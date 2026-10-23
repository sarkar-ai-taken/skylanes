// Corridor scoring engine. Pure functions over the layers in app/data/; no DOM, so it runs in node tests.
// Coordinates are [lon, lat]. Distances are metres in a local equirectangular projection around the metro centre.

export const FT = 3.28084;

// ---------- Aircraft library (generic classes; operators override with their own airframe numbers) ----------
export const AIRCRAFT = {
  quad: { name: 'Multirotor delivery drone, 2.5 lb payload', mtow: 7.5, spd: 18, src: 72, glide: 0, descent: 5,
    lostlink: 'hover 30 s, then return to launch', chute: false, lethalAreaM2: 2.0 },
  fixed: { name: 'Fixed-wing VTOL delivery drone, 4 lb payload', mtow: 22, spd: 28, src: 68, glide: 9, descent: 3,
    lostlink: 'continue to next waypoint, then loiter and land at the nearest contingency site', chute: true, lethalAreaM2: 3.5 },
  heavy: { name: 'Heavy-lift multirotor, 55 lb', mtow: 55, spd: 14, src: 84, glide: 0, descent: 7,
    lostlink: 'immediate controlled descent', chute: true, lethalAreaM2: 6.0 },
};

export const WIND_PRESETS = { calm: { kt: 5, dir: 180, g: 0.1 }, typical: { kt: 12, dir: 200, g: 0.25 }, gusty: { kt: 22, dir: 200, g: 0.5 } };

// Ground population model. Night = census residents. Workday = residents who stay home plus LEHD jobs at the workplace.
export const TOD = {
  night: { label: 'overnight (residents only)', res: 1, jobs: 0 },
  day: { label: 'weekday daytime (0.55 × residents + jobs)', res: 0.55, jobs: 1 },
  event: { label: 'event day at a stadium (daytime + crowd)', res: 0.55, jobs: 1, crowd: true },
};
// The clock hour each preset stands for where an hourly layer (road counts) needs one.
export const TOD_HOUR = { night: 3, day: 13, event: 17 };
export const DAY_TYPES = ['weekday', 'weekend'];

// Fallback density thresholds (people/km²) used only outside the FAA Operating Categories Map coverage.
export const CAT_THRESHOLDS = [50, 500, 2500, 10000];
export const catFromDensity = d => (d < 50 ? 1 : d < 500 ? 2 : d < 2500 ? 3 : d < 10000 ? 4 : 5);

const CROWD = 60000, CROWD_R = 300, STADIUM_TFR_M = 5556; // 3 NM

// ---------- Deterministic RNG so the same route always produces the same package ----------
export function rng(seed = 99) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ---------- Data preparation ----------
function decode(b64, Type) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Type === Uint8Array ? bytes : new Type(bytes.buffer);
}

// Only manifest is required; a page that needs just lanes and traffic can leave the other layers out.
export function prepare({ grid = { tiles: [] }, obstacles = [], powerlines = { features: [] }, sites = [], airspace = {}, manifest, buildings = [], traffic = null, wind = null,
  diurnal = null, noise311 = null, roadcounts = null, cellular = null }) {
  const [W, S, E, N] = manifest.bbox;
  const lat0 = (S + N) / 2, lon0 = (W + E) / 2;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180), mLat = 110574;
  const proj = ([lon, lat]) => [(lon - lon0) * mLon, (lat - lat0) * mLat];
  const unproj = ([x, y]) => [x / mLon + lon0, y / mLat + lat0];
  const g = { ...grid, loaded: new Map(), listed: new Set(grid.tiles) }; // tiles arrive through addTile / ensureTiles
  const projPoly = geom => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).map(p => p.map(r => r.map(proj)));
  const polys = fs => fs.map(f => ({ props: f.properties, rings: projPoly(f.geometry), bbox: bboxOf(projPoly(f.geometry)) }));
  return {
    manifest, proj, unproj, grid: g,
    obstacles: obstacles.map(o => ({ ...o, xy: proj([o.lon, o.lat]) })),
    buildings: buildings.map(b => { const ring = b.ring.map(proj); return { ...b, xy: ring, bbox: bboxOf([[ring]]) }; }),
    powerlines: powerlines.features.map(f => ({ props: f.properties, xy: f.geometry.coordinates.map(proj) })),
    sites: sites.map(s => ({ ...s, xy: proj([s.lon, s.lat]) })),
    facility: polys(airspace.facility_map || []),
    surface: polys(airspace.surface_areas || []),
    opcats: polys(airspace.operating_categories || []),
    classB: polys(airspace.class_b || []),
    traffic: traffic && { ...traffic, density: traffic.density.map(b => decode(b, Float32Array)), rotor: traffic.rotor.map(b => decode(b, Float32Array)) },
    wind: wind && { ...wind, xy: wind.points.map(proj) },
    diurnal,
    noise: noise311 && { ...noise311, byKey: new Map(Array.from({ length: noise311.cells.length / 6 }, (_, n) => [noise311.cells[n * 6] + noise311.cells[n * 6 + 1] * noise311.nx, noise311.cells[n * 6 + 2]])) },
    roads: roadcounts && { ...roadcounts, lines: roadcounts.segs.map(s => ({ ...s, xy: s.coords.map(proj) })) },
    cell: cellular && { ...cellular, byKey: new Map(cellular.dx.map((dx, n) => [dx * cellular.ny + cellular.dy[n], n])) },
  };
}

/** Bucket items by 200 m cells so point queries only look at nearby buildings and obstacles. */
const HASH_M = 200;
function hashOf(items, boxOf) {
  const h = new Map();
  for (const it of items) {
    const [a, b, c, d] = boxOf(it);
    for (let i = Math.floor(a / HASH_M); i <= Math.floor(c / HASH_M); i++) for (let j = Math.floor(b / HASH_M); j <= Math.floor(d / HASH_M); j++) {
      const k = i + ',' + j; if (!h.has(k)) h.set(k, []); h.get(k).push(it);
    }
  }
  return h;
}
function nearby(h, xy, r) {
  const out = new Set();
  for (let i = Math.floor((xy[0] - r) / HASH_M); i <= Math.floor((xy[0] + r) / HASH_M); i++) for (let j = Math.floor((xy[1] - r) / HASH_M); j <= Math.floor((xy[1] + r) / HASH_M); j++)
    for (const it of h.get(i + ',' + j) || []) out.add(it);
  return out;
}
function index(D) {
  if (!D._bh) {
    D._bh = hashOf(D.buildings, b => b.bbox);
    D._oh = hashOf(D.obstacles, o => [o.xy[0], o.xy[1], o.xy[0], o.xy[1]]);
  }
  return D;
}
/** Metres from xy to a building footprint; 0 inside. */
export function distToBuilding(xy, b) {
  const r = b.xy;
  if (inRing(xy[0], xy[1], r)) return 0;
  let m = Infinity;
  for (let i = 0; i < r.length - 1; i++) m = Math.min(m, segDist(xy, r[i], r[i + 1]));
  return m;
}

function bboxOf(polys) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of polys) for (const [x, y] of p[0]) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}
function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function inPolys(x, y, P) {
  const [a, b, c, d] = P.bbox;
  if (x < a || x > c || y < b || y > d) return false;
  return P.rings.some(p => inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h)));
}
const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// ---------- Point queries ----------
// ---------- The tiled population grid ----------
// Cell state: 0 land with census data, 1 water, 2 no data, 3 tile not loaded yet. Tiles absent from the index are open water.
const WATER = { state: 1 }, NODATA = { state: 2 }, UNLOADED = { state: 3 };

/** Decode one tile file and make it available to every query. */
export function addTile(D, t) {
  D.grid.loaded.set(`${t.ti}_${t.tj}`, { ...t, residents: decode(t.residents, Uint32Array), jobs: decode(t.jobs, Uint32Array),
    state: decode(t.state, Uint8Array), faacat: decode(t.faacat, Uint8Array), ceiling: decode(t.ceiling, Uint16Array),
    landuse: t.landuse ? decode(t.landuse, Uint8Array) : null,
    surf: t.surf ? decode(t.surf, Uint8Array) : null, surfkind: t.surfkind ? decode(t.surfkind, Uint8Array) : null });
}
/** Tile keys covering a [west, south, east, north] box that are listed but not loaded. */
export function missingTiles(D, [w, s, e, n]) {
  const g = D.grid, T = g.tile, out = [];
  const i0 = Math.max(0, Math.floor((w - g.west) / g.dlon / T)), i1 = Math.min(Math.ceil(g.nx / T) - 1, Math.floor((e - g.west) / g.dlon / T));
  const j0 = Math.max(0, Math.floor((s - g.south) / g.dlat / T)), j1 = Math.min(Math.ceil(g.ny / T) - 1, Math.floor((n - g.south) / g.dlat / T));
  for (let tj = j0; tj <= j1; tj++) for (let ti = i0; ti <= i1; ti++) { const k = `${ti}_${tj}`; if (g.listed.has(k) && !g.loaded.has(k)) out.push(k); }
  return out;
}
/** Load every tile a box needs. loader(key) resolves to the tile's JSON. */
export async function ensureTiles(D, box, loader) {
  const keys = missingTiles(D, box);
  (await Promise.all(keys.map(loader))).forEach(t => addTile(D, t));
  return keys.length;
}
/** Box around a route, padded by padM metres (failure footprints land beyond the line). */
export function routeBox(D, route, padM = 1500) {
  const xy = route.map(p => D.proj(p)), xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const [w, s] = D.unproj([Math.min(...xs) - padM, Math.min(...ys) - padM]), [e, n] = D.unproj([Math.max(...xs) + padM, Math.max(...ys) + padM]);
  return [w, s, e, n];
}

function cellAt(D, i, j) {
  const g = D.grid;
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return NODATA;
  const ti = Math.floor(i / g.tile), tj = Math.floor(j / g.tile), key = ti + '_' + tj, t = g.loaded.get(key);
  if (!t) return g.listed.has(key) ? UNLOADED : WATER;
  const k = (j - tj * g.tile) * t.w + (i - ti * g.tile);
  return { t, k, state: t.state[k] };
}
function cellOf(D, xy) {
  const [lon, lat] = D.unproj(xy), g = D.grid;
  return cellAt(D, Math.floor((lon - g.west) / g.dlon), Math.floor((lat - g.south) / g.dlat));
}
/** 'ok' where the grid has census data, 'water', 'nodata' outside it, 'unloaded' when its tile is not loaded. */
export const coverage = (D, xy) => ['ok', 'water', 'nodata', 'unloaded'][cellOf(D, xy).state];

/** People per km² on the ground at xy: 3×3-cell (300 m) mean of the 100 m grid, so one tall block does not set the category. */
export const density = (D, xy, tod = 'day') => weighted(D, xy, TOD[tod]);
/** The two parts every density weights: 3×3-cell means of residents and of jobs per km² at xy. */
export function cellMeans(D, xy) {
  const g = D.grid, [lon, lat] = D.unproj(xy);
  const i0 = Math.floor((lon - g.west) / g.dlon), j0 = Math.floor((lat - g.south) / g.dlat);
  let res = 0, jobs = 0, n = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const c = cellAt(D, i0 + di, j0 + dj);
    if (c.state === 0) { res += c.t.residents[c.k]; jobs += c.t.jobs[c.k]; n++; }
    else if (c.state === 1) n++; // water counts as empty; missing data does not count at all
  }
  return n ? [res / n, jobs / n] : [0, 0];
}
/** Stadium crowd per km² at xy (stadiums with a TFR, cone to CROWD_R). */
function crowdAt(D, xy) {
  let v = 0;
  for (const s of D.sites) if (s.kind === 'stadium' && s.tfr) { const d = hyp(xy, s.xy); if (d < CROWD_R) v += CROWD / (Math.PI * (CROWD_R / 1000) ** 2) * (1 - d / CROWD_R); }
  return v;
}
const weighted = (D, xy, w, mn = cellMeans(D, xy)) => w.res * mn[0] + w.jobs * mn[1] + (w.crowd ? crowdAt(D, xy) : 0);

