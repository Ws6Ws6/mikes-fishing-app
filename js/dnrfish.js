/* DNR fish survey & stocking per lake (Feature 6).
 * Data: data/dnr_fish.json, built offline from Indiana DNR Division of Fish & Wildlife open data
 * (Indiana Data Hub: Fish Surveys / Fish Records / Batch Fish Records, Waterbodies GIS layer),
 * the DNR Fishing Access Sites layer (report PDF links) and the DNR Fish Stocking Database dashboard.
 * Lakes are joined to DNR waterbodies by point-in-polygon (or <400 m) plus matching name and county.
 * Species shown come only from DNR survey catch records — nothing is inferred or invented. */
(function () {
  "use strict";
  const T = window.mfaTools;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let dataP = null;
  const load = () => (dataP = dataP || fetch("./data/dnr_fish.json").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).catch((e) => { dataP = null; throw e; }));
  const ds = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); };
  const len = (s) => (s.minL == null ? "—" : s.minL === s.maxL ? `${s.minL}″` : `${s.minL}–${s.maxL}″`);
  const pdfName = (u) => decodeURIComponent(u.split("/").pop()).replace(/^fw-/, "").replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
  const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;

  function speciesTable(sp, limit) {
    const rows = sp.map((s, i) => `<tr${i >= limit ? ' class="dnr-more" hidden' : ""}><td>${esc(s.name)}</td><td class="num">${s.n.toLocaleString()}</td><td class="num">${len(s)}</td></tr>`).join("");
    return `<table class="dnr-table"><thead><tr><th scope="col">Species</th><th scope="col" class="num">Collected</th><th scope="col" class="num">Length</th></tr></thead><tbody>${rows}</tbody></table>` +
      (sp.length > limit ? `<button type="button" class="tool-btn dnr-showall" aria-expanded="false">Show all ${sp.length} species</button>` : "");
  }
  function render(body, summary, lake, all) {
    const meta = all.meta, d = all.lakes[lake.id] || {};
    const src = meta.sources;
    const surveys = (d.surveys || []).filter((s) => s.species && s.species.length);
    const anySurvey = (d.surveys || []).length > 0;
    let h = "";
    if (!anySurvey) {
      summary.textContent = "🐟 DNR fish: no survey found";
      h += `<p class="dnr-none"><strong>No DNR survey found</strong> for this lake in the DNR fish survey data (2010–2025). Search DNR's reports: ${link(src.search.url, "Where to Fish Finder")}.</p>`;
    } else {
      const latest = surveys[0];
      summary.textContent = latest ? `🐟 DNR survey ${latest.start.slice(0, 4)} · ${latest.species.length} species` : `🐟 DNR survey ${d.surveys[0].start.slice(0, 4)}`;
      if (latest) {
        h += `<p class="dnr-h">Latest DNR survey with catch data: <strong>${esc(ds(latest.start))}</strong>${latest.end !== latest.start ? "–" + esc(ds(latest.end)) : ""} · ${esc(latest.type)}</p>`;
        h += speciesTable(latest.species, 8);
        h += `<p class="sec-src">"Collected" = fish caught in that survey's sample (all gears), not a population estimate.</p>`;
      } else h += `<p class="dnr-h">DNR surveyed this lake but published no catch records for it.</p>`;
      const older = d.surveys.filter((s) => s !== latest);
      if (older.length) h += `<details class="dnr-older"><summary>Other DNR surveys (${older.length})</summary><ul>${older.map((s) => `<li>${esc(ds(s.start))} · ${esc(s.type)} · ${s.species.length ? s.species.length + " species: " + s.species.slice(0, 6).map((x) => esc(x.name)).join(", ") + (s.species.length > 6 ? "…" : "") : "no catch records published"}</li>`).join("")}</ul></details>`;
    }
    if (d.reports && d.reports.length) h += `<p class="dnr-h">DNR reports</p><ul class="dnr-reports">${d.reports.map((u) => `<li>${link(u, pdfName(u))} (PDF)</li>`).join("")}</ul>`;
    if (d.stocking && d.stocking.length) {
      h += `<p class="dnr-h">DNR stocking (${d.stocking.length} record${d.stocking.length > 1 ? "s" : ""})</p><table class="dnr-table"><thead><tr><th scope="col">Year</th><th scope="col">Species</th><th scope="col" class="num">Number</th><th scope="col" class="num">Avg len</th></tr></thead><tbody>` +
        d.stocking.map((s) => `<tr><td>${s.year}</td><td>${esc(s.species)}</td><td class="num">${typeof s.qty === "number" ? s.qty.toLocaleString() : esc(s.qty)}</td><td class="num">${s.avg_len_in != null ? s.avg_len_in + "″" : "—"}</td></tr>`).join("") + "</tbody></table>";
    } else h += `<p class="dnr-h">No DNR stocking records for this lake in the ${link(src.stocking.url, "stocking database")} (2016–2026).</p>`;
    const wb = d.dnr_waterbody;
    h += `<p class="sec-src">Sources: ${link(src.surveys.url, src.surveys.name)}; ${link(src.stocking.url, "DNR Fish Stocking Database")}` +
      (d.reports ? `; report links from the ${link(src.reports.url, "DNR Fishing Access Sites layer")}` : "") +
      `. ${wb ? `Matched to DNR waterbody “${esc(wb.name)}” (${esc(wb.county)} Co., ${esc(wb.match)}; ${link(src.waterbodies.url, "DNR Waterbodies layer")}).` : "No matching DNR waterbody polygon."} Data built ${esc(meta.generated)}. ${link(src.search.url, "Search DNR survey reports")}.</p>`;
    body.innerHTML = h;
    const b = body.querySelector(".dnr-showall");
    if (b) b.onclick = () => { const open = b.getAttribute("aria-expanded") !== "true"; body.querySelectorAll(".dnr-more").forEach((r) => (r.hidden = !open)); b.setAttribute("aria-expanded", open); b.textContent = open ? "Show fewer" : `Show all ${body.querySelectorAll(".dnr-table tbody tr").length - (d.stocking ? d.stocking.length : 0)} species`; };
  }
  document.addEventListener("mfa:lakecard", (e) => {
    const lake = e.detail.lake;
    if (!lake || !lake.id) return;
    const { body, summary } = T.cardSection(e.detail.extras, { id: "secDnr", title: "🐟 DNR fish survey…", order: 30 });
    body.innerHTML = `<p class="sec-src">Loading DNR survey data…</p>`;
    load().then((all) => { if (body.isConnected) render(body, summary, lake, all); }).catch((err) => {
      summary.textContent = "🐟 DNR fish (unavailable)";
      body.innerHTML = `<p>DNR survey data unavailable right now${navigator.onLine === false ? " (offline — save the lake for offline to keep it)" : ""} (${esc(err.message)}). ${link("https://www.in.gov/dnr/fish-and-wildlife/fishing/where-to-fish-interactive-map", "Open DNR Where to Fish Finder")}.</p>`;
    });
  });
  window.mfaDnr = { load };
})();
