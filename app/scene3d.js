// The 3D sky: deck.gl layers drawn into the MapLibre map, from the same layers and scores the planner uses.
// Heights are metres above ground (the basemap is flat), so 400 ft AGL sits at z = 122 m.
import { FT, TIERS, LANE_STATUS, rng } from './engine.js';

const { MapboxOverlay, SolidPolygonLayer, PolygonLayer, PathLayer, ColumnLayer, ScatterplotLayer, LineLayer, TripsLayer, TextLayer,
  LightingEffect, AmbientLight, DirectionalLight } = deck;

const CAT = { 1: [95, 194, 122], 2: [152, 208, 127], 3: [224, 162, 74], 4: [232, 135, 82], 5: [226, 101, 90] };
const TEAL = [82, 201, 162], RED = [239, 107, 92], AMBER = [242, 184, 75], WHITE = [230, 235, 238];
// LAANC ceiling → colour: open sky teal, low ceilings amber, no auto-approval red.
const GLASS = { depthWriteEnabled: false, depthMask: false };
// Lane status colours: open in the tier colour; blocked and Category 5 red; over the LAANC ceiling orange; inside Class B violet.
const STATUS_COLOR = { blocked: RED, ceiling: [235, 140, 80], cat5: RED, atc: [176, 140, 255] };
const HEADWAY_M = 500; // one aircraft per 500 m of lane at 100% traffic
const ceilColor = c => (c === 0 ? RED : c <= 100 ? [235, 140, 80] : c <= 200 ? AMBER : c <= 300 ? [150, 200, 140] : TEAL);

const lighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.4 }),
  sun: new DirectionalLight({ color: [255, 244, 230], intensity: 1.6, direction: [-2, -3, -6] }),
});

/** Rectangles around each route segment, width w metres, as [lon, lat, z] rings. z is one height or one per waypoint. */
function ribbon(D, pts, w, z) {
  const zs = Array.isArray(z) ? z : pts.map(() => z);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = D.proj(pts[i]), b = D.proj(pts[i + 1]), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / L * w / 2, ny = (b[0] - a[0]) / L * w / 2;
    out.push([[[a[0] + nx, a[1] + ny], zs[i]], [[b[0] + nx, b[1] + ny], zs[i + 1]], [[b[0] - nx, b[1] - ny], zs[i + 1]], [[a[0] - nx, a[1] - ny], zs[i]]].map(([p, h]) => [...D.unproj(p), h]));
  }
  return out;
}

/** The route offset sideways by `side` metres at height z: the edges of the lane slab. */
function offset(D, pts, side, z) {
  const zs = Array.isArray(z) ? z : pts.map(() => z);
  return pts.map((p, i) => {
    const a = D.proj(pts[Math.max(0, i - 1)]), b = D.proj(pts[Math.min(pts.length - 1, i + 1)]), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, q = D.proj(p);
    return [...D.unproj([q[0] - (b[1] - a[1]) / L * side, q[1] + (b[0] - a[0]) / L * side]), zs[i]];
  });
}

