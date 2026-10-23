"""Seattle noise complaints, 36 full months, on 250 m cells -> app/data/noise311.json (a noise-sensitivity baseline).

Three City of Seattle open-data feeds (data.seattle.gov, Socrata SODA, no key), each kept as its own count:
  spd   SPD Call Data 33kz-ixgy: community-generated calls whose initial (caller-reported) type is noise. One row per
        dispatched unit, so events are deduped on cad_event_number. Point = dispatch_latitude/longitude as published
        (the description now says calls are located only to the patrol beat, yet rows carry block-level points; treat
        cell placement as approximate at 250 m); time = queued.
        Police-response records only (dataset description): a noise call queued and cleared before an officer went is
        not published, so SPD noise calls are undercounted.
  sdci  SDCI Code Complaints and Violations ez4a-iug7: recordtypedesc contains Noise (mostly construction and
        commercial noise). Point = address; open date only, so no hour of day.
  csr   Customer Service Requests 5ngg-rpne (Find It Fix It): Animal Noise and Nightlife Noise Complaint. Nightlife
        requests carry almost no coordinates; only geocoded rows are gridded. Time = when the request was filed.
Coverage is Seattle city limits only (City Council Districts 2024 dissolved, land only); outside it there is no data,
which is not the same as no complaints. Raw pages are cached in data/raw/noise311/.

    python noise311.py            # 36 months ending with the last full month
    python noise311.py --force    # refetch
"""
import datetime as dt, json, math, statistics, sys, urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep

from fetch import RAW, get
from metro import METRO

OUT_DIR = RAW / "noise311"
APP = Path(__file__).resolve().parent.parent / "app" / "data" / "noise311.json"
FORCE = "--force" in sys.argv
CELL = 250
SODA = "https://data.seattle.gov/resource/{}.json"
DISTRICTS = ("https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Seattle_City_Council_Districts/"
             "FeatureServer/0/query?where=1%3D1&outFields=C_DISTRICT&outSR=4326&f=geojson")

W, S, E, N = METRO["bbox"]
LAT0 = (S + N) / 2
M_LAT, M_LON = 110_574.0, 111_320.0 * math.cos(math.radians(LAT0))
DLON, DLAT = CELL / M_LON, CELL / M_LAT

today = dt.date.today()
END = today.replace(day=1)  # exclusive: first day of the current month
START = END.replace(year=END.year - 3)
SPAN = f"'{START.isoformat()}T00:00:00' AND '{END.isoformat()}T00:00:00'"

SOURCES = {
    "spd": dict(id="33kz-ixgy", name="SPD Call Data (CAD events, noise as initial call type)",
                select="cad_event_number,cad_event_original_time_queued,dispatch_latitude,dispatch_longitude,initial_call_type",
                where=(f"cad_event_original_time_queued >= '{START}' AND cad_event_original_time_queued < '{END}'"
                       " AND call_type_received_classification = 'COMMUNITY_GENERATED'"
                       " AND initial_call_type in ('NOISE - GENERAL','OBS - NOISE - DISTURBANCE (PARTY, ETC)',"
                       "'NOISE - ANIMAL (INCLUDES BARKING DOGS)')"),
                order="cad_event_number", key="cad_event_number", t="cad_event_original_time_queued",
                lat="dispatch_latitude", lon="dispatch_longitude", kind="initial_call_type", hourly=True),
    "sdci": dict(id="ez4a-iug7", name="SDCI Code Complaints and Violations (record type Noise)",
                 select="recordnum,opendate,latitude,longitude,recordtypedesc",
                 where=f"opendate >= '{START}' AND opendate < '{END}' AND recordtypedesc like '%Noise%'",
                 order="recordnum", key="recordnum", t="opendate", lat="latitude", lon="longitude",
                 kind=None, hourly=False),
    "csr": dict(id="5ngg-rpne", name="Customer Service Requests / Find It Fix It (Animal Noise, Nightlife Noise Complaint)",
                select="servicerequestnumber,createddate,latitude,longitude,webintakeservicerequests",
                where=(f"createddate >= '{START}' AND createddate < '{END}'"
                       " AND webintakeservicerequests in ('Animal Noise','Nightlife Noise Complaint')"),
                order="servicerequestnumber", key="servicerequestnumber", t="createddate", lat="latitude",
                lon="longitude", kind="webintakeservicerequests", hourly=True),
}


def soda(name, src):
    out = OUT_DIR / f"{name}_{START}_{END}.json"
    if out.exists() and not FORCE:
        print(f"have {out.name}")
        return json.loads(out.read_text())
    rows, off = [], 0
    while True:
        q = urllib.parse.urlencode({"$select": src["select"], "$where": src["where"], "$order": src["order"],
                                    "$limit": 50000, "$offset": off})
        page = json.loads(get(SODA.format(src["id"]) + "?" + q))
        rows += page
        print(f"     {name}: {len(rows)} rows")
        if len(page) < 50000:
            break
        off += 50000
    out.write_text(json.dumps(rows))
    return rows


