// Sample delivery corridors on real Seattle geography: [lon, lat] waypoints.
export const ROUTES = [
  { id: 'magnolia', name: 'Interbay hub → Magnolia homes', aircraft: 'quad', altFt: 300,
    path: [[-122.3790, 47.6450], [-122.3880, 47.6490], [-122.3990, 47.6500], [-122.4080, 47.6470]] },
  { id: 'ballard', name: 'Ballard store → Sunset Hill', aircraft: 'quad', altFt: 250,
    path: [[-122.3830, 47.6680], [-122.3920, 47.6720], [-122.4010, 47.6770]] },
  { id: 'fremont', name: 'Fremont → Wallingford over the Ship Canal', aircraft: 'fixed', altFt: 350,
    path: [[-122.3500, 47.6500], [-122.3420, 47.6530], [-122.3340, 47.6600], [-122.3280, 47.6620]] },
  { id: 'downtown', name: 'Pike Place → First Hill (fails)', aircraft: 'quad', altFt: 300,
    path: [[-122.3420, 47.6095], [-122.3330, 47.6060], [-122.3240, 47.6040]] },
];
