/* Tools menu: one tidy panel that hosts the extra features (offline maps, basemaps,
 * waypoints, tracks, launch filters, depth range, install). Each feature module
 * registers a collapsible section with window.mfaTools.addSection(). */
(function () {
  "use strict";
  const btn = document.getElementById("btnTools");
  const panel = document.getElementById("toolsPanel");
  const body = document.getElementById("toolsBody");
  const lakePanel = document.getElementById("panel");
  if (!btn || !panel || !body) return;

  let lastFocus = null;
  function focusables(root) {
    return [...root.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
  }
  function open(on) {
    panel.classList.toggle("hidden", !on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    btn.classList.toggle("active", on);
    if (on && lakePanel) lakePanel.classList.add("hidden");
    if (on) {
      lastFocus = document.activeElement;
      const close = document.getElementById("btnCloseTools");
      requestAnimationFrame(() => { try { (close || panel).focus(); } catch (_) {} });
    } else if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (_) {}
    }
  }
  btn.addEventListener("click", () => open(panel.classList.contains("hidden")));
  document.getElementById("btnCloseTools").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => {
    if (panel.classList.contains("hidden")) return;
    if (e.key === "Escape") { open(false); return; }
    if (e.key !== "Tab") return;
    const els = focusables(panel);
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Opening the lake list closes Tools (only one sheet at a time).
  const search = document.getElementById("btnSearch");
  if (search) search.addEventListener("click", () => open(false));
  if (window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.disableScrollPropagation(panel);
  }

  const sections = [];
  function addSection({ id, title, order = 50, open: startOpen = false }) {
    const d = document.createElement("details");
    d.className = "tool-section";
    d.id = id;
    d.dataset.order = order;
    if (startOpen) d.open = true;
    const s = document.createElement("summary");
    s.textContent = title;
    s.setAttribute("aria-label", title);
    const content = document.createElement("div");
    content.className = "tool-body";
    d.append(s, content);
    sections.push(d);
    sections.sort((a, b) => a.dataset.order - b.dataset.order);
    sections.forEach((x) => body.appendChild(x));
    return content;
  }
  // Collapsible section inside the lake card's extras box, kept in `order`.
  function cardSection(extras, { id, title, order = 50, open: startOpen = false }) {
    const d = document.createElement("details");
    d.className = "card-sec";
    d.id = id;
    d.dataset.order = order;
    if (startOpen) d.open = true;
    const s = document.createElement("summary");
    s.textContent = title;
    const content = document.createElement("div");
    content.className = "sec-body";
    d.append(s, content);
    const after = [...extras.children].find((c) => +(c.dataset.order || 50) > order);
    extras.insertBefore(d, after || null);
    return { details: d, body: content, summary: s };
  }
  const about = addSection({ id: "toolAbout", title: "ℹ About & sources", order: 90 });
  about.innerHTML = `<p class="tool-note">Depth lines: Indiana DNR surveys (IndianaMap) and DNR depth-map PDFs; a few Indiana lakes are unofficial traces of 1922–1954 Indiana Dept. of Conservation / USGS maps (marked on each lake); Salamonie Lake has unofficial lines from USGS lidar, measured from summer pool. Michigan lakes use official Michigan DNR Inland Lake Contours (State of Michigan Open Data; DEPTH in feet). That Michigan GIS record has no restrictions on use, reproduction, or distribution and is provided as-is. Lake outlines: USGS NHD, OpenStreetMap, and State of Michigan lake polygons. Launches: Indiana DNR, IndianaMap, OpenStreetMap, and Michigan DNR Parks and Recreation boating access sites (MiBFF), also a public record with no use restrictions, provided as-is.</p>
    <p class="tool-note">Depths are feet below the surface on the survey date — not live sonar.</p>`;

  window.mfaTools = { addSection, open, cardSection };
})();