// ---------- Hourly ground population (ATUS diurnal curves, pipeline/diurnal.py) ----------
const mod24 = h => ((h % 24) + 24) % 24;
export const hhmm = h => { const m = Math.round(mod24(h) * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/**
 * Weights on residents and jobs at clock hour h (fractions interpolate): the ATUS share of people at home, the share of
 * jobs whose holder is at work, and the share out or travelling spread over job cells × k (residents / jobs) as a proxy
 * for shops, schools and the roads between them. Without the layer: the night preset 22–06, else the day preset.
 */
export function hourWeights(D, hour, dayType = 'weekday') {
  const P = D.diurnal?.[dayType], h = mod24(hour);
  if (!P) { const m = TOD[h >= 6 && h < 22 ? 'day' : 'night']; return { res: m.res, jobs: m.jobs, preset: true }; }
  const k = D.diurnal.spread.k, h0 = Math.floor(h), f = h - h0, at = i => [P.resHome[i], P.jobsAtWork[i] + (P.out[i] + P.travel[i]) * k];
  const [r0, j0] = at(h0), [r1, j1] = at((h0 + 1) % 24);
  return { res: r0 + (r1 - r0) * f, jobs: j0 + (j1 - j0) * f };
}
/** People per km² at xy at a clock hour on a weekday or weekend day (same 300 m smoothing as density). */
export const densityAt = (D, xy, hour, dayType = 'weekday', crowd = false) => weighted(D, xy, { ...hourWeights(D, hour, dayType), crowd });

/** Circular runs of hours where pred holds: [{ from, hours }]. */
function hourRuns(pred) {
  const on = Array.from({ length: 24 }, (_, h) => pred(h));
  if (on.every(Boolean)) return [{ from: 0, hours: 24 }];
  const s = on.indexOf(false), out = [];
  for (let i = 1; i <= 24; i++) { const h = (s + i) % 24; if (!on[h]) continue; const last = out[out.length - 1]; if (last && (last.from + last.hours) % 24 === h) last.hours++; else out.push({ from: h, hours: 1 }); }
  return out;
}
/**
 * Best and worst operating windows in 24 hourly rows ({ h, peak, mean, cat }): best is the longest run at the lowest
 * category (ties to the lower mean density), worst the run at the highest category holding its busiest hour.
 */
export function operatingWindows(H) {
  const lo = Math.min(...H.map(x => x.cat)), hi = Math.max(...H.map(x => x.cat)), sum = w => Array.from({ length: w.hours }, (_, i) => H[(w.from + i) % 24].mean).reduce((a, b) => a + b, 0) / w.hours;
  const best = hourRuns(h => H[h].cat === lo).sort((a, b) => b.hours - a.hours || sum(a) - sum(b))[0];
  const busiest = H.reduce((a, x) => (x.mean > a.mean ? x : a)), quietest = H.reduce((a, x) => (x.mean < a.mean ? x : a));
  const top = H.filter(x => x.cat === hi).reduce((a, x) => (x.mean > a.mean ? x : a));
  const worst = hourRuns(h => H[h].cat === hi).find(w => (top.h - w.from + 24) % 24 < w.hours);
  const win = (w, cat) => ({ from: w.from, to: (w.from + w.hours) % 24, hours: w.hours, cat, mean: sum(w) });
  return { lo, hi, best: win(best, lo), worst: win(worst, hi), quietest: quietest.h, busiest: busiest.h };
}
export const windowText = w => (w.hours === 24 ? 'all day' : `${hhmm(w.from)}–${w.to === 0 ? '24:00' : hhmm(w.to)}`);
/**
 * Ground density by clock hour along a route from the 300 m means of its samples (cellMeans): per hour and day type the
 * peak and mean density and the census category of the peak (catFromDensity; the FAA map, where it applies, is static),
 * plus the operating windows. Stadium crowds are not in it. Null without the diurnal layer.
 */
export function hourlyProfile(D, means) {
  if (!D.diurnal || !means.length) return null;
  const out = {};
  for (const dt of DAY_TYPES) out[dt] = Array.from({ length: 24 }, (_, h) => {
    const w = hourWeights(D, h, dt); let peak = 0, sum = 0;
    for (const [r, j] of means) { const v = w.res * r + w.jobs * j; sum += v; if (v > peak) peak = v; }
    return { h, peak, mean: sum / means.length, cat: catFromDensity(peak) };
  });
  out.windows = Object.fromEntries(DAY_TYPES.map(dt => [dt, operatingWindows(out[dt])]));
  return out;
}
/** Walk a [lon, lat] route every stepM metres: fn(xy, along, leg, dir unit vector) per point. Returns the length. */
function walk(D, route, stepM, fn) {
  const pts = route.map(p => D.proj(p)); let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = hyp(a, b), n = Math.max(1, Math.ceil(L / stepM)), u = L ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0];
    for (let s = 0; s < n; s++) fn([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n], len + L * s / n, i, u);
    len += L;
  }
  if (pts.length > 1) fn(pts[pts.length - 1], len, pts.length - 2, [1, 0]);
  return len;
}
/** hourlyProfile for a [lon, lat] route on its own. */
export function routeProfile(D, route, stepM = 25) { const m = []; walk(D, route, stepM, xy => m.push(cellMeans(D, xy))); return hourlyProfile(D, m); }
export const isWater = (D, xy) => cellOf(D, xy).state === 1;

/** FAA Operating Categories Map category at xy (rasterized to the grid; highest polygon wins), or null outside its coverage. */
export function faaCategory(D, xy) { const c = cellOf(D, xy); return c.t && c.t.faacat[c.k] ? c.t.faacat[c.k] : null; }
/** UAS facility map ceiling (ft AGL) at xy, or null outside controlled airspace grids. */
export function facilityCeiling(D, xy) { const c = cellOf(D, xy); return c.t && c.t.ceiling[c.k] !== 65535 ? c.t.ceiling[c.k] : null; }
/** OSM land-use class name at xy ('unmapped' where OSM has none), or null when the tile carries no land use. */
export function landUse(D, xy) { const c = cellOf(D, xy); return c.t?.landuse ? D.grid.landuse[c.t.landuse[c.k]] : null; }
// Where a failing drone can come down with nobody under it: parks, fields, cemeteries.
export const OPEN_LAND = new Set(['park', 'open land', 'cemetery']);

// ---------- Lidar surface heights (USGS 3DEP) ----------
// Each tile can carry a 50 m raster at half the grid cell: tallest return above ground in 4 ft steps (255 = no lidar),
// and a kind flag (0 low, 1 structure, 2 tree canopy, 3 a mapped building or filed obstacle already accounts for it).
export const SURF_KIND = ['ground', 'structure', 'tree canopy', 'mapped structure'];
/**
 * Tallest lidar surface (ft) in the 50 m cells touching a circle of r metres around xy: { ft, kind }, or null where
 * no survey covers it. Cells are 50 m, so this is conservative by up to one cell. With unmapped, cells that a mapped
 * footprint or obstacle accounts for count as ground: the exact footprint is tested instead.
 */
export function surfaceNear(D, xy, r = 0, unmapped = false) {
  const g = D.grid, [lon0, lat0] = D.unproj([xy[0] - r, xy[1] - r]), [lon1, lat1] = D.unproj([xy[0] + r, xy[1] + r]);
  const hl = g.dlon / 2, ht = g.dlat / 2;
  let best = null;
  for (let J = Math.floor((lat0 - g.south) / ht); J <= Math.floor((lat1 - g.south) / ht); J++)
    for (let I = Math.floor((lon0 - g.west) / hl); I <= Math.floor((lon1 - g.west) / hl); I++) {
      const c = cellAt(D, I >> 1, J >> 1);
      if (!c.t?.surf) continue;
      const k = (J - c.t.tj * g.tile * 2) * c.t.w * 2 + (I - c.t.ti * g.tile * 2), v = c.t.surf[k];
      if (v === 255) continue;
      const kind = c.t.surfkind[k], ft = unmapped && kind === 3 ? 0 : v * 4;
      if (!best || ft > best.ft) best = { ft, kind: SURF_KIND[unmapped && kind === 3 ? 0 : kind] };
    }
  return best;
}

// ---------- Crewed traffic (historical ADS-B) ----------
/** Altitude band index (BANDS_FT) holding altFt, or -1 above the top band. */
const bandOf = (T, altFt) => T.bands_ft.findIndex((b, i) => i < T.bands_ft.length - 1 && altFt >= b && altFt < T.bands_ft[i + 1]);
/** Mean crewed aircraft present per km² at xy in the band holding altFt: { rho, rotor }, or null without the layer. */
export function trafficAt(D, xy, altFt) {
  const T = D.traffic; if (!T) return null;
  const b = bandOf(T, altFt); if (b < 0) return null;
  const [lon, lat] = D.unproj(xy), i = Math.floor((lon - T.west) / T.dlon), j = Math.floor((lat - T.south) / T.dlat);
  if (i < 0 || j < 0 || i >= T.nx || j >= T.ny) return null;
  return { rho: T.density[b][j * T.nx + i], rotor: T.rotor[b][j * T.nx + i], band: b };
}
/** Crewed aircraft per flight hour as text: 'none recorded', 3.2e-3 or 0.44. */
export const rateText = x => (x === 0 ? 'none recorded' : x < 0.01 ? x.toExponential(1) : x.toFixed(2));
/** 'low' at or below the region's median cell, 'moderate' to the 90th percentile, 'high' to the 99th, then 'very high'. */
export function trafficLevel(D, rho, band) {
  const [p50, p90, p99] = D.traffic.pct[band];
  return rho <= p50 ? 'low' : rho <= p90 ? 'moderate' : rho <= p99 ? 'high' : 'very high';
}

// ---------- Wind climatology (NOAA HRRR) ----------
/** Index of the HRRR climatology point nearest xy, or -1 without the layer. */
function windPoint(D, xy) {
  const C = D.wind; if (!C) return -1;
  let best = -1, d = Infinity;
  C.xy.forEach((p, i) => { const e = hyp(p, xy); if (e < d) { d = e; best = i; } });
  return best;
}
/** Speed at altFt from the 10 m and 80 m values by the power law the two levels imply. */
const toAlt = (v10, v80, altFt) => { const a = Math.log(Math.max(v80, 0.1) / Math.max(v10, 0.1)) / Math.log(8); return v80 * Math.max(0.3, altFt / FT / 80) ** a; };
/**
 * Climatological daytime wind at xy and altFt: pct 50 (a typical day) or 90 (a windy day). Direction is the most
 * common sector of strong (> 15 kt) winds. Returns a scoreRoute wind object with its source attached.
 */
