// Phase 1 baselines: hourly ground population, road users, noise complaints, mobile coverage, Remote ID in the package.
// Small inline fixtures pin the arithmetic; a few checks on the shipped layers make sure the files and the engine agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, addTile, density, densityAt, cellMeans, hourWeights, hourlyProfile, routeProfile, operatingWindows, windowText, hhmm,
  roadCrossings, complaintsNear, noiseRoute, cellTile, cellAlong, scoreRoute, findings, intendedArea, TOD, OCCUPANCY } from '../app/engine.js';
import { sections, toMarkdown } from '../app/package.js';
import { parseRemoteIdLog, summarizeRemoteId } from '../app/remoteid.js';
import { ROUTES } from '../app/routes.js';

// ---------- fixture: 20 × 20 cells of 100 m; columns 0–9 homes (3,000 residents/km²), 10–19 offices (20,000 jobs/km²) ----------
const W0 = -122.40, S0 = 47.60, DLON = 0.0013309367517595943, DLAT = 0.0009043717329571147;
const b64 = a => Buffer.from(a.buffer).toString('base64');
const N = 20, res = new Uint32Array(N * N), jobs = new Uint32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) (i < 10 ? res : jobs)[j * N + i] = i < 10 ? 3000 : 20000;
const tile = { ti: 0, tj: 0, w: N, h: N, residents: b64(res), jobs: b64(jobs), state: b64(new Uint8Array(N * N)), faacat: b64(new Uint8Array(N * N)), ceiling: b64(new Uint16Array(N * N).fill(65535)) };
const grid = { west: W0, south: S0, dlon: DLON, dlat: DLAT, nx: N, ny: N, tile: N, tiles: ['0_0'] };
const manifest = { metro: 'Fixture', bbox: [-122.42, 47.59, -122.36, 47.63], built: '2026-10-23', layers: {} };
const lon = i => W0 + (i + 0.5) * DLON, lat = j => S0 + (j + 0.5) * DLAT;
const route = [[lon(3), lat(10)], [lon(16), lat(10)]]; // ~1.3 km west to east, homes then offices

// ATUS-like curves: everyone home 00–05, then half home, 40% of jobs at work, 10% out and 5% travelling.
const day = (night, d) => Array.from({ length: 24 }, (_, h) => (h < 6 ? night : d));
const curve = { resHome: day(1, 0.5), jobsAtWork: day(0, 0.4), out: day(0, 0.1), travel: day(0, 0.05) };
const diurnal = { weekday: curve, weekend: { ...curve, jobsAtWork: day(0, 0.1) }, spread: { k: 2 }, local: { acs: 'ACS fixture' } };

const flat = Array(24).fill(1 / 24);
const roadcounts = { hourly: { all: flat, freeway: flat, arterial: flat, stations: 1 }, segs: [
  { aadt: 24000, awdt: 26000, year: 2024, counted: 2015, src: 'sdot', name: 'Test Ave', coords: [[lon(8), 47.605], [lon(8), 47.615]] },
  { aadt: 120000, year: 2025, src: 'wsdot', name: 'I-5', coords: [[lon(10), lat(10) + 20 / 110574], [lon(15), lat(10) + 20 / 110574]] },
  { aadt: 9000, year: 2025, src: 'wsdot', name: 'SR 900', coords: [[lon(2), lat(18)], [lon(17), lat(18)]] },
] };

// Seattle stand-in: a box over the western half of the route; one busy cell beside it and one far away.
const cityRing = [[-122.40, 47.60], [-122.386, 47.60], [-122.386, 47.62], [-122.40, 47.62], [-122.40, 47.60]];
const noise311 = { west: -122.40, south: 47.60, dlon: 0.0033, dlat: 0.00226, nx: 10, ny: 10, cells: [1, 4, 100, 90, 5, 5, 2, 9, 50, 50, 0, 0],
  city: [[cityRing]], city_bbox: [-122.40, 47.60, -122.386, 47.62], city_cell_stats: { median: 1, mean: 5, p75: 5, p90: 14, p99: 68, max: 300 },
  hour: Array.from({ length: 24 }, (_, h) => (h === 23 ? 50 : 5)), years: 3, start: '2023-10-01', end: '2026-09-30', records: 150 };

