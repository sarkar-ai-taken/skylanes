// Fetch NOTAMs around the metro from the FAA NOTAM API and write app/data/notams.json.
// The API needs a free key pair from https://api.faa.gov (NOTAM API): set FAA_NOTAM_CLIENT_ID and FAA_NOTAM_CLIENT_SECRET.
// Without them this writes an empty snapshot that says why, and the app carries on without NOTAMs.
// The public NOTAM search page blocks scripted requests, so there is no keyless route.
// Run: node pipeline/notams.mjs
import { writeFileSync, readFileSync } from 'node:fs';

const API = 'https://external-api.faa.gov/notamapi/v1/notams';
const RADIUS_NM = 50;
const OUT = new URL('../app/data/notams.json', import.meta.url);

/** "473612N1222011W" or "4736N12220W" (degrees, minutes, optional seconds) → [lon, lat]. */
export function parseCoord(s) {
  const m = s.match(/(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?([NS])\s?(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?([EW])/);
  if (!m) return null;
  const lat = (+m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0)) * (m[4] === 'S' ? -1 : 1);
  const lon = (+m[5] + +m[6] / 60 + (m[7] ? +m[7] / 3600 : 0)) * (m[8] === 'W' ? -1 : 1);
  return [+lon.toFixed(5), +lat.toFixed(5)];
}

/** What a NOTAM means for a low-level route: obstacle, uas, tfr, airspace, heliport, aerodrome, or other. */
export function kindOf(text) {
  const t = text.toUpperCase();
  if (/\bOBST\b|\bCRANE\b|TOWER LGT|\bLGT\b.*\bOUT\b/.test(t)) return 'obstacle';
  if (/\bUAS\b|UNMANNED/.test(t)) return 'uas';
  if (/FLIGHT RESTRICTIONS|\bTFR\b|91\.137|99\.7/.test(t)) return 'tfr';
  if (/\bHELIPORT\b|\bHELIPAD\b/.test(t)) return 'heliport';
  if (/\bAIRSPACE\b|PARACHUTE|\bPJE\b|AEROBATIC|BALLOON|LASER/.test(t)) return 'airspace';
  if (/\bRWY\b|\bAD\b|\bAP\b|\bTWY\b/.test(t)) return 'aerodrome';
  return 'other';
}

/** One API item → the fields the engine needs, or null without a position. */
export function parseNotam(core) {
  const n = core.notam || core, text = n.text || '';
  const at = parseCoord(text) || parseCoord((n.coordinates || '').replace(/\s/g, ''));
  if (!at) return null;
  const ft = text.match(/(\d{2,5})\s?FT\s*\((\d{1,5})\s?FT\s*AGL\)/) || [];
  const radius = text.match(/(\d+(?:\.\d+)?)\s?NM\s+RADIUS/) || (n.radius ? [null, n.radius] : []);
  return { id: `${n.location || n.icaoLocation || ''} ${n.number || n.id}`.trim(), kind: kindOf(text), text,
    start: n.effectiveStart || null, end: n.effectiveEnd && n.effectiveEnd !== 'PERM' ? n.effectiveEnd : null,
    lon: at[0], lat: at[1], radius_nm: radius[1] ? +radius[1] : null, msl_ft: ft[1] ? +ft[1] : null, agl_ft: ft[2] ? +ft[2] : null };
}

async function main() {
  const id = process.env.FAA_NOTAM_CLIENT_ID, secret = process.env.FAA_NOTAM_CLIENT_SECRET;
  if (!id || !secret) {
    writeFileSync(OUT, JSON.stringify({ fetched: null, reason: 'no FAA NOTAM API key (set FAA_NOTAM_CLIENT_ID / FAA_NOTAM_CLIENT_SECRET)', notams: [] }));
    return console.log('notams: no FAA API key; wrote an empty snapshot');
  }
  const [W, S, E, N] = JSON.parse(readFileSync(new URL('../app/data/manifest.json', import.meta.url))).bbox;
  const items = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ responseFormat: 'geoJson', locationLongitude: ((W + E) / 2).toFixed(3), locationLatitude: ((S + N) / 2).toFixed(3),
      locationRadius: RADIUS_NM, pageSize: 1000, pageNum: page });
    const r = await fetch(`${API}?${q}`, { headers: { client_id: id, client_secret: secret } });
    if (!r.ok) throw new Error(`FAA NOTAM API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    items.push(...j.items);
    if (page >= (j.totalPages || 1)) break;
  }
  const notams = items.map(it => parseNotam(it.properties.coreNOTAMData)).filter(Boolean)
    .filter(n => n.lon >= W - 0.2 && n.lon <= E + 0.2 && n.lat >= S - 0.2 && n.lat <= N + 0.2);
  writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), source: 'FAA NOTAM API', radius_nm: RADIUS_NM, total: items.length, notams }));
  console.log(`${notams.length} NOTAMs with a position in the box, of ${items.length} within ${RADIUS_NM} NM`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
