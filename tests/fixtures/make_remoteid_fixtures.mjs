// Usage: node tests/fixtures/make_remoteid_fixtures.mjs tests/fixtures
// Builds SYNTHETIC Remote ID log fixtures that mirror the byte-for-byte layout the two apps write.
// opendroneid/receiver-android: log/LogWriter.java + LogEntry.java + LogMessageEntry.java + OpenDroneIdParser.*.toCsvString
// Drone Scanner (Dronetag) 1.5.2: lib/utils/csvlogger.dart via package:csv ListToCsvConverter (CRLF), exportPacksToCSV concatenation.
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const D = ',', EPOCH19 = Date.UTC(2019, 0, 1);
const pad = (s, n) => s + '\0'.repeat(n - s.length);              // new String(byte[20]) keeps the NUL padding
const alt = m => Math.round((m + 1000) * 2);
const spd = v => v <= 63.75 ? [Math.round(v / 0.25), 0] : [Math.round((v - 63.75) / 0.75), 1];
const tenths = ms => Math.floor((ms % 3600000) / 100);
const hex = b => b.map(x => (x & 255).toString(16).toUpperCase().padStart(2, '0') + ' ').join('');
const le = (n, k) => Array.from({ length: k }, (_, i) => (n >> (8 * i)) & 255);
const adv = (cnt, msg) => [0x02, 0x01, 0x06, 0x1E, 0x16, 0xFA, 0xFF, 0x0D, cnt, ...msg, ...Array(25 - msg.length).fill(0)];

const H = ['session', 'timestamp (nanos)', 'transportType', 'macAddress', 'msgVersion', 'rssi', 'payload'].join(D);
const BID = 'idType,uaType,uasId,', LOC = 'status,heightType,EWDirection,speedMult,direction,speedHori,speedVert,droneLat,droneLon,altitudePressure,altitudeGeodetic,height,horizontalAccuracy,verticalAccuracy,baroAccuracy,speedAccuracy,timestamp,timeAccuracy,distance,';
const SID = 'descriptionType,operationDescription,', SYS = 'operatorLocationType,classificationType,operatorLatitude,operatorLongitude,areaCount,areaRadius,areaCeiling,areaFloor,category,classValue,operatorAltitudeGeo,systemTimestamp,';
const OPI = 'operatorIdType,operatorId,', AUTH = 'authType,authDataPage,authLastPageIndex,authLength,authTimestamp,authData,';
const header = H + D + BID + BID + LOC + SID + SYS + OPI + AUTH.repeat(16);
const E = { bid: ',,,', loc: ','.repeat(19), sid: ',,', sys: ','.repeat(12), op: ',,', auth: ',,,,,,' };

const boot = Date.UTC(2026, 9, 20, 22, 0, 0);                    // phone booted 15:00 PDT
const ns = ms => String((ms - boot) * 1e6);
const t0 = Date.UTC(2026, 9, 21, 0, 30, 0);                      // 17:30 PDT, 2026-10-20 local
const rows = [];
const row = (ms, tr, mac, rssi, payload, parts) => rows.push([0, ns(ms), tr, mac, 2, rssi, hex(payload)].join(D) + D +
  (parts.bid || E.bid) + E.bid + (parts.loc || E.loc) + (parts.sid || E.sid) + (parts.sys || E.sys) + (parts.op || E.op) + E.auth.repeat(16));
const ac = [
  { mac: '5A:1B:2C:3D:4E:01', tr: 'BT4', id: 'SYNTH0000000000000A1', idType: 1, ua: 2, op: 'FA3SYNTHOP1', opLL: [47.6080, -122.3340], start: [47.6085, -122.3345], v: [0.00012, 0.00018], h: 60, rssi: -71 },
  { mac: '5A:1B:2C:3D:4E:02', tr: 'BT5', id: 'SYNTH0000000000000B2', idType: 1, ua: 2, op: '', opLL: [47.6500, -122.3500], start: [47.6510, -122.3510], v: [0.0001, 0], h: 110, rssi: -88 },
];
ac.forEach((a, k) => {
  for (let i = 0; i < 6; i++) {
    const ms = t0 + k * 3600000 + i * 10000, lat = a.start[0] + a.v[0] * i, lon = a.start[1] + a.v[1] * i, h = a.h + 5 * i;
    if (i % 3 === 0) {
      row(ms - 400, a.tr, a.mac, a.rssi, adv(i, [0x02, (a.idType << 4) | a.ua, ...[...a.id].map(c => c.charCodeAt(0))]),
        { bid: `${a.idType},${a.ua},${pad(a.id, 20)},` });
      const sysTs = Math.floor((ms - EPOCH19) / 1000), olat = Math.round(a.opLL[0] * 1e7), olon = Math.round(a.opLL[1] * 1e7);
      row(ms - 200, a.tr, a.mac, a.rssi, adv(i, [0x42, 0x05, ...le(olat, 4), ...le(olon, 4), 1, 0, 0, 0, 0, 0, 0, 0x12, ...le(alt(20), 2), ...le(sysTs, 4)]),
        { sys: `1,1,${olat},${olon},1,0,0,0,1,2,${alt(20)},${sysTs},` });
      if (a.op) row(ms - 100, a.tr, a.mac, a.rssi, adv(i, [0x52, 0, ...[...a.op].map(c => c.charCodeAt(0))]), { op: `0,${pad(a.op, 20)},` });
    }
    const [sr, mult] = spd(12), dir = 34, la = Math.round(lat * 1e7), lo = Math.round(lon * 1e7);
    const st = (2 << 4) | (1 << 2) | (0 << 1) | mult;
    row(ms, a.tr, a.mac, a.rssi - i, adv(i, [0x12, st, dir, sr, 2, ...le(la, 4), ...le(lo, 4), ...le(alt(0), 2), ...le(alt(h + 40), 2), ...le(alt(h), 2), 0x4B, 0x24, ...le(tenths(ms), 2), 1]),
      { loc: `2,1,0,${mult},${dir},${sr},2,${la},${lo},2000,${alt(h + 40)},${alt(h)},11,4,2,4,${tenths(ms)},1,0.0,` });
  }
});
// a Self-ID whose free text holds a comma: the app does not quote it, so later columns shift right by one
row(t0 + 20000, 'BT4', ac[0].mac, -73, adv(9, [0x32, 0, ...[...'Survey, block 4'].map(c => c.charCodeAt(0))]), { sid: `0,${pad('Survey, block 4', 23)},` });
// an aircraft heard only once with its ID and nothing else (Wi-Fi beacon, rssi from the Wi-Fi scan)
row(t0 + 1800000, 'Beacon', '7E:00:00:00:00:C3', -60, adv(0, [0x02, 0x42, ...[...'SYNTHSESSION0C3'].map(c => c.charCodeAt(0))]), { bid: `4,2,${pad('SYNTHSESSION0C3', 20)},` });
writeFileSync(`${out}/remoteid_synthetic_opendroneid-receiver-android.csv`, [header, ...rows].join('\n') + '\n');

