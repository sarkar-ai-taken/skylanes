import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare, scoreRoute, findings, verdict, density, faaCategory, isWater } from '../app/engine.js';
import { ROUTES } from '../app/routes.js';

const load = n => JSON.parse(readFileSync(new URL(`../app/data/${n}.json`, import.meta.url)));
const D = prepare(Object.fromEntries(['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest'].map(n => [n, load(n)])));
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