def city():
    out = OUT_DIR / "council_districts.geojson"
    if not out.exists() or FORCE:
        out.write_bytes(get(DISTRICTS))
    fs = json.loads(out.read_text())["features"]
    assert len(fs) == 7, f"expected 7 council districts, got {len(fs)}"
    return unary_union([shape(f["geometry"]).buffer(0) for f in fs])


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    poly = city()
    near = prep(poly.buffer(150 / M_LAT))  # block centroids on the limit line still count
    cw, cs, ce, cn = poly.bounds
    i0, j0 = math.floor((cw - W) / DLON), math.floor((cs - S) / DLAT)
    ox, oy = W + i0 * DLON, S + j0 * DLAT  # cell origin, on the metro-wide 250 m lattice
    nx, ny = math.ceil((ce - ox) / DLON), math.ceil((cn - oy) / DLAT)
    inside = prep(poly)
    city_cells = [(i, j) for j in range(ny) for i in range(nx)
                  if inside.contains(Point(ox + (i + .5) * DLON, oy + (j + .5) * DLAT))]

    cells = defaultdict(lambda: [0, 0, 0])
    cdow = defaultdict(lambda: [0] * 7)
    meta, hour_all, dow_all, month_all = {}, [0] * 24, [0] * 7, Counter()
    for k, (name, src) in enumerate(SOURCES.items()):
        rows = soda(name, src)
        seen, hour, dow, kinds, n, nogeo, outside = set(), [0] * 24, [0] * 7, Counter(), 0, 0, 0
        first = last = None
        for r in rows:
            if r.get(src["key"]) in seen:
                continue
            seen.add(r.get(src["key"]))
            t = dt.datetime.fromisoformat(r[src["t"]][:19])
            if src["kind"]:
                kinds[r.get(src["kind"], "")] += 1
            try:
                lat, lon = float(r[src["lat"]]), float(r[src["lon"]])
            except (KeyError, TypeError, ValueError):
                nogeo += 1
                continue
            if not (47 < lat < 48 and -123 < lon < -122):
                nogeo += 1
                continue
            if not near.contains(Point(lon, lat)):
                outside += 1
                continue
            i, j = int((lon - ox) / DLON), int((lat - oy) / DLAT)
            cells[i, j][k] += 1
            d = t.weekday()
            cdow[i, j][d] += 1
            dow[d] += 1
            dow_all[d] += 1
            month_all[t.strftime("%Y-%m")] += 1
            if src["hourly"]:
                hour[t.hour] += 1
                hour_all[t.hour] += 1
            n += 1
            first, last = min(first or t, t), max(last or t, t)
        meta[name] = {"dataset": src["id"], "url": f"https://data.seattle.gov/d/{src['id']}", "name": src["name"],
                      "rows": len(rows), "records": len(seen), "gridded": n, "no_coords": nogeo, "outside_city": outside,
                      "first": first and first.date().isoformat(), "last": last and last.date().isoformat(),
                      "by_type": dict(kinds.most_common()) if kinds else None,
                      "hour": hour if src["hourly"] else None, "dow": dow}
        print(f"{name}: {len(seen)} records, {n} gridded, {nogeo} without coordinates, {outside} outside the city")

    keys = sorted(cells, key=lambda c: (c[1], c[0]))
    flat, dflat = [], []
    for c in keys:
        flat += [c[0], c[1], sum(cells[c]), *cells[c]]
        dflat += cdow[c]
    tot = {c: sum(v) for c, v in cells.items()}
    city_counts = sorted(tot.get(c, 0) for c in city_cells)
    pct = lambda p: city_counts[min(len(city_counts) - 1, int(p / 100 * len(city_counts)))]
    years = (END - START).days / 365.25
    simple = poly.simplify(0.0002, preserve_topology=True)
    rings = [simple] if simple.geom_type == "Polygon" else list(simple.geoms)
    out = {
        "source": "City of Seattle open data (data.seattle.gov, SODA): SPD Call Data, SDCI Code Complaints, Customer Service Requests",
        "built": today.isoformat(),
        "start": START.isoformat(), "end": (END - dt.timedelta(days=1)).isoformat(), "years": round(years, 3),
        "coverage": "Seattle city limits only (land, City Council Districts 2024 dissolved); no data outside",
        "city_bbox": [round(v, 5) for v in poly.bounds],
        "city": [[[[round(x, 5), round(y, 5)] for x, y in r.exterior.coords]] for r in rings],
        "cell_m": CELL, "west": ox, "south": oy, "dlon": DLON, "dlat": DLAT, "nx": nx, "ny": ny,
        "fields": ["i", "j", "total", *SOURCES],
        "cells": flat,
        "dow_cells": dflat,
        "records": sum(m["gridded"] for m in meta.values()),
        "hour": hour_all, "hour_note": "spd + csr only (sdci has dates only); local time; csr is filing time",
        "dow": dow_all, "dow_note": "0 = Monday",
        "month": dict(sorted(month_all.items())),
        "city_cells": len(city_cells),
        "city_cell_stats": {"median": statistics.median(city_counts), "mean": round(sum(city_counts) / len(city_counts), 3),
                            "p75": pct(75), "p90": pct(90), "p99": pct(99), "max": city_counts[-1],
                            "nonzero": sum(1 for v in city_counts if v)},
        "sources": meta,
    }
    APP.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {APP.name}: {out['records']} complaints, {len(keys)} cells, {APP.stat().st_size / 1e3:.0f} kB; "
          f"city cells {len(city_cells)}, median {out['city_cell_stats']['median']}, p90 {out['city_cell_stats']['p90']}")


if __name__ == "__main__":
    main()
