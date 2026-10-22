"""Surface height above ground (trees and structures) from USGS 3DEP lidar point clouds.

The 3DEP point clouds are public on AWS as Entwine Point Tiles (EPT): an octree whose shallow levels are an even
subsample of the whole survey. Reading every level is terabytes; reading down to DEPTH gives one return every
25-80 m² over the whole region, which is enough to catch every tree crown and roof that matters to a 50 m cell.

Each return's height above ground is its elevation minus the 3DEP bare-earth DEM (fetch.py), after removing the
survey's vertical-datum offset (measured from its own ground-classified returns). Per 50 m cell we keep the second
highest return (one stray return, a bird or a wire, does not set the height) and the share of high returns that came
from a multi-return pulse: canopy splits a pulse into several returns, roofs and towers return once.

The King and Pierce surveys classify ground, noise, water and bridge decks only, so trees and buildings are both
class 1; the multi-return share is what tells them apart.

    python lidar.py          # DEPTH below
    python lidar.py 7        # denser (about five times the download)

Writes data/raw/heights.npz. Downloaded tiles are cached in data/raw/lidar/<survey>/.
"""
import io, json, math, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

import laspy
import numpy as np
from shapely.geometry import box, shape

from fetch import RAW, UA
from metro import METRO

DEPTH = 6
CELL_M = 50
INDEX = "https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson"
OUT = RAW / "lidar"
R_MERC = 6378137.0
NOISE = {7, 18}  # low and high noise
GROUND = {2}
SKIP = NOISE | GROUND | {9}  # water returns are not surfaces


def get(url, tries=6):
    wait = 2
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            if k == tries - 1:
                raise
        except Exception:  # noqa: BLE001  DNS and resets under many parallel requests
            if k == tries - 1:
                raise
        time.sleep(wait)
        wait *= 2


def merc(lon, lat):
    return np.radians(lon) * R_MERC, np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R_MERC


def unmerc(x, y):
    return np.degrees(x / R_MERC), np.degrees(2 * np.arctan(np.exp(y / R_MERC)) - np.pi / 2)


def surveys():
    """3DEP EPT surveys whose boundary intersects the bbox."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "resources.geojson"
    if not path.exists():
        path.write_bytes(get(INDEX))
    bb = box(*METRO["bbox"])
    out = []
    for f in json.loads(path.read_text())["features"]:
        g = shape(f["geometry"])
        if g.intersects(bb) and "Bathymetric" not in f["properties"]["name"]:  # bathymetric surveys repeat the topo-bathy points
            out.append((f["properties"]["name"], f["properties"]["url"].rsplit("/", 1)[0], g.intersection(bb).area / bb.area))
    return out


def nodes(base, depth):
    """EPT keys down to `depth` whose cube intersects the bbox, from the survey's hierarchy."""
    ept = json.loads(get(f"{base}/ept.json"))
    b = ept["bounds"]
    w, s, e, n = METRO["bbox"]
    (x0, y0), (x1, y1) = merc(w, s), merc(e, n)

    def inside(key):
        d, x, y, _ = map(int, key.split("-"))
        sz = (b[3] - b[0]) / 2 ** d
        return b[0] + x * sz < x1 and b[0] + (x + 1) * sz > x0 and b[1] + y * sz < y1 and b[1] + (y + 1) * sz > y0

    keys, todo = [], ["0-0-0-0"]
    while todo:
        h = json.loads(get(f"{base}/ept-hierarchy/{todo.pop()}.json"))
        for k, v in h.items():
            d = int(k.split("-")[0])
            if d > depth or not inside(k) or v == 0:
                continue
            if v == -1 and d < depth:
                todo.append(k)  # the subtree lives in its own hierarchy file
            keys.append(k)
    return sorted(set(keys)), ept


