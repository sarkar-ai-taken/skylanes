// My address: geocode a typed address (OpenStreetMap Nominatim), a map click or the device location, then say which
// sky lanes run over or near it. The lane lookup is engine.lanesNear; only the typed address goes to a service (map
// tiles for the area still load from OpenFreeMap).
import { loadData, createMap, nav } from './base.js';
import { TIERS, LANE_HALF, lanesNear, trafficAt, trafficLevel } from './engine.js';

const $ = id => document.getElementById(id);
$('nav').innerHTML = nav('address');

const SHOW_M = 2000, SEARCH_M = 5000; // lanes drawn around the address; how far to look for the nearest one
const [{ raw, D }, map] = await Promise.all([loadData(['manifest', 'lanes', 'traffic']), createMap('map', { center: [-122.33, 47.61], zoom: 10.5, pitch: 35 })]);
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
$('loading').style.opacity = 0; setTimeout(() => $('loading').remove(), 400);
const [W, S, E, N] = D.manifest.bbox, inBox = ([lon, lat]) => lon >= W && lon <= E && lat >= S && lat <= N;
const lanes = raw.lanes, LB = lanes.map(ln => ln.p.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [180, 90, -180, -90]));

// ---------- map layers ----------
const rgb = c => `rgb(${c.join(',')})`, tierColor = ['match', ['get', 't'], ...TIERS.flatMap((T, i) => [i, rgb(T.color)]), '#888'];
const empty = { type: 'FeatureCollection', features: [] };
['lanes', 'rings', 'link'].forEach(id => map.addSource(id, { type: 'geojson', data: empty }));
const width = ['match', ['get', 't'], 0, 3, 1, 6, 9]; // personal widest and underneath, drone thin on top
map.addLayer({ id: 'lanes-open', type: 'line', source: 'lanes', filter: ['==', ['get', 's'], 0], layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['-', 2, ['get', 't']] }, paint: { 'line-color': tierColor, 'line-width': width, 'line-opacity': 0.85 } });
map.addLayer({ id: 'lanes-shut', type: 'line', source: 'lanes', filter: ['!=', ['get', 's'], 0], layout: { 'line-join': 'round', 'line-sort-key': ['-', 2, ['get', 't']] }, paint: { 'line-color': tierColor, 'line-width': width, 'line-opacity': 0.6, 'line-dasharray': [1.5, 1.2] } });
map.addLayer({ id: 'ring-fill', type: 'fill', source: 'rings', filter: ['==', ['get', 'k'], 'lane'], paint: { 'fill-color': '#e6ebee', 'fill-opacity': 0.12 } });
map.addLayer({ id: 'ring-line', type: 'line', source: 'rings', paint: { 'line-color': ['match', ['get', 'k'], 'lane', '#e6ebee', '#f2b84b'], 'line-width': ['match', ['get', 'k'], 'lane', 2, 1.2], 'line-dasharray': [2, 1.5] } });
map.addLayer({ id: 'link', type: 'line', source: 'link', paint: { 'line-color': '#e6ebee', 'line-width': 1.5, 'line-dasharray': [1, 1.5] } });
const marker = new maplibregl.Marker({ color: '#52c9a2' });
const pin = new maplibregl.Marker({ color: '#e6ebee', scale: 0.55 });

/** Circle of radius r metres around lonlat as a polygon ring. */
const circle = (ll, r, n = 64) => { const c = D.proj(ll); return [...Array(n + 1)].map((_, i) => D.unproj([c[0] + r * Math.cos(i / n * 2 * Math.PI), c[1] + r * Math.sin(i / n * 2 * Math.PI)])); };

// ---------- plain words ----------
const STATUS = {
  open: 'open', blocked: 'blocked by a tall structure at that level', ceiling: 'above the FAA LAANC ceiling here, so it needs further FAA approval',
  cat5: 'over Category 5 ground (dense crowds), so not flyable', atc: 'inside Seattle Class B airspace, so it needs air-traffic-control clearance',
};
const SHORT = { open: 'open', blocked: 'blocked', ceiling: 'over LAANC ceiling', cat5: 'Cat 5 ground', atc: 'needs ATC' };
const m = d => (d < 1000 ? `${Math.round(d / 10) * 10 || Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`);
const ft = l => `${l.toLocaleString()} ft`, and = a => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a[0]);
const loud = db => (db < 30 ? 'below a whisper' : db < 40 ? 'about a quiet library' : db < 50 ? 'about a quiet office or light rain' : db < 60 ? 'about normal conversation' : 'about a busy street');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The tier's closest level, and the levels that share its verdict. */
function tierSummary(T) {
  const hit = T.levels.filter(l => l.dist != null).sort((a, b) => a.dist - b.dist);
  if (!hit.length) return null;
  const v = hit[0].verdict, same = T.levels.filter(l => l.verdict === v && l.dist != null && l.dist - hit[0].dist < 1);
  return { best: hit[0], levels: same.map(l => l.level), statuses: [...new Set(same.map(levelText))] };
}
/** One level's status in words; overhead pieces of mixed status (junctions, run ends) name both. */
const levelText = e => (e.statuses.length > 1 ? `${STATUS[e.status]} here, ${and(e.statuses.filter(x => x !== e.status).map(x => SHORT[x]))} on the adjoining stretch` : STATUS[e.status]);
const statusText = (s, levels) => (s.statuses.length === 1 ? s.statuses[0] : and(levels.map(l => `${levelText(s.lv[l])} at ${ft(l)}`)));

