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

export function prepare({ grid, obstacles, powerlines, sites, airspace, manifest, buildings = [] }) {
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
    facility: polys(airspace.facility_map),
    surface: polys(airspace.surface_areas),
    opcats: polys(airspace.operating_categories),
    classB: polys(airspace.class_b || []),
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
    state: decode(t.state, Uint8Array), faacat: decode(t.faacat, Uint8Array), ceiling: decode(t.ceiling, Uint16Array) });
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
export function density(D, xy, tod = 'day') {
  const g = D.grid, m = TOD[tod], [lon, lat] = D.unproj(xy);
  const i0 = Math.floor((lon - g.west) / g.dlon), j0 = Math.floor((lat - g.south) / g.dlat);
  let sum = 0, n = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const c = cellAt(D, i0 + di, j0 + dj);
    if (c.state === 0) { sum += m.res * c.t.residents[c.k] + m.jobs * c.t.jobs[c.k]; n++; }
    else if (c.state === 1) n++; // water counts as empty; missing data does not count at all
  }
  let v = n ? sum / n : 0;
  if (m.crowd) for (const s of D.sites) if (s.kind === 'stadium' && s.tfr) {
    const d = hyp(xy, s.xy);
    if (d < CROWD_R) v += CROWD / (Math.PI * (CROWD_R / 1000) ** 2) * (1 - d / CROWD_R);
  }
  return v;
}
export const isWater = (D, xy) => cellOf(D, xy).state === 1;

/** FAA Operating Categories Map category at xy (rasterized to the grid; highest polygon wins), or null outside its coverage. */
export function faaCategory(D, xy) { const c = cellOf(D, xy); return c.t && c.t.faacat[c.k] ? c.t.faacat[c.k] : null; }
/** UAS facility map ceiling (ft AGL) at xy, or null outside controlled airspace grids. */
export function facilityCeiling(D, xy) { const c = cellOf(D, xy); return c.t && c.t.ceiling[c.k] !== 65535 ? c.t.ceiling[c.k] : null; }

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
export const DEFAULTS = { failRatePerFh: 1e-4, sampleM: 25, footEveryM: 100, footN: 40, obstacleLateralM: 60, clearM: 30, obstacleVertFt: 50, buildingHitM: 10, powerlineM: 30, powerlineMaxFt: 250, heliportM: 800, denseKm2: 5000 };

/** Altitude (ft AGL) of each waypoint: its own third coordinate, else the route default. */
export const waypointAlts = (route, altFt) => route.map(p => (p.length > 2 && Number.isFinite(p[2]) ? p[2] : altFt));

/**
 * Tallest building or obstacle (ft) within `r` metres of xy. The clearance rule used everywhere: a drone must keep
 * clearM (30 m) sideways from anything that rises to within obstacleVertFt (50 ft) of its altitude.
 */
function tallestNear(D, xy, r) {
  index(D);
  let h = 0;
  for (const b of nearby(D._bh, xy, r)) if (b.h_ft > h && distToBuilding(xy, b) < r) h = b.h_ft;
  for (const ob of nearby(D._oh, xy, r)) if (ob.agl_ft > h && hyp(xy, ob.xy) < r) h = ob.agl_ft;
  return h;
}
const isBlocked = (D, xy, alt, o, r = o.clearM) => tallestNear(D, xy, r) > alt - o.obstacleVertFt;

/**
 * Live constraints: stadium game windows ({ stadium, title, tfrStart, tfrEnd }) and TFRs ({ id, ring, effective, expire, lower_ft, upper_ft }).
 * `when` is the planned departure; both lists are optional and the score is unchanged without them.
 */
export function scoreRoute(D, route, { aircraft = 'quad', altFt = 300, wind = WIND_PRESETS.typical, tod = 'day', events = null, tfrs = [], when = new Date(), ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt }, ac = typeof aircraft === 'string' ? AIRCRAFT[aircraft] : aircraft;
  index(D);
  const pts = route.map(p => D.proj(p)), alts = waypointAlts(route, altFt), rnd = rng(99);
  const samples = [], foot = [], footFrom = [], obst = new Map(), bld = new Map(), lines = new Map(), air = new Map(), noise = { hospital: 0, school: 0 };
  let lenM = 0, nextFoot = 0, overSum = 0, hi = 0, waterLandings = 0;
  const near = new Map();
  const tfrPolys = (tfrs || []).filter(t => t.ring?.length > 3).map(t => { const rings = [[t.ring.map(D.proj)]]; return { t, rings, bbox: bboxOf(rings) }; });
  const sampleAt = (xy, along, alt) => {
    const d = density(D, xy, tod), fc = faaCategory(D, xy);
    const cov = coverage(D, xy);
    return { xy, ll: D.unproj(xy), along, alt, d, c: fc ?? catFromDensity(d), faa: fc != null, ceiling: facilityCeiling(D, xy), water: cov === 'water',
      blocked: isBlocked(D, xy, alt, o), noData: cov === 'nodata' || cov === 'unloaded' };
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
      for (const T of tfrPolys) if (alt >= (T.t.lower_ft ?? 0) && alt <= (T.t.upper_ft ?? Infinity) && inPolys(xy[0], xy[1], T)) {
        const active = (!T.t.effective || when >= new Date(T.t.effective)) && (!T.t.expire || when <= new Date(T.t.expire));
        air.set(`TFR ${T.t.id}`, { kind: 'tfr', tfr: T.t, conditional: !active, active });
      }
      if (along >= nextFoot) {
        nextFoot += o.footEveryM;
        for (const p of footprint(xy, alt, ac, wind, o.footN, rnd)) {
          const pd = density(D, p, tod); foot.push(p); footFrom.push([xy, alt]); overSum += pd;
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
    ac, altFt, alts, altMin, altMax, levelled: altMin !== altMax, wind, tod, opt: o, samples, foot, footFrom, lenM, minutes: hours * 60, maxCat,
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
  };
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
  if (r.wind.kt >= 20) f.push(['warn', `${r.wind.kt} kt wind: failure drift up to ${Math.round(r.wind.kt * 0.5144 * 1.5 * (r.altMax / FT / r.ac.descent))} m downwind. Set a wind limit in the operations manual.`]);
  if (r.noise.hospital) f.push(['warn', `${Math.round(r.noise.hospital)} dB at a hospital, above a 55 dB daytime target.`]);
  if (r.noise.school && r.tod !== 'night') f.push(['warn', `${Math.round(r.noise.school)} dB at ${r.noiseSites.filter(s => s.kind === 'school').length} school${r.noiseSites.filter(s => s.kind === 'school').length > 1 ? 's' : ''} during school hours.`]);
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
