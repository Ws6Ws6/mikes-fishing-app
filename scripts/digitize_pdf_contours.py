#!/usr/bin/env python3
"""Digitize Indiana DNR bathymetry PDF maps into GeoJSON contours.

Styles supported:
  - biobase_yellow: yellow contour lines over cyan/blue water (2015+ BioBase)
  - cbiobase_ramp: color-ramp bathymetry with dark contour strokes (cBioBase ~2012-2014)
  - lare_yellow: yellow contours on aerial orthophoto (LARE ~2008-2011)

Never invents depths: only uses labeled intervals supplied by caller / OCR.
QA: shoreline IoU vs OSM; flags needs_review when below thresholds.
"""
from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image
from pyproj import Transformer
from shapely.geometry import (
    LineString, MultiLineString, Polygon, MultiPolygon, mapping, shape, Point, box
)
from shapely.ops import transform as shp_transform, unary_union, linemerge
from shapely.validation import make_valid
from skimage.morphology import skeletonize
from skimage.measure import label as sk_label, regionprops

USER_AGENT = "MikesFishingApp/1.0 (contour-digitize; educational)"
WGS84_TO_MERC = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
MERC_TO_WGS84 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def to_merc(geom):
    return shp_transform(lambda x, y: WGS84_TO_MERC.transform(x, y), geom)


def to_wgs(geom):
    return shp_transform(lambda x, y: MERC_TO_WGS84.transform(x, y), geom)


def acres_of(geom_wgs) -> float:
    g = to_merc(geom_wgs)
    return abs(g.area) / 4046.8564224


def fetch_nominatim(query: str, lat: float | None = None, lon: float | None = None) -> dict | None:
    params = {"format": "json", "polygon_geojson": "1", "limit": "5", "q": query}
    if lat is not None and lon is not None:
        params = {
            "format": "json",
            "polygon_geojson": "1",
            "limit": "5",
            "q": query,
            "viewbox": f"{lon-0.05},{lat+0.05},{lon+0.05},{lat-0.05}",
            "bounded": "0",
        }
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        hits = json.load(r)
    if not hits:
        return None
    # Prefer natural water / reservoir with polygon
    def score(h):
        s = 0
        if h.get("geojson") and h["geojson"].get("type") in ("Polygon", "MultiPolygon"):
            s += 10
        if h.get("class") == "natural" and h.get("type") == "water":
            s += 5
        if h.get("type") in ("reservoir", "lake", "pond", "basin"):
            s += 3
        if lat is not None and lon is not None:
            try:
                dlat = float(h["lat"]) - lat
                dlon = float(h["lon"]) - lon
                dist = (dlat * dlat + dlon * dlon) ** 0.5
                s += max(0, 5 - dist * 200)
            except Exception:
                pass
        return s

    hits.sort(key=score, reverse=True)
    return hits[0] if score(hits[0]) >= 10 else hits[0]


def parse_meta_from_text(text: str) -> dict:
    meta = {}
    m = re.search(r"(\d{1,2}/\d{1,2}/\d{4})", text)
    if m:
        meta["survey_date_raw"] = m.group(1)
        p = m.group(1).split("/")
        meta["survey_date"] = f"{p[2]}-{int(p[0]):02d}-{int(p[1]):02d}"
    m = re.search(r"(\d+(?:\.\d+)?)\s*acres", text, re.I)
    if m:
        meta["acres"] = float(m.group(1))
    m = re.search(r"(\d+)\s*ft\s*contours?", text, re.I)
    if m:
        meta["contour_interval_ft"] = int(m.group(1))
    m = re.search(r"Max(?:imum)?\s*(?:Depth)?\s*[:=]?\s*(\d+)\s*['′]?", text, re.I)
    if m:
        meta["max_depth_ft"] = int(m.group(1))
    m = re.search(r"Latitude[:\s]+([0-9.+-]+)", text, re.I)
    if m:
        meta["lat"] = float(m.group(1))
    m = re.search(r"Longitude[:\s]+([0-9.+-]+)", text, re.I)
    if m:
        meta["lon"] = float(m.group(1))
    return meta