export function climateWind(D, xy, altFt, pct = 50) {
  const C = D.wind, k = windPoint(D, xy); if (k < 0) return null;
  const v10 = C[`p${pct}_10`][k], v80 = C[`p${pct}_80`][k];
  const rose = (pct >= 90 ? C.rose_over15 : C.rose).map(r => r[k]), sector = rose.indexOf(Math.max(...rose));
  return { kt: Math.round(toAlt(v10, v80, altFt)), dir: sector * 45, g: Math.min(0.6, Math.max(0.1, C.gust_factor[k] - 1)), src: `HRRR ${C.year} p${pct}` };
}
/**
 * Operating-weather summary at xy: share of daytime hours the 80 m (262 ft) wind exceeds each sustained limit, worst
 * month, gust p99, and the median and 90th percentile carried to altFt by the power law.
 */
export function windClimate(D, xy, altFt) {
  const C = D.wind, k = windPoint(D, xy); if (k < 0) return null;
  const at = p => Math.round(toAlt(C[`p${p}_10`][k], C[`p${p}_80`][k], altFt));
  const over = Object.fromEntries(Object.entries(C.over_80).map(([v, a]) => [v, a[k]]));
  const months = C.month_over20_80.map(m => m[k]), worst = months.indexOf(Math.max(...months));
  return { over, p50: at(50), p90: at(90), altFt: Math.round(altFt), gustP99: Math.round(C.gust_p99[k]),
    worstMonth: worst + 1, worstOver20: months[worst], year: C.year, hours: C.hours, dayHours: C.day_hours };
}

// ---------- Road users under the route (SDOT + WSDOT AADT, FHWA TMAS weekday hourly shape; pipeline/roadcounts.py) ----------
// Assumptions: 1.5 persons per vehicle (between the NHTS 2017 commute and all-trip averages); free-flow speeds
// 25 mph on Seattle arterials, 60 mph on interstates and US routes, 45 mph on other state routes.
export const OCCUPANCY = 1.5;
const ROAD_CELL = 250, isFreeway = ln => ln.src === 'wsdot' && /^(I-|US )/.test(ln.name);
const roadSpeed = ln => (ln.src === 'sdot' ? 11.2 : isFreeway(ln) ? 26.8 : 20.1);
const lerp24 = (a, h) => { const x = mod24(h), i = Math.floor(x), f = x - i; return a[i] + (a[(i + 1) % 24] - a[i]) * f; };
function roadIndex(R) {
  if (R.h) return R;
  R.pairs = []; R.h = new Map();
  R.lines.forEach((ln, k) => { for (let i = 0; i < ln.xy.length - 1; i++) {
    const a = ln.xy[i], b = ln.xy[i + 1], s = R.pairs.push([k, a, b]) - 1;
    for (let x = Math.floor(Math.min(a[0], b[0]) / ROAD_CELL); x <= Math.floor(Math.max(a[0], b[0]) / ROAD_CELL); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / ROAD_CELL); y <= Math.floor(Math.max(a[1], b[1]) / ROAD_CELL); y++) { const key = x + ',' + y; if (!R.h.has(key)) R.h.set(key, []); R.h.get(key).push(s); }
  } });
  return R;
}
function roadPairsNear(R, a, b, r) {
  const out = new Set();
  for (let x = Math.floor((Math.min(a[0], b[0]) - r) / ROAD_CELL); x <= Math.floor((Math.max(a[0], b[0]) + r) / ROAD_CELL); x++)
    for (let y = Math.floor((Math.min(a[1], b[1]) - r) / ROAD_CELL); y <= Math.floor((Math.max(a[1], b[1]) + r) / ROAD_CELL); y++) for (const s of R.h.get(x + ',' + y) || []) out.add(s);
  return out;
}
/** Where segments pq and ab cross: t along pq (0–1), or null. */
function crossT(p, q, a, b) {
  const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]], den = r[0] * s[1] - r[1] * s[0];
  if (!den) return null;
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den, u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
/**
 * Counted roads the route crosses or follows, and the road users under it. vph = daily volume × the TMAS weekday share of
 * that hour (freeway curve for interstates and US routes, all-station curve otherwise; AWDT on weekdays where SDOT has
 * it); with hour null, daily / 24. A road followed within bufferM at less than 45° for 50 m or more is a parallel
 * stretch, one per count section (same name and count). Vehicles under the footprint = vph / speed × road length inside
 * it, summed: a parallel stretch over its own length, a crossing over 2 × bufferM unless it lies in a followed stretch
 * of the same road (then that stretch counts, over at least 2 × bufferM).
 * Returns { crossings: [{ name, src, aadt, vph, at, along, leg, year }], parallel: [{ name, src, aadt, vph, lengthM, fromM, toM }],
 * followed (distinct roads followed), vehUnder, peopleUnder, hour, dayType, bufferM }, or null without the layer.
 * Only SDOT arterials and state highways are counted.
 */
export function roadCrossings(D, route, { hour = null, dayType = 'weekday', bufferM = 50, stepM = 25 } = {}) {
  const R = D.roads; if (!R || route.length < 2) return null;
  roadIndex(R);
  const pts = route.map(p => D.proj(p));
  const vph = ln => { const day = dayType === 'weekday' && ln.awdt ? ln.awdt : ln.aadt; return hour == null ? day / 24 : day * lerp24(R.hourly[isFreeway(ln) ? 'freeway' : 'all'], hour); };
  const road = ln => ({ name: ln.name, src: ln.src, aadt: ln.aadt, vph: vph(ln), year: ln.counted ?? ln.year, speedMs: roadSpeed(ln), ...(ln.awdt_only ? { awdtOnly: true } : {}) });
  const crossings = [];
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1], L = hyp(p, q);
    for (const s of roadPairsNear(R, p, q, 0)) {
      const [k, a, b] = R.pairs[s], t = crossT(p, q, a, b); if (t == null) continue;
      const xy = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], ln = R.lines[k];
      // one crossing per road: pieces of the same named road meeting at the crossing count once
      if (crossings.some(c => c.name === ln.name && c.src === ln.src && hyp(c.xy, xy) < 30)) continue;
      crossings.push({ ...road(ln), xy, at: D.unproj(xy).map(v => +v.toFixed(5)), along: len + L * t, leg: i });
    }
    len += L;
  }
  const par = new Map();
  walk(D, route, stepM, (xy, along, leg, u) => {
    const best = new Map(); // per road, the nearest section here: adjacent count sections overlap at their joints
    for (const s of roadPairsNear(R, xy, xy, bufferM)) {
      const [k, a, b] = R.pairs[s], L = hyp(a, b), d = segDist(xy, a, b);
      if (!L || d > bufferM || Math.abs(((b[0] - a[0]) * u[0] + (b[1] - a[1]) * u[1]) / L) < Math.SQRT1_2) continue;
      const ln = R.lines[k], nm = ln.src + ':' + ln.name, o = best.get(nm);
      if (!o || d < o.d) best.set(nm, { ln, d });
    }
    for (const { ln } of best.values()) {
      const key = `${ln.src}:${ln.name}:${ln.aadt}:${ln.awdt || 0}`, e = par.get(key) || par.set(key, { ln, at: new Set() }).get(key);
      e.at.add(Math.round(along / stepM));
    }
  });
  const nameLen = new Map();
  for (const { ln, at } of par.values()) nameLen.set(ln.src + ':' + ln.name, (nameLen.get(ln.src + ':' + ln.name) || 0) + at.size * stepM);
  const parallel = [...par.values()].filter(({ ln }) => nameLen.get(ln.src + ':' + ln.name) >= 50)
    .map(({ ln, at }) => ({ ...road(ln), lengthM: at.size * stepM, fromM: Math.min(...at) * stepM, toM: Math.max(...at) * stepM, at }))
    .sort((a, b) => b.vph * b.lengthM - a.vph * a.lengthM);
  const perM = r => r.vph / (r.speedMs * 3600), inStretch = (p, c) => p.src === c.src && p.name === c.name && [...p.at].some(i => Math.abs(i * stepM - c.along) <= bufferM);
  let vehUnder = 0;
  const shallow = new Set();
  for (const p of parallel) { const xs = crossings.filter(c => inStretch(p, c)); xs.forEach(c => shallow.add(c)); vehUnder += perM(p) * Math.max(p.lengthM, xs.length ? 2 * bufferM : 0); }
  for (const c of crossings) if (!shallow.has(c)) vehUnder += perM(c) * 2 * bufferM;
  crossings.sort((a, b) => a.along - b.along).forEach(c => delete c.xy);
  parallel.forEach(p => delete p.at);
  return { crossings, parallel, followed: new Set(parallel.map(p => p.src + ':' + p.name)).size, vehUnder, peopleUnder: vehUnder * OCCUPANCY, hour, dayType, bufferM,
    peakHour: R.hourly.all.indexOf(Math.max(...R.hourly.all)) };
}

// ---------- Noise complaints (Seattle open data, 250 m cells; pipeline/noise311.py) ----------
function inSeattle(N, lon, lat) {
  const [w, s, e, n] = N.city_bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n && N.city.some(p => inRing(lon, lat, p[0]) && !p.slice(1).some(h => inRing(lon, lat, h)));
}
/** Keys of the 250 m cells whose centres lie within r metres of xy. */
function noiseCells(D, xy, r, out = new Set()) {
  const N = D.noise, [lon0, lat0] = D.unproj([xy[0] - r, xy[1] - r]), [lon1, lat1] = D.unproj([xy[0] + r, xy[1] + r]);
  for (let j = Math.max(0, Math.floor((lat0 - N.south) / N.dlat)); j <= Math.min(N.ny - 1, Math.floor((lat1 - N.south) / N.dlat)); j++)
    for (let i = Math.max(0, Math.floor((lon0 - N.west) / N.dlon)); i <= Math.min(N.nx - 1, Math.floor((lon1 - N.west) / N.dlon)); i++)
      if (hyp(xy, D.proj([N.west + (i + 0.5) * N.dlon, N.south + (j + 0.5) * N.dlat])) <= r) out.add(i + j * N.nx);
  return out;
}
/** Noise complaints in the cells within r metres of xy over the layer's window: { n, cells, inCity }, or null outside Seattle (no data, not zero). */
export function complaintsNear(D, xy, r = 250) {
  const N = D.noise; if (!N) return null;
  const [lon, lat] = D.unproj(xy); if (!inSeattle(N, lon, lat)) return null;
  const cells = noiseCells(D, xy, r);
  return { n: [...cells].reduce((a, k) => a + (N.byKey.get(k) || 0), 0), cells: cells.size, inCity: true };
}
/**
 * Noise-complaint baseline along a route: the union of cells within r of the in-city part. perKm over the in-city
 * length; meanCell against the city's cell distribution: 'high' at p90 and above, 'elevated' from p75, else 'low'.
 * covered is the share of the route inside Seattle; outside it there is no data. Null without the layer.
 */
