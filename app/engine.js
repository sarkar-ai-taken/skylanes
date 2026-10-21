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

export function prepare({ grid, obstacles, powerlines, sites, airspace, manifest }) {
  const [W, S, E, N] = manifest.bbox;
  const lat0 = (S + N) / 2, lon0 = (W + E) / 2;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180), mLat = 110574;
  const proj = ([lon, lat]) => [(lon - lon0) * mLon, (lat - lat0) * mLat];
  const unproj = ([x, y]) => [x / mLon + lon0, y / mLat + lat0];
  const g = { ...grid, residents: decode(grid.residents, Uint32Array), jobs: decode(grid.jobs, Uint32Array), water: decode(grid.water, Uint8Array), faacat: decode(grid.faacat, Uint8Array), ceiling: decode(grid.ceiling, Uint16Array) };
  const projPoly = geom => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).map(p => p.map(r => r.map(proj)));
  const polys = fs => fs.map(f => ({ props: f.properties, rings: projPoly(f.geometry), bbox: bboxOf(projPoly(f.geometry)) }));
  return {
    manifest, proj, unproj, grid: g,
    obstacles: obstacles.map(o => ({ ...o, xy: proj([o.lon, o.lat]) })),
    powerlines: powerlines.features.map(f => ({ props: f.properties, xy: f.geometry.coordinates.map(proj) })),
    sites: sites.map(s => ({ ...s, xy: proj([s.lon, s.lat]) })),
    facility: polys(airspace.facility_map),
    surface: polys(airspace.surface_areas),
    opcats: polys(airspace.operating_categories),
  };
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
function cellIndex(D, xy) {
  const [lon, lat] = D.unproj(xy), g = D.grid;
  const i = Math.floor((lon - g.west) / g.dlon), j = Math.floor((lat - g.south) / g.dlat);
  return i < 0 || j < 0 || i >= g.nx || j >= g.ny ? -1 : j * g.nx + i;
}

/** People per km² on the ground at xy: 3×3-cell (300 m) mean of the 100 m grid, so one tall block does not set the category. */
export function density(D, xy, tod = 'day') {
  const g = D.grid, m = TOD[tod], k = cellIndex(D, xy);
  if (k < 0) return 0;
  let sum = 0, n = 0;
  const i0 = k % g.nx, j0 = (k - i0) / g.nx;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
    const q = j * g.nx + i;
    sum += g.water[q] ? 0 : m.res * g.residents[q] + m.jobs * g.jobs[q];
    n++;
  }
  let v = sum / n;
  if (m.crowd) for (const s of D.sites) if (s.kind === 'stadium' && s.tfr) {
    const d = hyp(xy, s.xy);
    if (d < CROWD_R) v += CROWD / (Math.PI * (CROWD_R / 1000) ** 2) * (1 - d / CROWD_R);
  }
  return v;
}
export const isWater = (D, xy) => { const k = cellIndex(D, xy); return k < 0 || D.grid.water[k] === 1; };

/** FAA Operating Categories Map category at xy (rasterized to the grid; highest polygon wins), or null outside its coverage. */
export function faaCategory(D, xy) { const k = cellIndex(D, xy); return k < 0 || !D.grid.faacat[k] ? null : D.grid.faacat[k]; }
/** UAS facility map ceiling (ft AGL) at xy, or null outside controlled airspace grids. */
export function facilityCeiling(D, xy) { const k = cellIndex(D, xy); return k < 0 || D.grid.ceiling[k] === 65535 ? null : D.grid.ceiling[k]; }

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
export const DEFAULTS = { failRatePerFh: 1e-4, sampleM: 25, footEveryM: 100, footN: 40, obstacleLateralM: 60, obstacleVertFt: 50, powerlineM: 30, powerlineMaxFt: 250, heliportM: 800, denseKm2: 5000 };

