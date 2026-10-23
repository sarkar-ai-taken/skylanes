// The generated safety-case package: one section model, rendered to HTML for the page and Markdown for download.
import { FT, TOD, OCCUPANCY, noiseAt, findings, altLabel, rateText, hhmm, windowText } from './engine.js';
import { remoteIdFindings } from './remoteid.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const km = m => (m / 1000).toFixed(2) + ' km';
const n0 = x => Math.round(x).toLocaleString('en-US');

export function corridorId(r) {
  const [lon, lat] = r.samples[0].ll;
  return `SEA-${Math.abs(Math.round(lat * 1000) % 1000).toString().padStart(3, '0')}${Math.abs(Math.round(lon * 1000) % 1000).toString().padStart(3, '0')}-${String(Math.round(r.lenM)).padStart(5, '0')}`;
}

/**
 * Section 6, the Phase 1 baselines: ground population by hour, crewed and uncrewed traffic, road users, noise complaints
 * and C2 link coverage. rid = { summary (summarizeRemoteId), files, warnings } when a Remote ID log was imported.
 */
function baselines(D, r, traffic, rid) {
  const pc = x => Math.round(x * 100) + '%', H = r.hourly, out = [];
  const band = (dt, b) => { const hs = H[dt].slice(b, b + 3); return [n0(Math.max(...hs.map(x => x.peak))), n0(hs.reduce((a, x) => a + x.mean, 0) / 3), `Cat ${Math.max(...hs.map(x => x.cat))}`]; };
  const win = w => (w.lo === w.hi ? `Category ${w.hi} at every hour` : `best ${windowText(w.best)} (Cat ${w.best.cat}, mean ${n0(w.best.mean)} /km²), worst ${windowText(w.worst)} (Cat ${w.worst.cat}, mean ${n0(w.worst.mean)} /km²)`) + `; mean density is highest at ${hhmm(w.busiest)} and lowest at ${hhmm(w.quietest)}`;
  out.push({ h: '6. Phase 1 baselines', p: ['Baselines from existing public feeds and phones, gathered before any flight: who is on the ground at each hour, crewed and uncrewed traffic, road users under the route, noise complaints, and ground-level mobile network performance for the command link. Each states where its data stops.'] });
  out.push(H ? { h: '6.1 Time-of-day ground population', p: [
    `Ground population along the centerline by local clock hour (300 m smoothing, no stadium crowd): census residents and LEHD jobs weighted by the share of people at home, at work, and out or travelling in that hour (BLS American Time Use Survey 2023–2024; weekday commute timing and work-from-home share localised with the ${D.diurnal.local.acs}). The categories in this table are census-derived for every hour (thresholds 50 / 500 / 2,500 / 10,000 people/km²). The FAA operating categories map, which sets the governing Category ${r.maxCat} where it covers the route (${pc(r.faaShare)}), is static and does not change with the hour.`,
    `Weekdays: ${win(H.windows.weekday)}. Weekends: ${win(H.windows.weekend)}. This package is scored at ${r.popLabel}.`],
    table: [['Hours (local)', 'Weekday peak /km²', 'Weekday mean /km²', 'Weekday category', 'Weekend peak /km²', 'Weekend mean /km²', 'Weekend category'],
      ...[0, 3, 6, 9, 12, 15, 18, 21].map(b => [`${hhmm(b)}–${b === 21 ? '24:00' : hhmm(b + 3)}`, ...band('weekday', b), ...band('weekend', b)])] }
    : { h: '6.1 Time-of-day ground population', p: [`The hourly population layer is not built, so the package uses the ${r.popLabel || TOD[r.tod].label} preset only.`] });
  const S = rid?.summary, howTo = 'To collect them, walk or drive the corridor at the planned operating hours with a phone running Drone Scanner (Dronetag) or the OpenDroneID receiver app (Android), export the log as CSV, and import it on the planning page (Import Remote ID log). The log is read in the browser and is not uploaded or put in the share link. Remote ID shows only aircraft that broadcast within radio range, so it gives a floor, not a census.';
  // a log with no position reports near this route is not a baseline for it
  out.push({ h: '6.2 Crewed and uncrewed traffic baseline', p: [
    traffic ? `Crewed:${traffic}` : 'Crewed: the historical ADS-B layer is not built.',
    S?.near ? `Uncrewed (Remote ID, ${rid.files.join(', ')}): ` + remoteIdFindings(S).join(' ')
      : S ? `Uncrewed: the imported Remote ID log (${rid.files.join(', ')}, ${S.records} broadcasts) has no position reports within ${S.radiusM} m of this route, so it is not a baseline for this corridor. ${howTo}`
        : `Uncrewed: no Remote ID observations have been collected for this corridor. ${howTo}`],
    ...(S?.near ? { table: [['Reported height (ft)', 'Reports', `Within ${S.radiusM} m of the route`], ...S.heightFt.map(b => [`${b.fromFt}${b.toFt ? '–' + b.toFt : '+'}`, String(b.obs), String(b.near)])] } : {}) });
  const R = r.roads;
  if (!R) out.push({ h: '6.3 Road users under the route', p: ['The road count layer is not built.'] });
  else {
    const rows = [...R.crossings.map(c => ({ ...c, how: 'crossed' })), ...R.parallel.map(p => ({ ...p, how: `followed for ${n0(p.lengthM)} m` }))].sort((a, b) => b.aadt - a.aadt);
    const old = rows.filter(x => x.src === 'sdot' && x.year < 2018).length, awdtOnly = rows.filter(x => x.awdtOnly).length, wy = D.roads.sources?.wsdot?.reporting_year;
    out.push({ h: '6.3 Road users under the route', p: [
      rows.length ? `The route crosses counted roads ${R.crossings.length} time${R.crossings.length === 1 ? '' : 's'} and follows ${R.followed} counted road${R.followed === 1 ? '' : 's'}${R.parallel.length > R.followed ? ` (${R.parallel.length} count sections)` : ''}. At ${hhmm(R.hour)} on a ${R.dayType}${r.hour == null ? ` (the hour the ${TOD[r.tod].label} preset stands for)` : ''}, about ${R.vehUnder.toFixed(1)} vehicles, ${R.peopleUnder.toFixed(1)} people at ${OCCUPANCY} per vehicle, are on counted roads under the ${2 * R.bufferM} m footprint as the drone passes, summed along the route. Occupants are partly sheltered by the vehicle.`
        : 'The route crosses and follows no counted road.',
      `Hourly volumes are AADT (AWDT for Seattle arterials on weekdays) × the FHWA TMAS weekday share of that hour, from WSDOT's permanent recorders in April and October 2024 (peak ${hhmm(R.peakHour)}); ${R.dayType === 'weekend' ? 'no weekend shape is published here, so weekend hours use the weekday shape; ' : ''}free-flow speeds 25 mph on Seattle arterials, 60 mph on interstates and US routes and 45 mph on other state routes. Only City of Seattle arterials (SDOT 2024 flow map) and state highways (WSDOT Traffic Sections${wy ? `, reporting year ${wy}, which WSDOT's service describes as 2023 estimated AADT` : ''}) carry counts: other county and city streets have none here, which means no data, not no traffic.${old ? ` ${old} of the counts below come from SDOT studies before 2018.` : ''}${awdtOnly ? ` ${awdtOnly} SDOT segment${awdtOnly === 1 ? ' has' : 's have'} no all-days count (ADT 0 in the flow map), so the weekday AWDT stands in for every day (high on weekends).` : ''}`],
      ...(rows.length ? { table: [['Road', 'Source', 'Vehicles/day', `Vehicles/h at ${hhmm(R.hour)}`, 'Year', 'Route'], ...rows.slice(0, 12).map(x => [x.name, x.src.toUpperCase(), n0(x.aadt) + (x.awdtOnly ? ' (AWDT)' : ''), n0(x.vph), String(x.year), x.how])] } : {}) });
  }
  const c = r.complaints, st = c?.stats, ns = D.noise?.sources || {};
  const nogeo = [ns.csr && `${n0(ns.csr.no_coords)} of ${n0(ns.csr.records)} Find It Fix It requests (nearly all of the nightlife noise complaints, which are rarely geocoded)`,
    ns.spd && `${n0(ns.spd.no_coords)} SPD calls`, ns.sdci && `${n0(ns.sdci.no_coords)} SDCI complaints`].filter(Boolean);
  out.push({ h: '6.4 Noise complaints baseline', p: !c ? ['The noise complaint layer is not built.'] : c.covered === 0
    ? ['The route lies outside Seattle city limits. This layer holds City of Seattle complaints only, so there is no data here, which is not the same as no complaints.']
    : [`${n0(c.n)} noise complaints were filed within ${c.r} m of the ${pc(c.covered)} of the route inside Seattle from ${c.start} to ${c.end} (${n0(c.perKm)} per km). The ${c.cells} cells touched average ${c.meanCell.toFixed(1)} complaints each (busiest ${c.maxCell}) against a city median of ${st.median}, p75 ${st.p75}, p90 ${st.p90} and p99 ${st.p99}: <b>${c.level}</b> for Seattle.${c.covered < 1 ? ' The rest of the route is outside Seattle: no data.' : ''}`,
      `Citywide, ${pc(c.nightShare)} of the complaints with a time fall between 22:00 and 07:00 and the busiest hour is ${hhmm(c.peakHour)}, so evening and night operations will draw more complaints. These are counts of complaints (SPD noise calls that drew a police response, SDCI noise code complaints, Find It Fix It animal and nightlife noise), not of noise or of people annoyed; a few callers or venues can dominate a cell. SPD publishes only calls an officer responded to: noise calls queued and cleared before anyone went are not in the data, so SPD calls are undercounted.${nogeo.length ? ` Records without coordinates are not in the per-route counts: ${nogeo.join(', ')}.` : ''}`] });
  const L = r.link;
  out.push({ h: '6.5 C2 link: ground-level mobile performance', p: !L ? ['The Ookla mobile speed-test layer is not built.'] : [
    `Speedtest by Ookla open data, ${L.quarter}, mobile tests averaged over tiles of about 400 m: ${pc(L.measured)} of the route lies on tiles with tests (${L.tiles} tiles, ${n0(L.tests)} tests) and ${pc(L.good)} on tiles averaging at least ${L.minKbps / 1000} Mbps down with latency at most ${L.maxLat} ms.` + (L.tiles ? ` Median download ${n0(L.medDownMbps)} Mbps, lowest ${L.minDownMbps.toFixed(1)} Mbps; median latency ${L.medLatMs} ms.` : '') + (L.worst ? ` The longest stretch without a usable tile is ${km(L.worst.toM - L.worst.fromM)}, from ${km(L.worst.fromM)} along the route (${L.worst.why}).` : ''),
    'These are crowd-sourced tests from handsets at ground level, not split by carrier or technology. At 300–400 ft a C2 radio sees more towers, more co-channel interference and gaps above down-tilted antennas, so ground throughput is neither an upper nor a lower bound on the link aloft. A tile with no tests means nobody ran one, not that there is no signal, and one quarter is sparse and biased toward where people use phones. Licence CC BY-NC-SA 4.0 (non-commercial use, attribution to Speedtest by Ookla Global Fixed and Mobile Network Performance Maps).'] });
  return out;
}

export function sections(D, r, area, today = new Date().toISOString().slice(0, 10), live = null, { remoteId = null } = {}) {
  const f = findings(r), m = D.manifest, L = m.layers;
  const catRows = [1, 2, 3, 4, 5].map(c => {
    const n = r.samples.filter(s => s.c === c).length;
    return n ? [`Category ${c}`, Math.round(n / r.samples.length * 100) + '%', km(n / r.samples.length * r.lenM)] : null;
  }).filter(Boolean);
  const hardObs = [...r.obstacles.filter(o => o.agl_ft >= o.alt), ...r.buildings.filter(b => b.h_ft >= b.alt).map(b => ({ agl_ft: b.h_ft }))].sort((a, b) => b.agl_ft - a.agl_ft);
  const nearObs = r.obstacles.length + r.buildings.length;
  const air = r.airspace.filter(a => !a.conditional).map(a => a.name);
  const t = r.traffic, c = r.climate, pc = x => Math.round(x * 100) + '%';
  const traffic = t ? ` Historical ADS-B (OpenSky, ${t.days} Mondays, ${t.hours} daytime hours): ${t.level} crewed traffic for the region at ${t.bandFt[0]}–${t.bandFt[1]} ft AGL along the route, ${t.encountersPerFh ? `about ${rateText(t.encountersPerFh)} aircraft passing within ${r.opt.encounterKm} km per flight hour` : `no aircraft recorded within ${r.opt.encounterKm} km at this level`}${t.rotorShare > 0.05 ? `, ${pc(t.rotorShare)} of it helicopters` : ''}.` : '';
  const lidar = r.lidarShare == null ? '' : r.lidarShare === 0 ? ' No 3DEP lidar survey covers the route.'
    : ` 3DEP lidar covers ${pc(r.lidarShare)} of the route; the tallest surface within ${r.opt.clearM} m is ${r.surfaceMaxFt} ft${r.surfaceHits.length ? `, and ${r.surfaceHits.length} stretch${r.surfaceHits.length > 1 ? 'es' : ''} of ${[...new Set(r.surfaceHits.map(h => h.kind))].join(' and ')} not in the mapped data come${r.surfaceHits.length > 1 ? '' : 's'} within ${r.opt.obstacleVertFt} ft of the level` : ''}.`;
  const land = r.land ? r.land.mix.filter(([, v]) => v >= 0.05).map(([k, v]) => `${k} ${pc(v)}`).join(', ') : null;
  const haz = [
    ['Loss of C2 link', `Lost-link behaviour: ${r.ac.lostlink}.` + (r.link ? ` Ookla ${r.link.quarter} ground-level mobile tests: ${pc(r.link.measured)} of the route measured, ${pc(r.link.good)} at ≥ ${r.link.minKbps / 1000} Mbps and ≤ ${r.link.maxLat} ms${r.link.worst ? `, longest stretch without a usable tile ${km(r.link.worst.toM - r.link.worst.fromM)} (${r.link.worst.why})` : ''}; ground level only (section 6.5).` : ''), 'Link coverage survey along the corridor before first operation; lost-link behaviour tested per manufacturer limits'],
    ['Propulsion failure', `${r.foot.length.toLocaleString()} simulated failure landings; ${Math.round(r.hiFrac * 100)}% on ground above ${r.opt.denseKm2.toLocaleString()} people/km², ${Math.round(r.waterFrac * 100)}% in water. Mean ${n0(r.meanUnder)} people/km² under the footprint.`,
      r.ac.chute ? 'Ballistic parachute; impact-energy target set with the manufacturer' : 'Route offset from the densest blocks; parachute recommended'],
    ['Ground fatality risk', `${r.ecPerFh.toExponential(1)} per flight hour (${r.ecPerFlight.toExponential(1)} per flight) at an assumed ${r.opt.failRatePerFh.toExponential(0)} failures per flight hour and ${r.ac.lethalAreaM2} m² lethal area.`,
      r.ecPerFh > 1e-6 ? 'Above a 1e-6 per flight hour target: lower the failure rate with redundancy, add a parachute, or move the route' : 'Within a 1e-6 per flight hour target'],
    ['Fly-away', `Up to ${n0(r.ac.spd * 10)} m of uncontrolled travel modelled.`, 'Geofence inside the area of intended flight; flight termination armed throughout'],
    ['Crewed aircraft', (air.length ? air.join('; ') + '.' : 'No heliport within 800 m, airport within 3 km or Class B/C/D surface area.') + traffic + (remoteId?.summary?.near ? ` Remote ID walk: ${remoteId.summary.aircraftNear} uncrewed aircraft within ${remoteId.summary.radiusM} m (section 6.2).` : ''), 'ADS-B In, yield to all crewed traffic; letters of agreement with the named heliport operators'],
    ['Obstacles', (hardObs.length ? `${hardObs.length} buildings or obstacles within ${r.opt.obstacleLateralM} m reach or exceed the route's altitude (tallest ${hardObs[0].agl_ft} ft).` : nearObs ? `${nearObs} buildings or obstacles within ${r.opt.obstacleLateralM} m rise to within ${r.opt.obstacleVertFt} ft of the route's altitude.` : `No mapped building or obstacle within ${r.opt.obstacleLateralM} m rises to within ${r.opt.obstacleVertFt} ft of the route's altitude (${altLabel(r)}).`) + lidar,
      'Building footprints and FAA DOF checked each operating day; at least 50 ft vertical clearance; FAA construction notices checked for cranes'],
    ['Power lines', r.powerlines.length ? `${r.powerlines.length} mapped transmission line(s) within ${r.opt.powerlineM} m.` : 'No mapped transmission line within 30 m below 250 ft.', 'Distribution lines are not in public data: site survey of launch and delivery points'],
    ['Weather', `Planned at ${r.wind.kt} kt from ${r.wind.dir}°${r.wind.src ? ` (${r.wind.src})` : ''}; failure drift scales with wind.` + (c ? ` HRRR ${c.year} daytime climatology here: median ${c.p50} kt and 90th percentile ${c.p90} kt at ${c.altFt} ft; the 80 m wind exceeds 15 / 20 / 25 kt in ${pc(c.over['15'])} / ${pc(c.over['20'])} / ${pc(c.over['25'])} of daytime hours, gusts reach ${c.gustP99} kt at the 99th percentile.` : ''),
      `Operating limit ${Math.max(15, Math.ceil(r.wind.kt * 1.3))} kt sustained, no flight in gusts above ${Math.max(20, Math.ceil(r.wind.kt * 1.6))} kt` + (c ? `; expect about ${pc(c.over['20'])} of daytime hours unavailable at a 20 kt limit` : '')],
    ['Noise', `${Math.round(noiseAt(0, r.altMin, r.ac))} dB directly below at the lowest level; 55 dB band extends ${n0(r.halfWidth55)} m each side.`, r.noiseSites.length ? `Notice to ${r.noiseSites.length} sensitive sites inside the band (${r.noiseSites.slice(0, 3).map(s => s.name).join(', ')}${r.noiseSites.length > 3 ? ', …' : ''})` : 'No hospital or school inside the 55 dB band'],
  ];
  const open = [];
  if (hardObs.length || r.blockedShare > 0) open.push('Reroute or change level to clear the building and obstacle conflicts; this package cannot be filed as drawn.');
  if (r.overCeilingShare > 0) open.push(`Request LAANC further coordination or an airspace authorization above the ${r.minCeiling} ft facility map ceiling.`);
  if (r.airspace.some(a => a.kind === 'heliport')) open.push('Obtain letters of agreement from the heliport operators named in section 3.');
  if (r.maxCat === 5) open.push('Reroute around Category 5 ground or prepare the highest-tier safety case.');
  if (r.surfaceHits?.length) open.push('Survey the lidar-flagged trees and structures (section 3) and raise the level or move the route where they reach it.');
  if (!remoteId?.summary?.near) open.push(`Walk the corridor with a Remote ID receiver app at the planned hours to record uncrewed traffic (section 6.2)${remoteId?.summary ? '; the imported log has no position reports near this route' : ''}.`);
  if (r.link && r.link.good < 0.9) open.push('Survey the C2 link along the corridor at operating altitude; public data covers only ground-level phone tests (section 6.5).');
  if ((r.notams || []).some(n => n.active)) open.push('Recheck the NOTAMs in section 4 on the day of operation.');
  open.push('Site survey of launch and delivery points for distribution lines, trees and temporary obstacles.');
  open.push('Replace the generic aircraft class with the operator\'s airframe data (descent rate, glide, source noise, lost-link logic) and its demonstrated failure rate.');
  const sources = Object.entries(L).map(([k, v]) => [k, v.source, v.count.toLocaleString()]);
  if (live?.wind) sources.push(['wind aloft', `Open-Meteo forecast, 10 / 80 / 120 m, valid ${live.wind.at}`, 'live']);
  if (live?.tfr) sources.push(['TFRs', `tfr.faa.gov snapshot ${live.tfr.fetched}`, String(live.tfr.tfrs.length)]);
  if (live?.events) sources.push(['stadium games', 'MLB statsapi, ESPN schedules (FDC 4/3621 stadium TFR windows)', String(live.events.length)]);
  if (live?.notams?.fetched) sources.push(['NOTAMs', `FAA NOTAM API snapshot ${live.notams.fetched}`, String(live.notams.notams.length)]);
  if (remoteId?.summary) sources.push(['Remote ID log', `${remoteId.files.join(', ')} (imported; read in the browser only)`, String(remoteId.summary.records)]);
  return {
    title: 'Concept of Operations, Hazard Assessment and Area of Intended Flight',
    meta: `Corridor ${corridorId(r)} · prepared ${today} · data built ${m.built} · draft for review, not a filed document`,
    blocks: [
      { h: '1. Operation', p: [`Routine beyond-visual-line-of-sight package delivery by a ${r.ac.name.toLowerCase()} (MTOW ${r.ac.mtow} lb) along a fixed ${km(r.lenM)} corridor in ${m.metro}, from ${r.samples[0].ll.map(x => x.toFixed(5)).reverse().join(', ')} to ${r.samples[r.samples.length - 1].ll.map(x => x.toFixed(5)).reverse().join(', ')}, at ${altLabel(r)}${r.levelled ? ` (waypoint levels ${r.alts.join(', ')} ft)` : ''}, cruise ${r.ac.spd} m/s, ${r.minutes.toFixed(1)} min block time. Operations window: ${r.popLabel || TOD[r.tod].label}.`] },
      { h: '2. Area of intended flight and ground risk', p: [
        `The area of intended flight is the convex hull of the corridor and every simulated failure landing: ${area.km2.toFixed(2)} km², attached as GeoJSON. The governing category is <b>Category ${r.maxCat}</b>, taken from the FAA operating categories map at the densest point on the route (${Math.round(r.faaShare * 100)}% of the route is covered by that map; the remainder uses census density thresholds).`,
        `Census ground population along the centerline peaks at ${n0(r.peakD)} people/km² and averages ${n0(r.meanD)} (${r.popLabel || TOD[r.tod].label}, 300 m smoothing${r.hourly ? '; every hour in section 6.1' : ''}).` + (land ? ` Land use under the route (OpenStreetMap): ${land}.` : '')],
        table: [['FAA category', 'Share of route', 'Length'], ...catRows] },
      { h: '3. Hazard assessment', table: [['Hazard', 'Analysis', 'Mitigation'], ...haz] },
      { h: '4. Airspace', p: [r.laancShare > 0 ? `${Math.round(r.laancShare * 100)}% of the route lies in UAS facility map grids (controlled airspace), lowest ceiling ${r.minCeiling} ft AGL. ${r.overCeilingShare > 0 ? `The planned altitude exceeds the ceiling on ${Math.round(r.overCeilingShare * 100)}% of the route.` : 'The planned altitude is within the ceilings; LAANC authorization required.'}` : 'The route lies outside the UAS facility map grids (uncontrolled airspace at the planned altitude).',
        r.airspace.length ? 'Named airspace features: ' + r.airspace.map(a => a.name + (a.conditional ? ' (event days only)' : '')).join('; ') + '.' : 'No heliport, airport, stadium TFR or surface area within the screening distances.',
        ...(r.notams?.length ? [`NOTAMs touching the route: ${r.notams.map(n => `${n.id} (${n.kind}${n.active ? '' : ', not in effect at the planned time'}, ${Math.round(n.dm)} m)`).join('; ')}.`] : live?.notams?.fetched ? ['No NOTAM in the FAA snapshot touches the route.'] : [])] },
      { h: '5. Lost link and contingency', p: [`On loss of command link the aircraft will ${r.ac.lostlink}. ` + (r.land ? `Contingency landing sites are the parks, fields, cemeteries and water within ${r.opt.landingReachM} m of the route (OpenStreetMap land use), available along ${pc(r.land.landingShare)} of it; the longest stretch without one is ${km(r.land.landingGapM)}. ` : 'Contingency landing sites are the lowest-density points on the route (from the density profile) and the launch site. ') + 'Flight termination is armed throughout and bounded by a geofence inside the area of intended flight.'] },
      ...baselines(D, r, traffic, remoteId),
      { h: '7. Findings', list: f.map(([s, t]) => `[${s === 'crit' ? 'blocking' : s === 'warn' ? 'mitigate' : 'ok'}] ${t}`) },
      { h: '8. Open items before filing', list: open },
      { h: '9. Data sources', table: [['Layer', 'Source', 'Records'], ...sources],
        p: ['Known gaps, stated so the reviewer does not have to find them: distribution power lines are not in public data; OSM building heights are partial and some masts and cranes use conservative default heights; lidar surface heights come from the 2020–2021 King and Pierce surveys (Snohomish and Kitsap have no public 3DEP point cloud on AWS), read at 50 m from an even subsample of the returns, so they are conservative laterally by up to one cell and miss single poles and wires; crewed traffic is weekday daytime ADS-B heard by OpenSky receivers, so aircraft without ADS-B Out and weekend recreational flying are under-counted; daytime population is modelled, not measured: the presets use 0.55 × residents + jobs (LEHD 2021), and the hourly model weights residents and jobs by national time-use shares (localised only for commute timing and work from home), applies the shares of people 15 and over to children too, and spreads people who are out or travelling over job cells; LODES places jobs at the reporting establishment, so downtown tower blocks can read up to about twice their real daytime density (conservative for risk); the FAA operating categories layer is read from the FAA ADDS public service and its regulatory status should be confirmed against the final rule; road counts cover only Seattle arterials and state highways, noise complaints only Seattle, and the Ookla tiles are ground-level phone tests from one quarter.'] },
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
