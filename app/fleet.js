// Fleet page: run the warehouse simulation, play it back in 3D, and chart the results.
import { loadData, createMap, nav, ensureBox } from './base.js';
import { FT } from './engine.js';
import { createScene } from './scene3d.js';
import { simulate, simBox, dronePos, REASONS, DEFAULT_PARAMS } from './fleet-sim.js';
import { stadiumEvents } from './live.js';
import { mountExpand } from './expand.js';

const $ = id => document.getElementById(id);
$('nav').innerHTML = nav('fleet');
mountExpand($('expand'), 'fleet');

// Industrial areas, not specific companies' sites.
const WAREHOUSES = [
  { id: 'interbay', name: 'Interbay', at: [-122.3790, 47.6450] },
  { id: 'ballard', name: 'Ballard industrial', at: [-122.3760, 47.6600] },
  { id: 'northgate', name: 'Northgate', at: [-122.3270, 47.7030] },
  { id: 'sodo', name: 'SoDo industrial', at: [-122.3335, 47.5745] },
  { id: 'georgetown', name: 'Georgetown', at: [-122.3200, 47.5470] },
  { id: 'kent', name: 'Kent valley', at: [-122.2350, 47.4050] },
  { id: 'redmond', name: 'Redmond', at: [-122.1400, 47.6650] },
  { id: 'issaquah', name: 'Issaquah', at: [-122.0300, 47.5480] },
  { id: 'everett', name: 'Everett', at: [-122.2050, 47.9200] },
  { id: 'fife', name: 'Fife / Tacoma port', at: [-122.3570, 47.2400] },
];
$('wh').innerHTML = WAREHOUSES.map(w => `<option value="${w.id}">${w.name}</option>`).join('') + '<option value="custom" hidden>Custom location</option>';

const [{ raw, D }, map] = await Promise.all([loadData(), createMap('map', { center: [-122.375, 47.641], zoom: 13.1, pitch: 60, bearing: -20 })]);
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const scene = createScene(map, D, raw, { consumer: true });
scene.setNetwork({ on: false });
const games = await stadiumEvents(30).then(r => r.events).catch(() => []);

// ---------- controls ----------
let warehouse = WAREHOUSES[0].at, placing = false;
const fmt = { fleet: v => v, rate: v => v, radius: v => `${v} km`, hours: v => `${v} h`, promise: v => `${v} min` };
const outs = { fleet: 'oFleet', rate: 'oRate', radius: 'oRadius', hours: 'oHours', promise: 'oPromise' };
for (const [id, o] of Object.entries(outs)) $(id).addEventListener('input', () => { $(o).textContent = fmt[id]($(id).value); schedule(); });
['aircraft', 'alt'].forEach(id => $(id).addEventListener('change', schedule));
$('wh').addEventListener('change', () => { const w = WAREHOUSES.find(x => x.id === $('wh').value); if (w) { warehouse = w.at; map.easeTo({ center: w.at, duration: 900 }); run(); } });
$('place').onclick = () => { placing = true; $('hint').textContent = 'Click the map to place the warehouse.'; map.getCanvas().style.cursor = 'crosshair'; };
map.on('click', e => {
  if (!placing) return;
  placing = false; map.getCanvas().style.cursor = '';
  warehouse = [e.lngLat.lng, e.lngLat.lat]; $('wh').value = 'custom';
  $('whNote').textContent = `${warehouse[1].toFixed(4)}, ${warehouse[0].toFixed(4)}`;
  run();
});
let timer = 0;
function schedule() { clearTimeout(timer); document.querySelector('.rail').classList.add('busy'); timer = setTimeout(run, 250); }