@dataclass
class DigitizeResult:
    lake: str
    county: str
    lake_id: str
    features: list
    meta: dict
    qa: dict
    needs_review: bool
    review_notes: list = field(default_factory=list)


def extract_water_mask_biobase(rgb: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    # cyan through deep blue overlay
    water = (
        (hsv[:, :, 0] >= 85)
        & (hsv[:, :, 0] <= 130)
        & (hsv[:, :, 1] >= 40)
        & (hsv[:, :, 2] >= 40)
    )
    mask = (water.astype(np.uint8) * 255)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k, iterations=1)
    # keep largest components that are substantial
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n <= 1:
        return mask
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.zeros_like(mask)
    # keep components >= 15% of largest
    thr = max(areas.max() * 0.15, 2000)
    for i, a in enumerate(areas, start=1):
        if a >= thr:
            keep[labels == i] = 255
    return keep


def extract_yellow_contours(rgb: np.ndarray, water: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    y = (
        (hsv[:, :, 0] >= 18)
        & (hsv[:, :, 0] <= 40)
        & (hsv[:, :, 1] >= 100)
        & (hsv[:, :, 2] >= 120)
    )
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    water_d = cv2.dilate(water, k, iterations=3)
    yin = (y & (water_d > 0)).astype(np.uint8) * 255
    # remove thick label blobs — keep thin lines via opening with small kernel then restore
    yin = cv2.morphologyEx(yin, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return yin


def extract_dark_contours_cbiobase(rgb: np.ndarray, water: np.ndarray) -> np.ndarray:
    """cBioBase maps: dark stroke contours over color ramp."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    # water approx: cooler hues OR saturated blues/cyans/purples in lake area
    cool = (
        ((hsv[:, :, 0] >= 85) & (hsv[:, :, 0] <= 170) & (hsv[:, :, 1] >= 30))
        | ((hsv[:, :, 0] >= 100) & (hsv[:, :, 0] <= 175) & (hsv[:, :, 2] <= 180) & (hsv[:, :, 1] >= 20))
    )
    mask = (cool.astype(np.uint8) * 255)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n > 1:
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        mask = ((labels == largest) | (stats[labels, cv2.CC_STAT_AREA] >= stats[largest, cv2.CC_STAT_AREA] * 0.1)).astype(np.uint8)
        # rebuild: keep large enough
        keep = np.zeros_like(mask)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= stats[largest, cv2.CC_STAT_AREA] * 0.08:
                keep[labels == i] = 255
        mask = keep
    # dark lines inside water
    dark = (gray < 70).astype(np.uint8) * 255
    water_d = cv2.dilate(mask, k, iterations=2)
    lines = cv2.bitwise_and(dark, water_d)
    lines = cv2.morphologyEx(lines, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return mask, lines


def mask_to_polygon_px(mask: np.ndarray) -> Optional[Polygon]:
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)
    polys = []
    min_area = mask.shape[0] * mask.shape[1] * 0.001
    for c in cnts[:8]:
        if cv2.contourArea(c) < min_area:
            continue
        pts = c.reshape(-1, 2)
        if len(pts) < 3:
            continue
        p = Polygon(pts)
        if not p.is_valid:
            p = make_valid(p)
        if p.geom_type == "Polygon" and p.area > 0:
            polys.append(p)
        elif p.geom_type == "MultiPolygon":
            polys.extend([g for g in p.geoms if g.area > 0])
    if not polys:
        return None
    u = unary_union(polys)
    if u.geom_type == "MultiPolygon":
        # take largest
        u = max(u.geoms, key=lambda g: g.area)
    return u


def osm_to_pixel_polygon(osm_geom, img_w, img_h, A_merc_affine):
    """Unused placeholder."""
    pass


def fit_similarity_px_to_merc(src_poly_px: Polygon, dst_poly_merc: Polygon):
    """Fit similarity transform mapping pixel coords -> mercator meters.

    Uses second-order moments (centroid + scale + orientation via PCA of boundary).
    """
    def pca_frame(poly: Polygon):
        # sample boundary
        b = poly.exterior
        # densify
        t = np.linspace(0, 1, 400, endpoint=False)
        # shapely 2: interpolate by distance
        length = b.length
        pts = np.array([list(b.interpolate(float(f) * length).coords[0]) for f in t])
        c = pts.mean(axis=0)
        X = pts - c
        # PCA
        cov = X.T @ X / len(pts)
        eigval, eigvec = np.linalg.eigh(cov)
        # largest eigenvalue axis
        order = np.argsort(eigval)[::-1]
        eigvec = eigvec[:, order]
        eigval = eigval[order]
        # orientation angle of major axis
        ang = math.atan2(eigvec[1, 0], eigvec[0, 0])
        # characteristic radius
        rad = math.sqrt(eigval[0])
        return c, ang, rad, pts

    c0, a0, r0, _ = pca_frame(src_poly_px)
    c1, a1, r1, _ = pca_frame(dst_poly_merc)
    if r0 < 1e-6:
        raise ValueError("degenerate source poly")
    scale = r1 / r0
    # try both angle alignments (a1-a0 and a1-a0+pi) — pick better IoU later
    candidates = []
    for flip in (0.0, math.pi):
        ang = (a1 - a0) + flip
        ca, sa = math.cos(ang), math.sin(ang)
        # x' = scale * R * (x - c0) + c1
        A = np.array(
            [
                [scale * ca, -scale * sa, c1[0] - scale * (ca * c0[0] - sa * c0[1])],
                [scale * sa, scale * ca, c1[1] - scale * (sa * c0[0] + ca * c0[1])],
            ],
            dtype=float,
        )
        candidates.append(A)
    return candidates


def apply_A(A: np.ndarray, x: float, y: float):
    return float(A[0, 0] * x + A[0, 1] * y + A[0, 2]), float(A[1, 0] * x + A[1, 1] * y + A[1, 2])


def warp_poly_px(poly: Polygon, A: np.ndarray) -> Polygon:
    def _map(x, y, z=None):
        return apply_A(A, x, y)
    return shp_transform(_map, poly)


def iou(a: Polygon, b: Polygon) -> float:
    if a.is_empty or b.is_empty:
        return 0.0
    inter = a.intersection(b).area
    union = a.union(b).area
    return float(inter / union) if union > 0 else 0.0


def refine_A_translation(A, src_poly, dst_poly, steps=9, span_frac=0.08):
    """Small translational search to improve IoU."""
    best_A = A
    best = iou(warp_poly_px(src_poly, A), dst_poly)
    # estimate scale from A
    scale = math.hypot(A[0, 0], A[1, 0])
    span = span_frac * math.sqrt(dst_poly.area)
    for dx in np.linspace(-span, span, steps):
        for dy in np.linspace(-span, span, steps):
            A2 = A.copy()
            A2[0, 2] += dx
            A2[1, 2] += dy
            sc = iou(warp_poly_px(src_poly, A2), dst_poly)
            if sc > best:
                best, best_A = sc, A2
    return best_A, best


def skeleton_to_lines(skel_bool: np.ndarray, min_pts=8):
    """Extract polylines from skeleton via contour tracing of single-pixel lines."""
    sk = skel_bool.astype(np.uint8) * 255
    # find contours on slightly dilated skeleton then simplify — better: connected components of endpoints
    # Use cv2.findContours on skel
    cnts, _ = cv2.findContours(sk, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    lines = []
    for c in cnts:
        pts = c.reshape(-1, 2)
        if len(pts) < min_pts:
            continue
        # remove closed duplicate last=first
        if len(pts) > 1 and np.all(pts[0] == pts[-1]):
            pts = pts[:-1]
        if len(pts) < min_pts:
            continue
        # subsample
        step = max(1, len(pts) // 200)
        pts = pts[::step]
        if len(pts) < 2:
            continue
        lines.append(pts.astype(float))
    return lines


def assign_depths_by_distance(lines_merc, shore_poly_merc, intervals_ft, max_depth_ft):
    """Assign each line the interval whose fractional distance rank matches.

    Approach: for each line, compute median distance-to-shore of its vertices.
    Sort unique distance clusters into bands matching intervals (shallow→deep).
    """
    if not lines_merc or not intervals_ft:
        return []
    shore = shore_poly_merc.exterior if shore_poly_merc.geom_type == "Polygon" else shore_poly_merc
    # distance for each line
    dists = []
    for pts in lines_merc:
        ds = []
        for x, y in pts[:: max(1, len(pts) // 20)]:
            ds.append(Point(x, y).distance(shore))
        # also require point inside lake
        mid = pts[len(pts) // 2]
        inside = shore_poly_merc.contains(Point(mid[0], mid[1])) or shore_poly_merc.buffer(5).contains(Point(mid[0], mid[1]))
        dists.append((float(np.median(ds)) if ds else 0.0, inside, pts))

    # only inside
    dists = [d for d in dists if d[1] and d[0] > 1.0]
    if not dists:
        return []

    # Filter: very near shore might be 0-contour artifacts; skip tiny distances for non-zero
    dists.sort(key=lambda t: t[0])
    # Cluster into len(intervals) groups by distance quantiles
    intervals = sorted(intervals_ft)
    n = len(intervals)
    # Assign by ranking distance into n bins
    features = []
    for i, (dist, _, pts) in enumerate(dists):
        # rank percentile
        pct = i / max(len(dists) - 1, 1)
        idx = min(n - 1, int(round(pct * (n - 1))))
        # better: map distance linearly from min to max onto intervals
        dmin, dmax = dists[0][0], dists[-1][0]
        if dmax > dmin:
            t = (dist - dmin) / (dmax - dmin)
        else:
            t = 0.0
        idx = min(n - 1, max(0, int(round(t * (n - 1)))))
        depth = intervals[idx]
        if max_depth_ft and depth > max_depth_ft:
            continue
        # convert pts already merc -> will convert later
        features.append((depth, pts, dist))
    return features


def assign_depths_nested(lines_merc, shore_poly_merc, intervals_ft):
    """Prefer nested-ring logic: closed-ish lines ordered by mean distance from shore."""
    intervals = sorted(intervals_ft)
    scored = []
    for pts in lines_merc:
        if len(pts) < 4:
            continue
        mid_idx = len(pts) // 2
        p = Point(pts[mid_idx])
        if not (shore_poly_merc.buffer(20).contains(p)):
            continue
        # mean distance to exterior
        ds = [Point(x, y).distance(shore_poly_merc.exterior) for x, y in pts[:: max(1, len(pts) // 15)]]
        scored.append((float(np.mean(ds)), pts))
    scored.sort(key=lambda t: t[0])
    if not scored:
        return []
    # cluster by relative distance gaps into up to len(intervals) groups
    dists = np.array([s[0] for s in scored])
    # use quantile edges
    n = len(intervals)
    edges = np.quantile(dists, np.linspace(0, 1, n + 1))
    out = []
    for dist, pts in scored:
        # bin
        idx = int(np.searchsorted(edges[1:-1], dist, side="right"))
        idx = min(max(idx, 0), n - 1)
        out.append((intervals[idx], pts, dist))
    return out



def extract_water_and_yellow_lare(rgb: np.ndarray):
    """LARE-era maps: yellow contours on aerial orthophoto (no cyan bathymetry fill).

    Water proxy = heavily dilated+closed yellow contour strokes (concentric rings
    merge into a solid lake blob). Avoids fragile hole-fill inversion.
    """
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    yellow = (
        (hsv[:, :, 0] >= 18)
        & (hsv[:, :, 0] <= 42)
        & (hsv[:, :, 1] >= 100)
        & (hsv[:, :, 2] >= 120)
    )
    ymask = (yellow.astype(np.uint8) * 255)
    # Remove small label blobs (compact) — keep elongated strokes
    nlab, lab, stats, _ = cv2.connectedComponentsWithStats(ymask, 8)
    thin = np.zeros_like(ymask)
    for i in range(1, nlab):
        a = stats[i, cv2.CC_STAT_AREA]
        w = stats[i, cv2.CC_STAT_WIDTH]
        h = stats[i, cv2.CC_STAT_HEIGHT]
        # keep line-like or reasonably large pieces; drop tiny glyph dots
        if a < 12:
            continue
        if a < 80 and max(w, h) < 25:
            continue
        thin[lab == i] = 255
    ymask = thin
    # Dilate enough to bridge typical contour spacing, then close
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
    solid = cv2.dilate(ymask, k, iterations=3)
    solid = cv2.morphologyEx(solid, cv2.MORPH_CLOSE, k, iterations=3)
    k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    solid = cv2.morphologyEx(solid, cv2.MORPH_OPEN, k2, iterations=1)
    # Keep largest components only (main lake basin(s))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    keep = np.zeros_like(solid)
    if n > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        thr = max(int(areas.max() * 0.25), 5000)
        for i, a in enumerate(areas, start=1):
            if a >= thr:
                keep[labels == i] = 255
    else:
        keep = solid
    kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    water_d = cv2.dilate(keep, kd, iterations=3)
    lines = cv2.bitwise_and(ymask, water_d)
    lines = cv2.morphologyEx(lines, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return keep, lines



def digitize_lake(
    *,
    lake: str,
    county: str,
    lake_id: str,
    png_path: Path,
    style: str,
    intervals_ft: list[int],
    max_depth_ft: int | None,
    acres_pdf: float | None,
    survey_date: str | None,
    lat: float | None = None,
    lon: float | None = None,
    pdf_url: str = "",
    out_dir: Path,
) -> DigitizeResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    rgb = np.array(Image.open(png_path).convert("RGB"))
    H, W = rgb.shape[:2]
    notes = []
    qa = {"img_w": W, "img_h": H, "style": style}

    # OSM shoreline
    queries = [
        f"{lake}, {county} County, Indiana",
        f"{lake.replace(chr(39), '')}, {county} County, Indiana",
        f"{lake.replace(chr(39), '').replace('Pond', 'Pond')}, Indiana",
        f"{lake.replace('Lake ', '').replace(' Lake', '')} Lake, {county} County, Indiana",
    ]
    if "Fidler" in lake:
        queries.insert(0, f"Fidler Pond, Goshen, {county} County, Indiana")
        queries.insert(0, f"Fidler Pond, {county} County, Indiana")
    if "Hurshtown" in lake:
        queries.insert(0, f"Hurshtown Reservoir, {county} County, Indiana")
        queries.insert(0, f"Hurshtown Pond, {county} County, Indiana")
    hit = None
    for q in queries:
        hit = fetch_nominatim(q, lat, lon)
        if hit and hit.get("geojson"):
            break
    if not hit or not hit.get("geojson"):
        notes.append("OSM shoreline not found")
        return DigitizeResult(lake, county, lake_id, [], {"survey_date": survey_date, "acres": acres_pdf, "max_depth_ft": max_depth_ft, "contour_interval_ft": intervals_ft[0] if intervals_ft else None, "pdf_url": pdf_url, "lat": lat, "lon": lon}, qa, True, notes)

    osm = shape(hit["geojson"])
    if osm.geom_type == "MultiPolygon":
        osm = max(osm.geoms, key=lambda g: g.area)
    osm = make_valid(osm)
    osm_merc = to_merc(osm)
    qa["osm_acres"] = round(acres_of(osm), 1)
    qa["osm_display"] = hit.get("display_name", "")[:120]
    qa["osm_id"] = f"{hit.get('osm_type')}/{hit.get('osm_id')}"

    # Extract masks
    if style == "biobase_yellow":
        water = extract_water_mask_biobase(rgb)
        lines_mask = extract_yellow_contours(rgb, water)
    elif style == "cbiobase_ramp":
        water, lines_mask = extract_dark_contours_cbiobase(rgb, None)
    elif style == "lare_yellow":
        water, lines_mask = extract_water_and_yellow_lare(rgb)
    else:
        raise ValueError(style)

    Image.fromarray(water).save(out_dir / "qa_water.png")
    Image.fromarray(lines_mask).save(out_dir / "qa_lines.png")

    src_poly = mask_to_polygon_px(water)
    if src_poly is None:
        notes.append("Failed to extract water mask polygon from PDF render")
        return DigitizeResult(lake, county, lake_id, [], {"survey_date": survey_date, "acres": acres_pdf, "max_depth_ft": max_depth_ft, "contour_interval_ft": intervals_ft[0] if intervals_ft else None, "pdf_url": pdf_url}, qa, True, notes)

    # Fit similarity
    cands = fit_similarity_px_to_merc(src_poly, osm_merc)
    best_A, best_iou = None, -1
    for A in cands:
        A2, sc = refine_A_translation(A, src_poly, osm_merc, steps=11, span_frac=0.1)
        # also try slight scale tweaks
        for sf in (0.92, 0.96, 1.0, 1.04, 1.08):
            A3 = A2.copy()
            # scale about centroid of warped
            cx, cy = osm_merc.centroid.x, osm_merc.centroid.y
            # extract current scale/rot, apply factor about destination centroid — simpler: scale columns 0,1 and adjust translation from src centroid
            sc0 = math.hypot(A3[0, 0], A3[1, 0])
            # rebuild from src centroid
            sx, sy = src_poly.centroid.x, src_poly.centroid.y
            # warped src centroid under A2
            wx, wy = apply_A(A2, sx, sy)
            ang = math.atan2(A2[1, 0], A2[0, 0])
            new_scale = sc0 * sf
            ca, sa = math.cos(ang), math.sin(ang)
            A4 = np.array(
                [
                    [new_scale * ca, -new_scale * sa, wx - new_scale * (ca * sx - sa * sy)],
                    [new_scale * sa, new_scale * ca, wy - new_scale * (sa * sx + ca * sy)],
                ]
            )
            A4, sc4 = refine_A_translation(A4, src_poly, osm_merc, steps=7, span_frac=0.05)
            if sc4 > best_iou:
                best_iou, best_A = sc4, A4
        if sc > best_iou:
            best_iou, best_A = sc, A2

    qa["shore_iou"] = round(float(best_iou), 3)
    np.save(out_dir / "A.npy", best_A)

    warped_shore = warp_poly_px(src_poly, best_A)
    qa["mask_acres_georef"] = round(warped_shore.area / 4046.8564224, 1)

    # Visual QA overlay in merc cropped — save WGS geojson of warped water vs osm
    qc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"role": "osm"}, "geometry": mapping(osm)},
            {"type": "Feature", "properties": {"role": "warped_mask"}, "geometry": mapping(to_wgs(warped_shore))},
        ],
    }
    (out_dir / "qa_shore_overlay.geojson").write_text(json.dumps(qc))

    if best_iou < 0.35:
        notes.append(f"Low shoreline IoU={best_iou:.2f} vs OSM — georef uncertain")
    if acres_pdf and qa["osm_acres"]:
        ratio = qa["osm_acres"] / acres_pdf
        qa["acres_ratio_osm_pdf"] = round(ratio, 2)
        if ratio > 1.6 or ratio < 0.6:
            notes.append(f"Acre mismatch OSM {qa['osm_acres']} vs PDF {acres_pdf}")

    # Skeletonize contour lines
    sk = skeletonize(lines_mask > 0)
    Image.fromarray((sk.astype(np.uint8) * 255)).save(out_dir / "qa_skel.png")
    min_pts = 40 if style == "cbiobase_ramp" else 10
    raw_lines = skeleton_to_lines(sk, min_pts=min_pts)
    # Drop very short polylines (noise strokes / glyph edges)
    raw_lines = [pts for pts in raw_lines if len(pts) >= min_pts]
    qa["raw_line_count"] = len(raw_lines)

    # Warp lines to merc
    lines_merc = []
    for pts in raw_lines:
        wpts = [apply_A(best_A, float(x), float(y)) for x, y in pts]
        # drop if mostly outside buffered shore
        inside_n = sum(1 for x, y in wpts[:: max(1, len(wpts)//10)] if osm_merc.buffer(30).contains(Point(x, y)))
        if inside_n < 2:
            continue
        lines_merc.append(wpts)

    qa["kept_line_count"] = len(lines_merc)
    assigned = assign_depths_nested(lines_merc, osm_merc, intervals_ft)

    # Build features in WGS84 + shoreline 0
    features = []
    # shoreline from OSM
    def add_ring(coords, depth, line_type):
        # coords in merc
        wgs = [MERC_TO_WGS84.transform(x, y) for x, y in coords]
        if len(wgs) < 2:
            return
        # simplify lightly
        ls = LineString(wgs)
        ls = ls.simplify(0.00002, preserve_topology=True)
        if ls.is_empty or ls.length < 1e-7:
            return
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "lake": lake,
                    "depth_ft": int(depth),
                    "line_type": line_type,
                },
                "geometry": mapping(ls),
            }
        )

    # OSM exterior + interiors as 0
    if osm_merc.geom_type == "Polygon":
        add_ring(list(osm_merc.exterior.coords), 0, "INDEX")
        for ring in osm_merc.interiors:
            add_ring(list(ring.coords), 0, "INDEX")

    depth_counts = {}
    for depth, pts, dist in assigned:
        depth_counts[depth] = depth_counts.get(depth, 0) + 1
        line_type = "INDEX" if depth % (5 if 5 in intervals_ft or intervals_ft[0] == 5 else intervals_ft[0]) == 0 and depth % 10 == 0 else "INTERMEDIATE"
        # Actually match existing schema: INDEX for multiples of larger step
        # Sylvan used INDEX for 0 and every other? Looking at sample: INDEX for some. Use INDEX when depth % (2*interval)==0 or depth==0
        interval = intervals_ft[0]
        line_type = "INDEX" if (depth % (interval * 2) == 0) else "INTERMEDIATE"
        add_ring(pts, depth, line_type)

    qa["depth_counts"] = {str(k): v for k, v in sorted(depth_counts.items())}
    qa["feature_count"] = len(features)

    # Coverage check: do we have roughly each interval?
    missing = [d for d in intervals_ft if d not in depth_counts]
    if missing:
        notes.append(f"Missing depth bands after assignment: {missing}")

    if len(features) < 3:
        notes.append("Very few contour features extracted")

    needs_review = bool(notes) or best_iou < 0.55 or len(missing) > max(1, len(intervals_ft)//3)

    meta = {
        "survey_date": survey_date,
        "acres": acres_pdf if acres_pdf else qa.get("osm_acres"),
        "max_depth_ft": max_depth_ft,
        "contour_interval_ft": intervals_ft[0] if intervals_ft else None,
        "min_contour_ft": 0,
        "max_contour_ft": max(depth_counts.keys()) if depth_counts else None,
        "pdf_url": pdf_url,
        "lat": lat,
        "lon": lon,
        "intervals_ft": intervals_ft,
    }

    # bbox from features
    xs, ys = [], []
    for f in features:
        for x, y in f["geometry"]["coordinates"]:
            xs.append(x); ys.append(y)
    if xs:
        meta["bbox"] = [round(min(xs), 6), round(min(ys), 6), round(max(xs), 6), round(max(ys), 6)]
        meta["centroid"] = [round(sum(xs)/len(xs), 6), round(sum(ys)/len(ys), 6)]

    # Save contours
    fc = {"type": "FeatureCollection", "features": features}
    (out_dir / "contours.geojson").write_text(json.dumps(fc))
    (out_dir / "qa.json").write_text(json.dumps({"qa": qa, "notes": notes, "needs_review": needs_review, "meta": meta}, indent=2))

    return DigitizeResult(lake, county, lake_id, features, meta, qa, needs_review, notes)


if __name__ == "__main__":
    print("library module — import digitize_lake")
