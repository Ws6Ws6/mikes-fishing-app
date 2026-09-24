# Mike's Fishing App

Mobile-friendly web map of **Northeast Indiana** lake depth contours for Joey / Mike.

**Live:** https://ws6ws6.github.io/mikes-fishing-app/

## Features

- OpenStreetMap street basemap + free Esri World Imagery satellite toggle
- Real DNR / IndianaMap bathymetric **vector contours** (feet below surface) with depth labels
- Lake search/list for Steuben, LaGrange, Noble, DeKalb, Kosciusko, Elkhart, Whitley, Allen
- Lake card: name, county, max depth, acres, Drive here (Google Maps), Next nearest lake
- **Trolling mode**: live/demo GPS boat marker + heading, follow-me, breadcrumb track, speed (mph), approximate depth from nearest survey contour, Screen Wake Lock

## Run locally

```bash
# From repo root — serve the static site (public/ already includes data/)
python3 -m http.server 8899 --directory public
# open http://127.0.0.1:8899/
```

## Rebuild depth data from IndianaMap

```bash
python3 -m venv .venv && .venv/bin/pip install shapely
.venv/bin/python scripts/rebuild_data.py
# Copy rebuilt files into public/data for local serving and Pages:
cp data/lakes.geojson data/contours.geojson data/sources.json public/data/
```

Then commit and push `main`. Redeploy Pages by updating the `gh-pages` branch with the contents of `public/` (plus `.nojekyll`).

## Data attribution

Bathymetric contours and lake survey attributes come from the **Indiana Department of Natural Resources (DNR) Fish & Wildlife** surveys published on **IndianaMap**. Contour intervals are typically **5 or 10 ft** (varies by lake). Suitable for planning / relative structure, **not** a substitute for boat sonar. Some lakes only have PDF maps on the DNR site (listed in-app without contours).

No invented depths.

## Contour precision (source limits)

Indiana DNR bathymetry (IndianaMap FeatureServer): surveyed with Biosonics DTX echosounder; shoreline = 0; values are **feet below surface**. Contour **intervals commonly 5 or 10 ft** (some lakes 1–3 ft). Suitable for structure / relative depth while trolling, **not** centimeter-accurate navigation or a substitute for live sonar. A few named lakes (e.g. Tippecanoe) have incomplete vector coverage in the FeatureServer even when a PDF survey exists — the app flags that.

## Screenshots

See `screenshots/`.
