// Remote ID walk logs: import what a phone heard (ASTM F3411 broadcast) and summarise the uncrewed traffic near a route.
// Pure ES module, no DOM. Formats, read from the apps' source:
//  odid    opendroneid/receiver-android debug log (log/LogWriter.java): one CSV row per received advert, raw F3411 integers,
//          timestamp = elapsedRealtimeNanos (time since phone boot, not wall clock), file log_<model>_<name>_<yyyy-MM-dd_HH-mm-ss.SSS>.csv
//  dscan   Dronetag Drone Scanner "Export Data" (lib/utils/csvlogger.dart): blocks per message pack, decoded values,
//          Dart DateTime strings in phone-local time, no RSSI; "export all" glues aircraft groups without a newline
//  json    records already normalised by this module (an array, or {records})
// Record: {t (ms UTC|null), id, idType, operatorId, lat, lon, altM (geodetic, WGS84), heightM, hRef ('ground'|'takeoff'),
//          speedMs, opLat, opLon, rssi (dBm|null), source, mac, uaType}

export const ID_TYPES = ['None', 'Serial_Number', 'CAA_Registration_ID', 'UTM_Assigned_ID', 'Specific_Session_ID'];
export const UA_TYPES = ['None', 'Aeroplane', 'Helicopter_or_Multirotor', 'Gyroplane', 'Hybrid_Lift', 'Ornithopter', 'Glider', 'Kite',
  'Free_balloon', 'Captive_balloon', 'Airship', 'Free_fall_parachute', 'Rocket', 'Tethered_powered_aircraft', 'Ground_obstacle', 'Other'];
const EPOCH19 = Date.UTC(2019, 0, 1), HOUR = 3600000, TZ = 'America/Los_Angeles';
const N_AUTH = 16, AUTH_W = 6, OP_W = 2, SYS_W = 12;                 // receiver-android Constants.MAX_AUTH_DATA_PAGES and csvHeader widths

// ---------- small helpers ----------
const num = s => { if (s == null || s === '') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
const str = s => (s == null ? '' : String(s)).replace(/\0/g, '').trim();
const enumName = s => str(s).replace(/^[A-Za-z]+\./, '');            // Dart enum toString: "IdType.Serial_Number"
const altOk = m => (m == null || m <= -1000 ? null : m);              // F3411: -1000 m = unknown
const llOk = (a, o) => (a == null || o == null || (a === 0 && o === 0) || Math.abs(a) > 90 || Math.abs(o) > 180 ? [null, null] : [a, o]);

/** RFC 4180 CSV (quotes, CRLF). Returns rows of strings. */
export function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** Offset (ms) of tz from UTC at instant ms. */
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** Wall-clock fields in tz -> UTC ms. */
export function localToUtc(y, mo, d, h, mi, s, ms, tz = TZ) {
  const g = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = g - tzOffset(g, tz);
  return g - tzOffset(t, tz);
}
const DART_RE = /^(-?\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z)?$/;
/** Dart DateTime.toString() (local unless it ends in Z). */
function dartTime(s, tz) {
  const m = DART_RE.exec(str(s)); if (!m) return null;
  const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
  return m[8] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms) : localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], ms, tz);
}
/** Start time from a receiver-android log file name, e.g. log_Pixel 7_ble_2026-10-20_17-29-58.120.csv (phone-local). */
export function startFromFilename(name, tz = TZ) {
  const m = /(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)\.(\d{3})/.exec(name || '');
  return m ? localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +m[7], tz) : null;
}
/** F3411 Location timestamp (1/10 s past the UTC hour) placed in the hour nearest a known instant. */
function snapToHour(tenths, near) {
  if (tenths == null || tenths > 36000 || near == null) return near;
  const base = Math.floor(near / HOUR) * HOUR + tenths * 100;
  return [base - HOUR, base, base + HOUR].reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a));
}

