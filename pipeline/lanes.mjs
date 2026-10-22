// Build app/data/lanes.json: the air-road network over OSM arterial roads, each stretch scored with the engine.
// Run after build.py: node pipeline/lanes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { prepare, addTile, buildLanes, laneStats, TIERS, LANE_STATUS } from '../app/engine.js';

const data = new URL('../app/data/', import.meta.url), raw = new URL('../data/raw/', import.meta.url);
const load = n => JSON.parse(readFileSync(new URL(`${n}.json`, data)));
const D = prepare(Object.fromEntries(['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest', 'buildings'].map(n => [n, load(n)])));
for (const k of D.grid.listed) addTile(D, JSON.parse(readFileSync(new URL(`tiles/${k}.json`, data))));
const roads = JSON.parse(readFileSync(new URL('osm_roads.json', raw))).elements
  .filter(e => e.geometry).map(e => ({ highway: e.tags.highway, coords: e.geometry.map(g => [g.lon, g.lat]) }));

const t = performance.now();
const lanes = buildLanes(D, roads);
writeFileSync(new URL('lanes.json', data), JSON.stringify(lanes));
const km = laneStats(lanes, D);
TIERS.forEach((tier, i) => console.log(`${tier.name.padEnd(16)} ` + LANE_STATUS.map((s, j) => `${s} ${km[i][j].toFixed(0)} km`).join('  ')));
console.log(`${lanes.length} pieces in ${((performance.now() - t) / 1000).toFixed(1)} s`);

const manifest = load('manifest');
manifest.layers.lanes = { source: 'OpenStreetMap highway=motorway|trunk|primary|secondary, scored with app/engine.js', count: lanes.length };
writeFileSync(new URL('manifest.json', data), JSON.stringify(manifest, null, 1));
