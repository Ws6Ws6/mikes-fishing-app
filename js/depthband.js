/* Depth range highlight (Feature 9). Shades the parts of a lake whose bounding contour lines all lie
 * within a chosen min–max depth. Only on lakes with verified contours (official DNR survey vectors or
 * DNR maps traced and reviewed; not historical, raster-approximate, unreviewed or dashed lines).
 * No depth is interpolated or invented: an area is shaded only when every contour around it is in the
 * range; the deepest basin is shaded only if DNR's published max depth is also in the range. */
(function () {
  "use strict";
  const T = window.mfaTools, M = () => window.__mfa;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const VERIFIED_METHODS = { vector_featureserver: 1, traced_from_pdf: 1 };
  function isVerified(l) {
    return !!(l && l.has_contours && !l.needs_review && !l.no_depth_map && VERIFIED_METHODS[l.contour_method] &&
      l.data_quality !== "needs_review" && l.data_quality !== "pdf_digitized" && l.line_style !== "dashed" &&
      !/distance_from_shore|synthetic/.test(l.depth_assignment || ""));
  }
  let contoursP = null;
  const loadContours = () => (contoursP = contoursP || fetch("./data/contours.geojson").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).catch((e) => { contoursP = null; throw e; }));
  const cache = new Map(); // lakeId -> {rings, open, depths}
  const mx = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
  function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
  function pip(pt, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; }
  function build(lakeId, gj, lat) {
    if (cache.has(lakeId)) return cache.get(lakeId);
    const k = mx(lat), rings = []; let open = 0; const depths = new Set();
    for (const f of gj.features) {
      const p = f.properties || {};
      if (p.lake_id !== lakeId || p.depth_ft == null) continue;
      if (p.line_style === "dashed" || p.contour_method === "synthetic_or_distance_based" || /distance_from_shore/.test(p.depth_assignment || "")) continue;
      depths.add(+p.depth_ft);
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
      for (const ln of lines) {
        if (ln.length < 4) { open++; continue; }
        const a = ln[0], b = ln[ln.length - 1];
        if (Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540) > 20) { open++; continue; }
        const r = ln.map((c) => [c[0], c[1]]);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        rings.push({ r, d: +p.depth_ft, area: ringArea(r), bb: [x0, y0, x1, y1], kids: [], parent: null });
      }
    }
    rings.sort((a, b) => a.area - b.area); // smallest first: first container found is the tightest
    for (let i = 0; i < rings.length; i++) {
      const c = rings[i], pt = c.r[0];
      for (let j = i + 1; j < rings.length; j++) {
        const p = rings[j];
        if (p.area <= c.area || pt[0] < p.bb[0] || pt[0] > p.bb[2] || pt[1] < p.bb[1] || pt[1] > p.bb[3]) continue;
        if (pip(pt, p.r)) { c.parent = p; p.kids.push(c); break; }
      }
    }
    const out = { rings, open, depths: [...depths].sort((a, b) => a - b) };
    cache.set(lakeId, out);
    return out;
  }
  // Regions = ring minus its child rings. Shade when the ring depth and all child depths are in [lo, hi].
  function regions(lake, data, lo, hi) {
    const res = [];
    let leafBasins = 0, leafSkipped = 0;
    for (const R of data.rings) {
      if (R.d < lo || R.d > hi) continue;
      if (R.kids.length) {
        if (R.kids.every((c) => c.d >= lo && c.d <= hi)) res.push(R);
      } else {
        const basin = !R.parent || R.parent.d < R.d;
        if (!basin) continue; // hump/island top: height unknown — never shaded
        leafBasins++;
        if (lake.max_depth_ft != null && lake.max_depth_ft >= R.d && lake.max_depth_ft <= hi) res.push(R);
        else leafSkipped++;
      }
    }
    return { res, leafSkipped };
  }
  let layer = null, cur = null;
  function pane() {
    const map = M().map;
    if (!map.getPane("depthBandPane")) { map.createPane("depthBandPane"); const p = map.getPane("depthBandPane"); p.style.zIndex = 390; p.style.pointerEvents = "none"; }
  }
  function clear() { if (layer) { M().map.removeLayer(layer); layer = null; } }
  function draw(lake, data, lo, hi) {
    clear(); pane();
    const { res, leafSkipped } = regions(lake, data, lo, hi);
    const ll = (r) => r.map((c) => [c[1], c[0]]);
    layer = L.layerGroup(res.map((R) => L.polygon([ll(R.r), ...R.kids.map((c) => ll(c.r))], { pane: "depthBandPane", interactive: false, stroke: false, fillColor: "#ff6a00", fillOpacity: 0.38, className: "depth-band" }))).addTo(M().map);
    return { n: res.length, leafSkipped };
  }
  document.addEventListener("mfa:lakecard", (e) => {
    const lake = e.detail.lake;
    clear(); cur = lake;
    if (!isVerified(lake)) return;
    const { body, summary } = T.cardSection(e.detail.extras, { id: "secDepth", title: "🎚 Depth range highlight", order: 5 });
    body.innerHTML = `<div class="tool-row db-row">
        <label>Min ft <input type="number" class="tool-input db-in" id="dbMin" min="0" step="1" inputmode="numeric" aria-label="Minimum depth in feet" /></label>
        <label>Max ft <input type="number" class="tool-input db-in" id="dbMax" min="0" step="1" inputmode="numeric" aria-label="Maximum depth in feet" /></label></div>
      <div class="tool-row"><button type="button" class="tool-btn" id="dbApply" aria-label="Shade depth range">Shade range</button>
        <button type="button" class="tool-btn" id="dbClear" aria-label="Clear depth shading">Clear</button></div>
      <p class="sec-src" id="dbStat" aria-live="polite">Loading contours…</p>`;
    const stat = body.querySelector("#dbStat"), iMin = body.querySelector("#dbMin"), iMax = body.querySelector("#dbMax");
    let data = null;
    loadContours().then((gj) => {
      if (cur !== lake) return;
      data = build(lake.id, gj, lake.lat != null ? lake.lat : lake.bbox ? (lake.bbox[1] + lake.bbox[3]) / 2 : 40);
      stat.textContent = `Contour depths on this lake: ${data.depths.join(", ")} ft. Shading follows these lines only.`;
    }).catch((err) => { stat.textContent = `Contours unavailable (${err.message}).`; });
    const go = () => {
      if (!data) return;
      let lo = parseFloat(iMin.value), hi = parseFloat(iMax.value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) { stat.textContent = "Enter a min and max depth in feet."; return; }
      if (lo > hi) [lo, hi] = [hi, lo];
      const r = draw(lake, data, lo, hi);
      summary.textContent = r.n ? `🎚 Shading ${lo}–${hi} ft` : "🎚 Depth range highlight";
      const inRange = data.depths.filter((d) => d >= lo && d <= hi);
      stat.innerHTML = (r.n ? `Shaded ${r.n} area${r.n > 1 ? "s" : ""} where every bounding contour is between ${lo} and ${hi} ft.` :
        `No area of this lake is bounded only by contours between ${lo} and ${hi} ft${inRange.length < 2 ? ` (needs at least two contour depths in the range; available: ${esc(data.depths.join(", "))} ft)` : ""}.`) +
        (r.leafSkipped ? ` The deepest basin${r.leafSkipped > 1 ? "s are" : " is"} not shaded because the depth inside the deepest contour isn't known to stay within ${hi} ft.` : "") +
        (data.open ? ` ${data.open} contour line${data.open > 1 ? "s are" : " is"} not closed, so nearby areas may be left unshaded.` : "") +
        ` Source: ${esc((M().depthSourceLabel && M().depthSourceLabel(lake)) || lake.source || "verified contours")}.`;
    };
    body.querySelector("#dbApply").onclick = go;
    [iMin, iMax].forEach((i) => i.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); }));
    body.querySelector("#dbClear").onclick = () => { clear(); summary.textContent = "🎚 Depth range highlight"; stat.textContent = data ? `Contour depths on this lake: ${data.depths.join(", ")} ft.` : ""; };
  });
  window.mfaDepthBand = { isVerified, build, regions, loadContours, clear, layer: () => layer };
})();