// ---------- run ----------
let sim = null, t = 0, playing = true, last = 0;
function run() {
  document.querySelector('.rail').classList.add('busy');
  setTimeout(async () => { // let the dimmed state paint before the work
    const params = { ...DEFAULT_PARAMS, warehouse, fleet: +$('fleet').value, ordersPerHour: +$('rate').value, radiusKm: +$('radius').value,
      hours: +$('hours').value, aircraft: $('aircraft').value, altFt: +$('alt').value, promiseMin: +$('promise').value };
    await ensureBox(D, simBox(D, params)); // census tiles under the service area
    sim = simulate(D, params, { events: games });
    t = 0; $('scrub').max = params.hours * 3600; $('scrub').value = 0;
    render();
    document.querySelector('.rail').classList.remove('busy');
    $('hint').textContent = 'Orders appear at real homes, weighted by census population.';
  }, 20);
}

const n0 = x => Math.round(x).toLocaleString('en-US');
const clock = s => { const m = DEFAULT_PARAMS.startHour * 60 + Math.floor(s / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
function render() {
  const m = sim.metrics;
  const tiles = [
    [n0(m.orders), 'orders'], [`${m.orders ? Math.round(m.delivered / m.orders * 100) : 0}%`, `delivered (${n0(m.delivered)})`],
    [m.medianMin != null ? `${m.medianMin.toFixed(0)} min` : '–', 'median to door'], [m.p90Min != null ? `${m.p90Min.toFixed(0)} min` : '–', '90th percentile'],
    [`${Math.round(m.busyShare * 100)}%`, 'fleet busy'], [n0(m.km), 'km flown'],
  ];
  $('kpis').innerHTML = tiles.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
  $('kpiNote').textContent = `${n0(m.rerouted)} delivered by climbing over or going around buildings; ${n0(m.lowered)} flown lower to stay under an airspace ceiling. ` +
    `Estimated ${m.fatalitiesPerMillion.toFixed(2)} ground fatalities per million deliveries at a 1e-4 per-hour failure rate.`;
  // refusal reasons: one hue, largest first, value at the bar tip
  const rs = Object.entries(m.refused).sort((a, b) => b[1] - a[1]), max = Math.max(1, ...rs.map(r => r[1]));
  $('reasons').innerHTML = rs.length ? '' : '<div class="note">None. Every order was delivered within the promise.</div>';
  for (const [k, v] of rs) {
    const el = document.createElement('div'); el.className = 'bar';
    el.innerHTML = `<span class="lab"></span><span class="val">${v} · ${Math.round(v / m.orders * 100)}%</span><span class="trk"><i style="width:${v / max * 100}%"></i></span>`;
    el.querySelector('.lab').textContent = REASONS[k];
    $('reasons').appendChild(el);
  }
  const B = m.buckets;
  charts.length = 0;
  lineChart($('chWait'), B, b => b.waiting, 'Orders waiting', 'in the queue at each quarter hour');
  columnChart($('chDone'), B, b => b.delivered, 'Deliveries', 'per 15 minutes');
  $('table').innerHTML = `<table><tr><th>Time</th><th>Orders</th><th>Delivered</th><th>Waiting</th></tr>${B.map(b => `<tr><td>${clock(b.t)}</td><td>${b.orders}</td><td>${b.delivered}</td><td>${b.waiting}</td></tr>`).join('')}</table>`;
  setNow();
}

// ---------- charts (single series: no legend box; title names it) ----------
const W = 360, Hh = 120, PAD = { l: 28, r: 8, t: 6, b: 18 };
function frame(el, title, sub, data, yMax) {
  el.innerHTML = `<div class="ttl">${title} <span class="sub">${sub}</span></div><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${title} ${sub}"></svg><div class="tip"></div>`;
  const svg = el.querySelector('svg'), ns = 'http://www.w3.org/2000/svg';
  const x = i => PAD.l + (i + 0.5) / data.length * (W - PAD.l - PAD.r), y = v => Hh - PAD.b - v / yMax * (Hh - PAD.t - PAD.b);
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
  for (const v of [0, yMax / 2, yMax]) {
    add('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 });
    add('text', { x: PAD.l - 4, y: y(v) + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--muted)', 'font-family': 'IBM Plex Mono' }, n0(v));
  }
  const ticks = data.length > 8 ? [0, Math.floor(data.length / 2), data.length - 1] : data.map((_, i) => i);
  for (const i of ticks) add('text', { x: x(i), y: Hh - 4, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--muted)', 'font-family': 'IBM Plex Mono' }, clock(data[i].t));
  const now = add('line', { y1: PAD.t, y2: Hh - PAD.b, stroke: 'var(--fg)', 'stroke-opacity': 0.35, 'stroke-width': 1 });
  return { svg, add, x, y, now, tip: el.querySelector('.tip') };
}
const niceMax = v => { const s = Math.max(4, v); const p = 10 ** Math.floor(Math.log10(s)); return Math.ceil(s / p * 2) / 2 * p; };
const charts = [];
function lineChart(el, data, val, title, sub) {
  const yMax = niceMax(Math.max(...data.map(val))), F = frame(el, title, sub, data, yMax);
  const pts = data.map((d, i) => `${F.x(i)},${F.y(val(d))}`).join(' ');
  F.add('polygon', { points: `${F.x(0)},${F.y(0)} ${pts} ${F.x(data.length - 1)},${F.y(0)}`, fill: 'var(--series)', 'fill-opacity': 0.1 });
  F.add('polyline', { points: pts, fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const peak = data.reduce((m, d, i) => (val(d) > val(data[m]) ? i : m), 0);
  F.add('circle', { cx: F.x(peak), cy: F.y(val(data[peak])), r: 4, fill: 'var(--series)', stroke: 'var(--panel)', 'stroke-width': 2 });
  F.add('text', { x: F.x(peak), y: F.y(val(data[peak])) - 8, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--fg)' }, `peak ${val(data[peak])}`);
  const hair = F.add('line', { y1: PAD.t, y2: Hh - PAD.b, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0 });
  hover(el, F, data, val, i => { hair.setAttribute('x1', F.x(i)); hair.setAttribute('x2', F.x(i)); hair.setAttribute('opacity', 1); }, () => hair.setAttribute('opacity', 0));
  charts.push(F);
}
function columnChart(el, data, val, title, sub) {
  const yMax = niceMax(Math.max(...data.map(val))), F = frame(el, title, sub, data, yMax);
  const bw = Math.min(24, (W - PAD.l - PAD.r) / data.length - 2), bars = [];
  data.forEach((d, i) => {
    const h = F.y(0) - F.y(val(d)), x0 = F.x(i) - bw / 2, r = Math.min(4, h, bw / 2);
    // 4px rounded data end, square at the baseline
    bars.push(F.add('path', { d: h > 0 ? `M${x0},${F.y(0)}V${F.y(val(d)) + r}Q${x0},${F.y(val(d))} ${x0 + r},${F.y(val(d))}H${x0 + bw - r}Q${x0 + bw},${F.y(val(d))} ${x0 + bw},${F.y(val(d)) + r}V${F.y(0)}Z` : '', fill: 'var(--series)' }));
  });
  hover(el, F, data, val, i => bars.forEach((b, j) => b.setAttribute('fill-opacity', j === i ? 1 : 0.55)), () => bars.forEach(b => b.setAttribute('fill-opacity', 1)));
  charts.push(F);
}
function hover(el, F, data, val, on, off) {
  const pick = e => { const r = F.svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * W; return Math.max(0, Math.min(data.length - 1, Math.round((vx - PAD.l) / (W - PAD.l - PAD.r) * data.length - 0.5))); };
  F.svg.addEventListener('pointermove', e => {
    const i = pick(e), r = F.svg.getBoundingClientRect();
    on(i);
    F.tip.innerHTML = '<b></b> <span></span>';
    F.tip.querySelector('b').textContent = val(data[i]);
    F.tip.querySelector('span').textContent = `at ${clock(data[i].t)}`;
    F.tip.style.left = `${F.x(i) / W * r.width}px`; F.tip.style.top = `${F.y(val(data[i])) / Hh * r.height + 22}px`; F.tip.style.opacity = 1;
  });
  F.svg.addEventListener('pointerleave', () => { off(); F.tip.style.opacity = 0; });
}
function setNow() { const i = Math.max(0, Math.min(sim.metrics.buckets.length - 1, t / 900 - 0.5)); for (const F of charts) { F.now.setAttribute('x1', F.x(i)); F.now.setAttribute('x2', F.x(i)); } }

// ---------- playback ----------
$('playBtn').onclick = () => { playing = !playing; $('playBtn').textContent = playing ? 'Pause' : 'Play'; last = 0; };
$('scrub').addEventListener('input', () => { t = +$('scrub').value; });
const GOOD = [82, 201, 162], WARN = [242, 184, 75], CRIT = [239, 107, 92];
function layers(now) {
  if (!sim) return [];
  const dt = last && playing ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
  t = Math.min(+$('scrub').max, t + dt * +$('pace').value);
  if (playing) $('scrub').value = t;
  const p = sim.params, L = [];
  // warehouse pad, service radius
  const ring = []; for (let a = 0; a <= 64; a++) { const c = D.proj(p.warehouse); ring.push(D.unproj([c[0] + p.radiusKm * 1000 * Math.cos(a / 32 * Math.PI), c[1] + p.radiusKm * 1000 * Math.sin(a / 32 * Math.PI)])); }
  L.push(new deck.PathLayer({ id: 'radius', data: [ring], getPath: d => d, getColor: [230, 235, 238, 70], getWidth: 2, widthMinPixels: 1 }));
  L.push(new deck.ColumnLayer({ id: 'warehouse', data: [p.warehouse], getPosition: d => d, diskResolution: 6, radius: 70, extruded: true, getElevation: 40, getFillColor: [...GOOD, 200], material: { ambient: 0.8 } }));
  // orders: waiting amber, delivered green fading over 20 minutes, refused red fading over 10
  const pins = [];
  for (const o of sim.orders) {
    if (o.t > t) break;
    if (o.refused) { const age = t - o.t; if (age < 600) pins.push({ at: o.at, c: CRIT, a: 230 * (1 - age / 600) }); }
    else if (o.door > t) pins.push({ at: o.at, c: WARN, a: 230 });
    else { const age = t - o.door; if (age < 1200) pins.push({ at: o.at, c: GOOD, a: 230 * (1 - age / 1200) }); }
  }
  L.push(new deck.ScatterplotLayer({ id: 'pins', data: pins, getPosition: d => d.at, getRadius: 28, radiusMinPixels: 4, getFillColor: d => [...d.c, d.a], stroked: true, getLineColor: [12, 17, 22, 200], lineWidthMinPixels: 1, updateTriggers: { getFillColor: t } }));
  // drones and short trails
  const air = [];
  for (const f of sim.flights) if (t >= f.out[0] && t <= f.ret[1]) { const pos = dronePos(D, f, t, p.altFt); if (pos) air.push({ pos, prev: dronePos(D, f, Math.max(f.out[0], t - 25), p.altFt) || pos, f }); }
  L.push(new deck.LineLayer({ id: 'trails', data: air, getSourcePosition: d => d.prev, getTargetPosition: d => d.pos, getColor: [255, 255, 255, 140], getWidth: 2 }));
  L.push(new deck.ScatterplotLayer({ id: 'drones', data: air, getPosition: d => d.pos, getRadius: 14, radiusMinPixels: 4, getFillColor: [255, 255, 255, 255], stroked: true, getLineColor: [...GOOD, 200], lineWidthMinPixels: 2 }));
  L.push(new deck.LineLayer({ id: 'tethers', data: air, getSourcePosition: d => d.pos, getTargetPosition: d => [d.pos[0], d.pos[1], 0], getColor: [255, 255, 255, 25], getWidth: 1 }));
  // counters and clock, a few times a second
  if (!layers.n || now - layers.n > 200) {
    layers.n = now;
    $('clock').textContent = clock(t);
    $('cAir').textContent = air.length;
    $('cWait').textContent = sim.orders.filter(o => !o.refused && o.t <= t && o.door > t).length;
    $('cDone').textContent = sim.orders.filter(o => o.door != null && o.door <= t).length;
    setNow();
  }
  return L;
}
scene.setExtra(layers, true);
window.skylanesFleet = { map, get sim() { return sim; } }; // handle for debugging
run();
