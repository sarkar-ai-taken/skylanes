// Air-taxi ride: plan a trip on the air-taxi lanes between concept vertiports, then fly it with a chase, cabin or
// orbit camera over the real 3D city. All geometry comes from the same lanes and engine as the planner.
import { loadData, createMap, nav } from './base.js';
import { FT, TIERS, laneGraph, routeOnLanes } from './engine.js';
import { createScene } from './scene3d.js';
import { VERTIPORTS } from './vertiports.js';
import { mountExpand } from './expand.js';

const $ = id => document.getElementById(id);
$('nav').innerHTML = nav('ride');
mountExpand($('expand'), 'ride');

const [{ raw, D }, map] = await Promise.all([loadData(), createMap('map', { center: [-122.34, 47.62], zoom: 12.6, pitch: 70, bearing: -20 })]);
try { map.setSky({ 'sky-color': '#13213a', 'horizon-color': '#e0905c', 'fog-color': '#0b1016', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 }); } catch { /* older style spec */ }
const scene = createScene(map, D, raw, { consumer: true });
scene.setNetwork({ on: true, tiers: [true, true, true], pct: 40 });
$('loading').style.opacity = 0; setTimeout(() => $('loading').remove(), 500);

const TAXI = 1, CRUISE_MS = 55, ACCEL = 1.2, LIFT_M = 30, VSPEED = 3; // tier index, m/s, m/s², vertical lift height and rate
const graphs = Object.fromEntries(TIERS[TAXI].levels.map(l => [l, laneGraph(D, raw.lanes, TAXI, l)]));

// ---------- booking ----------
const opts = VERTIPORTS.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
$('from').innerHTML = opts; $('to').innerHTML = opts;
const q = new URLSearchParams(location.hash.slice(1));
$('from').value = VERTIPORTS.some(v => v.id === q.get('from')) ? q.get('from') : 'northgate';
$('to').value = VERTIPORTS.some(v => v.id === q.get('to')) ? q.get('to') : 'sodo';

let trip = null;
function plan() {
  const A = VERTIPORTS.find(v => v.id === $('from').value), B = VERTIPORTS.find(v => v.id === $('to').value);
  if (A === B) { $('qAir').textContent = '–'; $('qCar').textContent = '–'; $('qNote').textContent = 'Pick two different vertiports.'; trip = null; return; }
  // One level per direction: east- and northbound at the lower level, the rest at the upper.
  const [ax, ay] = D.proj(A.at), [bx, by] = D.proj(B.at), brg = (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
  const level = brg < 180 ? TIERS[TAXI].levels[0] : TIERS[TAXI].levels[1];
  const R = routeOnLanes(D, graphs[level], A.at, B.at);
  trip = build(A, B, R, level);
  // Road ≈ 1.35 × straight line. Average speed rises with distance as more of the trip is freeway:
  // about 26 km/h across town, up to 50 km/h for 20 km and more, plus 4 min to park.
  const km = trip.direct * 1.35 / 1000, carMin = Math.round(km / Math.min(50, 20 + 1.5 * km) * 60 + 4);
  trip.carMin = carMin;
  $('qAir').textContent = `${Math.round(trip.T / 60)} min`;
  $('qCar').textContent = `~${carMin} min`;
  $('qNote').textContent = `${(trip.L / 1000).toFixed(1)} km at ${level.toLocaleString()} ft, ${R.direct ? 'direct (no lane gets there sooner)' : `${Math.round(R.onLanesM / trip.L * 100)}% on air-taxi lanes`}. Car time is a rough estimate.`;
  history.replaceState(null, '', `#from=${A.id}&to=${B.id}`);
  drawPreview();
}
['from', 'to'].forEach(id => $(id).addEventListener('change', plan));

/** Densify the route every 10 m with height and time: vertical lift, eased climb, cruise, descent, vertical let-down. */
function build(A, B, R, level) {
  const xy = R.path.map(p => D.proj(p)), pts = [];
  for (let i = 0; i < xy.length - 1; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]) / 10));
    for (let k = 0; k < n; k++) pts.push([xy[i][0] + (xy[i + 1][0] - xy[i][0]) * k / n, xy[i][1] + (xy[i + 1][1] - xy[i][1]) * k / n]);
  }
  pts.push(xy[xy.length - 1]);
  const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = s[s.length - 1], zc = level / FT, climb = Math.min(1500, L * 0.3), desc = Math.min(1800, L * 0.35);
  const ease = x => x * x * (3 - 2 * x);
  const z = d => LIFT_M + (zc - LIFT_M) * Math.min(ease(Math.min(1, d / climb)), ease(Math.min(1, (L - d) / desc)));
  const v = d => Math.max(4, Math.min(CRUISE_MS, 4 + Math.sqrt(2 * ACCEL * d), 4 + Math.sqrt(2 * ACCEL * (L - d))));
  // timeline: [0, lift] vertical up, then along-track, then [.., +lift] vertical down
  const lift = LIFT_M / VSPEED, track = [{ s: 0, t: lift, p: [...D.unproj(pts[0]), z(0)] }];
  for (let i = 1; i < pts.length; i++) track.push({ s: s[i], t: track[i - 1].t + (s[i] - s[i - 1]) / v((s[i] + s[i - 1]) / 2), p: [...D.unproj(pts[i]), z(s[i])] });
  const T = track[track.length - 1].t + lift;
  const direct = Math.hypot(D.proj(B.at)[0] - D.proj(A.at)[0], D.proj(B.at)[1] - D.proj(A.at)[1]);
  return { A, B, R, level, track, L, T, lift, direct, path3: track.map(k => k.p), times: track.map(k => k.t) };
}

