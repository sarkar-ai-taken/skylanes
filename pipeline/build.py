"""Turn data/raw/ into the compact layers the app loads from app/data/.

Outputs:
  grid.json        100 m population grid: residents and jobs per km² per cell, water mask
  obstacles.json   FAA DOF obstacles + OSM tall buildings, masts, towers, cranes (points)
  powerlines.json  OSM power lines (lines)
  sites.json       hospitals, schools, stadiums, heliports, airports (points)
  airspace.json    FAA UAS facility map grid, Class B/C/D surface areas, FAA operating categories
  manifest.json    source, retrieval date and record count for every layer
"""
import base64, csv, datetime, gzip, io, json, math, zipfile
from array import array
from pathlib import Path

import shapefile
from shapely.geometry import Point, box, shape
from shapely.strtree import STRtree

from metro import METRO

ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / "data" / "raw", ROOT / "app" / "data"
W, S, E, N = METRO["bbox"]
BBOX = box(W, S, E, N)
LAT0 = (S + N) / 2
M_LAT = 110_574.0
M_LON = 111_320.0 * math.cos(math.radians(LAT0))
FT = 3.28084
manifest = {"metro": METRO["name"], "bbox": METRO["bbox"], "built": datetime.date.today().isoformat(), "layers": {}}


def note(layer, source, count, **kw):
    manifest["layers"][layer] = {"source": source, "count": count, **kw}
    print(f"{layer:12s} {count:>7,}  {source}")


def r5(c):
    return [round(c[0], 5), round(c[1], 5)]


def rgeom(g):
    """Round GeoJSON coordinates to ~1 m to keep files small."""
    def walk(c):
        return r5(c) if isinstance(c[0], (int, float)) else [walk(x) for x in c]
    return {"type": g["type"], "coordinates": walk(g["coordinates"])}


def b64(arr):
    return base64.b64encode(arr.tobytes()).decode()


