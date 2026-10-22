# Corridor — Sky Lanes Seattle

Draw a delivery-drone route over Seattle and get a draft safety-case package: FAA operating category, census ground risk,
Monte Carlo failure footprints, expected ground fatalities per flight hour, obstacles, power lines, LAANC ceilings,
heliports and stadium TFRs, noise, and an area of intended flight. All on real public data.

Routes are tested against real building footprints (OSM, incl. tower parts) and FAA obstacles with one rule: keep
30 m sideways from anything that rises to within 50 ft of the route's level. Each waypoint can carry its own altitude
(click it on the map), and two planners fix conflicts: **Climb over** raises only the legs that need it, within 400 ft
and the LAANC ceiling; **Go around** finds a path around buildings at the current level (A* on a 15 m grid).

**Sky lanes** (switch on the map): an air-road network over OSM arterials in three tiers, one level per direction:
drones at 250 / 350 ft (flyable today), air taxis at 800 / 1000 ft and personal flight at 1600 / 2000 ft (2035 scenario).
Every stretch is scored with the same engine: open, blocked by a structure, over the LAANC ceiling, over Category 5
ground, or inside Class B (needs ATC). A traffic control fills open lanes to 0–100% of capacity (one aircraft per 500 m).

**Live conditions** (no keys): wind at 10 / 80 / 120 m from Open-Meteo, interpolated to the route's altitude;
MLB, NFL and NCAA football home games (MLB statsapi, ESPN) that switch on the FAA stadium TFR, with exact closure
windows; and active Washington TFRs from tfr.faa.gov. That site blocks browser requests, so the Pages workflow
fetches it hourly (`pipeline/tfr.mjs`) and ships `data/tfr.json` with the site.

**Live:** https://sarkar-ai-taken.github.io/skylanes/ · no sign-up, no API keys, runs entirely in the browser.
Every analysis is a shareable link (the route and settings live in the URL).

> Prototype for planning and discussion. Not an FAA product and not a filed document.

## Run

    npm run serve        # http://localhost:8080
    npm test             # engine + package tests (node, no deps)
    npm run build-data   # refetch and rebuild app/data/ (needs .venv with shapely, pyshp)

Set up the pipeline once: `python3 -m venv .venv && .venv/bin/pip install shapely pyshp`.

## Prototype it yourself, free

Everything here runs on free public data and free hosting.

1. Fork this repo. In the fork, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The workflow runs the tests and publishes `app/` to `https://<you>.github.io/<repo>/`.
3. Change the engine (`app/engine.js`), the sample routes (`app/routes.js`) or the package text (`app/package.js`) and push again.

To try another US metro, add an entry to `pipeline/metro.py` (bbox, state, county FIPS), switch `METRO` to it,
run `npm run build-data`, commit `app/data/`, and update the initial map bounds in `app/ui.js`.

## Layout

- `pipeline/fetch.py` downloads raw public data to `data/raw/` (not committed). `pipeline/build.py` writes compact layers to `app/data/`.
- `pipeline/metro.py` is the one place a metro is defined. A second metro is a new entry there plus a rebuild.
- `app/engine.js` scoring (pure, tested). `app/package.js` the generated document. `app/ui.js` map and rail.
- `app/routes.js` sample delivery corridors.

## Data (all public, free)

| Layer | Source |
| --- | --- |
| Residents | US Census 2020 TIGER/Line blocks, POP20 |
| Daytime population | LEHD LODES8 workplace area characteristics 2021 (jobs per block) |
| Density category | FAA ADDS "Operating Categories Map" service |
| Obstacles | FAA Digital Obstacle File (daily) + OSM masts, towers, cranes |
| Buildings | OSM building and building:part footprints ≥ 20 m or ≥ 6 levels (same source as the 3D basemap) |
| Power lines | OSM `power=line` (transmission only) |
| Controlled airspace | FAA UAS Facility Map grids, FAA Class airspace surface areas |
| Heliports, airports, stadiums | FAA ADDS + OSM |
| Hospitals, schools | OSM |
| Sky-lane network | OSM `highway=motorway/trunk/primary/secondary`, scored by `pipeline/lanes.mjs` |
| Wind | Open-Meteo forecast at 10 / 80 / 120 m (live, default); NWS KBFI surface observation; presets |
| Stadium TFR windows | MLB statsapi (Mariners), ESPN (Seahawks, Huskies), live |
| TFRs | tfr.faa.gov list + XNOTAM shapes, hourly |
| Basemap and 3D buildings | OpenFreeMap (OpenMapTiles) |

Known gaps are written into every generated package (section 8).

## Earlier prototypes

`corridor.html` (synthetic 2.5D planner) and `skylanes.html` (3D stacked-lane world) are kept for reference and
published under `/prototypes/` on the site.

## Data credits

US Census Bureau (2020 TIGER/Line blocks, LEHD LODES), FAA (Digital Obstacle File, UAS Facility Maps, ADDS),
National Weather Service, © OpenStreetMap contributors (ODbL), OpenFreeMap / OpenMapTiles.

## License

Code: [MIT](LICENSE). The data in `app/data/` keeps its sources' terms: US government data (Census, FAA, NWS) is
public domain; OpenStreetMap-derived layers are © OpenStreetMap contributors under the
[ODbL](https://www.openstreetmap.org/copyright), which requires attribution and share-alike for derived databases.