class Dem:
    def __init__(self):
        self.z = np.load(RAW / "dem.npy")
        m = json.loads((RAW / "dem.json").read_text())
        self.w, self.n, self.dlon, self.dlat = m["west"], m["north"], m["dlon"], m["dlat"]

    def at(self, lon, lat):
        """Bilinear bare-earth elevation; NaN outside the grid or where 3DEP has no data."""
        fx, fy = (lon - self.w) / self.dlon - 0.5, (self.n - lat) / self.dlat - 0.5
        i, j = np.floor(fx).astype(int), np.floor(fy).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < self.z.shape[1] - 1) & (j < self.z.shape[0] - 1)
        i, j, tx, ty = np.where(ok, i, 0), np.where(ok, j, 0), fx - i, fy - j
        z = self.z
        v = (z[j, i] * (1 - tx) * (1 - ty) + z[j, i + 1] * tx * (1 - ty) + z[j + 1, i] * (1 - tx) * ty + z[j + 1, i + 1] * tx * ty)
        return np.where(ok, v, np.nan)


def read_node(name, base, key):
    path = OUT / name / f"{key}.laz"
    if not path.exists():
        raw = get(f"{base}/ept-data/{key}.laz")
        if raw is None:
            return None
        path.write_bytes(raw)
    las = laspy.read(io.BytesIO(path.read_bytes()))
    lon, lat = unmerc(np.asarray(las.x), np.asarray(las.y))
    return lon, lat, np.asarray(las.z, np.float32), np.asarray(las.classification), np.asarray(las.number_of_returns) > 1


SPIKE_M = 60      # cells taller than this get a second look
GAP_M = 40        # a vertical gap this large splits the returns into clusters
SPIKE_SHARE = 0.2  # a top cluster with fewer than this share of the cell's surface returns is airborne
TREE_MAX_M = 75   # taller than any tree here: above this a cluster must match a filed obstacle or mapped building
MATCH_M = 150     # how far that obstacle or building may be from the cell


def known_structures():
    """(lon, lat, height m) of FAA DOF obstacles and OSM buildings, towers and masts with a height."""
    import csv
    out = []
    with open(RAW / "dof" / "DOF.CSV", newline="", encoding="latin-1") as fh:
        for r in csv.DictReader(fh):
            if r["STATE"] == "WA":
                out.append((float(r["LONDEC"]), float(r["LATDEC"]), int(r["AGL"]) / 3.28084))
    for f in ("osm_buildings.json", "osm_tall.json"):
        for e in json.loads((RAW / f).read_text())["elements"]:
            t = e.get("tags", {})
            try:
                h = float(str(t.get("height", "")).split()[0]) if t.get("height") else float(t["building:levels"]) * 3.3 + 3
            except (KeyError, ValueError):
                continue
            pts = e.get("geometry") or ([e["center"]] if "center" in e else [])
            for p in pts:
                out.append((p["lon"], p["lat"], h))
    return np.array(out)