/** Where the taxi is at time t: position [lon, lat, z], heading (deg), speed (m/s), distance flown, phase. */
function stateAt(t) {
  const k = trip.track, last = k[k.length - 1];
  if (t <= trip.lift) return { p: [k[0].p[0], k[0].p[1], LIFT_M * t / trip.lift], i: 0, spd: 0, vs: VSPEED, done: 0, phase: 'Lift-off' };
  if (t >= last.t) { const f = Math.min(1, (t - last.t) / trip.lift); return { p: [last.p[0], last.p[1], LIFT_M * (1 - f)], i: k.length - 1, spd: 0, vs: -VSPEED, done: trip.L, phase: f >= 1 ? 'Arrived' : 'Landing' }; }
  let lo = 0, hi = k.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
  const f = (t - k[lo].t) / (k[hi].t - k[lo].t), p = k[lo].p.map((x, j) => x + (k[hi].p[j] - x) * f);
  const spd = (k[hi].s - k[lo].s) / (k[hi].t - k[lo].t), d = k[lo].s + (k[hi].s - k[lo].s) * f;
  const cruise = Math.abs(p[2] - trip.level / FT) < 3;
  return { p, i: lo, spd, done: d, phase: cruise ? 'Cruise' : d < trip.L / 2 ? 'Climb' : 'Descent' };
}

/** Unit direction of travel averaged over the next `ahead` metres, in metres east/north. */
function heading(i, ahead) {
  const k = trip.track, j = Math.min(k.length - 1, i + Math.max(1, Math.round(ahead / 10)));
  const a = D.proj(k[i].p), b = D.proj(k[j === i ? Math.min(k.length - 1, i + 1) : j].p);
  const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
  return n < 1 && i > 0 ? heading(i - 1, ahead) : [dx / n, dy / n];
}
const offset = (p, dir, m, dz = 0) => { const q = D.proj(p); return [...D.unproj([q[0] + dir[0] * m, q[1] + dir[1] * m]), p[2] + dz]; };

