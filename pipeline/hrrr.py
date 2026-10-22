"""Wind climatology from the NOAA HRRR analysis archive (3 km, hourly), via the University of Utah HRRR Zarr mirror on AWS.

For every hour of YEAR this reads the 10 m and 80 m wind and the surface gust over the bbox, rotates the winds from
the HRRR Lambert grid to true north, and caches one month per file in data/raw/hrrr/<YYYY-MM>.npz.
build.py summarizes the year into app/data/wind.json (speed percentiles, exceedance, wind rose, by month and hour).

    python hrrr.py           # YEAR below
    python hrrr.py 2024      # another year
"""
import math, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import datetime as dt

import numpy as np
import numcodecs

from fetch import RAW, UA
from metro import METRO

YEAR = 2025
BASE = "https://hrrrzarr.s3.amazonaws.com/sfc/{d}/{d}_{h:02d}z_anl.zarr/{lvl}/{var}/{lvl}/{var}/{cj}.{ci}"
VARS = [("10m_above_ground", "UGRD"), ("10m_above_ground", "VGRD"), ("80m_above_ground", "UGRD"),
        ("80m_above_ground", "VGRD"), ("surface", "GUST")]
CHUNK = 150
OUT = RAW / "hrrr"

# HRRR CONUS grid: Lambert conformal, tangent at 38.5N, centre meridian 97.5W, 3 km, first point at the SW corner.
R_EARTH, LAT1, LON0, DX = 6371229.0, math.radians(38.5), math.radians(-97.5), 3000.0
CONE = math.sin(LAT1)
_F = math.cos(LAT1) * math.tan(math.pi / 4 + LAT1 / 2) ** CONE / CONE
_rho = lambda phi: R_EARTH * _F / math.tan(math.pi / 4 + phi / 2) ** CONE
_RHO0 = _rho(LAT1)


def _xy(lon, lat):
    r, t = _rho(math.radians(lat)), CONE * (math.radians(lon) - LON0)
    return r * math.sin(t), _RHO0 - r * math.cos(t)


_X1, _Y1 = _xy(-122.719528, 21.138123)


def grid_index(lon, lat):
    """Fractional (i, j) on the HRRR grid; i east, j north."""
    x, y = _xy(lon, lat)
    return (x - _X1) / DX, (y - _Y1) / DX


def grid_lonlat(i, j):
    """Inverse of grid_index."""
    x, y = _X1 + i * DX, _Y1 + j * DX
    r = math.copysign(math.hypot(x, _RHO0 - y), CONE)
    t = math.atan2(x, _RHO0 - y)
    lat = 2 * math.atan((R_EARTH * _F / r) ** (1 / CONE)) - math.pi / 2
    return math.degrees(t / CONE + LON0), math.degrees(lat)


def window():
    """The HRRR index window covering the bbox (one cell of margin), and the chunks it touches."""
    w, s, e, n = METRO["bbox"]
    ii, jj = zip(*(grid_index(lo, la) for lo in (w, e) for la in (s, n)))
    i0, i1, j0, j1 = math.floor(min(ii)) - 1, math.ceil(max(ii)) + 1, math.floor(min(jj)) - 1, math.ceil(max(jj)) + 1
    chunks = [(cj, ci) for cj in range(j0 // CHUNK, j1 // CHUNK + 1) for ci in range(i0 // CHUNK, i1 // CHUNK + 1)]
    return i0, i1, j0, j1, chunks


def get(url, tries=5):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None  # an hour missing from the archive
            if k == tries - 1:
                raise
        except Exception:  # noqa: BLE001
            if k == tries - 1:
                raise
        time.sleep(2 ** k)


def read_hour(t, win):
    """[5, nj, ni] float32 for one analysis hour, or None if any field is missing."""
    i0, i1, j0, j1, chunks = win
    out = np.empty((len(VARS), j1 - j0 + 1, i1 - i0 + 1), np.float32)
    d = t.strftime("%Y%m%d")
    for k, (lvl, var) in enumerate(VARS):
        for cj, ci in chunks:
            b = get(BASE.format(d=d, h=t.hour, lvl=lvl, var=var, cj=cj, ci=ci))
            if b is None:
                return None
            a = np.frombuffer(numcodecs.Blosc().decode(b), "<f4").reshape(CHUNK, CHUNK)
            ys, xs = slice(max(j0, cj * CHUNK), min(j1 + 1, (cj + 1) * CHUNK)), slice(max(i0, ci * CHUNK), min(i1 + 1, (ci + 1) * CHUNK))
            out[k, ys.start - j0:ys.stop - j0, xs.start - i0:xs.stop - i0] = a[ys.start - cj * CHUNK:ys.stop - cj * CHUNK, xs.start - ci * CHUNK:xs.stop - ci * CHUNK]
    return out


def rotation(win):
    """Angle (rad) that turns HRRR grid-relative u/v into earth-relative at each window point."""
    i0, i1, j0, j1, _ = win
    lon = np.array([[grid_lonlat(i, j)[0] for i in range(i0, i1 + 1)] for j in range(j0, j1 + 1)])
    return CONE * np.radians(lon - math.degrees(LON0))


def month(year, m, win):
    out = OUT / f"{year}-{m:02d}.npz"
    if out.exists():
        return f"have {out.name}"
    t0 = dt.datetime(year, m, 1)
    hours = [t0 + dt.timedelta(hours=h) for h in range(((dt.datetime(year + m // 12, m % 12 + 1, 1)) - t0).days * 24)]
    with ThreadPoolExecutor(16) as ex:
        fields = list(ex.map(lambda t: read_hour(t, win), hours))
    keep = [k for k, f in enumerate(fields) if f is not None]
    a = np.stack([fields[k] for k in keep])  # [t, var, j, i]
    rot = rotation(win)
    c, s = np.cos(rot), np.sin(rot)
    for u, v in ((0, 1), (2, 3)):  # grid-relative to earth-relative
        ue, ve = c * a[:, u] + s * a[:, v], -s * a[:, u] + c * a[:, v]
        a[:, u], a[:, v] = ue, ve
    np.savez_compressed(out, data=a.astype(np.float16), time=np.array([hours[k].isoformat() for k in keep]))
    return f"get  {out.name}  {len(keep)} of {len(hours)} hours"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    year = int(sys.argv[1]) if len(sys.argv) > 1 else YEAR
    win = window()
    i0, i1, j0, j1, chunks = win
    print(f"HRRR {year}: window i {i0}-{i1}, j {j0}-{j1} ({(i1 - i0 + 1) * (j1 - j0 + 1)} points), {len(chunks)} chunk(s) per field")
    (OUT / "window.json").write_text(__import__("json").dumps({"i0": i0, "i1": i1, "j0": j0, "j1": j1, "year": year}))
    for m in range(1, 13):
        print(month(year, m, win), flush=True)


if __name__ == "__main__":
    main()