// ---- Drone Scanner export: blocks per MessagePack, CRLF, groups glued together without a newline (exportPacksToCSV) ----
const q = v => /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const csv = rs => rs.map(r => r.map(q).join(',')).join('\r\n');
const dart = ms => { const d = new Date(ms - 7 * 3600000), p = (n, k = 2) => String(n).padStart(k, '0');   // phone in PDT
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`; };
const dartT = raw => dart(raw);                                   // DateTime.fromMillisecondsSinceEpoch(loc.time) with time = 1/10 s past the hour
const dbl = x => Number.isInteger(x) ? x.toFixed(1) : String(x);
const groups = [];
[{ mac: '6B:00:00:00:00:D4', id: 'SYNTH0000000000000D4', op: 'FA3SYNTHOP4', opLL: [47.6150, -122.3270], start: [47.6140, -122.3290], h: 45 },
 { mac: '6B:00:00:00:00:E5', id: 'SYNTH0000000000000E5', op: '', opLL: [47.5900, -122.2900], start: [47.5910, -122.2910], h: 130 }].forEach((a, k) => {
  const g = [];
  for (let i = 0; i < 3; i++) {
    const ms = Date.UTC(2026, 9, 21, 1 + k, 12, 0) + i * 30000, lat = +(a.start[0] + 0.0002 * i).toFixed(7), lon = +(a.start[1] + 0.0003 * i).toFixed(7);
    g.push(['mac address'], [a.mac], ['Location Message', 'MessageSource.BluetoothLegacy'],
      ['status', 'heightType', 'direction', 'speedHori', 'speedVert', 'droneLat', 'droneLon', 'altitudePressure', 'altitudeGeodetic', 'height', 'horizontalAccuracy', 'verticalAccuracy', 'baroAccuracy', 'speedAccuracy', 'timestamp', 'timeAccuracy'],
      ['AircraftStatus.Airborne', 'HeightType.Ground', '90.0', '8.25', '0.0', dbl(lat), dbl(lon), '-1000.0', dbl(a.h + 35), dbl(a.h + 3 * i), 'HorizontalAccuracy.meters_10', 'VerticalAccuracy.meters_3', 'VerticalAccuracy.meters_3', 'SpeedAccuracy.meter_per_second_1', dartT(tenths(ms)), '0.1'],
      ['BasicId Message', 'MessageSource.BluetoothLegacy'], ['idType', 'uaType', 'uasId'], ['IdType.Serial_Number', 'UaType.Helicopter_or_Multirotor', a.id]);
    if (a.op) g.push(['OperatorId Message', 'MessageSource.BluetoothLegacy'], ['operatorId'], [a.op]);
    g.push(['System Data Message', 'MessageSource.BluetoothLegacy'],
      ['operatorLocationType', 'classificationType', 'operatorLatitude', 'operatorLongitude', 'areaCount', 'areaRadius', 'areaCeiling', 'areaFloor', 'category', 'classValue', 'operatorAltitudeGeo', 'systemTimestamp'],
      ['OperatorLocationType.LiveGNSS', 'ClassificationType.Undeclared', dbl(a.opLL[0]), dbl(a.opLL[1]), 1, 0, '-1000.0', '-1000.0', '', '', '20.0', dart(ms - 300)]);
  }
  groups.push(csv(g));
});
writeFileSync(`${out}/remoteid_synthetic_dronescanner-export-all.csv`, groups.join(''));
