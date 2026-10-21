// Map, controls and rail. All scoring lives in engine.js; all document text in package.js.
import { AIRCRAFT, WIND_PRESETS, TOD, FT, prepare, scoreRoute, findings, verdict, noiseAt, intendedArea, catFromDensity, density } from './engine.js';
import { ROUTES } from './routes.js';
import { sections, toHTML, toMarkdown, corridorId } from './package.js';
import { createScene } from './scene3d.js';

const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const dark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const fc = features => ({ type: 'FeatureCollection', features });
const pt = (c, p = {}) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: c } });

const files = ['grid', 'obstacles', 'powerlines', 'sites', 'airspace', 'manifest'];
const raw = Object.fromEntries(await Promise.all(files.map(async n => [n, await (await fetch(`data/${n}.json`)).json()])));
const D = prepare(raw);
const M = raw.manifest;
$('dataNote').textContent = `Real data: census 2020 blocks, LEHD jobs, FAA obstacle file, UAS facility map, FAA operating categories, OSM. Built ${M.built}.`;

// ---------- Controls ----------
$('route').innerHTML = '<option value="">Sample routes…</option>' + ROUTES.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
$('aircraft').innerHTML = Object.entries(AIRCRAFT).map(([k, a]) => `<option value="${k}">${a.name}</option>`).join('');
let liveWind = null;
const state = { route: [], finished: false, result: null };

// ---------- Map ----------
const [W, S, E, N] = M.bbox;
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', // the 3D sky reads best on a dark map in either page theme
  bounds: [[-122.42, 47.59], [-122.30, 47.69]], maxBounds: [[W - 0.05, S - 0.03], [E + 0.05, N + 0.03]],
  pitch: 60, bearing: -20, maxPitch: 75, doubleClickZoom: false, attributionControl: { compact: true },
});
window.corridorMap = map; // handle for debugging and tests
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

function densityImage(tod) {
  const g = D.grid, cv = document.createElement('canvas'); cv.width = g.nx; cv.height = g.ny;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(g.nx, g.ny), m = TOD[tod];
  const cols = [null, [47, 143, 78], [127, 191, 106], [199, 129, 26], [216, 98, 42], [194, 59, 46]];
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i, o = ((g.ny - 1 - j) * g.nx + i) * 4;
    if (g.water[k]) continue;
    const d = m.res * g.residents[k] + m.jobs * g.jobs[k], c = catFromDensity(d), col = cols[c];
    img.data.set([...col, c <= 2 ? 0 : c === 3 ? 50 : c === 4 ? 80 : 120], o);
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
}
const gridCorners = () => { const g = D.grid, e = g.west + g.nx * g.dlon, n = g.south + g.ny * g.dlat; return [[g.west, n], [e, n], [e, g.south], [g.west, g.south]]; };
// metres → pixels at every zoom: width doubles per zoom level
const metresWidth = m => ['interpolate', ['exponential', 2], ['zoom'], 10, m / (156543.03 * Math.cos(47.62 * Math.PI / 180) / 2 ** 10), 20, m / (156543.03 * Math.cos(47.62 * Math.PI / 180) / 2 ** 20)];

const LAYERS = {
  density: ['density'], faacat: ['faacat-fill', 'faacat-line'], laanc: ['laanc-line', 'laanc-label'], obstacles: ['obstacles'],
  power: ['power'], sites: ['sites'], foot: ['foot'], noise: ['noise'], area: ['area-fill', 'area-line'],
};

