// The real-data layers: 3DEP lidar heights, OSM land use, OpenSky ADS-B traffic, HRRR wind, FAA NOTAMs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, addTile, scoreRoute, findings, planClimb, surfaceNear, landUse, trafficAt, trafficLevel, climateWind, windClimate } from '../app/engine.js';
import { ROUTES } from '../app/routes.js';

const load = n => JSON.parse(readFileSync(new URL(`../app/data/${n}.json`, import.meta.url)));
const D = prepare(Object.fromEntries(['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest', 'buildings', 'traffic', 'wind'].map(n => [n, load(n)])));
for (const k of D.grid.listed) addTile(D, JSON.parse(readFileSync(new URL(`../app/data/tiles/${k}.json`, import.meta.url))));
const P = ll => D.proj(ll);
const route = id => ROUTES.find(r => r.id === id).path;

test('lidar reads the towers it should and leaves mapped ones to their footprints', () => {
  const cc = surfaceNear(D, P([-122.3305, 47.6045]));
  assert.ok(cc.ft > 880 && cc.ft < 960, `Columbia Center ${cc.ft} ft (actual 933)`);
  assert.equal(cc.kind, 'mapped structure');
  assert.equal(surfaceNear(D, P([-122.3305, 47.6045]), 0, true).ft, 0, 'the footprint handles it');
  const sn = surfaceNear(D, P([-122.3493, 47.6205]));
  assert.ok(sn.ft > 560 && sn.ft < 640, `Space Needle ${sn.ft} ft (actual 605)`);
});

test('lidar sees the old-growth canopy in Seward Park and nothing airborne south of SEA', () => {
  const s = surfaceNear(D, P([-122.2525, 47.553]));
  assert.equal(s.kind, 'tree canopy');
  assert.ok(s.ft > 100 && s.ft < 246, `canopy ${s.ft} ft`);
  // a cloud deck at 1,130 ft over Des Moines in the 2021 survey must not read as a structure
  assert.ok(surfaceNear(D, P([-122.3186, 47.3971])).ft < 100);
});

test('a 150 ft route through Seward Park is flagged for trees, and climb over clears them', () => {
  const R = [[-122.2560, 47.5490], [-122.2530, 47.5570]];
  const r = scoreRoute(D, R, { altFt: 150 });
  assert.ok(r.lidarShare > 0.95);
  assert.ok(r.surfaceHits.some(h => h.kind === 'tree canopy'), 'trees near the level');
  assert.ok(findings(r).some(([, t]) => t.startsWith('Lidar: tree canopy')));
  const { route: up } = planClimb(D, R, { altFt: 150 });
  const r2 = scoreRoute(D, up, { altFt: 150 });
  assert.ok(Math.min(...up.map(p => p[2])) > 150);
  assert.equal(r2.surfaceHits.length, 0);
});

test('routes outside the lidar surveys say so instead of passing silently', () => {
  const r = scoreRoute(D, [[-122.63, 47.565], [-122.62, 47.575]], { altFt: 200 }); // Bremerton, Kitsap
  assert.equal(r.lidarShare, 0);
  assert.ok(findings(r).some(([s, t]) => s === 'warn' && t.includes('No 3DEP lidar')));
});

test('land use: parks are parks, and the contingency gap is measured', () => {
  assert.ok(['park', 'forest'].includes(landUse(D, P([-122.4105, 47.6603]))), `Discovery Park: ${landUse(D, P([-122.4105, 47.6603]))}`);
  assert.ok(['park', 'forest'].includes(landUse(D, P([-122.2525, 47.553]))), 'Seward Park');
  const r = scoreRoute(D, route('magnolia'), {});
  assert.ok(r.land.mix.length > 1);
  assert.ok(r.land.landingGapM > 0 && r.land.landingGapM <= r.lenM);
});

test('crewed traffic is busiest at Boeing Field and quiet over the Issaquah foothills', () => {
  const bfi = trafficAt(D, P([-122.30, 47.53]), 300), iss = trafficAt(D, P([-122.03, 47.53]), 300);
  assert.equal(trafficLevel(D, bfi.rho, bfi.band), 'very high');
  assert.ok(iss.rho < bfi.rho / 100);
  assert.equal(trafficAt(D, P([-122.30, 47.53]), 5000), null, 'above the top band');
  const r = scoreRoute(D, route('fremont'), ROUTES.find(x => x.id === 'fremont'));
  assert.ok(r.traffic.encountersPerFh > 0.05, 'Lake Union floatplanes');
});

test('HRRR wind: the windy day is windier, exceedance falls with the limit, the worst month is a month', () => {
  const xy = P([-122.33, 47.61]), w50 = climateWind(D, xy, 300, 50), w90 = climateWind(D, xy, 300, 90), c = windClimate(D, xy, 300);
  assert.ok(w90.kt > w50.kt && w50.kt > 0);
  assert.ok(c.over['15'] >= c.over['20'] && c.over['20'] >= c.over['25']);
  assert.ok(c.worstMonth >= 1 && c.worstMonth <= 12);
  assert.ok(c.hours > 4000, 'a year of daytime hours');
  assert.ok(climateWind(D, xy, 400, 50).kt >= climateWind(D, xy, 100, 50).kt, 'wind grows with height');
});

test('NOTAMs: the parser reads positions and heights, and an obstacle NOTAM by the route is reported', async () => {
  const { parseNotam, kindOf } = await import('../pipeline/notams.mjs');
  const n = parseNotam({ notam: { number: '10/123', location: 'BFI', text: 'OBST CRANE (ASN 2026-ANM-1-NRA) 473849N1222410W (1.2NM NE BFI) 610FT (420FT AGL) FLAGGED AND LGTD',
    effectiveStart: '2026-10-01T00:00:00.000Z', effectiveEnd: '2026-12-01T00:00:00.000Z' } });
  assert.deepEqual([n.kind, n.agl_ft, n.msl_ft], ['obstacle', 420, 610]);
  assert.ok(Math.abs(n.lat - 47.64694) < 1e-4 && Math.abs(n.lon + 122.40278) < 1e-4);
  assert.equal(kindOf('AIRSPACE UAS WI AN AREA DEFINED AS 1NM RADIUS OF 4738N12221W SFC-400FT'), 'uas');
  const on = scoreRoute(D, route('magnolia'), { notams: [n], when: new Date('2026-10-22T18:00:00Z') });
  assert.equal(on.notams.length, 1);
  assert.ok(findings(on).some(([, t]) => t.startsWith('NOTAM BFI 10/123')));
  const off = scoreRoute(D, route('magnolia'), { notams: [n], when: new Date('2026-12-22T18:00:00Z') });
  assert.ok(!findings(off).some(([, t]) => t.startsWith('NOTAM')), 'expired');
});

test('the package carries the real-data layers with no holes', async () => {
  const { sections, toMarkdown } = await import('../app/package.js');
  const { intendedArea } = await import('../app/engine.js');
  for (const R of ROUTES) {
    const r = scoreRoute(D, R.path, { aircraft: R.aircraft, altFt: R.altFt });
    const md = toMarkdown(sections(D, r, intendedArea(D, r), '2026-10-22'));
    for (const s of ['Historical ADS-B', 'HRRR', 'heights', 'traffic', 'wind']) assert.ok(md.includes(s), `${R.id}: ${s}`);
    assert.ok(!md.includes('undefined') && !md.includes('NaN') && !md.includes('null'), R.id);
  }
});
