// Remote ID log import. Fixtures are SYNTHETIC examples of each app's file format (layout copied from the apps' source), not real observations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRemoteIdLog, summarizeRemoteId, remoteIdFindings, detectFormat, parseCSV, startFromFilename, distToRoute } from '../app/remoteid.js';

const fx = n => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const ODID = fx('remoteid_synthetic_opendroneid-receiver-android.csv'), DS = fx('remoteid_synthetic_dronescanner-export-all.csv');
const route = [[-122.3350, 47.6080], [-122.3200, 47.6200]];
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('formats are detected from their headers', () => {
  assert.equal(detectFormat(ODID), 'odid'); assert.equal(detectFormat(DS), 'dscan');
  assert.equal(detectFormat('[{"id":"x"}]'), 'json'); assert.equal(detectFormat('a,b\n1,2'), null);
  const r = parseRemoteIdLog('hello'); assert.equal(r.length, 0); assert.equal(r.format, null); assert.ok(r.warnings.length);
});

test('receiver-android log: raw F3411 integers decoded, identity joined by MAC, wall clock from System timestamps', () => {
  const r = parseRemoteIdLog(ODID);
  assert.equal(r.format, 'odid');
  const A = r.filter(x => x.id === 'SYNTH0000000000000A1');
  assert.equal(A.length, 6);
  const a0 = A[0];
  near(a0.lat, 47.6085); near(a0.lon, -122.3345);
  assert.equal(a0.heightM, 60); assert.equal(a0.altM, 100); assert.equal(a0.hRef, 'ground');
  assert.equal(a0.speedMs, 12); assert.equal(a0.idType, 'Serial_Number'); assert.equal(a0.uaType, 'Helicopter_or_Multirotor');
  assert.equal(a0.operatorId, 'FA3SYNTHOP1'); near(a0.opLat, 47.608); near(a0.opLon, -122.334);
  assert.equal(a0.rssi, -71); assert.equal(a0.source, 'opendroneid:BT4');
  assert.equal(a0.t, Date.UTC(2026, 9, 21, 0, 30, 0));                // 17:30 PDT
  assert.equal(A[5].t - a0.t, 50000);
  const B = r.filter(x => x.id === 'SYNTH0000000000000B2');
  assert.equal(B.length, 6); assert.equal(B[0].operatorId, null); assert.equal(B[0].source, 'opendroneid:BT5');
  // ID-only transmitter (Wi-Fi beacon) is kept once, NUL padding stripped, no position
  const C = r.filter(x => x.id === 'SYNTHSESSION0C3');
  assert.equal(C.length, 1); assert.equal(C[0].lat, null); assert.equal(C[0].idType, 'Specific_Session_ID');
  assert.ok(r.every(x => !/\0/.test(x.id)));
});

test('receiver-android log: a comma inside Self-ID text does not shift the operator columns', () => {
  const lines = ODID.trim().split('\n'), hdr = lines[0];
  const bad = lines.find(l => l.includes('Survey, block 4'));
  assert.equal(bad.split(',').length, hdr.split(',').length + 1);
  // an Operator ID row with the same shift still reads correctly
  const cols = lines.find(l => l.includes('FA3SYNTHOP1')).split(','), iS = hdr.split(',').indexOf('descriptionType');
  cols.splice(iS, 2, '0', 'Survey', ' here');
  const r = parseRemoteIdLog([hdr, cols.join(','), lines.find(l => l.includes('5A:1B:2C:3D:4E:01') && /,2,1,0,0,34,/.test(l))].join('\n'));
  assert.equal(r.length, 1); assert.equal(r[0].operatorId, 'FA3SYNTHOP1');
});

test('receiver-android log without a System timestamp falls back to the file-name start time', () => {
  const lines = ODID.trim().split('\n'), hdr = lines[0];
  const locOnly = lines.filter(l => l.includes('5A:1B:2C:3D:4E:02') && /,2,1,0,0,34,/.test(l));
  const fn = 'log_Pixel 7_ble_2026-10-20_18-30-00.000.csv';
  assert.equal(startFromFilename(fn), Date.UTC(2026, 9, 21, 1, 30, 0));
  const none = parseRemoteIdLog([hdr, ...locOnly].join('\n'));
  assert.ok(none.every(x => x.t == null)); assert.ok(none.warnings.some(w => /anchor/.test(w)));
  const r = parseRemoteIdLog([hdr, ...locOnly].join('\n'), { filename: fn });
  assert.equal(r[0].t, Date.UTC(2026, 9, 21, 1, 30, 0));              // snapped to the Location message's 1/10 s past the hour
  assert.equal(r[1].t - r[0].t, 10000);
});

