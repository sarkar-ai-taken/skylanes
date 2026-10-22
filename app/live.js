// Live conditions fetched in the browser: wind at drone altitudes (Open-Meteo) and stadium games that switch on the
// FAA stadium TFR (MLB statsapi, ESPN). TFRs come from data/tfr.json, refreshed hourly by the Pages workflow.
// Every fetch fails soft: callers get null and fall back to presets.

const FT = 3.28084;

/** Wind now at 10 m, 80 m and 120 m above ground for one point, plus gusts. */
export async function windAloft(lat, lon) {
  try {
    const q = new URLSearchParams({ latitude: lat, longitude: lon, wind_speed_unit: 'kn', forecast_hours: 2,
      hourly: 'wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m,wind_gusts_10m', timezone: 'UTC' });
    const h = (await (await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json()).hourly;
    const now = new Date(), k = Math.max(0, h.time.findIndex(t => new Date(t + 'Z') > now) - 1);
    const levels = [10, 80, 120].map(m => ({ ft: Math.round(m * FT), kt: h[`wind_speed_${m}m`][k], dir: h[`wind_direction_${m}m`][k] }));
    return { at: h.time[k] + 'Z', levels, gustKt: h.wind_gusts_10m[k], source: 'Open-Meteo' };
  } catch { return null; }
}

/** Wind at altFt from the profile: linear between levels, direction interpolated as a vector. */
export function windAt(profile, altFt) {
  const L = profile.levels;
  let i = 0; while (i < L.length - 2 && altFt > L[i + 1].ft) i++;
  const a = L[i], b = L[i + 1], t = Math.max(0, Math.min(1.5, (altFt - a.ft) / (b.ft - a.ft))); // mild extrapolation above 120 m
  const vec = l => [l.kt * Math.sin(l.dir * Math.PI / 180), l.kt * Math.cos(l.dir * Math.PI / 180)];
  const [ax, ay] = vec(a), [bx, by] = vec(b), x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
  const kt = Math.round(Math.hypot(x, y)), dir = Math.round((Math.atan2(x, y) * 180 / Math.PI + 360) % 360);
  const surface = L[0].kt || 1;
  return { kt, dir, g: Math.min(0.6, Math.max(0.1, (profile.gustKt - surface) / surface)) };
}

// FAA FDC 4/3621: MLB, NFL and NCAA Division I football games, 3 NM, 3,000 ft AGL, 1 h before to 1 h after the event.
const LEAGUES = [
  { league: 'NFL', stadium: 'Lumen Field', hours: 3.25, espn: 'football/nfl/teams/sea' },
  { league: 'NCAA football', stadium: 'Husky Stadium', hours: 3.5, espn: 'football/college-football/teams/264' },
];

/** 00:00 in Seattle on a YYYY-MM-DD date, whatever the daylight-saving offset. */
export function pacificMidnight(ymd) {
  const utc = Date.parse(ymd + 'T00:00:00Z');
  const laHour = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(utc);
  return new Date(utc + ((24 - laHour) % 24) * 36e5);
}

/** Home games in the next `days` days at stadiums with the standing FAA TFR. */
export async function stadiumEvents(days = 30) {
  const now = Date.now(), until = now + days * 864e5, out = [];
  const window = (stadium, league, title, start, hours, tbd) => {
    let s = new Date(start);
    // Kickoff not announced: ESPN parks it at midnight Eastern on the game date. Close that whole Pacific day.
    if (tbd) s = pacificMidnight(s.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    const tfrStart = tbd ? s : new Date(s.getTime() - 36e5);
    const tfrEnd = tbd ? new Date(s.getTime() + 24 * 36e5) : new Date(s.getTime() + (hours + 1) * 36e5);
    if (tfrEnd.getTime() > now && s.getTime() < until) out.push({ stadium, league, title, start: s, tfrStart, tfrEnd, tbd });
  };
  const jobs = LEAGUES.map(async L => {
    const d = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/${L.espn}/schedule`)).json();
    for (const e of d.events || []) {
      const c = e.competitions?.[0];
      if (!c || !(c.venue?.fullName || '').includes(L.stadium.split(' ')[0])) continue;
      window(L.stadium, L.league, e.shortName, e.date, L.hours, c.timeValid === false);
    }
  });
  jobs.push((async () => {
    const fmt = t => new Date(t).toISOString().slice(0, 10);
    const d = await (await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=136&hydrate=venue&startDate=${fmt(now - 864e5)}&endDate=${fmt(until)}`)).json();
    for (const day of d.dates || []) for (const g of day.games) if (g.venue?.name === 'T-Mobile Park')
      window('T-Mobile Park', 'MLB', `${g.teams.away.team.name} @ Mariners`, g.gameDate, 3, false);
  })());
  const settled = await Promise.allSettled(jobs);
  return { events: out.sort((a, b) => a.start - b.start), failed: settled.filter(s => s.status === 'rejected').length };
}

/** Active TFRs near the metro, from the hourly snapshot shipped with the site. */
export async function loadTfrs() {
  try { const t = await (await fetch('data/tfr.json', { cache: 'no-cache' })).json(); return t.fetched ? t : null; } catch { return null; }
}

/** NOTAMs around the metro, from the snapshot the Pages workflow writes when it has an FAA API key. */
export async function loadNotams() {
  try { const t = await (await fetch('data/notams.json', { cache: 'no-cache' })).json(); return t; } catch { return null; }
}