// Ookla stand-in: the z16 tile at the route's start is fast; the next one east is slow; the rest were never measured.
const tileOf = ([lo, la], z = 16) => [Math.floor((lo + 180) / 360 * 2 ** z), Math.floor((1 - Math.asinh(Math.tan(la * Math.PI / 180)) / Math.PI) / 2 * 2 ** z)];
const [tx, ty] = tileOf(route[0]);
const cellular = { quarter: '2026-Q3', license: 'CC BY-NC-SA 4.0', z: 16, x0: tx - 2, y0: ty - 2, nx: 6, ny: 6, count: 2, tests: 7,
  dx: [2, 3], dy: [2, 2], d: [50000, 2000], u: [10000, 500], lat: [30, 40], tests_n: [5, 2], dev: [3, 1] };

const base = { grid, manifest };
const D = prepare({ ...base, diurnal, roadcounts, noise311, cellular }); addTile(D, tile);
const bare = prepare(base); addTile(bare, tile);
const home = [D.proj([lon(3), lat(10)]), D.proj([lon(16), lat(10)])];

test('hourWeights reads the ATUS curves, interpolates between hours, and falls back to the presets without them', () => {
  assert.deepEqual(hourWeights(D, 3), { res: 1, jobs: 0 });
  const noon = hourWeights(D, 12);
  assert.ok(Math.abs(noon.res - 0.5) < 1e-12 && Math.abs(noon.jobs - (0.4 + 0.15 * 2)) < 1e-12);
  const half = hourWeights(D, 5.5);
  assert.ok(Math.abs(half.res - 0.75) < 1e-12 && Math.abs(half.jobs - 0.35) < 1e-12);
  assert.deepEqual(hourWeights(D, 27), hourWeights(D, 3), 'hours wrap');
  assert.ok(hourWeights(D, 12, 'weekend').jobs < noon.jobs, 'fewer at work on weekends');
  assert.deepEqual(hourWeights(bare, 3), { res: 1, jobs: 0, preset: true });
  assert.deepEqual(hourWeights(bare, 12), { res: 0.55, jobs: 1, preset: true });
  assert.equal(hhmm(17.5), '17:30'); assert.equal(hhmm(24), '00:00'); assert.equal(hhmm(-1), '23:00');
});

test('densityAt: homes fill at night, offices by day; density() and the TOD presets are unchanged', () => {
  const [h, o] = home;
  assert.deepEqual(cellMeans(D, h), [3000, 0]);
  assert.equal(densityAt(D, h, 3), 3000); assert.equal(densityAt(D, o, 3), 0);
  assert.equal(densityAt(D, h, 12), 1500); assert.ok(Math.abs(densityAt(D, o, 12) - 14000) < 1e-9);
  assert.equal(density(D, h, 'night'), 3000); assert.equal(density(D, o, 'day'), 20000); assert.equal(density(D, h, 'day'), 0.55 * 3000);
});

test('operating windows: longest run at the lowest category, worst run around the busiest hour, wrapping midnight', () => {
  const cat = h => (h < 6 || h >= 22 ? 3 : h < 18 ? 5 : 4);
  const H = Array.from({ length: 24 }, (_, h) => ({ h, cat: cat(h), peak: 0, mean: h === 12 ? 900 : cat(h) * 100 }));
  const w = operatingWindows(H);
  assert.deepEqual([w.lo, w.hi, w.best.from, w.best.to, w.best.hours, w.worst.from, w.worst.to, w.busiest], [3, 5, 22, 6, 8, 6, 18, 12]);
  assert.equal(windowText(w.best), '22:00–06:00'); assert.equal(windowText(w.worst), '06:00–18:00');
  const all = operatingWindows(H.map(x => ({ ...x, cat: 4 })));
  assert.equal(windowText(all.best), 'all day'); assert.equal(all.best.hours, 24);
});

