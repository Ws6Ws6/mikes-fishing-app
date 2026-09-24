# Mike's Fishing App (prototype)

Mobile-friendly web map for Joey / Mike: **statewide Indiana boat launches** plus **Northeast Indiana** lake depth contours.

## Features

- OpenStreetMap street basemap + free Esri World Imagery satellite toggle
- Real DNR / IndianaMap bathymetric **vector contours** (feet below surface) with depth labels
- Lake search/list for Steuben, LaGrange, Noble, DeKalb, Kosciusko, Elkhart, Whitley, Allen
- Lake card: name, county, max depth, acres, Drive here (Google Maps), Next nearest lake
- **Trolling mode**: live/demo GPS boat marker + heading, follow-me, breadcrumb track, speed (mph), approximate depth from nearest survey contour, Screen Wake Lock
- **Boat launches / ramps** (statewide Indiana): public DNR access sites + private/commercial sites from Indiana recreational inventory and OSM (tagged), with map toggle, clusters, and nearby list on lake cards

## Run locally

```bash
cd /workspace/mikes-fishing-app
python3 -m http.server 8899 --directory public
# open http://127.0.0.1:8899/
```

## Rebuild depth data from IndianaMap

```bash
python3 -m venv .venv && .venv/bin/pip install shapely
.venv/bin/python scripts/rebuild_data.py
```

## Rebuild boat launches

```bash
.venv/bin/python scripts/rebuild_launches.py
# writes data/launches.geojson and copies to public/data/ (real file, no symlink)
```

Sources: Indiana DNR Fish_Access_RO (public), IndianaMap Recreational Facility Locations (Private/Commercial with ramps), OpenStreetMap slipways. Private coverage is only what appears in those open datasets — gated club directories are not scraped.

## Data honesty

No invented depths. Contours come from Indiana DNR Fish & Wildlife surveys published on IndianaMap. Contour intervals are typically **5 or 10 ft** (varies by lake). Suitable for planning / relative structure, **not** a substitute for boat sonar. Some lakes only have PDF maps on the DNR site (listed in-app without contours).

## Screenshots

See `screenshots/`.

## Trolling mode

- Max zoom 22 (basemap tiles overzoom past native 19 so the map never goes blank)
- Vector contour lines + repeated depth labels when zoomed in
- Boat GPS marker with heading arrow, follow-me, breadcrumb track, speed (mph)
- Approximate depth from nearest survey contour (labeled as approximate; not sonar)
- Screen Wake Lock while trolling is active
- Demo GPS: open a lake → **Troll here** (or boat button) when geolocation is unavailable

## Contour precision (source limits)

Indiana DNR bathymetry (IndianaMap FeatureServer): surveyed with Biosonics DTX echosounder;
shoreline = 0; values are **feet below surface**. Contour **intervals commonly 5 or 10 ft**
(some lakes 1–3 ft). Suitable for structure / relative depth while trolling, **not** centimeter-accurate
navigation or a substitute for live sonar. A few named lakes (e.g. Tippecanoe) have incomplete
vector coverage in the FeatureServer even when a PDF survey exists — the app flags that.