export function createScene(map, D, raw) {
  const overlay = new MapboxOverlay({ interleaved: true, layers: [], effects: [lighting] });
  map.addControl(overlay);
  let r = null, route = [], visible = true, t0 = performance.now(), raf = 0;

  // Sky lanes: pieces in 3D, each with metre lengths for placing traffic.
  const lanes = (raw.lanes || []).map(ln => {
    const z = ln.l / FT, xy = ln.p.map(q => D.proj(q)), cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    return { ...ln, p3: ln.p.map(q => [q[0], q[1], z]), xy, cum, len: cum[cum.length - 1], z, status: LANE_STATUS[ln.s], rev: TIERS[ln.t].levels.indexOf(ln.l) === 1 };
  });
  const net = { on: true, tiers: TIERS.map(() => true), pct: 25, shown: [], vehicles: [] };
  function refreshNet() {
    net.shown = net.on ? lanes.filter(ln => net.tiers[ln.t]) : [];
    // Traffic fills open lanes only: pct of capacity, placed by length, deterministic per setting.
    const open = net.shown.filter(ln => ln.status === 'open'), cap = open.reduce((a, ln) => a + Math.floor(ln.len / HEADWAY_M), 0);
    const n = Math.round(cap * net.pct / 100), rnd = rng(7), total = open.reduce((a, ln) => a + ln.len, 0);
    net.vehicles = [];
    for (let k = 0; k < n && total; k++) {
      let x = rnd() * total, i = 0; while (x > open[i].len) { x -= open[i].len; i++; }
      net.vehicles.push({ ln: open[i], off: x, spd: TIERS[open[i].t].spd * (0.85 + rnd() * 0.3) });
    }
    net.capacity = cap;
  }
  refreshNet();
  // Position along a lane piece at distance d (wrapping), as [lon, lat, z]; one-way per level.
  function along(ln, d) {
    let s = ((d % ln.len) + ln.len) % ln.len; if (ln.rev) s = ln.len - s;
    let i = 1; while (i < ln.cum.length - 1 && ln.cum[i] < s) i++;
    const f = (s - ln.cum[i - 1]) / ((ln.cum[i] - ln.cum[i - 1]) || 1), a = ln.p3[i - 1], b = ln.p3[i];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, ln.z];
  }
  const laneColor = (ln, a) => [...(STATUS_COLOR[ln.status] || TIERS[ln.t].color), a];

  // Static layers: built once.
  const ceilings = raw.airspace.facility_map.map(f => ({ poly: f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0], c: f.properties.ceiling_ft }));
  const cat5 = raw.airspace.operating_categories.filter(f => f.properties.category === 5).flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);
  const heli = raw.sites.filter(s => s.kind === 'heliport');
  const stadiums = raw.sites.filter(s => s.kind === 'stadium' && s.tfr);

  function layers(now) {
    const alt = r ? r.altFt / FT : 91;
    // Only obstacles the engine flagged for this route turn red.
    const hits = new Set(r ? r.obstacles.map(o => o.id) : []);
    const L = [
      new SolidPolygonLayer({ id: 'cat5', data: cat5, getPolygon: d => d, getFillColor: [...RED, 26], extruded: false, parameters: GLASS }),
      // Controlled airspace: a glass block per facility map cell, as tall as its LAANC ceiling.
      new PolygonLayer({ id: 'ceilings', data: ceilings, getPolygon: d => d.poly, extruded: true, wireframe: true, stroked: false,
        getElevation: d => Math.max(2, d.c / FT), getFillColor: d => [...ceilColor(d.c), d.c === 0 ? 34 : 16], getLineColor: d => [...ceilColor(d.c), 110], parameters: GLASS,
        material: { ambient: 0.6, diffuse: 0.4, shininess: 0 }, pickable: true }),
      // Obstacles as thin columns at true height; red where they reach the planned altitude.
      new ColumnLayer({ id: 'obstacles3d', data: raw.obstacles, diskResolution: 8, extruded: true,
        getPosition: o => [o.lon, o.lat],
        getFillColor: o => (hits.has(o.id) ? [...RED, 240] : [...WHITE, 70]), getElevation: o => o.agl_ft / FT, radius: 6, updateTriggers: { getFillColor: [r?.lenM, r?.altFt] }, pickable: true }),
      // Heliports: an 800 m screening column up to 500 ft, like the vertiport ramps in the scenario model.
      new ColumnLayer({ id: 'heli', data: heli, diskResolution: 48, radius: 800, extruded: true, wireframe: true, filled: true,
        getPosition: s => [s.lon, s.lat], getElevation: 152, getFillColor: [...RED, 5], getLineColor: [...RED, 55], parameters: GLASS, pickable: true }),
    ];
    if (r?.tod === 'event') L.push(new ColumnLayer({ id: 'tfr', data: stadiums, diskResolution: 64, radius: 5556, extruded: true, wireframe: true,
      getPosition: s => [s.lon, s.lat], getElevation: 914, getFillColor: [...AMBER, 10], getLineColor: [...AMBER, 50], parameters: GLASS }));
    if (net.shown.length) {
      L.push(new PathLayer({ id: 'lanes-slab', data: net.shown, getPath: ln => ln.p3, getColor: ln => laneColor(ln, ln.status === 'open' ? 34 : 46), getWidth: 36, widthMinPixels: 2, parameters: GLASS, updateTriggers: { getColor: net.shown.length } }));
      L.push(new PathLayer({ id: 'lanes-core', data: net.shown, getPath: ln => ln.p3, getColor: ln => laneColor(ln, ln.status === 'open' ? 170 : 210), getWidth: 2, widthMinPixels: 1, parameters: GLASS }));
    }
    if (net.vehicles.length) {
      const sec = (now - t0) / 1000;
      const heads = net.vehicles.map(v => ({ v, p: along(v.ln, v.off + v.spd * sec), q: along(v.ln, v.off + v.spd * (sec - 4)) }));
      L.push(new LineLayer({ id: 'traffic-trail', data: heads.filter(h => Math.hypot(h.p[0] - h.q[0], h.p[1] - h.q[1]) < 0.01), getSourcePosition: h => h.q, getTargetPosition: h => h.p,
        getColor: h => [...TIERS[h.v.ln.t].color, 150], getWidth: 2, parameters: GLASS }));
      L.push(new ScatterplotLayer({ id: 'traffic', data: heads, getPosition: h => h.p, getRadius: 9, radiusMinPixels: 2, getFillColor: h => [...TIERS[h.v.ln.t].color.map(c => Math.min(255, c + 60)), 255] }));
    }
    if (!r) return L;

    const pts = route, last = r.samples.length - 1;
    const air = r.samples.map(s => [...s.ll, s.alt / FT]);
    // Ground: noise band and the area of intended flight.
    L.push(new SolidPolygonLayer({ id: 'noise3d', data: ribbon(D, pts, Math.max(8, 2 * r.halfWidth55), 0.5), getPolygon: d => d, getFillColor: [...TEAL, 28], parameters: GLASS }));
    // The lane: a translucent slab ±15 m around cruise altitude, as in the stacked-lane model.
    const wz = r.alts.map(a => a / FT);
    L.push(new SolidPolygonLayer({ id: 'lane', data: ribbon(D, pts, 60, wz.map(z => z - 15)), getPolygon: d => d, extruded: true, getElevation: 30,
      getFillColor: [...TEAL, 30], material: { ambient: 0.9, diffuse: 0.2 }, parameters: GLASS }));
    L.push(new PathLayer({ id: 'lane-edges', data: [-1, 1].flatMap(sd => [-15, 15].map(dz => offset(D, pts, sd * 30, wz.map(z => z + dz)))), getPath: d => d, getColor: [...TEAL, 110], getWidth: 1, widthMinPixels: 1 }));
    // Buildings the route reaches, outlined in red over the basemap's own extrusion.
    const struck = r.buildings.filter(b => b.dm < r.opt.clearM); // inside the 30 m clearance and within 50 ft of the route's level
    L.push(new PolygonLayer({ id: 'struck', data: struck, getPolygon: b => b.ring, extruded: true, wireframe: true, getElevation: b => b.h_ft / FT + 1,
      getFillColor: [...RED, 120], getLineColor: [...RED, 255], parameters: GLASS, pickable: true }));
    // Waypoint levels, written in the air.
    L.push(new TextLayer({ id: 'levels', data: pts.map((p, i) => ({ p: [p[0], p[1], wz[i] + 22], t: `${r.alts[i]} ft`, show: i === 0 || i === pts.length - 1 || r.alts[i] !== r.alts[i - 1] })).filter(d => d.show), getPosition: d => d.p, getText: d => d.t,
      getSize: 12, getColor: [...WHITE, 240], background: true, getBackgroundColor: [18, 25, 32, 210], backgroundPadding: [4, 2], fontFamily: 'IBM Plex Mono, monospace', billboard: true }));
    // Failure fall lines from the route to each simulated landing, and the landings glowing on the ground.
    const fall = r.foot.map((p, i) => ({ s: [...D.unproj(r.footFrom[i][0]), r.footFrom[i][1] / FT], t: [...D.unproj(p), 0.5] }));
    L.push(new LineLayer({ id: 'fall', data: fall.filter((_, i) => i % 3 === 0), getSourcePosition: d => d.s, getTargetPosition: d => d.t, getColor: [...RED, 55], getWidth: 1, parameters: GLASS }));
    L.push(new ScatterplotLayer({ id: 'landings', data: fall, getPosition: d => d.t, getRadius: 6, radiusMinPixels: 1.5, getFillColor: [...RED, 150] }));
    // Route: climb at launch, cruise coloured by FAA category, descend at the drop.
    const segs = [];
    for (let i = 0; i < last; i++) segs.push({ path: [air[i], air[i + 1]], c: r.samples[i].c });
    const legs = [[[...r.samples[0].ll, 0], air[0]], [air[last], [...r.samples[last].ll, 0]], ...pts.slice(1, -1).map((p, i) => [[p[0], p[1], 0], [p[0], p[1], wz[i + 1]]])];
    L.push(new PathLayer({ id: 'route-glow', data: segs, getPath: d => d.path, getColor: d => [...CAT[d.c], 90], getWidth: 24, widthMinPixels: 8, capRounded: true, parameters: GLASS }));
    L.push(new PathLayer({ id: 'route', data: segs, getPath: d => d.path, getColor: d => [...CAT[d.c], 255], getWidth: 4, widthMinPixels: 2.5, capRounded: true }));
    L.push(new PathLayer({ id: 'legs', data: legs, getPath: d => d, getColor: [...WHITE, 200], getWidth: 2, widthMinPixels: 1.5, getDashArray: [4, 3] }));
    L.push(new ScatterplotLayer({ id: 'pads', data: [r.samples[0].ll, r.samples[last].ll], getPosition: d => d, getRadius: 30, getFillColor: [...TEAL, 120], getLineColor: [...TEAL, 255], stroked: true, lineWidthMinPixels: 1.5 }));
    // A drone flying the corridor on a loop, with a light trail.
    const T = r.minutes * 60, loop = T + 6, t = ((now - t0) / 1000 * Math.max(1, T / 20)) % loop;
    const times = r.samples.map(s => s.along / r.lenM * T);
    L.push(new TripsLayer({ id: 'trip', data: [{ path: air, times }], getPath: d => d.path, getTimestamps: d => d.times, getColor: [...WHITE, 255],
      getWidth: 8, widthMinPixels: 4, trailLength: T * 0.25, parameters: GLASS, currentTime: t, capRounded: true }));
    const k = times.findIndex(x => x > t), head = k <= 0 ? (t >= T ? null : air[0]) : air[k - 1];
    if (head) L.push(new ScatterplotLayer({ id: 'drone', data: [head], getPosition: d => d, getRadius: 14, radiusMinPixels: 4, getFillColor: [255, 255, 255, 255],
      getLineColor: [...TEAL, 160], stroked: true, lineWidthMinPixels: 6 }));
    return L;
  }

  function frame(now) {
    if (!visible) return;
    overlay.setProps({ layers: layers(now) });
    const moving = r || net.vehicles.length;
    raf = moving && !matchMedia('(prefers-reduced-motion: reduce)').matches ? requestAnimationFrame(frame) : 0;
  }
  const kick = () => { cancelAnimationFrame(raf); frame(performance.now()); };

  return {
    update(result, path) { r = result; route = path; t0 = performance.now(); kick(); },
    setVisible(v) { visible = v; if (!v) { cancelAnimationFrame(raf); overlay.setProps({ layers: [] }); } else kick(); },
    tooltip: overlay,
    /** on/off, per-tier visibility, traffic percent. Returns vehicles airborne and capacity. */
    setNetwork({ on = net.on, tiers = net.tiers, pct = net.pct } = {}) { Object.assign(net, { on, tiers, pct }); refreshNet(); kick(); return { airborne: net.vehicles.length, capacity: net.capacity }; },
  };
}