test('the hourly profile of a route: peak and mean by hour, census categories, windows; null without the layer', () => {
  const P = routeProfile(D, route);
  assert.equal(P.weekday[3].cat, 4); assert.ok(Math.abs(P.weekday[3].peak - 3000) < 1e-9);
  assert.equal(P.weekday[13].cat, 5); assert.ok(Math.abs(P.weekday[13].peak - 14000) < 1e-9);
  assert.ok(P.weekend[13].peak < P.weekday[13].peak);
  assert.deepEqual([P.windows.weekday.lo, P.windows.weekday.best.from, P.windows.weekday.best.to], [4, 0, 6]);
  assert.equal(routeProfile(bare, route), null);
  assert.equal(hourlyProfile(D, []), null);
});

test('road crossings: one crossing, one parallel freeway stretch, vehicles under the footprint by hour', () => {
  const R = roadCrossings(D, route, { hour: 12 });
  assert.deepEqual(R.crossings.map(c => [c.name, c.leg, c.year]), [['Test Ave', 0, 2015]]);
  assert.ok(Math.abs(R.crossings[0].along - 500) < 10, `crossing at ${R.crossings[0].along} m`);
  assert.ok(Math.abs(R.crossings[0].vph - 26000 / 24) < 1e-9, 'AWDT on a weekday');
  assert.equal(R.parallel.length, 1); assert.equal(R.parallel[0].name, 'I-5');
  assert.ok(R.parallel[0].lengthM >= 500 && R.parallel[0].lengthM <= 600, `followed for ${R.parallel[0].lengthM} m (500 m road, 50 m buffer at each end)`);
  const want = 26000 / 24 / (11.2 * 3600) * 100 + 5000 / (26.8 * 3600) * R.parallel[0].lengthM;
  assert.ok(Math.abs(R.vehUnder - want) < 1e-9); assert.equal(R.peopleUnder, R.vehUnder * OCCUPANCY);
  assert.ok(Math.abs(roadCrossings(D, route, { hour: 12, dayType: 'weekend' }).crossings[0].vph - 1000) < 1e-9, 'AADT at weekends');
  assert.ok(!R.crossings.some(c => c.name === 'SR 900'), 'roads 800 m away are not under the route');
  assert.equal(roadCrossings(bare, route), null);
});

test('road crossings: each count section and each separate crossing of the same road counts at its own volume', () => {
  const y = lat(10), dy = 20 / 110574;
  const segs = [{ aadt: 48000, year: 2025, src: 'wsdot', name: 'SR 1', coords: [[lon(3), y + dy], [lon(7), y + dy]] },   // followed ~500 m
    { aadt: 24000, year: 2025, src: 'wsdot', name: 'SR 1', coords: [[lon(7), y + dy], [lon(9), y + dy]] },                  // next section, followed ~250 m
    { aadt: 12000, year: 2025, src: 'wsdot', name: 'SR 1', coords: [[lon(14), y - 0.005], [lon(14), y + 0.005]] }];        // crossed far from both
  const X = prepare({ ...base, roadcounts: { hourly: roadcounts.hourly, segs } }), R = roadCrossings(X, route, { hour: 12 });
  assert.equal(R.crossings.length, 1); assert.equal(R.followed, 1); assert.equal(R.parallel.length, 2);
  const perM = (d, v) => d / 24 / (v * 3600), want = perM(12000, 20.1) * 100 + R.parallel.reduce((a, p) => a + perM(p.aadt, 20.1) * p.lengthM, 0);
  assert.ok(Math.abs(R.vehUnder - want) < 1e-9, `${R.vehUnder} vs ${want}`);
  assert.ok(R.parallel.every(p => p.lengthM >= 200), R.parallel.map(p => p.lengthM).join(','));
});

