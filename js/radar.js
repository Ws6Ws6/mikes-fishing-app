/* Feature 4b — Live weather radar overlay with a 6-hour loop.
 * Source: NEXRAD base reflectivity mosaic (N0Q) tiles from the Iowa Environmental
 * Mesonet (IEM), Iowa State University. IEM: "The materials found on this website are
 * in the public domain and may be used freely by anyone for any lawful purpose.
 * Attributing the Iowa Environmental Mesonet of Iowa State University would be
 * appreciated." (mesonet.agron.iastate.edu/disclaimer.php)
 *   newest frame time: /data/gis/images/4326/USCOMP/n0q_0.json  (meta.valid)
 *   archived frames:   /json/radar.py?operation=list&product=N0Q&radar=USCOMP
 *   tiles:             /c/tile.py/1.0.0/ridge::USCOMP-N0Q-YYYYMMDDHHMI/{z}/{x}/{y}.png
 * Frame times always come from IEM; a frame that fails is reported and skipped, and
 * an old frame is never labelled as the latest. */
(function () {
  "use strict";
  const M = window.__mfa, T = window.mfaTools;
  if (!M || !window.L) return;
  const map = M.map, esc = M.escapeHtml;
  const IEM = "https://mesonet.agron.iastate.edu";
  const META = IEM + "/data/gis/images/4326/USCOMP/n0q_0.json";
  const TILE = "https://mesonet{s}.agron.iastate.edu/c/tile.py/1.0.0/ridge::USCOMP-N0Q-{ts}/{z}/{x}/{y}.png";
  const ATTR = 'Radar: <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">IEM</a> NEXRAD';
  const HOURS = 6, REFRESH_MS = 5 * 60 * 1000, STALE_MS = 20 * 60 * 1000, OPACITY = 0.62, FRAME_MS = 550;
  const stepMin = () => (innerWidth >= 800 ? 10 : 15); // fewer frames to preload on phones

  if (!map.getPane("radarPane")) {
    map.createPane("radarPane");
    const p = map.getPane("radarPane");
    p.style.zIndex = 350; // above basemap tiles (200), below contours/overlays (400) and markers
    p.style.pointerEvents = "none";
  }

  const key = (t) => new Date(t).toISOString().replace(/[-:T]/g, "").slice(0, 12); // UTC YYYYMMDDHHMI
  const tLocal = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  function rel(ms) { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`IEM ${r.status}`);
    return r.json();
  }

  const st = { on: false, frames: [], idx: -1, playing: false, playTimer: null, refreshTimer: null, tickTimer: null, latest: null, metaErr: null, waited: 0, gen: 0 };

  function makeFrame(t) {
    const f = { t, k: key(t), err: 0, loading: true, loaded: false };
    f.layer = L.tileLayer(TILE.replace("{ts}", f.k), {
      pane: "radarPane", subdomains: ["1", "2", "3"], opacity: 0, maxNativeZoom: 10, maxZoom: 20,
      updateWhenIdle: true, keepBuffer: 0, attribution: ATTR, className: "radar-tiles",
      bounds: L.latLngBounds([18, -135], [56, -60]),
    });
    f.layer.on("loading", () => { f.loading = true; f.loaded = false; f.err = 0; });
    f.layer.on("tileerror", () => { f.err++; });
    f.layer.on("load", () => { f.loading = false; f.loaded = true; ui(); });
    return f;
  }

  async function fetchTimes() {
    const meta = await getJSON(META);
    const latest = Date.parse(meta && meta.meta && meta.meta.valid);
    if (!Number.isFinite(latest)) throw new Error("IEM radar time missing");
    const start = latest - HOURS * 3600e3;
    const fmt = (t) => new Date(t).toISOString().slice(0, 16) + "Z";
    let scans = null;
    try {
      const j = await getJSON(`${IEM}/json/radar.py?operation=list&product=N0Q&radar=USCOMP&start=${fmt(start)}&end=${fmt(latest)}`);
      scans = (j.scans || []).map((s) => Date.parse(s.ts)).filter(Number.isFinite);
    } catch (_) { scans = null; }
    const step = stepMin();
    let times;
    if (scans && scans.length) {
      times = scans.filter((t) => t >= start && t <= latest && (t === latest || new Date(t).getUTCMinutes() % step === 0));
    } else {
      // IEM documents the mosaic as available at every 5-minute mark; build the grid.
      times = [];
      for (let t = latest - (latest % (step * 60000)); t >= start; t -= step * 60000) times.push(t);
    }
    if (!times.includes(latest)) times.push(latest);
    return { latest, times: [...new Set(times)].sort((a, b) => a - b) };
  }

  async function sync() {
    const my = ++st.gen;
    let res;
    try { res = await fetchTimes(); st.metaErr = null; statusMsg = ""; statusKind = ""; }
    catch (e) {
      if (my !== st.gen || !st.on) return;
      st.metaErr = e.message || "network error";
      if (!st.frames.length) { setStatus(`Radar unavailable right now (${st.metaErr}).`, "err"); ui(); }
      else ui();
      return;
    }
    if (my !== st.gen || !st.on) return;
    const wasAtLatest = st.idx === st.frames.length - 1;
    const old = new Map(st.frames.map((f) => [f.t, f]));
    const frames = res.times.map((t) => old.get(t) || makeFrame(t));
    for (const [t, f] of old) if (!res.times.includes(t)) map.removeLayer(f.layer);
    for (const f of frames) if (!map.hasLayer(f.layer)) f.layer.addTo(map); // preload every frame (hidden)
    const curT = st.frames[st.idx] && st.frames[st.idx].t;
    st.frames = frames; st.latest = res.latest;
    st.idx = wasAtLatest || curT == null ? frames.length - 1 : Math.max(0, frames.findIndex((f) => f.t === curT));
    show(st.idx);
  }

  function show(i) {
    if (!st.frames.length) return;
    st.idx = Math.max(0, Math.min(st.frames.length - 1, i));
    st.frames.forEach((f, j) => f.layer.setOpacity(j === st.idx ? OPACITY : 0));
    ui();
  }

  function step() {
    if (!st.playing || !st.frames.length) return;
    const n = st.frames.length;
    let next = (st.idx + 1) % n, tries = 0;
    while (st.frames[next].err && tries++ < n) next = (next + 1) % n; // skip failed frames
    const f = st.frames[next];
    if (f.loading && st.waited < 6) { st.waited++; st.playTimer = setTimeout(step, 250); return; } // wait for preload
    st.waited = 0;
    show(next);
    st.playTimer = setTimeout(step, next === n - 1 ? FRAME_MS * 3 : FRAME_MS); // hold on the latest frame
  }
  function play(on) {
    st.playing = on && st.frames.length > 1;
    clearTimeout(st.playTimer);
    if (st.playing) st.playTimer = setTimeout(step, FRAME_MS);
    ui();
  }

  function enable(on) {
    if (on === st.on) { if (on) bar.classList.remove("hidden"); return; }
    st.on = on;
    if (toggle) toggle.checked = on;
    if (!on) {
      st.gen++;
      play(false);
      clearInterval(st.refreshTimer); clearInterval(st.tickTimer);
      st.frames.forEach((f) => map.removeLayer(f.layer));
      st.frames = []; st.idx = -1; st.latest = null; st.metaErr = null;
      bar.classList.add("hidden");
      setStatus("");
      return;
    }
    bar.classList.remove("hidden");
    if (!navigator.onLine) { setStatus("Radar needs an internet connection — you're offline.", "err"); ui(); return; }
    setStatus("Loading radar frames…");
    ui();
    sync();
    st.refreshTimer = setInterval(sync, REFRESH_MS);
    st.tickTimer = setInterval(ui, 30000);
  }

  // ---------- UI ----------
  const bar = document.createElement("div");
  bar.id = "radarBar";
  bar.className = "radar-bar hidden";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Weather radar loop");
  bar.innerHTML = `
    <div class="radar-row">
      <button type="button" id="radarPlay" class="radar-btn" aria-label="Play radar loop">▶</button>
      <div class="radar-when"><span id="radarTime">—</span> <span id="radarBadge" class="radar-badge"></span></div>
      <button type="button" id="radarClose" class="radar-btn" aria-label="Turn off weather radar">×</button>
    </div>
    <input type="range" id="radarSlider" min="0" max="0" value="0" step="1" aria-label="Radar frame time" />
    <div id="radarStatus" class="radar-status" aria-live="polite"></div>
    <div class="radar-attr">NEXRAD radar (N0Q) · <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">Iowa Environmental Mesonet</a></div>`;
  document.body.appendChild(bar);
  L.DomEvent.disableClickPropagation(bar);
  L.DomEvent.disableScrollPropagation(bar);
  const $ = (id) => bar.querySelector("#" + id);
  $("radarPlay").onclick = () => play(!st.playing);
  $("radarClose").onclick = () => enable(false);
  $("radarSlider").addEventListener("input", (e) => { const v = +e.target.value; play(false); show(v); });

  let statusMsg = "", statusKind = "";
  function setStatus(m, kind) { statusMsg = m; statusKind = kind || ""; ui(); }

  function ui() {
    const n = st.frames.length, f = st.frames[st.idx];
    const s = $("radarSlider");
    s.max = Math.max(0, n - 1); s.value = Math.max(0, st.idx); s.disabled = n < 2;
    $("radarPlay").textContent = st.playing ? "❚❚" : "▶";
    $("radarPlay").setAttribute("aria-label", st.playing ? "Pause radar loop" : "Play radar loop");
    $("radarPlay").disabled = n < 2;
    const badge = $("radarBadge");
    const now = Date.now();
    let msgs = [];
    if (f) {
      const isLast = st.idx === n - 1;
      $("radarTime").textContent = tLocal(f.t);
      s.setAttribute("aria-valuetext", tLocal(f.t) + (isLast ? " (newest frame)" : ""));
      const age = now - f.t;
      if (f.err && !f.loading) { badge.textContent = "FAILED"; badge.className = "radar-badge bad"; }
      else if (isLast && age <= STALE_MS) { badge.textContent = "LATEST"; badge.className = "radar-badge live"; }
      else if (isLast) { badge.textContent = `NEWEST · ${rel(age)} old`; badge.className = "radar-badge old"; }
      else { badge.textContent = `${rel(age)} ago`; badge.className = "radar-badge"; }
      const last = st.frames[n - 1], lastAge = now - last.t;
      if (lastAge > STALE_MS) msgs.push(`Radar delayed: the newest frame IEM has is ${rel(lastAge)} old.`);
      if (last.err && !last.loading) msgs.push("The newest radar frame failed to load.");
      const loaded = st.frames.filter((x) => !x.loading).length, failed = st.frames.filter((x) => x.err && !x.loading).length;
      if (loaded < n) msgs.push(`Loading frames ${loaded}/${n}…`);
      if (failed) msgs.push(`${failed} of ${n} frame${failed === 1 ? "" : "s"} failed to load (skipped in the loop).`);
      if (st.metaErr) msgs.push(`Couldn't refresh radar (${st.metaErr}); showing frames up to ${tLocal(last.t)}.`);
      msgs.push(`${n} frames, every ${stepMin()} min over the last ${HOURS} h.`);
    } else {
      $("radarTime").textContent = "—"; badge.textContent = ""; badge.className = "radar-badge";
    }
    if (!f && statusMsg) msgs = [statusMsg];
    else if (f && statusMsg) msgs.unshift(statusMsg);
    const stEl = $("radarStatus");
    stEl.textContent = msgs.join(" ");
    stEl.className = "radar-status" + ((statusKind === "err" && !f) || msgs.some((m) => /failed|delayed|Couldn't/.test(m)) ? " warn" : "");
    if (toolStatus) toolStatus.textContent = st.on ? stEl.textContent : "";
  }

  // ---------- Tools section ----------
  let toggle = null, toolStatus = null;
  if (T) {
    const el = T.addSection({ id: "toolRadar", title: "🌧 Weather radar", order: 15 });
    el.innerHTML = `
      <label class="tool-check"><input type="checkbox" id="radarToggle" aria-label="Show live weather radar with a 6-hour loop" /> Show live radar (6-hour loop)</label>
      <p class="tool-note" id="radarToolStatus" aria-live="polite"></p>
      <p class="tool-note">NEXRAD base reflectivity mosaic from the <a href="https://mesonet.agron.iastate.edu/ogc/" target="_blank" rel="noopener">Iowa Environmental Mesonet</a> (Iowa State University; public domain). Frame times come from IEM; the newest refreshes every 5 minutes. Needs an internet connection.</p>`;
    toggle = el.querySelector("#radarToggle");
    toolStatus = el.querySelector("#radarToolStatus");
    toggle.onchange = () => { enable(toggle.checked); if (toggle.checked && innerWidth < 800) T.open(false); };
  }
  window.addEventListener("offline", () => { if (st.on) { play(false); setStatus("Offline — radar paused; frames shown may be out of date.", "err"); ui(); } });
  window.addEventListener("online", () => { if (st.on) sync(); });
  window.mfaRadar = { enable, play, show, state: () => ({ on: st.on, idx: st.idx, playing: st.playing, latest: st.latest, frames: st.frames.map((f) => ({ t: f.t, k: f.k, err: f.err, loading: f.loading })) }), sync };
})();
