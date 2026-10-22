// "Is my home under a lane?": lanesNear against the real lane network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, lanesNear, heardWidth, noiseAt, TIERS, TIER_NOISE, LANE_STATUS, LANE_HALF, NEAR_FLOOR_M } from '../app/engine.js';
import { LANE_HALF as RIDE_HALF } from '../app/ride-sim.js';

const load = n => JSON.parse(readFileSync(new URL(`../app/data/${n}.json`, import.meta.url)));
const lanes = load('lanes'), D = prepare({ manifest: load('manifest') });
const lv = (R, t, l) => R.tiers[t].levels.find(x => x.level === l);

/** Brute force over every segment: nearest distance from ll to tier t at level l, the pieces at it, and the runner-up. */
function bruteAll(ll, t, l) {
  const p = D.proj(ll), ds = [];
  lanes.forEach((ln, j) => { if (ln.t === t && ln.l === l) for (let i = 0; i < ln.p.length - 1; i++) {
    const a = D.proj(ln.p[i]), b = D.proj(ln.p[i + 1]), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const k = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    ds.push([Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy), j]);
  } });
  ds.sort((x, y) => x[0] - y[0]);
  const d = ds[0][0], other = ds.find(x => lanes[x[1]] !== lanes[ds[0][1]]);
  return { d, piece: ds[0][1], gap: other ? other[0] - d : Infinity };
}
const brute = (ll, t, l) => bruteAll(ll, t, l).d;

test('the lane half-width is defined once and the ride keeps its export', () => {
  assert.equal(LANE_HALF, 40); assert.equal(RIDE_HALF, LANE_HALF);
});

test('a point on a drone-lane piece is overhead at distance ~0', () => {
  const pc = lanes.find(ln => ln.t === 0 && ln.l === 250 && ln.p.length >= 2 && ln.s === 0);
  const [a, b] = pc.p, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const e = lv(lanesNear(D, lanes, mid), 0, 250);
  assert.equal(e.verdict, 'overhead');
  assert.ok(e.dist < 1, `dist ${e.dist}`);
  assert.equal(e.status, 'open');
  // 20 m off the centreline is still under the 80 m lane
  const [x, y] = D.proj(mid), off = lv(lanesNear(D, lanes, D.unproj([x + 20, y])), 0, 250);
  assert.equal(off.verdict, 'overhead');
});

test('the middle of Lake Washington is clear of every lane, with a real distance', () => {
  const R = lanesNear(D, lanes, [-122.26, 47.62], { radiusM: 5000 });
  for (const T of R.tiers) for (const e of T.levels) {
    assert.equal(e.verdict, 'clear', `${T.id} ${e.level}`);
    assert.ok(e.dist > NEAR_FLOOR_M && Number.isFinite(e.dist), `${T.id} ${e.level} ${e.dist}`);
  }
});

test('outside the search radius a level comes back clear with nulls, not NaN', () => {
  const e = lv(lanesNear(D, lanes, [-122.26, 47.62], { radiusM: 200 }), 0, 250);
  assert.deepEqual([e.verdict, e.dist, e.status, e.nearest], ['clear', null, null, null]);
});

test('indexed distances match brute force over every piece', () => {
  for (const ll of [[-122.3443, 47.68], [-122.3305, 47.6045], [-122.2525, 47.553], [-122.20, 47.61], [-122.44, 47.25], [-122.20, 47.98]]) {
    const R = lanesNear(D, lanes, ll, { radiusM: 8000 });
    TIERS.forEach((T, t) => T.levels.forEach(l => {
      const want = brute(ll, t, l), got = lv(R, t, l).dist;
      if (want > 8000) assert.equal(got, null);
      else assert.ok(Math.abs(got - want) < 1e-6, `${ll} ${T.id} ${l}: ${got} vs ${want}`);
    }));
  }
});

