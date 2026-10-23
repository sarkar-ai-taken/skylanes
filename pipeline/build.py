"""Turn data/raw/ into the compact layers the app loads from app/data/.

Outputs:
  grid.json        100 m population grid: residents and jobs per km² per cell, water mask
  obstacles.json   FAA DOF obstacles + OSM tall buildings, masts, towers, cranes (points)
  powerlines.json  OSM power lines (lines)
  sites.json       hospitals, schools, stadiums, heliports, airports (points)
  airspace.json    FAA UAS facility map grid, Class B/C/D surface areas, FAA operating categories
  traffic.json     crewed-aircraft density per 1 km cell and altitude band, from historical ADS-B (adsb.py)
  wind.json        HRRR wind climatology per 3 km point (hrrr.py)
  diurnal.json, noise311.json, roadcounts.json, cellular.json are written by their own scripts; build.py only notes
  them in the manifest (`build.py --notes` does just that, after diurnal.py, which needs the tiles built here)
  manifest.json    source, retrieval date and record count for every layer

Each population tile also carries OSM land use per 100 m cell and, where 3DEP lidar covers it (lidar.py), the surface
height above ground per 50 m cell with a tree / structure flag.
"""
import base64, csv, datetime, gzip, io, json, math, re, sys, zipfile
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


# ---------------------------------------------------------------- land use
LANDUSE = ["unmapped", "residential", "commercial", "industrial", "institutional", "park", "forest", "open land",
           "rail and transport", "water", "cemetery", "construction", "parking"]
_LU = {
    "landuse": {"residential": 1, "commercial": 2, "retail": 2, "office": 2, "industrial": 3, "port": 3, "depot": 3,
                "education": 4, "institutional": 4, "religious": 4, "military": 4, "recreation_ground": 5, "village_green": 5,
                "forest": 6, "grass": 7, "meadow": 7, "farmland": 7, "orchard": 7, "vineyard": 7, "farmyard": 7, "allotments": 7,
                "plant_nursery": 7, "railway": 8, "reservoir": 9, "basin": 9, "aquaculture": 9, "salt_pond": 9, "cemetery": 10,
                "construction": 11, "brownfield": 11, "greenfield": 11, "landfill": 11, "quarry": 11},
    "leisure": {"park": 5, "garden": 5, "playground": 5, "pitch": 5, "golf_course": 5, "recreation_ground": 5, "nature_reserve": 5},
    "natural": {"wood": 6, "scrub": 6, "heath": 6, "grassland": 7, "beach": 7, "wetland": 9, "water": 9},
    "amenity": {"parking": 12, "school": 4, "university": 4, "college": 4, "hospital": 4},
}


def osm_polygons(e):
    """Shapely polygons for an Overpass way or multipolygon relation fetched with `out geom`."""
    from shapely.ops import polygonize, unary_union
    if e["type"] == "way" and "geometry" in e:
        ring = [(p["lon"], p["lat"]) for p in e["geometry"]]
        if len(ring) < 4 or ring[0] != ring[-1]:
            return []
        polys = [shape({"type": "Polygon", "coordinates": [ring]})]
    elif e["type"] == "relation":
        lines = [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in e.get("members", []) if m.get("role") == "outer" and "geometry" in m]
        polys = list(polygonize(unary_union([shape({"type": "LineString", "coordinates": l}) for l in lines if len(l) > 1])))
    else:
        return []
    out = []
    for poly in polys:
        if not poly.is_valid:
            poly = poly.buffer(0)
        out += [g for g in getattr(poly, "geoms", [poly]) if g.geom_type == "Polygon" and not g.is_empty]
    return out


def landuse_layer():
    """(STRtree, class per polygon, area per polygon) for OSM land use, or None before fetch.py has run."""
    path = RAW / "osm_landuse.json"
    if not path.exists():
        return None
    geoms, cls, area = [], [], []
    for e in json.load(open(path))["elements"]:
        t = e.get("tags", {})
        c = next((_LU[k][t[k]] for k in _LU if t.get(k) in _LU[k]), None)
        if c is None:
            continue
        for g in osm_polygons(e):
            if g.intersects(BBOX):
                geoms.append(g); cls.append(c); area.append(g.area)
    return STRtree(geoms), cls, area


