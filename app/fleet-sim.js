// Warehouse drone-delivery simulation. Pure and deterministic for a given seed, so it runs in node tests.
// Orders arrive at real homes (census residents), every order is checked with the engine, feasible ones queue for
// the next free drone, and each flight is recorded for playback.
import { AIRCRAFT, FT, rng, quickCheck, planClimb, planAround, MAX_ALT_FT, DEFAULTS } from './engine.js';

export const RANGE_KM = { quad: 16, fixed: 40, heavy: 10 }; // round-trip range on one battery, by aircraft class
export const REASONS = {
  range: 'Beyond round-trip range',
  cat5: 'Drop point on Category 5 ground',
  water: 'Drop point in water',
  noauth: 'No automatic airspace approval',
  noclear: 'No clear path at a legal level',
  stadium: 'Stadium TFR active',
  busy: 'Fleet busy past the delivery promise',
};

export const DEFAULT_PARAMS = {
  warehouse: [-122.3335, 47.5745], fleet: 12, ordersPerHour: 60, hours: 4, radiusKm: 6, aircraft: 'quad', altFt: 300,
  loadS: 90, dropS: 45, turnS: 150, climbMs: 3, promiseMin: 60, seed: 11, startHour: 10,
};

/** Home locations near the warehouse, weighted by census residents (the people who order to their door). Needs simBox's tiles loaded. */
function homes(D, W, radiusM) {
  const g = D.grid, c = D.proj(W), cells = [], cum = [];
  let total = 0;
  const tiles = [...g.loaded.values()].sort((a, b) => a.tj - b.tj || a.ti - b.ti); // fixed order keeps runs deterministic
  for (const t of tiles) for (let j = 0; j < t.h; j++) for (let i = 0; i < t.w; i++) {
    const k = j * t.w + i;
    if (t.state[k] !== 0 || !t.residents[k]) continue;
    const ll = [g.west + (t.ti * g.tile + i + 0.5) * g.dlon, g.south + (t.tj * g.tile + j + 0.5) * g.dlat], xy = D.proj(ll);
    if (Math.hypot(xy[0] - c[0], xy[1] - c[1]) > radiusM) continue;
    total += t.residents[k]; cells.push(ll); cum.push(total);
  }
  return { cells, cum, total };
}

/** The box whose grid tiles a simulation needs: the service radius plus room for reroutes and footprints. */
export function simBox(D, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }, c = D.proj(p.warehouse), r = p.radiusKm * 1000 + 1500;
  const [w, s] = D.unproj([c[0] - r, c[1] - r]), [e, n] = D.unproj([c[0] + r, c[1] + r]);
  return [w, s, e, n];
}

