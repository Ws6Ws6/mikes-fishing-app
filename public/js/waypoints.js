/* Feature 2 — Waypoints: drop at GPS / map centre / long-press, name + notes,
 * edit, delete, GPX export/import. Stored on this device (localStorage). */
(function () {
  "use strict";
  const M = window.__mfa, G = window.mfaGpx, T = window.mfaTools;
  if (!M || !G) return;
  const map = M.map, esc = M.escapeHtml;
  const KEY = "mfa.waypoints";
  let wps = load();
  let visible = localStorage.getItem("mfa.waypointsHidden") !== "1";

  function load() { try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function save() { localStorage.setItem(KEY, JSON.stringify(wps)); }
  const uid = () => "wp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fmt = (v) => (+v).toFixed(5);

  if (!map.getPane("waypointsPane")) {
    map.createPane("waypointsPane");
    map.getPane("waypointsPane").style.zIndex = 640;
  }
  const layer = L.layerGroup();
  const icon = L.divIcon({ className: "wp-marker", html: '<div class="wp-pin" aria-hidden="true">📌</div>', iconSize: [30, 30], iconAnchor: [9, 28], popupAnchor: [4, -26] });

  function popupHtml(w) {
    return `<div class="wp-popup"><strong>${esc(w.name)}</strong>${w.notes ? `<p>${esc(w.notes)}</p>` : ""}
      <small>${fmt(w.lat)}, ${fmt(w.lng)}${w.src ? ` · ${w.src === "gps" ? "GPS" : w.src === "import" ? "imported" : "map position"}` : ""}</small>
      <div class="wp-popup-btns"><button type="button" class="tool-btn" data-wp-edit="${esc(w.id)}" aria-label="Edit waypoint ${esc(w.name)}">Edit</button>
      <button type="button" class="tool-btn danger" data-wp-del="${esc(w.id)}" aria-label="Delete waypoint ${esc(w.name)}">Delete</button></div></div>`;
  }
  function draw() {
    layer.clearLayers();
    for (const w of wps) {
      const m = L.marker([w.lat, w.lng], { icon, pane: "waypointsPane", title: w.name, keyboard: true, alt: "Waypoint " + w.name });
      m.bindPopup(() => popupHtml(w), { maxWidth: 260 });
      m._wpId = w.id;
      layer.addLayer(m);
    }
    if (visible && !map.hasLayer(layer)) layer.addTo(map);
    if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
    renderList();
  }
  map.on("popupopen", (e) => {
    const el = e.popup.getElement();
    if (!el) return;
    const ed = el.querySelector("[data-wp-edit]");
    if (ed) ed.onclick = () => { map.closePopup(); openEditor(wps.find((w) => w.id === ed.dataset.wpEdit)); };
    const dl = el.querySelector("[data-wp-del]");
    if (dl) dl.onclick = () => { map.closePopup(); remove(dl.dataset.wpDel); };
  });

  function remove(id) {
    const w = wps.find((x) => x.id === id);
    if (!w) return;
    if (!confirm(`Delete waypoint "${w.name}"?`)) return;
    wps = wps.filter((x) => x.id !== id);
    save(); draw();
    M.toast("Waypoint deleted");
  }

  // ---------- editor dialog ----------
  const dlg = document.createElement("div");
  dlg.className = "wp-dialog hidden";
  dlg.setAttribute("role", "dialog");
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-label", "Waypoint");
  dlg.innerHTML = `<form class="wp-form" novalidate>
      <h3 id="wpTitle">New waypoint</h3>
      <label>Name<input id="wpName" class="tool-input" maxlength="80" required aria-label="Waypoint name" /></label>
      <label>Notes<textarea id="wpNotes" class="tool-input" rows="3" maxlength="1000" aria-label="Waypoint notes"></textarea></label>
      <p class="tool-note" id="wpWhere"></p>
      <div class="tool-row">
        <button type="submit" class="tool-btn primary" id="wpSave">Save</button>
        <button type="button" class="tool-btn" id="wpCancel">Cancel</button>
        <button type="button" class="tool-btn danger" id="wpDelete">Delete</button>
      </div></form>`;
  document.body.appendChild(dlg);
  L.DomEvent.disableClickPropagation(dlg);
  let editing = null;
  function openEditor(w) {
    if (!w) return;
    editing = w;
    const isNew = !wps.some((x) => x.id === w.id);
    dlg.querySelector("#wpTitle").textContent = isNew ? "New waypoint" : "Edit waypoint";
    dlg.querySelector("#wpName").value = w.name || "";
    dlg.querySelector("#wpNotes").value = w.notes || "";
    dlg.querySelector("#wpWhere").textContent = `${fmt(w.lat)}, ${fmt(w.lng)} · ${w.src === "gps" ? "from GPS" + (w.acc ? ` (±${Math.round(w.acc)} m)` : "") : w.src === "import" ? "imported" : "map position"}`;
    dlg.querySelector("#wpDelete").classList.toggle("hidden", isNew);
    dlg.classList.remove("hidden");
    dlg.querySelector("#wpName").focus({ preventScroll: true });
  }
  function closeEditor() { dlg.classList.add("hidden"); editing = null; }
  dlg.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!editing) return;
    const name = dlg.querySelector("#wpName").value.trim() || `Waypoint ${wps.length + 1}`;
    const notes = dlg.querySelector("#wpNotes").value.trim();
    const i = wps.findIndex((x) => x.id === editing.id);
    const w = { ...editing, name, notes, updated: new Date().toISOString() };
    if (i >= 0) wps[i] = w; else wps.push(w);
    save(); closeEditor(); draw();
    M.toast(i >= 0 ? "Waypoint updated" : "Waypoint saved");
  });
  dlg.querySelector("#wpCancel").onclick = closeEditor;
  dlg.querySelector("#wpDelete").onclick = () => { const id = editing && editing.id; closeEditor(); remove(id); };
  dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEditor(); });

  function newAt(lat, lng, src, acc) {
    const now = new Date().toISOString();
    openEditor({ id: uid(), lat, lng, src, acc: acc || null, name: `Waypoint ${wps.length + 1}`, notes: "", time: now, created: now });
  }
  function addAtGps() {
    if (!navigator.geolocation || !window.isSecureContext) { M.toast("Location isn't available in this browser"); return; }
    M.toast("Getting your GPS position…");
    navigator.geolocation.getCurrentPosition(
      (p) => newAt(p.coords.latitude, p.coords.longitude, "gps", p.coords.accuracy),
      (err) => M.toast(err && err.code === 1 ? "Allow location for this site to drop a waypoint at your position." : "Couldn't get a GPS fix — try 'At map centre'.", 4500),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }
  function addAtCenter() { const c = map.getCenter(); newAt(c.lat, c.lng, "map"); }
  // Long-press on touch (contextmenu) or right-click on desktop.
  map.on("contextmenu", (e) => newAt(e.latlng.lat, e.latlng.lng, "map"));

  // ---------- GPX ----------
  function exportGpx() {
    if (!wps.length) { M.toast("No waypoints to export"); return; }
    G.download(`waypoints-${new Date().toISOString().slice(0, 10)}.gpx`, G.doc(wps.map(G.wpt).join(""), "Waypoints"));
  }
  async function importGpx(file) {
    try {
      const { wpts } = G.parse(await file.text());
      let added = 0, dup = 0;
      for (const w of wpts) {
        if (wps.some((x) => Math.abs(x.lat - w.lat) < 1e-6 && Math.abs(x.lng - w.lng) < 1e-6 && x.name === w.name)) { dup++; continue; }
        const now = new Date().toISOString();
        wps.push({ id: uid(), lat: w.lat, lng: w.lng, name: w.name || `Waypoint ${wps.length + 1}`, notes: w.notes || "", time: w.time || now, created: now, src: "import" });
        added++;
      }
      save(); draw();
      M.toast(`Imported ${added} waypoint${added === 1 ? "" : "s"}${dup ? ` (${dup} already here)` : ""}`, 3500);
    } catch (e) { M.toast("Import failed: " + e.message, 4000); }
  }

  // ---------- Tools section ----------
  let listEl;
  if (T) {
    const el = T.addSection({ id: "toolWaypoints", title: "📌 Waypoints", order: 20 });
    el.innerHTML = `
      <div class="tool-row">
        <button type="button" class="tool-btn primary" id="wpAddGps" aria-label="Add waypoint at my GPS position">＋ At my GPS position</button>
        <button type="button" class="tool-btn" id="wpAddCenter" aria-label="Add waypoint at map centre">＋ At map centre</button>
      </div>
      <p class="tool-note">Tip: long-press the map (right-click on a computer) to drop a waypoint there.</p>
      <label class="tool-check"><input type="checkbox" id="wpShow" ${visible ? "checked" : ""}/> Show waypoints on map</label>
      <ul class="tool-list" id="wpList" aria-label="Saved waypoints"></ul>
      <div class="tool-row">
        <button type="button" class="tool-btn" id="wpExport" aria-label="Export waypoints as GPX">Export GPX</button>
        <label class="tool-btn file-btn" aria-label="Import waypoints from GPX">Import GPX<input type="file" id="wpImport" accept=".gpx,application/gpx+xml,application/xml,text/xml" /></label>
      </div>
      <p class="tool-note">Waypoints are stored only on this device.</p>`;
    el.querySelector("#wpAddGps").onclick = addAtGps;
    el.querySelector("#wpAddCenter").onclick = addAtCenter;
    el.querySelector("#wpExport").onclick = exportGpx;
    el.querySelector("#wpImport").onchange = (e) => { const f = e.target.files[0]; if (f) importGpx(f); e.target.value = ""; };
    el.querySelector("#wpShow").onchange = (e) => { visible = e.target.checked; localStorage.setItem("mfa.waypointsHidden", visible ? "0" : "1"); draw(); };
    listEl = el.querySelector("#wpList");
  }
  function renderList() {
    if (!listEl) return;
    if (!wps.length) { listEl.innerHTML = `<li class="tool-empty">No waypoints yet.</li>`; return; }
    listEl.innerHTML = wps.map((w) => `<li class="tool-item" data-id="${esc(w.id)}">
      <div class="tool-item-main"><b>${esc(w.name)}</b><small>${fmt(w.lat)}, ${fmt(w.lng)}${w.notes ? " · " + esc(w.notes.slice(0, 60)) : ""}</small></div>
      <div class="tool-item-btns">
        <button type="button" class="tool-btn" data-act="go" aria-label="Show waypoint ${esc(w.name)} on map">Go</button>
        <button type="button" class="tool-btn" data-act="edit" aria-label="Edit waypoint ${esc(w.name)}">Edit</button>
        <button type="button" class="tool-btn danger" data-act="del" aria-label="Delete waypoint ${esc(w.name)}">Delete</button>
      </div></li>`).join("");
    listEl.querySelectorAll(".tool-item").forEach((li) => {
      const w = wps.find((x) => x.id === li.dataset.id);
      li.querySelector('[data-act="go"]').onclick = () => {
        if (!visible) { visible = true; const c = document.getElementById("wpShow"); if (c) c.checked = true; draw(); }
        T.open(false); map.setView([w.lat, w.lng], Math.max(map.getZoom(), 16));
        layer.eachLayer((m) => { if (m._wpId === w.id) m.openPopup(); });
      };
      li.querySelector('[data-act="edit"]').onclick = () => openEditor(w);
      li.querySelector('[data-act="del"]').onclick = () => remove(w.id);
    });
  }
  window.addEventListener("storage", (e) => { if (e.key === KEY) { wps = load(); draw(); } });
  draw();
  window.mfaWaypoints = { list: () => wps.slice(), addAtCenter, addAtGps, newAt };
})();