export function noiseRoute(D, route, { stepM = 50, r = 250 } = {}) {
  const N = D.noise; if (!N || route.length < 2) return null;
  const cells = new Set(); let inC = 0, all = 0;
  const lenM = walk(D, route, stepM, xy => { all++; const [lon, lat] = D.unproj(xy); if (inSeattle(N, lon, lat)) { inC++; noiseCells(D, xy, r, cells); } });
  const st = N.city_cell_stats, hrs = N.hour, tot = hrs.reduce((a, b) => a + b, 0);
  const base = { covered: inC / all, years: N.years, start: N.start, end: N.end, r, peakHour: hrs.indexOf(Math.max(...hrs)),
    nightShare: tot ? [22, 23, 0, 1, 2, 3, 4, 5, 6].reduce((a, h) => a + hrs[h], 0) / tot : 0, stats: st };
  if (!inC) return { ...base, n: 0, cells: 0, perKm: 0, meanCell: 0, maxCell: 0, level: null };
  const v = [...cells].map(k => N.byKey.get(k) || 0), n = v.reduce((a, b) => a + b, 0), meanCell = n / v.length;
  return { ...base, n, cells: v.length, perKm: n / Math.max(0.05, lenM * inC / all / 1000), meanCell, maxCell: Math.max(...v),
    level: meanCell >= st.p90 ? 'high' : meanCell >= st.p75 ? 'elevated' : 'low' };
}

// ---------- C2 link: mobile coverage (Ookla open data, z16 tiles; pipeline/cellular.py) ----------
const tileOf = (lon, lat, z) => [Math.floor((lon + 180) / 360 * 2 ** z), Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z)];
/** Ookla mobile tile at xy: { d, u (kbps), lat (ms), tests, dev, key }, or null where nobody ran a test (not the same as no signal). */
export function cellTile(D, xy) {
  const C = D.cell; if (!C) return null;
  const [x, y] = tileOf(...D.unproj(xy), C.z), dx = x - C.x0, dy = y - C.y0;
  if (dx < 0 || dy < 0 || dx >= C.nx || dy >= C.ny) return null;
  const n = C.byKey.get(dx * C.ny + dy);
  return n == null ? null : { d: C.d[n], u: C.u[n], lat: C.lat[n], tests: C.tests_n[n], dev: C.dev[n], key: n };
}
/**
 * Ground-level mobile performance along a route every stepM: measured = share of points on a tile with tests, good =
 * share with download ≥ minKbps and latency ≤ maxLat, worst = the longest stretch that is not good and why. Null without the layer.
 */
export function cellAlong(D, route, { minKbps = 5000, maxLat = 100, stepM = 100 } = {}) {
  const C = D.cell; if (!C || route.length < 2) return null;
  const pts = [], tiles = new Map();
  const lenM = walk(D, route, stepM, (xy, along) => {
    const t = cellTile(D, xy), why = !t ? 'no measurements' : t.d < minKbps ? 'low throughput' : t.lat > maxLat ? `latency > ${maxLat} ms` : null;
    if (t) tiles.set(t.key, t);
    pts.push({ along, why });
  });
  let worst = null, run = null;
  for (const p of [...pts, { along: lenM, why: null }]) {
    if (p.why) { if (!run) run = { fromM: p.along, why: {} }; run.why[p.why] = (run.why[p.why] || 0) + 1; continue; }
    if (run) { run.toM = Math.min(lenM, p.along); if (!worst || run.toM - run.fromM > worst.toM - worst.fromM) worst = run; run = null; }
  }
  const T = [...tiles.values()], med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  return { quarter: C.quarter, license: C.license, minKbps, maxLat, points: pts.length,
    measured: pts.filter(p => p.why !== 'no measurements').length / pts.length, good: pts.filter(p => !p.why).length / pts.length,
    tiles: T.length, tests: T.reduce((a, t) => a + t.tests, 0), medDownMbps: T.length ? med(T.map(t => t.d)) / 1000 : null, minDownMbps: T.length ? Math.min(...T.map(t => t.d)) / 1000 : null,
    medLatMs: med(T.map(t => t.lat)), worst: worst && { fromM: worst.fromM, toM: worst.toM, why: Object.entries(worst.why).sort((a, b) => b[1] - a[1])[0][0] } };
}

// ---------- Physics ----------
/** Monte Carlo failure landings around xy. Returns [x, y] points in metres. */
export function footprint(xy, altFt, ac, w, n, rnd) {
  const out = [], alt = altFt / FT, wms = w.kt * 0.5144, wr = w.dir * Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const mode = rnd(); let r, ang = rnd() * Math.PI * 2;
    const gust = 1 + (rnd() - 0.5) * 2 * w.g;
    const fall = alt / (ac.descent * (0.7 + rnd() * 0.6));
    const drift = wms * gust * fall;
    // wind blows FROM dir, so drift is toward dir + 180°
    let dx = -drift * Math.sin(wr), dy = -drift * Math.cos(wr);
    if (mode < 0.35) r = alt * 0.15 * rnd();                                  // power loss, near-ballistic
    else if (mode < 0.7 && ac.glide) r = alt * ac.glide * (0.4 + rnd() * 0.6); // glide
    else if (mode < 0.85) { r = ac.spd * (2 + rnd() * 8); ang = wr + Math.PI + (rnd() - 0.5); } // fly-away, downwind
    else r = alt * 0.3 * rnd();
    if (ac.chute && rnd() < 0.8) { dx *= 2.2; dy *= 2.2; r *= 0.3; }
    out.push([xy[0] + r * Math.cos(ang) + dx, xy[1] + r * Math.sin(ang) + dy]);
  }
  return out;
}
/** dB at ground from spherical spreading of the source level at 1 m, plus 0.005 dB/m air absorption. */
export const noiseAt = (horizM, altFt, ac) => { const r = Math.hypot(horizM, altFt / FT); return ac.src - 20 * Math.log10(Math.max(1, r)) - 0.005 * r; };
export const noiseHalfWidth = (altFt, ac, db = 55) => Math.sqrt(Math.max(0, (10 ** ((ac.src - db) / 20)) ** 2 - (altFt / FT) ** 2));

// ---------- Route scoring ----------
export const DEFAULTS = { failRatePerFh: 1e-4, sampleM: 25, footEveryM: 100, footN: 40, obstacleLateralM: 60, clearM: 30, obstacleVertFt: 50, buildingHitM: 10, powerlineM: 30, powerlineMaxFt: 250, heliportM: 800, denseKm2: 5000,
  encounterKm: 1, landingReachM: 150, notamObstacleM: 600 };

/** Altitude (ft AGL) of each waypoint: its own third coordinate, else the route default. */
export const waypointAlts = (route, altFt) => route.map(p => (p.length > 2 && Number.isFinite(p[2]) ? p[2] : altFt));

/**
 * Tallest building or obstacle (ft) within `r` metres of xy. The clearance rule used everywhere: a drone must keep
 * clearM (30 m) sideways from anything that rises to within obstacleVertFt (50 ft) of its altitude.
 */
function tallestNear(D, xy, r, lidar = true) {
  index(D);
  let h = 0;
  for (const b of nearby(D._bh, xy, r)) if (b.h_ft > h && distToBuilding(xy, b) < r) h = b.h_ft;
  for (const ob of nearby(D._oh, xy, r)) if (ob.agl_ft > h && hyp(xy, ob.xy) < r) h = ob.agl_ft;
  if (lidar) { const sf = surfaceNear(D, xy, r, true); if (sf && sf.ft > h) h = sf.ft; } // trees and unmapped structures
  return h;
}
const isBlocked = (D, xy, alt, o, r = o.clearM) => tallestNear(D, xy, r) > alt - o.obstacleVertFt;

/**
 * Live constraints: stadium game windows ({ stadium, title, tfrStart, tfrEnd }), TFRs ({ id, ring, effective, expire, lower_ft, upper_ft })
 * and NOTAMs ({ id, kind, text, lon, lat, radius_nm, agl_ft, start, end }, from pipeline/notams.mjs).
 * `when` is the planned departure; both lists are optional and the score is unchanged without them.
 */
