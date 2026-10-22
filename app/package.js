// The generated safety-case package: one section model, rendered to HTML for the page and Markdown for download.
import { FT, TOD, noiseAt, findings, altLabel } from './engine.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const km = m => (m / 1000).toFixed(2) + ' km';
const n0 = x => Math.round(x).toLocaleString('en-US');

export function corridorId(r) {
  const [lon, lat] = r.samples[0].ll;
  return `SEA-${Math.abs(Math.round(lat * 1000) % 1000).toString().padStart(3, '0')}${Math.abs(Math.round(lon * 1000) % 1000).toString().padStart(3, '0')}-${String(Math.round(r.lenM)).padStart(5, '0')}`;
}

export function sections(D, r, area, today = new Date().toISOString().slice(0, 10), live = null) {
  const f = findings(r), m = D.manifest, L = m.layers;
  const catRows = [1, 2, 3, 4, 5].map(c => {
    const n = r.samples.filter(s => s.c === c).length;
    return n ? [`Category ${c}`, Math.round(n / r.samples.length * 100) + '%', km(n / r.samples.length * r.lenM)] : null;
  }).filter(Boolean);
  const hardObs = [...r.obstacles.filter(o => o.agl_ft >= o.alt), ...r.buildings.filter(b => b.h_ft >= b.alt).map(b => ({ agl_ft: b.h_ft }))].sort((a, b) => b.agl_ft - a.agl_ft);
  const nearObs = r.obstacles.length + r.buildings.length;
  const air = r.airspace.filter(a => !a.conditional).map(a => a.name);
  const haz = [
    ['Loss of C2 link', `Lost-link behaviour: ${r.ac.lostlink}.`, 'Link coverage survey along the corridor before first operation; lost-link behaviour tested per manufacturer limits'],
    ['Propulsion failure', `${r.foot.length.toLocaleString()} simulated failure landings; ${Math.round(r.hiFrac * 100)}% on ground above ${r.opt.denseKm2.toLocaleString()} people/km², ${Math.round(r.waterFrac * 100)}% in water. Mean ${n0(r.meanUnder)} people/km² under the footprint.`,
      r.ac.chute ? 'Ballistic parachute; impact-energy target set with the manufacturer' : 'Route offset from the densest blocks; parachute recommended'],
    ['Ground fatality risk', `${r.ecPerFh.toExponential(1)} per flight hour (${r.ecPerFlight.toExponential(1)} per flight) at an assumed ${r.opt.failRatePerFh.toExponential(0)} failures per flight hour and ${r.ac.lethalAreaM2} m² lethal area.`,
      r.ecPerFh > 1e-6 ? 'Above a 1e-6 per flight hour target: lower the failure rate with redundancy, add a parachute, or move the route' : 'Within a 1e-6 per flight hour target'],
    ['Fly-away', `Up to ${n0(r.ac.spd * 10)} m of uncontrolled travel modelled.`, 'Geofence inside the area of intended flight; flight termination armed throughout'],
    ['Crewed aircraft', air.length ? air.join('; ') : 'No heliport within 800 m, airport within 3 km or Class B/C/D surface area.', 'ADS-B In, yield to all crewed traffic; letters of agreement with the named heliport operators'],
    ['Obstacles', hardObs.length ? `${hardObs.length} buildings or obstacles within ${r.opt.obstacleLateralM} m reach or exceed the route's altitude (tallest ${hardObs[0].agl_ft} ft).` : nearObs ? `${nearObs} buildings or obstacles within ${r.opt.obstacleLateralM} m rise to within ${r.opt.obstacleVertFt} ft of the route's altitude.` : `No mapped building or obstacle within ${r.opt.obstacleLateralM} m rises to within ${r.opt.obstacleVertFt} ft of the route's altitude (${altLabel(r)}).`,
      'Building footprints and FAA DOF checked each operating day; at least 50 ft vertical clearance; FAA construction notices checked for cranes'],
    ['Power lines', r.powerlines.length ? `${r.powerlines.length} mapped transmission line(s) within ${r.opt.powerlineM} m.` : 'No mapped transmission line within 30 m below 250 ft.', 'Distribution lines are not in public data: site survey of launch and delivery points'],
    ['Weather', `Planned at ${r.wind.kt} kt from ${r.wind.dir}°; failure drift scales with wind.`, `Operating limit ${Math.max(15, Math.ceil(r.wind.kt * 1.3))} kt sustained, no flight in gusts above ${Math.max(20, Math.ceil(r.wind.kt * 1.6))} kt`],
    ['Noise', `${Math.round(noiseAt(0, r.altMin, r.ac))} dB directly below at the lowest level; 55 dB band extends ${n0(r.halfWidth55)} m each side.`, r.noiseSites.length ? `Notice to ${r.noiseSites.length} sensitive sites inside the band (${r.noiseSites.slice(0, 3).map(s => s.name).join(', ')}${r.noiseSites.length > 3 ? ', …' : ''})` : 'No hospital or school inside the 55 dB band'],
  ];
  const open = [];
  if (hardObs.length || r.blockedShare > 0) open.push('Reroute or change level to clear the building and obstacle conflicts; this package cannot be filed as drawn.');
  if (r.overCeilingShare > 0) open.push(`Request LAANC further coordination or an airspace authorization above the ${r.minCeiling} ft facility map ceiling.`);
  if (r.airspace.some(a => a.kind === 'heliport')) open.push('Obtain letters of agreement from the heliport operators named in section 3.');
  if (r.maxCat === 5) open.push('Reroute around Category 5 ground or prepare the highest-tier safety case.');
  open.push('Site survey of launch and delivery points for distribution lines, trees and temporary obstacles.');
  open.push('Replace the generic aircraft class with the operator\'s airframe data (descent rate, glide, source noise, lost-link logic) and its demonstrated failure rate.');
  const sources = Object.entries(L).map(([k, v]) => [k, v.source, v.count.toLocaleString()]);
  if (live?.wind) sources.push(['wind aloft', `Open-Meteo forecast, 10 / 80 / 120 m, valid ${live.wind.at}`, 'live']);
  if (live?.tfr) sources.push(['TFRs', `tfr.faa.gov snapshot ${live.tfr.fetched}`, String(live.tfr.tfrs.length)]);
  if (live?.events) sources.push(['stadium games', 'MLB statsapi, ESPN schedules (FDC 4/3621 stadium TFR windows)', String(live.events.length)]);
  return {
    title: 'Concept of Operations, Hazard Assessment and Area of Intended Flight',
    meta: `Corridor ${corridorId(r)} · prepared ${today} · data built ${m.built} · draft for review, not a filed document`,
    blocks: [
      { h: '1. Operation', p: [`Routine beyond-visual-line-of-sight package delivery by a ${r.ac.name.toLowerCase()} (MTOW ${r.ac.mtow} lb) along a fixed ${km(r.lenM)} corridor in Seattle, from ${r.samples[0].ll.map(x => x.toFixed(5)).reverse().join(', ')} to ${r.samples[r.samples.length - 1].ll.map(x => x.toFixed(5)).reverse().join(', ')}, at ${altLabel(r)}${r.levelled ? ` (waypoint levels ${r.alts.join(', ')} ft)` : ''}, cruise ${r.ac.spd} m/s, ${r.minutes.toFixed(1)} min block time. Operations window: ${TOD[r.tod].label}.`] },
      { h: '2. Area of intended flight and ground risk', p: [
        `The area of intended flight is the convex hull of the corridor and every simulated failure landing: ${area.km2.toFixed(2)} km², attached as GeoJSON. The governing category is <b>Category ${r.maxCat}</b>, taken from the FAA operating categories map at the densest point on the route (${Math.round(r.faaShare * 100)}% of the route is covered by that map; the remainder uses census density thresholds).`,
        `Census ground population along the centerline peaks at ${n0(r.peakD)} people/km² and averages ${n0(r.meanD)} (${TOD[r.tod].label}, 300 m smoothing).`],
        table: [['FAA category', 'Share of route', 'Length'], ...catRows] },
      { h: '3. Hazard assessment', table: [['Hazard', 'Analysis', 'Mitigation'], ...haz] },
      { h: '4. Airspace', p: [r.laancShare > 0 ? `${Math.round(r.laancShare * 100)}% of the route lies in UAS facility map grids (controlled airspace), lowest ceiling ${r.minCeiling} ft AGL. ${r.overCeilingShare > 0 ? `The planned altitude exceeds the ceiling on ${Math.round(r.overCeilingShare * 100)}% of the route.` : 'The planned altitude is within the ceilings; LAANC authorization required.'}` : 'The route lies outside the UAS facility map grids (uncontrolled airspace at the planned altitude).',
        r.airspace.length ? 'Named airspace features: ' + r.airspace.map(a => a.name + (a.conditional ? ' (event days only)' : '')).join('; ') + '.' : 'No heliport, airport, stadium TFR or surface area within the screening distances.'] },
      { h: '5. Lost link and contingency', p: [`On loss of command link the aircraft will ${r.ac.lostlink}. Contingency landing sites are the lowest-density points on the route (from the density profile) and the launch site. Flight termination is armed throughout and bounded by a geofence inside the area of intended flight.`] },
      { h: '6. Findings', list: f.map(([s, t]) => `[${s === 'crit' ? 'blocking' : s === 'warn' ? 'mitigate' : 'ok'}] ${t}`) },
      { h: '7. Open items before filing', list: open },
      { h: '8. Data sources', table: [['Layer', 'Source', 'Records'], ...sources],
        p: ['Known gaps, stated so the reviewer does not have to find them: distribution power lines and most trees are not in public data; OSM building heights are partial and some masts and cranes use conservative default heights; daytime population is modelled as 0.55 × residents + jobs (LEHD 2021), not measured, and LODES places jobs at the reporting establishment, so downtown tower blocks can read up to about twice their real daytime density (conservative for risk); the FAA operating categories layer is read from the FAA ADDS public service and its regulatory status should be confirmed against the final rule.'] },
    ],
  };
}

