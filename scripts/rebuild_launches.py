#!/usr/bin/env python3
"""Rebuild boat launch / ramp GeoJSON for Mike's Fishing App (statewide Indiana).

Sources (public, no invented points):
  1. Indiana DNR Fish & Wildlife Fishing Access Sites (Fish_Access_RO)
     https://gisdata.in.gov/server/rest/services/Hosted/Fish_Access_RO/FeatureServer/0
  2. IndianaMap Recreational Facility Locations (Private/Commercial with rampnu > 0)
     https://gisdata.in.gov/server/rest/services/Hosted/Recreational_Facility_Locations/FeatureServer/0
  3. OpenStreetMap leisure=slipway (+ marina / boat_rental with access tags)
     via Overpass API
  County attribution: Indiana County Boundaries 2022 polygons (all 92 counties).

Usage:
  .venv/bin/python scripts/rebuild_launches.py
  # or: python3 scripts/rebuild_launches.py  (needs shapely)
"""
from __future__ import annotations

import json
import math
import ssl
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PUBLIC_DATA = ROOT / "public" / "data"

# Special-case county display names (ArcGIS often returns ALL CAPS / variants)
COUNTY_DISPLAY = {
    "DEKALB": "DeKalb",
    "LAGRANGE": "LaGrange",
    "STJOSEPH": "St. Joseph",
    "SAINTJOSEPH": "St. Joseph",
    "STJOE": "St. Joseph",
    "LAPORTE": "LaPorte",
    "LA PORTE": "LaPorte",
    "VANDERBURGH": "Vanderburgh",
}

DNR_URL = (
    "https://gisdata.in.gov/server/rest/services/Hosted/"
    "Fish_Access_RO/FeatureServer/0/query"
)
REC_URL = (
    "https://gisdata.in.gov/server/rest/services/Hosted/"
    "Recreational_Facility_Locations/FeatureServer/0/query"
)
COUNTY_URL = (
    "https://gisdata.in.gov/server/rest/services/Hosted/"
    "County_Boundaries_of_Indiana_2022/FeatureServer/0/query"
)
OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

# Full Indiana envelope (S, W, N, E) for OSM / rec spatial queries
BBOX = (37.75, -88.12, 41.78, -84.75)
DEDUP_M = 120.0
PAGE_SIZE = 200

try:
    from shapely.geometry import Point, shape
except ImportError:
    import sys
    print("Install shapely: .venv/bin/pip install shapely", file=sys.stderr)
    raise SystemExit(1)

# Allow Indiana GIS TLS quirks if any
CTX = ssl.create_default_context()


def http_get_json(url: str, params: dict | None = None, timeout: int = 180, retries: int = 4) -> dict:
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mikes-fishing-app/1.0"})
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = 2 ** attempt
            print(f"  HTTP retry {attempt+1}/{retries} after {exc} (sleep {wait}s)")
            import time
            time.sleep(wait)
    raise last


def http_post_bytes(url: str, body: bytes, timeout: int = 180, retries: int = 4) -> dict:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "User-Agent": "mikes-fishing-app/1.0",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = 2 ** attempt
            print(f"  HTTP POST retry {attempt+1}/{retries} after {exc} (sleep {wait}s)")
            import time
            time.sleep(wait)
    raise last


def fix_county(c: str | None) -> str | None:
    if not c:
        return None
    key = c.upper().replace(".", "").replace(" ", "").replace("-", "")
    if key in COUNTY_DISPLAY:
        return COUNTY_DISPLAY[key]
    # Title-case remaining ALL CAPS names from ArcGIS
    return c.strip().title() if c else None


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def near_existing(lat, lng, existing, meters=DEDUP_M) -> bool:
    for e in existing:
        if haversine_m(lat, lng, e["lat"], e["lng"]) <= meters:
            return True
    return False


def arcgis_geojson_all(url: str, base_params: dict, page_size: int | None = None) -> list:
    """Paginate an ArcGIS FeatureServer GeoJSON query."""
    page = page_size or PAGE_SIZE
    features = []
    offset = 0
    params0 = dict(base_params)
    # Stable pagination when supported
    if "orderByFields" not in params0:
        params0["orderByFields"] = "objectid"
    while True:
        params = dict(params0)
        params["resultOffset"] = offset
        params["resultRecordCount"] = page
        try:
            g = http_get_json(url, params)
        except Exception as exc:  # noqa: BLE001
            # Some layers reject orderByFields — retry without
            if "orderByFields" in params:
                print(f"  orderByFields failed ({exc}); retrying without")
                params0.pop("orderByFields", None)
                params = dict(params0)
                params["resultOffset"] = offset
                params["resultRecordCount"] = page
                g = http_get_json(url, params)
            else:
                raise
        batch = g.get("features") or []
        features.extend(batch)
        print(f"  … offset {offset}: +{len(batch)} (total {len(features)})")
        if len(batch) < page:
            break
        offset += page
        if offset > 20000:
            print("  warning: pagination safety stop")
            break
    return features


