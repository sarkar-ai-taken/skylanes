// Sample delivery corridors on real greater-Seattle geography: [lon, lat] waypoints.
export const ROUTES = [
  { id: 'magnolia', name: 'Interbay hub → Magnolia homes', aircraft: 'quad', altFt: 300,
    path: [[-122.3790, 47.6450], [-122.3880, 47.6490], [-122.3990, 47.6500], [-122.4080, 47.6470]] },
  { id: 'ballard', name: 'Ballard store → Sunset Hill', aircraft: 'quad', altFt: 250,
    path: [[-122.3830, 47.6680], [-122.3920, 47.6720], [-122.4010, 47.6770]] },
  { id: 'fremont', name: 'Fremont → Wallingford over the Ship Canal', aircraft: 'fixed', altFt: 350,
    path: [[-122.3500, 47.6500], [-122.3420, 47.6530], [-122.3340, 47.6600], [-122.3280, 47.6620]] },
  { id: 'downtown', name: 'Pike Place → First Hill (fails)', aircraft: 'quad', altFt: 300,
    path: [[-122.3420, 47.6095], [-122.3330, 47.6060], [-122.3240, 47.6040]] },
  { id: 'bellevue', name: 'Bellevue: through the downtown towers → Bridle Trails', aircraft: 'quad', altFt: 300,
    path: [[-122.1950, 47.6120], [-122.1880, 47.6250], [-122.1800, 47.6380]] },
  { id: 'issaquah', name: 'Issaquah: Highlands hub → Squak Mountain homes', aircraft: 'quad', altFt: 300,
    path: [[-122.0230, 47.5430], [-122.0380, 47.5320], [-122.0520, 47.5240]] },
  { id: 'redmond', name: 'Redmond: Overlake → Education Hill', aircraft: 'fixed', altFt: 350,
    path: [[-122.1380, 47.6380], [-122.1250, 47.6600], [-122.1150, 47.6850]] },
  { id: 'tacoma', name: 'Tacoma: Tideflats → Hilltop', aircraft: 'quad', altFt: 300,
    path: [[-122.4100, 47.2620], [-122.4300, 47.2560], [-122.4500, 47.2520]] },
];