// ---------- format detection ----------
export function detectFormat(text) {
  const head = text.slice(0, 4000).replace(/^﻿/, '');
  if (/^\s*[[{]/.test(head)) return 'json';
  if (/^session,timestamp \(nanos\),transportType,macAddress/.test(head)) return 'odid';
  if (/^mac address\s*\r?\n/.test(head) || /\n(Location|BasicId) Message,/.test(head)) return 'dscan';
  return null;
}

/** Parse a Remote ID log. Returns the records array with .format and .warnings attached.
 *  opts: {tz, startMs (wall-clock ms at the first row, for logs without any time anchor), filename} */
export function parseRemoteIdLog(text, opts = {}) {
  text = String(text || '').replace(/^﻿/, '');
  const fmt = detectFormat(text), tz = opts.tz || TZ, warnings = [];
  const recs = fmt === 'odid' ? parseOdid(text, { ...opts, tz }, warnings) : fmt === 'dscan' ? parseDscan(text, { ...opts, tz }, warnings)
    : fmt === 'json' ? parseJson(text, warnings) : (warnings.push('unrecognised file: not a receiver-android log, a Drone Scanner export or Remote ID JSON'), []);
  recs.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  return Object.assign(recs, { format: fmt, warnings });
}

// Identity, operator and position arrive in separate messages (one per BT4 advert): fill each observation from the same transmitter.
function fillByMac(obs, ident) {
  const out = [];
  for (const [mac, list] of groupBy(obs, o => o.mac)) {
    const I = (ident.get(mac) || []).sort((a, b) => a.k - b.k), byF = new Map();
    // nearest entry in time carrying field f (the earlier one on a tie), by binary search over the k-sorted entries
    const pick = (k, f) => {
      const a = byF.get(f) || byF.set(f, I.filter(x => x[f] != null && x[f] !== '')).get(f); if (!a.length) return null;
      const lb = v => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].k < v) lo = m + 1; else hi = m; } return lo; };
      const i = lb(k), c = i ? a[lb(a[i - 1].k)] : null, b = a[i];
      return (b && (!c || b.k - k < k - c.k) ? b : c)[f];
    };
    for (const o of list) {
      if (o.id == null) o.id = pick(o.k, 'id'); if (o.idType == null) o.idType = pick(o.k, 'idType'); if (o.uaType == null) o.uaType = pick(o.k, 'uaType');
      if (o.operatorId == null) o.operatorId = pick(o.k, 'operatorId');
      if (o.opLat == null) { o.opLat = pick(o.k, 'opLat'); o.opLon = pick(o.k, 'opLon'); }
      out.push(o);
    }
  }
  return out;
}
const groupBy = (a, f) => a.reduce((m, x) => { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); return m; }, new Map());
const rec = o => ({ t: null, id: null, idType: null, operatorId: null, lat: null, lon: null, altM: null, heightM: null, hRef: null,
  speedMs: null, opLat: null, opLon: null, rssi: null, source: null, mac: null, uaType: null, ...o });

