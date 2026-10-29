/* Feature 1 — Offline maps.
 * "Save lake for offline" stores the app, lake data and USGS National Map basemap
 * tiles (public domain; bulk/offline use allowed) for the lake's bounding box.
 * OSM/Esri tiles are never bulk-downloaded (OSM tile policy forbids it). */
(function () {
  "use strict";
  const M = window.__mfa;
  if (!M) return;
  const esc = M.escapeHtml;
  const RUNTIME = "mfa-runtime-v1";
  const TILE_PREFIX = "mfa-tiles-";
  const STORE_KEY = "mfa.offlineLakes";
  const MAX_TILES = 1200; // per lake, both layers combined
  const MIN_Z = 11;
  const TOP_Z = 16; // USGS native max
  const LAYERS = [
    { key: "usgsTopo", name: "USGS Topo", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}" },
    { key: "usgsImagery", name: "USGS Imagery", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}" },
  ];
  const hasCaches = "caches" in window;
  const swOk = "serviceWorker" in navigator && window.isSecureContext;

  // ---------- service worker ----------
  let swReg = null;
  if (swOk) {
    navigator.serviceWorker
      .register("./sw.js")
      .then((r) => { swReg = r; renderStatus(); })
      .catch((e) => { console.warn("SW register failed", e); renderStatus(); });
    navigator.serviceWorker.addEventListener("controllerchange", renderStatus);
  }

  // ---------- storage ----------
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (_) { return {}; }
  }
  function writeSaved(o) { localStorage.setItem(STORE_KEY, JSON.stringify(o)); }

  // ---------- tile math ----------
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  function paddedBbox(b) {
    const dx = Math.max((b[2] - b[0]) * 0.15, 0.004);
    const dy = Math.max((b[3] - b[1]) * 0.15, 0.003);
    return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
  }
  function tilesFor(b, z) {
    const out = [];
    const x0 = lon2x(b[0], z), x1 = lon2x(b[2], z), y0 = lat2y(b[3], z), y1 = lat2y(b[1], z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
    return out;
  }
  // Pick the deepest zoom (and layers) that fit under MAX_TILES.
  function planFor(lake) {
    const b = paddedBbox(lake.bbox);
    for (let maxZ = TOP_Z; maxZ >= 13; maxZ--) {
      let per = [];
      for (let z = MIN_Z; z <= maxZ; z++) per = per.concat(tilesFor(b, z));
      if (per.length * 2 <= MAX_TILES) return { bbox: b, maxZ, layers: LAYERS, tiles: per, total: per.length * 2 };
      if (per.length <= MAX_TILES && maxZ <= 14) return { bbox: b, maxZ, layers: [LAYERS[0]], tiles: per, total: per.length };
    }
    let per = [];
    for (let z = MIN_Z; z <= 13; z++) per = per.concat(tilesFor(b, z));
    return { bbox: b, maxZ: 13, layers: [LAYERS[0]], tiles: per.slice(0, MAX_TILES), total: Math.min(per.length, MAX_TILES) };
  }
  const tileUrl = (tpl, [z, x, y]) => tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);

  async function cacheAppFiles() {
    const c = await caches.open(RUNTIME);
    const urls = (window.MFA_SHELL || []).concat(window.MFA_DATA || []);
    for (const u of urls) {
      const abs = new URL(u, location.href);
      const key = abs.pathname === "/" || u === "./" ? abs.origin + abs.pathname : abs.origin + abs.pathname;
      const hit = await c.match(key);
      if (hit && /\.geojson$/.test(abs.pathname)) continue; // already stored by the app's own load
      try {
        const r = await fetch(abs.href, { cache: "no-cache" });
        if (r.ok) await c.put(key, r);
      } catch (_) {}
    }
    for (const u of window.MFA_CDN || []) {
      if (await c.match(u)) continue;
      try { const r = await fetch(u, { mode: "cors" }); if (r.ok) await c.put(u, r); } catch (_) {}
    }
  }

  let job = null;
  async function saveLake(lake, onProgress) {
    if (!hasCaches) throw new Error("This browser can't store offline maps.");
    if (!lake.bbox) throw new Error("This lake has no map extent.");
    const plan = planFor(lake);
    const cacheName = TILE_PREFIX + lake.id;
    await caches.delete(cacheName);
    const cache = await caches.open(cacheName);
    const urls = [];
    for (const L of plan.layers) for (const t of plan.tiles) urls.push(tileUrl(L.url, t));
    let done = 0, failed = 0, bytes = 0, i = 0;
    job = { cancel: false, lakeId: lake.id };
    const myJob = job;
    onProgress && onProgress(0, urls.length, "Saving app and lake data…");
    await cacheAppFiles();
    async function worker() {
      while (i < urls.length && !myJob.cancel) {
        const u = urls[i++];
        try {
          const r = await fetch(u, { mode: "cors" });
          if (r.ok) {
            const blob = await r.clone().blob();
            bytes += blob.size;
            await cache.put(u, r);
          } else failed++;
        } catch (_) { failed++; }
        done++;
        if (done % 10 === 0 || done === urls.length) onProgress && onProgress(done, urls.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    if (myJob.cancel) {
      await caches.delete(cacheName);
      job = null;
      throw new Error("Cancelled");
    }
    job = null;
    const saved = loadSaved();
    saved[lake.id] = {
      id: lake.id, name: lake.name, county: lake.county || "", bbox: plan.bbox,
      maxZ: plan.maxZ, minZ: MIN_Z, layers: plan.layers.map((l) => l.name),
      tiles: urls.length - failed, failed, bytes, savedAt: new Date().toISOString(),
    };
    writeSaved(saved);
    return saved[lake.id];
  }
  async function deleteLake(id) {
    if (hasCaches) await caches.delete(TILE_PREFIX + id);
    const s = loadSaved();
    delete s[id];
    writeSaved(s);
  }

  const fmtMB = (b) => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + " MB";
  const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ---------- Tools menu section ----------
  const T = window.mfaTools;
  let statusEl, listEl;
  if (T) {
    const el = T.addSection({ id: "toolOffline", title: "🗺 Basemap & offline maps", order: 10 });
    const radios = Object.entries(M.basemaps)
      .map(([k, v]) => `<label class="tool-radio"><input type="radio" name="mfaBasemap" value="${k}" ${M.getBasemap() === k ? "checked" : ""}/> ${esc(v.label)}</label>`)
      .join("");
    el.innerHTML = `
      <fieldset class="tool-fieldset"><legend>Basemap</legend>${radios}</fieldset>
      <div class="tool-sub">Offline lakes</div>
      <p class="tool-note" id="offlineStatus"></p>
      <ul class="tool-list" id="offlineList" aria-label="Lakes saved for offline"></ul>
      <p class="tool-note">Open a lake and tap <b>Save lake for offline</b>. Saves this app, the lake data and USGS Topo + Imagery tiles (public domain, U.S. Geological Survey National Map) for that lake, up to ${MAX_TILES} tiles. Street (OpenStreetMap) and Satellite (Esri) maps need a connection.</p>`;
    el.querySelectorAll('input[name="mfaBasemap"]').forEach((r) =>
      r.addEventListener("change", () => r.checked && M.setBasemap(r.value))
    );
    document.addEventListener("mfa:basemap", (e) => {
      const r = el.querySelector(`input[value="${e.detail.name}"]`);
      if (r) r.checked = true;
    });
    statusEl = el.querySelector("#offlineStatus");
    listEl = el.querySelector("#offlineList");
  }

  async function renderStatus() {
    if (!statusEl) return;
    const parts = [];
    parts.push(navigator.onLine ? "Online." : "<b>Offline</b> — showing saved data.");
    if (!swOk) parts.push("Offline storage needs HTTPS and a modern browser.");
    else parts.push(navigator.serviceWorker.controller ? "Offline support active." : "Offline support installing…");
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        parts.push(`Storage used: ${fmtMB(est.usage || 0)}.`);
      }
    } catch (_) {}
    statusEl.innerHTML = parts.join(" ");
  }
  function renderList() {
    if (!listEl) return;
    const saved = Object.values(loadSaved());
    if (!saved.length) {
      listEl.innerHTML = `<li class="tool-empty">No lakes saved yet.</li>`;
      return;
    }
    listEl.innerHTML = saved
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => `<li class="tool-item" data-id="${esc(s.id)}">
          <div class="tool-item-main"><b>${esc(s.name)}</b><small>${esc(s.county)} · ${s.tiles} tiles (${esc(s.layers.join(" + "))}, zoom ${s.minZ}–${s.maxZ}) · ${fmtMB(s.bytes)} · saved ${esc(fmtWhen(s.savedAt))}</small></div>
          <div class="tool-item-btns">
            <button type="button" class="tool-btn" data-act="show" aria-label="Show ${esc(s.name)} on the map">Show</button>
            <button type="button" class="tool-btn danger" data-act="del" aria-label="Delete offline copy of ${esc(s.name)}">Delete</button>
          </div></li>`)
      .join("");
    listEl.querySelectorAll(".tool-item").forEach((li) => {
      const id = li.dataset.id;
      li.querySelector('[data-act="show"]').onclick = () => {
        const lake = M.lakeById(id);
        if (lake) { M.selectLake(lake, true); T && T.open(false); }
      };
      li.querySelector('[data-act="del"]').onclick = async () => {
        await deleteLake(id);
        M.toast("Offline copy deleted");
        renderList(); renderStatus();
        refreshCardButton();
      };
    });
  }
  renderList();
  renderStatus();

  // ---------- lake card button ----------
  let cardLake = null, cardBox = null;
  function refreshCardButton() {
    if (!cardBox || !cardLake || !document.body.contains(cardBox)) return;
    const s = loadSaved()[cardLake.id];
    if (job && job.lakeId === cardLake.id) return;
    if (!cardLake.bbox) { cardBox.innerHTML = ""; return; }
    cardBox.innerHTML = s
      ? `<div class="offline-row"><span class="offline-ok">✓ Saved for offline · ${s.tiles} tiles · ${esc(fmtWhen(s.savedAt))}</span>
         <button type="button" class="tool-btn" id="btnOfflineUpdate" aria-label="Update offline copy of this lake">Update</button>
         <button type="button" class="tool-btn danger" id="btnOfflineDelete" aria-label="Delete offline copy of this lake">Delete</button></div>`
      : `<button type="button" class="tool-btn wide" id="btnSaveOffline" aria-label="Save this lake for offline use">⬇ Save lake for offline <small>(~${planFor(cardLake).total} map tiles)</small></button>`;
    const go = cardBox.querySelector("#btnSaveOffline") || cardBox.querySelector("#btnOfflineUpdate");
    if (go) go.onclick = () => startSave(cardLake);
    const del = cardBox.querySelector("#btnOfflineDelete");
    if (del) del.onclick = async () => { await deleteLake(cardLake.id); M.toast("Offline copy deleted"); refreshCardButton(); renderList(); renderStatus(); };
  }
  async function startSave(lake) {
    if (!navigator.onLine) { M.toast("Connect to the internet to save a lake"); return; }
    const box = cardBox;
    box.innerHTML = `<div class="offline-row"><span class="offline-prog" id="offlineProg" role="status" aria-live="polite">Preparing…</span>
      <button type="button" class="tool-btn danger" id="btnOfflineCancel" aria-label="Cancel saving">Cancel</button></div>`;
    box.querySelector("#btnOfflineCancel").onclick = () => { if (job) job.cancel = true; };
    try {
      const s = await saveLake(lake, (d, n, msg) => {
        const p = document.getElementById("offlineProg");
        if (p) p.textContent = msg || `Saving map tiles ${d} / ${n}…`;
      });
      M.toast(`${lake.name} saved for offline (${s.tiles} tiles${s.failed ? `, ${s.failed} failed` : ""})`, 3500);
    } catch (e) {
      M.toast(e.message === "Cancelled" ? "Save cancelled" : "Couldn't save: " + e.message, 3500);
    }
    renderList(); renderStatus(); refreshCardButton();
  }
  document.addEventListener("mfa:lakecard", (e) => {
    cardLake = e.detail.lake;
    cardBox = document.createElement("div");
    cardBox.className = "offline-box";
    cardBox.dataset.order = 90;
    e.detail.extras.appendChild(cardBox);
    refreshCardButton();
  });

  // ---------- going offline ----------
  function onOffline() {
    renderStatus();
    const b = M.getBasemap();
    if ((b === "street" || b === "sat") && Object.keys(loadSaved()).length) {
      M.setBasemap("usgsTopo", true);
      M.toast("Offline — switched to the saved USGS Topo map", 4000);
    } else if (b === "street" || b === "sat") {
      M.toast("Offline — map tiles need a connection. Save a lake while online to use it offline.", 4500);
    }
  }
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", renderStatus);
  if (!navigator.onLine) onOffline();

  window.mfaOffline = { planFor, saveLake, deleteLake, loadSaved, TILE_PREFIX, MAX_TILES };
})();