def despike(surface, surveys_seen, depth, dem, grid):
    """Drop aircraft, birds and other airborne returns from the tall cells, in place.

    The top-two height cannot tell an airliner on final from a tower roof. Here every return of each cell above
    SPIKE_M is collected again from the cached tiles; walking down from the top, a cluster of returns separated from
    everything below by more than GAP_M, and holding under SPIKE_SHARE of the cell's surface returns, is discarded.
    Roofs cover much of their cell; an aircraft or bird is a handful of returns. A large flat cluster above any tree
    (TREE_MAX_M) with no FAA-filed obstacle or mapped building under it is a cloud deck and goes too: every structure
    over 200 ft must be filed with the FAA. Thin masts can be dropped as well; the FAA obstacle file carries those.
    """
    w, s, dlon, dlat, nx, ny = grid
    tall = np.flatnonzero(np.nan_to_num(surface.ravel()) > SPIKE_M)
    if not len(tall):
        return
    want = np.zeros(nx * ny, bool); want[tall] = True
    lo_lon, lo_lat = w + (tall % nx) * dlon, s + (tall // nx) * dlat
    cells = {}
    for name, base, keys, b in surveys_seen:
        x0, y0 = merc(lo_lon, lo_lat)
        x1, y1 = merc(lo_lon + dlon, lo_lat + dlat)

        def hit(key):
            d, x, y, _ = map(int, key.split("-"))
            sz = (b[3] - b[0]) / 2 ** d
            return bool(np.any((b[0] + x * sz < x1) & (b[0] + (x + 1) * sz > x0) & (b[1] + y * sz < y1) & (b[1] + (y + 1) * sz > y0)))
        sel = [k for k in keys if hit(k)]
        with ThreadPoolExecutor(12) as ex:
            for got in ex.map(lambda key: read_node(name, base, key), sel):
                if got is None:
                    continue
                lon, lat, z, cls, _ = got
                # ground and water returns count here: they are what a floating cluster floats above
                ok = (lon >= w) & (lon < w + nx * dlon) & (lat >= s) & (lat < s + ny * dlat) & ~np.isin(cls, list(NOISE))
                c = ((lat[ok] - s) // dlat).astype(np.int64) * nx + ((lon[ok] - w) // dlon).astype(np.int64)
                m = want[c]
                if not m.any():
                    continue
                g = dem.at(lon[ok][m], lat[ok][m])
                for ci, hv in zip(c[m], z[ok][m] - g):
                    if np.isfinite(hv):
                        cells.setdefault(int(ci), []).append(float(hv))
    known = known_structures()
    m_lon = 111_320.0 * math.cos(math.radians(s + ny * dlat / 2))

    def corroborated(ci, h):
        lon, lat = w + (ci % nx + 0.5) * dlon, s + (ci // nx + 0.5) * dlat
        near = (np.abs(known[:, 0] - lon) * m_lon < MATCH_M) & (np.abs(known[:, 1] - lat) * 110_574 < MATCH_M)
        return bool(np.any(known[near, 2] >= h - GAP_M))

    fixed = 0
    for ci, hs in cells.items():
        hs = sorted(hs, reverse=True)
        while len(hs) > 1:
            gaps = [k for k in range(len(hs) - 1) if hs[k] - hs[k + 1] > GAP_M]
            if not gaps:
                break
            small = gaps[0] + 1 < SPIKE_SHARE * len(hs)  # a few returns: aircraft or birds
            floating = hs[0] > TREE_MAX_M and not corroborated(ci, hs[0])  # a sheet with nothing filed under it: cloud
            if not (small or floating):
                break
            hs = hs[gaps[0] + 1:]
        h = hs[1] if len(hs) > 1 else hs[0]
        if h < surface.flat[ci] - 1:
            surface.flat[ci] = max(h, 0)
            fixed += 1
    print(f"  despike: {len(tall):,} cells above {SPIKE_M} m, {fixed:,} lowered (aircraft, birds and cloud removed)", flush=True)


def main():
    depth = int(sys.argv[1]) if len(sys.argv) > 1 else DEPTH
    w, s, e, n = METRO["bbox"]
    lat0 = (s + n) / 2
    dlon, dlat = CELL_M / (111_320.0 * math.cos(math.radians(lat0))), CELL_M / 110_574.0
    nx, ny = int((e - w) / dlon), int((n - s) / dlat)
    dem = Dem()
    top1, top2 = np.full(nx * ny, -np.inf, np.float32), np.full(nx * ny, -np.inf, np.float32)
    count, high, multi = np.zeros(nx * ny, np.uint32), np.zeros(nx * ny, np.uint32), np.zeros(nx * ny, np.uint32)
    report, surveys_seen = [], []
    for name, base, share in surveys():
        (OUT / name).mkdir(parents=True, exist_ok=True)
        keys, ept = nodes(base, depth)
        surveys_seen.append((name, base, keys, ept["bounds"]))
        print(f"{name}: {share:.0%} of the box, {len(keys)} EPT nodes to depth {depth}", flush=True)
        def clip(got):
            lon, lat, z, cls, mr = got
            ok = (lon >= w) & (lon < w + nx * dlon) & (lat >= s) & (lat < s + ny * dlat)
            lon, lat, z, cls, mr = lon[ok], lat[ok], z[ok], cls[ok], mr[ok]
            g = dem.at(lon, lat)
            fin = np.isfinite(g)
            return lon[fin], lat[fin], z[fin] - g[fin], cls[fin], mr[fin]

        # Pass 1: the survey's vertical datum against the DEM, from ground returns in an even sample of nodes.
        resid = []
        with ThreadPoolExecutor(12) as ex:
            for got in ex.map(lambda key: read_node(name, base, key), keys[:: max(1, len(keys) // 120)]):
                if got is not None:
                    _, _, hag, cls, _ = clip(got)
                    resid.append(hag[np.isin(cls, list(GROUND))])
        off = float(np.median(np.concatenate(resid))) if resid else 0.0
        print(f"  vertical datum offset {off:+.2f} m (ground returns minus 3DEP DEM)", flush=True)
        # Pass 2: every node, streamed into the per-cell top-two and multi-return counts.
        t0, pts = time.time(), 0
        with ThreadPoolExecutor(12) as ex:
            for k, got in enumerate(ex.map(lambda key: read_node(name, base, key), keys)):
                if got is None:
                    continue
                lon, lat, hag, cls, mr = clip(got)
                pts += len(hag)
                allc = ((lat - s) // dlat).astype(np.int64) * nx + ((lon - w) // dlon).astype(np.int64)
                np.add.at(count, allc, 1)
                keep = ~np.isin(cls, list(SKIP))
                if not keep.any():
                    continue
                c, h, mr = allc[keep], hag[keep] - off, mr[keep]
                o = np.lexsort((h, c))
                c, h, mr = c[o], h[o], mr[o]
                pos = np.flatnonzero(np.r_[c[1:] != c[:-1], True])
                prev = np.maximum(pos - 1, 0)
                t1 = h[pos]
                t2 = np.where((pos > 0) & (c[prev] == c[pos]), h[prev], -np.inf)
                u = c[pos]
                a1, a2 = top1[u], top2[u]
                top1[u], top2[u] = np.maximum(a1, t1), np.maximum(np.minimum(a1, t1), np.maximum(a2, t2))
                hi = h > 5
                np.add.at(high, c[hi], 1)
                np.add.at(multi, c[hi & mr], 1)
                if k % 250 == 0:
                    print(f"  {k}/{len(keys)} nodes, {pts / 1e6:.1f} M returns, {time.time() - t0:.0f}s", flush=True)
        print(f"  {pts / 1e6:.1f} M returns in the box", flush=True)
        report.append({"survey": name, "returns": pts, "nodes": len(keys), "datum_offset_m": round(off, 2), "box_share": round(share, 3)})
    surface = np.where(np.isfinite(top2), top2, np.where(np.isfinite(top1), top1, np.nan))
    surface = np.where(count > 0, np.maximum(np.nan_to_num(surface, nan=0.0), 0), np.nan).astype(np.float32)
    despike(surface, surveys_seen, depth, dem, (w, s, dlon, dlat, nx, ny))
    np.savez_compressed(RAW / "heights.npz", surface=surface.reshape(ny, nx), count=count.reshape(ny, nx),
                        high=high.reshape(ny, nx), multi=multi.reshape(ny, nx))
    (RAW / "heights.json").write_text(json.dumps({"west": w, "south": s, "dlon": dlon, "dlat": dlat, "nx": nx, "ny": ny,
                                                  "cell_m": CELL_M, "depth": depth, "surveys": report}))
    cov = np.isfinite(surface)
    print(f"heights: {cov.sum():,} of {nx * ny:,} cells covered; tallest {np.nanmax(surface):.0f} m")


if __name__ == "__main__":
    main()