// ---------- opendroneid receiver-android ----------
function parseOdid(text, { tz, startMs, filename }, warnings) {
  const rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(','));
  const H = rows.shift(), W = H.length, at = n => H.indexOf(n);
  const iB = at('idType'), iL = at('status'), iS = at('descriptionType'), iSys = at('operatorLocationType');
  const obs = [], ident = new Map(); let anchors = [], bad = 0;
  for (const r of rows) {
    if (r.length < 7 || !/^\d+$/.test(r[1])) { bad++; continue; }
    // SelfID free text is written unquoted; a comma in it shifts everything after it. System/OperatorID/auth are fixed from the end.
    const sh = Math.max(0, r.length - W), g = (i, k) => r[i + k], gs = k => r[iSys + sh + k];
    const k = Number(r[1]) / 1e6, mac = r[3], tr = r[2], rssi = num(r[5]);
    const I = { k, mac };
    if (str(g(iB, 2))) Object.assign(I, { id: str(g(iB, 2)), idType: ID_TYPES[num(g(iB, 0))] ?? null, uaType: UA_TYPES[num(g(iB, 1))] ?? null });
    if (str(gs(0))) {
      const [a, o] = llOk(num(gs(2)) * 1e-7, num(gs(3)) * 1e-7); Object.assign(I, { opLat: a, opLon: o });
      const st = num(gs(11)); if (st > 0) anchors.push(EPOCH19 + st * 1000 - k);
    }
    if (str(r[iSys + sh + SYS_W + 1])) I.operatorId = str(r[iSys + sh + SYS_W + 1]);
    if (Object.keys(I).length > 2) (ident.get(mac) || ident.set(mac, []).get(mac)).push(I);
    if (str(g(iL, 0))) {
      const [lat, lon] = llOk(num(g(iL, 7)) * 1e-7, num(g(iL, 8)) * 1e-7), raw = num(g(iL, 5)), mult = num(g(iL, 3));
      const sp = raw == null || raw === 255 ? null : mult ? raw * 0.75 + 255 * 0.25 : raw * 0.25;
      const alt = v => (v == null ? null : altOk(v / 2 - 1000));
      obs.push(rec({ k, mac, lat, lon, altM: alt(num(g(iL, 10))), heightM: alt(num(g(iL, 11))), hRef: num(g(iL, 1)) ? 'ground' : 'takeoff',
        speedMs: sp, rssi: tr === 'NAN' ? null : rssi, source: 'opendroneid:' + tr, tenths: num(g(iL, 16)) }));
    } else if (I.id || I.opLat != null) obs.push(rec({ k, mac, rssi: tr === 'NAN' ? null : rssi, source: 'opendroneid:' + tr, identOnly: true }));
  }
  if (bad) warnings.push(`${bad} unreadable rows skipped`);
  // Wall clock: boot->UTC offset from System message timestamps (aircraft clock), else the file-name / given start time.
  anchors.sort((a, b) => a - b);
  let off = anchors.length ? anchors[anchors.length >> 1] : null;
  const st = startMs ?? startFromFilename(filename, tz), k0 = Math.min(...obs.map(o => o.k));
  if (off == null && st != null && obs.length) off = st - k0;
  if (off == null) warnings.push('no wall-clock anchor (no System message timestamp, no start time): times unknown');
  const out = fillByMac(obs, ident);
  // Location-less rows only matter for transmitters that never sent a position.
  const withPos = new Set(out.filter(o => !o.identOnly).map(o => o.mac));
  const seen = new Set();
  return out.filter(o => !o.identOnly || (!withPos.has(o.mac) && !seen.has(o.mac) && seen.add(o.mac))).map(o => {
    const t = off == null ? null : snapToHour(o.tenths, o.k + off);
    const { k, tenths, identOnly, ...r } = o; return { ...r, t };
  });
}

// ---------- Dronetag Drone Scanner CSV export ----------
function parseDscan(text, { tz, startMs }, warnings) {
  const rows = parseCSV(text);
  // "Export all" concatenates aircraft groups with no separator: the last cell of one group runs into "mac address".
  const fixed = [];
  for (const r of rows) {
    const last = r[r.length - 1];
    if (r.length > 1 && /mac address$/.test(last) && last !== 'mac address') { fixed.push([...r.slice(0, -1), last.slice(0, -11)], ['mac address']); }
    else fixed.push(r);
  }
  const packs = []; let p = null;
  for (let i = 0; i < fixed.length; i++) {
    const r = fixed[i], h = str(r[0]);
    if (h === 'mac address') { p = { mac: str((fixed[i + 1] || [])[0]) }; packs.push(p); i++; continue; }
    const m = /^(Location|BasicId|OperatorId|SelfId|Authentication|System Data) Message$/.exec(h);
    if (m && p) { const H = fixed[i + 1] || [], V = fixed[i + 2] || []; p[m[1]] = { src: enumName(r[1]), ...Object.fromEntries(H.map((k, j) => [str(k), V[j]])) }; i += 2; }
  }
  let lonBug = 0;
  const out = [];
  for (const P of packs) {
    const L = P.Location, B = P.BasicId, S = P['System Data'];
    const tRx = S ? dartTime(S.systemTimestamp, tz) : null;
    const r = rec({ mac: P.mac, source: 'dronescanner:' + ((L || B || S || {}).src || 'Unknown') });
    if (B) Object.assign(r, { id: str(B.uasId) || null, idType: enumName(B.idType) || null, uaType: enumName(B.uaType) || null });
    if (P.OperatorId) r.operatorId = str(P.OperatorId.operatorId) || null;
    if (S) [r.opLat, r.opLon] = llOk(num(S.operatorLatitude), num(S.operatorLongitude));
    if (L) {
      let lat = num(L.droneLat), lon = num(L.droneLon);
      if (lat != null && lat === lon && lat !== 0) { lon = null; lonBug++; }      // app <= 1.0 wrote latitude into droneLon
      [r.lat, r.lon] = llOk(lat, lon);
      r.altM = altOk(num(L.altitudeGeodetic)); r.heightM = altOk(num(L.height));
      r.hRef = /Ground/.test(L.heightType || '') ? 'ground' : L.heightType ? 'takeoff' : null;
      const sp = num(L.speedHori); r.speedMs = sp == null || sp >= 254.25 ? null : sp;
      // timestamp column = DateTime.fromMillisecondsSinceEpoch(1/10 s past the hour): only its sub-hour part carries information
      const lt = DART_RE.exec(str(L.timestamp));
      const tenths = lt ? ((+lt[5] * 60 + +lt[6]) * 1000 + (lt[7] ? Math.round(Number('0.' + lt[7]) * 1000) : 0)) % 900000 : null;
      r.t = snapToHour(tenths, tRx ?? startMs ?? null);
    } else r.t = tRx;
    if (L || B || S) out.push(r);
  }
  if (lonBug) warnings.push(`${lonBug} positions had droneLon = droneLat (Drone Scanner export bug before v1.5): longitude dropped`);
  if (out.some(r => r.t == null)) warnings.push(`${out.filter(r => r.t == null).length} packs without a time (no System message received)`);
  if (out.length) warnings.push('Drone Scanner exports carry no RSSI');
  return out;
}

