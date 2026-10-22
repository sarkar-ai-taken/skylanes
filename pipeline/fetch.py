"""Download the raw public data for one metro into data/raw/.

Every source here is public and free. Re-running skips files that already exist;
pass --force to refetch. Sources and their licences are listed in pipeline/SOURCES.md.
"""
import gzip, json, sys, time, urllib.parse, urllib.request, zipfile
from pathlib import Path

from metro import METRO

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
UA = {"User-Agent": "corridor-pipeline/0.1 (route safety-case prototype)"}
FORCE = "--force" in sys.argv


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
    if out.exists() and not FORCE:
        print(f"have {name}")
        return out
    print(f"get  {name}")
    out.write_bytes(get(url))
    return out


def arcgis(name, service, where="1=1", fields="*"):
    """Page through an ArcGIS FeatureServer layer clipped to the metro bbox, as GeoJSON."""
    out = RAW / f"{name}.geojson"
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


def overpass(name, query):
    out = RAW / f"{name}.json"
    if out.exists() and not FORCE:
        print(f"have {out.name}")
        return
    print(f"get  {out.name} (Overpass; slow when the public server is busy)")
    s, w, n, e = METRO["bbox"][1], METRO["bbox"][0], METRO["bbox"][3], METRO["bbox"][2]
    body = urllib.parse.urlencode({"data": f"[out:json][timeout:180][bbox:{s},{w},{n},{e}];{query}"}).encode()
    out.write_bytes(get("https://overpass-api.de/api/interpreter", data=body, tries=8))


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    st = METRO["state_fips"]
    # Census 2020 blocks carry POP20 and ALAND20 in the TIGER file itself.
    download("tabblock.zip", f"https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{st}_tabblock20.zip")
    # LEHD LODES workplace area characteristics: jobs per census block (daytime population).
    download("wac.csv.gz", f"https://lehd.ces.census.gov/data/lodes/LODES8/{METRO['state']}/wac/{METRO['state']}_wac_S000_JT00_2021.csv.gz")
    # FAA Digital Obstacle File, national, updated daily.
    z = download("dof_csv.zip", "https://aeronav.faa.gov/Obst_Data/DAILY_DOF_CSV.ZIP")
    if not (RAW / "dof" / "DOF.CSV").exists() or FORCE:
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
    # Footprints of every building tall enough to matter at 150-400 ft: tagged height >= 20 m or >= 6 levels.
    overpass("osm_buildings", 'way["building"]["height"](if:number(t["height"])>=20);out geom tags;'
                              'way["building"]["building:levels"](if:number(t["building:levels"])>=6);out geom tags;'
                              'relation["building"]["height"](if:number(t["height"])>=20);out geom tags;'
                              # towers mapped as parts (Columbia Center, many downtown high-rises)
                              'way["building:part"]["height"](if:number(t["height"])>=20);out geom tags;'
                              'way["building:part"]["building:levels"](if:number(t["building:levels"])>=6);out geom tags;'
                              'relation["building:part"]["height"](if:number(t["height"])>=20);out geom tags;')
    # Arterial roads: the air-road network follows them (fewer people below, noise masked by traffic).
    overpass("osm_roads", 'way["highway"~"^(motorway|trunk|primary|secondary)$"];out geom tags;')


if __name__ == "__main__":
    main()
