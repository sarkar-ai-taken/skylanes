"""Road traffic counts: who drives under the route, and at what hour.

Segments (annual average daily traffic, all directions):
  - SDOT "2024 Arterial Traffic Volumes" flow map (City of Seattle arterials). AADT = ADT; AWDT (weekday) kept too.
    Many segments carry an older study (SDOT label 'Study(NormalizedYY)'); its year is kept as `counted`, and
    SDOT's uncounted estimates are flagged `estimate`. About 200 segments have ADT 0 but an AWDT (West Seattle Br,
    15th Ave W, Elliott Ave W ...): kept with aadt = AWDT and flagged `awdt_only` (high on weekends).
  - WSDOT "Traffic Sections" (Shared/TrafficData layer 1), state highway system. Features carry ReportingYear 2025;
    the service description calls the values "2023 estimated Annual Average Daily Traffic", so the vintage is unclear.
  Where SDOT and WSDOT map the same street (SR 99, SR 522, SR 513 ...), WSDOT wins: an SDOT segment with >= 80 %
  of its length within 25 m of a WSDOT section is dropped.

Hourly profile: FHWA TMAS continuous-count volume files (hourly counts that WSDOT submits from its permanent
traffic recorders), Apr + Oct 2024, stations inside the bbox, Mon-Fri. Each station-day becomes 24 shares; the
curve is the mean over stations of each station's mean day, so a busy freeway does not swamp the arterials.

Output app/data/roadcounts.json:
  hourly: {all|freeway|arterial: 24 shares of a weekday's traffic, local time, sum 1}, with station counts
  segs: [{aadt, awdt?, year, counted?, estimate?, awdt_only?, src: 'sdot'|'wsdot', name, coords: [[lon, lat], ...]}]
Vehicles on a segment in hour h of a weekday ~= aadt * hourly.all[h] (AADT, not AWDT: a slight undercount on weekdays).

    python roadcounts.py

Run with the pipeline dir on sys.path (fetch, metro), e.g. .venv/bin/python pipeline/roadcounts.py.
"""
import io, json, math, re, statistics, sys, urllib.parse, zipfile
from collections import defaultdict
from datetime import date

from shapely import transform
from shapely.geometry import MultiLineString, box
from shapely.ops import linemerge, unary_union

from fetch import RAW, get
from metro import METRO

DIR = RAW / "roadcounts"
OUT = RAW.parent.parent / "app" / "data" / "roadcounts.json"
W, S, E, N = METRO["bbox"]
LAT0 = (S + N) / 2
M_LAT, M_LON = 110_574.0, 111_320.0 * math.cos(math.radians(LAT0))
SDOT = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/2024_Arterial_Traffic_Volumes/FeatureServer/0"
WSDOT = "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/MapServer/1"
TMAS = "https://www.fhwa.dot.gov/policyinformation/tables/tmasdata/2024"
MONTHS = ["apr", "oct"]
TOL_M, MIN_AADT, MAX_BYTES = 10, 2000, 2_500_000

to_m = lambda a: (a - [W, S]) * [M_LON, M_LAT]
to_ll = lambda a: a / [M_LON, M_LAT] + [W, S]
BOX = box(0, 0, (E - W) * M_LON, (N - S) * M_LAT)


def fetch(name, url):
    out = DIR / name
    if not out.exists() or "--force" in sys.argv:
        print(f"get  {name}")
        out.write_bytes(get(url))
    return out


def arcgis(name, layer, fields):
    """Every feature of an ArcGIS layer that touches the bbox, as GeoJSON in WGS84 (paged by object id offset)."""
    out = DIR / f"{name}.geojson"
    if out.exists() and "--force" not in sys.argv:
        return json.loads(out.read_text())
    print(f"get  {out.name}")
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": "1=1", "outFields": fields, "f": "geojson", "outSR": 4326, "returnGeometry": "true",
            "geometry": f"{W},{S},{E},{N}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "orderByFields": "OBJECTID" if name == "wsdot" else "FID",
            "resultOffset": offset, "resultRecordCount": 1000,
        })
        page = json.loads(get(f"{layer}/query?{q}"))
        if "error" in page:
            raise SystemExit(f"{name}: {page['error']}")
        feats += page.get("features", [])
        if not page.get("properties", {}).get("exceededTransferLimit") and not page.get("exceededTransferLimit"):
            break
        offset += 1000
    fc = {"type": "FeatureCollection", "features": feats}
    out.write_text(json.dumps(fc))
    return fc