def heights_layer():
    """3DEP lidar surface heights from lidar.py (50 m cells), or None."""
    if not (RAW / "heights.npz").exists():
        return None
    import numpy as np
    h, meta = np.load(RAW / "heights.npz"), json.loads((RAW / "heights.json").read_text())
    assert abs(meta["dlon"] * 2 - METRO["grid_m"] / M_LON) < 1e-9, "heights must be on the population grid at half its cell"
    surf = h["surface"]
    code = np.where(np.isnan(surf), 255, np.minimum(254, np.ceil(np.nan_to_num(surf) * FT / 4))).astype(np.uint8)
    high, multi = h["high"], h["multi"]
    # Canopy splits a laser pulse into several returns; roofs, towers and cranes return it once.
    # kind: 0 ground or low, 1 structure, 2 tree canopy, 3 accounted for by a mapped building or filed obstacle
    tree = (high >= 3) & (multi >= TREE_MULTI * high) & (np.nan_to_num(surf) < 75)  # nothing here grows past 75 m: lattice cranes and towers split pulses too
    kind = np.where(code == 255, 0, np.where(np.nan_to_num(surf) < 5, 0, np.where(tree, 2, 1))).astype(np.uint8)
    explained = mapped_cells(code, meta)
    kind[explained] = 3
    return code, kind, meta


def mapped_cells(code, meta):
    """50 m cells whose lidar height a mapped footprint or filed obstacle already accounts for (within 50 ft).

    The engine tests those against the exact footprint instead of the coarser lidar cell, so a launch pad between
    downtown towers is not walled in by the 50 m cells around them.
    """
    import numpy as np
    ny, nx = code.shape
    dlon, dlat = meta["dlon"], meta["dlat"]
    out = np.zeros(code.shape, bool)
    reach = lambda h_ft, j, i: code[j, i] != 255 and h_ft >= int(code[j, i]) * 4 - 50  # int: uint8 * 4 overflows
    for b in json.loads((OUT / "buildings.json").read_text()):
        poly = shape({"type": "Polygon", "coordinates": [b["ring"]]})
        x0, y0, x1, y1 = poly.bounds
        for j in range(max(0, int((y0 - S) / dlat)), min(ny, int((y1 - S) / dlat) + 1)):
            for i in range(max(0, int((x0 - W) / dlon)), min(nx, int((x1 - W) / dlon) + 1)):
                if reach(b["h_ft"], j, i) and poly.intersects(box(W + i * dlon, S + j * dlat, W + (i + 1) * dlon, S + (j + 1) * dlat)):
                    out[j, i] = True
    for o in json.loads((OUT / "obstacles.json").read_text()):
        i0, j0 = int((o["lon"] - W) / dlon), int((o["lat"] - S) / dlat)
        for j in range(max(0, j0 - 1), min(ny, j0 + 2)):  # filed positions are good to about one cell
            for i in range(max(0, i0 - 1), min(nx, i0 + 2)):
                if reach(o["agl_ft"], j, i):
                    out[j, i] = True
    return out


TREE_MULTI = 0.5  # share of high returns from multi-return pulses above which a cell reads as tree canopy


# ---------------------------------------------------------------- population grid
TILE = 80  # cells per tile side: 8 km at 100 m


