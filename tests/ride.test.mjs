import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, laneGraph, routeOnLanes, TIERS } from '../app/engine.js';
import { VERTIPORTS } from '../app/vertiports.js';
import { CRUISE_MS, SIGNAL, signalState, placeSignals, fly } from '../app/ride-sim.js';

const load = n => JSON.parse(readFileSync(new URL(`../app/data/${n}.json`, import.meta.url)));

test('without signals the taxi flies the whole route, forward only, never above cruise', () => {
  const { line, wait } = fly(12000);
  assert.equal(line[line.length - 1].s, 12000);
  assert.equal(wait, 0);
  for (let i = 1; i < line.length; i++) {
    assert.ok(line[i].s >= line[i - 1].s);
    assert.ok((line[i].s - line[i - 1].s) / (line[i].t - line[i - 1].t) <= CRUISE_MS + 1e-6);
  }
});

test('the taxi never passes a signal stop point on red, and red costs time', () => {
  const sig = { s: 5000, offset: 0 }, stop = sig.s - SIGNAL.stopM;
  let held = 0; const base = fly(9000).T;
  for (let offset = 0; offset < SIGNAL.cycle; offset += 3) {
    const g = { ...sig, offset }, { line, T } = fly(9000, [g]);
    held += T > base + 1;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      if (a.s < stop && b.s >= stop + 1) assert.notEqual(signalState(g, b.t), 'red', `crossed on red, offset ${offset}`);
    }
    assert.ok(T >= base - 1e-6);
  }
  assert.ok(held > SIGNAL.cycle / 3 / 3, `slowed at ${held} of ${SIGNAL.cycle / 3} phases`);
});

test('signals sit at lane junctions, spaced out and clear of the climb and descent', () => {
  const D = prepare(Object.fromEntries(['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest'].map(n => [n, load(n)])));
  const level = TIERS[1].levels[1], G = laneGraph(D, load('lanes'), 1, level);
  const at = id => VERTIPORTS.find(v => v.id === id).at, R = routeOnLanes(D, G, at('northgate'), at('sodo'));
  const pts = R.path.map(p => D.proj(p)), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const S = placeSignals(G, pts, cum), L = cum[cum.length - 1];
  assert.ok(S.length >= 2, `${S.length} signals`);
  for (let k = 0; k < S.length; k++) {
    assert.ok(S[k].s > 1500 && S[k].s < L - 1500);
    if (k) assert.ok(S[k].s - S[k - 1].s >= 2000);
  }
});

test('game mode: tilting the phone steers and climbs the same way in portrait and both landscapes', async () => {
  const { screenTilt, tiltInput } = await import('../app/ride-sim.js');
  // portrait, held 45° back: tilt the right edge down → right; pull the top toward you → climb
  const p0 = screenTilt(45, 0, 0);
  assert.ok(Math.abs(p0.roll) < 1e-9 && Math.abs(p0.pitch - 45) < 1e-9);
  assert.ok(tiltInput(screenTilt(45, 30, 0), p0).x > 0.5);
  assert.ok(tiltInput(screenTilt(65, 0, 0), p0).y > 0.5);
  assert.ok(tiltInput(screenTilt(25, 0, 0), p0).y < -0.5);
  assert.deepEqual(tiltInput(screenTilt(47, 2, 0), p0), { x: 0, y: 0 }, 'inside the dead zone');
  // landscape, rotated 90° (device top to the left), held 45° back: β 0, γ −45
  const l0 = screenTilt(0, -45, 90);
  assert.ok(Math.abs(l0.roll) < 1e-6 && Math.abs(l0.pitch - 45) < 1e-6);
  assert.ok(tiltInput(screenTilt(20, -45, 90), l0).x > 0.5, 'right edge (device bottom) down');
  assert.ok(tiltInput(screenTilt(0, -70, 90), l0).y > 0.5, 'more upright climbs');
  // and the other landscape
  const r0 = screenTilt(0, 45, 270);
  assert.ok(Math.abs(r0.roll) < 1e-6 && Math.abs(r0.pitch - 45) < 1e-6);
  assert.ok(tiltInput(screenTilt(0, 70, 270), r0).y > 0.5);
  // input saturates and never goes NaN near upright
  const up = tiltInput(screenTilt(89.9, 89.9, 0), p0);
  assert.ok(Math.abs(up.x) <= 1 && Math.abs(up.y) <= 1 && !Number.isNaN(up.x + up.y));
});