function describe(R) {
  const [dr, ...future] = R.tiers, d = tierSummary(dr), out = { v: 'clear', big: '', lines: [] };
  if (d) d.lv = Object.fromEntries(dr.levels.map(l => [l.level, l]));
  if (d && d.best.verdict === 'overhead') {
    out.v = 'overhead';
    out.big = `Yes — a proposed drone lane in this plan runs over your address at ${and(d.levels.map(ft))}.`;
    out.lines.push(`The lane centreline is ${m(d.best.dist)} from you, inside its 40 m half-width. Here it is ${statusText(d, d.levels)}.`);
  } else if (d && d.best.verdict === 'nearby') {
    out.v = 'nearby';
    out.big = `Not overhead, but a proposed drone lane passes ${m(d.best.dist)} to the ${d.best.dir}.`;
    out.lines.push(`${d.best.db >= 55 ? `That is inside its noise footprint: drones on it at ${and(d.levels.map(ft))} would be clearly heard.` : `That is about a block away; it would fly at ${and(d.levels.map(ft))}.`} There it is ${statusText(d, d.levels)}.`);
  } else if (d) {
    out.big = `No lane overhead. The nearest proposed drone lane is ${m(d.best.dist)} to the ${d.best.dir}.`;
    out.lines.push(`It flies at ${and(d.levels.map(ft))} and is ${statusText(d, d.levels)} there.`);
  } else out.big = `No lane overhead. No drone lane within ${m(SEARCH_M)}.`;
  if (d) {
    out.lines.push(`If delivery drones flew it, one passing would be about ${Math.max(0, Math.round(d.best.db))} dB at your address, ${loud(d.best.db)}.`);
    const tr = D.traffic && trafficAt(D, D.proj(d.best.nearest), d.best.level);
    if (tr) out.lines.push(`Crewed aircraft at that height here (helicopters, small planes, historical ADS-B): ${trafficLevel(D, tr.rho, tr.band)} for the region.`);
  }
  const f = future.map(T => [T, tierSummary(T)]).filter(([, s]) => s && s.best.verdict !== 'clear');
  out.lines.push(f.length
    ? `2035 scenario: ${and(f.map(([T, s]) => `${s.best.verdict === 'overhead' ? 'an' : 'a nearby'} ${T.id === 'taxi' ? 'air-taxi' : 'personal-flight'} lane ${s.best.verdict === 'overhead' ? 'overhead' : `${m(s.best.dist)} ${s.best.dir}`} at ${and(s.levels.map(ft))}`))}, and one passing would be about ${Math.round(Math.max(...f.map(([, s]) => s.best.db)))} dB at your address. Only drone lanes are flyable today; the upper tiers are a planning scenario.`
    : 'No air-taxi or personal-flight lane over or near you in the 2035 planning scenario. Only drone lanes are flyable today.');
  return out;
}

// ---------- check a point ----------
/** Drop the previous answer, marker and hash so a failed lookup never shows a stale result. */
function clear() {
  $('answerSec').hidden = true; $('detailSec').hidden = true; marker.remove(); pin.remove();
  ['rings', 'link'].forEach(id => map.getSource(id).setData(empty));
  history.replaceState(null, '', location.pathname + location.search);
}
function fail(t) { clear(); say(t, true); }
/** caution: a line shown first, for a point only roughly known (coarse device location). */
function check(ll, label, caution) {
  if (!inBox(ll)) return fail(`That point is outside the Greater Seattle box this map covers (King, Pierce, Snohomish and Kitsap counties).`);
  const R = lanesNear(D, lanes, ll, { radiusM: SEARCH_M }), A = describe(R);
  if (caution) { if (A.v === 'overhead') A.big = A.big.replace('runs over your address', 'runs near this point'); A.lines.unshift(caution); }
  history.replaceState(null, '', `#at=${ll[1].toFixed(4)},${ll[0].toFixed(4)}`);
  $('answerSec').hidden = false; $('detailSec').hidden = false;
  $('answer').dataset.v = A.v;
  $('answer').innerHTML = `<div class="where">${esc(label)}</div><p class="big">${A.big}</p>${A.lines.map((t, i) => `<p${i === A.lines.length - 1 ? ' class="muted"' : ''}>${t}</p>`).join('')}`;
  $('detail').querySelector('tbody').innerHTML = R.tiers.flatMap(T => T.levels.map(l => `<tr><td><span class="sw" style="background:${rgb(TIERS[T.tier].color)}"></span>${T.id === 'drone' ? 'Drone' : T.id === 'taxi' ? 'Air taxi' : 'Personal'} ${ft(l.level)}</td>
    <td>${l.dist == null ? `> ${m(SEARCH_M)}` : `${m(l.dist)} ${l.dist > LANE_HALF ? l.dir : ''}`}</td><td>${l.status ? SHORT[l.status] : '–'}</td><td>${l.db == null ? '–' : `${Math.max(0, Math.round(l.db))} dB`}</td>
    <td><span class="tag ${l.verdict}">${l.verdict}</span></td></tr>`)).join('');
  draw(ll, R);
}