export function scoreRoute(D, route, { aircraft = 'quad', altFt = 300, wind = WIND_PRESETS.typical, tod = 'day', ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt }, ac = typeof aircraft === 'string' ? AIRCRAFT[aircraft] : aircraft;
  const pts = route.map(D.proj), rnd = rng(99);
  const samples = [], foot = [], obst = new Map(), lines = new Map(), air = new Map(), noise = { hospital: 0, school: 0 };
  let lenM = 0, nextFoot = 0, overSum = 0, hi = 0, waterLandings = 0;
  const near = new Map();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = hyp(a, b), steps = Math.max(1, Math.ceil(L / o.sampleM));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, xy = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], along = lenM + L * t;
      const d = density(D, xy, tod), fc = faaCategory(D, xy), c = fc ?? catFromDensity(d);
      const ceiling = facilityCeiling(D, xy);
      samples.push({ xy, ll: D.unproj(xy), along, d, c, faa: fc != null, ceiling, water: isWater(D, xy) });
      for (const ob of D.obstacles) if (hyp(xy, ob.xy) < o.obstacleLateralM && ob.agl_ft > altFt - o.obstacleVertFt) obst.set(ob.id, ob);
      for (const pl of D.powerlines) if (altFt < o.powerlineMaxFt) for (let k = 0; k < pl.xy.length - 1; k++)
        if (segDist(xy, pl.xy[k], pl.xy[k + 1]) < o.powerlineM) { lines.set(pl, along); break; }
      for (const st of D.sites) {
        const dm = hyp(xy, st.xy);
        if (st.kind === 'hospital' || st.kind === 'school') { const db = noiseAt(dm, altFt, ac); if (db > 55) noise[st.kind] = Math.max(noise[st.kind], db); if (db > 55) near.set(st, Math.max(near.get(st) || 0, db)); }
        if (st.kind === 'heliport' && dm < o.heliportM) air.set(`Heliport ${st.name}`, { kind: 'heliport', site: st, dm: Math.min(dm, air.get(`Heliport ${st.name}`)?.dm ?? Infinity) });
        if (st.kind === 'airport' && dm < 3000) air.set(`Airport ${st.name}`, { kind: 'airport', site: st, dm });
        if (st.kind === 'stadium' && st.tfr && dm < STADIUM_TFR_M) air.set(`Stadium TFR ${st.name}`, { kind: 'stadium', site: st, dm, conditional: tod !== 'event' });
      }
      for (const P of D.surface) if (inPolys(xy[0], xy[1], P)) air.set(`${P.props.name}`, { kind: 'surface', cls: P.props.class });
      if (along >= nextFoot) {
        nextFoot += o.footEveryM;
        for (const p of footprint(xy, altFt, ac, wind, o.footN, rnd)) {
          const pd = density(D, p, tod); foot.push(p); overSum += pd;
          if (pd >= o.denseKm2) hi++;
          if (isWater(D, p)) waterLandings++;
        }
      }
    }
    lenM += L;
  }
  if (pts.length > 1) { const xy = pts[pts.length - 1]; const d = density(D, xy, tod), fc = faaCategory(D, xy); samples.push({ xy, ll: D.unproj(xy), along: lenM, d, c: fc ?? catFromDensity(d), faa: fc != null, ceiling: facilityCeiling(D, xy), water: isWater(D, xy) }); }
  if (samples.length < 2) return null;

  const maxCat = Math.max(...samples.map(s => s.c));
  const meanUnder = foot.length ? overSum / foot.length : 0;
  const hours = lenM / ac.spd / 3600;
  // Expected ground fatalities per flight hour: failure rate × lethal area × people per m² under the footprint.
  const ecPerFh = o.failRatePerFh * ac.lethalAreaM2 * meanUnder / 1e6;
  const laanc = samples.filter(s => s.ceiling != null);
  const overCeiling = laanc.filter(s => altFt > s.ceiling);
  return {
    ac, altFt, wind, tod, opt: o, samples, foot, lenM, minutes: hours * 60, maxCat,
    meanD: samples.reduce((a, s) => a + s.d, 0) / samples.length, peakD: Math.max(...samples.map(s => s.d)),
    faaShare: samples.filter(s => s.faa).length / samples.length,
    hiFrac: foot.length ? hi / foot.length : 0, waterFrac: foot.length ? waterLandings / foot.length : 0, meanUnder, ecPerFh, ecPerFlight: ecPerFh * hours,
    obstacles: [...obst.values()].sort((a, b) => b.agl_ft - a.agl_ft), powerlines: [...lines.keys()].map(pl => pl.props),
    airspace: [...air.entries()].map(([name, v]) => ({ name, ...v })), noise, noiseSites: [...near.entries()].map(([s, db]) => ({ name: s.name, kind: s.kind, db })).sort((a, b) => b.db - a.db),
    laancShare: laanc.length / samples.length, minCeiling: laanc.length ? Math.min(...laanc.map(s => s.ceiling)) : null, overCeilingShare: overCeiling.length / samples.length,
    halfWidth55: noiseHalfWidth(altFt, ac),
  };
}