def lines(g):
    if not g:
        return None
    parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
    parts = [p for p in parts if len(p) >= 2]
    return MultiLineString(parts) if parts else None


def simple(geom):
    """Clip to the bbox, simplify at TOL_M in metres, return a list of [[lon, lat], ...] parts rounded to 5 decimals."""
    g = transform(linemerge(geom), to_m).simplify(TOL_M, preserve_topology=False)
    g = transform(g.intersection(BOX), to_ll)
    parts = list(g.geoms) if hasattr(g, "geoms") else [g]
    out = []
    for p in parts:
        if p.geom_type != "LineString" or p.length == 0:
            continue
        c = [[round(x, 5), round(y, 5)] for x, y in p.coords]
        c = [v for i, v in enumerate(c) if i == 0 or v != c[i - 1]]
        if len(c) >= 2:
            out.append(c)
    return out


DIRS = {"N", "S", "E", "W", "NE", "NW", "SE", "SW"}


def street(s):
    """SDOT street name in title case, keeping directions and ordinals ('20th Ave NW'; str.title() gives '20Th Ave Nw')."""
    w = lambda m: m[0].upper() if m[0].upper() in DIRS else m[0].lower() if m[0][0].isdigit() else m[0].capitalize()
    return re.sub(r"[A-Za-z0-9]+", w, " ".join(s.split())).replace(",", ", ")


def segments():
    sd = arcgis("sdot", SDOT, "FID,STNAME_ORD,ADT,AWDT,START_DATE,DATAQUALIT")
    ws = arcgis("wsdot", WSDOT, "OBJECTID,RouteIdentifier,StateRouteNumber,SymbolCode,RelatedRouteType,Location,AADT,ReportingYear")
    wsd = [(f["properties"], lines(f["geometry"])) for f in ws["features"]]
    wsd = [(p, g) for p, g in wsd if g is not None and p.get("AADT")]
    wbuf = unary_union([transform(g, to_m).buffer(25) for _, g in wsd])
    segs, stats = [], defaultdict(int)
    for p, g in wsd:
        sym = {"IS": "I-", "US": "US ", "SR": "SR "}.get(p.get("SymbolCode"), "SR ")
        name = f"{sym}{int(p['StateRouteNumber'])}" + (f" {p['RelatedRouteType']}" if p.get("RelatedRouteType") else "")
        for c in simple(g):
            segs.append({"aadt": int(p["AADT"]), "year": int(p["ReportingYear"]), "src": "wsdot", "name": name, "coords": c})
        stats["wsdot_in"] += 1
    for f in sd["features"]:
        p, g = f["properties"], lines(f["geometry"])
        if g is None or not (p.get("ADT") or p.get("AWDT")):
            stats["sdot_nocount"] += 1
            continue
        gm = transform(g, to_m)
        if gm.length and gm.intersection(wbuf).length / gm.length >= 0.8:
            stats["sdot_on_state_route"] += 1
            continue
        counted = date.fromtimestamp(p["START_DATE"] / 1000).year if p.get("START_DATE") else None
        adt, awdt = int(p["ADT"] or 0), int(p["AWDT"] or 0)
        stats["sdot_awdt_only"] += not adt
        for c in simple(g):
            s = {"aadt": adt or awdt, "awdt": awdt, "year": 2024, "src": "sdot", "name": street(p.get("STNAME_ORD") or "")}
            if not adt:
                s["awdt_only"] = True  # SDOT left ADT at 0: the weekday AWDT stands in for every day
            if (p.get("DATAQUALIT") or "").strip() == "Estimate":
                s["estimate"] = True  # SDOT estimate, no study on this segment
            elif counted:
                s["counted"] = counted
            s["coords"] = c
            segs.append(s)
        stats["sdot_in"] += 1
    return segs, stats