def load_counties():
    features = arcgis_geojson_all(
        COUNTY_URL,
        {
            "where": "1=1",
            "outFields": "name",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        },
    )
    polys = []
    for f in features:
        name = fix_county(f["properties"]["name"])
        polys.append((name, shape(f["geometry"])))
    print(f"Loaded {len(polys)} county polygons (statewide)")
    return polys


def county_of(lat, lng, polys) -> str | None:
    pt = Point(lng, lat)
    for name, poly in polys:
        if poly.contains(pt) or poly.touches(pt):
            return name
    return None


def feature(name, access, lake, county, lat, lng, source, source_url, notes, extra=None):
    props = {
        "name": name,
        "access": access,  # public | private | unknown
        "lake": lake,
        "county": county,
        "lat": round(lat, 6),
        "lng": round(lng, 6),
        "source": source,
        "source_url": source_url,
        "notes": notes or "",
    }
    if extra:
        props.update(extra)
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]},
        "properties": props,
    }


def fetch_dnr(polys):
    print("Fetching DNR Fish Access (statewide)…")
    dnr_fields = (
        "site_name,waterbody,county,boat_ramp,type_of_la,type_of_ra,"
        "fee,fees,parking_info,motor_rest,ada_access,comments,land_type,accessid,objectid"
    )
    features = arcgis_geojson_all(
        DNR_URL,
        {
            "where": "1=1",
            "outFields": dnr_fields,
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        },
        page_size=200,
    )
    out = []
    for f in features:
        p = f["properties"]
        br = str(p.get("boat_ramp") or "").lower()
        launch = p.get("type_of_la") or ""
        if br != "yes" and launch not in ("Boat Ramp", "Carry Down", "Canoe Ramp"):
            continue
        geom = f.get("geometry")
        if not geom or "coordinates" not in geom:
            continue
        coords = geom["coordinates"]
        lng, lat = float(coords[0]), float(coords[1])
        county = fix_county(p.get("county")) or county_of(lat, lng, polys)
        if not county:
            # Outside Indiana polygons — skip
            continue
        name = (p.get("site_name") or "Public access").strip()
        lake = (p.get("waterbody") or "").strip() or None
        notes_parts = []
        if launch:
            notes_parts.append(f"Launch: {launch}")
        if p.get("type_of_ra"):
            notes_parts.append(f"Ramp: {p['type_of_ra']}")
        fee = p.get("fee") or p.get("fees")
        if fee:
            notes_parts.append(f"Fee: {fee}")
        if p.get("parking_info"):
            notes_parts.append(f"Parking: {p['parking_info']}")
        if p.get("motor_rest"):
            notes_parts.append(f"Motor: {p['motor_rest']}")
        if p.get("ada_access"):
            notes_parts.append(f"ADA: {p['ada_access']}")
        if p.get("comments"):
            notes_parts.append(str(p["comments"])[:200])
        out.append(
            feature(
                name=name,
                access="public",
                lake=lake,
                county=county,
                lat=lat,
                lng=lng,
                source="Indiana DNR Fish & Wildlife — Fishing Access Sites",
                source_url=DNR_URL.rsplit("/query", 1)[0],
                notes="; ".join(notes_parts),
                extra={
                    "launch_type": launch or None,
                    "land_type": p.get("land_type"),
                    "dnr_accessid": p.get("accessid"),
                },
            )
        )
    print(f"DNR launches: {len(out)}")
    return out