export function scoreRoute(D, route, { aircraft = 'quad', altFt = 300, wind = WIND_PRESETS.typical, tod = 'day', hour = null, dayType = 'weekday', events = null, tfrs = [], notams = [], when = new Date(), ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt }, ac = typeof aircraft === 'string' ? AIRCRAFT[aircraft] : aircraft;
  // hour (0–24, local) switches the ground population from the TOD preset to the hourly model; the event crowd still applies
  const W = hour == null ? TOD[tod] : { ...hourWeights(D, hour, dayType), crowd: TOD[tod]?.crowd };
  const dens = (xy, mn) => weighted(D, xy, W, mn);
  index(D);
  const pts = route.map(p => D.proj(p)), alts = waypointAlts(route, altFt), rnd = rng(99);
  const samples = [], foot = [], footFrom = [], obst = new Map(), bld = new Map(), lines = new Map(), air = new Map(), noise = { hospital: 0, school: 0 };
  let lenM = 0, nextFoot = 0, overSum = 0, hi = 0, waterLandings = 0;
  const near = new Map();
  const tfrPolys = (tfrs || []).filter(t => t.ring?.length > 3).map(t => { const rings = [[t.ring.map(D.proj)]]; return { t, rings, bbox: bboxOf(rings) }; });
  // Obstacle NOTAMs are points (often to the nearest minute, ~1.8 km); others reach their stated radius or 1 km.
  const notamPts = (notams || []).map(n => ({ n, xy: D.proj([n.lon, n.lat]), r: n.radius_nm ? n.radius_nm * 1852 : n.kind === 'obstacle' ? o.notamObstacleM : 1000 }));
  const notamHits = new Map();
  const sampleAt = (xy, along, alt) => {
    const mn = cellMeans(D, xy), d = dens(xy, mn), fc = faaCategory(D, xy);
    const cov = coverage(D, xy), sf = surfaceNear(D, xy, o.clearM), un = sf && surfaceNear(D, xy, o.clearM, true), tr = trafficAt(D, xy, alt);
    return { xy, ll: D.unproj(xy), along, alt, d, mn, c: fc ?? catFromDensity(d), faa: fc != null, ceiling: facilityCeiling(D, xy), water: cov === 'water',
      blocked: isBlocked(D, xy, alt, o), noData: cov === 'nodata' || cov === 'unloaded',
      surf: sf, unmapped: un, mapped: un ? tallestNear(D, xy, o.clearM, false) : 0, traffic: tr, land: landUse(D, xy), landing: nearOpenLand(D, xy, o.landingReachM) };
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = hyp(a, b), steps = Math.max(1, Math.ceil(L / o.sampleM));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, xy = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], along = lenM + L * t;
      const alt = alts[i] + (alts[i + 1] - alts[i]) * t;
      samples.push(sampleAt(xy, along, alt));
      for (const ob of nearby(D._oh, xy, o.obstacleLateralM)) { const dm = hyp(xy, ob.xy); if (dm < o.obstacleLateralM && ob.agl_ft > alt - o.obstacleVertFt) {
        const prev = obst.get(ob.id); obst.set(ob.id, { ...ob, alt: Math.min(alt, prev?.alt ?? Infinity), dm: Math.min(dm, prev?.dm ?? Infinity) });
      } }
      for (const bd of nearby(D._bh, xy, o.obstacleLateralM)) if (bd.h_ft > alt - o.obstacleVertFt) {
        const dm = distToBuilding(xy, bd);
        if (dm < o.obstacleLateralM) { const prev = bld.get(bd.id); bld.set(bd.id, { ...bd, alt: Math.min(alt, prev?.alt ?? Infinity), dm: Math.min(dm, prev?.dm ?? Infinity) }); }
      }
      for (const pl of D.powerlines) if (alt < o.powerlineMaxFt) for (let k = 0; k < pl.xy.length - 1; k++)
        if (segDist(xy, pl.xy[k], pl.xy[k + 1]) < o.powerlineM) { lines.set(pl, along); break; }
      for (const st of D.sites) {
        const dm = hyp(xy, st.xy);
        if (st.kind === 'hospital' || st.kind === 'school') { const db = noiseAt(dm, alt, ac); if (db > 55) { noise[st.kind] = Math.max(noise[st.kind], db); near.set(st, Math.max(near.get(st) || 0, db)); } }
        if (st.kind === 'heliport' && dm < o.heliportM) air.set(`Heliport ${st.name}`, { kind: 'heliport', site: st, dm: Math.min(dm, air.get(`Heliport ${st.name}`)?.dm ?? Infinity) });
        if (st.kind === 'airport' && dm < 3000) air.set(`Airport ${st.name}`, { kind: 'airport', site: st, dm });
        if (st.kind === 'stadium' && st.tfr && dm < STADIUM_TFR_M && !air.has(`Stadium TFR ${st.name}`)) {
          const games = events ? events.filter(e => st.name.includes(e.stadium)) : null;
          const now = games?.find(e => when >= e.tfrStart && when <= e.tfrEnd), next = games?.find(e => e.tfrStart > when);
          air.set(`Stadium TFR ${st.name}`, { kind: 'stadium', site: st, dm, conditional: tod !== 'event' && !now, now, next, scheduled: !!games });
        }
      }
      for (const P of D.surface) if (inPolys(xy[0], xy[1], P)) air.set(`${P.props.name}`, { kind: 'surface', cls: P.props.class });
      for (const P of notamPts) {
        const dm = hyp(xy, P.xy);
        if (dm > P.r || (P.n.kind === 'obstacle' && P.n.agl_ft != null && P.n.agl_ft <= alt - o.obstacleVertFt)) continue;
        const active = (!P.n.start || when >= new Date(P.n.start)) && (!P.n.end || when <= new Date(P.n.end));
        notamHits.set(P.n.id, { ...P.n, dm: Math.min(dm, notamHits.get(P.n.id)?.dm ?? Infinity), active });
      }
      for (const T of tfrPolys) if (alt >= (T.t.lower_ft ?? 0) && alt <= (T.t.upper_ft ?? Infinity) && inPolys(xy[0], xy[1], T)) {
        const active = (!T.t.effective || when >= new Date(T.t.effective)) && (!T.t.expire || when <= new Date(T.t.expire));
        air.set(`TFR ${T.t.id}`, { kind: 'tfr', tfr: T.t, conditional: !active, active });
      }
      if (along >= nextFoot) {
        nextFoot += o.footEveryM;
        for (const p of footprint(xy, alt, ac, wind, o.footN, rnd)) {
          const pd = dens(p); foot.push(p); footFrom.push([xy, alt]); overSum += pd;
          if (pd >= o.denseKm2) hi++;
          if (isWater(D, p)) waterLandings++;
        }
      }
    }
    lenM += L;
  }
  if (pts.length > 1) samples.push(sampleAt(pts[pts.length - 1], lenM, alts[alts.length - 1]));
  if (samples.length < 2) return null;

  const maxCat = Math.max(...samples.map(s => s.c));
  const meanUnder = foot.length ? overSum / foot.length : 0;
  const hours = lenM / ac.spd / 3600;
  // Expected ground fatalities per flight hour: failure rate × lethal area × people per m² under the footprint.
  const ecPerFh = o.failRatePerFh * ac.lethalAreaM2 * meanUnder / 1e6;
  const laanc = samples.filter(s => s.ceiling != null);
  const overCeiling = laanc.filter(s => s.alt > s.ceiling);
  const altMin = Math.min(...alts), altMax = Math.max(...alts);
  return {
    ...lidarSummary(samples, o), ...trafficSummary(D, samples, ac, o), ...landSummary(samples, lenM),
    climate: windClimate(D, samples[Math.floor(samples.length / 2)].xy, (altMin + altMax) / 2),
    ...phase1(D, route, samples, { hour, dayType, tod, W }),
    ac, altFt, alts, altMin, altMax, levelled: altMin !== altMax, wind, tod, hour, dayType, opt: o, samples, foot, footFrom, lenM, minutes: hours * 60, maxCat,
    meanD: samples.reduce((a, s) => a + s.d, 0) / samples.length, peakD: Math.max(...samples.map(s => s.d)),
    faaShare: samples.filter(s => s.faa).length / samples.length,
    hiFrac: foot.length ? hi / foot.length : 0, waterFrac: foot.length ? waterLandings / foot.length : 0, meanUnder, ecPerFh, ecPerFlight: ecPerFh * hours,
    obstacles: [...obst.values()].sort((a, b) => b.agl_ft - a.agl_ft), buildings: [...bld.values()].sort((a, b) => b.h_ft - a.h_ft),
    blockedShare: samples.filter(s => s.blocked).length / samples.length,
    noDataShare: samples.filter(s => s.noData).length / samples.length,
    powerlines: [...lines.keys()].map(pl => pl.props),
    airspace: [...air.entries()].map(([name, v]) => ({ name, ...v })), noise, noiseSites: [...near.entries()].map(([s, db]) => ({ name: s.name, kind: s.kind, db })).sort((a, b) => b.db - a.db),
    laancShare: laanc.length / samples.length, minCeiling: laanc.length ? Math.min(...laanc.map(s => s.ceiling)) : null, overCeilingShare: overCeiling.length / samples.length,
    halfWidth55: noiseHalfWidth(altMin, ac),
    notams: [...notamHits.values()].sort((a, b) => b.active - a.active || a.dm - b.dm),
  };
}

/**
 * The Phase 1 baselines: ground density by hour, road users, noise complaints and mobile coverage along the route.
 * Each is null when its layer is not loaded. popLabel names the population model behind the samples.
 */
function phase1(D, route, samples, { hour, dayType, tod, W }) {
  const crowd = W.crowd ? ' + stadium crowd' : '';
  return {
    popLabel: hour == null ? TOD[tod].label : `${dayType} ${hhmm(hour)} (${W.preset ? `no hourly layer: ${hourWeights(D, hour).res === 1 ? 'overnight' : 'daytime'} preset` : 'ATUS hourly model'}${crowd})`,
    schoolHours: hour == null ? tod !== 'night' : dayType === 'weekday' && mod24(hour) >= 7 && mod24(hour) < 16,
    hourly: hourlyProfile(D, samples.map(s => s.mn)),
    roads: roadCrossings(D, route, { hour: hour ?? TOD_HOUR[tod], dayType: hour == null ? 'weekday' : dayType }),
    complaints: noiseRoute(D, route), link: cellAlong(D, route),
  };
}
/** True if a park, field or cemetery lies within r metres of xy (3×3 grid cells for r up to one cell). */
function nearOpenLand(D, xy, r) {
  if (landUse(D, xy) == null) return null;
  for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]])
    if (OPEN_LAND.has(landUse(D, [xy[0] + dx, xy[1] + dy]))) return true;
  return false;
}
/**
 * Lidar conflicts: stretches where the surface within clearM rises to within obstacleVertFt of the route and no mapped
 * building or obstacle explains it (mapped ones are reported from their own layers). Grouped into runs along the route.
 */
function lidarSummary(samples, o) {
  const cov = samples.filter(s => s.surf);
  const runs = [];
  for (const s of samples) {
    const u = s.unmapped, hit = u && u.ft > s.alt - o.obstacleVertFt && u.ft > s.mapped + o.obstacleVertFt;
    const last = runs[runs.length - 1];
    if (!hit) continue;
    if (last && s.along - last.to <= o.sampleM * 1.5) { last.to = s.along; if (u.ft > last.ft) Object.assign(last, { ft: u.ft, kind: u.kind, ll: s.ll, alt: s.alt }); }
    else runs.push({ from: s.along, to: s.along, ft: u.ft, kind: u.kind, ll: s.ll, alt: s.alt });
  }
  return { lidarShare: cov.length / samples.length, surfaceMaxFt: cov.length ? Math.max(...cov.map(s => s.surf.ft)) : null, surfaceHits: runs.sort((a, b) => b.ft - a.ft) };
}
/**
 * Crewed traffic along the route at its altitude, and the expected rate of crewed aircraft passing within encounterKm
 * in the same band: density × 2R × relative speed (the classic gas model), per flight hour.
 */
function trafficSummary(D, samples, ac, o) {
  const T = D.traffic, tr = samples.filter(s => s.traffic);
  if (!T || !tr.length) return { traffic: null };
  const mean = tr.reduce((a, s) => a + s.traffic.rho, 0) / tr.length, peak = Math.max(...tr.map(s => s.traffic.rho));
  const rotor = tr.reduce((a, s) => a + s.traffic.rotor, 0) / tr.length;
  const band = tr[Math.floor(tr.length / 2)].traffic.band, v = Math.hypot(T.speed_ms[band], ac.spd) / 1000;
  return { traffic: { mean, peak, rotorShare: mean ? rotor / mean : 0, band, bandFt: [T.bands_ft[band], T.bands_ft[band + 1]],
    level: trafficLevel(D, mean, band), peakLevel: trafficLevel(D, peak, band), encountersPerFh: mean * 2 * o.encounterKm * v * 3600, days: T.days.length, hours: T.hours } };
}
/** Land-use mix under the route and the longest stretch with no park, field or cemetery within reach. */
function landSummary(samples, lenM) {
  const lu = samples.filter(s => s.land != null);
  if (!lu.length) return { land: null };
  const mix = {};
  for (const s of lu) mix[s.land] = (mix[s.land] || 0) + 1 / lu.length;
  let gap = 0, last = 0;
  for (const s of samples) if (s.landing || s.water) { gap = Math.max(gap, s.along - last); last = s.along; }
  gap = Math.max(gap, lenM - last);
  return { land: { mix: Object.entries(mix).sort((a, b) => b[1] - a[1]), landingGapM: gap, landingShare: samples.filter(s => s.landing || s.water).length / samples.length } };
}

// ---------- Planning: clear buildings and obstacles ----------
export const MAX_ALT_FT = 400;
const roundUp = (x, step = 25) => Math.ceil(x / step) * step;

/**
 * Climb over: raise the waypoints at both ends of every leg that does not clear its obstacles by the vertical buffer,
 * up to 400 ft and the facility map ceiling. Returns the new route and the legs it could not fix.
 */
export function planClimb(D, route, { altFt = 300, ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt }, alts = waypointAlts(route, altFt), pts = route.map(p => D.proj(p)), stuck = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = hyp(a, b), steps = Math.max(1, Math.ceil(L / o.sampleM));
    let need = 0, cap = MAX_ALT_FT;
    for (let s = 0; s <= steps; s++) {
      const xy = [a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps];
      need = Math.max(need, tallestNear(D, xy, o.clearM));
      const c = facilityCeiling(D, xy); if (c != null) cap = Math.min(cap, c);
    }
    if (!need) continue;
    const want = roundUp(need + o.obstacleVertFt);
    if (want > cap) { stuck.push({ leg: i, needFt: want, capFt: cap }); continue; }
    alts[i] = Math.max(alts[i], want); alts[i + 1] = Math.max(alts[i + 1], want);
  }
  return { route: route.map((p, i) => [p[0], p[1], alts[i]]), stuck };
}

/**
 * Go around: A* on a 20 m grid around each leg, at the leg's altitude, avoiding every building and obstacle that
 * does not clear by the vertical buffer, then pull the path tight. Waypoints keep their order.
 */
