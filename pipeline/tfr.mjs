// Fetch active FAA TFRs for the metro's state from tfr.faa.gov and write app/data/tfr.json.
// tfr.faa.gov does not allow browser requests, so the Pages workflow runs this hourly and ships the result with the site.
// Run: node pipeline/tfr.mjs
import { writeFileSync, readFileSync } from 'node:fs';

const STATE = 'WA';
const UA = { 'User-Agent': 'corridor-pipeline/0.1 (route safety-case prototype)' };

/** Parse one XNOTAM detail document: times, vertical limits and the merged-area polygon as [lon, lat] pairs. */
export function parseXnotam(xml) {
  const one = tag => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];
  const deg = s => { const m = s.match(/^([\d.]+)([NSEW])$/); return m ? (+m[1]) * (m[2] === 'S' || m[2] === 'W' ? -1 : 1) : NaN; };
  const area = (xml.match(/<abdMergedArea>([\s\S]*?)<\/abdMergedArea>/) || [])[1] || '';
  const ring = [...area.matchAll(/<geoLat>([^<]+)<\/geoLat>\s*<geoLong>([^<]+)<\/geoLong>/g)].map(m => [deg(m[2]), deg(m[1])]).filter(p => p.every(Number.isFinite));
  const ft = (v, code) => (v == null ? null : code === 'FL' ? +v * 100 : +v);
  return {
    effective: one('dateEffective') ? one('dateEffective') + 'Z' : null,
    expire: one('dateExpire') ? one('dateExpire') + 'Z' : null,
    upper_ft: ft(one('valDistVerUpper'), one('uomDistVerUpper')), lower_ft: ft(one('valDistVerLower'), one('uomDistVerLower')),
    ring: ring.length < 3 ? [] : ring[0].join() === ring[ring.length - 1].join() ? ring : [...ring, ring[0]],
  };
}

async function main() {
  const list = await (await fetch('https://tfr.faa.gov/tfrapi/getTfrList', { headers: UA })).json();
  const local = list.filter(t => t.state === STATE);
  const tfrs = [];
  for (const t of local) {
    const id = t.notam_id.replace('/', '_');
    try {
      const xml = await (await fetch(`https://tfr.faa.gov/download/detail_${id}.xml`, { headers: UA })).text();
      tfrs.push({ id: t.notam_id, type: t.type, description: t.description, ...parseXnotam(xml) });
    } catch (e) { console.warn(`skip ${t.notam_id}: ${e.message}`); }
  }
  const out = { fetched: new Date().toISOString(), source: 'tfr.faa.gov', state: STATE, national: list.length, tfrs };
  writeFileSync(new URL('../app/data/tfr.json', import.meta.url), JSON.stringify(out));
  console.log(`${tfrs.length} ${STATE} TFRs of ${list.length} nationally`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