def fetch_rec_private(polys, existing):
    """Private/Commercial sites with boat ramps from Indiana recreational facilities inventory."""
    print("Fetching Rec Facility private/commercial ramps (statewide)…")
    s, w, n, e = BBOX
    features = arcgis_geojson_all(
        REC_URL,
        {
            "where": "rampnu > 0 AND areatype IN ('Private','Commercial')",
            "geometry": f"{w},{s},{e},{n}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "site,lkaccname,rampnu,areatype,owner,fees,openpublic,address,city,boatfac,handcarry,slips,boatrental",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        },
    )
    out = []
    for f in features:
        p = f["properties"]
        geom = f.get("geometry")
        if not geom or "coordinates" not in geom:
            continue
        coords = geom["coordinates"]
        lng, lat = float(coords[0]), float(coords[1])
        county = county_of(lat, lng, polys)
        if not county:
            continue
        if near_existing(lat, lng, existing, meters=150):
            continue
        name = (p.get("site") or "Private boat ramp").strip()
        lake = (p.get("lkaccname") or "").strip() or None
        if lake in ("Not listed", "None"):
            lake = None
        notes_parts = [f"Type: {p.get('areatype')}"]
        if p.get("rampnu"):
            notes_parts.append(f"Ramps: {p['rampnu']}")
        if p.get("owner"):
            notes_parts.append(f"Owner: {p['owner']}")
        if p.get("fees") not in (None, 0):
            notes_parts.append("Fees may apply (see source)")
        if p.get("address") or p.get("city"):
            notes_parts.append(
                ", ".join(x for x in [p.get("address"), p.get("city")] if x)
            )
        notes_parts.append(
            "Private/commercial facility listed in state inventory — confirm access before visiting"
        )
        feat = feature(
            name=name,
            access="private",
            lake=lake,
            county=county,
            lat=lat,
            lng=lng,
            source="IndianaMap Recreational Facility Locations",
            source_url=REC_URL.rsplit("/query", 1)[0],
            notes="; ".join(notes_parts),
            extra={"areatype": p.get("areatype"), "rampnu": p.get("rampnu")},
        )
        out.append(feat)
        existing.append({"lat": lat, "lng": lng})
    print(f"Rec private/commercial launches (in-county, deduped): {len(out)}")
    return out


def fetch_osm(polys, existing):
    print("Fetching OSM slipways/marinas (Indiana bbox)…")
    s, w, n, e = BBOX
    query = f"""[out:json][timeout:180];
(
  node["leisure"="slipway"]({s},{w},{n},{e});
  way["leisure"="slipway"]({s},{w},{n},{e});
  node["leisure"="marina"]({s},{w},{n},{e});
  way["leisure"="marina"]({s},{w},{n},{e});
  node["amenity"="boat_rental"]({s},{w},{n},{e});
  way["amenity"="boat_rental"]({s},{w},{n},{e});
);
out center tags;
"""
    body = urllib.parse.urlencode({"data": query}).encode()
    data = None
    last_err = None
    for url in OVERPASS_URLS:
        try:
            data = http_post_bytes(url, body, timeout=200)
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            print(f"Overpass failed {url}: {exc}")
    if data is None:
        print(f"OSM skipped: {last_err}")
        return []

    out = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        kind = tags.get("leisure") or tags.get("amenity")
        # Prefer slipways; marinas/rentals only if access explicitly private/customers/members
        # or named as launch/ramp
        acc_raw = (tags.get("access") or "").lower()
        name = (tags.get("name") or "").strip()

        if kind == "slipway":
            pass  # always consider
        elif kind in ("marina", "boat_rental"):
            if acc_raw not in ("private", "customers", "members", "yes", "public"):
                # skip untagged marinas (often not a launch point)
                if "launch" not in name.lower() and "ramp" not in name.lower():
                    continue
        else:
            continue

        if "lat" in el:
            lat, lng = float(el["lat"]), float(el["lon"])
        else:
            c = el.get("center") or {}
            if "lat" not in c:
                continue
            lat, lng = float(c["lat"]), float(c["lon"])

        county = county_of(lat, lng, polys)
        if not county:
            continue
        if near_existing(lat, lng, existing, meters=DEDUP_M):
            continue

        if acc_raw in ("private", "customers", "members"):
            access = "private"
        elif acc_raw in ("yes", "public", "permissive"):
            access = "public"
        else:
            access = "unknown"

        if not name:
            if kind == "slipway":
                name = "Boat slipway (OSM)"
            elif kind == "marina":
                name = "Marina (OSM)"
            else:
                name = "Boat rental (OSM)"

        lake = tags.get("water") or tags.get("lake") or None
        notes_parts = [f"OSM: {kind}"]
        if acc_raw:
            notes_parts.append(f"access={acc_raw}")
        if tags.get("fee"):
            notes_parts.append(f"fee={tags['fee']}")
        if tags.get("surface"):
            notes_parts.append(f"surface={tags['surface']}")
        if tags.get("description"):
            notes_parts.append(tags["description"][:160])
        osm_type = el.get("type", "node")
        osm_id = el.get("id")
        source_url = f"https://www.openstreetmap.org/{osm_type}/{osm_id}"

        feat = feature(
            name=name,
            access=access,
            lake=lake,
            county=county,
            lat=lat,
            lng=lng,
            source="OpenStreetMap",
            source_url=source_url,
            notes="; ".join(notes_parts),
            extra={"osm_kind": kind, "osm_id": f"{osm_type}/{osm_id}"},
        )
        out.append(feat)
        existing.append({"lat": lat, "lng": lng})

    print(f"OSM launches (in-county, deduped): {len(out)}")
    print("  OSM access:", Counter(f["properties"]["access"] for f in out))
    return out


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    polys = load_counties()

    features = []
    existing = []

    dnr = fetch_dnr(polys)
    features.extend(dnr)
    for f in dnr:
        existing.append(
            {"lat": f["properties"]["lat"], "lng": f["properties"]["lng"]}
        )

    rec = fetch_rec_private(polys, existing)
    features.extend(rec)

    osm = fetch_osm(polys, existing)
    features.extend(osm)

    # Stable id
    for i, f in enumerate(features, 1):
        f["properties"]["id"] = f"launch-{i:04d}"

    counts = Counter(f["properties"]["access"] for f in features)
    by_county = Counter(f["properties"]["county"] for f in features)
    by_source = Counter(
        f["properties"]["source"].split(" —")[0].split(" Locations")[0][:40]
        for f in features
    )
    county_list = sorted(by_county.keys())

    meta = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "region": "Indiana (statewide)",
        "counties": county_list,
        "county_count": len(county_list),
        "counts": {
            "total": len(features),
            "public": counts.get("public", 0),
            "private": counts.get("private", 0),
            "unknown": counts.get("unknown", 0),
        },
        "by_county": dict(sorted(by_county.items())),
        "sources": [
            {
                "name": "Indiana DNR Fish & Wildlife — Fishing Access Sites",
                "url": DNR_URL.rsplit("/query", 1)[0],
                "access": "public",
                "notes": "Official public access sites; boat_ramp=Yes / Boat Ramp / Carry Down / Canoe Ramp.",
            },
            {
                "name": "IndianaMap Recreational Facility Locations",
                "url": REC_URL.rsplit("/query", 1)[0],
                "access": "private (areatype Private or Commercial with rampnu>0)",
                "notes": "State inventory of private/commercial facilities that report boat ramps. Not a guarantee of public entry.",
            },
            {
                "name": "OpenStreetMap (leisure=slipway, marina, amenity=boat_rental)",
                "url": "https://www.openstreetmap.org/",
                "access": "from OSM access=* tag (private/customers/members → private; yes/public → public; else unknown)",
                "notes": "Deduped against DNR/rec within ~120 m. Untagged slipways labeled unknown. Private club launches not in OSM/state inventories are intentionally omitted.",
            },
        ],
        "caveats": [
            "Private launch coverage is limited to sites published in the state recreational facilities inventory or OSM with access=private/customers/members.",
            "Do not treat private/commercial markers as guaranteed guest access — confirm with the operator.",
            "No gated club directories were scraped; absence of a private ramp does not mean none exist.",
        ],
        "rebuild": "python3 scripts/rebuild_launches.py  # requires shapely; copies to public/data/",
    }

    gj = {
        "type": "FeatureCollection",
        "features": features,
        "properties": meta,
    }

    out_path = DATA / "launches.geojson"
    pub_path = PUBLIC_DATA / "launches.geojson"
    text = json.dumps(gj, separators=(",", ":"))
    out_path.write_text(text)
    # Real file copy (no symlink) for gh-pages
    pub_path.write_text(text)

    # Merge launch source into sources.json if present
    sources_path = DATA / "sources.json"
    if sources_path.exists():
        src = json.loads(sources_path.read_text())
        # Keep depth region as NE Indiana; launches are statewide
        src["launches"] = meta
        sources_path.write_text(json.dumps(src, indent=2) + "\n")
        (PUBLIC_DATA / "sources.json").write_text(json.dumps(src, indent=2) + "\n")

    print("Wrote", out_path, "and", pub_path)
    print("Counts:", dict(counts))
    print("County count:", len(county_list))
    print("By county (sample):", dict(list(sorted(by_county.items()))[:15]), "…")
    print("By source prefix:", dict(by_source))
    for probe in ("Marion", "Monroe", "Lake", "Vanderburgh"):
        print(f"  {probe}: {by_county.get(probe, 0)}")


if __name__ == "__main__":
    main()
