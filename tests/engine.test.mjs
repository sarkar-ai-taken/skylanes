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

test('stadium TFR uses the game schedule: active during a game window, next closure otherwise', () => {
  const R = route('fremont'); // 1.3 NM from Husky Stadium
  const kickoff = new Date('2026-11-07T20:30:00Z');
  const events = [{ stadium: 'Husky Stadium', title: 'PSU @ WASH', start: kickoff, tfrStart: new Date(kickoff - 36e5), tfrEnd: new Date(+kickoff + 4.5 * 36e5) }];
  const during = findings(scoreRoute(D, R, { events, when: new Date(+kickoff + 36e5) }));
  assert.ok(during.some(([s, t]) => s === 'crit' && t.includes('active now') && t.includes('PSU @ WASH')));
  const before = findings(scoreRoute(D, R, { events, when: new Date('2026-11-01T18:00:00Z') }));
  assert.ok(before.some(([s, t]) => s === 'warn' && t.includes('Next closure')));
  const none = findings(scoreRoute(D, R, { events: [], when: new Date('2026-11-01T18:00:00Z') }));
  assert.ok(none.some(([s, t]) => s === 'good' && t.includes('no MLB')));
});

test('a TFR polygon over the route blocks it while active', async () => {
  const { parseXnotam } = await import('../pipeline/tfr.mjs');
  const fixture = parseXnotam(readFileSync(new URL('./fixtures/tfr_6_1500.xml', import.meta.url), 'utf8'));
  assert.ok(fixture.ring.length > 30);
  assert.deepEqual(fixture.ring[0], fixture.ring[fixture.ring.length - 1]);
  assert.equal(fixture.upper_ft, 7500);
  // a synthetic 2 km square over Magnolia, ground to 1,000 ft
  const sq = [[-122.41, 47.640], [-122.38, 47.640], [-122.38, 47.655], [-122.41, 47.655], [-122.41, 47.640]];
  const tfr = { id: '6/9999', type: 'HAZARDS', ring: sq, lower_ft: 0, upper_ft: 1000, effective: '2026-10-22T15:00:00Z', expire: '2026-10-23T02:00:00Z' };
  const on = findings(scoreRoute(D, route('magnolia'), { tfrs: [tfr], when: new Date('2026-10-22T18:00:00Z') }));
  assert.ok(on.some(([s, t]) => s === 'crit' && t.includes('Inside active TFR 6/9999')));
  const off = findings(scoreRoute(D, route('magnolia'), { tfrs: [tfr], when: new Date('2026-10-24T18:00:00Z') }));
  assert.ok(!off.some(([s, t]) => s === 'crit' && t.includes('TFR 6/9999')));
});

test('wind aloft interpolates between model levels', async () => {
  const { windAt } = await import('../app/live.js');
  const p = { levels: [{ ft: 33, kt: 6, dir: 200 }, { ft: 262, kt: 12, dir: 210 }, { ft: 394, kt: 16, dir: 220 }], gustKt: 9 };
  const w = windAt(p, 300);
  assert.ok(w.kt > 12 && w.kt < 16, `kt ${w.kt}`);
  assert.ok(w.dir >= 210 && w.dir <= 220, `dir ${w.dir}`);
  assert.equal(windAt(p, 262).kt, 12);
});

test('pacific midnight handles both sides of the daylight-saving change', async () => {
  const { pacificMidnight } = await import('../app/live.js');
  assert.equal(pacificMidnight('2026-10-25').toISOString(), '2026-10-25T07:00:00.000Z'); // PDT
  assert.equal(pacificMidnight('2026-11-07').toISOString(), '2026-11-07T08:00:00.000Z'); // PST
});

test('every sample route altitude is a selectable level', async () => {
  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const R of (await import('../app/routes.js')).ROUTES) assert.ok(html.includes(`<option value="${R.altFt}"`), `${R.id} ${R.altFt}`);
});
