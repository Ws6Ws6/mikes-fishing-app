/* Mike's Fishing App — Indiana boat launches · NE Indiana lake depth prototype */
(function () {
  "use strict";

  const MAX_ZOOM = 22;
  // Default view stays NE Indiana (depth maps); pan/zoom freely for statewide launches.
  const NE_CENTER = [41.45, -85.35];
  const NE_ZOOM = 9;
  const STATE_BOUNDS = L.latLngBounds([37.75, -88.12], [41.78, -84.75]);

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
  L.control.zoom({ position: "bottomright" }).addTo(map);

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
  osm.addTo(map);

  let basemap = "street";
  document.getElementById("btnLayers").addEventListener("click", () => {
    if (basemap === "street") {
      map.removeLayer(osm);
      sat.addTo(map);
      basemap = "sat";
      toast("Satellite basemap");
    } else {
      map.removeLayer(sat);
      osm.addTo(map);
      basemap = "street";
      toast("Street basemap");
    }
  });

  function depthColor(ft) {
    if (ft == null) return "#4aa3d9";
    const t = Math.max(0, Math.min(1, ft / 80));
    // light cyan -> deep navy
    const r = Math.round(200 - t * 170);
    const g = Math.round(230 - t * 180);
    const b = Math.round(255 - t * 80);
    return `rgb(${r},${g},${b})`;
  }

  let lakes = [];
  let contourLayer = null;
  let labelLayer = null;
  let lakeMarkers = L.layerGroup().addTo(map);
  let selectedLake = null;
  let wakeLock = null;
  let launches = [];
  let launchCluster = null;
  let launchesVisible = true;

  const ACCESS_COLORS = {
    public: { fill: "#1a7f4b", stroke: "#0e4d2c" },
    private: { fill: "#d97706", stroke: "#92400e" },
    unknown: { fill: "#6b7280", stroke: "#374151" },
  };

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
    simulate: false,
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
      const depth = layer.feature && layer.feature.properties.depth_ft;
      if (depth == null) return;
      const rings = Array.isArray(latlngs[0]) && typeof latlngs[0][0] !== "number"
        ? (Array.isArray(latlngs[0][0]) ? latlngs.flat() : latlngs)
        : [latlngs];
      for (const line of rings) {
        const pts = line.map((ll) => (ll.lat != null ? [ll.lat, ll.lng] : [ll[0], ll[1]]));
        for (let i = 0; i < pts.length - 1; i++) {
          const d = distPointToSegM(p, pts[i], pts[i + 1]);
          if (d < bestD) {
            bestD = d;
            best = { depth, distM: d };
          }
        }
      }
    });
    // Only report if within ~80 m of a contour (honest proximity)
    if (!best || best.distM > 80) return null;
    return best;
  }

  function renderLakeList() {
    const q = (document.getElementById("lakeSearch").value || "").trim().toLowerCase();
    const showC = document.getElementById("filterContours").checked;
    const showP = document.getElementById("filterPdf").checked;
    const ul = document.getElementById("lakeList");
    ul.innerHTML = "";
    const filtered = lakes
      .filter((l) => {
        if (l.has_contours && !showC) return false;
        if (!l.has_contours && !showP) return false;
        if (!q) return true;
        return (
          l.name.toLowerCase().includes(q) ||
          (l.county || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const l of filtered) {
      const li = document.createElement("li");
      const badge = l.has_contours
        ? '<span class="badge contour">contours</span>'
        : '<span class="badge pdf">PDF map</span>';
      const depth =
        l.max_depth_ft != null ? ` · max ${l.max_depth_ft} ft` : "";
      const acres = l.acres != null ? ` · ${l.acres} ac` : "";
      li.innerHTML = `<div class="name">${l.name}${badge}</div>
        <div class="meta">${l.county || "—"}${acres}${depth}</div>`;
      li.addEventListener("click", () => selectLake(l, true));
      ul.appendChild(li);
    }
  }

  function openPanel(open) {
    document.getElementById("panel").classList.toggle("hidden", !open);
  }

  function selectLake(lake, fly) {
    selectedLake = lake;
    showLakeCard(lake);
    openPanel(false);
    if (lake.has_contours && lake.bbox) {
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
      toast("PDF-only lake — open DNR map from the card (no map location yet)");
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
    const notes = p.notes
      ? `<p class="launch-notes">${escapeHtml(p.notes)}</p>`
      : "";
    return `<div class="launch-popup">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="access-badge ${badgeClass}">${accessLabel}</span>
      ${lake}${county}
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
    if (!launchCluster) return;
    if (launchesVisible) {
      if (!map.hasLayer(launchCluster)) map.addLayer(launchCluster);
    } else if (map.hasLayer(launchCluster)) {
      map.removeLayer(launchCluster);
    }
  }

  function placeLaunchMarkers() {
    if (launchCluster) {
      map.removeLayer(launchCluster);
      launchCluster = null;
    }
    if (typeof L.markerClusterGroup !== "function") {
      console.warn("MarkerCluster not loaded; using plain layer group");
      launchCluster = L.layerGroup();
    } else {
      launchCluster = L.markerClusterGroup({
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
    for (const Lch of launches) {
      const m = L.marker([Lch.lat, Lch.lng], {
        icon: launchIcon(Lch.access),
        keyboard: false,
      });
      m.bindPopup(launchPopupHtml(Lch), { maxWidth: 280 });
      m.bindTooltip(
        `${Lch.name} (${Lch.access})`,
        { direction: "top", opacity: 0.9, offset: [0, -6] }
      );
      launchCluster.addLayer(m);
    }
    if (launchesVisible) launchCluster.addTo(map);
  }

  function showLakeCard(lake) {
    const card = document.getElementById("lakeCard");
    const maxD =
      lake.max_depth_ft != null ? `${lake.max_depth_ft} ft` : "—";
    const acres = lake.acres != null ? `${lake.acres}` : "—";
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
    if (lake.has_contours) {
      actions += `<button type="button" class="secondary" id="btnTrollHere">Troll here</button>`;
    }
    card.innerHTML = `
      <button class="close" id="btnCloseCard" type="button" aria-label="Close">✕</button>
      <h2>${lake.name}</h2>
      <div class="county">${lake.county || ""}${lake.county2 ? " / " + lake.county2 : ""} · ${lake.has_contours ? "Vector contours" : "PDF map only"}</div>
      <div class="stats">
        <div><strong>Max depth</strong>${maxD}</div>
        <div><strong>Acres</strong>${acres}</div>
        <div><strong>Contour interval</strong>${interval}</div>
        <div><strong>Survey</strong>${survey}</div>
      </div>
      <div class="actions">${actions}</div>
      <div id="nearbyLaunches" class="nearby-launches"></div>
      <p class="source">${lake.source || ""} · <a href="${lake.source_url}" target="_blank" rel="noopener">source</a><br/>${lake.precision_note || ""}</p>
    `;
    card.classList.remove("hidden");
    document.getElementById("btnCloseCard").onclick = () =>
      card.classList.add("hidden");
    const next = document.getElementById("btnNextNearest");
    if (next) next.onclick = () => goNextNearest(lake);
    const th = document.getElementById("btnTrollHere");
    if (th)
      th.onclick = () => {
        if (lake.lat != null) {
          map.setView([lake.lat, lake.lng], 17);
        }
        startTrolling({ simulateAt: lake });
      };
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
              <span class="nearby-name">${escapeHtml(x.name)}</span>
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
      if (!l.has_contours || l.lat == null) continue;
      const m = L.circleMarker([l.lat, l.lng], {
        radius: 5,
        color: "#0b3d5c",
        weight: 1,
        fillColor: "#3aa0d8",
        fillOpacity: 0.9,
      });
      m.bindTooltip(l.name, { direction: "top", opacity: 0.9 });
      m.on("click", () => selectLake(l, false));
      lakeMarkers.addLayer(m);
    }
  }

  function styleContour(feature) {
    const d = feature.properties.depth_ft;
    const index = feature.properties.line_type === "INDEX";
    const z = map.getZoom();
    const base = z >= 18 ? 3.2 : z >= 16 ? 2.4 : z >= 14 ? 1.8 : 1.3;
    return {
      color: depthColor(d),
      weight: index ? base + 0.8 : base,
      opacity: 0.98,
      lineJoin: "round",
      lineCap: "round",
    };
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

  async function loadData() {
    const [lakesGj, contoursGj, sources, launchesGj] = await Promise.all([
      fetch("./data/lakes.geojson").then((r) => r.json()),
      fetch("./data/contours.geojson").then((r) => r.json()),
      fetch("./data/sources.json").then((r) => r.json()).catch(() => null),
      fetch("./data/launches.geojson").then((r) => r.json()).catch(() => null),
    ]);

    lakes = lakesGj.features.map((f) => {
      const p = f.properties;
      const g = f.geometry;
      return {
        ...p,
        lat: g ? g.coordinates[1] : null,
        lng: g ? g.coordinates[0] : null,
      };
    });

    contourLayer = L.geoJSON(contoursGj, {
      style: styleContour,
      // crisp vectors at all zooms
      renderer: L.canvas({ padding: 0.5 }),
    }).addTo(map);

    // Only show contours when reasonably zoomed
    const syncContourVis = () => {
      const z = map.getZoom();
      if (z >= 11) {
        if (!map.hasLayer(contourLayer)) contourLayer.addTo(map);
        contourLayer.setStyle(styleContour);
      } else if (map.hasLayer(contourLayer)) {
        map.removeLayer(contourLayer);
      }
      updateLabels();
      lakeMarkers.eachLayer((m) => {
        if (z >= 13) m.setStyle({ radius: 4, opacity: 0.35, fillOpacity: 0.35 });
        else m.setStyle({ radius: 5, opacity: 1, fillOpacity: 0.9 });
      });
    };
    map.on("zoomend moveend", syncContourVis);
    syncContourVis();

    placeLakeMarkers();
    if (launchesGj && launchesGj.features) {
      launches = launchesGj.features.map((f) => {
        const p = f.properties || {};
        const g = f.geometry;
        return {
          ...p,
          lat: p.lat != null ? p.lat : g ? g.coordinates[1] : null,
          lng: p.lng != null ? p.lng : g ? g.coordinates[0] : null,
        };
      }).filter((x) => x.lat != null && x.lng != null);
      placeLaunchMarkers();
      console.info("Launches:", launchesGj.properties && launchesGj.properties.counts);
    }
    renderLakeList();
    if (sources) {
      console.info("Data sources:", sources);
    }
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

  function onTrollPosition(pos) {
    const { latitude: lat, longitude: lng, speed, heading } = pos.coords;
    troll.lat = lat;
    troll.lng = lng;
    if (speed != null && !Number.isNaN(speed)) {
      troll.speedMph = Math.max(0, speed * 2.23694);
    }
    if (heading != null && !Number.isNaN(heading)) {
      troll.heading = heading;
    }
    // derive speed/heading from track if GPS doesn't provide
    if (troll.track.length) {
      const prev = troll.track[troll.track.length - 1];
      const d = haversineM(prev, [lat, lng]);
      if (d > 1.5) {
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
    if (troll.follow) {
      map.panTo([lat, lng], { animate: true, duration: 0.4 });
    }

    const depthInfo = nearestContourDepth(lat, lng);
    document.getElementById("trollSpeed").textContent =
      troll.speedMph != null ? troll.speedMph.toFixed(1) : "—";
    document.getElementById("trollHeading").textContent =
      troll.heading != null ? Math.round(troll.heading) : "—";
    document.getElementById("trollDepth").textContent = depthInfo
      ? `~${depthInfo.depth}`
      : "—";
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
        });
      }
    } catch (e) {
      console.warn("Wake lock unavailable", e);
    }
  }

  async function releaseWakeLock() {
    try {
      if (wakeLock) await wakeLock.release();
    } catch (_) {}
    wakeLock = null;
  }

  function startTrolling(opts = {}) {
    troll.on = true;
    document.body.classList.add("trolling");
    document.getElementById("trollHud").classList.remove("hidden");
    document.getElementById("btnTroll").classList.add("active");
    document.getElementById("lakeCard").classList.add("hidden");
    requestWakeLock();

    if (opts.simulateAt) {
      troll.simulate = true;
      const lake = opts.simulateAt;
      // Simulate boat near lake center for screenshots / demos
      let lat = lake.lat;
      let lng = lake.lng;
      let heading = 35;
      let tick = 0;
      if (troll._simTimer) clearInterval(troll._simTimer);
      // seed track
      troll.track = [];
      const step = () => {
        tick++;
        heading = (heading + (Math.sin(tick / 8) * 4)) % 360;
        const m = 4; // ~4 m per tick
        const dLat = (m / 111320) * Math.cos((heading * Math.PI) / 180);
        const dLng =
          (m / (111320 * Math.cos((lat * Math.PI) / 180))) *
          Math.sin((heading * Math.PI) / 180);
        lat += dLat;
        lng += dLng;
        onTrollPosition({
          coords: {
            latitude: lat,
            longitude: lng,
            speed: 1.3, // ~2.9 mph in m/s
            heading,
            accuracy: 5,
          },
        });
      };
      step();
      troll._simTimer = setInterval(step, 1000);
      if (map.getZoom() < 17) map.setView([lake.lat, lake.lng], 18);
      toast("Trolling mode (demo GPS) — depth from nearest survey contour");
      return;
    }

    troll.simulate = false;
    if (!navigator.geolocation) {
      toast("Geolocation not available — use Troll here on a lake for demo");
      return;
    }
    troll.watchId = navigator.geolocation.watchPosition(
      onTrollPosition,
      (err) => toast("GPS: " + err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
    // DeviceOrientation for heading fallback
    const onOrient = (e) => {
      if (e.absolute || e.webkitCompassHeading != null) {
        const h =
          e.webkitCompassHeading != null
            ? e.webkitCompassHeading
            : (360 - e.alpha) % 360;
        troll.heading = h;
      }
    };
    window.addEventListener("deviceorientationabsolute", onOrient, true);
    window.addEventListener("deviceorientation", onOrient, true);
    troll._onOrient = onOrient;
    toast("Trolling mode — follow me + wake lock");
  }

  function stopTrolling() {
    troll.on = false;
    document.body.classList.remove("trolling");
    document.getElementById("trollHud").classList.add("hidden");
    document.getElementById("btnTroll").classList.remove("active");
    if (troll.watchId != null) {
      navigator.geolocation.clearWatch(troll.watchId);
      troll.watchId = null;
    }
    if (troll._simTimer) {
      clearInterval(troll._simTimer);
      troll._simTimer = null;
    }
    if (troll._onOrient) {
      window.removeEventListener("deviceorientationabsolute", troll._onOrient, true);
      window.removeEventListener("deviceorientation", troll._onOrient, true);
      troll._onOrient = null;
    }
    releaseWakeLock();
  }

  document.getElementById("btnTroll").addEventListener("click", () => {
    if (troll.on) stopTrolling();
    else {
      // Prefer selected lake for demo if no GPS yet
      if (selectedLake && selectedLake.has_contours) {
        startTrolling({ simulateAt: selectedLake });
      } else {
        startTrolling();
      }
    }
  });
  document.getElementById("btnExitTroll").addEventListener("click", stopTrolling);
  document.getElementById("followMe").addEventListener("change", (e) => {
    troll.follow = e.target.checked;
  });
  document.getElementById("btnClearTrack").addEventListener("click", () => {
    troll.track = troll.lat != null ? [[troll.lat, troll.lng]] : [];
    updateTrack();
  });

  document.getElementById("btnSearch").addEventListener("click", () => {
    const panel = document.getElementById("panel");
    openPanel(panel.classList.contains("hidden"));
  });
  document.getElementById("btnClosePanel").addEventListener("click", () => openPanel(false));
  document.getElementById("lakeSearch").addEventListener("input", renderLakeList);
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
  window.__mfa = {
    map,
    selectLakeByName(name) {
      const l = lakes.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (l) selectLake(l, true);
      return !!l;
    },
    startTrollDemo(name) {
      const l = lakes.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!l) return false;
      selectLake(l, false);
      map.setView([l.lat, l.lng], 18);
      startTrolling({ simulateAt: l });
      return true;
    },
    getLakes: () => lakes,
    getLaunches: () => launches,
    setLaunchesVisible,
  };

  loadData().catch((e) => {
    console.error(e);
    toast("Failed to load lake data");
  });
})();