function parseJson(text, warnings) {
  let j; try { j = JSON.parse(text); } catch { warnings.push('invalid JSON'); return []; }
  const a = Array.isArray(j) ? j : Array.isArray(j?.records) ? j.records : null;
  if (!a) { warnings.push('JSON has no records array'); return []; }
  return a.filter(o => o && typeof o === 'object').map(o => {
    const r = rec({}); for (const k of Object.keys(r)) if (o[k] !== undefined) r[k] = o[k];
    r.t = typeof r.t === 'string' ? Date.parse(r.t) || null : num(r.t);
    for (const k of ['lat', 'lon', 'altM', 'heightM', 'speedMs', 'opLat', 'opLon', 'rssi']) r[k] = num(r[k]);
    r.source = r.source || 'json'; return r;
  });
}

// ---------- summary ----------
const R = 6371008.8, rad = Math.PI / 180;
/** Distance (m) from [lon,lat] to a polyline of [lon,lat] (local equirectangular). */
export function distToRoute(ll, route) {
  const c = Math.cos(ll[1] * rad), P = q => [(q[0] - ll[0]) * rad * R * c, (q[1] - ll[1]) * rad * R];
  if (route.length === 1) return Math.hypot(...P(route[0]));
  let d = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = P(route[i]), b = P(route[i + 1]), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const k = L ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L)) : 0;
    d = Math.min(d, Math.hypot(a[0] + k * dx, a[1] + k * dy));
  }
  return d;
}
export const HEIGHT_BANDS_FT = [0, 100, 200, 300, 400, 500];          // AGL/takeoff-relative; Part 107 ceiling is 400 ft