// ---------- Findings ----------
export function findings(r) {
  const f = [];
  const pct = x => Math.round(x * 100) + '%';
  const share = c => pct(r.samples.filter(s => s.c >= c).length / r.samples.length);
  if (r.maxCat === 5) f.push(['crit', `${share(5)} of the route crosses Category 5 ground, the densest class on the FAA operating categories map. Expect the heaviest safety case; reroute if the destination allows.`]);
  else if (r.maxCat === 4) f.push(['warn', `${share(4)} of the route crosses Category 4 ground on the FAA operating categories map. Most of residential Seattle is Category 4, so this is the normal case for urban delivery; the safety case must carry it.`]);
  else if (r.maxCat === 3) f.push(['warn', 'Category 3 segments present.']);
  else f.push(['good', 'Entire route stays in Category 1–2 ground.']);
  const hard = r.obstacles.filter(o => o.agl_ft >= r.altFt);
  if (hard.length) f.push(['crit', `${hard.length} obstacle${hard.length > 1 ? 's' : ''} within ${r.opt.obstacleLateralM} m lateral reach or exceed ${r.altFt} ft AGL, tallest ${hard[0].agl_ft} ft (${hard[0].name || hard[0].kind}, ${hard[0].src}). Hard conflict.`]);
  else if (r.obstacles.length) f.push(['warn', `${r.obstacles.length} obstacles within ${r.opt.obstacleLateralM} m rise to within ${r.opt.obstacleVertFt} ft of planned altitude.`]);
  const cranes = r.obstacles.filter(o => o.temporary);
  if (cranes.length) f.push(['warn', `${cranes.length} construction crane${cranes.length > 1 ? 's' : ''} mapped near the route. Cranes move; check FAA construction notices before each operation.`]);
  if (r.powerlines.length) f.push(['warn', `Route crosses or runs within ${r.opt.powerlineM} m of ${r.powerlines.length} mapped transmission line${r.powerlines.length > 1 ? 's' : ''} below ${r.opt.powerlineMaxFt} ft. Distribution lines are not in the public data.`]);
  if (r.overCeilingShare > 0) f.push(['crit', `${pct(r.overCeilingShare)} of the route is inside a UAS facility map grid with a ceiling below ${r.altFt} ft (lowest ${r.minCeiling} ft). Needs a LAANC further-coordination request or an airspace authorization.`]);
  else if (r.laancShare > 0) f.push(['warn', `${pct(r.laancShare)} of the route is in controlled airspace; LAANC authorization required up to the grid ceiling (lowest ${r.minCeiling} ft).`]);
  for (const a of r.airspace) {
    if (a.kind === 'heliport') f.push(['crit', `${a.name} is ${Math.round(a.dm)} m from the route. Coordinate with the heliport operator; letter of agreement expected.`]);
    if (a.kind === 'airport') f.push(['crit', `${a.name} within 3 km.`]);
    if (a.kind === 'surface') f.push(['crit', `Route enters the ${a.name} surface area (Class ${a.cls}).`]);
    if (a.kind === 'stadium') f.push([a.conditional ? 'warn' : 'crit', `${a.site.name} is ${(a.dm / 1852).toFixed(1)} NM away: inside the 3 NM stadium TFR${a.conditional ? ' on event days' : ''}. No flight from 1 h before to 1 h after events.`]);
  }
  const dense = `ground above ${r.opt.denseKm2.toLocaleString()} people/km²`;
  if (r.hiFrac > 0.25) f.push(['crit', `${pct(r.hiFrac)} of simulated failure landings fall on ${dense}. ${r.ac.chute ? 'The parachute lowers impact energy but widens drift under this wind.' : 'A parachute system would lower impact energy.'}`]);
  else if (r.hiFrac > 0.05) f.push(['warn', `${pct(r.hiFrac)} of simulated failure landings fall on ${dense}.`]);
  if (r.waterFrac > 0.2) f.push(['good', `${pct(r.waterFrac)} of simulated failure landings fall in water.`]);
  if (r.ecPerFh > 1e-6) f.push(['warn', `Estimated ${r.ecPerFh.toExponential(1)} ground fatalities per flight hour at the assumed failure rate, above the 1e-6 target often used in ground-risk assessments.`]);
  if (r.wind.kt >= 20) f.push(['warn', `${r.wind.kt} kt wind: failure drift up to ${Math.round(r.wind.kt * 0.5144 * 1.5 * (r.altFt / FT / r.ac.descent))} m downwind. Set a wind limit in the operations manual.`]);
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