test('noise complaints: counted in Seattle, no data outside it', () => {
  const near = complaintsNear(D, D.proj(route[0]));
  assert.deepEqual(near, { n: 100, cells: near.cells, inCity: true });
  assert.equal(complaintsNear(D, D.proj(route[1])), null, 'outside the city is no data, not zero');
  const c = noiseRoute(D, route);
  assert.ok(c.covered > 0.45 && c.covered < 0.65, `covered ${c.covered}`);
  assert.equal(c.n, 100); assert.equal(c.maxCell, 100); assert.equal(c.peakHour, 23);
  assert.equal(c.level, c.meanCell >= 14 ? 'high' : c.meanCell >= 5 ? 'elevated' : 'low');
  const out = noiseRoute(D, [[lon(14), lat(5)], [lon(18), lat(5)]]);
  assert.deepEqual([out.covered, out.n, out.level], [0, 0, null]);
  assert.equal(noiseRoute(bare, route), null);
});

test('mobile coverage: measured, good and the longest stretch without a usable tile', () => {
  assert.equal(cellTile(D, D.proj(route[0])).d, 50000);
  assert.equal(cellTile(D, D.proj([-122.2, 47.7])), null);
  const L = cellAlong(D, route);
  assert.ok(L.measured > L.good && L.good > 0 && L.measured < 1, JSON.stringify(L));
  assert.equal(L.tiles, 2); assert.equal(L.tests, 7); assert.equal(L.minDownMbps, 2);
  assert.ok(['no measurements', 'low throughput'].includes(L.worst.why) && L.worst.toM > L.worst.fromM);
  assert.equal(cellAlong(bare, route), null);
});

test('scoreRoute: the hour drives samples and footprints; without one the preset result is unchanged', () => {
  const pre = scoreRoute(D, route, {}), old = scoreRoute(bare, route, {});
  assert.equal(pre.hour, null); assert.equal(pre.popLabel, TOD.day.label);
  assert.deepEqual(pre.samples.map(s => s.d), old.samples.map(s => s.d)); assert.equal(pre.ecPerFh, old.ecPerFh);
  assert.deepEqual([old.hourly, old.roads, old.complaints, old.link], [null, null, null, null]);
  const night = scoreRoute(D, route, { hour: 3 }), noon = scoreRoute(D, route, { hour: 12 });
  assert.ok(Math.abs(night.peakD - 3000) < 1e-9 && Math.abs(noon.peakD - 14000) < 1e-9);
  assert.match(noon.popLabel, /^weekday 12:00 \(ATUS hourly model\)/);
  assert.match(scoreRoute(bare, route, { hour: 3 }).popLabel, /no hourly layer: overnight preset/);
  assert.equal(noon.roads.hour, 12); assert.equal(pre.roads.hour, 13, 'the day preset stands for 13:00');
  assert.equal(noon.schoolHours, true); assert.equal(scoreRoute(D, route, { hour: 12, dayType: 'weekend' }).schoolHours, false);
  const f = findings(noon).map(x => x[1]).join('\n');
  for (const s of ['changes with the hour', 'counted road', 'noise complaints', 'Ookla 2026-Q3']) assert.ok(f.includes(s), s);
  const at3 = scoreRoute(D, route, { hour: 3 }), fn = findings(at3).find(x => x[1].includes('ATUS hourly model'));
  assert.equal(at3.maxCat, 4); assert.equal(fn[0], 'warn'); assert.ok(fn[1].includes('census-derived category (Cat 5) is above the governing Category 4'), fn[1]);
  assert.ok(!findings(noon).find(x => x[1].includes('ATUS hourly model'))[1].includes('above the governing'));
});