def build_grid():
    """Population grid at grid_m, split into TILE×TILE tiles the app loads on demand.

    Cell state: 0 land with census data, 1 water, 2 no data (outside every census block, e.g. across the border).
    Every Washington block in the box is used, whatever its county, so land is never mistaken for water.
    """
    zf = zipfile.ZipFile(RAW / "tabblock.zip")
    stem = next(n for n in zf.namelist() if n.endswith(".shp"))[:-4]
    rd = shapefile.Reader(shp=io.BytesIO(zf.read(stem + ".shp")), dbf=io.BytesIO(zf.read(stem + ".dbf")),
                          shx=io.BytesIO(zf.read(stem + ".shx")))
    fields = [f[0] for f in rd.fields[1:]]
    i_geo, i_pop, i_land = (fields.index(k) for k in ("GEOID20", "POP20", "ALAND20"))

    jobs = {}
    with gzip.open(RAW / "wac.csv.gz", "rt") as fh:
        for row in csv.DictReader(fh):
            jobs[row["w_geocode"]] = int(row["C000"])

    geoms, recs = [], []
    for sr in rd.iterShapeRecords():
        x0, y0, x1, y1 = sr.shape.bbox
        if x1 < W or x0 > E or y1 < S or y0 > N:
            continue
        rec = sr.record
        geoms.append(shape(sr.shape.__geo_interface__))
        recs.append((rec[i_pop], jobs.get(rec[i_geo], 0), rec[i_land]))
    tree = STRtree(geoms)
    airspace = json.loads((OUT / "airspace.json").read_text())
    cat_tree = STRtree([shape(f["geometry"]) for f in airspace["operating_categories"]])
    fm_tree = STRtree([shape(f["geometry"]) for f in airspace["facility_map"]])

    lu, hts = landuse_layer(), heights_layer()
    lu_cells, h_cells = [0] * len(LANDUSE), 0
    cell = METRO["grid_m"]
    nx, ny = int((E - W) * M_LON // cell), int((N - S) * M_LAT // cell)
    dlon, dlat = cell / M_LON, cell / M_LAT
    tdir = OUT / "tiles"
    tdir.mkdir(exist_ok=True)
    for old in tdir.glob("*.json"):
        old.unlink()
    keys, residents, jobs_total, used = [], 0, 0, set()
    for tj in range((ny + TILE - 1) // TILE):
        for ti in range((nx + TILE - 1) // TILE):
            i0, j0 = ti * TILE, tj * TILE
            w, h = min(TILE, nx - i0), min(TILE, ny - j0)
            pts = [Point(W + (i0 + i + 0.5) * dlon, S + (j0 + j + 0.5) * dlat) for j in range(h) for i in range(w)]
            res, job, state = array("I", [0]) * (w * h), array("I", [0]) * (w * h), bytearray([2]) * (w * h)
            for pi, gi in zip(*tree.query(pts, predicate="within")):
                if state[pi] != 2:
                    continue
                pop, jb, land = recs[gi]
                used.add(int(gi))
                if land <= 0:
                    state[pi] = 1
                    continue
                state[pi] = 0
                res[pi], job[pi] = round(pop / land * 1e6), round(jb / land * 1e6)
            if all(v == 1 for v in state):
                continue  # open water: the app treats a missing listed-as-water tile as water
            faacat, ceiling = bytearray(w * h), array("H", [65535]) * (w * h)
            for pi, fi in zip(*cat_tree.query(pts, predicate="within")):
                faacat[pi] = max(faacat[pi], airspace["operating_categories"][int(fi)]["properties"]["category"])
            for pi, fi in zip(*fm_tree.query(pts, predicate="within")):
                ceiling[pi] = min(ceiling[pi], airspace["facility_map"][int(fi)]["properties"]["ceiling_ft"])
            key = f"{ti}_{tj}"
            keys.append(key)
            tile = {"ti": ti, "tj": tj, "w": w, "h": h, "residents": b64(res), "jobs": b64(job),
                    "state": base64.b64encode(bytes(state)).decode(), "faacat": base64.b64encode(bytes(faacat)).decode(), "ceiling": b64(ceiling)}
            if lu:
                tree_lu, cls, area = lu
                land, best = bytearray(w * h), [math.inf] * (w * h)
                for pi, gi in zip(*tree_lu.query(pts, predicate="within")):
                    if area[gi] < best[pi]:  # the most specific polygon wins: a park inside a residential zone is a park
                        best[pi], land[pi] = area[gi], cls[gi]
                for v in land:
                    lu_cells[v] += 1
                tile["landuse"] = base64.b64encode(bytes(land)).decode()
            if hts:
                code, kind, _ = hts
                sub = code[j0 * 2:(j0 + h) * 2, i0 * 2:(i0 + w) * 2]
                if (sub != 255).any():
                    tile["surf"] = base64.b64encode(sub.tobytes()).decode()
                    tile["surfkind"] = base64.b64encode(kind[j0 * 2:(j0 + h) * 2, i0 * 2:(i0 + w) * 2].tobytes()).decode()
                    h_cells += int((sub != 255).sum())
            (tdir / f"{key}.json").write_text(json.dumps(tile))
            residents += sum(res[k] for k in range(w * h) if state[k] == 0) * cell * cell / 1e6
            jobs_total += sum(job[k] for k in range(w * h) if state[k] == 0) * cell * cell / 1e6
    out = {"west": W, "south": S, "cell_m": cell, "dlon": dlon, "dlat": dlat, "nx": nx, "ny": ny, "tile": TILE,
           "dtype": "uint32le", "tiles": keys, "landuse": LANDUSE if lu else None, "surf_cell_m": cell // 2 if hts else None}
    (OUT / "grid.json").write_text(json.dumps(out))
    note("grid", "US Census 2020 TIGER/Line blocks (POP20) + LEHD LODES8 WAC 2021 (C000 jobs), tiled", nx * ny,
         tiles=len(keys), blocks=len(used), residents_est=round(residents), jobs_est=round(jobs_total), cell_m=cell)
    if lu:
        note("landuse", "OpenStreetMap landuse, leisure, natural and amenity areas, rasterized to 100 m (most specific area wins)",
             sum(lu_cells[1:]), cells=dict(zip(LANDUSE, lu_cells)))
    if hts:
        meta = hts[2]
        note("heights", f"USGS 3DEP lidar point clouds (EPT, depth {meta['depth']}), second-highest return above the 3DEP DEM per {meta['cell_m']} m cell",
             h_cells, surveys=[x["survey"] for x in meta["surveys"]], returns=sum(x["returns"] for x in meta["surveys"]), tree_multi_return_share=TREE_MULTI)


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
        if "building" in t and not t.get("man_made"):
            continue  # buildings are footprints now, see build_buildings
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


def building_height_m(t):
    h = num(t.get("height"))
    if h is None and t.get("building:levels"):
        lv = num(t["building:levels"])
        h = lv * 3.3 + 3 if lv else None
    return h


def build_buildings():
    """Footprints of tall buildings, so a route is tested against the outline, not a centre point."""
    out, seen = [], set()
    for e in json.load(open(RAW / "osm_buildings.json"))["elements"]:
        t = e.get("tags", {})
        h = building_height_m(t)
        if h is None:
            continue
        for poly in osm_polygons(e):
            if not poly.intersects(BBOX):
                continue
            key = (round(poly.centroid.x, 5), round(poly.centroid.y, 5), round(h))
            if key in seen:
                continue  # the same tower mapped as a building and as a relation
            seen.add(key)
            out.append({"id": f"osm/{e['type']}/{e['id']}", "name": t.get("name"), "h_ft": round(h * FT),
                        "ring": [r5(c) for c in poly.simplify(0.00001).exterior.coords]})
    (OUT / "buildings.json").write_text(json.dumps(out))
    note("buildings", "OpenStreetMap building and building:part footprints, height >= 20 m or >= 6 levels", len(out))


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
        sites.append({"lon": round(lon, 5), "lat": round(lat, 5), "kind": kind, "name": t.get("name") or f"unnamed {kind}", "src": "OSM"})
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
    # Class B shelves at every floor: the upper sky-lane tiers sit inside them and need ATC clearance.
    shelves = clip({"features": [f for f in json.load(open(RAW / "class_airspace.geojson"))["features"] if f["properties"]["CLASS"] == "B"]},
                   lambda p: {"name": p["NAME"], "lower_ft": p["LOWER_VAL"] or 0, "upper_ft": p["UPPER_VAL"]})
    cats = clip(json.load(open(RAW / "faa_operating_categories.geojson")),
                lambda p: {"category": int(p["POP_DENSITY"].split()[-1])})
    out = {"facility_map": fm, "surface_areas": surf, "operating_categories": cats, "class_b": shelves}
    (OUT / "airspace.json").write_text(json.dumps(out))
    note("facility_map", "FAA UAS Facility Map (LAANC ceilings)", len(fm))
    note("surface", "FAA ADDS Class airspace, surface areas", len(surf))
    note("class_b", "FAA ADDS Class B shelves (all floors)", len(shelves))
    note("op_categories", "FAA ADDS Operating Categories Map", len(cats))


# ---------------------------------------------------------------- crewed traffic (ADS-B)
TRAFFIC_M = 1000
BANDS_FT = [0, 500, 1000, 2000, 3000]
GEOID_M = -23.0  # EGM96 geoid height over Puget Sound: MSL = GNSS ellipsoid height + 23 m


def build_traffic():
    """Mean number of crewed aircraft present per km² in each altitude band, from the ADS-B samples adsb.py kept."""
    import numpy as np
    files = sorted((RAW / "adsb").glob("*.csv.gz")) if (RAW / "adsb").exists() else []
    if not files:
        print("traffic      skipped: run pipeline/adsb.py first")
        return
    rotor = set()
    with open(RAW / "aircraft_db.csv", newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            if row["icaoaircrafttype"].startswith("H") or row["categoryDescription"].lower().startswith("rotorcraft"):
                rotor.add(row["icao24"])
    dem = np.load(RAW / "dem.npy")
    dm = json.loads((RAW / "dem.json").read_text())
    dlon, dlat = TRAFFIC_M / M_LON, TRAFFIC_M / M_LAT
    nx, ny, nb = math.ceil((E - W) / dlon), math.ceil((N - S) / dlat), len(BANDS_FT) - 1
    allc, rotc = np.zeros((nb, ny, nx)), np.zeros((nb, ny, nx))
    seen, speed, rows, stale = [set() for _ in range(nb)], [[] for _ in range(nb)], 0, 0
    for f in files:
        with gzip.open(f, "rt") as fh:
            for r in csv.DictReader(fh):
                if float(r["time"]) - float(r["lastposupdate"] or 0) > 15:
                    stale += 1  # position not refreshed: the receiver lost it; do not smear it along
                    continue
                lon, lat = float(r["lon"]), float(r["lat"])
                msl = float(r["geoaltitude"]) - GEOID_M if r["geoaltitude"] else float(r["baroaltitude"])
                gz = dem[min(dem.shape[0] - 1, int((dm["north"] - lat) / dm["dlat"])), min(dem.shape[1] - 1, int((lon - dm["west"]) / dm["dlon"]))]
                agl = (msl - (0 if np.isnan(gz) else gz)) * FT
                if agl >= BANDS_FT[-1]:
                    continue
                b = max(0, next(k for k in range(nb) if agl < BANDS_FT[k + 1]))
                i, j = min(nx - 1, int((lon - W) / dlon)), min(ny - 1, int((lat - S) / dlat))
                allc[b, j, i] += 1
                if r["icao24"] in rotor:
                    rotc[b, j, i] += 1
                seen[b].add(r["icao24"])
                if r["velocity"]:
                    speed[b].append(float(r["velocity"]))
                rows += 1
    hours = len(files)
    # One state vector stands for 10 s; density = aircraft-seconds / sampled seconds / km² (cells are 1 km²).
    to_rho = lambda c: c * 10 / (hours * 3600) / (TRAFFIC_M / 1000) ** 2

    def smooth(a):  # 3×3 mean: tracks are sparse and a 1 km cell is smaller than a turn
        p = np.pad(a, ((0, 0), (1, 1), (1, 1)))
        return sum(p[:, 1 + dj:1 + dj + a.shape[1], 1 + di:1 + di + a.shape[2]] for dj in (-1, 0, 1) for di in (-1, 0, 1)) / 9
    rho, rrho = smooth(to_rho(allc)), smooth(to_rho(rotc))
    pct = [[float(np.percentile(rho[b], q)) for q in (50, 90, 99)] for b in range(nb)]
    days = sorted({f.name[:10] for f in files})
    (OUT / "traffic.json").write_text(json.dumps({
        "west": W, "south": S, "dlon": dlon, "dlat": dlat, "nx": nx, "ny": ny, "cell_m": TRAFFIC_M, "bands_ft": BANDS_FT,
        "unit": "mean crewed aircraft present per km² (3×3 cell smoothing)",
        "density": [b64(np.asarray(rho[b], "<f4").ravel()) for b in range(nb)],
        "rotor": [b64(np.asarray(rrho[b], "<f4").ravel()) for b in range(nb)],
        "pct": pct, "speed_ms": [round(float(np.median(v)), 1) if v else 50.0 for v in speed],
        "aircraft": [len(x) for x in seen], "days": days, "hours": hours,
        "window": "Mondays 07:00-17:00 PDT (14-23 UTC)"}))
    note("traffic", f"OpenSky Network historical ADS-B state vectors ({len(days)} Mondays, {hours} hours), below 3,000 ft AGL",
         rows, aircraft=sum(len(x) for x in seen), stale_dropped=stale, days=days)


# ---------------------------------------------------------------- wind climatology (HRRR)
KT = 1.94384
DAY_HOURS = (7, 20)  # local operating day


def build_wind():
    """Per HRRR point: daytime wind percentiles at 10 and 80 m, gusts, exceedance of drone limits, wind rose, by month."""
    import numpy as np
    from zoneinfo import ZoneInfo
    from hrrr import grid_lonlat
    files = sorted((RAW / "hrrr").glob("*.npz")) if (RAW / "hrrr").exists() else []
    if not files:
        print("wind         skipped: run pipeline/hrrr.py first")
        return
    win = json.loads((RAW / "hrrr" / "window.json").read_text())
    data, times = [], []
    for f in files:
        z = np.load(f)
        data.append(z["data"].astype(np.float32)); times += list(z["time"])
    a = np.concatenate(data)  # [t, var, j, i]
    tz = ZoneInfo("America/Los_Angeles")
    loc = [datetime.datetime.fromisoformat(t).replace(tzinfo=datetime.timezone.utc).astimezone(tz) for t in times]
    day = np.array([DAY_HOURS[0] <= t.hour < DAY_HOURS[1] for t in loc])
    month = np.array([t.month for t in loc])
    a, month = a[day], month[day]
    ws10, ws80, gust = np.hypot(a[:, 0], a[:, 1]) * KT, np.hypot(a[:, 2], a[:, 3]) * KT, a[:, 4] * KT
    dir80 = (np.degrees(np.arctan2(-a[:, 2], -a[:, 3])) + 360) % 360  # direction the wind blows from
    pts, idx = [], []
    for j in range(a.shape[2]):
        for i in range(a.shape[3]):
            lon, lat = grid_lonlat(win["i0"] + i, win["j0"] + j)
            if W - 0.02 <= lon <= E + 0.02 and S - 0.02 <= lat <= N + 0.02:
                pts.append([round(lon, 4), round(lat, 4)]); idx.append((j, i))
    J, I = np.array([p[0] for p in idx]), np.array([p[1] for p in idx])
    q = lambda x, p: np.round(np.percentile(x[:, J, I], p, axis=0), 1).tolist()
    ex = lambda x, v: np.round((x[:, J, I] > v).mean(axis=0), 3).tolist()
    sector = ((dir80[:, J, I] + 22.5) // 45 % 8).astype(int)
    rose = [np.round((sector == k).mean(axis=0), 3).tolist() for k in range(8)]
    strong = ws80[:, J, I] > 15
    rose15 = [np.round(((sector == k) & strong).mean(axis=0), 3).tolist() for k in range(8)]
    gf = np.round(np.median(gust[:, J, I] / np.maximum(ws10[:, J, I], 1), axis=0), 2).tolist()
    by_month = {m: month == m for m in range(1, 13)}
    out = {
        "source": "NOAA HRRR analyses (3 km, hourly) via the University of Utah HRRR Zarr archive on AWS",
        "year": win["year"], "hours": int(day.sum()), "day_hours": list(DAY_HOURS), "unit": "kt", "points": pts,
        "p50_80": q(ws80, 50), "p90_80": q(ws80, 90), "p50_10": q(ws10, 50), "p90_10": q(ws10, 90),
        "gust_p99": q(gust, 99), "gust_factor": gf,
        "over_80": {str(v): ex(ws80, v) for v in (15, 20, 25)}, "gust_over": {str(v): ex(gust, v) for v in (25, 30, 35)},
        "rose": rose, "rose_over15": rose15,
        "month_over20_80": [np.round((ws80[by_month[m]][:, J, I] > 20).mean(axis=0), 3).tolist() for m in range(1, 13)],
    }
    (OUT / "wind.json").write_text(json.dumps(out, separators=(",", ":")))
    note("wind", f"NOAA HRRR {win['year']} hourly analyses, 10 m and 80 m wind and surface gust, local {DAY_HOURS[0]:02d}:00-{DAY_HOURS[1]:02d}:00",
         len(pts), hours=int(day.sum()), months=len(files))


# ---------------------------------------------------------------- Phase 1 layers (built by their own scripts)
def note_phase1():
    """Manifest notes for the layers diurnal.py, noise311.py, roadcounts.py and cellular.py write; absent ones are skipped."""
    def load(name):
        p = OUT / f"{name}.json"
        return json.loads(p.read_text()) if p.exists() else None

    if d := load("diurnal"):
        years = "+".join(sorted({m for f in d["sources"]["atus"]["files"] for m in re.findall(r"(\d{4})", f)}))
        note("diurnal", f"BLS American Time Use Survey {years} (where people are, by hour) + Census {d['local']['acs']} (commute timing, work from home)",
             d["weekday"]["n_diaries"] + d["weekend"]["n_diaries"], built=d["built"], commuter_factor=d["local"]["commuter_factor"])
    if n := load("noise311"):
        note("noise311", f"City of Seattle open data: SPD noise calls with a police response, SDCI noise complaints, Find It Fix It noise requests (geocoded only), {n['start']} to {n['end']}, Seattle only",
             n["records"], cells=len(n["cells"]) // 6, cell_m=n["cell_m"], built=n["built"])
    if r := load("roadcounts"):
        src = [s["src"] for s in r["segs"]]
        note("roadcounts", f"SDOT 2024 Arterial Traffic Volumes + WSDOT Traffic Sections AADT (reporting year {r['sources']['wsdot'].get('reporting_year')}, described by WSDOT as 2023 estimates); FHWA TMAS weekday hourly shape (WSDOT recorders, Apr + Oct 2024)",
             len(src), sdot=src.count("sdot"), wsdot=src.count("wsdot"), sdot_awdt_only=sum(bool(s.get("awdt_only")) for s in r["segs"]), stations=r["hourly"]["stations"], built=r["built"])
    if c := load("cellular"):
        note("cellular", f"Speedtest by Ookla open data, mobile speed tests on tiles {c['quarter']} (CC BY-NC-SA 4.0, non-commercial)", c["count"], tests=c["tests"], z=c["z"])


if __name__ == "__main__" and "--notes" in sys.argv:
    # refresh only the Phase 1 notes in an existing manifest
    manifest = json.loads((OUT / "manifest.json").read_text())
    note_phase1()
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
elif __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build_obstacles()
    build_buildings()
    build_sites()
    build_airspace()
    build_grid()  # after build_airspace: rasterizes its polygons
    build_traffic()
    build_wind()
    note_phase1()
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
