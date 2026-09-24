#!/usr/bin/env python3
"""Rebuild static GeoJSON for Mike's Fishing App from IndianaMap DNR bathymetry.

Usage:
  python3 scripts/rebuild_data.py          # uses system python if shapely available
  .venv/bin/python scripts/rebuild_data.py # preferred

Sources (public ArcGIS REST, no API key):
  Contours: https://gisdata.in.gov/server/rest/services/Hosted/Lake_Bathymetry_RO/FeatureServer/0
  Outlines: https://gisdata.in.gov/server/rest/services/Hosted/Lake_Bathymetry_RO/FeatureServer/1
  PDF maps: https://www.in.gov/dnr/fish-and-wildlife/fishing/lake-depth-maps
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
NE_COUNTIES_SQL = (
    "county1_name IN ('STEUBEN','LAGRANGE','NOBLE','DEKALB','KOSCIUSKO','KOSCIUSCO',"
    "'ELKHART','WHITLEY','ALLEN') OR county2_name IN ('STEUBEN','LAGRANGE','NOBLE',"
    "'DEKALB','KOSCIUSKO','KOSCIUSCO','ELKHART','WHITLEY','ALLEN')"
)
CONTOURS_URL = (
    "https://gisdata.in.gov/server/rest/services/Hosted/"
    "Lake_Bathymetry_RO/FeatureServer/0/query"
)

try:
    from shapely.geometry import mapping, shape
except ImportError:
    print("Install shapely: python3 -m venv .venv && .venv/bin/pip install shapely", file=sys.stderr)
    sys.exit(1)


def query(params: dict) -> dict:
    qs = urllib.parse.urlencode(params)
    with urllib.request.urlopen(CONTOURS_URL + "?" + qs, timeout=180) as r:
        return json.load(r)


def fix_county(c: str | None) -> str | None:
    if not c:
        return None
    c = c.upper().replace(".", "")
    return {
        "LAGRANGE": "LaGrange",
        "STEUBEN": "Steuben",
        "NOBLE": "Noble",
        "DEKALB": "DeKalb",
        "KOSCIUSKO": "Kosciusko",
        "KOSCIUSCO": "Kosciusko",
        "ELKHART": "Elkhart",
        "WHITLEY": "Whitley",
        "ALLEN": "Allen",
    }.get(c, c.title())


def fix_name(n: str) -> str:
    if n == "JAMES LAKE":
        return "James Lake"
    if n == "TROY-CEDAR LAKE":
        return "Troy-Cedar Lake"
    return n


def round_coords(obj, n=6):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(x), n) for x in obj]
        return [round_coords(x, n) for x in obj]
    return obj


def download_contours() -> dict:
    features = []
    offset = 0
    page = 1000
    while True:
        print(f"Fetching contours offset={offset}...")
        data = query(
            {
                "where": NE_COUNTIES_SQL,
                "outFields": (
                    "objectid,contour,lake_name,county1_name,county2_name,"
                    "lake_acres,lake_max_depth,survey_date,line_type,"
                    "finfo_lakeid,nhdid_waterbody"
                ),
                "returnGeometry": "true",
                "outSR": "4326",
                "resultOffset": offset,
                "resultRecordCount": page,
                "f": "geojson",
            }
        )
        feats = data.get("features", [])
        print(f"  got {len(feats)}")
        features.extend(feats)
        if not data.get("exceededTransferLimit") and len(feats) < page:
            break
        if not feats:
            break
        offset += len(feats)
        time.sleep(0.25)
    return {"type": "FeatureCollection", "features": features}


PDF_ONLY = [
    {"name": "Bower Lake", "county": "Steuben", "year": 2023},
    {"name": "Loon Lake", "county": "Steuben", "year": 2011},
    {"name": "Meserve Lake", "county": "Steuben", "year": 2009},
    {"name": "Ball Lake", "county": "Steuben", "year": 2013},
    {"name": "Beaverdam Lake", "county": "Steuben", "year": 2013},
    {"name": "Gooseneck Lake", "county": "Steuben", "year": 2014},
    {"name": "Green Lake", "county": "Steuben", "year": 2013},
    {"name": "Henry Lake", "county": "Steuben", "year": 2014},
    {"name": "Lake Arrowhead", "county": "Steuben", "year": 2014},
    {"name": "Lime Lake", "county": "Steuben", "year": 2014},
    {"name": "Little Otter Lake", "county": "Steuben", "year": 2013},
    {"name": "Silver Lake", "county": "Steuben", "year": 2014},
    {"name": "Big Otter Lake", "county": "Steuben", "year": 2015},
    {"name": "Fox Lake", "county": "Steuben", "year": 2015},
    {"name": "Gage Lake", "county": "Steuben", "year": 2015},
    {"name": "Hamilton Lake", "county": "Steuben", "year": 2022},
    {"name": "West Otter Lake", "county": "Steuben", "year": 2015},
    {"name": "Atwood Lake", "county": "LaGrange", "year": 2010},
    {"name": "Big Long Lake", "county": "LaGrange", "year": 2008},
    {"name": "Little Turkey Lake", "county": "LaGrange", "year": 2007},
    {"name": "Shipshewana Lake", "county": "LaGrange", "year": 2011},
    {"name": "Stone Lake", "county": "LaGrange", "year": 2011},
    {"name": "Adams Lake", "county": "LaGrange", "year": 2014},
    {"name": "Meteer Lake", "county": "LaGrange", "year": 2013},
    {"name": "Nauvoo Lake", "county": "LaGrange", "year": 2014},
    {"name": "Troxel Lake", "county": "LaGrange", "year": 2014},
    {"name": "Brokesha Lake", "county": "LaGrange", "year": 2015},
    {"name": "Cedar Lake", "county": "LaGrange", "year": 2017},
    {"name": "Bixler Lake", "county": "Noble", "year": 2022},
    {"name": "Cree Lake", "county": "Noble", "year": 2007},
    {"name": "Hindman Lake", "county": "Noble", "year": 2012},
    {"name": "Jones Lake", "county": "Noble", "year": 2007},
    {"name": "Latta Lake", "county": "Noble", "year": 2007},
    {"name": "Mud Lake", "county": "Noble", "year": 2011},
    {"name": "Steinbarger Lake", "county": "Noble", "year": 2007},
    {"name": "Tamarack Lake", "county": "Noble", "year": 2011},
    {"name": "Waldron Lake", "county": "Noble", "year": 2011},
    {"name": "Harper Lake", "county": "Noble", "year": 2013},
    {"name": "Big Lake", "county": "Noble", "year": 2013},
    {"name": "Crane Lake", "county": "Noble", "year": 2014},
    {"name": "Lindsey Lake", "county": "Noble", "year": 2014},
    {"name": "Loon Lake", "county": "Noble", "year": 2013},
    {"name": "Miller Lake", "county": "Noble", "year": 2013},
    {"name": "Moss Lake", "county": "Noble", "year": 2013},
    {"name": "Pleasant Lake", "county": "Noble", "year": 2014},
    {"name": "Summit Lake", "county": "Noble", "year": 2014},
    {"name": "Upper Long Lake", "county": "Noble", "year": 2013},
    {"name": "Eagle Lake", "county": "Noble", "year": 2015},
    {"name": "Engle Lake", "county": "Noble", "year": 2015},
    {"name": "Skinner Lake", "county": "Noble", "year": 2015},
    {"name": "Crooked Lake", "county": "Noble", "year": 2017},
    {"name": "Sylvan Lake (East/West)", "county": "Noble", "year": 2021},
    {"name": "Irish Lake", "county": "Kosciusko", "year": 2023},
    {"name": "Hill Lake", "county": "Kosciusko", "year": 2011},
    {"name": "Little Barbee Lake", "county": "Kosciusko", "year": 2008},
    {"name": "North Little Lake", "county": "Kosciusko", "year": 2012},
    {"name": "Banning Lake", "county": "Kosciusko", "year": 2013},
    {"name": "Beaver Dam Lake", "county": "Kosciusko", "year": 2014},
    {"name": "Center Lake", "county": "Kosciusko", "year": 2014},
    {"name": "Kuhn Lake", "county": "Kosciusko", "year": 2013},
    {"name": "McClures Lake", "county": "Kosciusko", "year": 2014},
    {"name": "Silver Lake", "county": "Kosciusko", "year": 2013},
    {"name": "Waubee Lake", "county": "Kosciusko", "year": 2014},
    {"name": "Sechrist Lake", "county": "Kosciusko", "year": 2015},
    {"name": "Sellers Lake", "county": "Kosciusko", "year": 2015},
    {"name": "Webster Lake", "county": "Kosciusko", "year": 2017},
    {"name": "Winona Lake", "county": "Kosciusko", "year": 2017},
    {"name": "Fish Lake", "county": "Elkhart", "year": 2023},
    {"name": "Heaton Lake", "county": "Elkhart", "year": 2010},
    {"name": "Simonton Lake", "county": "Elkhart", "year": 2009},
    {"name": "Fidler's Pond", "county": "Elkhart", "year": 2014},
    {"name": "Indiana Lake", "county": "Elkhart", "year": 2014},
    {"name": "Indian Lake", "county": "DeKalb", "year": 2014},
    {"name": "Little Cedar Lake", "county": "Whitley", "year": 2012},
    {"name": "Old Lake", "county": "Whitley", "year": 2015},
    {"name": "Crooked Lake", "county": "Whitley", "year": 2017},
    {"name": "Lake Everett", "county": "Allen", "year": 2012},
    {"name": "Hurshtown Lake", "county": "Allen", "year": 2015},
]
PDF_INDEX = "https://www.in.gov/dnr/fish-and-wildlife/fishing/lake-depth-maps"


def norm(n: str) -> str:
    return (
        n.lower()
        .replace(" lake", "")
        .replace(" reservoir", "")
        .replace(" pond", "")
        .strip()
    )


def process(raw: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    with open(DATA / "contours_raw.geojson", "w") as f:
        json.dump(raw, f)

    lakes = defaultdict(
        lambda: {
            "features": [],
            "contours": set(),
            "county": None,
            "county2": None,
            "acres": None,
            "max_depth": None,
            "survey_date": None,
            "bbox": [180, 90, -180, -90],
            "coords_sample": [],
            "raw_name": None,
        }
    )
    contour_out = []

    for feat in raw["features"]:
        p = feat["properties"]
        raw_name = p.get("lake_name") or "Unknown"
        name = fix_name(raw_name)
        L = lakes[name]
        L["raw_name"] = raw_name
        L["features"].append(feat)
        if p.get("contour") is not None:
            L["contours"].add(float(p["contour"]))
        if p.get("county1_name"):
            L["county"] = fix_county(p["county1_name"])
        if p.get("county2_name"):
            L["county2"] = fix_county(p["county2_name"])
        if p.get("lake_acres") is not None:
            L["acres"] = p["lake_acres"]
        if p.get("lake_max_depth") is not None:
            L["max_depth"] = p["lake_max_depth"]
        if p.get("survey_date") and not L["survey_date"]:
            try:
                L["survey_date"] = datetime.fromtimestamp(
                    p["survey_date"] / 1000, tz=timezone.utc
                ).strftime("%Y-%m-%d")
            except Exception:
                pass

        geom = shape(feat["geometry"])
        try:
            simp = geom.simplify(0.000012, preserve_topology=True)
            if simp.is_empty:
                simp = geom
        except Exception:
            simp = geom
        g = mapping(simp)
        g["coordinates"] = round_coords(g["coordinates"])
        contour_out.append(
            {
                "type": "Feature",
                "geometry": g,
                "properties": {
                    "lake": name,
                    "depth_ft": p.get("contour"),
                    "line_type": p.get("line_type"),
                },
            }
        )

        def walk(c):
            if not c:
                return
            if isinstance(c[0], (int, float)):
                lon, lat = c[0], c[1]
                L["bbox"][0] = min(L["bbox"][0], lon)
                L["bbox"][1] = min(L["bbox"][1], lat)
                L["bbox"][2] = max(L["bbox"][2], lon)
                L["bbox"][3] = max(L["bbox"][3], lat)
                if len(L["coords_sample"]) < 800:
                    L["coords_sample"].append((lon, lat))
            else:
                for x in c:
                    walk(x)

        walk(feat["geometry"].get("coordinates"))

    lake_list = []
    for name, L in sorted(lakes.items()):
        cont = sorted(L["contours"])
        steps = [
            round(cont[i + 1] - cont[i], 2)
            for i in range(len(cont) - 1)
            if cont[i + 1] - cont[i] > 0
        ]
        interval = Counter(steps).most_common(1)[0][0] if steps else None
        lon = sum(c[0] for c in L["coords_sample"]) / len(L["coords_sample"])
        lat = sum(c[1] for c in L["coords_sample"]) / len(L["coords_sample"])
        lake_list.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon, 6), round(lat, 6)],
                },
                "properties": {
                    "id": name.lower().replace(" ", "-").replace("/", "-"),
                    "name": name,
                    "source_lake_name": L["raw_name"],
                    "county": L["county"],
                    "county2": L["county2"],
                    "acres": L["acres"],
                    "max_depth_ft": L["max_depth"],
                    "survey_date": L["survey_date"],
                    "contour_interval_ft": interval,
                    "min_contour_ft": cont[0] if cont else None,
                    "max_contour_ft": cont[-1] if cont else None,
                    "has_contours": True,
                    "pdf_url": None,
                    "bbox": [round(x, 6) for x in L["bbox"]],
                    "source": "Indiana DNR Division of Fish & Wildlife – Lake Bathymetry (IndianaMap)",
                    "source_url": CONTOURS_URL.rsplit("/query", 1)[0],
                    "precision_note": (
                        f"Surveyed bathymetric contours; typical interval {interval} ft. "
                        "Contours are feet below surface. Not a real-time sonar product."
                    ),
                },
            }
        )

    for p in PDF_ONLY:
        if any(
            norm(f["properties"]["name"]) == norm(p["name"])
            and f["properties"]["county"] == p["county"]
            for f in lake_list
        ):
            continue
        lake_list.append(
            {
                "type": "Feature",
                "geometry": None,
                "properties": {
                    "id": (
                        p["name"] + "-" + p["county"]
                    )
                    .lower()
                    .replace(" ", "-")
                    .replace("/", "-")
                    .replace("(", "")
                    .replace(")", ""),
                    "name": p["name"],
                    "county": p["county"],
                    "county2": None,
                    "acres": None,
                    "max_depth_ft": None,
                    "survey_date": str(p["year"]),
                    "contour_interval_ft": None,
                    "has_contours": False,
                    "pdf_url": PDF_INDEX,
                    "bbox": None,
                    "source": "Indiana DNR Fish & Wildlife Lake Depth Maps (PDF only)",
                    "source_url": PDF_INDEX,
                    "precision_note": "PDF/scanned bathymetry map only; no vector contours in FeatureServer.",
                },
            }
        )

    with open(DATA / "contours.geojson", "w") as f:
        json.dump(
            {"type": "FeatureCollection", "features": contour_out},
            f,
            separators=(",", ":"),
        )
    with open(DATA / "lakes.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": lake_list}, f, indent=2)

    meta = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "region": "Northeast Indiana",
        "counties": [
            "Steuben",
            "LaGrange",
            "Noble",
            "DeKalb",
            "Kosciusko",
            "Elkhart",
            "Whitley",
            "Allen",
        ],
        "lakes_with_contours": sum(
            1 for f in lake_list if f["properties"]["has_contours"]
        ),
        "lakes_pdf_only": sum(
            1 for f in lake_list if not f["properties"]["has_contours"]
        ),
        "contour_features": len(contour_out),
        "sources": [
            {
                "name": "IndianaMap / Indiana DNR Lake Bathymetry Contours",
                "url": "https://gisdata.in.gov/server/rest/services/Hosted/Lake_Bathymetry_RO/FeatureServer/0",
                "attribution": "Indiana Department of Natural Resources, Division of Fish and Wildlife",
                "notes": (
                    "Polyline bathymetric contours; shoreline = 0; values are feet below surface. "
                    "Surveyed with Biosonics DTX echosounder. Intervals commonly 5 or 10 ft. "
                    "FeatureServer last noted update ~2019; newer PDF surveys may not be in vector layer yet."
                ),
            },
            {
                "name": "Indiana DNR Lake Depth Maps (PDF)",
                "url": PDF_INDEX,
                "attribution": "Indiana Department of Natural Resources",
            },
        ],
    }
    with open(DATA / "sources.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(
        f"Done: {meta['lakes_with_contours']} contour lakes, "
        f"{meta['lakes_pdf_only']} PDF-only, "
        f"{meta['contour_features']} contour features, "
        f"contours.geojson={os.path.getsize(DATA/'contours.geojson')/1024:.0f}KB"
    )


def main():
    raw = download_contours()
    process(raw)


if __name__ == "__main__":
    main()