export function simulate(D, params = {}, { events = [] } = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }, rnd = rng(p.seed), ac = AIRCRAFT[p.aircraft];
  const H = homes(D, p.warehouse, p.radiusKm * 1000);
  const t0 = new Date(2026, 9, 22, p.startHour).getTime(); // wall clock for the TFR check; any weekday works
  const orders = [];
  // Poisson arrivals over the window
  for (let t = 0; ;) {
    t += -Math.log(1 - rnd()) * 3600 / p.ordersPerHour;
    if (t > p.hours * 3600 || !H.total) break;
    const x = rnd() * H.total; let lo = 0, hi = H.cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (H.cum[m] < x) lo = m + 1; else hi = m; }
    const [lon, lat] = H.cells[lo];
    orders.push({ id: orders.length + 1, t, at: [lon + (rnd() - 0.5) * D.grid.dlon, lat + (rnd() - 0.5) * D.grid.dlat] });
  }

  // Feasibility: the same rules as the planner, cheapest checks first.
  const vspeed = () => (2 * p.altFt / FT) / p.climbMs; // climb plus descent, seconds
  for (const o of orders) {
    let route = [[...p.warehouse, p.altFt], [...o.at, p.altFt]];
    let q = quickCheck(D, route, p.altFt);
    const wall = new Date(t0 + o.t * 1000);
    if (2 * q.lenM / 1000 > RANGE_KM[p.aircraft]) { o.refused = 'range'; continue; }
    if (q.dropWater) { o.refused = 'water'; continue; }
    if (q.dropCat === 5) { o.refused = 'cat5'; continue; }
    if (events.some(e => wall >= e.tfrStart && wall <= e.tfrEnd)) {
      // a game is on: refuse drops inside 3 NM of that stadium
      const near = events.filter(e => wall >= e.tfrStart && wall <= e.tfrEnd).some(e => {
        const st = D.sites.find(s => s.kind === 'stadium' && s.name.includes(e.stadium));
        return st && Math.hypot(D.proj(o.at)[0] - st.xy[0], D.proj(o.at)[1] - st.xy[1]) < 5556;
      });
      if (near) { o.refused = 'stadium'; continue; }
    }
    let alt = p.altFt;
    if (q.minCeiling != null && q.minCeiling < alt) {
      if (q.minCeiling < 100) { o.refused = 'noauth'; continue; }
      alt = q.minCeiling; route = route.map(r => [r[0], r[1], alt]); q = quickCheck(D, route, alt); o.lowered = alt;
    }
    if (q.blocked) {
      const up = planClimb(D, route, { altFt: alt });
      const upCap = Math.min(MAX_ALT_FT, q.minCeiling ?? MAX_ALT_FT);
      if (!up.stuck.length && up.route.every(r => r[2] <= upCap)) { route = up.route; o.fix = 'climb'; }
      else {
        const ar = planAround(D, route, { altFt: alt });
        if (ar.failed.length) { o.refused = 'noclear'; continue; }
        route = ar.route; o.fix = 'around';
      }
      q = quickCheck(D, route, alt);
      if (q.blocked) { o.refused = 'noclear'; continue; }
      if (2 * q.lenM / 1000 > RANGE_KM[p.aircraft]) { o.refused = 'range'; continue; }
    }
    o.route = route; o.lenM = q.lenM; o.meanD = q.meanD;
    o.flyS = q.lenM / ac.spd + vspeed();
  }

  // Dispatch: first come, first served, to the drone that frees up first.
  const free = Array.from({ length: p.fleet }, () => 0), flights = [];
  let km = 0, ec = 0;
  for (const o of orders) {
    if (o.refused) continue;
    let d = 0; for (let i = 1; i < free.length; i++) if (free[i] < free[d]) d = i;
    const start = Math.max(o.t, free[d]) + p.loadS, door = start + o.flyS, back = door + p.dropS + o.flyS, ready = back + p.turnS;
    if ((door - o.t) / 60 > p.promiseMin) { o.refused = 'busy'; continue; }
    free[d] = ready;
    o.drone = d; o.start = start; o.door = door; o.back = back;
    flights.push({ drone: d, order: o.id, out: [start, door], ret: [door + p.dropS, back], route: o.route });
    km += 2 * o.lenM / 1000;
    ec += DEFAULTS.failRatePerFh * ac.lethalAreaM2 * o.meanD / 1e6 * (2 * o.flyS / 3600);
  }
  return { params: p, orders, flights, metrics: metrics(orders, flights, p, km, ec) };
}

function metrics(orders, flights, p, km, ec) {
  const done = orders.filter(o => o.door != null), waits = done.map(o => (o.door - o.t) / 60).sort((a, b) => a - b);
  const q = f => waits.length ? waits[Math.min(waits.length - 1, Math.floor(f * waits.length))] : null;
  const refused = {}; for (const o of orders) if (o.refused) refused[o.refused] = (refused[o.refused] || 0) + 1;
  // Fleet busy share: sum of each drone's load-to-ready time over fleet × window
  const busy = flights.reduce((a, f) => a + (f.ret[1] + p.turnS - (f.out[0] - p.loadS)), 0);
  const end = p.hours * 3600, step = 900, buckets = [];
  for (let t = 0; t < end; t += step) {
    const at = t + step;
    buckets.push({
      t: at,
      orders: orders.filter(o => o.t >= t && o.t < at).length,
      delivered: done.filter(o => o.door >= t && o.door < at).length,
      waiting: orders.filter(o => !o.refused && o.t <= at && o.door > at).length,
    });
  }
  return {
    orders: orders.length, delivered: done.length, refused, refusedTotal: orders.length - done.length,
    rerouted: done.filter(o => o.fix).length, lowered: done.filter(o => o.lowered).length,
    medianMin: q(0.5), p90Min: q(0.9), busyShare: Math.min(1, busy / (p.fleet * end)), km,
    fatalitiesPerMillion: done.length ? ec / done.length * 1e6 : 0, buckets,
  };
}

/** Where drone `f` is at sim time t, as [lon, lat, z], or null when it is on the pad. */
export function dronePos(D, f, t, altFt) {
  const leg = t >= f.out[0] && t <= f.out[1] ? 'out' : t >= f.ret[0] && t <= f.ret[1] ? 'ret' : null;
  if (!leg) return null;
  const [a, b] = leg === 'out' ? f.out : f.ret, u = (t - a) / (b - a);
  const pts = leg === 'out' ? f.route : f.route.slice().reverse();
  const xy = pts.map(q => D.proj(q)), cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const s = u * cum[cum.length - 1]; let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const f2 = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  const z = Math.min(1, Math.min(u, 1 - u) * 8) * (pts[i][2] ?? altFt) / FT; // climb out of and down into the pads
  return [...D.unproj([xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * f2, xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * f2]), z];
}
