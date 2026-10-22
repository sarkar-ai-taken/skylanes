# Corridor — Sky Lanes Seattle

Draw a delivery-drone route anywhere in greater Seattle (King, Pierce, Snohomish and Kitsap counties) and get a draft safety-case package: FAA operating category, census ground risk,
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

**Site data** (built offline from public archives, no keys): surface heights from **USGS 3DEP lidar** point clouds
(trees and unmapped structures, 50 m), **crewed traffic** per altitude band from historical **OpenSky ADS-B**, a year
of **NOAA HRRR** wind (percentiles, exceedance of drone limits, worst month), and **OSM land use** under the route
(contingency landing sites). Each feeds the score, the findings and the package; see [Site data](#site-data).

**Live conditions** (no keys): wind at 10 / 80 / 120 m from Open-Meteo, interpolated to the route's altitude;
MLB, NFL and NCAA football home games (MLB statsapi, ESPN) that switch on the FAA stadium TFR, with exact closure
windows; and active Washington TFRs from tfr.faa.gov. That site blocks browser requests, so the Pages workflow
fetches it hourly (`pipeline/tfr.mjs`) and ships `data/tfr.json` with the site.

**Live:** https://sarkar-ai-taken.github.io/skylanes/ (planner) · [/ride.html](https://sarkar-ai-taken.github.io/skylanes/ride.html) (fly an air taxi) · [/fleet.html](https://sarkar-ai-taken.github.io/skylanes/fleet.html) (warehouse fleet simulation) · [/address.html](https://sarkar-ai-taken.github.io/skylanes/address.html) (is my home under a lane?) · no sign-up, no API keys, runs entirely in the browser.
Every analysis is a shareable link (the route and settings live in the URL).

> Prototype for planning and discussion. Not an FAA product and not a filed document.

## Run

    npm run serve        # http://localhost:8080
    npm test             # engine + package tests (node, no deps)
    npm run build-data   # refetch and rebuild app/data/ (needs the .venv below)

Set up the pipeline once: `python3 -m venv .venv && .venv/bin/pip install shapely pyshp numpy numcodecs laspy lazrs`.
A first `build-data` downloads about 12 GB (mostly ADS-B and lidar) into `data/raw/` and takes about an hour on a
home connection; reruns reuse it. `fetch.py --force --only <name>,<name>` refetches single sources.

## Four pages

- **Plan a route** (`index.html`): the safety-case planner above.
- **Ride** (`ride.html`): pick two concept vertiports and fly an air taxi on the 800 / 1,000 ft lanes, with chase, cabin
  and orbit cameras, a heads-up display and a car-time comparison. A 2035 concept on today's map. Take over with the
  arrow keys, WASD or the on-screen pad: left / right and up / down steer inside the 80 m × 200 ft lane box while the
  autopilot keeps the speed; pushing past an edge is refused with an error and that edge lights red. Virtual traffic
  signals sit at the busiest lane junctions (at least 2 km apart); the taxi brakes for red and holds before the gate
  (`app/ride-sim.js`, deterministic, tested).
- **Fleet** (`fleet.html`): place a warehouse, set drones, order rate, radius and delivery promise. Orders arrive at
  census-weighted homes; each is checked by the engine (range, Category 5 drop, airspace approval, buildings, stadium
  TFRs) and either dispatched, rerouted, flown lower or refused with a reason. Playback in 3D with KPIs and charts
  (`app/fleet-sim.js`, deterministic, tested).
- **My address** (`address.html`): type an address (geocoded by OpenStreetMap Nominatim; map tiles for
  the area load from OpenFreeMap; the lane check runs in the browser), click the map or use your location, and get a plain answer: is a drone, air-taxi or personal-flight lane
  overhead (centreline within 40 m), nearby (inside the tier's 55 dB band, at least 150 m) or clear, with distance,
  direction, lane status and expected noise (`lanesNear` in `app/engine.js`, tested).

Each page has an "Expand beyond Seattle" sign-up box. It stays closed until `app/config.js` names an endpoint
(Formspree or a Google Form).

## Coverage

The data covers Central Puget Sound: Marysville to Puyallup, Bremerton to North Bend (about 9,000 km², 4.1 million
residents). The population grid is split into 8 km tiles (`app/data/tiles/`) that load only where you look or fly, so
coverage can grow to all of Washington by widening the box in `pipeline/metro.py` and rebuilding. A route over
ground without data is flagged as outside coverage, never scored as empty.

## Prototype it yourself, free

Everything here runs on free public data and free hosting.

1. Fork this repo. In the fork, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The workflow runs the tests and publishes `app/` to `https://<you>.github.io/<repo>/`.
3. Change the engine (`app/engine.js`), the sample routes (`app/routes.js`) or the package text (`app/package.js`) and push again.

To try another region, add an entry to `pipeline/metro.py` (bbox and state), switch `METRO` to it,
run `npm run build-data`, commit `app/data/`, and update the initial map bounds in `app/ui.js`.

## Site data

| Layer | How it is built | What the engine does with it |
| --- | --- | --- |
| Surface height (`pipeline/lidar.py`) | USGS 3DEP point clouds on AWS (Entwine), read to octree depth 6: one return per 25–80 m². Height above the 3DEP bare-earth DEM, second-highest return per 50 m cell. Aircraft, birds and cloud decks are removed (a small or unfiled cluster floating above a 40 m gap). Multi-return share tells canopy from roofs. | Trees and structures that no mapped footprint or filed obstacle explains join the 30 m / 50 ft clearance rule, the planners and the sky lanes; each stretch is a finding. Cells a footprint explains are left to the footprint. |
| Crewed traffic (`pipeline/adsb.py`) | OpenSky Network state vectors (10 s) for 4 Mondays, one per season, 07:00–17:00 PDT, below 3,000 ft above the 3DEP terrain; rotorcraft from the OpenSky aircraft database. Mean aircraft present per km² per band (0–500, 500–1,000, 1,000–2,000, 2,000–3,000 ft), 1 km cells. | Traffic level at the route's band against the region's distribution, helicopter share, and crewed aircraft passing within 1 km per flight hour (density × 2R × relative speed). |
| Wind climatology (`pipeline/hrrr.py`) | Every hourly NOAA HRRR analysis of 2025 (3 km), 10 m and 80 m wind and gust, rotated to true north; daytime hours 07:00–20:00. | Two wind presets (typical day, windy day) at the route's level, the share of hours over 15 / 20 / 25 kt, the worst month, gust p99. |
| Land use (`fetch.py`, `build.py`) | OSM landuse, leisure, natural and amenity areas rasterized to 100 m, the most specific area winning. | Land-use mix under the route and the longest stretch with no park, field, cemetery or water within 150 m. |
| NOTAMs (`pipeline/notams.mjs`) | FAA NOTAM API within 50 NM, hourly in the Pages workflow. Needs a free key pair from api.faa.gov in the repository secrets `FAA_NOTAM_CLIENT_ID` and `FAA_NOTAM_CLIENT_SECRET`; without them the snapshot is empty and says why. | Active obstacle NOTAMs within 600 m that reach the route's level, and any NOTAM area the route enters, become findings. |

Known limits: lidar covers King and Pierce (Snohomish and Kitsap have no 3DEP point cloud on AWS yet) and dates from
2020–2021; the ADS-B sample is weekday daytime and only sees aircraft with ADS-B Out that OpenSky receivers heard;
OSM land use is complete in Seattle and patchy outside it.

## Layout

- `pipeline/fetch.py` downloads raw public data to `data/raw/` (not committed); `lidar.py`, `hrrr.py` and `adsb.py` sample the large archives there. `pipeline/build.py` writes compact layers to `app/data/`.
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
| Wind | Open-Meteo forecast at 10 / 80 / 120 m (live, default); NWS KBFI surface observation; NOAA HRRR 2025 climatology; presets |
| Trees and unmapped structures | USGS 3DEP lidar point clouds (King County 2021, Pierce County 2020), 3DEP bare-earth DEM |
| Crewed traffic | OpenSky Network historical ADS-B state vectors and aircraft database |
| Land use | OpenStreetMap landuse, leisure, natural and amenity areas |
| NOTAMs | FAA NOTAM API (hourly, with an API key) |
| Stadium TFR windows | MLB statsapi (Mariners), ESPN (Seahawks, Huskies), live |
| TFRs | tfr.faa.gov list + XNOTAM shapes, hourly |
| Basemap and 3D buildings | OpenFreeMap (OpenMapTiles) |

Known gaps are written into every generated package (section 8).

## Earlier prototypes

`corridor.html` (synthetic 2.5D planner) and `skylanes.html` (3D stacked-lane world) are kept for reference and
published under `/prototypes/` on the site.

## Data credits

US Census Bureau (2020 TIGER/Line blocks, LEHD LODES), FAA (Digital Obstacle File, UAS Facility Maps, ADDS, NOTAM API),
National Weather Service, USGS 3D Elevation Program, NOAA HRRR (via the University of Utah HRRR Zarr archive),
OpenSky Network (Schäfer et al., "Bringing up OpenSky", IPSN 2014; non-commercial research use), © OpenStreetMap contributors (ODbL), OpenFreeMap / OpenMapTiles.

## License

Code: [MIT](LICENSE). The data in `app/data/` keeps its sources' terms: US government data (Census, FAA, NWS) is
public domain; OpenStreetMap-derived layers are © OpenStreetMap contributors under the
[ODbL](https://www.openstreetmap.org/copyright), which requires attribution and share-alike for derived databases.