export function summarizeRemoteId(records, route = [], { radiusM = 500, tz = TZ } = {}) {
  const FT = 3.28084, fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }), hourOf = t => +fmt.format(t);
  const key = r => r.id || 'mac:' + r.mac;
  const A = new Map(), O = new Map(), byHour = Array.from({ length: 24 }, (_, h) => ({ h, obs: 0, near: 0, aircraft: new Set() }));
  const hb = HEIGHT_BANDS_FT.map((f, i) => ({ fromFt: f, toFt: HEIGHT_BANDS_FT[i + 1] ?? null, obs: 0, near: 0 }));
  let near = 0, pos = 0, noHeight = 0, t0 = Infinity, t1 = -Infinity;
  for (const r of records) {
    const k = key(r), a = A.get(k) || A.set(k, { id: r.id, mac: r.mac, idType: r.idType, uaType: r.uaType, operatorIds: new Set(), n: 0,
      first: null, last: null, maxHeightM: null, minDistM: null, near: 0, sources: new Set() }).get(k);
    a.n++; a.sources.add(r.source); if (r.operatorId) a.operatorIds.add(r.operatorId);
    if (r.t != null) { a.first = Math.min(a.first ?? r.t, r.t); a.last = Math.max(a.last ?? r.t, r.t); t0 = Math.min(t0, r.t); t1 = Math.max(t1, r.t); }
    const d = r.lat != null && r.lon != null && route.length ? distToRoute([r.lon, r.lat], route) : null, isNear = d != null && d <= radiusM;
    if (r.lat != null && r.lon != null) pos++;
    if (d != null) a.minDistM = Math.min(a.minDistM ?? d, d);
    if (isNear) { near++; a.near++; }
    if (r.heightM != null) {
      a.maxHeightM = Math.max(a.maxHeightM ?? r.heightM, r.heightM);
      const ft = r.heightM * FT, b = hb.findLast(x => ft >= x.fromFt) || hb[0]; b.obs++; if (isNear) b.near++;
    } else if (r.lat != null) noHeight++;
    if (r.t != null) { const H = byHour[hourOf(r.t)]; H.obs++; if (isNear) H.near++; H.aircraft.add(k); }
    if (r.opLat != null && r.opLon != null) {
      const ok = (r.operatorId || k) + '@' + r.opLat.toFixed(4) + ',' + r.opLon.toFixed(4);
      const o = O.get(ok) || O.set(ok, { operatorId: r.operatorId || null, lat: +r.opLat.toFixed(5), lon: +r.opLon.toFixed(5), n: 0, aircraft: new Set(), distM: null }).get(ok);
      o.n++; o.aircraft.add(k); if (route.length) o.distM = Math.round(distToRoute([r.opLon, r.opLat], route));
    }
  }
  const aircraft = [...A.values()].map(a => ({ ...a, operatorIds: [...a.operatorIds], sources: [...a.sources],
    minDistM: a.minDistM == null ? null : Math.round(a.minDistM) })).sort((x, y) => (x.minDistM ?? Infinity) - (y.minDistM ?? Infinity));
  const operators = [...O.values()].map(o => ({ ...o, aircraft: [...o.aircraft] }));
  const opIds = new Set(records.map(r => r.operatorId).filter(Boolean));
  return {
    radiusM, tz, records: records.length, withPosition: pos, near,
    aircraft, uniqueAircraft: aircraft.length, aircraftNear: aircraft.filter(a => a.near).length,
    uniqueOperatorIds: opIds.size, operators,
    span: t0 <= t1 ? { from: t0, to: t1, hours: +((t1 - t0) / HOUR).toFixed(2) } : null,
    byHour: byHour.map(h => ({ h: h.h, obs: h.obs, near: h.near, aircraft: h.aircraft.size })),
    heightFt: hb, noHeight,
  };
}

/** Plain-language lines for the safety-case package (uncrewed traffic baseline). */
export function remoteIdFindings(s) {
  if (!s.records) return ['No Remote ID broadcasts in the imported log.'];
  const span = s.span ? `${new Date(s.span.from).toISOString().slice(0, 16)}Z to ${new Date(s.span.to).toISOString().slice(0, 16)}Z` : 'unknown times';
  const busy = s.byHour.filter(h => h.near).sort((a, b) => b.near - a.near)[0];
  const over = s.heightFt.filter(b => b.fromFt >= 400).reduce((n, b) => n + b.obs, 0);
  return [
    `Remote ID walk log: ${s.records} broadcasts from ${s.uniqueAircraft} aircraft (${s.uniqueOperatorIds} operator IDs), ${span}.`,
    `${s.aircraftNear} aircraft and ${s.near} position reports within ${s.radiusM} m of the route.`,
    busy ? `Busiest hour near the route: ${String(busy.h).padStart(2, '0')}:00 ${s.tz} (${busy.near} reports, ${busy.aircraft} aircraft).` : 'No position reports near the route.',
    `Heights reported: ${s.heightFt.map(b => `${b.fromFt}${b.toFt ? '–' + b.toFt : '+'} ft ${b.obs}`).join(', ')}${s.noHeight ? `, unknown ${s.noHeight}` : ''}; ${over} above 400 ft.`,
    'Baseline covers only aircraft that broadcast Remote ID within radio range (about 0.5–1 km for Bluetooth 4) while the log ran; it is a floor, not a census.',
  ];
}
