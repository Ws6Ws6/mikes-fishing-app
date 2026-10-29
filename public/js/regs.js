/* Fishing regulations per lake (Feature 7).
 * data/regs.json quotes the official 2026-2027 Indiana Fishing Regulations Guide (published by Indiana DNR
 * on eRegulations, linked from in.gov/dnr) word for word: the statewide size & bag table plus the
 * lake-specific entries from the guide's special-regulation lists. Nothing is paraphrased into a rule. */
(function () {
  "use strict";
  const T = window.mfaTools;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  let dataP = null;
  const load = () => (dataP = dataP || fetch("./data/regs.json").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).catch((e) => { dataP = null; throw e; }));
  const cite = (x, g) => `<cite class="reg-cite">— ${link(x.url, (x.url.includes("eregulations") ? g.title + ": " : "") + x.page)}${x.page_updated ? ` (page updated ${esc(x.page_updated)})` : ""}</cite>`;

  function render(body, summary, lake, R) {
    const g = R.guide, sp = R.special[lake.id] || [];
    let h = "";
    if (sp.length) {
      summary.textContent = `📜 Regulations · special rule${sp.length > 1 ? "s" : ""} here`;
      h += `<p class="reg-h"><strong>Lake-specific rules</strong> (quoted from the official guide):</p>` +
        sp.map((x) => `<blockquote class="reg-quote">${x.label ? `<span class="reg-label">${esc(x.label)}:</span> ` : ""}“${esc(x.quote)}”${x.items ? `<ul class="reg-items">${x.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}${cite(x, g)}</blockquote>`).join("");
    } else {
      summary.textContent = "📜 Regulations · statewide limits";
      h += `<p class="reg-h">No lake-specific rule for ${esc(lake.name)} in the ${esc(g.year)} guide's special-regulation lists — statewide limits apply.</p>`;
    }
    const S = R.statewide;
    h += `<details class="reg-state"><summary>${esc(S.title)} (${esc(g.year)})</summary>
      <table class="reg-table"><thead><tr><th scope="col">Species</th><th scope="col">Daily bag</th><th scope="col">Minimum size</th></tr></thead><tbody>
      ${S.rows.map((r) => `<tr><td>${esc(r.species)}</td><td>${esc(r.bag)}</td><td>${esc(r.size)}</td></tr>`).join("")}</tbody></table>
      <ol class="reg-foot">${S.footnotes.map((f) => `<li value="${f.n}">${esc(f.text)}</li>`).join("")}</ol>
      <p class="reg-p">“${esc(S.possession)}”</p>
      ${R.extras.map((x) => `<p class="reg-p">“${esc(x.quote)}” <span class="reg-src">(${link(x.url, x.page)})</span></p>`).join("")}
      <p class="sec-src">Quoted from ${link(S.url, g.title + " — Size & Bag Limits")} (page updated ${esc(S.page_updated)}).</p></details>`;
    h += `<div class="tool-row reg-links">${link(g.dnr_url, "DNR regulations guide")}${link(g.online_url, "Full guide online")}${link(g.pdf_url, "Guide PDF")}</div>`;
    h += `<p class="sec-src">${esc(g.note)} Quotes retrieved ${esc(R.retrieved)}; always check the current guide before keeping fish.</p>`;
    body.innerHTML = h;
  }
  document.addEventListener("mfa:lakecard", (e) => {
    const lake = e.detail.lake;
    if (!lake || !lake.id) return;
    const { body, summary } = T.cardSection(e.detail.extras, { id: "secRegs", title: "📜 Regulations", order: 40 });
    body.innerHTML = `<p class="sec-src">Loading regulations…</p>`;
    load().then((R) => { if (body.isConnected) render(body, summary, lake, R); }).catch((err) => {
      summary.textContent = "📜 Regulations (link only)";
      body.innerHTML = `<p>Regulation details unavailable right now (${esc(err.message)}). ${link("https://www.in.gov/dnr/fish-and-wildlife/fishing/fishing-guide-and-regulations/", "Open the Indiana DNR fishing regulations guide")}.</p>`;
    });
  });
  window.mfaRegs = { load };
})();