def hourly():
    """Weekday hourly shares from FHWA TMAS hourly volumes at the WSDOT permanent recorders inside the bbox."""
    sta = zipfile.ZipFile(fetch("2024_station_data.zip", f"{TMAS}/2024_station_data.zip"))
    fsys = {}
    for line in io.TextIOWrapper(sta.open("WA_2024 (TMAS).STA"), "latin-1"):
        r = line.split("|")
        if r[0] != "S":
            continue
        lat, lon = int(r[26]) / 1e6, -int(r[27]) / 1e6
        if W <= lon <= E and S <= lat <= N:
            fsys[r[2]] = r[6]
    days = defaultdict(lambda: [0] * 24)  # (station, y, m, d) -> hourly, all lanes and directions summed
    for mon in MONTHS:
        z = zipfile.ZipFile(fetch(f"{mon}_2024_ccs_data.zip", f"{TMAS}/{mon}_2024_ccs_data.zip"))
        name = next(n for n in z.namelist() if n.startswith("WA_"))
        for line in io.TextIOWrapper(z.open(name), "latin-1"):
            r = line.rstrip("\n").split("|")
            if r[0] != "V" or r[3] not in fsys or r[9] not in "23456" or (len(r) > 34 and r[34].strip() not in ("", "0")):
                continue
            h = [int(v) for v in r[10:34]]
            d = days[(r[3], r[6], r[7], r[8])]
            for i in range(24):
                d[i] += h[i]
    per = defaultdict(list)  # station -> list of 24-share days
    for (st, *_), h in days.items():
        t = sum(h)
        if t >= 500 and min(h) > 0:  # a dead loop or partial day leaves zero hours
            per[st].append([v / t for v in h])
    def curve(sts):
        means = [[statistics.fmean(d[i] for d in per[s]) for i in range(24)] for s in sts]
        c = [statistics.fmean(m[i] for m in means) for i in range(24)]
        return [round(v / sum(c), 5) for v in c]
    fw = [s for s in per if fsys[s][0] in "12"]  # 1 interstate, 2 other freeway / expressway
    ar = [s for s in per if fsys[s][0] in "34567"]
    return {"all": curve(list(per)), "freeway": curve(fw), "arterial": curve(ar),
            "stations": len(per), "stations_freeway": len(fw), "stations_arterial": len(ar),
            "station_days": sum(len(v) for v in per.values()), "stations_in_bbox": len(fsys)}


def main():
    DIR.mkdir(parents=True, exist_ok=True)
    segs, stats = segments()
    hr = hourly()
    dropped = 0
    doc = lambda: {
        "built": date.today().isoformat(),
        "sources": {
            "sdot": {"name": "SDOT 2024 Arterial Traffic Volumes (traffic flow map), City of Seattle open data", "url": SDOT,
                     "year": 2024, "aadt": "ADT field (all days); awdt = average weekday; counted = study year (SDOT labels most 'Study(NormalizedYY)'); estimate = SDOT estimate, no study; awdt_only = ADT 0 in the source, aadt set to AWDT",
                     "segments_in": stats["sdot_in"], "awdt_only": stats["sdot_awdt_only"], "no_count": stats["sdot_nocount"],
                     "dropped_on_state_route": stats["sdot_on_state_route"]},
            "wsdot": {"name": "WSDOT Traffic Sections (estimated AADT, state highway system, all directions)", "url": WSDOT,
                      "reporting_year": max((s["year"] for s in segs if s["src"] == "wsdot"), default=None), "segments_in": stats["wsdot_in"],
                      "vintage_note": "features carry ReportingYear; the service description says 2023 estimated AADT"},
            "hourly": {"name": "FHWA Travel Monitoring Analysis System (TMAS) hourly volume files, Washington (WSDOT permanent traffic recorders)",
                       "url": f"{TMAS}/", "months": [f"{m} 2024" for m in MONTHS], "days": "Mon-Fri",
                       "method": "per station-day shares (complete days only), mean per station, mean over stations"},
        },
        "simplify_m": TOL_M, "min_aadt": MIN_AADT if dropped else 0, "dropped_low_aadt": dropped,
        "hourly": hr, "segs": segs,
    }
    text = json.dumps(doc(), separators=(",", ":"))
    if len(text) > MAX_BYTES:
        dropped = sum(s["aadt"] < MIN_AADT for s in segs)
        segs[:] = [s for s in segs if s["aadt"] >= MIN_AADT]
        text = json.dumps(doc(), separators=(",", ":"))
    OUT.write_text(text)
    pm = max(range(24), key=lambda i: hr["all"][i])
    print(f"roadcounts {len(segs):,} segments ({stats['sdot_in']} sdot, {stats['wsdot_in']} wsdot, "
          f"{stats['sdot_on_state_route']} sdot on state routes dropped, {dropped} < {MIN_AADT} dropped), "
          f"{len(text) / 1e6:.2f} MB; hourly from {hr['stations']} stations / {hr['station_days']} days, peak {pm}:00 {hr['all'][pm]:.3f}")


if __name__ == "__main__":
    main()
