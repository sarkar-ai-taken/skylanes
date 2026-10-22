"""Download the raw public data for one metro into data/raw/.

Every source here is public and free. Re-running skips files that already exist;
pass --force to refetch, and --only name,name to touch just those files. Sources and their licences are listed in pipeline/SOURCES.md.
"""
import gzip, json, sys, time, urllib.parse, urllib.request, zipfile
from pathlib import Path

from metro import METRO

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
UA = {"User-Agent": "corridor-pipeline/0.1 (route safety-case prototype)"}
FORCE = "--force" in sys.argv
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
skip = lambda name: ONLY is not None and name not in ONLY


def get(url, data=None, tries=6):
    wait = 5
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001  network sources fail transiently
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} after {e}; waiting {wait}s")
            time.sleep(wait)
            wait *= 2


def download(name, url):
    out = RAW / name
    if skip(name.split(".")[0]):
        return out
    if out.exists() and not FORCE:
        print(f"have {name}")
        return out
    print(f"get  {name}")
    out.write_bytes(get(url))
    return out


def arcgis(name, service, where="1=1", fields="*"):
    """Page through an ArcGIS FeatureServer layer clipped to the metro bbox, as GeoJSON."""
    out = RAW / f"{name}.geojson"
    if skip(name):
        return
    if out.exists() and not FORCE:
        print(f"have {out.name}")
        return
    print(f"get  {out.name}")
    w, s, e, n = METRO["bbox"]
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": where, "outFields": fields, "f": "geojson", "outSR": 4326,
            "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            "resultOffset": offset, "resultRecordCount": 2000,
        })
        page = json.loads(get(f"{FAA}/{service}/FeatureServer/0/query?{q}"))
        feats += page.get("features", [])
        if not page.get("properties", {}).get("exceededTransferLimit") and not page.get("exceededTransferLimit"):
            break
        offset += 2000
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    print(f"     {len(feats)} features")


def overpass(name, query, split=2):
    """Run an Overpass query over the bbox in split×split pieces (the public server times out on big areas) and merge."""
    out = RAW / f"{name}.json"
    if skip(name):
        return
    if out.exists() and not FORCE:
        print(f"have {out.name}")
        return
    print(f"get  {out.name} (Overpass, {split * split} pieces; slow when the public server is busy)")
    w, s, e, n = METRO["bbox"]
    seen, elements = set(), []
    for a in range(split):
        for b in range(split):
            sw, ss = w + (e - w) * a / split, s + (n - s) * b / split
            se, sn = w + (e - w) * (a + 1) / split, s + (n - s) * (b + 1) / split
            body = urllib.parse.urlencode({"data": f"[out:json][timeout:300][bbox:{ss},{sw},{sn},{se}];{query}"}).encode()
            for el in json.loads(get("https://overpass-api.de/api/interpreter", data=body, tries=8))["elements"]:
                if (el["type"], el["id"]) not in seen:
                    seen.add((el["type"], el["id"]))
                    elements.append(el)
            time.sleep(2)  # be polite to the shared server
    out.write_text(json.dumps({"elements": elements}))
    print(f"     {len(elements)} elements")


DEM_M = 20  # terrain posting; fine enough to take ground height out of lidar returns and ADS-B altitudes
DEM_TILE = 2000


