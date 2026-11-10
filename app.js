/* Mike's Fishing App — Indiana & Michigan boat launches and lake depth maps */
(function () {
  "use strict";

  const MAX_ZOOM = 22;
  // Default view stays on NE Indiana. Bounds cover Indiana and Michigan so northern lakes are reachable.
  const NE_CENTER = [41.0, -85.4];
  const NE_ZOOM = 9;
  const STATE_BOUNDS = L.latLngBounds([37.7, -90.6], [48.35, -82.1]);

  const map = L.map("map", {
    center: NE_CENTER,
    zoom: NE_ZOOM,
    maxZoom: MAX_ZOOM,
    minZoom: 6,
    zoomControl: false,
    attributionControl: true,
    maxBounds: STATE_BOUNDS.pad(0.35),
    maxBoundsViscosity: 0.4,
  });
  // Drop Leaflet's default "Leaflet" prefix link (flag + leafletjs.com); provider credits stay.
  map.attributionControl.setPrefix(false);
  // Bottom-left: zoom buttons must not sit under the depth/launch legend.
  L.control.zoom({ position: "bottomleft" }).addTo(map);

  // Dedicated high pane for boat launches (above contours/overlays)
  if (!map.getPane("launchesPane")) {
    map.createPane("launchesPane");
    map.getPane("launchesPane").style.zIndex = 650; // markers=600, tooltip=650, popup=700
  }

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: MAX_ZOOM,
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });

  // Esri World Imagery — free, no API key (attribution required)
  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 19,
      attribution:
        "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    }
  );
  // USGS The National Map basemaps — public domain, no usage restrictions
  // (USGS asks for attribution). Used for "Save lake for offline" because the
  // OSM tile policy forbids bulk downloading and Esri imagery terms do not allow
  // offline caching without a license. Native tiles exist to zoom 16.
  const USGS_ATTR = 'Map services and data available from <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">U.S. Geological Survey, National Geospatial Program</a>';
  const usgsTopo = L.tileLayer(
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: MAX_ZOOM, maxNativeZoom: 16, attribution: USGS_ATTR }
  );
  const usgsImagery = L.tileLayer(
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: MAX_ZOOM, maxNativeZoom: 16, attribution: USGS_ATTR }
  );
  const BASEMAPS = {
    street: { layer: osm, label: "Street (OpenStreetMap)" },
    sat: { layer: sat, label: "Satellite (Esri)" },
    usgsTopo: { layer: usgsTopo, label: "USGS Topo (works offline)" },
    usgsImagery: { layer: usgsImagery, label: "USGS Imagery (works offline)" },
  };
  osm.addTo(map);

  let basemap = "street";
  function setBasemap(name, quiet) {
    if (!BASEMAPS[name] || name === basemap) return basemap;
    map.removeLayer(BASEMAPS[basemap].layer);
    BASEMAPS[name].layer.addTo(map);
    basemap = name;
    if (!quiet) toast(BASEMAPS[name].label.replace(/ \(.*\)$/, "") + " basemap");
    document.dispatchEvent(new CustomEvent("mfa:basemap", { detail: { name } }));
    return basemap;
  }
  // Basemap switching lives in Tools > Basemap & offline maps (no duplicate header button).


  // Depth colour ramp, shallow -> deep. Dark enough that 0–20 ft lines read on light
  // water (OSM / USGS Topo); on imagery basemaps a light halo is drawn under the lines.
  // The legend ramp is built from these same stops (see applyLegendRamp).
  const DEPTH_STOPS = [
    [0, [0, 119, 194]],   // strong blue
    [20, [31, 79, 192]],  // royal blue
    [40, [58, 47, 168]],  // indigo
    [60, [82, 30, 140]],  // violet
    [80, [52, 10, 86]],   // deep purple (80+)
  ];
  const DEPTH_MAX = 80;
  function depthColor(ft) {
    if (ft == null) return "#1f6fc0";
    const d = Math.max(0, Math.min(DEPTH_MAX, +ft || 0));
    for (let i = 1; i < DEPTH_STOPS.length; i++) {
      const [d1, c1] = DEPTH_STOPS[i];
      if (d <= d1) {
        const [d0, c0] = DEPTH_STOPS[i - 1];
        const t = (d - d0) / (d1 - d0);
        const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    const c = DEPTH_STOPS[DEPTH_STOPS.length - 1][1];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function applyLegendRamp() {
    const el = document.querySelector("#legend .ramp");
    if (!el) return;
    const stops = DEPTH_STOPS.map(([d, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${Math.round((d / DEPTH_MAX) * 100)}%`);
    el.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  }
  applyLegendRamp();

  let lakes = [];
  let contourLayer = null;
  let labelLayer = null;
  let lakeMarkers = L.layerGroup().addTo(map);
  let selectedLake = null;
  let wakeLock = null;
  let launches = [];
  let launchCluster = null;
  // Off at statewide / county zoom; auto-on at lake-level zoom (see LAKE_ZOOM).
  // Manual canoe toggle still works; next zoomend re-syncs to zoom policy.
  let launchesVisible = false;
  let _launchZoomBand = null;
  const LAKE_ZOOM = 13; // fitBounds maxZoom is 15; contours detail ~11+

  const ACCESS_COLORS = {
    public: { fill: "#1a7f4b", stroke: "#0e4d2c" },
    private: { fill: "#d97706", stroke: "#92400e" },
    unknown: { fill: "#6b7280", stroke: "#374151" },
  };

const MPS_PER_MPH = 0.44704;
const EARTH_M = 6371000;

function trollDistM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function median(nums) {
  const a = nums.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function createTrollSpeedFilter(options) {
  const opt = options || {};
  const stationaryMph = opt.stationaryMph != null ? opt.stationaryMph : 0.5;
  const STATIONARY_MPS = stationaryMph * MPS_PER_MPH;
  const MAX_ACC_M = opt.maxAccM != null ? opt.maxAccM : 25;
  const STALE_MS = opt.staleMs != null ? opt.staleMs : 5000;
  const LAG_MS = opt.lagMs != null ? opt.lagMs : 8000;
  const TAU_S = opt.tauS != null ? opt.tauS : 4;
  const JUMP_M = opt.jumpM != null ? opt.jumpM : 25;
  const BUBBLE_M = opt.bubbleM != null ? opt.bubbleM : null; // set from accuracy if null
  const SETTLE_MS = opt.settleMs != null ? opt.settleMs : 4000;
  const MAX_DERIVED_MPS = 25 * MPS_PER_MPH;

  function clipDerived(v) {
    if (v == null || !Number.isFinite(v)) return null;
    if (v < STATIONARY_MPS) return 0;
    // A short GPS jump can look like hundreds of mph. Don't show that.
    if (v > MAX_DERIVED_MPS) return null;
    return v;
  }

  function centroid(arr) {
    let lat = 0, lng = 0, tt = 0;
    for (const p of arr) { lat += p.lat; lng += p.lng; tt += p.t; }
    const n = arr.length;
    return { lat: lat / n, lng: lng / n, t: tt / n };
  }

  let ema = null;
  let emaHist = [];
  let rawHist = [];
  let posHist = [];
  let first = null;
  let anchor = null;
  let anchorSettled = false;
  let shownMps = null;
  let lastUsedT = 0;
  let stopped = true;
  let stopCount = 0;

  function reset() {
    ema = null;
    emaHist = [];
    rawHist = [];
    posHist = [];
    first = null;
    anchor = null;
    anchorSettled = false;
    shownMps = null;
    lastUsedT = 0;
    stopped = true;
    stopCount = 0;
  }

  function posSpeedMps(now) {
    if (!ema) return null;
    let old = null;
    for (let i = 0; i < emaHist.length; i++) {
      if (now - emaHist[i].t >= LAG_MS) old = emaHist[i];
    }
    if (!old) return null;
    const dt = (ema.t - old.t) / 1000;
    if (dt < LAG_MS / 1000 - 0.75) return null;
    return trollDistM(old, ema) / dt;
  }

  function medianPos(now) {
    const v = posSpeedMps(now);
    if (v != null) {
      posHist.push({ t: now, v });
      posHist = posHist.filter((p) => now - p.t <= 12000);
    }
    return median(posHist.map((p) => p.v));
  }

  function push(fix, now) {
    if (now == null) now = fix.t;
    const acc = fix.acc;
    const poor = acc != null && Number.isFinite(acc) && acc > MAX_ACC_M;
    if (poor || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) {
      return shownMps;
    }

    const pt = { lat: fix.lat, lng: fix.lng, t: fix.t != null ? fix.t : now, acc: acc };
    lastUsedT = now;
    rawHist.push(pt);
    rawHist = rawHist.filter((p) => now - p.t <= 20000);
    if (!first) first = pt;
    if (!anchor) anchor = { lat: pt.lat, lng: pt.lng, t: pt.t };

    if (!ema) {
      ema = { lat: pt.lat, lng: pt.lng, t: pt.t };
    } else {
      const dt = (pt.t - ema.t) / 1000;
      if (dt > 0) {
        const a = 1 - Math.exp(-Math.min(dt, 10) / TAU_S);
        ema = {
          lat: a * pt.lat + (1 - a) * ema.lat,
          lng: a * pt.lng + (1 - a) * ema.lng,
          t: pt.t,
        };
      } else {
        ema.t = pt.t;
      }
    }
    emaHist.push({ lat: ema.lat, lng: ema.lng, t: ema.t });
    emaHist = emaHist.filter((e) => now - e.t <= 20000);

    if (!anchorSettled && stopped && first && now - first.t >= SETTLE_MS) {
      const win = rawHist.filter((p) => p.t <= first.t + SETTLE_MS);
      if (win.length) anchor = centroid(win);
      else if (ema) anchor = { lat: ema.lat, lng: ema.lng, t: ema.t };
      anchorSettled = true;
    }

    const gps =
      fix.spd != null && Number.isFinite(fix.spd) && fix.spd >= 0 ? fix.spd : null;
    const pos = medianPos(now);
    const jumped = anchor ? trollDistM(anchor, pt) >= JUMP_M : false;
    const accRef = acc != null && Number.isFinite(acc) ? acc : 10;
    const bubbleM = BUBBLE_M != null ? BUBBLE_M : Math.max(10, accRef);
    const leftBubble = anchor && ema && trollDistM(anchor, ema) >= bubbleM;
    const lagS = LAG_MS / 1000;
    const observed = pos != null ? pos * lagS : null;
    const highGps = gps != null && gps > 2.2 * MPS_PER_MPH;
    const posReady = pos != null && posHist.length >= 3;

    let raw = null;
    if (gps != null && gps < STATIONARY_MPS) {
      raw = 0;
    } else if (jumped && gps != null && gps < 25 * MPS_PER_MPH) {
      // A large move before the window fills: trust a boat-range GPS speed
      // (t.py's 3.0 mph steps, but not a 60 mph jitter spike).
      raw = gps;
    } else if (gps != null && highGps) {
      // 3.7 mph while sitting still: only trust this if the smoothed path
      // has left the sit-bubble and moved at least half as fast.
      raw = posReady && leftBubble && pos >= gps * 0.5 ? gps : 0;
    } else if (gps != null) {
      if (pos == null && !jumped) raw = 0;
      else if (pos != null && pos < STATIONARY_MPS) raw = 0;
      else raw = gps;
    } else if (pos != null) {
      const use = observed >= Math.max(6, accRef * 0.75) ? clipDerived(pos) : 0;
      raw = use;
    } else if (jumped) {
      // Only derive a speed from a jump after a couple of seconds, and
      // only if it is in boat range. A 0.5 s 100 m hop is a GPS jump,
      // not a 400 mph boat. If rejected, keep the last good reading.
      const dt = (pt.t - (anchor ? anchor.t : first.t)) / 1000;
      const derived = dt >= 2 ? clipDerived(trollDistM(anchor || first, pt) / dt) : null;
      raw = derived != null ? derived : null;
    }

    if (raw == null) return shownMps;

    if (raw < STATIONARY_MPS) {
      stopCount += 1;
      if (stopped || stopCount >= 3) {
        if (!stopped && ema) {
          anchor = { lat: ema.lat, lng: ema.lng, t: ema.t };
          anchorSettled = true;
        }
        stopped = true;
        shownMps = shownMps == null && stopCount < 1 ? null : 0;
        if (stopped) shownMps = 0;
        return shownMps;
      }
      // Brief dip while moving: keep the last reading.
      return shownMps;
    }

    stopCount = 0;
    if (stopped) {
      stopped = false;
      shownMps = raw;
    } else {
      shownMps = 0.55 * raw + 0.45 * shownMps;
      if (shownMps < STATIONARY_MPS) {
        stopped = true;
        shownMps = 0;
      }
    }
    return shownMps;
  }

  function tick(now) {
    if (now == null) now = Date.now();
    if (shownMps == null) return null;
    if (lastUsedT && now - lastUsedT >= STALE_MS) {
      if (!stopped && ema) {
        anchor = { lat: ema.lat, lng: ema.lng, t: ema.t };
        anchorSettled = true;
      }
      stopped = true;
      shownMps = 0;
    }
    return shownMps;
  }

  function mph() {
    return shownMps == null ? null : shownMps / MPS_PER_MPH;
  }

  return { push, tick, reset, value: () => shownMps, mph, trollDistM };
}


  window.createTrollSpeedFilter = createTrollSpeedFilter;

  // Trolling state
  const troll = {
    on: false,
    follow: true,
    watchId: null,
    headingWatch: null,
    lat: null,
    lng: null,
    heading: null,
    speedMph: null,
    track: [],
    boatMarker: null,
    trackLine: null,
    speedFilter: createTrollSpeedFilter(),
    _speedTimer: null,
  };

  function toast(msg, ms = 2200) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), ms);
  }

  function haversineM(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function distPointToSegM(p, a, b) {
    // Approximate local meters for nearest-contour
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((p[0] * Math.PI) / 180);
    const px = (p[1] - a[1]) * mPerDegLon;
    const py = (p[0] - a[0]) * mPerDegLat;
    const bx = (b[1] - a[1]) * mPerDegLon;
    const by = (b[0] - a[0]) * mPerDegLat;
    const len2 = bx * bx + by * by;
    let t = len2 ? (px * bx + py * by) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = t * bx;
    const cy = t * by;
    return Math.hypot(px - cx, py - cy);
  }

  function nearestContourDepth(lat, lng) {
    if (!contourLayer) return null;
    let best = null;
    let bestD = Infinity;
    const p = [lat, lng];
    contourLayer.eachLayer((layer) => {
      const latlngs = layer.getLatLngs();
      const fp = layer.feature && layer.feature.properties;
      const depth = fp && fp.depth_ft;
      if (depth == null || depth <= 0) return;
      const lk = lakeById(fp.lake_id);
      if (!lk || !lk.has_contours || lk.no_depth_map) return;
      if (/distance_from_shore/.test(fp.depth_assignment || lk.depth_assignment || "")) return;
      const rings = Array.isArray(latlngs[0]) && typeof latlngs[0][0] !== "number"
        ? (Array.isArray(latlngs[0][0]) ? latlngs.flat() : latlngs)
        : [latlngs];
      for (const line of rings) {
        const pts = [];
        for (const ll of line) {
          if (!ll) continue;
          if (ll.lat != null && ll.lng != null && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
            pts.push([ll.lat, ll.lng]);
          } else if (Array.isArray(ll) && Number.isFinite(+ll[0]) && Number.isFinite(+ll[1])) {
            pts.push([+ll[0], +ll[1]]);
          }
        }
        for (let i = 0; i < pts.length - 1; i++) {
          const d = distPointToSegM(p, pts[i], pts[i + 1]);
          if (d < bestD) {
            bestD = d;
            best = { depth, distM: d, lakeId: fp.lake_id };
          }
        }
      }
    });
    // Only report if within ~80 m of a contour (honest proximity)
    if (!best || best.distM > 80) return null;
    return best;
  }

  function lakeById(id) {
    if (!lakeById._m || lakeById._n !== lakes.length) {
      lakeById._m = new Map(lakes.map((l) => [l.id, l]));
      lakeById._n = lakes.length;
    }
    return lakeById._m.get(id);
  }

  // Plain-language source for a lake's contour depths.
  function depthSourceLabel(lk) {
    if (!lk) return "";
    const yr = (String(lk.source || "").match(/\b(1[89]\d\d|20\d\d)\b/) || [])[1];
    switch (lk.contour_method) {
      case "vector_featureserver":
        return (lk.state === "MI") ? "Michigan DNR Inland Lake Contours" : "DNR survey";
      case "traced_from_pdf":
        return "DNR map (traced)";
      case "raster_color_band_trace":
        return "DNR map (traced, approx.)";
      case "historical_trace":
        return `${yr ? yr + " " : ""}historic map (unofficial)`;
      case "lidar_dem_contour":
        return "USGS lidar (unofficial)";
      case "dnr_paper_map_fitted":
        return "Michigan DNR lake map (hand-drawn), fitted to shoreline";
      default:
        return "unofficial";
    }
  }

  function normSearch(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  // Common misspellings / aliases so "silvan" finds Sylvan Lake, etc.
  const SEARCH_ALIASES = {
    silvan: "sylvan",
    silvon: "sylvan",
    sylvn: "sylvan",
    shipshewanna: "shipshewana",
    tippecano: "tippecanoe",
  };

  function expandSearchToken(tok) {
    const t = SEARCH_ALIASES[tok] || tok;
    return t;
  }

  function tokenFuzzyIn(hay, tok) {
    if (!tok) return true;
    if (hay.includes(tok)) return true;
    // Allow one-char typo for tokens length >= 5 (silvan ↔ sylvan)
    if (tok.length >= 5) {
      const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
      for (const w of words) {
        if (Math.abs(w.length - tok.length) > 1) continue;
        let i = 0, j = 0, miss = 0;
        while (i < w.length && j < tok.length) {
          if (w[i] === tok[j]) { i++; j++; continue; }
          miss++;
          if (miss > 1) break;
          if (w.length > tok.length) i++;
          else if (tok.length > w.length) j++;
          else { i++; j++; }
        }
        miss += w.length - i + tok.length - j;
        if (miss <= 1) return true;
      }
    }
    return false;
  }

  function lakeMatchesQuery(l, q) {
    if (!q) return true;
    const name = normSearch(l.name);
    const county = normSearch(l.county);
    const county2 = normSearch(l.county2);
    const state = lakeStateName(l).toLowerCase();
    const hay = `${name} ${county} ${county2} ${state} ${normSearch(l.state)}`.trim();
    return q.split(/\s+/).every((tok) => {
      const t = expandSearchToken(tok);
      return tokenFuzzyIn(hay, t) || tokenFuzzyIn(hay, tok);
    });
  }

  let countyFilter = null;
  let stateFilter = null; // "IN" | "MI" | null
  let sortNear = null; // {lat, lng} after Locate

  function lakeState(l) {
    const s = String((l && l.state) || "IN").toUpperCase();
    return s === "MI" ? "MI" : "IN";
  }
  function lakeStateName(l) {
    return lakeState(l) === "MI" ? "Michigan" : "Indiana";
  }

  function filteredLakes() {
    const q = normSearch(document.getElementById("lakeSearch").value);
    const showC = document.getElementById("filterContours").checked;
    const showP = document.getElementById("filterPdf").checked;
    const list = lakes.filter((l) => {
        if (l.has_contours && !showC) return false;
        if (!l.has_contours && !showP) return false;
        if (stateFilter && lakeState(l) !== stateFilter) return false;
        if (countyFilter && l.county !== countyFilter && l.county2 !== countyFilter) return false;
        return lakeMatchesQuery(l, q);
      });
    if (sortNear && sortNear.lat != null) {
      list.sort((a, b) => {
        const da = a.lat != null ? haversineM([sortNear.lat, sortNear.lng], [a.lat, a.lng]) : Infinity;
        const db = b.lat != null ? haversineM([sortNear.lat, sortNear.lng], [b.lat, b.lng]) : Infinity;
        return da - db;
      });
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  }


  // Never show internal QC notes (strict.py, file paths, ICP, overlay filenames).
  const QC_NOTE = /strict\.py|strict_multi|check\/|h54\/|\.(png|jpg|json)\b|ICP |fit_iou|water_iou|frac_inside|IoU=|overlay check/i;
  function publicReviewNote(lake) {
    if (!lake || !lake.needs_review) return "";
    const t = String(lake.review_notes || "").trim();
    if (t && !QC_NOTE.test(t)) return t;
    return "These contours still need a position or depth check. Depths are not a substitute for sonar.";
  }


  function allCounties() {
    const set = new Set();
    for (const l of lakes) {
      if (stateFilter && lakeState(l) !== stateFilter) continue;
      if (l.county) set.add(l.county);
      if (l.county2) set.add(l.county2);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }
  function renderCountyChips() {
    const el = document.getElementById("countyChips");
    if (!el) return;
    el.innerHTML = "";
    const mk = (label, { pressed, disabled, onClick, title }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "county-chip";
      b.textContent = label;
      b.setAttribute("aria-pressed", pressed ? "true" : "false");
      if (title) b.title = title;
      if (disabled) b.disabled = true;
      b.addEventListener("click", onClick);
      el.appendChild(b);
      return b;
    };
    mk("All", { pressed: !countyFilter && !stateFilter && !sortNear, onClick: () => { countyFilter = null; stateFilter = null; sortNear = null; renderCountyChips(); renderLakeList(); } });
    mk("Nearest to me", {
      pressed: !!sortNear,
      disabled: !sortNear && !(window.__mfaLastFix),
      title: "Sort the list by distance from your location",
      onClick: () => {
        const fix = window.__mfaLastFix;
        if (!fix) return;
        sortNear = { lat: fix.lat, lng: fix.lng };
        countyFilter = null;
        stateFilter = null;
        renderCountyChips();
        renderLakeList();
      }
    });
    mk("Indiana", { pressed: stateFilter === "IN" && !sortNear, onClick: () => { stateFilter = stateFilter === "IN" ? null : "IN"; countyFilter = null; sortNear = null; renderCountyChips(); renderLakeList(); } });
    mk("Michigan", { pressed: stateFilter === "MI" && !sortNear, onClick: () => { stateFilter = stateFilter === "MI" ? null : "MI"; countyFilter = null; sortNear = null; renderCountyChips(); renderLakeList(); } });
    if (stateFilter) {
      for (const c of allCounties()) {
        mk(c, { pressed: countyFilter === c, onClick: () => { countyFilter = countyFilter === c ? null : c; sortNear = null; renderCountyChips(); renderLakeList(); } });
      }
    }
  }

  function renderLakeList() {
    const ul = document.getElementById("lakeList");
    ul.innerHTML = "";
    const filtered = filteredLakes();

    for (const l of filtered) {
      const li = document.createElement("li");
      let badge;
      if (l.retrace_pending)
        badge = '<span class="badge nomap">Re-tracing depths</span>';
      else if (l.no_depth_map)
        badge = '<span class="badge nomap">No depth map yet</span>';
      else if (l.georef_method === "synthetic" || l.contour_method === "synthetic_or_distance_based")
        badge = '<span class="badge review-high">Approx. contours</span>';
      else if (l.needs_review && l.review_priority === "high")
        badge = '<span class="badge review-high">Needs review</span>';
      else if (l.needs_review)
        badge = '<span class="badge review">Needs review</span>';
      else if (l.has_contours) badge = l.contour_method === "lidar_dem_contour" ? '<span class="badge contour">lidar contours</span>' : '<span class="badge contour">contours</span>';
      else badge = '<span class="badge pdf">PDF map</span>';
      const depth =
        l.max_depth_ft != null ? ` · max ${l.max_depth_ft} ft`
          : l.max_contour_ft != null ? ` · max ≥${l.max_contour_ft} ft` : "";
      const acres = l.acres != null ? ` · ${l.acres} ac`
        : Array.isArray(l.acres_range) ? ` · ~${l.acres_range[0]}–${l.acres_range[1]} ac` : "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lake-row";
      btn.innerHTML = `<div class="name">${l.name}${badge}</div>
        <div class="meta">${l.county || "—"}, ${lakeStateName(l)}${acres}${depth}</div>`;
      btn.addEventListener("click", () => selectLake(l, true));
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function openPanel(open) {
    document.getElementById("panel").classList.toggle("hidden", !open);
    if (open) {
      const input = document.getElementById("lakeSearch");
      // Defer focus so it works after display:none → visible on mobile
      requestAnimationFrame(() => {
        try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
      });
    }
  }

  function goToTopSearchMatch() {
    const matches = filteredLakes();
    if (!matches.length) {
      toast("No lakes match");
      return false;
    }
    selectLake(matches[0], true);
    toast(matches[0].name);
    return true;
  }

  function closeLakeTooltips() {
    if (lakeMarkers) lakeMarkers.eachLayer((m) => { if (m.closeTooltip) m.closeTooltip(); });
  }
  const HOME_TITLE = "Indiana & Michigan lake depth maps and boat launches | Mike's Fishing App";
  const HOME_CANONICAL = "https://mikesfishingapp.com/";
  function countyPlaceName(county) {
    if (!county) return "";
    if (/\(|\bcounty\b/i.test(county)) return county;
    return county + " County";
  }
  function syncDocumentSeo(lake) {
    const link = document.querySelector('link[rel="canonical"]');
    if (lake && lake.id) {
      const st = lakeStateName(lake);
      const place = countyPlaceName(lake.county) || st;
      const noMap = lake.no_depth_map || !lake.has_contours;
      const unofficial = /unofficial/i.test((lake.accuracy_note || "") + " " + (lake.source || ""))
        || lake.contour_method === "lidar_dem_contour";
      document.title = noMap
        ? (lake.name + " — no depth map yet | " + place + ", " + st)
        : unofficial
          ? (lake.name + " depth map (unofficial) | " + place + ", " + st)
          : (lake.name + " depth map | " + place + ", " + st);
      if (link) link.setAttribute("href", "https://mikesfishingapp.com/lakes/" + encodeURIComponent(lake.id) + "/");
    } else {
      document.title = HOME_TITLE;
      if (link) link.setAttribute("href", HOME_CANONICAL);
    }
  }
  function syncLakeUrl(lake) {
    const url = new URL(location.href);
    if (lake && lake.id) url.searchParams.set("lake", lake.id);
    else url.searchParams.delete("lake");
    const next = url.pathname + url.search + url.hash;
    const cur = location.pathname + location.search + location.hash;
    if (next !== cur) history.replaceState({ lakeId: lake && lake.id }, "", next);
    syncDocumentSeo(lake);
  }
  function applyLakeFromUrl() {
    const id = new URLSearchParams(location.search).get("lake");
    if (!id) { syncDocumentSeo(null); return false; }
    const l = lakeById(id);
    if (l) { selectLake(l, true); return true; }
    return false;
  }
  function applySearchFromUrl() {
    const q = new URLSearchParams(location.search).get("q");
    if (q == null || q === "") return false;
    const input = document.getElementById("lakeSearch");
    if (input) input.value = q;
    openPanel(true);
    renderLakeList();
    return true;
  }
  function selectLake(lake, fly) {
    selectedLake = lake;
    closeLakeTooltips();
    showLakeCard(lake);
    openPanel(false);
    closeLakeTooltips();
    syncLakeUrl(lake);
    if (lake.has_contours) ensureLakeContours(lake.id);
    if ((lake.has_contours || lake.no_depth_map) && lake.bbox) {
      const b = lake.bbox;
      if (fly) {
        map.fitBounds(
          [
            [b[1], b[0]],
            [b[3], b[2]],
          ],
          { padding: [40, 40], maxZoom: 15 }
        );
      }
    } else if (lake.lat != null) {
      if (fly) map.setView([lake.lat, lake.lng], 14);
    } else {
      toast("No map location for this lake yet — use the DNR PDF on its card");
    }
  }


  function launchIcon(access) {
    const c = ACCESS_COLORS[access] || ACCESS_COLORS.unknown;
    return L.divIcon({
      className: "launch-marker",
      html: `<span class="launch-pin" style="--fill:${c.fill};--stroke:${c.stroke}" title="${access}"></span>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Launch type as shown to anglers; shoreline / carry-down sites are not trailer ramps.
  function launchKindLabel(t) {
    if (t === "Shoreline") return { text: "Shoreline fishing only (no boat ramp)", short: "shore only", cls: "kind-shore" };
    if (t === "Carry Down") return { text: "Carry-down launch (no trailer ramp)", short: "carry-down", cls: "kind-carry" };
    if (t === "Canoe Ramp") return { text: "Canoe / kayak ramp", short: "canoe ramp", cls: "kind-carry" };
    return null;
  }

  // Drop empty "Field: ;" entries from DNR notes (e.g. "Ramp:  ;").
  function cleanLaunchNotes(s) {
    if (!s) return "";
    return String(s)
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x && !/^[^:]+:\s*$/.test(x) && !/^[^:]+:\s*(none listed|n\/a|null|undefined)$/i.test(x))
      .join("; ");
  }

  function launchPopupHtml(p) {
    const dest = `${p.lat},${p.lng}`;
    const accessLabel =
      p.access === "public"
        ? "Public"
        : p.access === "private"
          ? "Private / commercial"
          : "Unknown access";
    const badgeClass = p.access || "unknown";
    const lake = p.lake ? `<div><strong>Lake</strong> ${escapeHtml(p.lake)}</div>` : "";
    const county = p.county
      ? `<div><strong>County</strong> ${escapeHtml(p.county)}</div>`
      : "";
    const notesClean = cleanLaunchNotes(p.notes);
    const notes = notesClean
      ? `<p class="launch-notes">${escapeHtml(notesClean)}</p>`
      : "";
    const kind = launchKindLabel(p.launch_type);
    const kindHtml = kind ? `<div class="launch-kind ${kind.cls}">${escapeHtml(kind.text)}</div>` : "";
    const approxHtml = p.location_approx
      ? `<div class="launch-kind">Approximate location</div>`
      : "";
    return `<div class="launch-popup">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="access-badge ${badgeClass}">${accessLabel}</span>
      ${kindHtml}${approxHtml}${lake}${county}
      ${typeof window.mfaLaunchAttrs === "function" ? `<div class="launch-attrs">${window.mfaLaunchAttrs(p)}</div>` : ""}
      <div class="launch-actions">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}" target="_blank" rel="noopener">Drive here</a>
        <a class="secondary" href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">Source</a>
      </div>
      <p class="launch-source">${escapeHtml(p.source)}</p>
      ${notes}
    </div>`;
  }

  function nearestLaunches(lake, limit = 6, maxMi = 8) {
    if (!lake || lake.lat == null) return [];
    const scored = [];
    for (const Lch of launches) {
      const d = haversineM([lake.lat, lake.lng], [Lch.lat, Lch.lng]);
      const mi = d / 1609.34;
      if (mi <= maxMi) scored.push({ ...Lch, miles: mi });
    }
    scored.sort((a, b) => a.miles - b.miles);
    const linked = new Set(Array.isArray(lake.launch_ids) ? lake.launch_ids : []);
    if (linked.size) {
      for (const s of scored) if (linked.has(s.id)) s.onLake = true;
      scored.sort((a, b) => (a.onLake ? 0 : 1) - (b.onLake ? 0 : 1) || a.miles - b.miles);
      return scored.slice(0, limit);
    }
    // Prefer same-named lake matches first
    const lakeName = (lake.name || "").toLowerCase();
    scored.sort((a, b) => {
      const aHit = a.lake && a.lake.toLowerCase().includes(lakeName.split(" ")[0]) ? 0 : 1;
      const bHit = b.lake && b.lake.toLowerCase().includes(lakeName.split(" ")[0]) ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      return a.miles - b.miles;
    });
    return scored.slice(0, limit);
  }

  function setLaunchesVisible(on) {
    launchesVisible = !!on;
    const btn = document.getElementById("btnLaunches");
    const chk = document.getElementById("filterLaunches");
    if (btn) {
      btn.classList.toggle("active", launchesVisible);
      btn.setAttribute("aria-pressed", launchesVisible ? "true" : "false");
    }
    if (chk) chk.checked = launchesVisible;
    if (!launchCluster) {
      if (launchesVisible) {
        if (launches.length) placeLaunchMarkers();
        else toast("Boat launches not loaded yet");
      }
      return;
    }
    if (launchesVisible) {
      if (!map.hasLayer(launchCluster)) map.addLayer(launchCluster);
      const n = typeof launchCluster.getLayers === "function" ? launchCluster.getLayers().length : launches.length;
      if (!n) toast("No boat launches to show");
    } else if (map.hasLayer(launchCluster)) {
      map.removeLayer(launchCluster);
    }
  }

  function syncLaunchesForZoom() {
    // Default off when zoomed out; auto-on at lake-level zoom.
    // Only auto-switch when crossing the lake-zoom threshold; otherwise respect the user's toggle.
    const band = map.getZoom() >= LAKE_ZOOM;
    if (band !== _launchZoomBand) {
      _launchZoomBand = band;
      setLaunchesVisible(band);
    } else if (launchesVisible && launchCluster && !map.hasLayer(launchCluster)) setLaunchesVisible(true);
  }

  function placeLaunchMarkers() {
    if (launchCluster) {
      map.removeLayer(launchCluster);
      launchCluster = null;
    }
    const paneOpts = { pane: "launchesPane" };
    if (typeof L.markerClusterGroup !== "function") {
      console.warn("MarkerCluster not loaded; using plain layer group");
      launchCluster = L.layerGroup();
    } else {
      launchCluster = L.markerClusterGroup({
        ...paneOpts,
        maxClusterRadius: (zoom) => (zoom <= 9 ? 70 : zoom <= 11 ? 50 : zoom <= 13 ? 36 : 28),
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        disableClusteringAtZoom: 15,
        iconCreateFunction(cluster) {
          const n = cluster.getChildCount();
          const size = n > 40 ? "lg" : n > 15 ? "md" : "sm";
          return L.divIcon({
            html: `<div><span>${n}</span></div>`,
            className: `launch-cluster launch-cluster-${size}`,
            iconSize: L.point(40, 40),
          });
        },
      });
    }
    let placed = 0;
    for (const Lch of launches) {
      if (!Number.isFinite(Lch.lat) || !Number.isFinite(Lch.lng)) continue;
      if (typeof window.mfaLaunchFilter === "function" && !window.mfaLaunchFilter(Lch)) continue;
      const m = L.marker([Lch.lat, Lch.lng], {
        icon: launchIcon(Lch.access),
        keyboard: true,
        pane: "launchesPane",
        title: Lch.name || "Boat launch",
      });
      m.bindPopup(launchPopupHtml(Lch), { maxWidth: 280 });
      m.bindTooltip(
        `${Lch.name} (${Lch.access})`,
        { direction: "top", opacity: 0.9, offset: [0, -6] }
      );
      launchCluster.addLayer(m);
      placed++;
    }
    if (launchesVisible) {
      launchCluster.addTo(map);
      if (placed === 0) toast(launches.length ? "No launches match the launch filters" : "No boat launches to show");
    }
    console.info("Launch markers placed:", placed);
  }

  // Small-print source for max depth / acres; says so plainly when not recorded.
  function statSourcesHtml(lake) {
    const parts = [];
    if (lake.max_depth_ft != null)
      parts.push(`Max depth: ${escapeHtml(lake.max_depth_source || "source not recorded")}`);
    if (lake.acres != null || Array.isArray(lake.acres_range))
      parts.push(`Acres: ${escapeHtml(lake.acres_source || "source not recorded")}`);
    return parts.length ? `<br/><span class="stat-sources">${parts.join(" · ")}</span>` : "";
  }

  function showLakeCard(lake) {
    const card = document.getElementById("lakeCard");
    const maxD =
      lake.max_depth_label
        ? escapeHtml(lake.max_depth_label)
        : lake.max_depth_ft != null
        ? `${lake.max_depth_ft} ft`
        : lake.max_contour_ft != null
          ? `≥ ${lake.max_contour_ft} ft <small>(deepest contour; DNR max not published)</small>`
          : "—";
    const acres = lake.acres != null ? `${lake.acres}`
      : Array.isArray(lake.acres_range) ? `~${lake.acres_range[0]}–${lake.acres_range[1]} <small>(outlines differ)</small>` : "—";
    const interval =
      lake.contour_interval_ft != null
        ? `${lake.contour_interval_ft} ft`
        : "—";
    const survey = lake.survey_date || "—";
    let actions = "";
    if (lake.lat != null && lake.lng != null) {
      const dest = `${lake.lat},${lake.lng}`;
      actions += `<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}" target="_blank" rel="noopener">Drive here</a>`;
      actions += `<button type="button" class="secondary" id="btnNextNearest">Next nearest lake</button>`;
    }
    if (lake.pdf_url) {
      actions += `<a class="secondary" href="${lake.pdf_url}" target="_blank" rel="noopener">DNR PDF maps</a>`;
    }
    card.innerHTML = `
      <button class="close" id="btnCloseCard" type="button" aria-label="Close">✕</button>
      <h2>${lake.name}</h2>
      <div class="county">${lake.county || ""}${lake.county2 ? " / " + lake.county2 : ""}, ${lakeStateName(lake)} · ${
        lake.retrace_pending ? "Depth map being re-traced" :
        lake.no_depth_map ? "No depth map yet" :
        lake.georef_method === "synthetic" || lake.contour_method === "synthetic_or_distance_based"
          ? "Approximate contours (review)"
          : lake.needs_review
            ? "Needs review"
            : lake.has_contours
              ? (lake.contour_method === "vector_featureserver" ? "Vector contours" : lake.contour_method === "lidar_dem_contour" ? "Lidar contours (unofficial)" : lake.contour_method === "historical_trace" ? "Unofficial historical contours" : lake.contour_method === "dnr_paper_map_fitted" ? "Unofficial DNR map (fitted shoreline)" : "Digitized PDF contours")
              : "PDF map only"
      }</div>
      ${
        lake.no_depth_map
          ? `<div class="nomap-banner"><strong>${lake.retrace_pending ? "Depth map being re-traced." : "No depth map yet."}</strong> ${lake.nomap_banner ? escapeHtml(lake.nomap_banner) : "No published depth survey was found for this lake, so no contours or depths are shown."}</div>`
          : (lake.georef_method === "synthetic" || lake.contour_method === "synthetic_or_distance_based")
          ? `<div class="approx-banner"><strong>Approximate contours.</strong> ${
              lake.review_notes
                || "Georeferencing is synthetic or shapes are approximate. Depth values come from the survey, but line positions are not reliable."
            } Contours draw dashed on the map.</div>`
          : lake.needs_review && publicReviewNote(lake)
            ? `<div class="review-notes"><strong>Needs a closer look:</strong> ${escapeHtml(publicReviewNote(lake))}</div>`
            : ""
      }
      ${lake.depth_banner && !lake.no_depth_map ? `<div class="review-notes"><strong>${escapeHtml(lake.depth_banner_title || "Note")}:</strong> ${escapeHtml(lake.depth_banner)}</div>` : ""}
      ${lake.exceeds_dnr_max ? `<div class="review-notes dnr-warn"><strong>⚠ Exceeds DNR max contour:</strong> ${lake.exceeds_dnr_note || ""}</div>` : ""}
      ${lake.no_depth_map ? `<div class="stats">
        <div><strong>Acres</strong>${acres}</div>
        ${lake.max_depth_ft != null ? `<div><strong>Max depth</strong>${lake.max_depth_ft} ft</div>` : ""}
        <div><strong>Depth map</strong>${lake.nomap_depth_label ? escapeHtml(lake.nomap_depth_label) : "Not available"}</div>
      </div>` : `<div class="stats">
        <div><strong>Max depth</strong>${maxD}</div>
        <div><strong>Acres</strong>${acres}</div>
        <div><strong>Contour interval</strong>${interval}</div>
        <div><strong>Survey</strong>${survey}</div>
      </div>`}
      <div class="actions">${actions}</div>
      <div id="nearbyLaunches" class="nearby-launches"></div>
      <p class="source">${escapeHtml(lake.source || "")}${lake.source_url ? ` · <a href="${lake.source_url}" target="_blank" rel="noopener">source</a>` : ""}${lake.accuracy_note ? `<br/>${escapeHtml(lake.accuracy_note)}` : ""}${statSourcesHtml(lake)}</p>
    `;
    card.classList.remove("hidden");
    document.getElementById("btnCloseCard").onclick = () =>
      card.classList.add("hidden");
    const next = document.getElementById("btnNextNearest");
    if (next) next.onclick = () => goNextNearest(lake);
    const nearEl = document.getElementById("nearbyLaunches");
    const near = nearestLaunches(lake);
    if (nearEl && near.length) {
      nearEl.innerHTML =
        `<div class="nearby-title">Nearby launches</div>` +
        near
          .map((x) => {
            const badge =
              x.access === "public"
                ? "public"
                : x.access === "private"
                  ? "private"
                  : "unknown";
            return `<button type="button" class="nearby-item" data-lat="${x.lat}" data-lng="${x.lng}">
              <span class="dot ${badge}"></span>
              <span class="nearby-name">${escapeHtml(x.name)}${x.onLake ? ' <small class="on-lake">on this lake</small>' : ""}${launchKindLabel(x.launch_type) ? ` <small class="launch-kind-tag">${launchKindLabel(x.launch_type).short}</small>` : ""}</span>
              <span class="nearby-mi">${x.miles < 0.1 ? "<0.1" : x.miles.toFixed(1)} mi</span>
            </button>`;
          })
          .join("");
      nearEl.querySelectorAll(".nearby-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          const lat = parseFloat(btn.dataset.lat);
          const lng = parseFloat(btn.dataset.lng);
          setLaunchesVisible(true);
          map.setView([lat, lng], 15);
          // open matching popup if possible
          if (launchCluster) {
            launchCluster.eachLayer((layer) => {
              const ll = layer.getLatLng && layer.getLatLng();
              if (ll && Math.abs(ll.lat - lat) < 1e-5 && Math.abs(ll.lng - lng) < 1e-5) {
                launchCluster.zoomToShowLayer(layer, () => layer.openPopup());
              }
            });
          }
        });
      });
    } else if (nearEl) {
      nearEl.innerHTML = "";
    }
    // Feature modules (offline, weather, sun/moon, fish, regs…) add their sections here.
    const extra = document.createElement("div");
    extra.id = "cardExtras";
    extra.className = "card-extras";
    const srcP = card.querySelector("p.source");
    card.insertBefore(extra, srcP);
    document.dispatchEvent(new CustomEvent("mfa:lakecard", { detail: { lake, card, extras: extra } }));
    applyCardPeek(card);
  }

  function applyCardPeek(card) {
    const existing = card.querySelector("#btnCardExpand");
    if (existing) existing.remove();
    card.classList.remove("peek", "expanded");
    if (window.innerWidth >= 800) return;
    card.classList.add("peek");
    const btn = document.createElement("button");
    btn.id = "btnCardExpand";
    btn.type = "button";
    btn.className = "card-expand";
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "Show more";
    btn.addEventListener("click", () => {
      const peek = card.classList.toggle("peek");
      // toggle returns new state of the class: true if now peeking
      btn.textContent = peek ? "Show more" : "Show less";
      btn.setAttribute("aria-expanded", peek ? "false" : "true");
      if (!peek) card.classList.add("expanded");
      else card.classList.remove("expanded");
    });
    const actions = card.querySelector(".actions");
    if (actions) actions.after(btn);
    else card.appendChild(btn);
  }

  function goNextNearest(from) {
    if (from.lat == null) return;
    let best = null;
    let bestD = Infinity;
    for (const l of lakes) {
      if (!l.has_contours || l.id === from.id || l.lat == null) continue;
      const d = haversineM([from.lat, from.lng], [l.lat, l.lng]);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    if (!best) {
      toast("No other contour lakes found");
      return;
    }
    selectLake(best, true);
    toast(`Next nearest: ${best.name} (${(bestD / 1609.34).toFixed(1)} mi)`);
  }

  function placeLakeMarkers() {
    lakeMarkers.clearLayers();
    for (const l of lakes) {
      if (!(l.has_contours || l.no_depth_map) || !Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue;
      const nomap = !l.has_contours;
      const m = L.circleMarker([l.lat, l.lng], nomap ? {
        radius: 5,
        color: "#4b5563",
        weight: 1.5,
        fillColor: "#ffffff",
        fillOpacity: 0.85,
        nomap: true,
      } : {
        radius: 5,
        color: "#0b3d5c",
        weight: 1,
        fillColor: "#3aa0d8",
        fillOpacity: 0.9,
      });
      m.bindTooltip(nomap ? `${l.name} (no depth map yet)` : l.name, { direction: "top", opacity: 0.9 });
      m.on("click", () => selectLake(l, false));
      lakeMarkers.addLayer(m);
    }
  }

  function styleContour(feature) {
    const d = feature.properties.depth_ft;
    const index = feature.properties.line_type === "INDEX";
    const dashed = feature.properties.line_style === "dashed"
      || feature.properties.georef_method === "synthetic"
      || feature.properties.contour_method === "synthetic_or_distance_based";
    const z = map.getZoom();
    // Thinner at mid-zoom so dense rings read as lines, not a watercolor haze.
    // Keep a bit of weight at high zoom for trolling readability.
    const base = z >= 18 ? 2.4 : z >= 16 ? 1.7 : z >= 14 ? 1.25 : z >= 12 ? 1.0 : 0.85;
    const opacity = dashed ? 0.8 : (z >= 16 ? 0.95 : z >= 14 ? 0.88 : 0.78);
    return {
      color: depthColor(d),
      weight: index ? base + 0.55 : base,
      opacity,
      fill: false,
      fillOpacity: 0,
      fillColor: "transparent",
      lineJoin: "miter",
      lineCap: "butt",
      dashArray: dashed ? "6 5" : null,
      stroke: true,
    };
  }

  // Light halo under contour lines, only on imagery basemaps (dark water hides dark lines).
  const IMAGERY_BASEMAPS = { sat: true, usgsImagery: true };
  let haloLayer = null;
  function haloStyle(props) {
    const z = map.getZoom();
    const base = z >= 18 ? 2.4 : z >= 16 ? 1.7 : z >= 14 ? 1.25 : z >= 12 ? 1.0 : 0.85;
    const index = props && props.line_type === "INDEX";
    const dashed = props && (props.line_style === "dashed" || props.georef_method === "synthetic" || props.contour_method === "synthetic_or_distance_based");
    return { color: "#ffffff", opacity: 0.8, weight: (index ? base + 0.55 : base) + 2, dashArray: dashed ? "6 5" : null };
  }

  function updateLabels() {
    if (labelLayer) {
      map.removeLayer(labelLayer);
      labelLayer = null;
    }
    if (!contourLayer || map.getZoom() < 14) return;
    labelLayer = L.layerGroup().addTo(map);
    const bounds = map.getBounds().pad(0.05);
    const zoom = map.getZoom();
    // Spacing along each contour (meters). Much denser when fully zoomed in for trolling.
    const spacingM =
      zoom >= 21 ? 25 :
      zoom >= 20 ? 40 :
      zoom >= 19 ? 60 :
      zoom >= 18 ? 90 :
      zoom >= 16 ? 160 :
      320;
    const maxLabels = zoom >= 20 ? 600 : zoom >= 18 ? 400 : zoom >= 16 ? 200 : 100;
    let count = 0;
    contourLayer.eachLayer((layer) => {
      if (count >= maxLabels) return;
      const depth = layer.feature && layer.feature.properties.depth_ft;
      if (depth == null || depth === 0) return;
      // Below z16, only label 10-ft index contours to reduce clutter
      if (zoom < 16 && depth % 10 !== 0) return;
      const latlngs = layer.getLatLngs();
      const flat = [];
      const walk = (arr) => {
        if (!arr || !arr.length) return;
        if (arr[0] instanceof L.LatLng || (arr[0] && arr[0].lat != null)) {
          flat.push(...arr);
        } else {
          arr.forEach(walk);
        }
      };
      walk(latlngs);
      if (flat.length < 2) return;
      let traveled = 0;
      let nextAt = spacingM * 0.35; // first label a bit into the line
      for (let i = 1; i < flat.length; i++) {
        const a = flat[i - 1];
        const b = flat[i];
        const seg = map.distance(a, b);
        const prev = traveled;
        traveled += seg;
        while (nextAt <= traveled && count < maxLabels) {
          const t = seg > 0 ? (nextAt - prev) / seg : 0;
          const ll = L.latLng(
            a.lat + (b.lat - a.lat) * t,
            a.lng + (b.lng - a.lng) * t
          );
          if (bounds.contains(ll)) {
            const icon = L.divIcon({
              className: "contour-label",
              html: `<span>${depth}</span>`,
              iconSize: [28, 14],
              iconAnchor: [14, 7],
            });
            L.marker(ll, { icon, interactive: false, keyboard: false }).addTo(labelLayer);
            count++;
          }
          nextAt += spacingM;
        }
      }
    });
  }


  const contourCache = new Map();
  const contourPending = new Map();
  let onContoursAdded = () => {};
  function ensureLakeContours(id) {
    if (!id) return Promise.resolve({ type: "FeatureCollection", features: [] });
    if (contourCache.has(id)) return Promise.resolve(contourCache.get(id));
    if (contourPending.has(id)) return contourPending.get(id);
    const p = fetch("./data/contours/" + encodeURIComponent(id) + ".geojson")
      .then((r) => (r.ok ? r.json() : { type: "FeatureCollection", features: [] }))
      .then((gj) => {
        contourCache.set(id, gj);
        contourPending.delete(id);
        if (contourLayer && gj.features && gj.features.length) {
          contourLayer.addData(gj);
          const el = contourLayer._renderer && contourLayer._renderer._container;
          if (el) el.classList.add("contour-svg");
          onContoursAdded();
        }
        return gj;
      })
      .catch((e) => {
        contourPending.delete(id);
        console.warn("Contour fetch failed", id, e);
        return { type: "FeatureCollection", features: [] };
      });
    contourPending.set(id, p);
    return p;
  }
  function loadContoursInView() {
    if (!map || map.getZoom() < 14) return Promise.resolve();
    const b = map.getBounds();
    const jobs = [];
    for (const l of lakes) {
      if (!l.has_contours || !l.bbox) continue;
      const bb = L.latLngBounds([l.bbox[1], l.bbox[0]], [l.bbox[3], l.bbox[2]]);
      if (b.intersects(bb)) jobs.push(ensureLakeContours(l.id));
    }
    return Promise.all(jobs);
  }

  async function loadData() {
    // Launches load on their own so a huge contours fetch cannot block or abort them.
    const launchesPromise = fetch("./data/launches.geojson")
      .then((r) => (r.ok ? r.json() : null))
      .catch((e) => {
        console.warn("Launches fetch failed", e);
        return null;
      });

    const [lakesGj, sources] = await Promise.all([
      fetch("./data/lakes.geojson").then((r) => r.json()),
      fetch("./data/sources.json").then((r) => r.json()).catch(() => null),
    ]);

    lakes = lakesGj.features.map((f) => {
      const p = f.properties || {};
      const g = f.geometry;
      // Lakes may be Point or Polygon (shore lock). Always derive a numeric lat/lng —
      // Polygon coordinates[0]/[1] are rings, which crash Leaflet circleMarkers.
      let lat = null;
      let lng = null;
      if (g && g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
        lng = +g.coordinates[0];
        lat = +g.coordinates[1];
      } else if (p.bbox && p.bbox.length >= 4) {
        lng = (+p.bbox[0] + +p.bbox[2]) / 2;
        lat = (+p.bbox[1] + +p.bbox[3]) / 2;
      } else if (g && g.type === "Polygon" && g.coordinates && g.coordinates[0] && g.coordinates[0].length) {
        const ring = g.coordinates[0];
        let sx = 0, sy = 0, n = 0;
        for (const pt of ring) {
          if (pt && pt.length >= 2 && Number.isFinite(+pt[0]) && Number.isFinite(+pt[1])) {
            sx += +pt[0]; sy += +pt[1]; n++;
          }
        }
        if (n) { lng = sx / n; lat = sy / n; }
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { lat = null; lng = null; }
      return { ...p, lat, lng };
    });

    // SVG renderer (not canvas): canvas overlays were drifting so lakes/contours
    // sat in the wrong geographic place after pan, wheel-zoom, or touch scroll.
    // padding keeps nearby lines drawn while panning without a full redraw race.
    const contourRenderer = L.svg({ padding: 0.5 });
    // Leaflet 1.9 ignores renderer className and may create the SVG only when
    // the first contour is added (lazy shards), or recreate it on view reset.
    // Tag inside _initContainer so fill:none CSS always hits contour strokes.
    const _initContourSvg = contourRenderer._initContainer.bind(contourRenderer);
    contourRenderer._initContainer = function () {
      _initContourSvg();
      if (this._container) this._container.classList.add("contour-svg");
    };
    contourLayer = L.geoJSON({ type: "FeatureCollection", features: [] }, {
      style: styleContour,
      renderer: contourRenderer,
    }).addTo(map);
    const tagContourSvg = () => {
      const el = contourRenderer && contourRenderer._container;
      if (el) el.classList.add("contour-svg");
    };
    tagContourSvg();
    contourLayer.on("add", tagContourSvg);
    map.on("viewreset zoomend", tagContourSvg);

    const syncHalo = () => {
      const want = !!IMAGERY_BASEMAPS[basemap] && map.hasLayer(contourLayer);
      if (want) {
        if (!haloLayer) {
          haloLayer = L.layerGroup();
          contourLayer.eachLayer((l) => {
            const props = (l.feature && l.feature.properties) || {};
            const h = L.polyline(l.getLatLngs(), { ...haloStyle(props), renderer: contourRenderer, interactive: false, className: "contour-halo" });
            h._haloProps = props;
            haloLayer.addLayer(h);
          });
        }
        if (!map.hasLayer(haloLayer)) {
          // Halo paths must sit under the coloured lines in the same SVG.
          map.removeLayer(contourLayer);
          haloLayer.eachLayer((h) => h.setStyle(haloStyle(h._haloProps)));
          haloLayer.addTo(map);
          contourLayer.addTo(map);
        }
      } else if (haloLayer && map.hasLayer(haloLayer)) {
        map.removeLayer(haloLayer);
      }
    };
    document.addEventListener("mfa:basemap", syncHalo);

    // Visibility + marker sizing depend on zoom only.
    const syncContourVis = () => {
      const z = map.getZoom();
      if (z >= 11) {
        if (!map.hasLayer(contourLayer)) contourLayer.addTo(map);
      } else if (map.hasLayer(contourLayer)) {
        map.removeLayer(contourLayer);
      }
      syncHalo();
      lakeMarkers.eachLayer((m) => {
        const ll = m.getLatLng && m.getLatLng();
        if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return;
        if (m.options && m.options.nomap) {
          if (z >= 13) m.setStyle({ radius: 5, opacity: 0.8, fillOpacity: 0.7 });
          else m.setStyle({ radius: 5, opacity: 1, fillOpacity: 0.85 });
        } else if (z >= 13) m.setStyle({ radius: 4, opacity: 0.35, fillOpacity: 0.35 });
        else m.setStyle({ radius: 5, opacity: 1, fillOpacity: 0.9 });
      });
    };
    // Restyle only on zoom — setStyle on every moveend forced a full redraw while
    // Leaflet was still settling the pan transform (worsened canvas drift).
    const syncContourStyle = () => {
      if (map.hasLayer(contourLayer)) contourLayer.setStyle(styleContour);
      if (haloLayer && map.hasLayer(haloLayer)) haloLayer.eachLayer((h) => h.setStyle(haloStyle(h._haloProps)));
    };
    // Labels depend on viewport bounds; throttle during inertial pan / follow-me.
    let _labelTimer = null;
    const scheduleLabels = (immediate) => {
      if (_labelTimer != null) {
        clearTimeout(_labelTimer);
        _labelTimer = null;
      }
      if (immediate) {
        updateLabels();
        return;
      }
      _labelTimer = setTimeout(() => {
        _labelTimer = null;
        updateLabels();
      }, 120);
    };
    onContoursAdded = () => {
      if (haloLayer) { map.removeLayer(haloLayer); haloLayer = null; }
      syncHalo();
      syncContourStyle();
      scheduleLabels(true);
    };
    map.on("zoomend", () => {
      syncContourVis();
      syncContourStyle();
      scheduleLabels(true);
      syncLaunchesForZoom();
      loadContoursInView();
    });
    map.on("moveend", () => { scheduleLabels(false); loadContoursInView(); });
    syncContourVis();
    syncContourStyle();
    scheduleLabels(true);
    syncLaunchesForZoom();

    // Mobile browser chrome / orientation / keyboard can resize the map without
    // Leaflet noticing — overlays then look shifted until invalidateSize.
    const invalidate = () => map.invalidateSize({ pan: false });
    window.addEventListener("resize", invalidate);
    window.addEventListener("orientationchange", invalidate);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", invalidate);
    }
    requestAnimationFrame(invalidate);

    placeLakeMarkers();
    renderLakeList();
    renderCountyChips();
    applySearchFromUrl();
    applyLakeFromUrl();
    setLoadStatus("");
    loadContoursInView();
    if (selectedLake && selectedLake.has_contours) ensureLakeContours(selectedLake.id);
    window.addEventListener("popstate", applyLakeFromUrl);
    if (sources) {
      console.info("Data sources:", sources);
    }

    // Always place launches (even if contours were slow/heavy)
    try {
      const launchesGj = await launchesPromise;
      if (launchesGj && launchesGj.features) {
        launches = launchesGj.features.map((f) => {
          const p = f.properties || {};
          const g = f.geometry;
          const lat = p.lat != null ? +p.lat : g && g.coordinates ? +g.coordinates[1] : NaN;
          const lng = p.lng != null ? +p.lng : g && g.coordinates ? +g.coordinates[0] : NaN;
          return { ...p, lat, lng };
        }).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
        placeLaunchMarkers();
        console.info("Launches:", launches.length, launchesGj.properties && launchesGj.properties.counts);
        if (launchesVisible && launches.length === 0) {
          toast("No boat launches in dataset");
        }
      } else {
        console.warn("Launches GeoJSON missing or empty");
        if (launchesVisible) toast("Boat launches unavailable");
      }
    } catch (e) {
      console.error("Launches place failed", e);
      toast("Boat launches failed to load");
    }
    window.__mfaDataLoaded = true;
    document.dispatchEvent(new CustomEvent("mfa:data"));
  }

  // ----- Geolocation / trolling -----
  function boatIcon(heading) {
    const rot = heading != null ? heading : 0;
    return L.divIcon({
      className: "boat-marker",
      html: `<div class="boat-arrow"><svg viewBox="0 0 28 28" style="transform:rotate(${rot}deg)"><polygon points="14,2 22,24 14,19 6,24" fill="#f0b429" stroke="#1a2a36" stroke-width="1.5"/></svg></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function updateBoatMarker(lat, lng, heading) {
    if (!troll.boatMarker) {
      troll.boatMarker = L.marker([lat, lng], {
        icon: boatIcon(heading),
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      troll.boatMarker.setLatLng([lat, lng]);
      troll.boatMarker.setIcon(boatIcon(heading));
    }
  }

  function updateTrack() {
    if (!troll.trackLine) {
      troll.trackLine = L.polyline(troll.track, {
        color: "#f0b429",
        weight: 3,
        opacity: 0.85,
      }).addTo(map);
    } else {
      troll.trackLine.setLatLngs(troll.track);
    }
  }

  function emitTroll(type, detail) {
    try { document.dispatchEvent(new CustomEvent(type, { detail })); } catch (_) {}
  }
  function onTrollPosition(pos) {
    if (!troll.on) return;
    const { latitude: lat, longitude: lng, speed, heading } = pos.coords;
    // Hook for track recording (js/tracks.js). Raw GPS values only.
    emitTroll("mfa:trollpos", {
      lat, lng,
      t: pos.timestamp || Date.now(),
      spd: speed != null && !Number.isNaN(speed) ? speed : null,
      hdg: heading != null && !Number.isNaN(heading) ? heading : null,
      acc: pos.coords.accuracy != null ? pos.coords.accuracy : null,
    });
    troll.lat = lat;
    troll.lng = lng;
    const acc = pos.coords.accuracy;
    const tFix = pos.timestamp || Date.now();
    const gpsSpd = speed != null && !Number.isNaN(speed) ? speed : null;
    const mps = troll.speedFilter.push({ lat, lng, t: tFix, acc, spd: gpsSpd }, tFix);
    troll.speedMph = mps == null ? null : mps * 2.23694;
    if (heading != null && !Number.isNaN(heading)) {
      troll.heading = heading;
    }
    // derive heading from track if GPS doesn't provide; only add points that
    // moved more than the accuracy bubble so the line doesn't wander when still.
    const minTrackM = Math.max(4, Math.min(acc != null && !Number.isNaN(acc) ? acc : 10, 20) * 0.8);
    if (troll.track.length) {
      const prev = troll.track[troll.track.length - 1];
      const d = haversineM(prev, [lat, lng]);
      if (d > minTrackM) {
        if (troll.heading == null || heading == null) {
          const dy = lat - prev[0];
          const dx = lng - prev[1];
          troll.heading = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
        }
        troll.track.push([lat, lng]);
        if (troll.track.length > 2000) troll.track.shift();
        updateTrack();
      }
    } else {
      troll.track.push([lat, lng]);
    }

    updateBoatMarker(lat, lng, troll.heading);
    updateAccuracy(lat, lng, pos.coords.accuracy);
    if (!troll._fixed) {
      // First fix: jump to the boat (zoom in only if zoomed far out).
      troll._fixed = true;
      if (troll.follow) map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: false });
    } else if (troll.follow) {
      // Later fixes keep the user's zoom.
      map.panTo([lat, lng], { animate: true, duration: 0.4 });
    }

    const paintDepth = () => {
      if (!troll.on || troll.lat !== lat) return;
      const depthInfo = nearestContourDepth(lat, lng);
      document.getElementById("trollSpeed").textContent =
        troll.speedMph != null ? troll.speedMph.toFixed(1) : "—";
      document.getElementById("trollHeading").textContent =
        troll.heading != null ? Math.round(troll.heading) : "—";
      document.getElementById("trollDepth").textContent = depthInfo ? `${depthInfo.depth}` : "—";
      const srcEl = document.getElementById("trollDepthSrc");
      if (srcEl)
        srcEl.textContent = depthInfo
          ? `Nearest contour: ${depthInfo.depth} ft · ${depthSourceLabel(lakeById(depthInfo.lakeId))} · ${Math.round(depthInfo.distM)} m away`
          : "No verified depth line within 80 m";
    };
    paintDepth();
    loadContoursInView().then(paintDepth);
  }

  async function requestWakeLock() {
    // Keep the screen awake while trolling; fail silently where unsupported.
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
        });
      }
    } catch (_) {
      wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    try {
      if (wakeLock) await wakeLock.release();
    } catch (_) {}
    wakeLock = null;
  }

  // The OS drops the wake lock when the tab is hidden; take it back on return.
  document.addEventListener("visibilitychange", () => {
    if (troll.on && !wakeLock && document.visibilityState === "visible") requestWakeLock();
  });

  // ----- Trolling mode map control (follows your GPS) -----
  const TrollControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const wrap = L.DomUtil.create("div", "leaflet-control troll-control");
      wrap.innerHTML =
        '<button id="btnTroll" type="button" class="troll-toggle" aria-label="Trolling mode: follow my GPS location" aria-pressed="false" title="Trolling mode: follow my GPS location">' +
        '<span class="troll-ico" aria-hidden="true">🚤</span><span class="troll-text">Trolling mode</span><span class="troll-state" aria-hidden="true"></span></button>' +
        '<button id="btnRecenter" type="button" class="troll-recenter hidden" aria-label="Re-centre on my location and resume following" title="Re-centre"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>Re-centre</button>';
      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.disableScrollPropagation(wrap);
      return wrap;
    },
  });
  new TrollControl().addTo(map);

  function setTrollButton() {
    const btn = document.getElementById("btnTroll");
    if (!btn) return;
    btn.classList.toggle("active", troll.on);
    btn.setAttribute("aria-pressed", troll.on ? "true" : "false");
    const st = btn.querySelector(".troll-state");
    if (st) st.textContent = troll.on ? (troll.follow ? "ON" : "PAUSED") : "";
    const rc = document.getElementById("btnRecenter");
    if (rc) rc.classList.toggle("hidden", !(troll.on && !troll.follow));
    const fm = document.getElementById("followMe");
    if (fm) fm.checked = troll.follow;
  }

  function setFollow(on) {
    troll.follow = on;
    if (on && troll.on && troll.lat != null) {
      map.panTo([troll.lat, troll.lng], { animate: true, duration: 0.4 });
    }
    setTrollButton();
  }

  function updateAccuracy(lat, lng, acc) {
    if (acc == null || Number.isNaN(acc)) return;
    if (!troll.accCircle) {
      troll.accCircle = L.circle([lat, lng], {
        radius: acc,
        color: "#1f8fbf",
        weight: 1,
        fillColor: "#1f8fbf",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    } else {
      troll.accCircle.setLatLng([lat, lng]);
      troll.accCircle.setRadius(acc);
    }
  }

  function clearTrollLayers() {
    if (troll.boatMarker) { map.removeLayer(troll.boatMarker); troll.boatMarker = null; }
    if (troll.accCircle) { map.removeLayer(troll.accCircle); troll.accCircle = null; }
    if (troll.trackLine) { map.removeLayer(troll.trackLine); troll.trackLine = null; }
    troll.track = [];
    troll.lat = troll.lng = null;
    troll.heading = null;
    troll.speedMph = null;
    troll._fixed = false;
    ["trollSpeed", "trollDepth", "trollHeading"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "—";
    });
    const srcEl = document.getElementById("trollDepthSrc");
    if (srcEl) srcEl.textContent = "";
  }

  function onTrollGeoError(err) {
    if (!troll.on) return;
    if (err && err.code === 1) {
      stopTrolling();
      toast("Trolling mode needs your location. Allow location for this site in your browser settings, then try again.", 6000);
    } else if (err && err.code === 3) {
      toast("Still waiting for a GPS fix… (open sky helps)", 4000);
    } else {
      toast("Can't get your location right now. Check that location/GPS is on.", 5000);
    }
  }

  function startTrolling() {
    if (troll.on) stopTrolling();
    troll.on = true;
    troll.follow = true;
    troll._fixed = false;
    document.body.classList.add("trolling");
    document.getElementById("trollHud").classList.remove("hidden");
    document.getElementById("lakeCard").classList.add("hidden");
    setTrollButton();
    requestWakeLock();

    if (!window.isSecureContext || !navigator.geolocation) {
      stopTrolling();
      toast("Location isn't available in this browser, so Trolling mode can't follow you.", 5000);
      return;
    }
    troll.speedFilter.reset();
    troll.speedMph = null;
    if (troll._speedTimer) clearInterval(troll._speedTimer);
    troll._speedTimer = setInterval(() => {
      if (!troll.on) return;
      const mps = troll.speedFilter.tick(Date.now());
      troll.speedMph = mps == null ? null : mps * 2.23694;
      const el = document.getElementById("trollSpeed");
      if (el) el.textContent = troll.speedMph != null ? troll.speedMph.toFixed(1) : "—";
    }, 1000);
    troll.watchId = navigator.geolocation.watchPosition(onTrollPosition, onTrollGeoError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });
    // DeviceOrientation for heading fallback
    const onOrient = (e) => {
      if (e.absolute || e.webkitCompassHeading != null) {
        const h =
          e.webkitCompassHeading != null
            ? e.webkitCompassHeading
            : (360 - e.alpha) % 360;
        if (troll.speedMph == null || troll.speedMph < 0.5) troll.heading = h;
      }
    };
    window.addEventListener("deviceorientationabsolute", onOrient, true);
    window.addEventListener("deviceorientation", onOrient, true);
    troll._onOrient = onOrient;
    toast("Trolling mode on: finding your GPS location…");
    emitTroll("mfa:trollstart", {});
  }

  function stopTrolling() {
    const wasOn = troll.on;
    troll.on = false;
    document.body.classList.remove("trolling");
    document.getElementById("trollHud").classList.add("hidden");
    if (troll._speedTimer) {
      clearInterval(troll._speedTimer);
      troll._speedTimer = null;
    }
    if (troll.speedFilter) troll.speedFilter.reset();
    if (troll.watchId != null) {
      navigator.geolocation.clearWatch(troll.watchId);
      troll.watchId = null;
    }
    if (troll._onOrient) {
      window.removeEventListener("deviceorientationabsolute", troll._onOrient, true);
      window.removeEventListener("deviceorientation", troll._onOrient, true);
      troll._onOrient = null;
    }
    clearTrollLayers();
    releaseWakeLock();
    troll.follow = true;
    setTrollButton();
    if (wasOn) emitTroll("mfa:trollstop", {});
  }

  // Keep the legend just above the Trolling HUD whatever its height (extra rows such
  // as the track-recording status can make it taller).
  if (window.ResizeObserver) {
    const hudEl = document.getElementById("trollHud");
    new ResizeObserver(() => {
      if (hudEl.offsetHeight) document.body.style.setProperty("--troll-hud-h", hudEl.offsetHeight + "px");
    }).observe(hudEl);
  }

  // Trolling mode always uses the device's real GPS.
  document.getElementById("btnTroll").addEventListener("click", () => {
    if (troll.on) {
      stopTrolling();
      toast("Trolling mode off");
    } else startTrolling();
  });
  document.getElementById("btnRecenter").addEventListener("click", () => setFollow(true));
  // A user drag pauses following (programmatic panTo does not fire dragstart).
  map.on("dragstart", () => {
    if (troll.on && troll.follow) {
      troll.follow = false;
      setTrollButton();
      toast("Following paused. Tap Re-centre to follow again.", 3000);
    }
  });
  document.getElementById("btnExitTroll").addEventListener("click", stopTrolling);
  document.getElementById("followMe").addEventListener("change", (e) => {
    setFollow(e.target.checked);
  });
  document.getElementById("btnClearTrack").addEventListener("click", () => {
    troll.track = troll.lat != null ? [[troll.lat, troll.lng]] : [];
    updateTrack();
  });

  document.getElementById("btnSearch").addEventListener("click", () => {
    // Magnifier always opens the panel and focuses search (mobile-friendly)
    openPanel(true);
  });
  document.getElementById("btnClosePanel").addEventListener("click", () => openPanel(false));
  const lakeSearch = document.getElementById("lakeSearch");
  lakeSearch.addEventListener("input", () => {
    // Typing should open the panel if it was closed
    const panel = document.getElementById("panel");
    if (panel.classList.contains("hidden")) openPanel(true);
    renderLakeList();
  });
  lakeSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const panel = document.getElementById("panel");
      if (panel.classList.contains("hidden")) openPanel(true);
      renderLakeList();
      goToTopSearchMatch();
    }
  });
  document.getElementById("filterContours").addEventListener("change", renderLakeList);
  document.getElementById("filterPdf").addEventListener("change", renderLakeList);
  const filterLaunches = document.getElementById("filterLaunches");
  if (filterLaunches) {
    filterLaunches.addEventListener("change", (e) => setLaunchesVisible(e.target.checked));
  }
  const btnLaunches = document.getElementById("btnLaunches");
  if (btnLaunches) {
    btnLaunches.addEventListener("click", () => setLaunchesVisible(!launchesVisible));
  }

  document.getElementById("btnLocate").addEventListener("click", () => {
    if (!navigator.geolocation) {
      toast("Geolocation not supported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        window.__mfaLastFix = { lat: latitude, lng: longitude };
        sortNear = { lat: latitude, lng: longitude };
        countyFilter = null;
        stateFilter = null;
        renderCountyChips();
        renderLakeList();
        openPanel(true);
        map.setView([latitude, longitude], Math.max(map.getZoom(), 13));
        L.circleMarker([latitude, longitude], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#2b6cff",
          fillOpacity: 1,
        })
          .addTo(map)
          .bindTooltip("You are here")
          .openTooltip();
      },
      (err) => toast("Location: " + err.message),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  // Deep-link helpers for Playwright screenshots

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const card = document.getElementById("lakeCard");
    if (card && !card.classList.contains("hidden")) {
      card.classList.add("hidden");
      e.stopPropagation();
      return;
    }
    const list = document.getElementById("panel");
    if (list && !list.classList.contains("hidden")) {
      list.classList.add("hidden");
    }
  });

  window.__mfa = {
    map,
    selectLakeByName(name) {
      const l = lakes.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (l) selectLake(l, true);
      return !!l;
    },
    getLakes: () => lakes,
    getLaunches: () => launches,
    refreshLaunches() { if (launches.length) placeLaunchMarkers(); },
    getLaunchMarkerCount: () => (launchCluster ? launchCluster.getLayers().length : 0),
    setLaunchesVisible,
    setBasemap,
    getBasemap: () => basemap,
    basemaps: BASEMAPS,
    toast,
    escapeHtml,
    lakeById,
    selectLake: (l, fly) => selectLake(l, fly),
    ensureLakeContours,
    createTrollSpeedFilter,
    trollState: () => troll,
  };
  document.dispatchEvent(new CustomEvent("mfa:ready"));

  function setLoadStatus(msg) {
    const el = document.getElementById("loadStatus");
    if (!el) return;
    if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
    el.classList.remove("hidden");
    el.textContent = msg;
  }
  loadData()
    .then(() => setLoadStatus(""))
    .catch((e) => {
      console.error(e);
      setLoadStatus("");
      toast("Failed to load lake data");
    });
})();
