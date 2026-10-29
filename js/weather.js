/* Feature 4a — Weather & wind for the selected lake, from the National Weather Service
 * API (api.weather.gov, public domain, CORS-enabled).
 *   /points/{lat},{lon} -> forecastHourly + observationStations
 *   nearest station -> /stations/{id}/observations/latest
 * Only values returned by NWS are shown; anything missing is shown as "—" and any
 * failure says the data is unavailable. Browsers do not let a page set its own
 * User-Agent header, so requests carry the browser's normal User-Agent. */
(function () {
  "use strict";
  const M = window.__mfa, T = window.mfaTools;
  if (!M || !T) return;
  const esc = M.escapeHtml;
  const API = "https://api.weather.gov";
  const TTL = 10 * 60 * 1000; // re-use results for 10 minutes per lake
  const OBS_MAX_AGE = 2 * 3600 * 1000; // try the next station if the nearest has nothing this recent
  const cache = new Map();

  async function getJSON(url, signal) {
    const r = await fetch(url, { headers: { Accept: "application/geo+json" }, signal });
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j.detail || j.title || ""; } catch (_) {}
      throw new Error(`NWS ${r.status}${detail ? ": " + detail : ""}`);
    }
    return r.json();
  }
  const R = 6371008.8, rad = Math.PI / 180;
  function distM(a1, o1, a2, o2) {
    const h = Math.sin(((a2 - a1) * rad) / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(((o2 - o1) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  // NWS observation units -> mph / °F (only converting, never estimating)
  function toMph(q) {
    if (!q || q.value == null) return null;
    const u = q.unitCode || "";
    if (u.endsWith("km_h-1")) return q.value * 0.621371;
    if (u.endsWith("m_s-1")) return q.value * 2.23694;
    if (u.endsWith("kt") || u.endsWith("knot")) return q.value * 1.15078;
    return null;
  }
  function toF(q) {
    if (!q || q.value == null) return null;
    const u = q.unitCode || "";
    if (u.endsWith("degC")) return q.value * 9 / 5 + 32;
    if (u.endsWith("degF")) return q.value;
    return null;
  }
  const tfmt = (d, withDay) => new Date(d).toLocaleString([], { ...(withDay ? { weekday: "short" } : {}), hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const hfmt = (d) => new Date(d).toLocaleTimeString([], { hour: "numeric" });
  function ago(ms) { const m = Math.round(ms / 60000); return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; }

  async function load(lat, lng, signal) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.data;
    const pt = await getJSON(`${API}/points/${lat.toFixed(4)},${lng.toFixed(4)}`, signal);
    const P = pt.properties || {};
    const out = { point: P, obs: null, obsErr: null, hourly: null, hourlyErr: null, fetched: Date.now() };
    const obsP = (async () => {
      const st = await getJSON(P.observationStations + "?limit=10", signal);
      const stations = (st.features || []).map((f) => ({
        id: f.properties.stationIdentifier, name: f.properties.name,
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        d: distM(lat, lng, f.geometry.coordinates[1], f.geometry.coordinates[0]),
      })).sort((a, b) => a.d - b.d);
      if (!stations.length) throw new Error("no observation stations listed");
      for (const s of stations.slice(0, 3)) {
        try {
          const o = await getJSON(`${API}/stations/${encodeURIComponent(s.id)}/observations/latest`, signal);
          const p = o.properties || {};
          const t = Date.parse(p.timestamp);
          if (!Number.isFinite(t) || Date.now() - t > OBS_MAX_AGE) continue;
          if (p.windSpeed == null || p.windSpeed.value == null) continue;
          return { station: s, p, t };
        } catch (e) { if (e.name === "AbortError") throw e; }
      }
      throw new Error("no recent wind observation from the 3 nearest stations");
    })().then((v) => { out.obs = v; }, (e) => { if (e.name === "AbortError") throw e; out.obsErr = e.message; });
    const hourP = getJSON(P.forecastHourly + (P.forecastHourly.includes("?") ? "&" : "?") + "units=us", signal)
      .then((h) => { out.hourly = h.properties; }, (e) => { if (e.name === "AbortError") throw e; out.hourlyErr = e.message; });
    await Promise.all([obsP, hourP]);
    cache.set(key, { at: Date.now(), data: out });
    return out;
  }

  function arrow(deg) {
    // Arrow points the way the wind is blowing TO (from-direction + 180°).
    return `<span class="wx-arrow" style="transform:rotate(${(deg + 180) % 360}deg)" aria-hidden="true">↑</span>`;
  }
  function render(body, lake, d, summary) {
    const P = d.point, rel = P.relativeLocation && P.relativeLocation.properties;
    let h = "";
    if (d.obs) {
      const p = d.obs.p, s = d.obs.station;
      const w = toMph(p.windSpeed), g = toMph(p.windGust), dir = p.windDirection && p.windDirection.value, tf = toF(p.temperature);
      const calm = w != null && w < 0.5;
      h += `<div class="wx-now" data-wx="obs">
        <div class="wx-wind"><b>Wind</b> ${calm ? "Calm" : `${w.toFixed(0)} mph`}${!calm && dir != null ? ` from ${compass(dir)} (${Math.round(dir)}°) ${arrow(dir)}` : !calm ? " (direction not reported)" : ""}${g != null ? ` · gusts ${g.toFixed(0)} mph` : ""}</div>
        <div>${tf != null ? `${tf.toFixed(0)}°F` : "Temp —"}${p.textDescription ? ` · ${esc(p.textDescription)}` : ""}</div>
        <div class="sec-src">Observed ${esc(tfmt(d.obs.t))} (${ago(Date.now() - d.obs.t)}) at ${esc(s.name)} (${esc(s.id)}), ${(s.d / 1609.344).toFixed(1)} mi from the lake.</div>
      </div>`;
    } else {
      h += `<p class="sec-unavail" data-wx="obs-unavail">Current conditions unavailable (${esc(d.obsErr || "no data")}).</p>`;
    }
    if (d.hourly && Array.isArray(d.hourly.periods) && d.hourly.periods.length) {
      const now = Date.now();
      const rows = d.hourly.periods.filter((x) => Date.parse(x.endTime) > now).slice(0, 12);
      h += `<table class="wx-hourly" aria-label="Hourly forecast"><thead><tr><th>Time</th><th>Temp</th><th>Wind</th><th>Rain</th><th></th></tr></thead><tbody>` +
        rows.map((x) => {
          const pop = x.probabilityOfPrecipitation && x.probabilityOfPrecipitation.value;
          return `<tr><td>${esc(hfmt(x.startTime))}</td><td>${x.temperature != null ? esc(x.temperature) + "°" + esc(x.temperatureUnit || "") : "—"}</td><td>${esc(x.windSpeed || "—")} ${esc(x.windDirection || "")}</td><td>${pop != null ? esc(pop) + "%" : "—"}</td><td>${esc(x.shortForecast || "")}</td></tr>`;
        }).join("") + `</tbody></table>`;
      const upd = d.hourly.updateTime || d.hourly.updated || d.hourly.generatedAt;
      h += `<div class="sec-src">Hourly forecast for NWS grid ${esc(P.gridId)} ${esc(P.gridX)},${esc(P.gridY)}${rel ? ` (near ${esc(rel.city)}, ${esc(rel.state)})` : ""}${upd ? `, updated ${esc(tfmt(upd, true))}` : ""}.</div>`;
    } else {
      h += `<p class="sec-unavail" data-wx="hourly-unavail">Hourly forecast unavailable (${esc(d.hourlyErr || "no data")}).</p>`;
    }
    h += `<div class="sec-src">Source: National Weather Service, <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noopener">api.weather.gov</a> · fetched ${esc(tfmt(d.fetched))} · <a href="https://forecast.weather.gov/MapClick.php?lat=${lake.lat.toFixed(4)}&lon=${lake.lng.toFixed(4)}" target="_blank" rel="noopener">Full NWS forecast</a></div>`;
    h += `<div class="tool-row"><button type="button" class="tool-btn" data-wx="radar" aria-label="Show the weather radar loop on the map">🌧 Show radar loop</button>
          <button type="button" class="tool-btn" data-wx="refresh" aria-label="Refresh weather">↻ Refresh</button></div>`;
    body.innerHTML = h;
    if (summary) {
      let t = "🌤 Weather & wind (NWS)";
      if (d.obs) {
        const w = toMph(d.obs.p.windSpeed), dir = d.obs.p.windDirection && d.obs.p.windDirection.value;
        t = `🌤 Wind ${w < 0.5 ? "calm" : w.toFixed(0) + " mph" + (dir != null ? " " + compass(dir) : "")} · NWS`;
      }
      summary.textContent = t;
    }
    wireButtons(body, lake, summary);
  }
  function wireButtons(body, lake, summary) {
    const rb = body.querySelector('[data-wx="radar"]');
    if (rb) rb.onclick = () => { if (window.mfaRadar) { window.mfaRadar.enable(true); const c = document.getElementById("lakeCard"); if (c && innerWidth < 800) c.classList.add("hidden"); } };
    const fb = body.querySelector('[data-wx="refresh"]');
    if (fb) fb.onclick = () => { cache.clear(); show(body, lake, summary); };
  }
  let ctl = null;
  async function show(body, lake, summary) {
    if (ctl) ctl.abort();
    const my = (ctl = new AbortController());
    body.innerHTML = `<p class="tool-note" data-wx="loading">Loading NWS weather…</p>`;
    if (!navigator.onLine) {
      body.innerHTML = `<p class="sec-unavail" data-wx="unavail">Weather unavailable — you're offline.</p>`;
      if (summary) summary.textContent = "🌤 Weather & wind (offline)";
      return;
    }
    try {
      const d = await load(lake.lat, lake.lng, my.signal);
      if (my.signal.aborted || !body.isConnected) return;
      render(body, lake, d, summary);
      api.last = d;
    } catch (e) {
      if (e.name === "AbortError" || !body.isConnected) return;
      body.innerHTML = `<p class="sec-unavail" data-wx="unavail">Weather unavailable right now (${esc(e.message || "network error")}). No values are shown rather than guesses.</p>
        <div class="sec-src">Source: National Weather Service api.weather.gov</div>
        <div class="tool-row"><button type="button" class="tool-btn" data-wx="refresh" aria-label="Retry loading weather">↻ Retry</button></div>`;
      wireButtons(body, lake, summary);
      if (summary) summary.textContent = "🌤 Weather & wind (unavailable)";
    }
  }
  document.addEventListener("mfa:lakecard", (e) => {
    const lake = e.detail.lake;
    if (!lake || !Number.isFinite(lake.lat) || !Number.isFinite(lake.lng)) return;
    const { body, summary } = T.cardSection(e.detail.extras, { id: "secWeather", title: "🌤 Weather & wind (NWS)", order: 10, open: innerWidth >= 800 });
    show(body, lake, summary);
  });
  const api = { last: null, compass, toMph, clearCache: () => cache.clear() };
  window.mfaWeather = api;
})();