test('result shape: every tier and level, valid fields, no NaN', () => {
  const R = lanesNear(D, lanes, [-122.3443, 47.68], { radiusM: 3000 });
  assert.equal(R.tiers.length, TIERS.length);
  const walk = v => { if (typeof v === 'number') assert.ok(!Number.isNaN(v)); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(R);
  for (const T of R.tiers) {
    assert.deepEqual(T.levels.map(e => e.level), TIERS[T.tier].levels);
    for (const e of T.levels) {
      assert.ok(['overhead', 'nearby', 'clear'].includes(e.verdict));
      assert.ok(e.nearM >= NEAR_FLOOR_M);
      if (e.dist == null) continue;
      assert.ok(LANE_STATUS.includes(e.status));
      assert.ok(e.bearing >= 0 && e.bearing < 360 && typeof e.dir === 'string');
      assert.ok(Math.abs(D.proj(e.nearest)[0] - D.proj(lanes[e.piece].p[0])[0]) < 50000);
      assert.equal(e.verdict, e.dist <= LANE_HALF ? 'overhead' : e.dist <= e.nearM ? 'nearby' : 'clear');
    }
  }
  // Aurora Ave runs about 70 m west of this point: a nearby drone lane, a louder air-taxi band
  const d = lv(R, 0, 250);
  assert.equal(d.verdict, 'nearby'); assert.match(d.dir, /west/);
  assert.ok(lv(R, 1, 800).nearM > 300, 'air-taxi 55 dB band is hundreds of metres wide');
});

test('indexed lookup matches brute force at small and large radii, piece and status included', () => {
  // points jittered within ~300 m of drone-lane vertices, plus the middle of the longest segment
  let long = null, Lmax = 0;
  lanes.forEach(ln => { if (ln.t === 0) for (let i = 0; i < ln.p.length - 1; i++) { const a = D.proj(ln.p[i]), b = D.proj(ln.p[i + 1]), L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > Lmax) { Lmax = L; long = [ln, a, b]; } } });
  const [lnL, a, b] = long, pts = [D.unproj([(a[0] + b[0]) / 2 + 15, (a[1] + b[1]) / 2])];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const drones = lanes.filter(ln => ln.t === 0);
  for (let i = 0; i < 12; i++) { const ln = drones[Math.floor(rnd() * drones.length)], [x, y] = D.proj(ln.p[0]); pts.push(D.unproj([x + (rnd() - 0.5) * 600, y + (rnd() - 0.5) * 600])); }
  for (const r of [30, 100, 250, 1000, 8000]) for (const ll of pts) {
    const R = lanesNear(D, lanes, ll, { radiusM: r });
    for (const l of TIERS[0].levels) {
      const want = bruteAll(ll, 0, l), got = lv(R, 0, l);
      if (want.d > r) { assert.equal(got.dist, null, `r ${r} ${ll}`); continue; }
      assert.ok(Math.abs(got.dist - want.d) < 1e-6, `r ${r} ${ll} ${l}: ${got.dist} vs ${want.d}`);
      if (want.gap > 1e-3) { assert.equal(got.piece, want.piece); assert.equal(got.status, LANE_STATUS[lanes[want.piece].s]); }
    }
  }
  assert.equal(lv(lanesNear(D, lanes, pts[0], { radiusM: 60 }), 0, lnL.l).verdict, 'overhead', 'mid-way along the longest segment');
});

test('the nearby band ends where the noise figure itself drops to 55 dB', () => {
  for (let t = 0; t < TIERS.length; t++) for (const l of TIERS[t].levels) {
    const w = heardWidth(l, TIER_NOISE[t]);
    if (w > 0) assert.ok(Math.abs(noiseAt(w, l, TIER_NOISE[t]) - 55) < 0.01, `${t} ${l}`);
    else assert.ok(noiseAt(0, l, TIER_NOISE[t]) < 55);
    const e = lv(lanesNear(D, lanes, [-122.3443, 47.68], { radiusM: 3000 }), t, l);
    assert.equal(e.nearM, Math.max(NEAR_FLOOR_M, w));
    if (e.nearM > NEAR_FLOOR_M && e.verdict === 'nearby') assert.ok(e.db >= 55 - 1e-9, `${t} ${l} ${e.db}`);
  }
});

test('overhead at a junction lists every status passing over, ties going to the more flyable piece', () => {
  let found = 0;
  for (let j = 0; j < lanes.length && found < 20; j += 7) {
    const ln = lanes[j]; if (ln.t !== 0) continue;
    const e = lv(lanesNear(D, lanes, ln.p[0], { radiusM: 100 }), 0, ln.l);
    assert.equal(e.verdict, 'overhead'); assert.ok(e.statuses.includes(e.status) && e.statuses.includes(LANE_STATUS[ln.s]));
    assert.deepEqual(e.statuses, [...e.statuses].sort((x, y) => LANE_STATUS.indexOf(x) - LANE_STATUS.indexOf(y)));
    if (e.statuses.length > 1) found++;
  }
  assert.ok(found > 0, 'some vertex has mixed statuses overhead');
});
