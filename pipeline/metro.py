"""The one metro the pipeline builds. Adding a metro means adding an entry here."""

METROS = {
    "seattle": {
        "name": "Seattle",
        "state": "wa",
        "state_fips": "53",
        "county_fips": ["033"],  # King County
        # west, south, east, north (WGS84). Shilshole to Lake Washington, Northgate to Boeing Field.
        "bbox": [-122.46, 47.48, -122.22, 47.74],
        "grid_m": 100,
    },
}
METRO = METROS["seattle"]
