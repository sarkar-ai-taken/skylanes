// The 3D sky: deck.gl layers drawn into the MapLibre map, from the same layers and scores the planner uses.
// Heights are metres above ground (the basemap is flat), so 400 ft AGL sits at z = 122 m.
import { FT } from './engine.js';

const { MapboxOverlay, SolidPolygonLayer, PolygonLayer, PathLayer, ColumnLayer, ScatterplotLayer, LineLayer, TripsLayer,
  LightingEffect, AmbientLight, DirectionalLight } = deck;

const CAT = { 1: [95, 194, 122], 2: [152, 208, 127], 3: [224, 162, 74], 4: [232, 135, 82], 5: [226, 101, 90] };
const TEAL = [82, 201, 162], RED = [239, 107, 92], AMBER = [242, 184, 75], WHITE = [230, 235, 238];
// LAANC ceiling → colour: open sky teal, low ceilings amber, no auto-approval red.
const GLASS = { depthWriteEnabled: false, depthMask: false };
const ceilColor = c => (c === 0 ? RED : c <= 100 ? [235, 140, 80] : c <= 200 ? AMBER : c <= 300 ? [150, 200, 140] : TEAL);

const lighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.4 }),
  sun: new DirectionalLight({ color: [255, 244, 230], intensity: 1.6, direction: [-2, -3, -6] }),
});

/** Rectangles around each route segment, width w metres, as [lon, lat, z] rings. */
function ribbon(D, pts, w, z) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = D.proj(pts[i]), b = D.proj(pts[i + 1]), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / L * w / 2, ny = (b[0] - a[0]) / L * w / 2;
    out.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]].map(p => [...D.unproj(p), z]));
  }
  return out;
}

/** The route offset sideways by `side` metres at height z: the edges of the lane slab. */
function offset(D, pts, side, z) {
  return pts.map((p, i) => {
    const a = D.proj(pts[Math.max(0, i - 1)]), b = D.proj(pts[Math.min(pts.length - 1, i + 1)]), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, q = D.proj(p);
    return [...D.unproj([q[0] - (b[1] - a[1]) / L * side, q[1] + (b[0] - a[0]) / L * side]), z];
  });
}

export function createScene(map, D, raw) {
  const overlay = new MapboxOverlay({ interleaved: true, layers: [], effects: [lighting] });
  map.addControl(overlay);
  let r = null, route = [], visible = true, t0 = performance.now(), raf = 0;

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
    if (!r) return L;

    const pts = route, last = r.samples.length - 1;
    const air = r.samples.map(s => [...s.ll, alt]);
    // Ground: noise band and the area of intended flight.
    L.push(new SolidPolygonLayer({ id: 'noise3d', data: ribbon(D, pts, Math.max(8, 2 * r.halfWidth55), 0.5), getPolygon: d => d, getFillColor: [...TEAL, 28], parameters: GLASS }));
    // The lane: a translucent slab ±15 m around cruise altitude, as in the stacked-lane model.
    L.push(new SolidPolygonLayer({ id: 'lane', data: ribbon(D, pts, 60, alt - 15), getPolygon: d => d, extruded: true, getElevation: 30,
      getFillColor: [...TEAL, 30], material: { ambient: 0.9, diffuse: 0.2 }, parameters: GLASS }));
    L.push(new PathLayer({ id: 'lane-edges', data: [-1, 1].flatMap(sd => [alt - 15, alt + 15].map(z => offset(D, pts, sd * 30, z))), getPath: d => d, getColor: [...TEAL, 110], getWidth: 1, widthMinPixels: 1 }));
    // Failure fall lines from the route to each simulated landing, and the landings glowing on the ground.
    const fall = r.foot.map((p, i) => ({ s: [...D.unproj(r.footFrom[i]), alt], t: [...D.unproj(p), 0.5] }));
    L.push(new LineLayer({ id: 'fall', data: fall.filter((_, i) => i % 3 === 0), getSourcePosition: d => d.s, getTargetPosition: d => d.t, getColor: [...RED, 55], getWidth: 1, parameters: GLASS }));
    L.push(new ScatterplotLayer({ id: 'landings', data: fall, getPosition: d => d.t, getRadius: 6, radiusMinPixels: 1.5, getFillColor: [...RED, 150] }));
    // Route: climb at launch, cruise coloured by FAA category, descend at the drop.
    const segs = [];
    for (let i = 0; i < last; i++) segs.push({ path: [air[i], air[i + 1]], c: r.samples[i].c });
    const legs = [[[...r.samples[0].ll, 0], air[0]], [air[last], [...r.samples[last].ll, 0]]];
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
    raf = r && !matchMedia('(prefers-reduced-motion: reduce)').matches ? requestAnimationFrame(frame) : 0;
  }
  const kick = () => { cancelAnimationFrame(raf); frame(performance.now()); };

  return {
    update(result, path) { r = result; route = path; t0 = performance.now(); kick(); },
    setVisible(v) { visible = v; if (!v) { cancelAnimationFrame(raf); overlay.setProps({ layers: [] }); } else kick(); },
    tooltip: overlay,
  };
}