# ---------------------------------------------------------------- population grid
def build_grid():
    zf = zipfile.ZipFile(RAW / "tabblock.zip")
    stem = next(n for n in zf.namelist() if n.endswith(".shp"))[:-4]
    rd = shapefile.Reader(shp=io.BytesIO(zf.read(stem + ".shp")), dbf=io.BytesIO(zf.read(stem + ".dbf")),
                          shx=io.BytesIO(zf.read(stem + ".shx")))
    fields = [f[0] for f in rd.fields[1:]]
    i_geo, i_cty, i_pop, i_land = (fields.index(k) for k in ("GEOID20", "COUNTYFP20", "POP20", "ALAND20"))

    jobs = {}
    with gzip.open(RAW / "wac.csv.gz", "rt") as fh:
        for row in csv.DictReader(fh):
            jobs[row["w_geocode"]] = int(row["C000"])

    geoms, recs = [], []
    for sr in rd.iterShapeRecords():
        rec = sr.record
        if rec[i_cty] not in METRO["county_fips"]:
            continue
        x0, y0, x1, y1 = sr.shape.bbox
        if x1 < W or x0 > E or y1 < S or y0 > N:
            continue
        geoms.append(shape(sr.shape.__geo_interface__))
        land = rec[i_land]
        recs.append((rec[i_pop], jobs.get(rec[i_geo], 0), land))
    tree = STRtree(geoms)

    cell = METRO["grid_m"]
    nx = int((E - W) * M_LON // cell)
    ny = int((N - S) * M_LAT // cell)
    dlon, dlat = cell / M_LON, cell / M_LAT
    res, job, water = array("I", [0]) * (nx * ny), array("I", [0]) * (nx * ny), bytearray(nx * ny)
    pts = [Point(W + (i + 0.5) * dlon, S + (j + 0.5) * dlat) for j in range(ny) for i in range(nx)]
    hit = tree.query(pts, predicate="within")  # (point index, block index) pairs
    seen = set()
    for pi, gi in zip(*hit):
        if pi in seen:
            continue
        seen.add(pi)
        pop, jb, land = recs[gi]
        if land <= 0:
            water[pi] = 1
            continue
        res[pi] = round(pop / land * 1e6)
        job[pi] = round(jb / land * 1e6)
    for pi in range(nx * ny):
        if pi not in seen:
            water[pi] = 1  # outside every King County land block: Sound, lakes, or another county
    blocks_used = len({int(g) for g in hit[1]})

    # FAA operating category (highest polygon wins) and UAS facility map ceiling per cell; 0 / 65535 = none.
    airspace = json.loads((OUT / "airspace.json").read_text())
    faacat, ceiling = bytearray(nx * ny), array("H", [65535]) * (nx * ny)
    for layer, apply in (("operating_categories", lambda pi, p: faacat.__setitem__(pi, max(faacat[pi], p["category"]))),
                         ("facility_map", lambda pi, p: ceiling.__setitem__(pi, min(ceiling[pi], p["ceiling_ft"])))):
        fs = airspace[layer]
        t = STRtree([shape(f["geometry"]) for f in fs])
        for pi, fi in zip(*t.query(pts, predicate="within")):
            apply(int(pi), fs[int(fi)]["properties"])
    out = {"west": W, "south": S, "cell_m": cell, "dlon": dlon, "dlat": dlat, "nx": nx, "ny": ny,
           "dtype": "uint32le", "residents": b64(res), "jobs": b64(job), "water": base64.b64encode(bytes(water)).decode(),
           "faacat": base64.b64encode(bytes(faacat)).decode(), "ceiling": b64(ceiling)}
    (OUT / "grid.json").write_text(json.dumps(out))
    note("grid", "US Census 2020 TIGER/Line blocks (POP20) + LEHD LODES8 WAC 2021 (C000 jobs)", nx * ny,
         blocks=blocks_used, total_residents=sum(r[0] for r in recs), total_jobs=sum(r[1] for r in recs),
         cell_m=cell)


# ---------------------------------------------------------------- obstacles
def osm_center(e):
    if "center" in e:
        return e["center"]["lon"], e["center"]["lat"]
    return e.get("lon"), e.get("lat")


def num(v):
    try:
        return float(str(v).split()[0].replace("m", "").replace(",", "."))
    except (ValueError, IndexError):
        return None


def build_obstacles():
    obs = []
    with open(RAW / "dof" / "DOF.CSV", newline="", encoding="latin-1") as fh:
        for row in csv.DictReader(fh):
            if row["STATE"] != "WA":
                continue
            lat, lon = float(row["LATDEC"]), float(row["LONDEC"])
            if not (S <= lat <= N and W <= lon <= E):
                continue
            obs.append({"lon": round(lon, 5), "lat": round(lat, 5), "agl_ft": int(row["AGL"]), "amsl_ft": int(row["AMSL"]),
                        "kind": row["TYPE"].strip().lower(), "src": "FAA DOF", "id": row["OAS"], "lit": row["LIGHTING"].strip()})
    n_dof = len(obs)

    osm = json.load(open(RAW / "osm_tall.json"))
    lines = []
    for e in osm["elements"]:
        t = e.get("tags", {})
        if t.get("power") == "line" and "geometry" in e:
            lines.append({"type": "Feature", "properties": {"voltage": t.get("voltage"), "name": t.get("name")},
                          "geometry": {"type": "LineString", "coordinates": [r5([p["lon"], p["lat"]]) for p in e["geometry"]]}})
            continue
        lon, lat = osm_center(e)
        if lon is None:
            continue
        h = num(t.get("height"))
        if h is None and t.get("building:levels"):
            lv = num(t["building:levels"])
            h = lv * 3.3 + 3 if lv else None
        kind = t.get("man_made") or "building"
        if h is None:
            h = {"crane": 60, "mast": 30, "tower": 30, "chimney": 30}.get(kind)  # unknown height: conservative default
            est = True
        else:
            est = False
        obs.append({"lon": round(lon, 5), "lat": round(lat, 5), "agl_ft": round(h * FT), "kind": kind, "src": "OSM",
                    "id": f"osm/{e['type']}/{e['id']}", "name": t.get("name"), "height_estimated": est,
                    "temporary": kind == "crane"})
    (OUT / "obstacles.json").write_text(json.dumps(obs))
    (OUT / "powerlines.json").write_text(json.dumps({"type": "FeatureCollection", "features": lines}))
    note("obstacles", "FAA Digital Obstacle File (daily) + OpenStreetMap", len(obs), faa_dof=n_dof, osm=len(obs) - n_dof)
    note("powerlines", "OpenStreetMap power=line (transmission; distribution lines largely unmapped)", len(lines))


# ---------------------------------------------------------------- sensitive sites
def build_sites():
    sites, seen = [], set()
    for e in json.load(open(RAW / "osm_sites.json"))["elements"]:
        t = e.get("tags", {})
        lon, lat = osm_center(e)
        if lon is None:
            continue
        kind = {"helipad": "heliport", "stadium": "stadium"}.get(t.get("aeroway") or t.get("leisure")) or t.get("amenity")
        kind = {"kindergarten": "school", "college": "school", "university": "school"}.get(kind, kind)
        key = (kind, round(lon, 3), round(lat, 3))
        if key in seen:
            continue
        seen.add(key)
        sites.append({"lon": round(lon, 5), "lat": round(lat, 5), "kind": kind, "name": t.get("name") or kind, "src": "OSM"})
    for f in json.load(open(RAW / "airports.geojson"))["features"]:
        p = f["properties"]
        kind = {"HP": "heliport", "AD": "airport", "SP": "seaplane base"}.get(p["TYPE_CODE"], "airport")
        lon, lat = f["geometry"]["coordinates"]
        sites.append({"lon": round(lon, 5), "lat": round(lat, 5), "kind": kind,
                      "name": f'{p["NAME"]} ({p["IDENT"]})', "src": "FAA ADDS", "private": p.get("PRIVATEUSE") == 1})
    for f in json.load(open(RAW / "stadiums.geojson"))["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        sites.append({"lon": round(lon, 5), "lat": round(lat, 5), "kind": "stadium",
                      "name": p["NAME"], "src": "FAA ADDS", "tfr": True})
    # The FAA record wins where OSM maps the same helipad or stadium.
    faa = [x for x in sites if x["src"] == "FAA ADDS"]
    near = lambda a, b: abs(a["lon"] - b["lon"]) * M_LON < 150 and abs(a["lat"] - b["lat"]) * M_LAT < 150
    sites = [x for x in sites if x["src"] != "OSM" or x["kind"] not in ("heliport", "stadium")
             or not any(near(x, y) and y["kind"] == x["kind"] for y in faa)]
    (OUT / "sites.json").write_text(json.dumps(sites))
    note("sites", "OpenStreetMap amenities + FAA ADDS airports/heliports/stadiums", len(sites))


# ---------------------------------------------------------------- airspace
def clip(fc, props):
    out = []
    for f in fc["features"]:
        if not f.get("geometry"):
            continue
        g = shape(f["geometry"]).intersection(BBOX)
        if g.is_empty:
            continue
        out.append({"type": "Feature", "properties": props(f["properties"]), "geometry": rgeom(g.simplify(0.00005).__geo_interface__)})
    return out


def build_airspace():
    fm = clip(json.load(open(RAW / "facility_map.geojson")),
              lambda p: {"ceiling_ft": p["CEILING"], "airport": p.get("APT1_NAME"), "laanc": p.get("APT1_LAANC") == 1,
                         "effective": p.get("MAP_EFF")})
    surf = clip({"features": [f for f in json.load(open(RAW / "class_airspace.geojson"))["features"]
                              if f["properties"]["CLASS"] in ("B", "C", "D") and (f["properties"]["LOWER_VAL"] or 0) == 0]},
                lambda p: {"name": p["NAME"], "class": p["CLASS"], "upper_ft": p["UPPER_VAL"]})
    cats = clip(json.load(open(RAW / "faa_operating_categories.geojson")),
                lambda p: {"category": int(p["POP_DENSITY"].split()[-1])})
    out = {"facility_map": fm, "surface_areas": surf, "operating_categories": cats}
    (OUT / "airspace.json").write_text(json.dumps(out))
    note("facility_map", "FAA UAS Facility Map (LAANC ceilings)", len(fm))
    note("surface", "FAA ADDS Class airspace, surface areas", len(surf))
    note("op_categories", "FAA ADDS Operating Categories Map", len(cats))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build_obstacles()
    build_sites()
    build_airspace()
    build_grid()  # after build_airspace: rasterizes its polygons
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
