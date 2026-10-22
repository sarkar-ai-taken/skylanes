"""The region the pipeline builds. Adding a region means adding an entry here and pointing METRO at it."""

METROS = {
    "seattle": {
        "name": "Seattle",
        "state": "wa",
        "state_fips": "53",
        # west, south, east, north (WGS84). Shilshole to Lake Washington, Northgate to Boeing Field.
        "bbox": [-122.46, 47.48, -122.22, 47.74],
        "grid_m": 100,
    },
    "puget": {
        # Central Puget Sound: King, Pierce, Snohomish and Kitsap counties.
        # Marysville to Puyallup, Bremerton to North Bend.
        "name": "Greater Seattle",
        "state": "wa",
        "state_fips": "53",
        "bbox": [-122.85, 47.05, -121.75, 48.05],
        "grid_m": 100,
    },
}
METRO = METROS["puget"]
