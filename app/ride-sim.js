// Air-taxi flight along a lane route with virtual traffic signals at lane junctions. Pure and deterministic, so the
// ride page and the node tests fly the same trip: autopilot speed only, the pilot's steering never changes timing.
import { LANE_HALF } from './engine.js';

export const CRUISE_MS = 55, ACCEL = 1.2, BRAKE = 2.5, MIN_MS = 4; // m/s, m/s², m/s², creeping speed off the pads
export { LANE_HALF }; // the lane is 80 m wide (defined once in the engine)
export const BAND = 30; // and 60 m (about 200 ft) tall around its level
// Each signal cycles green, amber, red; cross traffic at the junction gets the red share. Amber outlasts the time to
// brake from cruise (CRUISE_MS / BRAKE), so a taxi that cannot stop is through before red. It holds stopM before the gate.
export const SIGNAL = { cycle: 60, green: 28, amber: 12, stopM: 80 };

export function signalState(sig, t) {
  const ph = (((t + sig.offset) % SIGNAL.cycle) + SIGNAL.cycle) % SIGNAL.cycle;
  return ph < SIGNAL.green ? 'green' : ph < SIGNAL.green + SIGNAL.amber ? 'amber' : 'red';
}

/**
 * Signals at lane junctions (graph nodes where three or more lane pieces meet) within `near` metres of the route.
 * xy is the route in metres, densified, with arc lengths cum. Busiest junctions win, at least `spacing` apart,
 * none within `edge` of either pad (the taxi is still climbing or descending there).
 */
export function placeSignals(G, xy, cum, { spacing = 2000, edge = 1500, near = 60 } = {}) {
  const L = cum[cum.length - 1], found = [];
  G.nodes.forEach((n, id) => {
    const deg = G.adj.get(id).length;
    if (deg < 3) return;
    let best = Infinity, bi = -1;
    for (let i = 0; i < xy.length; i++) { const d = (xy[i][0] - n[0]) ** 2 + (xy[i][1] - n[1]) ** 2; if (d < best) { best = d; bi = i; } }
    if (best < near * near && cum[bi] > edge && cum[bi] < L - edge) found.push({ s: cum[bi], i: bi, deg });
  });
  found.sort((a, b) => b.deg - a.deg || a.s - b.s);
  const picked = [];
  for (const f of found) if (picked.every(p => Math.abs(p.s - f.s) >= spacing)) picked.push(f);
  return picked.sort((a, b) => a.s - b.s).map((p, k) => ({ id: k, s: p.s, i: p.i, deg: p.deg, offset: (Math.round(p.s / 10) * 37) % SIGNAL.cycle }));
}

/**
 * Fly L metres from time t0: accelerate to cruise, brake for the pad, and stop at a signal that is red, or amber
 * with room to stop. Returns the timeline [{ t, s }] (a point every 10 m or 1 s), arrival time T and seconds held.
 */
export function fly(L, signals = [], { t0 = 0, dt = 0.1 } = {}) {
  let t = t0, s = 0, v = MIN_MS, next = 0, stopping = false, wait = 0;
  const line = [{ t, s }];
  while (s < L && t - t0 < 36000) {
    while (next < signals.length && signals[next].s - SIGNAL.stopM < s - 0.01) { next++; stopping = false; }
    let cap = Math.min(CRUISE_MS, MIN_MS + Math.sqrt(2 * ACCEL * (L - s))), floor = MIN_MS;
    if (next < signals.length) {
      const sig = signals[next], gap = sig.s - SIGNAL.stopM - s, st = signalState(sig, t);
      if (st === 'green') stopping = false;
      // Amber with no room to stop: carry on through. Otherwise brake to hold at the stop point.
      else if (!stopping && st === 'amber' && v * v / (2 * BRAKE) > gap) next++;
      else stopping = true;
      if (stopping) { cap = Math.min(cap, Math.sqrt(2 * BRAKE * Math.max(0, gap))); floor = 0; }
    }
    v = Math.max(Math.min(floor, cap), Math.min(v + ACCEL * dt, cap));
    const stopAt = stopping ? signals[next].s - SIGNAL.stopM : Infinity;
    s = Math.min(L, s + v * dt, Math.max(s, stopAt));
    t += dt;
    if (v < 0.5) wait += dt;
    const p = line[line.length - 1];
    if (s - p.s >= 10 || t - p.t >= 1 || s >= L) line.push({ t, s });
  }
  return { line, T: t, wait };
}

// ---------- game mode: tilt the phone to fly ----------
export const TILT = { dead: 4, full: 25 }; // degrees from the held pose: ignored below dead, full input at full

/**
 * Roll and pitch (degrees) of the screen as the user sees it, from deviceorientation β, γ and the screen rotation.
 * Goes through the gravity vector, so it has no gimbal flip when a landscape phone is held near upright.
 * roll > 0: right edge down. pitch: 0 flat, 90 upright facing the user.
 */
export function screenTilt(beta, gamma, angle = 0) {
  const r = Math.PI / 180, b = beta * r, g = gamma * r, a = angle * r;
  const gx = Math.cos(b) * Math.sin(g), gy = -Math.sin(b), gz = -Math.cos(b) * Math.cos(g); // gravity in device axes
  const sx = gx * Math.cos(a) - gy * Math.sin(a), sy = gx * Math.sin(a) + gy * Math.cos(a);
  return { roll: Math.asin(Math.max(-1, Math.min(1, sx))) / r, pitch: Math.atan2(-sy, -gz) / r };
}

/** Stick input in [-1, 1] from the tilt away from the held pose: x right, y climb (pull the top toward you). */
export function tiltInput(now, held, { dead, full } = TILT) {
  const axis = d => { const m = Math.abs(d); return m < dead ? 0 : Math.sign(d) * Math.min(1, (m - dead) / (full - dead)); };
  let dp = now.pitch - held.pitch; dp = ((dp + 540) % 360) - 180;
  return { x: axis(now.roll - held.roll), y: axis(dp) };
}
