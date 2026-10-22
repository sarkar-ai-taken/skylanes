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