// ---------- vehicle: a low-poly eVTOL mesh (fuselage, wing, tail, six rotors) ----------
function vehicleMesh() {
  const P = [], N = [];
  const box = (cx, cy, cz, sx, sy, sz) => {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const f = (a, b, c, d, n) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); for (let i = 0; i < 6; i++) N.push(...n); };
    f([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]); f([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]);
    f([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]); f([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);
    f([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]); f([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);
  };
  const disc = (cx, cy, cz, r) => { for (let i = 0; i < 12; i++) { const a = i / 12 * 2 * Math.PI, b = (i + 1) / 12 * 2 * Math.PI; P.push(cx, cy, cz, cx + r * Math.cos(a), cy + r * Math.sin(a), cz, cx + r * Math.cos(b), cy + r * Math.sin(b), cz); for (let j = 0; j < 3; j++) N.push(0, 0, 1); } };
  box(0, 0, 0, 1.9, 7.5, 1.7);       // fuselage, nose toward +y
  box(0, 3.4, -0.2, 1.4, 1.2, 1.2);  // nose
  box(0, -0.4, 0.9, 13, 1.3, 0.22);  // wing
  box(0, -3.6, 0.9, 4.2, 0.9, 0.2);  // tail plane
  box(0, -3.6, 1.5, 0.2, 0.9, 1.3);  // fin
  for (const [x, y] of [[-6, 2.2], [6, 2.2], [-6, -2.6], [6, -2.6], [-3.4, 2.2], [3.4, 2.2]]) { box(x, y, 0.9, 0.25, 0.25, 0.6); disc(x, y, 1.25, 1.35); }
  return { attributes: { POSITION: { value: new Float32Array(P), size: 3 }, NORMAL: { value: new Float32Array(N), size: 3 } } };
}
const MESH = vehicleMesh(), SCALE = 2.2; // drawn about twice life size so it reads at chase distance

// ---------- flight loop ----------
let flying = false, t = 0, last = 0, speedX = 3, cam = 'chase', orbitA = 0;
const fmtMin = s => s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
function drawPreview() {
  if (!trip) return;
  scene.setExtra(now => tripLayers(null, now), true);
  const b = trip.path3.reduce((bb, p) => bb.extend([p[0], p[1]]), new maplibregl.LngLatBounds(trip.path3[0], trip.path3[0]));
  map.fitBounds(b, { padding: { top: 80, bottom: 80, left: Math.min(380, innerWidth * 0.4), right: 60 }, pitch: 60, bearing: -20, duration: 1200 });
}
function tripLayers(st, now) {
  const L = [];
  const blink = Math.floor(now / 500) % 2;
  L.push(new deck.PathLayer({ id: 'trip-lane', data: [trip.path3], getPath: d => d, getColor: [106, 169, 255, 60], getWidth: 40, widthMinPixels: 4, parameters: { depthWriteEnabled: false, depthMask: false } }));
  L.push(new deck.PathLayer({ id: 'trip-core', data: [trip.path3], getPath: d => d, getColor: [190, 220, 255, 200], getWidth: 2, widthMinPixels: 1.5 }));
  L.push(new deck.ScatterplotLayer({ id: 'pads', data: [trip.A.at, trip.B.at], getPosition: d => d, getRadius: 45, getFillColor: [106, 169, 255, 70], getLineColor: [106, 169, 255, 255], stroked: true, lineWidthMinPixels: 2 }));
  L.push(new deck.TextLayer({ id: 'pad-names', data: [trip.A, trip.B], getPosition: v => [...v.at, 60], getText: v => v.name, getSize: 13, getColor: [238, 242, 245, 255], background: true, getBackgroundColor: [14, 20, 27, 200], backgroundPadding: [6, 3], fontFamily: 'IBM Plex Sans, sans-serif' }));
  if (!st) return L;
  L.push(new deck.TripsLayer({ id: 'trail', data: [{ p: trip.path3, t: trip.times }], getPath: d => d.p, getTimestamps: d => d.t, getColor: [255, 255, 255, 230], getWidth: 3, widthMinPixels: 2, trailLength: 25, currentTime: t, capRounded: true }));
  const dir = heading(st.i, 40), yaw = Math.atan2(dir[0], dir[1]) * 180 / Math.PI;
  L.push(new deck.SimpleMeshLayer({ id: 'taxi', data: [st], mesh: MESH, getPosition: d => d.p, getOrientation: [0, -yaw, 0], getColor: [232, 238, 245, 255], sizeScale: SCALE,
    material: { ambient: 0.55, diffuse: 0.7, shininess: 48, specularColor: [200, 220, 255] } }));
  const wing = (m, side) => offset(st.p, [dir[1] * side, -dir[0] * side], m * SCALE, 0.9 * SCALE);
  L.push(new deck.ScatterplotLayer({ id: 'navlights', data: [{ p: wing(6.5, 1), c: [80, 255, 120] }, { p: wing(6.5, -1), c: [255, 70, 70] }, ...(blink ? [{ p: offset(st.p, dir, -4 * SCALE, 2 * SCALE), c: [255, 255, 255] }] : [])],
    getPosition: d => d.p, getFillColor: d => [...d.c, 255], getRadius: 0.7, radiusMinPixels: 2, radiusMaxPixels: 7, billboard: true }));
  return L;
}