test('the package carries section 6 with every baseline, renumbered, and the Remote ID log when imported', () => {
  const r = scoreRoute(D, route, { hour: 17 });
  const md = toMarkdown(sections(D, r, intendedArea(D, r), '2026-10-23'));
  for (const h of ['## 6. Phase 1 baselines', '## 6.1 Time-of-day ground population', '## 6.2 Crewed and uncrewed traffic baseline', '## 6.3 Road users under the route',
    '## 6.4 Noise complaints baseline', '## 6.5 C2 link: ground-level mobile performance', '## 7. Findings', '## 8. Open items', '## 9. Data sources']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('| 00:00–03:00 |') && md.includes('| 21:00–24:00 |'));
  assert.ok(md.includes('no Remote ID observations') && md.includes('Drone Scanner'));
  assert.match(md, /\| Loss of C2 link \| [^|]*Ookla 2026-Q3[^|]*section 6\.5/);
  assert.ok(!/undefined|NaN|null/.test(md));
  const recs = parseRemoteIdLog(JSON.stringify([{ t: Date.UTC(2026, 9, 21, 0, 30), id: 'SYNTH1', lat: lat(10), lon: lon(5), heightM: 40, operatorId: 'OP1', opLat: lat(9), opLon: lon(5) }]));
  const rid = { summary: summarizeRemoteId(recs, route, { radiusM: 500 }), files: ['walk.json'], warnings: [] };
  const md2 = toMarkdown(sections(D, r, intendedArea(D, r), '2026-10-23', null, { remoteId: rid }));
  assert.ok(md2.includes('Uncrewed (Remote ID, walk.json)') && md2.includes('| Remote ID log |') && md2.includes('Remote ID walk: 1 uncrewed aircraft within 500 m'));
  assert.ok(!md2.includes('Walk the corridor with a Remote ID receiver'), 'no open item once a log is in');
  // a log recorded elsewhere is not this corridor's baseline: the open item stays and 6.2 says so
  const far = parseRemoteIdLog(JSON.stringify([{ t: Date.UTC(2026, 9, 21, 0, 30), id: 'FAR1', lat: 47.70, lon: -122.30, heightM: 40 }]));
  const md3 = toMarkdown(sections(D, r, intendedArea(D, r), '2026-10-23', null, { remoteId: { summary: summarizeRemoteId(far, route, { radiusM: 500 }), files: ['far.json'], warnings: [] } }));
  assert.ok(md3.includes('Walk the corridor with a Remote ID receiver') && md3.includes('not a baseline for this corridor') && !md3.includes('Remote ID walk:'));
  const r0 = scoreRoute(bare, route, {});
  const md0 = toMarkdown(sections(bare, r0, intendedArea(bare, r0), '2026-10-23'));
  for (const s of ['hourly population layer is not built', 'road count layer is not built', 'noise complaint layer is not built', 'mobile speed-test layer is not built']) assert.ok(md0.includes(s), s);
  assert.ok(!/undefined|NaN|null/.test(md0));
});

test('the shipped layers agree with the engine', () => {
  const load = n => JSON.parse(readFileSync(new URL(`../app/data/${n}.json`, import.meta.url)));
  const R = prepare(Object.fromEntries(['manifest', 'diurnal', 'noise311', 'roadcounts', 'cellular'].map(n => [n, load(n)])));
  const path = id => ROUTES.find(r => r.id === id).path;
  assert.ok(hourWeights(R, 3).res > 0.95 && hourWeights(R, 12).res < 0.6, 'people leave home by day');
  assert.ok(hourWeights(R, 12).jobs > hourWeights(R, 3).jobs);
  for (const k of ['weekday', 'weekend']) assert.ok(Array.from({ length: 24 }, (_, h) => h).every(h => Math.abs(['resHome', 'atWorkAllPersons', 'out', 'travel', 'unknown'].reduce((a, f) => a + R.diurnal[k][f][h], 0) - 1) < 0.003));
  assert.ok(Math.abs(R.roads.hourly.all.reduce((a, b) => a + b, 0) - 1) < 1e-3);
  assert.ok(roadCrossings(R, path('bellevue'), { hour: 17 }).crossings.some(c => c.name === 'I-405' && c.aadt > 100000), 'I-405 in Bellevue');
  assert.equal(noiseRoute(R, path('downtown')).level, 'high');
  assert.equal(noiseRoute(R, path('bellevue')).covered, 0, 'Bellevue is outside Seattle');
  assert.equal(cellAlong(R, path('downtown')).measured, 1);
  for (const k of ['diurnal', 'noise311', 'roadcounts', 'cellular']) assert.ok(R.manifest.layers[k]?.count > 0, `manifest notes ${k}`);
});
