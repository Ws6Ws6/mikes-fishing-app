#!/usr/bin/env python3
"""Merge contour-batches/<county>/ into data/lakes.geojson + contours.geojson.

Only updates lakes that currently lack contours (or are marked incomplete),
unless --force-ids is given. Handles lakes_patch.json as list OR {lakes:[...]}.
"""
from __future__ import annotations
import argparse, json, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT / "contour-batches"
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "data"

def load_patch(path: Path):
    d = json.loads(path.read_text())
    if isinstance(d, list):
        return d
    if isinstance(d, dict) and "lakes" in d:
        return d["lakes"]
    raise ValueError(f"Unrecognized patch schema: {path}")

def load_review(path: Path):
    if not path.exists():
        return []
    d = json.loads(path.read_text())
    if isinstance(d, list):
        return d
    if isinstance(d, dict) and "items" in d:
        return d["items"]
    return []

def in_bbox(feat, bbox, pad=0.03):
    if not bbox:
        return False
    coords = feat["geometry"]["coordinates"]
    xs = [c[0] for c in coords[:: max(1, len(coords)//25)]]
    ys = [c[1] for c in coords[:: max(1, len(coords)//25)]]
    if not xs:
        return False
    cx, cy = sum(xs)/len(xs), sum(ys)/len(ys)
    return (bbox[0]-pad <= cx <= bbox[2]+pad) and (bbox[1]-pad <= cy <= bbox[3]+pad)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("counties", nargs="+", help="County folder names under contour-batches/")
    ap.add_argument("--force-ids", nargs="*", default=[], help="Also replace contours for these lake ids")
    args = ap.parse_args()

    lakes = json.loads((DATA/"lakes.geojson").read_text())
    by_id = {f["properties"]["id"]: f for f in lakes["features"]}
    contours = json.loads((DATA/"contours.geojson").read_text())

    rq_path = DATA/"contour_review_queue.json"
    rq = {e["id"]: e for e in (json.loads(rq_path.read_text()) if rq_path.exists() else [])}

    updated = []
    new_feats = []
    bboxes = {}  # name -> list of (bbox, id)

    for county in args.counties:
        # case-insensitive folder resolve
        candidates = [p for p in BATCH.iterdir() if p.is_dir() and p.name.lower() == county.lower()]
        cdir = None
        for cand in candidates:
            if (cand/"lakes_patch.json").exists() and (cand/"contours.geojson").exists():
                cdir = cand
                break
        if not cdir and candidates:
            cdir = candidates[0]
        if not cdir:
            print(f"SKIP missing county dir {county}")
            continue
        patch_path = cdir/"lakes_patch.json"
        cont_path = cdir/"contours.geojson"
        if not patch_path.exists() or not cont_path.exists():
            print(f"SKIP incomplete batch {cdir}")
            continue
        patches = load_patch(patch_path)
        reviews = {e.get("id"): e for e in load_review(cdir/"review_queue.json") if e.get("id")}
        cfc = json.loads(cont_path.read_text())
        print(f"\n== {cdir.name}: {len(patches)} patch lakes, {len(cfc['features'])} contour feats ==")

        # index contours by lake name
        by_lake_name = {}
        for f in cfc["features"]:
            by_lake_name.setdefault(f["properties"].get("lake"), []).append(f)

        for p in patches:
            lid = p.get("id")
            name = p.get("name")
            if not lid or lid not in by_id:
                print(f"  skip unknown id {lid}")
                continue
            if p.get("note") and "Already has" in p.get("note", ""):
                print(f"  skip already-vectored note: {name}")
                continue
            props = by_id[lid]["properties"]
            allow = (not props.get("has_contours")) or props.get("data_quality") == "incomplete_contours" or lid in args.force_ids
            if not allow:
                print(f"  skip already has contours: {name} ({lid})")
                continue

            # needs_review from patch or review queue
            rev = reviews.get(lid)
            needs = bool(p.get("needs_review"))
            notes = p.get("review_notes")
            if rev:
                needs = True
                reasons = rev.get("reasons") or rev.get("issues") or []
                if isinstance(reasons, list):
                    notes = "; ".join(reasons)
                elif reasons:
                    notes = str(reasons)
                if rev.get("severity") == "high" or (rev.get("shore_iou") is not None and rev["shore_iou"] < 0.5):
                    needs = True
            # also from digitize_qa
            qa = p.get("digitize_qa") or {}
            iou = qa.get("shore_iou") or p.get("shore_iou")
            if iou is not None and iou < 0.55:
                needs = True
                extra = f"Shoreline IoU={iou:.2f}"
                notes = f"{notes}; {extra}" if notes else extra

            # apply props
            props["has_contours"] = True
            props["needs_review"] = needs
            props["review_notes"] = notes
            for k in ["acres","max_depth_ft","survey_date","contour_interval_ft","min_contour_ft","max_contour_ft","pdf_url","bbox","source","source_url","precision_note"]:
                if p.get(k) is not None:
                    props[k] = p[k]
            if needs:
                props["data_quality"] = "needs_review"
            else:
                props["data_quality"] = p.get("data_quality") or "pdf_digitized"
            if p.get("bbox"):
                bb = p["bbox"]
                by_id[lid]["geometry"] = {"type":"Point","coordinates":[round((bb[0]+bb[2])/2,6), round((bb[1]+bb[3])/2,6)]}

            # collect contours for this lake name
            feats = by_lake_name.get(name, [])
            # ensure lake property matches app name
            for f in feats:
                f["properties"]["lake"] = name
            new_feats.extend(feats)
            bboxes.setdefault(name, []).append((p.get("bbox"), lid))
            updated.append(lid)
            if needs:
                rq[lid] = {"id": lid, "name": name, "county": props.get("county"), "issues": notes.split("; ") if notes else [], "shore_iou": iou, "status": "pending_review"}
            print(f"  + {name}: {len(feats)} feats, needs_review={needs}")

    # Remove prior contours for updated lakes (bbox-safe for name collisions)
    updated_names = set()
    for lid in updated:
        updated_names.add(by_id[lid]["properties"]["name"])

    kept = []
    removed = 0
    for f in contours["features"]:
        ln = f["properties"].get("lake")
        drop = False
        if ln in bboxes:
            for bbox, lid in bboxes[ln]:
                if lid in updated and (ln != "Crooked Lake" and ln != "Fish Lake" and ln != "Cedar Lake" and ln != "Silver Lake" and ln != "Loon Lake"):
                    # unique-enough names among updates: drop all matching name for that lake
                    # For non-collision names among NE inventory
                    if len(bboxes[ln]) == 1 or in_bbox(f, bbox):
                        drop = True
                        break
                elif lid in updated and in_bbox(f, bbox):
                    drop = True
                    break
        if drop:
            removed += 1
        else:
            kept.append(f)
    print(f"\nRemoved {removed} prior contour features; adding {len(new_feats)}")
    kept.extend(new_feats)
    lakes["features"] = list(by_id.values())
    (DATA/"lakes.geojson").write_text(json.dumps(lakes))
    (DATA/"contours.geojson").write_text(json.dumps({"type":"FeatureCollection","features":kept}))
    (DATA/"contour_review_queue.json").write_text(json.dumps(list(rq.values()), indent=2))
    for name in ["lakes.geojson","contours.geojson","contour_review_queue.json"]:
        shutil.copy2(DATA/name, PUBLIC/name)
    has = sum(1 for f in lakes["features"] if f["properties"].get("has_contours"))
    rev = sum(1 for f in lakes["features"] if f["properties"].get("needs_review"))
    print(f"Done. Contour lakes={has}/{len(lakes['features'])}, needs_review={rev}, contour_feats={len(kept)}")
    print("Updated:", updated)

if __name__ == "__main__":
    main()
