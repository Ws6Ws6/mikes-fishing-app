/* Feature 3 — Track recording in Trolling mode.
 * Records your GPS path (time + speed) while Trolling mode is on, saves tracks on
 * this device (IndexedDB), shows them on the map, exports GPX.
 * Listens to mfa:trollstart / mfa:trollpos / mfa:trollstop from app.js; never
 * touches the Trolling HUD values themselves. */
(function () {
  "use strict";
  const M = window.__mfa, G = window.mfaGpx, T = window.mfaTools;
  if (!M || !G) return;
  const map = M.map, esc = M.escapeHtml;
  const PREF = "mfa.trackRecord", SHOWN = "mfa.tracksShown";
  const MIN_MOVE_M = 3, MAX_GAP_MS = 15000, MAX_ACC_M = 100, MAX_POINTS = 50000;

  // ---------- storage (IndexedDB, in-memory fallback) ----------
  let dbp = null, mem = new Map();
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      if (!window.indexedDB) return res(null);
      let req;
      try { req = indexedDB.open("mfa-tracks", 1); } catch (_) { return res(null); }
      req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id" });
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    if (!d) return fn(null);
    return new Promise((res, rej) => {
      const t = d.transaction("tracks", mode), st = t.objectStore("tracks");
      let out;
      Promise.resolve(fn(st)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const putTrack = (t) => tx("readwrite", (st) => { if (!st) { mem.set(t.id, t); return; } st.put(t); });
  const delTrack = (id) => tx("readwrite", (st) => { if (!st) { mem.delete(id); return; } st.delete(id); });
  const allTracks = () => tx("readonly", (st) => (st ? reqP(st.getAll()) : [...mem.values()]));

  // ---------- maths ----------
  const R = 6371008.8, rad = Math.PI / 180;
  function distM(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function stats(t) {
    const p = t.points || [];
    let d = 0, max = null, gps = 0;
    for (let i = 1; i < p.length; i++) d += distM(p[i - 1], p[i]);
    for (const x of p) { if (x.spd != null) { max = max == null ? x.spd : Math.max(max, x.spd); if (!x.sd) gps++; } }
    const dur = p.length > 1 ? p[p.length - 1].t - p[0].t : 0;
    return { distM: d, durMs: dur, avgMs: dur > 0 ? d / (dur / 1000) : null, maxMs: max, n: p.length, gpsSpeed: gps };
  }
  const mi = (m) => (m / 1609.344).toFixed(m < 16093 ? 2 : 1);
  const mph = (ms) => (ms == null ? "—" : (ms * 2.23694).toFixed(1));
  function durTxt(ms) { if (ms < 60000) return `${Math.round(ms / 1000)} s`; const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }
  const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ---------- recording ----------
  let autoRec = localStorage.getItem(PREF) !== "0";
  let trolling = false, cur = null, lastSave = 0, skippedAcc = 0;
  function begin() {
    const now = Date.now();
    cur = { id: "trk-" + now.toString(36), name: `Track ${when(now)}`, start: now, points: [], inProgress: true, created: new Date(now).toISOString() };
    skippedAcc = 0; lastSave = 0;
    hud();
  }
  async function finish(reason) {
    if (!cur) return;
    const t = cur; cur = null;
    if (t.points.length < 2) { delTrack(t.id).catch(() => {}); hud(); if (reason !== "silent") M.toast("Track not saved — fewer than 2 GPS points recorded.", 3500); return; }
    t.inProgress = false; t.end = t.points[t.points.length - 1].t;
    const s = stats(t);
    try { await putTrack(t); } catch (e) { M.toast("Couldn't save track: " + e.message, 4500); }
    shown.add(t.id); saveShown();
    hud(); await refresh();
    M.toast(`Track saved: ${mi(s.distM)} mi in ${durTxt(s.durMs)}`, 3500);
  }
  function onPos(e) {
    if (!cur) return;
    const d = e.detail || {};
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return;
    if (d.acc != null && d.acc > MAX_ACC_M) { skippedAcc++; hud(); return; }
    const t = Number.isFinite(d.t) ? d.t : Date.now();
    const pt = { lat: +d.lat.toFixed(7), lng: +d.lng.toFixed(7), t };
    const prev = cur.points[cur.points.length - 1];
    if (prev) {
      const m = distM(prev, pt), dt = t - prev.t;
      if (dt <= 0) return;
      if (m < MIN_MOVE_M && dt < MAX_GAP_MS) return;
      if (d.spd != null) pt.spd = +d.spd.toFixed(2);
      else if (dt >= 1000) { pt.spd = +(m / (dt / 1000)).toFixed(2); pt.sd = 1; } // derived from positions (only over ≥1 s, to avoid GPS-jitter spikes)
    } else if (d.spd != null) pt.spd = +d.spd.toFixed(2);
    if (d.acc != null) pt.acc = Math.round(d.acc);
    cur.points.push(pt);
    if (cur.points.length > MAX_POINTS) cur.points.shift();
    const now = Date.now();
    if (now - lastSave > 20000) { lastSave = now; putTrack(cur).catch(() => {}); }
    hud();
  }
  document.addEventListener("mfa:trollstart", () => { trolling = true; if (autoRec) begin(); hud(); });
  document.addEventListener("mfa:trollpos", onPos);
  document.addEventListener("mfa:trollstop", () => { trolling = false; finish(); hud(); });
  window.addEventListener("pagehide", () => { if (cur) putTrack(cur).catch(() => {}); });

  // ---------- HUD (one small button + status line inside the existing Trolling HUD) ----------
  const ctr = document.querySelector("#trollHud .troll-controls");
  let recBtn = null, recStat = null;
  if (ctr) {
    recBtn = document.createElement("button");
    recBtn.type = "button"; recBtn.id = "btnRecTrack";
    ctr.insertBefore(recBtn, document.getElementById("btnClearTrack"));
    recBtn.addEventListener("click", () => {
      if (cur) finish(); else if (trolling) begin();
      hud();
    });
    recStat = document.createElement("p");
    recStat.id = "trackStat"; recStat.className = "track-stat"; recStat.setAttribute("aria-live", "polite");
    ctr.insertAdjacentElement("afterend", recStat);
  }
  function hud() {
    if (!recBtn) return;
    const on = !!cur;
    recBtn.textContent = on ? "■ Stop" : "● Rec";
    recBtn.classList.toggle("rec-on", on);
    recBtn.setAttribute("aria-pressed", on ? "true" : "false");
    recBtn.setAttribute("aria-label", on ? "Stop recording and save this track" : "Start recording a track");
    if (!on) { recStat.textContent = trolling ? "Not recording a track." : ""; return; }
    const s = stats(cur);
    recStat.textContent = `● Recording track · ${mi(s.distM)} mi · ${s.n} point${s.n === 1 ? "" : "s"}` + (skippedAcc ? ` · ${skippedAcc} low-accuracy fix${skippedAcc === 1 ? "" : "es"} skipped` : "");
  }

  // ---------- saved tracks on the map ----------
  if (!map.getPane("tracksPane")) { map.createPane("tracksPane"); map.getPane("tracksPane").style.zIndex = 610; }
  let shown = new Set();
  try { shown = new Set(JSON.parse(localStorage.getItem(SHOWN) || "[]")); } catch (_) {}
  const saveShown = () => localStorage.setItem(SHOWN, JSON.stringify([...shown]));
  const lines = new Map();
  let tracks = [];
  function popup(t) {
    const s = stats(t);
    return `<div class="trk-popup"><strong>${esc(t.name)}</strong><br/><small>${esc(when(t.start))}</small>
      <div>${mi(s.distM)} mi · ${durTxt(s.durMs)}</div>
      <div>Avg ${mph(s.avgMs)} mph · Max ${mph(s.maxMs)} mph</div>
      <small>${s.n} GPS points · speed ${s.gpsSpeed ? "from GPS" : "derived from positions"}</small></div>`;
  }
  function drawLines() {
    for (const [id, l] of lines) { map.removeLayer(l); lines.delete(id); }
    for (const t of tracks) {
      if (!shown.has(t.id) || (t.points || []).length < 2) continue;
      const l = L.polyline(t.points.map((p) => [p.lat, p.lng]), { pane: "tracksPane", color: "#e8590c", weight: 4, opacity: 0.85, className: "trk-line" });
      l.bindPopup(() => popup(t));
      l.addTo(map); lines.set(t.id, l);
    }
  }

  // ---------- Tools section ----------
  let listEl = null;
  if (T) {
    const el = T.addSection({ id: "toolTracks", title: "🛶 Tracks", order: 30 });
    el.innerHTML = `
      <label class="tool-check"><input type="checkbox" id="trkAuto" ${autoRec ? "checked" : ""}/> Record a track automatically in Trolling mode</label>
      <p class="tool-note">Tracks record your GPS position, time and speed while Trolling mode is on, and are stored only on this device.</p>
      <ul class="tool-list" id="trkList" aria-label="Saved tracks"></ul>
      <div class="tool-row"><button type="button" class="tool-btn" id="trkExportAll" aria-label="Export all tracks as GPX">Export all GPX</button></div>`;
    el.querySelector("#trkAuto").onchange = (e) => { autoRec = e.target.checked; localStorage.setItem(PREF, autoRec ? "1" : "0"); };
    el.querySelector("#trkExportAll").onclick = () => {
      const ok = tracks.filter((t) => t.points.length >= 2);
      if (!ok.length) { M.toast("No tracks to export"); return; }
      G.download(`tracks-${new Date().toISOString().slice(0, 10)}.gpx`, G.doc(ok.map(G.trk).join(""), "Tracks"));
    };
    listEl = el.querySelector("#trkList");
  }
  function renderList() {
    if (!listEl) return;
    if (!tracks.length) { listEl.innerHTML = `<li class="tool-empty">No tracks yet. Turn on Trolling mode to record one.</li>`; return; }
    listEl.innerHTML = tracks.map((t) => {
      const s = stats(t), on = shown.has(t.id);
      return `<li class="tool-item" data-id="${esc(t.id)}">
        <div class="tool-item-main"><b>${esc(t.name)}</b><small>${esc(when(t.start))} · ${mi(s.distM)} mi · ${durTxt(s.durMs)} · avg ${mph(s.avgMs)} / max ${mph(s.maxMs)} mph</small></div>
        <div class="tool-item-btns">
          <button type="button" class="tool-btn" data-act="show" aria-pressed="${on}" aria-label="${on ? "Hide" : "Show"} track ${esc(t.name)} on map">${on ? "Hide" : "Show"}</button>
          <button type="button" class="tool-btn" data-act="gpx" aria-label="Export track ${esc(t.name)} as GPX">GPX</button>
          <button type="button" class="tool-btn" data-act="ren" aria-label="Rename track ${esc(t.name)}">Rename</button>
          <button type="button" class="tool-btn danger" data-act="del" aria-label="Delete track ${esc(t.name)}">Delete</button>
        </div></li>`;
    }).join("");
    listEl.querySelectorAll(".tool-item").forEach((li) => {
      const t = tracks.find((x) => x.id === li.dataset.id);
      li.querySelector('[data-act="show"]').onclick = () => {
        if (shown.has(t.id)) shown.delete(t.id); else shown.add(t.id);
        saveShown(); drawLines(); renderList();
        const l = lines.get(t.id);
        if (l) { T.open(false); map.fitBounds(l.getBounds(), { padding: [30, 30], maxZoom: 17 }); }
      };
      li.querySelector('[data-act="gpx"]').onclick = () => G.download(`${t.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "track"}.gpx`, G.doc(G.trk(t), t.name));
      li.querySelector('[data-act="ren"]').onclick = async () => {
        const n = prompt("Track name", t.name);
        if (n == null || !n.trim()) return;
        t.name = n.trim().slice(0, 80); await putTrack(t); await refresh();
      };
      li.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm(`Delete track "${t.name}"?`)) return;
        await delTrack(t.id); shown.delete(t.id); saveShown(); await refresh(); M.toast("Track deleted");
      };
    });
  }
  async function refresh() {
    try { tracks = (await allTracks()).filter((t) => !t.inProgress).sort((a, b) => b.start - a.start); }
    catch (e) { tracks = []; if (listEl) listEl.innerHTML = `<li class="tool-empty">Couldn't read saved tracks: ${esc(e.message)}</li>`; return; }
    drawLines(); renderList();
  }
  // A track still marked "in progress" means the page closed while recording: keep it.
  (async () => {
    try {
      for (const t of await allTracks()) {
        if (!t.inProgress) continue;
        if ((t.points || []).length < 2) { await delTrack(t.id); continue; }
        t.inProgress = false; t.end = t.points[t.points.length - 1].t; t.name += " (interrupted)";
        await putTrack(t); shown.add(t.id); saveShown();
      }
    } catch (_) {}
    if (!(await db())) M.toast("Tracks can't be saved permanently in this browser (no IndexedDB).", 4000);
    refresh();
  })();
  hud();
  window.mfaTracks = { list: () => tracks.slice(), current: () => cur, stats, refresh, finish };
})();