export function planAround(D, route, { altFt = 300, cellM = 15, marginM = 600, ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt }, alts = waypointAlts(route, altFt), pts = route.map(p => D.proj(p));
  index(D);
  // Via points (not the launch or drop) that sit inside a clearance ring move to the nearest clear spot.
  const moved = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const r0 = o.clearM + cellM * 0.75;
    if (!isBlocked(D, pts[i], alts[i], o, r0)) continue;
    let best = null;
    for (let rad = cellM; rad <= 300 && !best; rad += cellM) for (let k = 0; k < 24 && !best; k++) {
      const q = [pts[i][0] + rad * Math.cos(k * Math.PI / 12), pts[i][1] + rad * Math.sin(k * Math.PI / 12)];
      if (!isBlocked(D, q, alts[i], o, r0)) best = q;
    }
    if (best) { pts[i] = best; moved.push(i); }
  }
  const at = i => [...D.unproj(pts[i]), alts[i]];
  const out = [at(0)], failed = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const alt = Math.min(alts[i], alts[i + 1]), a = pts[i], b = pts[i + 1];
    const x0 = Math.min(a[0], b[0]) - marginM, y0 = Math.min(a[1], b[1]) - marginM;
    const nx = Math.ceil((Math.max(a[0], b[0]) + marginM - x0) / cellM), ny = Math.ceil((Math.max(a[1], b[1]) + marginM - y0) / cellM);
    const cxy = (i2, j2) => [x0 + (i2 + 0.5) * cellM, y0 + (j2 + 0.5) * cellM];
    const blocked = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let k = 0; k < nx; k++) {
      if (isBlocked(D, cxy(k, j), alt, o, o.clearM + cellM * 0.75)) blocked[j * nx + k] = 1;
    }
    const cell = p => [Math.min(nx - 1, Math.max(0, Math.floor((p[0] - x0) / cellM))), Math.min(ny - 1, Math.max(0, Math.floor((p[1] - y0) / cellM)))];
    const [si, sj] = cell(a), [ti, tj] = cell(b), S = sj * nx + si, T = tj * nx + ti;
    // Launch and drop pads may sit beside a tower: the aircraft climbs and lets down vertically within clearM of them.
    const pad = Math.ceil((o.clearM + cellM) / cellM);
    for (const [pi, pj] of [[si, sj, i === 0], [ti, tj, i + 1 === pts.length - 1]].filter(e => e[2])) for (let dj = -pad; dj <= pad; dj++) for (let di = -pad; di <= pad; di++) {
      const X = pi + di, Y = pj + dj; if (X >= 0 && Y >= 0 && X < nx && Y < ny && Math.hypot(di, dj) <= pad) blocked[Y * nx + X] = 0;
    }
    const path = astar(nx, ny, blocked, S, T);
    if (!path) { failed.push(i); out.push(at(i + 1)); continue; }
    const xy = path.map(q => cxy(q % nx, Math.floor(q / nx)));
    xy[0] = a; xy[xy.length - 1] = b;
    const free = (p, q) => { const n = Math.ceil(hyp(p, q) / (cellM / 2)); for (let s = 1; s < n; s++) { const [ci, cj] = cell([p[0] + (q[0] - p[0]) * s / n, p[1] + (q[1] - p[1]) * s / n]); if (blocked[cj * nx + ci]) return false; } return true; };
    // string pulling: keep only the turns the obstacles force
    let k = 0;
    while (k < xy.length - 1) {
      let far = xy.length - 1;
      while (far > k + 1 && !free(xy[k], xy[far])) far--;
      if (far < xy.length - 1) out.push([...D.unproj(xy[far]), alt]);
      k = far;
    }
    out.push(at(i + 1));
  }
  return { route: out.map(p => [+p[0].toFixed(6), +p[1].toFixed(6), p[2]]), failed, moved };
}

function astar(nx, ny, blocked, S, T) {
  const g = new Float64Array(nx * ny).fill(Infinity), from = new Int32Array(nx * ny).fill(-1), done = new Uint8Array(nx * ny);
  const tx = T % nx, ty = Math.floor(T / nx), hcost = q => Math.hypot(q % nx - tx, Math.floor(q / nx) - ty);
  const heap = [[hcost(S), S]]; g[S] = 0;
  const push = e => { heap.push(e); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  while (heap.length) {
    const [, q] = pop();
    if (done[q]) continue; done[q] = 1;
    if (q === T) { const p = [q]; let c = q; while (from[c] >= 0) { c = from[c]; p.push(c); } return p.reverse(); }
    const x = q % nx, y = Math.floor(q / nx);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
      const n = Y * nx + X; if (blocked[n] || done[n]) continue;
      if (dx && dy && (blocked[y * nx + X] || blocked[Y * nx + x])) continue; // no corner cutting
      const ng = g[q] + (dx && dy ? Math.SQRT2 : 1);
      if (ng < g[n]) { g[n] = ng; from[n] = q; push([ng + hcost(n), n]); }
    }
  }
  return null;
}

// ---------- Findings ----------
/** '300 ft AGL' or '250–375 ft AGL' when the route changes level. */
export const altLabel = r => (r.levelled ? `${r.altMin}–${r.altMax}` : `${r.altMin}`) + ' ft AGL';

const TZ = 'America/Los_Angeles';
const fmtDay = d => d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = d => d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

