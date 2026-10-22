import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, scoreRoute, findings, verdict, density, faaCategory, isWater } from '../app/engine.js';
import { ROUTES } from '../app/routes.js';

const load = n => JSON.parse(readFileSync(new URL(`../app/data/${n}.json`, import.meta.url)));
const D = prepare(Object.fromEntries(['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest', 'buildings'].map(n => [n, load(n)])));
const route = id => ROUTES.find(r => r.id === id).path;

test('water reads as water and downtown reads dense', () => {
  assert.ok(isWater(D, D.proj([-122.37, 47.60])), 'Elliott Bay');
  assert.ok(isWater(D, D.proj([-122.335, 47.638])), 'Lake Union');
  assert.ok(density(D, D.proj([-122.335, 47.607]), 'day') > 10000, 'downtown daytime');
  assert.ok(density(D, D.proj([-122.335, 47.607]), 'night') < density(D, D.proj([-122.335, 47.607]), 'day'));
});

test('FAA operating category is highest downtown', () => {
  assert.equal(faaCategory(D, D.proj([-122.333, 47.606])), 5);
});

test('downtown crossing is not fileable as drawn', () => {
  const r = scoreRoute(D, route('downtown'), { aircraft: 'quad', altFt: 300 });
  assert.equal(r.maxCat, 5);
  assert.ok(r.obstacles.some(o => o.agl_ft >= 300), 'towers above 300 ft');
  assert.equal(verdict(findings(r)), 'crit');
});

test('scores are deterministic', () => {
  const a = scoreRoute(D, route('magnolia'), {}), b = scoreRoute(D, route('magnolia'), {});
  assert.deepEqual(a.foot.slice(0, 20), b.foot.slice(0, 20));
  assert.equal(a.ecPerFh, b.ecPerFh);
});

test('every sample route scores in under 2 s', () => {
  for (const R of ROUTES) {
    const t = performance.now(); const r = scoreRoute(D, R.path, { aircraft: R.aircraft, altFt: R.altFt });
    const ms = performance.now() - t;
    console.log(`${R.id.padEnd(10)} ${(r.lenM / 1000).toFixed(2)} km  cat ${r.maxCat}  obst ${r.obstacles.length}  lines ${r.powerlines.length}  air ${r.airspace.map(a => a.name).join('; ') || '-'}  Ec/fh ${r.ecPerFh.toExponential(1)}  ${verdict(findings(r))}  ${ms.toFixed(0)} ms`);
    assert.ok(ms < 2000, `${R.id} took ${ms} ms`);
  }
});

test('intended area contains the route and is a closed ring', async () => {
  const { intendedArea } = await import('../app/engine.js');
  const r = scoreRoute(D, route('magnolia'), {});
  const a = intendedArea(D, r);
  assert.deepEqual(a.ring[0], a.ring[a.ring.length - 1]);
  assert.ok(a.km2 > 0.1 && a.km2 < 10, `area ${a.km2}`);
});

test('package renders every section to HTML and Markdown', async () => {
  const { intendedArea } = await import('../app/engine.js');
  const { sections, toHTML, toMarkdown } = await import('../app/package.js');
  const r = scoreRoute(D, route('downtown'), {});
  const doc = sections(D, r, intendedArea(D, r), '2026-10-21');
  const md = toMarkdown(doc), html = toHTML(doc);
  for (let i = 1; i <= 8; i++) assert.ok(md.includes(`## ${i}.`), `section ${i}`);
  assert.ok(md.includes('**Category 5**'));
  assert.ok(html.includes('<strong>Category 5</strong>'));
  assert.ok(!html.includes('undefined') && !md.includes('NaN'));
});

test('a route straight through Columbia Center is caught as passing through a building', async () => {
  const thru = [[-122.3330, 47.6045], [-122.3280, 47.6045]];
  const r = scoreRoute(D, thru, { altFt: 300 });
  assert.ok(r.buildings.some(b => b.dm === 0 && b.h_ft > 900), 'Columbia Center footprint hit');
  assert.ok(r.blockedShare > 0);
  assert.ok(findings(r).some(([s, t]) => s === 'crit' && t.includes('passes through')));
});

test('go around clears every building and obstacle at the route altitude', async () => {
  const { planAround } = await import('../app/engine.js');
  const thru = [[-122.3330, 47.6045], [-122.3280, 47.6045]];
  const { route: out, failed } = planAround(D, thru, { altFt: 300 });
  assert.equal(failed.length, 0);
  const r = scoreRoute(D, out, { altFt: 300 });
  const mid = r.samples.slice(2, -2); // launch and drop pads may sit beside towers
  assert.equal(mid.filter(s => s.blocked).length, 0, `still blocked: ${mid.filter(s => s.blocked).length}`);
  assert.ok(r.lenM < 1500, `detour stays reasonable: ${r.lenM} m`);
});

test('climb over raises only the legs that need it and respects 400 ft', async () => {
  const { planClimb } = await import('../app/engine.js');
  // Ballard: low ceilings do not apply; a 150 ft route over mid-rise blocks
  const R = [[-122.3870, 47.6640], [-122.3830, 47.6680], [-122.3760, 47.6690]];
  const { route: out } = planClimb(D, R, { altFt: 100 });
  assert.ok(out.every(p => p[2] <= 400));
  const r = scoreRoute(D, out, { altFt: 100 });
  assert.equal(r.samples.filter(s => s.blocked).length, 0);
});

test('per-waypoint levels are honoured and interpolated', () => {
  const r = scoreRoute(D, [[-122.3790, 47.6450, 200], [-122.3990, 47.6500, 400]], {});
  assert.equal(r.altMin, 200); assert.equal(r.altMax, 400); assert.ok(r.levelled);
  const mid = r.samples[Math.floor(r.samples.length / 2)].alt;
  assert.ok(mid > 250 && mid < 350, `mid ${mid}`);
});

test('sky lanes: every piece has a valid tier, level and status, and drone lanes respect the clearance rule', async () => {
  const { TIERS, LANE_STATUS, laneStatus } = await import('../app/engine.js');
  const lanes = load('lanes');
  assert.ok(lanes.length > 1000);
  for (const ln of lanes.slice(0, 500)) {
    assert.ok(TIERS[ln.t].levels.includes(ln.l));
    assert.ok(LANE_STATUS[ln.s]);
    assert.ok(ln.p.length >= 2);
  }
  // spot-check: a drone lane piece marked open is open at its midpoint
  const open = lanes.filter(ln => ln.t === 0 && ln.s === 0).slice(0, 50);
  for (const ln of open) { const m = ln.p[Math.floor(ln.p.length / 2)]; assert.equal(laneStatus(D, D.proj(m), ln.l, TIERS[0]), 'open'); }
});
