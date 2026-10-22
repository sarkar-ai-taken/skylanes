// Shared start-up for the ride and fleet pages: load the data layers and a dark 3D basemap.
import { prepare, ensureTiles } from './engine.js';

export async function loadData(names = ['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest', 'buildings', 'lanes']) {
  const raw = Object.fromEntries(await Promise.all(names.map(async n => [n, await (await fetch(`data/${n}.json`)).json()])));
  return { raw, D: prepare(raw) };
}

/** Population-grid tiles a box needs, fetched once each. */
export const loadTile = key => fetch(`data/tiles/${key}.json`).then(r => r.json());
export const ensureBox = (D, box) => ensureTiles(D, box, loadTile);

/** A dark MapLibre map with height-shaded 3D buildings; resolves once the style has loaded. */
export function createMap(container, opts = {}) {
  const map = new maplibregl.Map({ container, style: 'https://tiles.openfreemap.org/styles/dark', maxPitch: 85, attributionControl: { compact: true }, ...opts });
  return new Promise(resolve => map.on('load', () => {
    const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
    map.addLayer({ id: 'bld3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 12,
      paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#1f272c', 60, '#34414a', 200, '#4a5d6a'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.92 } }, firstSymbol);
    resolve(map);
  }));
}

/** Header links between the three pages. */
export function nav(active) {
  const pages = [['index.html', 'Plan a route'], ['ride.html', 'Ride'], ['fleet.html', 'Fleet']];
  return `<nav class="pages">${pages.map(([h, t]) => `<a href="${h}"${h.startsWith(active) ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>`;
}