export function toHTML(doc) {
  const tbl = t => `<div class="tablewrap"><table><tr>${t[0].map(h => `<th>${esc(h)}</th>`).join('')}</tr>${t.slice(1).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  return `<h2>${esc(doc.title)}</h2><p class="note">${esc(doc.meta)}</p>` + doc.blocks.map(b =>
    `<h3>${esc(b.h)}</h3>${(b.p || []).map(p => `<p>${esc(p).replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<strong>$1</strong>')}</p>`).join('')}${b.table ? tbl(b.table) : ''}${b.list ? `<ul>${b.list.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`).join('');
}

export function toMarkdown(doc) {
  const cell = c => String(c).replace(/\|/g, '\\|');
  const tbl = t => `| ${t[0].map(cell).join(' | ')} |\n| ${t[0].map(() => '---').join(' | ')} |\n` + t.slice(1).map(r => `| ${r.map(cell).join(' | ')} |`).join('\n');
  return `# ${doc.title}\n\n_${doc.meta}_\n\n` + doc.blocks.map(b =>
    `## ${b.h}\n\n${(b.p || []).map(p => p.replace(/<\/?b>/g, '**') + '\n\n').join('')}${b.table ? tbl(b.table) + '\n\n' : ''}${b.list ? b.list.map(i => `- ${i}`).join('\n') + '\n\n' : ''}`).join('');
}
