"""Crewed-aircraft traffic over the metro from historical ADS-B: OpenSky Network state-vector samples.

OpenSky publishes every state vector its receivers heard, at 10 s resolution, for one Monday a week from
2020-05-25 to 2022-06-27 (https://opensky-network.org/datasets/states/, free for research and non-commercial use).
Each hour is a ~180 MB tar of a gzipped CSV for the whole world. This script streams the chosen hours, keeps only the
rows inside the bbox below 3,000 ft above ground, and writes them to data/raw/adsb/<date>-<hour>.csv.gz, so a rerun
skips hours it already has. build.py turns the samples into the traffic-density layer.

    python adsb.py                  # the default sample: 4 Mondays (one per season), 07:00-17:00 Pacific
    python adsb.py 2022-06-20 ...   # other Mondays from the OpenSky list
"""
import csv, gzip, io, sys, tarfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fetch import RAW, UA
from metro import METRO

# Mondays spread over a year, so seasonal flying (summer floatplanes, winter IFR) is in the sample.
DAYS = ["2021-09-13", "2021-12-13", "2022-03-14", "2022-06-20"]
HOURS = range(14, 24)  # UTC 14:00-23:59 = 07:00-16:59 PDT (06:00-15:59 PST); OpenSky files hold only the Monday's own UTC hours
MAX_MSL_M = 1500  # 4,900 ft MSL: enough for 3,000 ft above the highest ground in the box
OUT = RAW / "adsb"
URL = "https://s3.opensky-network.org/data-samples/states/{d}/{h:02d}/states_{d}-{h:02d}.csv.tar"
KEEP = ["time", "icao24", "lat", "lon", "velocity", "heading", "vertrate", "callsign", "baroaltitude", "geoaltitude", "lastposupdate"]


def hour_slots(days):
    return [(d, h) for d in days for h in HOURS]


def fetch_hour(d, h):
    out = OUT / f"{d}-{h:02d}.csv.gz"
    if out.exists():
        return out.name, None
    w, s, e, n = METRO["bbox"]
    t0, kept, seen = time.time(), 0, 0
    for attempt in range(4):
        try:
            req = urllib.request.Request(URL.format(d=d, h=h), headers=UA)
            buf = io.BytesIO()
            with urllib.request.urlopen(req, timeout=300) as r, tarfile.open(fileobj=r, mode="r|") as tar:
                for m in tar:
                    if not m.name.endswith(".csv.gz"):
                        continue
                    rows = io.TextIOWrapper(gzip.GzipFile(fileobj=tar.extractfile(m)), encoding="utf-8")
                    head = next(rows).strip().split(",")
                    ix = {k: head.index(k) for k in KEEP}
                    ilat, ilon, ialt, igeo, iground = ix["lat"], ix["lon"], ix["baroaltitude"], ix["geoaltitude"], head.index("onground")
                    with gzip.open(buf, "wt", newline="") as fo:
                        wr = csv.writer(fo)
                        wr.writerow(KEEP)
                        for line in rows:
                            seen += 1
                            c = line.rstrip("\n").split(",")
                            # cheap string tests before float parsing: most of the world is outside the box
                            if not c[ilat] or not c[ilon] or c[iground] == "True":
                                continue
                            lat, lon = float(c[ilat]), float(c[ilon])
                            if not (s <= lat <= n and w <= lon <= e):
                                continue
                            alt = c[igeo] or c[ialt]
                            if not alt or float(alt) > MAX_MSL_M:
                                continue
                            wr.writerow([c[ix[k]] for k in KEEP])
                            kept += 1
            out.write_bytes(buf.getvalue())
            return out.name, f"{kept:,} of {seen:,} rows in {time.time() - t0:.0f}s"
        except Exception as ex:  # noqa: BLE001  long streams drop; start the hour again
            if attempt == 3:
                return out.name, f"FAILED: {ex}"
            time.sleep(10 * (attempt + 1))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    days = [a for a in sys.argv[1:] if a[:2] == "20"] or DAYS
    slots = list(hour_slots(days))
    print(f"ADS-B: {len(slots)} hours from OpenSky ({', '.join(days)}), streaming ~180 MB each")
    with ThreadPoolExecutor(4) as ex:  # the OpenSky bucket gives ~5 MB/s per stream
        for name, msg in ex.map(lambda dh: fetch_hour(*dh), slots):
            print(f"{'have' if msg is None else 'get '} {name}" + (f"  {msg}" if msg else ""))


if __name__ == "__main__":
    main()
