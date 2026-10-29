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

  function open(on) {
    panel.classList.toggle("hidden", !on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    btn.classList.toggle("active", on);
    if (on && lakePanel) lakePanel.classList.add("hidden");
  }
  btn.addEventListener("click", () => open(panel.classList.contains("hidden")));
  document.getElementById("btnCloseTools").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.classList.contains("hidden")) open(false);
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
  window.mfaTools = { addSection, open, cardSection };
})();