def dem():
    """USGS 3DEP bare-earth elevation (m, NAVD88) for the bbox, DEM_M north-south, from the 3DEP ImageServer, as one float32 grid.

    Saved as data/raw/dem.npy, rows north to south, with dem.json giving the origin and step.
    """
    import numpy as np
    out, meta = RAW / "dem.npy", RAW / "dem.json"
    if skip("dem"):
        return
    if out.exists() and not FORCE:
        print("have dem.npy")
        return
    import math
    w, s, e, n = METRO["bbox"]
    # Square pixels in degrees: the ImageServer silently widens the extent to make them square otherwise.
    dlon = dlat = DEM_M / 110_574.0
    nx, ny = math.ceil((e - w) / dlon), math.ceil((n - s) / dlat)
    print(f"get  dem.npy (3DEP, {nx}x{ny} at {DEM_M} m, {math.ceil(nx / DEM_TILE) * math.ceil(ny / DEM_TILE)} pieces)")
    z = np.full((ny, nx), np.nan, dtype=np.float32)
    for j0 in range(0, ny, DEM_TILE):
        for i0 in range(0, nx, DEM_TILE):
            tw, th = min(DEM_TILE, nx - i0), min(DEM_TILE, ny - j0)
            bb = (w + i0 * dlon, n - (j0 + th) * dlat, w + (i0 + tw) * dlon, n - j0 * dlat)
            q = urllib.parse.urlencode({"bbox": ",".join(f"{v:.7f}" for v in bb), "bboxSR": 4326, "imageSR": 4326,
                                        "size": f"{tw},{th}", "format": "bsq", "pixelType": "F32", "noData": -9999,
                                        "interpolation": "RSP_BilinearInterpolation", "f": "image"})
            raw = get(f"https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?{q}")
            a = np.frombuffer(raw[:tw * th * 4], dtype="<f4").reshape(th, tw)  # the service appends a short trailer
            z[j0:j0 + th, i0:i0 + tw] = np.where(a < -1000, np.nan, a)
    np.save(out, z)
    meta.write_text(json.dumps({"west": w, "north": n, "dlon": dlon, "dlat": dlat, "nx": nx, "ny": ny, "m": DEM_M,
                                "source": "USGS 3DEP ImageServer (bare earth, NAVD88 m)"}))


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    st = METRO["state_fips"]
    # Census 2020 blocks carry POP20 and ALAND20 in the TIGER file itself.
    download("tabblock.zip", f"https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{st}_tabblock20.zip")
    # LEHD LODES workplace area characteristics: jobs per census block (daytime population).
    download("wac.csv.gz", f"https://lehd.ces.census.gov/data/lodes/LODES8/{METRO['state']}/wac/{METRO['state']}_wac_S000_JT00_2021.csv.gz")
    # FAA Digital Obstacle File, national, updated daily.
    z = download("dof_csv.zip", "https://aeronav.faa.gov/Obst_Data/DAILY_DOF_CSV.ZIP")
    if not skip("dof_csv") and (not (RAW / "dof" / "DOF.CSV").exists() or FORCE):
        zipfile.ZipFile(z).extractall(RAW / "dof")
    # FAA ADDS layers.
    arcgis("facility_map", "FAA_UAS_FacilityMap_Data")
    arcgis("airports", "US_Airport")
    arcgis("class_airspace", "Class_Airspace")
    arcgis("stadiums", "Stadiums")
    arcgis("faa_operating_categories", "Operating_Categories_Map")
    arcgis("nsufr", "Part_Time_National_Security_UAS_Flight_Restrictions")
    # OSM: hospitals, schools, helipads and tall buildings.
    overpass("osm_sites", 'nwr["amenity"~"^(hospital|school|kindergarten|college|university)$"];out center tags;'
                          'nwr["aeroway"="helipad"];out center tags;nwr["leisure"="stadium"];out center tags;')
    overpass("osm_tall", 'way["building"]["height"](if:number(t["height"])>=25);out center tags;'
                         'way["building"]["building:levels"](if:number(t["building:levels"])>=8);out center tags;'
                         'nwr["man_made"~"^(mast|tower|chimney|crane)$"];out center tags;'
                         'way["power"="line"];out geom tags;')
    # Footprints of every building tall enough (relations need the full body, "out geom", for their members' geometry) to matter at 150-400 ft: tagged height >= 20 m or >= 6 levels.
    overpass("osm_buildings", 'way["building"]["height"](if:number(t["height"])>=20);out geom tags;'
                              'way["building"]["building:levels"](if:number(t["building:levels"])>=6);out geom tags;'
                              'relation["building"]["height"](if:number(t["height"])>=20);out geom;'
                              # towers mapped as parts (Columbia Center, many downtown high-rises)
                              'way["building:part"]["height"](if:number(t["height"])>=20);out geom tags;'
                              'way["building:part"]["building:levels"](if:number(t["building:levels"])>=6);out geom tags;'
                              'relation["building:part"]["height"](if:number(t["height"])>=20);out geom;')
    # Land use, parks, woods and water: what is on the ground under the route and where a contingency landing can go.
    overpass("osm_landuse", 'way["landuse"];out geom tags;relation["landuse"]["type"="multipolygon"];out geom;'
                            'way["leisure"~"^(park|golf_course|pitch|recreation_ground|playground|nature_reserve|garden)$"];out geom tags;'
                            'relation["leisure"~"^(park|golf_course|nature_reserve)$"];out geom;'
                            'way["natural"~"^(wood|scrub|grassland|heath|wetland|water|beach)$"];out geom tags;'
                            'relation["natural"~"^(wood|wetland|water)$"]["type"="multipolygon"];out geom;'
                            'way["amenity"~"^(parking|school|hospital|university|college)$"];out geom tags;', split=4)
    # USGS 3DEP bare-earth terrain: ground height for the lidar and ADS-B layers.
    dem()
    # OpenSky aircraft database: tells rotorcraft (ICAO type H*) from fixed-wing in the ADS-B samples.
    download("aircraft_db.csv", "https://s3.opensky-network.org/data-samples/metadata/aircraftDatabase.csv")
    # Arterial roads: the air-road network follows them (fewer people below, noise masked by traffic).
    overpass("osm_roads", 'way["highway"~"^(motorway|trunk|primary|secondary)$"];out geom tags;')


if __name__ == "__main__":
    main()