function camera(st) {
  const dirNear = heading(st.i, 60), dirFar = heading(st.i, 300);
  let from, to;
  if (cam === 'cabin') { from = offset(st.p, dirNear, 4 * SCALE, 1.6 * SCALE); to = offset(st.p, dirFar, 600, -60); }
  else if (cam === 'orbit') { orbitA += 0.0035; const r = 220, q = D.proj(st.p); from = [...D.unproj([q[0] + r * Math.cos(orbitA), q[1] + r * Math.sin(orbitA)]), st.p[2] + 90]; to = st.p; }
  else { from = offset(st.p, dirFar, -150, 45); to = offset(st.p, dirNear, 80, -8); }
  // MapLibre's camera looks at a point on the ground, so aim at where the line of sight from `from` through `to`
  // meets the ground, no farther than the 84° pitch limit allows.
  const zf = Math.max(from[2], 8), f = D.proj(from), g = D.proj(to), drop = Math.max(0.5, zf - to[2]);
  const reach = Math.hypot(g[0] - f[0], g[1] - f[1]), k = Math.min(zf / drop, zf * Math.tan(84 * Math.PI / 180) / Math.max(reach, 1));
  const hit = D.unproj([f[0] + (g[0] - f[0]) * k, f[1] + (g[1] - f[1]) * k]);
  const o = map.calculateCameraOptionsFromTo(new maplibregl.LngLat(from[0], from[1]), zf, new maplibregl.LngLat(hit[0], hit[1]), 0);
  map.jumpTo({ ...o, pitch: Math.min(o.pitch, 85) });
}

function frame(now) {
  if (!flying) return;
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
  t += dt * speedX;
  const st = stateAt(t);
  camera(st);
  const togo = Math.max(0, trip.T - t);
  $('hPhase').textContent = st.phase;
  $('hAlt').textContent = Math.round(st.p[2] * FT).toLocaleString();
  $('hSpd').textContent = Math.round(st.spd * 1.944);
  $('hDist').textContent = ((trip.L - st.done) / 1000).toFixed(1);
  $('hEta').textContent = fmtMin(togo);
  if (st.phase === 'Arrived') return arrive();
  requestAnimationFrame(frame);
}
scene.setExtra(now => (trip ? tripLayers(flying ? stateAt(t) : null, now) : []), true);

function takeOff() {
  if (!trip) return;
  t = 0; last = 0; orbitA = 0; flying = true;
  document.body.classList.add('flying'); document.body.classList.remove('arrived');
  scene.setExtra(now => tripLayers(stateAt(t), now), true);
  requestAnimationFrame(frame);
}
function arrive() {
  flying = false;
  document.body.classList.remove('flying'); document.body.classList.add('arrived');
  const saved = trip.carMin - Math.round(trip.T / 60);
  $('aRoute').textContent = `${trip.A.name} → ${trip.B.name} · ${(trip.L / 1000).toFixed(1)} km at ${trip.level.toLocaleString()} ft`;
  $('aSaved').textContent = saved > 0 ? `${saved} min saved` : 'About the same as driving';
  $('aCompare').textContent = `${Math.round(trip.T / 60)} min by air taxi vs ~${trip.carMin} min by car (rough estimate, typical traffic).`;
}
$('go').onclick = takeOff;
$('abort').onclick = () => { flying = false; document.body.classList.remove('flying'); drawPreview(); };
$('again').onclick = () => { const a = $('from').value; $('from').value = $('to').value; $('to').value = a; plan(); document.body.classList.remove('arrived'); takeOff(); };
$('newtrip').onclick = () => { document.body.classList.remove('arrived'); drawPreview(); };
$('speed').onclick = () => { speedX = speedX === 1 ? 3 : speedX === 3 ? 6 : 1; $('speed').textContent = `Speed ${speedX}×`; };
document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => {
  cam = b.dataset.cam;
  document.querySelectorAll('[data-cam]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.cam === cam)));
  document.body.classList.toggle('cabinview', cam === 'cabin');
}));
window.skylanesRide = { map, get trip() { return trip; } }; // handle for debugging
plan();