export function findings(r) {
  const f = [];
  if (r.noDataShare > 0) f.push(['crit', `${Math.round(r.noDataShare * 100)}% of the route is outside the data coverage. Ground risk there is unknown, not zero.`]);
  const pct = x => Math.round(x * 100) + '%';
  const share = c => pct(r.samples.filter(s => s.c >= c).length / r.samples.length);
  if (r.maxCat === 5) f.push(['crit', `${share(5)} of the route crosses Category 5 ground, the densest class on the FAA operating categories map. Expect the heaviest safety case; reroute if the destination allows.`]);
  else if (r.maxCat === 4) f.push(['warn', `${share(4)} of the route crosses Category 4 ground on the FAA operating categories map. About 80% of the region's residential neighbourhoods are Category 4, so this is the normal case for urban delivery; the safety case must carry it.`]);
  else if (r.maxCat === 3) f.push(['warn', 'Category 3 segments present.']);
  else f.push(['good', 'Entire route stays in Category 1–2 ground.']);
  const through = r.buildings.filter(b => b.dm < r.opt.buildingHitM && b.h_ft >= b.alt - r.opt.obstacleVertFt);
  if (through.length) f.push(['crit', `The route passes through or within ${r.opt.buildingHitM} m of ${through.length} building${through.length > 1 ? 's' : ''} that reach its altitude, tallest ${through[0].h_ft} ft${through[0].name ? ` (${through[0].name})` : ''}. Use Climb over or Go around.`]);
  const hard = [...r.obstacles.filter(o => o.dm < r.opt.clearM), ...r.buildings.filter(b => !through.includes(b) && b.dm < r.opt.clearM).map(b => ({ ...b, agl_ft: b.h_ft, kind: 'building', src: 'OSM' }))].sort((a, b) => b.agl_ft - a.agl_ft);
  if (hard.length) f.push(['crit', `${hard.length} obstacle${hard.length > 1 ? 's' : ''} within ${r.opt.clearM} m rise to within ${r.opt.obstacleVertFt} ft of the route's altitude, tallest ${hard[0].agl_ft} ft (${hard[0].name || hard[0].kind}, ${hard[0].src}). Not enough clearance.`]);
  const close = r.obstacles.length + r.buildings.length - hard.length - through.length;
  if (!hard.length && !through.length && close > 0) f.push(['warn', `${close} obstacles or buildings within ${r.opt.obstacleLateralM} m rise to within ${r.opt.obstacleVertFt} ft of the route's altitude.`]);
  if (r.levelled) f.push(['good', `Altitude varies from ${r.altMin} to ${r.altMax} ft AGL along the route.`]);
  for (const h of r.surfaceHits || []) {
    const near = h.ft >= h.alt ? 'reaches' : `rises to within ${r.opt.obstacleVertFt} ft of`;
    f.push([h.ft >= h.alt ? 'crit' : 'warn', `Lidar: ${h.kind} ${near} the route's ${Math.round(h.alt)} ft level for ${Math.max(25, Math.round(h.to - h.from))} m near ${h.ll[1].toFixed(4)}, ${h.ll[0].toFixed(4)} (${h.ft} ft above ground, not in the mapped buildings or obstacle file).`]);
    if (f.filter(x => x[1].startsWith('Lidar:')).length >= 3) { const more = r.surfaceHits.length - 3; if (more > 0) f.push(['warn', `Lidar: ${more} more stretch${more > 1 ? 'es' : ''} with trees or structures close to the route's level.`]); break; }
  }
  if (r.lidarShare === 0) f.push(['warn', 'No 3DEP lidar survey in the data covers this route, so trees and unmapped structures are not checked. Survey the corridor.']);
  else if (r.lidarShare != null && r.lidarShare < 0.95) f.push(['warn', `3DEP lidar covers ${pct(r.lidarShare)} of the route; trees and unmapped structures on the rest are not checked.`]);
  const cranes = r.obstacles.filter(o => o.temporary);
  if (cranes.length) f.push(['warn', `${cranes.length} construction crane${cranes.length > 1 ? 's' : ''} mapped near the route. Cranes move; check FAA construction notices before each operation.`]);
  if (r.powerlines.length) f.push(['warn', `Route crosses or runs within ${r.opt.powerlineM} m of ${r.powerlines.length} mapped transmission line${r.powerlines.length > 1 ? 's' : ''} below ${r.opt.powerlineMaxFt} ft. Distribution lines are not in the public data.`]);
  if (r.overCeilingShare > 0) f.push(['crit', `${pct(r.overCeilingShare)} of the route is inside a UAS facility map grid with a ceiling below its altitude (lowest ${r.minCeiling} ft). Needs a LAANC further-coordination request or an airspace authorization.`]);
  else if (r.laancShare > 0) f.push(['warn', `${pct(r.laancShare)} of the route is in controlled airspace; LAANC authorization required up to the grid ceiling (lowest ${r.minCeiling} ft).`]);
  for (const a of r.airspace) {
    if (a.kind === 'heliport') f.push(['crit', `${a.name} is ${Math.round(a.dm)} m from the route. Coordinate with the heliport operator; letter of agreement expected.`]);
    if (a.kind === 'airport') f.push(['crit', `${a.name} within 3 km.`]);
    if (a.kind === 'surface') f.push(['crit', `Route enters the ${a.name} surface area (Class ${a.cls}).`]);
    if (a.kind === 'stadium') {
      const nm = `${a.site.name} is ${(a.dm / 1852).toFixed(1)} NM away, inside its 3 NM stadium TFR`;
      const span = e => e.tbd ? `${fmtDay(e.tfrStart)}, all day (kickoff not announced)` : `${fmtDay(e.tfrStart)} ${fmtTime(e.tfrStart)}–${fmtTime(e.tfrEnd)}`;
      if (a.now) f.push(['crit', `${nm}, active now for ${a.now.title} until ${fmtTime(a.now.tfrEnd)}.`]);
      else if (!a.conditional) f.push(['crit', `${nm}. No flight from 1 h before to 1 h after events.`]);
      else if (a.next) f.push(['warn', `${nm}. Next closure: ${span(a.next)} (${a.next.title}).`]);
      else if (a.scheduled) f.push(['good', `${nm}; no MLB, NFL or NCAA football game there in the next 30 days.`]);
      else f.push(['warn', `${nm} on event days. No flight from 1 h before to 1 h after events.`]);
    }
    if (a.kind === 'tfr') f.push([a.active ? 'crit' : 'warn', `${a.active ? 'Inside active' : 'Crosses upcoming'} TFR ${a.tfr.id} (${a.tfr.type.toLowerCase()}), ${a.tfr.lower_ft ?? 0}–${a.tfr.upper_ft} ft, ${fmtDay(new Date(a.tfr.effective))} ${fmtTime(new Date(a.tfr.effective))} to ${fmtDay(new Date(a.tfr.expire))} ${fmtTime(new Date(a.tfr.expire))}.`]);
  }
  const dense = `ground above ${r.opt.denseKm2.toLocaleString()} people/km²`;
  if (r.hiFrac > 0.25) f.push(['crit', `${pct(r.hiFrac)} of simulated failure landings fall on ${dense}. ${r.ac.chute ? 'The parachute lowers impact energy but widens drift under this wind.' : 'A parachute system would lower impact energy.'}`]);
  else if (r.hiFrac > 0.05) f.push(['warn', `${pct(r.hiFrac)} of simulated failure landings fall on ${dense}.`]);
  if (r.waterFrac > 0.2) f.push(['good', `${pct(r.waterFrac)} of simulated failure landings fall in water.`]);
  if (r.ecPerFh > 1e-6) f.push(['warn', `Estimated ${r.ecPerFh.toExponential(1)} ground fatalities per flight hour at the assumed failure rate, above the 1e-6 target often used in ground-risk assessments.`]);
  const nts = (r.notams || []).filter(n => n.active);
  for (const n of nts.slice(0, 3)) f.push(['warn', `NOTAM ${n.id} (${n.kind}, ${Math.round(n.dm)} m from the route): ${n.text.replace(/\s+/g, ' ').slice(0, 160)}${n.text.length > 160 ? '…' : ''}`]);
  if (nts.length > 3) f.push(['warn', `${nts.length - 3} more active NOTAMs touch the route; see the package.`]);
  if (r.traffic) {
    const t = r.traffic, band = `${t.bandFt[0]}–${t.bandFt[1]} ft`, heli = t.rotorShare > 0.3 ? `, ${pct(t.rotorShare)} of it helicopters` : '';
    const rate = t.encountersPerFh === 0 ? `no crewed aircraft were recorded at this level within ${r.opt.encounterKm} km`
      : `about ${rateText(t.encountersPerFh)} crewed aircraft pass within ${r.opt.encounterKm} km per flight hour`;
    const msg = `Crewed traffic at ${band} along the route is ${t.level} for the region (ADS-B, ${t.hours} sampled hours${heli}): ${rate}.`;
    f.push([t.level === 'very high' || t.peakLevel === 'very high' ? 'crit' : t.level === 'high' ? 'warn' : 'good', msg + (t.peakLevel !== t.level ? ` Peaks ${t.peakLevel}.` : '')]);
  }
  if (r.land && r.land.landingGapM > 1000) {
    const un = r.land.mix.find(([k]) => k === 'unmapped')?.[1] || 0;
    f.push(['warn', `${(r.land.landingGapM / 1000).toFixed(1)} km of the route has no park, field, cemetery or water within ${r.opt.landingReachM} m for a contingency landing${un > 0.25 ? ` (OpenStreetMap has no land use for ${pct(un)} of the route, so a survey may find more)` : ''}.`]);
  }
  if (r.climate) {
    const c = r.climate, mon = new Date(2000, c.worstMonth - 1).toLocaleString('en-US', { month: 'long' });
    const o20 = c.over['20'];
    f.push([o20 > 0.1 ? 'warn' : 'good', `HRRR ${c.year}: the 80 m (262 ft) wind here exceeds 20 kt in ${pct(o20)} of daytime hours, worst in ${mon} (${pct(c.worstOver20)}); at ${c.altFt} ft the median is ${c.p50} kt and the 90th percentile ${c.p90} kt.`]);
  }
  if (r.hourly) {
    const w = r.hourly.windows.weekday, e = r.hourly.windows.weekend, ce = `weekends Cat ${e.lo}${e.hi > e.lo ? `–${e.hi}` : ''}`;
    // census density above the governing (FAA map) category is a caution, never a pass
    const top = Math.max(w.hi, e.hi), over = top > r.maxCat ? ` At its worst hour the census-derived category (Cat ${top}) is above the governing Category ${r.maxCat} (FAA map where it covers the route); the safety case should account for it.` : '';
    if (w.hi > w.lo) f.push(['warn', `Ground population under the route changes with the hour (ATUS hourly model, census categories): weekdays Cat ${w.lo} ${windowText(w.best)} and Cat ${w.hi} ${windowText(w.worst)}; ${ce}. Scheduling in the Cat ${w.lo} window lowers ground risk; the FAA map category is static.${over}`]);
    else f.push([over ? 'warn' : 'good', `Census-derived category is Cat ${w.hi} at every weekday hour (ATUS hourly model), ${ce}; mean density peaks at ${hhmm(w.busiest)} and is lowest at ${hhmm(w.quietest)}.${over}`]);
  }
  if (r.roads && (r.roads.crossings.length || r.roads.parallel.length)) {
    const R = r.roads, big = [...R.crossings, ...R.parallel].sort((a, b) => b.aadt - a.aadt)[0], nc = R.crossings.length;
    f.push([big.aadt >= 40000 || R.parallel.some(p => p.aadt >= 20000) ? 'warn' : 'good', `The route crosses counted roads ${nc} time${nc === 1 ? '' : 's'}${R.followed ? ` and follows ${R.followed} counted road${R.followed === 1 ? '' : 's'}` : ''} (busiest ${big.name}, ${big.aadt.toLocaleString('en-US')} vehicles/day): about ${R.vehUnder.toFixed(1)} vehicles, ${R.peopleUnder.toFixed(1)} people, under the footprint per flight at ${hhmm(R.hour)} on a ${R.dayType}. Cross roads at right angles and avoid following busy ones.`]);
  }
  const nc = r.complaints;
  if (nc && nc.covered > 0) f.push([nc.level === 'high' ? 'warn' : 'good', `${nc.n.toLocaleString('en-US')} noise complaints within ${nc.r} m of the route's Seattle part over ${Math.round(nc.years)} years (${Math.round(nc.perKm)} per km; nearby cells average ${nc.meanCell.toFixed(1)} against a city p75 of ${nc.stats.p75} and p90 of ${nc.stats.p90}): ${nc.level} for Seattle. Complaints citywide peak at ${hhmm(nc.peakHour)}.`]);
  const L = r.link;
  if (L) {
    const gap = L.worst ? `; longest stretch without a usable tile ${((L.worst.toM - L.worst.fromM) / 1000).toFixed(2)} km (${L.worst.why})` : '';
    f.push([L.good >= 0.9 ? 'good' : 'warn', `Ookla ${L.quarter} ground-level mobile tests: ${pct(L.measured)} of the route measured, ${pct(L.good)} at ≥ ${L.minKbps / 1000} Mbps and ≤ ${L.maxLat} ms${gap}. Handset data at street level does not show the link at altitude; survey the C2 link along the corridor.`]);
  }
  if (r.wind.kt >= 20) f.push(['warn', `${r.wind.kt} kt wind: failure drift up to ${Math.round(r.wind.kt * 0.5144 * 1.5 * (r.altMax / FT / r.ac.descent))} m downwind. Set a wind limit in the operations manual.`]);
  if (r.noise.hospital) f.push(['warn', `${Math.round(r.noise.hospital)} dB at a hospital, above a 55 dB daytime target.`]);
  if (r.noise.school && (r.schoolHours ?? r.tod !== 'night')) f.push(['warn', `${Math.round(r.noise.school)} dB at ${r.noiseSites.filter(s => s.kind === 'school').length} school${r.noiseSites.filter(s => s.kind === 'school').length > 1 ? 's' : ''} during school hours.`]);
  return f;
}
export const verdict = f => (f.some(x => x[0] === 'crit') ? 'crit' : f.some(x => x[0] === 'warn') ? 'warn' : 'good');

// ---------- Area of intended flight ----------
/** Convex hull of the route and every simulated failure landing, as a [lon, lat] ring: the ground a contingency can reach. */
export function intendedArea(D, r) {
  const P = [...r.samples.map(s => s.xy), ...r.foot].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.slice().reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  const ring = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; area += a[0] * b[1] - b[0] * a[1]; }
  return { ring: [...ring, ring[0]].map(D.unproj), km2: Math.abs(area) / 2 / 1e6 };
}

// ---------- Sky lanes: the air-road network ----------
// Lanes follow arterial roads (fewer people below, noise masked by traffic). Each tier has one level per direction,
// so opposing traffic never shares a level. Only the drone tier is flyable under today's rules; the upper tiers are a
// 2035 scenario drawn for planning conversations.
export const TIERS = [
  { id: 'drone', name: 'Drone lanes', levels: [250, 350], roads: ['motorway', 'trunk', 'primary', 'secondary'], spd: 18, color: [82, 201, 162], today: true },
  { id: 'taxi', name: 'Air-taxi lanes', levels: [800, 1000], roads: ['motorway', 'trunk'], spd: 55, color: [106, 169, 255], today: false },
  { id: 'personal', name: 'Personal flight', levels: [1600, 2000], roads: ['motorway'], spd: 70, color: [242, 184, 75], today: false },
];
export const LANE_STATUS = ['open', 'blocked', 'ceiling', 'cat5', 'atc'];

/** Why a lane at levelFt cannot be flown at xy: 'blocked' by a structure, over the LAANC 'ceiling', over 'cat5' ground, inside Class B ('atc'), else 'open'. */
export function laneStatus(D, xy, levelFt, tier, o = DEFAULTS) {
  if (isBlocked(D, xy, levelFt, o)) return 'blocked';
  if (tier.today) {
    const c = facilityCeiling(D, xy);
    if (c != null && levelFt > c) return 'ceiling';
    if (faaCategory(D, xy) === 5) return 'cat5';
  } else if (D.classB.some(P => P.props.lower_ft <= levelFt && inPolys(xy[0], xy[1], P))) return 'atc';
  return 'open';
}

/** Douglas–Peucker in metres. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > max) { max = d; idx = i; } }
  if (max <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

/**
 * Build every lane piece: roads → simplified paths → one path per tier level, split into runs of equal status.
 * roads: [{ highway, coords: [[lon, lat], ...] }]. Returns [{ t: tier index, l: level ft, s: status index, p: [[lon, lat], ...] }].
 */