map.on('load', () => {
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addSource('density', { type: 'image', url: densityImage('day'), coordinates: gridCorners() });
  map.addLayer({ id: 'density', type: 'raster', source: 'density', paint: { 'raster-opacity': 0.75, 'raster-resampling': 'nearest' } }, firstSymbol);
  map.addSource('faacat', { type: 'geojson', data: fc(raw.airspace.operating_categories.slice().sort((a, b) => a.properties.category - b.properties.category)) });
  const catColor = ['match', ['get', 'category'], 2, css('--c2'), 3, css('--warn'), 4, css('--c4'), 5, css('--crit'), '#888'];
  map.addLayer({ id: 'faacat-fill', type: 'fill', source: 'faacat', paint: { 'fill-color': catColor, 'fill-opacity': 0.12 }, layout: { visibility: 'none' } }, firstSymbol);
  map.addLayer({ id: 'faacat-line', type: 'line', source: 'faacat', paint: { 'line-color': catColor, 'line-width': 1.5 }, layout: { visibility: 'none' } });
  map.addSource('laanc', { type: 'geojson', data: fc(raw.airspace.facility_map) });
  map.addLayer({ id: 'laanc-line', type: 'line', source: 'laanc', paint: { 'line-color': css('--muted'), 'line-width': 0.5, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'laanc-label', type: 'symbol', source: 'laanc', minzoom: 12, layout: { 'text-field': ['to-string', ['get', 'ceiling_ft']], 'text-size': 10, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': css('--muted'), 'text-opacity': 0.8 } });
  // 3D buildings from the basemap's OpenMapTiles source
  map.addLayer({ id: 'bld3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#1f272c', 60, '#34414a', 200, '#4a5d6a'], 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.9 } });
  map.addSource('power', { type: 'geojson', data: raw.powerlines });
  map.addLayer({ id: 'power', type: 'line', source: 'power', paint: { 'line-color': '#8a5cc2', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  map.addSource('obstacles', { type: 'geojson', data: fc(raw.obstacles.map(o => pt([o.lon, o.lat], o))) });
  map.addLayer({ id: 'obstacles', type: 'circle', source: 'obstacles', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'agl_ft'], 50, 2, 300, 4, 700, 7], 'circle-color': css('--fg'), 'circle-opacity': 0.55, 'circle-stroke-width': 0 } });
  map.addSource('sites', { type: 'geojson', data: fc(raw.sites.map(s => pt([s.lon, s.lat], s))) });
  map.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': ['match', ['get', 'kind'], 'school', 3, 5],
    'circle-color': ['match', ['get', 'kind'], 'hospital', css('--crit'), 'heliport', css('--crit'), 'school', css('--warn'), css('--accent')], 'circle-stroke-color': css('--panel'), 'circle-stroke-width': 1 } });
  for (const id of ['area', 'noise', 'foot', 'routeSeg', 'wps']) map.addSource(id, { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': css('--accent'), 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': css('--accent'), 'line-width': 1, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'noise', type: 'line', source: 'noise', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': css('--accent'), 'line-opacity': 0.18, 'line-width': metresWidth(1) } });
  map.addLayer({ id: 'foot', type: 'circle', source: 'foot', paint: { 'circle-radius': 2, 'circle-color': css('--crit'), 'circle-opacity': 0.35 } });
  map.addLayer({ id: 'routeSeg', type: 'line', source: 'routeSeg', layout: { 'line-cap': 'round' },
    paint: { 'line-width': 5, 'line-color': ['match', ['get', 'c'], 1, css('--good'), 2, css('--c2'), 3, css('--warn'), 4, css('--c4'), 5, css('--crit'), css('--accent')] } });
  map.addLayer({ id: 'wps', type: 'circle', source: 'wps', paint: { 'circle-radius': 6, 'circle-color': css('--accent'), 'circle-stroke-color': css('--panel'), 'circle-stroke-width': 2 } });

  for (const id of ['obstacles', 'sites', 'power']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  $('loading').remove();
  scene = createScene(map, D, raw);
  setView('3d');
  if (!loadHash()) loadSample('magnolia');
});

function popup(e) {
  const p = e.features[0].properties;
  const html = p.agl_ft != null ? `<b>${p.name || p.kind}</b><br>${p.agl_ft} ft AGL${p.height_estimated === true || p.height_estimated === 'true' ? ' (height estimated)' : ''}<br>${p.src} ${p.id}`
    : p.voltage !== undefined ? `<b>Power line</b><br>${p.name || ''} ${p.voltage ? p.voltage + ' V' : ''}` : `<b>${p.name}</b><br>${p.kind} · ${p.src}`;
  new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

// ---------- Route drawing ----------
map.on('click', e => {
  // While a route is being drawn every click is a waypoint; otherwise a click on a feature inspects it.
  const drawing = state.route.length && !state.finished;
  const hit = !drawing && map.queryRenderedFeatures(e.point, { layers: ['obstacles', 'sites', 'power'].filter(id => map.getLayoutProperty(id, 'visibility') !== 'none') });
  if (hit && hit.length) return popup({ features: hit, lngLat: e.lngLat });
  if (state.finished) { state.route = []; state.finished = false; }
  state.route.push([e.lngLat.lng, e.lngLat.lat]); score();
});
map.on('dblclick', e => { e.preventDefault(); if (state.route.length > 1) { state.finished = true; score(); } });
$('undo').onclick = () => { state.route.pop(); state.finished = false; score(); };
$('clear').onclick = () => { state.route = []; state.finished = false; score(); };
$('route').onchange = e => e.target.value && loadSample(e.target.value);
// The URL hash carries the route and settings, so a link reproduces the exact analysis.
function saveHash() {
  if (!state.finished || state.route.length < 2) return;
  const q = new URLSearchParams({ r: state.route.map(p => p.map(x => x.toFixed(5)).join(',')).join(';'), ac: $('aircraft').value, alt: $('alt').value, w: $('wind').value, t: $('tod').value });
  history.replaceState(null, '', '#' + q.toString());
}
function loadHash() {
  const q = new URLSearchParams(location.hash.slice(1)), r = q.get('r');
  if (!r) return false;
  const pts = r.split(';').map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
  if (pts.length < 2) return false;
  for (const [k, id] of [['ac', 'aircraft'], ['alt', 'alt'], ['w', 'wind'], ['t', 'tod']]) if (q.get(k) && $(id).querySelector(`option[value="${q.get(k)}"]`)) $(id).value = q.get(k);
  state.route = pts; state.finished = true;
  map.fitBounds(pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: 80, maxZoom: 15 });
  $('wind').value === 'live' ? $('wind').dispatchEvent(new Event('change')) : score();
  return true;
}
$('share').onclick = async () => {
  if (!state.finished) return toast('Finish a route first (double-click)');
  saveHash();
  try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast('Copy the address bar to share'); }
};
function loadSample(id) {
  const R = ROUTES.find(r => r.id === id);
  state.route = R.path.map(p => p.slice()); state.finished = true;
  $('aircraft').value = R.aircraft; $('alt').value = R.altFt; $('route').value = id;
  score();
}
['aircraft', 'alt', 'tod'].forEach(id => $(id).addEventListener('change', score));
$('wind').addEventListener('change', async () => {
  if ($('wind').value === 'live' && !liveWind) {
    try {
      const o = (await (await fetch('https://api.weather.gov/stations/KBFI/observations/latest')).json()).properties;
      const kt = (o.windSpeed.value ?? 0) / 1.852, gust = o.windGust.value ? o.windGust.value / 1.852 : kt;
      liveWind = { kt: Math.round(kt), dir: o.windDirection.value ?? 0, g: Math.min(0.6, Math.max(0.1, (gust - kt) / Math.max(kt, 1))), at: o.timestamp };
      $('wind').querySelector('[value=live]').textContent = `Wind ${liveWind.kt} kt from ${liveWind.dir}° (KBFI ${new Date(o.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    } catch { toast('Could not reach api.weather.gov; using typical wind'); $('wind').value = 'typical'; }
  }
  score();
});
const wind = () => ($('wind').value === 'live' && liveWind) || WIND_PRESETS[$('wind').value] || WIND_PRESETS.typical;

const applyLayer = cb => { for (const id of LAYERS[cb.dataset.layer]) map.getLayer(id) && map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none'); };
document.querySelectorAll('[data-layer]').forEach(cb => cb.addEventListener('change', () => applyLayer(cb)));

// ---------- 3D sky / plan view ----------
// 3D draws the route, lane, footprints and airspace volumes with deck.gl; plan view uses the flat MapLibre layers and the layer toggles.
let scene = null, view = '3d';
const FLAT = ['laanc-line', 'laanc-label', 'obstacles', 'foot', 'noise', 'area-fill', 'area-line', 'routeSeg'];
function setView(v) {
  view = v;
  document.body.dataset.view = v;
  $('view').textContent = v === '3d' ? 'Plan view' : '3D sky';
  if (v === '3d') for (const id of FLAT) map.setLayoutProperty(id, 'visibility', 'none');
  else document.querySelectorAll('[data-layer]').forEach(applyLayer);
  map.setPaintProperty('density', 'raster-opacity', v === '3d' ? 0.12 : 0.75);
  scene.setVisible(v === '3d');
  map.easeTo(v === '3d' ? { pitch: 60, bearing: -20, duration: 800 } : { pitch: 0, bearing: 0, duration: 800 });
}
$('view').onclick = () => scene && setView(view === '3d' ? 'plan' : '3d');

// ---------- Scoring → map + rail + doc ----------
let lastTod = 'day';
function score() {
  const tod = $('tod').value;
  if (tod !== lastTod && map.getSource('density')) { map.getSource('density').updateImage({ url: densityImage(tod), coordinates: gridCorners() }); lastTod = tod; }
  state.result = state.route.length > 1 ? scoreRoute(D, state.route, { aircraft: $('aircraft').value, altFt: +$('alt').value, wind: wind(), tod }) : null;
  drawMap(); renderRail(); renderDoc(); saveHash();
  $('hint').textContent = state.route.length ? state.finished ? 'Route complete. Click the map to start a new one.' : 'Keep clicking. Double-click to finish.' : 'Click to place waypoints. Double-click to finish.';
}

function drawMap() {
  if (!map.getSource('wps')) return;
  const r = state.result;
  map.getSource('wps').setData(fc(state.route.map((c, i) => pt(c, { i }))));
  scene?.update(r, state.route);
  if (!r) { for (const id of ['area', 'noise', 'foot', 'routeSeg']) map.getSource(id).setData(fc([])); return; }
  const segs = [];
  for (let i = 0; i < r.samples.length - 1; i++) segs.push({ type: 'Feature', properties: { c: r.samples[i].c }, geometry: { type: 'LineString', coordinates: [r.samples[i].ll, r.samples[i + 1].ll] } });
  map.getSource('routeSeg').setData(fc(segs));
  map.getSource('foot').setData(fc(r.foot.map(p => pt(D.unproj(p)))));
  map.getSource('noise').setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: state.route } }]));
  map.setPaintProperty('noise', 'line-width', metresWidth(Math.max(4, 2 * r.halfWidth55)));
  const a = intendedArea(D, r);
  map.getSource('area').setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [a.ring] } }]));
}

const kv = (id, rows) => ($(id).innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''));
const n0 = x => Math.round(x).toLocaleString('en-US');
function renderRail() {
  const r = state.result;
  if (!r) { $('verdict').innerHTML = '<span class="pill warn">—</span><span>Draw a route</span>'; ['routeKv', 'riskKv', 'airKv', 'noiseKv', 'segbar', 'findings'].forEach(i => ($(i).innerHTML = '')); return; }
  const f = findings(r), v = verdict(f);
  $('verdict').innerHTML = `<span class="pill ${v}">Cat ${r.maxCat}</span><span>${v === 'crit' ? 'Not fileable as drawn' : v === 'warn' ? 'Fileable with mitigations' : 'Fileable'}</span>`;
  kv('routeKv', [['Corridor', corridorId(r)], ['Length', (r.lenM / 1000).toFixed(2) + ' km'], ['Flight time', r.minutes.toFixed(1) + ' min at ' + r.ac.spd + ' m/s'], ['Altitude', r.altFt + ' ft AGL'], ['Wind', `${r.wind.kt} kt from ${r.wind.dir}°`]]);
  const step = Math.max(1, Math.ceil(r.samples.length / 60));
  $('segbar').innerHTML = r.samples.filter((_, i) => i % step === 0).map(s => `<i class="c${s.c}" title="Cat ${s.c} · ${n0(s.d)} /km²"></i>`).join('');
  kv('riskKv', [['Peak density', n0(r.peakD) + ' /km²'], ['Mean density', n0(r.meanD) + ' /km²'], ['Under footprint (mean)', n0(r.meanUnder) + ' /km²'], ['Landings on dense ground', Math.round(r.hiFrac * 100) + '%'], ['Landings in water', Math.round(r.waterFrac * 100) + '%'], ['Fatalities / flight hr', r.ecPerFh.toExponential(1)], ['Footprint samples', r.foot.length.toLocaleString()]]);
  kv('airKv', [['In LAANC grids', Math.round(r.laancShare * 100) + '%'], ['Lowest ceiling', r.minCeiling == null ? '—' : r.minCeiling + ' ft'], ['Obstacles ≥ alt − 50 ft', r.obstacles.length], ['Transmission lines', r.powerlines.length], ['Airspace features', r.airspace.filter(a => !a.conditional).length]]);
  kv('noiseKv', [['Source level', r.ac.src + ' dB @ 1 m'], ['Directly below', Math.round(noiseAt(0, r.altFt, r.ac)) + ' dB'], ['55 dB half-width', n0(r.halfWidth55) + ' m'], ['Hospitals ≥ 55 dB', r.noiseSites.filter(s => s.kind === 'hospital').length], ['Schools ≥ 55 dB', r.noiseSites.filter(s => s.kind === 'school').length]]);
  $('findings').innerHTML = f.map(([c, t]) => `<li class="${c}">${t}</li>`).join('');
}

let doc = null;
function renderDoc() {
  const r = state.result;
  if (!r) { doc = null; $('docBody').innerHTML = '<p class="note">The package appears once a route is scored.</p>'; return; }
  doc = sections(D, r, intendedArea(D, r));
  $('docBody').innerHTML = toHTML(doc);
}
function save(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('dlMd').onclick = () => doc ? save(`${corridorId(state.result)}.md`, toMarkdown(doc), 'text/markdown') : toast('Draw a route first');
$('dlGeo').onclick = () => {
  const r = state.result; if (!r) return toast('Draw a route first');
  const a = intendedArea(D, r);
  save(`${corridorId(r)}.geojson`, JSON.stringify(fc([
    { type: 'Feature', properties: { role: 'route', corridor: corridorId(r), alt_ft_agl: r.altFt, aircraft: r.ac.name }, geometry: { type: 'LineString', coordinates: state.route } },
    { type: 'Feature', properties: { role: 'area_of_intended_flight', km2: +a.km2.toFixed(3) }, geometry: { type: 'Polygon', coordinates: [a.ring] } },
  ]), null, 1), 'application/geo+json');
};
$('print').onclick = () => print();
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 2000); }