test('Drone Scanner export-all: glued groups split, Dart enums and local times decoded', () => {
  const r = parseRemoteIdLog(DS);
  assert.equal(r.format, 'dscan'); assert.equal(r.length, 6);
  const D = r.filter(x => x.id === 'SYNTH0000000000000D4'), E = r.filter(x => x.id === 'SYNTH0000000000000E5');
  assert.equal(D.length, 3); assert.equal(E.length, 3);
  near(D[0].lat, 47.614); near(D[0].lon, -122.329); assert.equal(D[0].heightM, 45); assert.equal(D[0].altM, 80);
  assert.equal(D[0].speedMs, 8.25); assert.equal(D[0].hRef, 'ground'); assert.equal(D[0].idType, 'Serial_Number');
  assert.equal(D[0].operatorId, 'FA3SYNTHOP4'); near(D[0].opLat, 47.615); assert.equal(D[0].rssi, null);
  assert.equal(D[0].source, 'dronescanner:BluetoothLegacy');
  assert.equal(D[0].t, Date.UTC(2026, 9, 21, 1, 12, 0)); assert.equal(D[2].t, Date.UTC(2026, 9, 21, 1, 13, 0));
  assert.equal(E[0].t, Date.UTC(2026, 9, 21, 2, 12, 0)); assert.equal(E[0].operatorId, null);
  assert.ok(r.warnings.some(w => /RSSI/.test(w)));
});

test('Drone Scanner <= 1.0 export with latitude in droneLon drops the longitude and says so', () => {
  const old = DS.replace(/(Ground,90\.0,8\.25,0\.0,)([\d.]+),-?[\d.]+,/g, '$1$2,$2,');
  const r = parseRemoteIdLog(old);
  assert.ok(r.every(x => x.lon == null)); assert.ok(r.warnings.some(w => /droneLon/.test(w)));
});

test('CSV reader handles quotes and CRLF', () => {
  assert.deepEqual(parseCSV('a,"b,c","d""e"\r\n1,2,3'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
});

test('normalised JSON round-trips', () => {
  const r = parseRemoteIdLog(DS), back = parseRemoteIdLog(JSON.stringify({ records: r }));
  assert.equal(back.format, 'json'); assert.deepEqual(back.map(x => [x.t, x.id, x.lat]), r.map(x => [x.t, x.id, x.lat]));
});

test('distance to route', () => {
  near(distToRoute([-122.3350, 47.6080], route), 0, 1e-6);
  near(distToRoute([-122.3350, 47.6170], [[-122.3350, 47.6080]]), 1000.8, 1);
});

test('summary: unique aircraft and operators, near-route counts, hours, height bands', () => {
  const recs = [...parseRemoteIdLog(ODID), ...parseRemoteIdLog(DS)];
  const s = summarizeRemoteId(recs, route, { radiusM: 300 });
  assert.equal(s.records, 19); assert.equal(s.uniqueAircraft, 5); assert.equal(s.uniqueOperatorIds, 2);
  const a = s.aircraft.find(x => x.id === 'SYNTH0000000000000A1');
  assert.equal(a.n, 6); assert.ok(a.minDistM < 50); assert.equal(a.maxHeightM, 85); assert.deepEqual(a.operatorIds, ['FA3SYNTHOP1']);
  assert.equal(s.aircraft.find(x => x.id === 'SYNTH0000000000000B2').near, 0);   // 4.8 km north
  assert.equal(s.aircraftNear, 2);                                                // A1 and D4
  assert.equal(s.byHour[17].obs, 6); assert.equal(s.byHour[17].aircraft, 1);
  assert.equal(s.byHour[18].aircraft, 3);
  const sumH = s.heightFt.reduce((n, b) => n + b.obs, 0);
  assert.equal(sumH + s.noHeight, s.withPosition);
  assert.equal(s.heightFt.find(b => b.fromFt === 400).obs, 6);                    // B2 125–135 m and E5 130–136 m
  assert.ok(s.operators.some(o => o.operatorId === 'FA3SYNTHOP1' && o.distM === 57));
  const lines = remoteIdFindings(s);
  assert.match(lines[0], /19 broadcasts from 5 aircraft/); assert.match(lines.at(-1), /floor, not a census/);
});