export function buildLanes(D, roads, { stepM = 25, tolM = 12, minM = 120 } = {}) {
  index(D);
  const out = [];
  for (const road of roads) {
    const xy = simplify(road.coords.map(c => D.proj(c)), tolM);
    let len = 0; for (let i = 0; i < xy.length - 1; i++) len += hyp(xy[i], xy[i + 1]);
    if (len < minM) continue;
    // resample once; every tier level walks the same points
    const pts = [];
    for (let i = 0; i < xy.length - 1; i++) {
      const n = Math.max(1, Math.ceil(hyp(xy[i], xy[i + 1]) / stepM));
      for (let k = 0; k < n; k++) pts.push([xy[i][0] + (xy[i + 1][0] - xy[i][0]) * k / n, xy[i][1] + (xy[i + 1][1] - xy[i][1]) * k / n]);
    }
    pts.push(xy[xy.length - 1]);
    TIERS.forEach((tier, t) => {
      if (!tier.roads.includes(road.highway)) return;
      for (const l of tier.levels) {
        let run = [pts[0]], st = laneStatus(D, pts[0], l, tier);
        const flush = () => { if (run.length > 1) out.push({ t, l, s: LANE_STATUS.indexOf(st), p: simplify(run, 3).map(q => D.unproj(q).map(v => +v.toFixed(5))) }); };
        for (let i = 1; i < pts.length; i++) {
          const s2 = laneStatus(D, pts[i], l, tier);
          run.push(pts[i]);
          if (s2 !== st) { flush(); run = [pts[i]]; st = s2; }
        }
        flush();
      }
    });
  }
  return out;
}

/** Kilometres of lane per tier and status. */
export function laneStats(lanes, D) {
  const km = TIERS.map(() => LANE_STATUS.map(() => 0));
  for (const ln of lanes) { let m = 0; for (let i = 0; i < ln.p.length - 1; i++) m += hyp(D.proj(ln.p[i]), D.proj(ln.p[i + 1])); km[ln.t][ln.s] += m / 1000; }
  return km;
}

// ---------- Lanes near a point ("is my home under a lane?") ----------
export const LANE_HALF = 40; // m: a lane is 80 m wide around its centreline
/**
 * Source level (dB at 1 m) heard from each tier. Drones fly the quad class. Air taxi: 110 dB gives about 65 dB at
 * 500 ft, the published target for 4–5 seat eVTOLs. Personal flight: a single-seat eVTOL, assumed 6 dB quieter.
 */
export const TIER_NOISE = [AIRCRAFT.quad, { name: 'eVTOL air taxi', src: 110 }, { name: 'Single-seat personal eVTOL', src: 104 }];
/** 'nearby' reaches the 55 dB footprint, but never less than this: about a block away. */
export const NEAR_FLOOR_M = 150;
/** Horizontal distance (m) where noiseAt (spreading plus air absorption) falls to db; 0 if never that loud. */
export function heardWidth(altFt, ac, db = 55) {
  let lo = 0, hi = noiseHalfWidth(altFt, ac, db); if (noiseAt(0, altFt, ac) < db) return 0;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (noiseAt(m, altFt, ac) >= db) lo = m; else hi = m; }
  return lo;
}
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const LANE_CELL = 250, laneIdx = new WeakMap();
/** Every lane segment in metres, bucketed by 250 m cells over its bounding box. Built once per lanes array and D. */
function laneIndex(D, lanes) {
  const c = laneIdx.get(lanes); if (c && c.D === D) return c;
  const segs = [], h = new Map();
  lanes.forEach((ln, k) => {
    const xy = ln.p.map(D.proj);
    for (let i = 0; i < xy.length - 1; i++) {
      const a = xy[i], b = xy[i + 1], s = segs.push([k, a, b]) - 1;
      for (let x = Math.floor(Math.min(a[0], b[0]) / LANE_CELL); x <= Math.floor(Math.max(a[0], b[0]) / LANE_CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / LANE_CELL); y <= Math.floor(Math.max(a[1], b[1]) / LANE_CELL); y++) {
          const key = x + ',' + y; if (!h.has(key)) h.set(key, []); h.get(key).push(s);
        }
    }
  });
  const v = { D, segs, h }; laneIdx.set(lanes, v); return v;
}
/** Nearest point on segment ab to p, and its distance. */
function segNearest(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0, q = [a[0] + t * dx, a[1] + t * dy];
  return { q, d: hyp(p, q) };
}
/**
 * The nearest lane piece of every tier level within radiusM of lonlat. Returns { at, tiers: [{ tier, id, name, today,
 * levels: [{ level, dist m | null, piece index, status, statuses, nearest [lon, lat], bearing deg, dir, verdict, db, nearM }] }] }.
 * verdict: 'overhead' within the lane half-width, 'nearby' within the tier's 55 dB footprint (heardWidth, at least
 * NEAR_FLOOR_M), else 'clear'. statuses: every status of that level's pieces within the lane half-width (LANE_STATUS
 * order), else [status]. dist, piece, status, nearest, bearing, dir and db are null when nothing lies within radiusM.
 */
export function lanesNear(D, lanes, lonlat, { radiusM = 1000 } = {}) {
  const { segs, h } = laneIndex(D, lanes), p = D.proj(lonlat), best = new Map(), under = new Map(), seen = new Set();
  for (let x = Math.floor((p[0] - radiusM) / LANE_CELL); x <= Math.floor((p[0] + radiusM) / LANE_CELL); x++)
    for (let y = Math.floor((p[1] - radiusM) / LANE_CELL); y <= Math.floor((p[1] + radiusM) / LANE_CELL); y++)
      for (const s of h.get(x + ',' + y) || []) {
        if (seen.has(s)) continue; seen.add(s);
        const [k, a, b] = segs[s], ln = lanes[k], r = segNearest(p, a, b), key = ln.t + ':' + ln.l, o = best.get(key);
        if (r.d > radiusM) continue;
        if (r.d <= LANE_HALF) { if (!under.has(key)) under.set(key, new Set()); under.get(key).add(ln.s); }
        if (!o || r.d < o.d || (r.d === o.d && ln.s < lanes[o.k].s)) best.set(key, { ...r, k }); // ties go to the more flyable piece
      }
  return { at: lonlat, tiers: TIERS.map((tier, t) => ({ tier: t, id: tier.id, name: tier.name, today: tier.today, levels: tier.levels.map(level => {
    const nearM = Math.max(NEAR_FLOOR_M, heardWidth(level, TIER_NOISE[t])), key = t + ':' + level, b = best.get(key);
    if (!b) return { level, dist: null, piece: null, status: null, statuses: [], nearest: null, bearing: null, dir: null, verdict: 'clear', db: null, nearM };
    const brg = (Math.atan2(b.q[0] - p[0], b.q[1] - p[1]) * 180 / Math.PI + 360) % 360;
    const st = under.has(key) ? [...under.get(key)].sort((x, y) => x - y).map(i => LANE_STATUS[i]) : [LANE_STATUS[lanes[b.k].s]];
    return { level, dist: b.d, piece: b.k, status: LANE_STATUS[lanes[b.k].s], statuses: st, nearest: D.unproj(b.q), bearing: brg, dir: COMPASS[Math.round(brg / 45) % 8],
      verdict: b.d <= LANE_HALF ? 'overhead' : b.d <= nearM ? 'nearby' : 'clear', db: noiseAt(b.d, level, TIER_NOISE[t]), nearM };
  }) })) };
}

// ---------- Routing on the lane network ----------
/**
 * Graph of one tier's flyable lane pieces at one level. Piece ends within snapM metres join, which is how separate
 * OSM ways meet at junctions. Returns { nodes: [[x, y]], adj: Map(node → [{ to, w, piece, fwd }]) }.
 */
export function laneGraph(D, lanes, tier, level, { snapM = 150, statuses = ['open', 'atc'] } = {}) {
  const pieces = lanes.filter(ln => ln.t === tier && ln.l === level && statuses.includes(LANE_STATUS[ln.s]));
  const nodes = [], hash = new Map(), adj = new Map();
  const nodeAt = xy => {
    const k = (i, j) => i + ',' + j, ci = Math.floor(xy[0] / snapM), cj = Math.floor(xy[1] / snapM);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const n of hash.get(k(ci + di, cj + dj)) || []) if (hyp(nodes[n], xy) < snapM) return n;
    nodes.push(xy); const n = nodes.length - 1;
    if (!hash.has(k(ci, cj))) hash.set(k(ci, cj), []); hash.get(k(ci, cj)).push(n); adj.set(n, []);
    return n;
  };
  for (const ln of pieces) {
    const xy = ln.p.map(q => D.proj(q)); let w = 0; for (let i = 1; i < xy.length; i++) w += hyp(xy[i - 1], xy[i]);
    const a = nodeAt(xy[0]), b = nodeAt(xy[xy.length - 1]);
    if (a === b) continue;
    adj.get(a).push({ to: b, w, xy, fwd: true }); adj.get(b).push({ to: a, w, xy, fwd: false });
  }
  return { nodes, adj };
}

/**
 * Path from `from` to `to` ([lon, lat]) along the lane graph, entering and leaving at the nearest lane nodes.
 * Falls back to a direct line when the lanes would more than double the distance or do not connect.
 * Returns { path: [[lon, lat]], onLanesM, totalM, direct: bool }.
 */
export function routeOnLanes(D, G, from, to, { maxDetour = 2 } = {}) {
  const A = D.proj(from), B = D.proj(to), direct = hyp(A, B);
  const nearest = p => { let best = -1, d = Infinity; G.nodes.forEach((q, i) => { const e = hyp(p, q); if (e < d) { d = e; best = i; } }); return [best, d]; };
  const [s, ds] = nearest(A), [t, dt] = nearest(B);
  const straight = { path: [from, to], onLanesM: 0, totalM: direct, direct: true };
  if (s < 0 || t < 0 || s === t) return straight;
  const dist = new Map([[s, 0]]), prev = new Map(), done = new Set(), heap = [[0, s]];
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0]);
    const [d, n] = heap.shift();
    if (done.has(n)) continue; done.add(n);
    if (n === t) break;
    for (const e of G.adj.get(n)) { const nd = d + e.w; if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { n, e }); heap.push([nd, e.to]); } }
  }
  if (!dist.has(t)) return straight;
  const total = ds + dist.get(t) + dt;
  if (total > direct * maxDetour) return straight;
  const legs = [];
  for (let n = t; n !== s;) { const { n: p, e } = prev.get(n); legs.unshift(e.fwd ? e.xy : e.xy.slice().reverse()); n = p; }
  const xy = [A, ...legs.flatMap((l, i) => (i ? l.slice(1) : l)), B];
  return { path: xy.map(D.unproj), onLanesM: dist.get(t), totalM: total, direct: false };
}

// ---------- Fast checks for many routes (fleet simulation) ----------
/**
 * The subset of scoreRoute a dispatcher needs, about 50× cheaper: clearance against buildings and obstacles,
 * the lowest LAANC ceiling, the drop point's FAA category, mean density under the path and length.
 */
export function quickCheck(D, route, altFt, { stepM = 25, tod = 'day', ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt }, pts = route.map(p => D.proj(p)), alts = waypointAlts(route, altFt);
  let lenM = 0, blocked = 0, minCeiling = null, dSum = 0, n = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = hyp(a, b), steps = Math.max(1, Math.ceil(L / stepM));
    for (let s = 0; s <= steps; s++) {
      const xy = [a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps], alt = alts[i] + (alts[i + 1] - alts[i]) * s / steps;
      if (isBlocked(D, xy, alt, o)) blocked++;
      const c = facilityCeiling(D, xy); if (c != null) minCeiling = Math.min(minCeiling ?? Infinity, c);
      dSum += density(D, xy, tod); n++;
    }
    lenM += L;
  }
  const end = pts[pts.length - 1];
  return { lenM, blocked, minCeiling, dropCat: faaCategory(D, end) ?? catFromDensity(density(D, end, tod)), meanD: n ? dSum / n : 0, dropWater: isWater(D, end) };
}
