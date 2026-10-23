"""Mobile network coverage from Ookla Open Data (Speedtest by Ookla Global Fixed and Mobile Network Performance Maps).

Ookla publishes, per quarter, the mean download / upload / latency of every Speedtest run on a phone, aggregated to
zoom-16 web-mercator tiles (~610 m at the equator, ~410 x 410 m here), with test and device counts. A tile with no
tests is absent, which means "nobody measured", not "no signal". Licence CC BY-NC-SA 4.0 (non-commercial, attribute).

This finds the latest mobile quarter in the public bucket, downloads the shapefile zip with curl into
data/raw/cellular/, reads only the .dbf (quadkey + numbers; tile geometry follows from the quadkey) and keeps the
tiles that touch the bbox. Output app/data/cellular.json, columnar:
  z=16, x0/y0 tile origin, tiles as parallel arrays dx, dy (tile x - x0, y - y0), d / u (kbps), lat (ms), tests, dev.

    python cellular.py            # latest quarter
    python cellular.py 2026 2     # a given year and quarter
"""
import json, math, re, subprocess, sys, urllib.request, zipfile

import shapefile

from fetch import RAW, UA
from metro import METRO

BUCKET = "https://ookla-open-data.s3.amazonaws.com"
PREFIX = "shapefiles/performance/type=mobile/"
Z = 16
DIR = RAW / "cellular"
OUT = RAW.parent.parent / "app" / "data" / "cellular.json"
W, S, E, N = METRO["bbox"]


def keys():
    req = urllib.request.Request(f"{BUCKET}/?list-type=2&prefix={PREFIX}", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        xml = r.read().decode()
    return sorted(k for k in re.findall(r"<Key>([^<]+_performance_mobile_tiles\.zip)</Key>", xml))


def tile(lon, lat):
    n = 2 ** Z
    y = math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat)))
    return int((lon + 180) / 360 * n), int((1 - y / math.pi) / 2 * n)


def quad(qk):
    x = y = 0
    for i, c in enumerate(qk):
        b, m = int(c), 1 << (len(qk) - 1 - i)
        x |= m if b & 1 else 0
        y |= m if b & 2 else 0
    return x, y


def main():
    ks = keys()
    if len(sys.argv) > 2:
        ks = [k for k in ks if f"year={sys.argv[1]}/quarter={sys.argv[2]}/" in k]
    key = ks[-1]
    year, q = re.search(r"year=(\d+)/quarter=(\d)", key).groups()
    DIR.mkdir(parents=True, exist_ok=True)
    zp = DIR / key.rsplit("/", 1)[1]
    if not zp.exists():
        print(f"downloading {key}")
        subprocess.run(["curl", "-sSfL", "-o", str(zp), f"{BUCKET}/{key}"], check=True)
    with zipfile.ZipFile(zp) as z:
        dbf = next(n for n in z.namelist() if n.endswith(".dbf"))
        if not (DIR / dbf).exists() or (DIR / dbf).stat().st_size != z.getinfo(dbf).file_size:
            z.extract(dbf, DIR)
    (x0, y0), (x1, y1) = tile(W, N), tile(E, S)  # tile y grows southward
    rd = shapefile.Reader(dbf=open(DIR / dbf, "rb"))
    f = [fd.name for fd in rd.fields[1:]]
    iq, ilon, ilat = f.index("quadkey"), f.index("tile_x"), f.index("tile_y")
    cols = [f.index(c) for c in ("avg_d_kbps", "avg_u_kbps", "avg_lat_ms", "tests", "devices")]
    pad = 0.01  # tile_x/tile_y are tile centres; pad by more than half a tile before the exact quadkey test
    rows = []
    for r in rd.iterRecords():
        if not (W - pad <= r[ilon] <= E + pad and S - pad <= r[ilat] <= N + pad):
            continue
        x, y = quad(r[iq])
        if x0 <= x <= x1 and y0 <= y <= y1:
            rows.append((x - x0, y - y0, *(int(r[c]) for c in cols)))
    rows.sort()
    dx, dy, d, u, lat, tests, dev = (list(c) for c in zip(*rows))
    out = {"source": "Speedtest by Ookla Global Fixed and Mobile Network Performance Maps, mobile tiles "
                     f"(s3://ookla-open-data/{key})",
           "license": "CC BY-NC-SA 4.0, Ookla open data; attribution required, non-commercial",
           "quarter": f"{year}-Q{q}", "z": Z, "x0": x0, "y0": y0, "nx": x1 - x0 + 1, "ny": y1 - y0 + 1,
           "count": len(rows), "tests": sum(tests), "unit": {"d": "kbps", "u": "kbps", "lat": "ms"},
           "dx": dx, "dy": dy, "d": d, "u": u, "lat": lat, "tests_n": tests, "dev": dev}
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"cellular {len(rows):>7,} tiles of {out['nx'] * out['ny']:,} in bbox, {sum(tests):,} tests, "
          f"{year}-Q{q}, {OUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