function draw(ll, R) {
  const [x, y] = ll, dLon = SHOW_M / (111320 * Math.cos(y * Math.PI / 180)), dLat = SHOW_M / 110574;
  const feats = [];
  lanes.forEach((ln, i) => { const b = LB[i]; if (b[2] >= x - dLon && b[0] <= x + dLon && b[3] >= y - dLat && b[1] <= y + dLat) feats.push({ type: 'Feature', properties: { t: ln.t, s: ln.s }, geometry: { type: 'LineString', coordinates: ln.p } }); });
  map.getSource('lanes').setData({ type: 'FeatureCollection', features: feats });
  const d = R.tiers[0].levels.filter(l => l.dist != null).sort((a, b) => a.dist - b.dist)[0];
  map.getSource('rings').setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { k: 'lane' }, geometry: { type: 'Polygon', coordinates: [circle(ll, LANE_HALF)] } },
    { type: 'Feature', properties: { k: 'near' }, geometry: { type: 'LineString', coordinates: circle(ll, R.tiers[0].levels[0].nearM) } }] });
  map.getSource('link').setData(d && d.dist > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [ll, d.nearest] } } : empty);
  marker.setLngLat(ll).addTo(map);
  if (d) pin.setLngLat(d.nearest).addTo(map); else pin.remove();
  const far = d && d.dist < SHOW_M ? Math.max(250, d.dist * 1.6) : 600, fx = far / (111320 * Math.cos(y * Math.PI / 180)), fy = far / 110574;
  map.fitBounds([[x - fx, y - fy], [x + fx, y + fy]], { padding: 40, maxZoom: 16.5, duration: 900 });
}

// ---------- input: typed address, map click, device location ----------
function say(t, err = false) { $('status').textContent = t; $('status').classList.toggle('err', err); }
function showMatches(list) {
  const ul = $('matches'); ul.hidden = list.length < 2;
  ul.innerHTML = list.map((r, i) => `<li><button type="button" data-i="${i}" aria-pressed="${i === 0}">${esc(r.display_name)}</button></li>`).join('');
  ul.querySelectorAll('button').forEach(b => b.onclick = () => {
    ul.querySelectorAll('button').forEach(o => o.setAttribute('aria-pressed', o === b));
    const r = list[+b.dataset.i]; check([+r.lon, +r.lat], r.display_name);
  });
}
let lastAsk = 0, ask = 0;
$('find').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q || $('go').disabled) return;
  $('go').disabled = true; const me = ++ask, at = lastAsk = Math.max(Date.now(), lastAsk + 1100); // Nominatim: one request a second
  say('Looking up the address…'); showMatches([]);
  if (at > Date.now()) await new Promise(r => setTimeout(r, at - Date.now()));
  try {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us&viewbox=${[W, N, E, S].join(',')}&bounded=1&accept-language=en&q=${encodeURIComponent(q)}`;
    const res = await fetch(u, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()).filter(r => inBox([+r.lon, +r.lat]));
    if (me !== ask) return;
    if (!list.length) return fail('No match inside Greater Seattle. Try adding the city, or click your home on the map.');
    say(list.length > 1 ? `${list.length} matches. Showing the first; pick another if it's wrong.` : '');
    showMatches(list); check([+list[0].lon, +list[0].lat], list[0].display_name);
  } catch { if (me === ask) fail('Could not reach the address service. Check your connection, or click your home on the map.'); }
  finally { $('go').disabled = false; }
});
map.on('click', e => { showMatches([]); say(''); check([e.lngLat.lng, e.lngLat.lat], `Map point ${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`); });
$('locate').onclick = () => {
  if (!navigator.geolocation) return fail('This browser cannot share its location.');
  say('Finding your location…'); $('locate').disabled = true;
  navigator.geolocation.getCurrentPosition(p => {
    $('locate').disabled = false; say(''); showMatches([]);
    const acc = Math.round(p.coords.accuracy);
    check([p.coords.longitude, p.coords.latitude], `Your location (±${acc} m)`, acc > 100 ? `Your location is only known to within ${m(acc)}, so this answer is for the area, not your home. Type your address or click your home for a precise answer.` : '');
  }, err => { $('locate').disabled = false; fail(err.code === 1 ? 'Location permission was declined.' : 'Could not get your location.'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
};

// A shared link carries rounded coordinates only, never the address text.
function fromHash() {
  const h = /^#at=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(location.hash);
  if (h) check([+h[2], +h[1]], `Shared point ${(+h[1]).toFixed(4)}, ${(+h[2]).toFixed(4)}`);
}
fromHash();
addEventListener('hashchange', fromHash); // replaceState does not fire this, so only a pasted or edited link re-runs
