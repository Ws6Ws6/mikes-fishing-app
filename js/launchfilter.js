/* Launch filters (Feature 8): launch type, ramp surface, parking, fee, ADA.
 * Attributes come only from the Indiana DNR Fishing Access Sites layer (data/launch_attrs.json,
 * joined by DNR accessid). A value DNR did not record stays "unknown": an active filter never
 * treats unknown as a match unless "Include unknown" is ticked. Launches from non-DNR sources
 * (IndianaMap, OpenStreetMap) have no DNR attributes, so they count as unknown. */
(function () {
  "use strict";
  const T = window.mfaTools, M = () => window.__mfa;
  const KEY = "mfa.launchFilter";
  const LABEL = {
    type: { boat_ramp: "Boat ramp", carry_down: "Carry-down", canoe_ramp: "Canoe/kayak ramp", shoreline: "Shoreline" },
    surface: { concrete: "Concrete", gravel: "Gravel", dirt: "Dirt", concrete_gravel: "Concrete & gravel", other: "Other" },
    parking: { lot: "Parking lot", pull_off: "Pull-off", none: "No parking" },
    fee: { no: "No fee", yes: "Fee charged" },
    ada: { yes: "ADA accessible", no: "Not ADA accessible" },
  };
  const FIELDS = ["type", "surface", "parking", "fee", "ada"];
  const NAMES = { type: "Launch type", surface: "Ramp surface", parking: "Parking", fee: "Fee", ada: "ADA access" };
  let attrs = null, meta = null;
  let f = { type: "", surface: "", parking: "", fee: "", ada: "", unknown: false };
  try { Object.assign(f, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (_) {}
  const active = () => FIELDS.some((k) => f[k]);

  function attrOf(id) {
    const a = attrs && attrs[id];
    const o = { type: null, surface: null, parking: null, fee: null, ada: null, dnr: !!a };
    if (a) FIELDS.forEach((k, i) => (o[k] = a[i]));
    return o;
  }
  // value matches? "has_parking" = lot or pull-off.
  function matchOne(k, want, v) {
    if (v == null) return f.unknown; // unknown is never a yes
    if (k === "parking" && want === "any") return v === "lot" || v === "pull_off";
    return v === want;
  }
  function filter(l) {
    if (!active()) return true;
    const a = attrOf(l.id);
    return FIELDS.every((k) => !f[k] || matchOne(k, f[k], a[k]));
  }
  window.mfaLaunchFilter = (l) => filter(l);
  window.mfaLaunchAttrs = (l) => {
    const a = attrOf(l.id);
    return FIELDS.map((k) => `<div><strong>${NAMES[k]}</strong> ${a[k] == null ? '<span class="unk">unknown</span>' : LABEL[k][a[k]]}</div>`).join("") +
      `<div class="launch-attr-src">${a.dnr ? "Details: DNR Fishing Access Sites" : "No DNR access-site details for this launch"}</div>`;
  };

  let el, statEl;
  function counts() {
    const all = (M() && M().getLaunches && M().getLaunches()) || [];
    let shown = 0, unk = 0;
    for (const l of all) {
      if (filter(l)) shown++;
      else if (active()) { const a = attrOf(l.id); if (FIELDS.some((k) => f[k] && a[k] == null)) unk++; }
    }
    return { total: all.length, shown, unk };
  }
  function apply(save = true) {
    if (save) try { localStorage.setItem(KEY, JSON.stringify(f)); } catch (_) {}
    if (M() && M().refreshLaunches) M().refreshLaunches();
    const c = counts();
    if (statEl) statEl.textContent = active()
      ? `Showing ${c.shown} of ${c.total} launches. ${c.unk} hidden only because DNR didn't record that detail${f.unknown ? "" : " (tick “Include unknown” to show them)"}.`
      : `All ${c.total} launches shown. Pick a filter to narrow them.`;
    const b = document.getElementById("btnLaunchFilterBadge");
    if (b) b.hidden = !active();
  }
  function sel(k, opts) {
    return `<label class="lf-row"><span>${NAMES[k]}</span><select class="tool-input" data-lf="${k}" aria-label="${NAMES[k]} filter">
      <option value="">Any</option>${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>`;
  }
  function build() {
    el = T.addSection({ id: "toolLaunchFilter", title: "⚓ Launch filters", order: 25 });
    el.innerHTML =
      sel("type", Object.entries(LABEL.type)) +
      sel("surface", Object.entries(LABEL.surface)) +
      sel("parking", [["any", "Has parking (lot or pull-off)"], ...Object.entries(LABEL.parking)]) +
      sel("fee", Object.entries(LABEL.fee)) +
      sel("ada", [["yes", "ADA accessible"]]) +
      `<label class="tool-check"><input type="checkbox" id="lfUnknown" /> Include launches where DNR didn't record the detail (unknown)</label>
       <div class="tool-row"><button type="button" class="tool-btn" id="lfClear" aria-label="Clear launch filters">Clear filters</button></div>
       <p class="sec-src" id="lfStat" aria-live="polite"></p>
       <p class="sec-src" id="lfSrc"></p>`;
    statEl = el.querySelector("#lfStat");
    el.querySelectorAll("select[data-lf]").forEach((s) => {
      s.value = f[s.dataset.lf] || "";
      s.addEventListener("change", () => { f[s.dataset.lf] = s.value; apply(); });
    });
    const u = el.querySelector("#lfUnknown"); u.checked = !!f.unknown;
    u.addEventListener("change", () => { f.unknown = u.checked; apply(); });
    el.querySelector("#lfClear").onclick = () => { FIELDS.forEach((k) => (f[k] = "")); f.unknown = false; el.querySelectorAll("select[data-lf]").forEach((s) => (s.value = "")); u.checked = false; apply(); };
  }
  build();
  fetch("./data/launch_attrs.json").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then((d) => {
    attrs = d.launches; meta = d.meta;
    el.querySelector("#lfSrc").innerHTML = `Source: <a href="${meta.source_url}" target="_blank" rel="noopener">Indiana DNR Fishing Access Sites</a> (retrieved ${meta.retrieved}). Launches from other sources have no DNR details, so they count as unknown.`;
    apply(false);
  }).catch((e) => {
    attrs = {};
    el.querySelector("#lfSrc").textContent = `Launch details unavailable (${e.message}); every detail counts as unknown.`;
    apply(false);
  });
  document.addEventListener("mfa:data", () => apply(false));
  window.mfaLaunchFilters = { get: () => ({ ...f }), set: (o) => { Object.assign(f, o); el.querySelectorAll("select[data-lf]").forEach((s) => (s.value = f[s.dataset.lf] || "")); el.querySelector("#lfUnknown").checked = !!f.unknown; apply(); }, counts, attrOf };
})();
