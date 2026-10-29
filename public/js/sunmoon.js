/* Feature 5 — Sunrise, sunset and moon for the selected lake, calculated on the
 * device with SunCalc 1.9.0 (vendor/suncalc, BSD-2-Clause, (c) Vladimir Agafonkin) for the
 * sun and moon phase; moonrise/moonset use the more accurate lunar series below.
 * No network needed. Times shown in this device's time zone. */
(function () {
  "use strict";
  const M = window.__mfa, T = window.mfaTools, S = window.SunCalc;
  if (!M || !T || !S) return;
  const esc = M.escapeHtml;
  const tf = (d) => (d instanceof Date && !isNaN(d) ? new Date(Math.round(d / 60000) * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null); // nearest minute
  const tz = () => new Date().toLocaleTimeString([], { timeZoneName: "short" }).split(" ").pop();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const PH = 1 / 29.530588; // one day as a fraction of the synodic month
  function phaseName(p) {
    if (p < PH || p > 1 - PH) return ["New moon", "🌑"];
    if (Math.abs(p - 0.25) < PH) return ["First quarter", "🌓"];
    if (Math.abs(p - 0.5) < PH) return ["Full moon", "🌕"];
    if (Math.abs(p - 0.75) < PH) return ["Last quarter", "🌗"];
    if (p < 0.25) return ["Waxing crescent", "🌒"];
    if (p < 0.5) return ["Waxing gibbous", "🌔"];
    if (p < 0.75) return ["Waning gibbous", "🌖"];
    return ["Waning crescent", "🌘"];
  }
  // Next time the phase fraction crosses `target` (0 = new, 0.5 = full), hourly steps.
  function nextPhase(from, target) {
    let prev = S.getMoonIllumination(from).phase;
    for (let h = 1; h <= 24 * 31; h++) {
      const t = new Date(from.getTime() + h * 3600e3), p = S.getMoonIllumination(t).phase;
      const crossed = target === 0 ? p < prev : prev < target && p >= target;
      if (crossed) return t;
      prev = p;
    }
    return null;
  }
  // ---- Moonrise / moonset: SunCalc's simplified lunar model can be ~10+ min off, so
  // rise/set use Paul Schlyter's lunar theory (main perturbation terms, ~2' accuracy)
  // with topocentric parallax, semidiameter and 34' refraction (USNO convention).
  const RD = Math.PI / 180, sind = (x) => Math.sin(x * RD), cosd = (x) => Math.cos(x * RD);
  const rev = (x) => x - Math.floor(x / 360) * 360;
  function moonEq(jd) {
    const d = jd - 2451543.5;
    const N = rev(125.1228 - 0.0529538083 * d), i = 5.1454, w = rev(318.0634 + 0.1643573223 * d);
    const a = 60.2666, e = 0.0549, Mm = rev(115.3654 + 13.0649929509 * d);
    const ws = 282.9404 + 4.70935e-5 * d, Ms = rev(356.047 + 0.9856002585 * d);
    let E = Mm + (e / RD) * sind(Mm) * (1 + e * cosd(Mm));
    for (let k = 0; k < 5; k++) E = E - (E - (e / RD) * sind(E) - Mm) / (1 - e * cosd(E));
    const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
    const v = Math.atan2(yv, xv) / RD;
    let r = Math.sqrt(xv * xv + yv * yv);
    const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    const zh = r * sind(v + w) * sind(i);
    let lon = Math.atan2(yh, xh) / RD, lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) / RD;
    const Ls = Ms + ws, Lm = Mm + w + N, D = Lm - Ls, F = Lm - N;
    lon += -1.274 * sind(Mm - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms) - 0.059 * sind(2 * Mm - 2 * D)
      - 0.057 * sind(Mm - 2 * D + Ms) + 0.053 * sind(Mm + 2 * D) + 0.046 * sind(2 * D - Ms) + 0.041 * sind(Mm - Ms)
      - 0.035 * sind(D) - 0.031 * sind(Mm + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(Mm - 4 * D);
    lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(Mm - F - 2 * D) - 0.046 * sind(Mm + F - 2 * D)
      + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * Mm + F);
    r += -0.58 * cosd(Mm - 2 * D) - 0.46 * cosd(2 * D);
    const ecl = 23.4393 - 3.563e-7 * d;
    const xg = r * cosd(lon) * cosd(lat), yg = r * sind(lon) * cosd(lat), zg = r * sind(lat);
    const ye = yg * cosd(ecl) - zg * sind(ecl), ze = yg * sind(ecl) + zg * cosd(ecl);
    return { ra: Math.atan2(ye, xg) / RD, dec: Math.atan2(ze, Math.sqrt(xg * xg + ye * ye)) / RD, r };
  }
  // Apparent altitude of the moon's upper limb above the horizon (degrees, + = visible).
  function moonLimbAlt(t, lat, lng) {
    const jd = t / 86400000 + 2440587.5;
    const m = moonEq(jd);
    const gmst = rev(280.46061837 + 360.98564736629 * (jd - 2451545));
    const H = gmst + lng - m.ra;
    const h = Math.asin(sind(lat) * sind(m.dec) + cosd(lat) * cosd(m.dec) * cosd(H)) / RD;
    const par = Math.asin(1 / m.r) / RD;
    return h - par * cosd(h) + 0.2725 * par + 0.5667;
  }
  function moonRiseSet(dayStart, lat, lng) {
    const out = { rise: null, set: null };
    const step = 10 * 60000, end = dayStart.getTime() + 86400000;
    let t0 = dayStart.getTime(), f0 = moonLimbAlt(t0, lat, lng), anyUp = f0 > 0, anyDown = f0 <= 0;
    for (let t1 = t0 + step; t1 <= end; t1 += step) {
      const f1 = moonLimbAlt(t1, lat, lng);
      if (f1 > 0) anyUp = true; else anyDown = true;
      if ((f0 <= 0) !== (f1 <= 0)) {
        let a = t0, b = t1, fa = f0;
        while (b - a > 5000) { const c = (a + b) / 2, fc = moonLimbAlt(c, lat, lng); if ((fa <= 0) === (fc <= 0)) { a = c; fa = fc; } else b = c; }
        const when = new Date(Math.round((a + b) / 2));
        if (f0 <= 0 && !out.rise) out.rise = when; else if (f0 > 0 && !out.set) out.set = when;
      }
      t0 = t1; f0 = f1;
    }
    if (!out.rise && !out.set) out[anyUp && !anyDown ? "alwaysUp" : "alwaysDown"] = true;
    return out;
  }
  const dfmt = (d) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  function dur(ms) { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)} h ${m % 60} min`; }

  function compute(lake, day) {
    const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0);
    const mid = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);
    const sun = S.getTimes(noon, lake.lat, lake.lng);
    const moon = moonRiseSet(mid, lake.lat, lake.lng);
    const ill = S.getMoonIllumination(noon);
    return { sun, moon, ill, noon };
  }
  function render(body, lake, day) {
    const { sun, moon, ill, noon } = compute(lake, day);
    const [pn, pe] = phaseName(ill.phase);
    const nf = nextPhase(noon, 0.5), nn = nextPhase(noon, 0);
    const row = (k, v) => `<tr><th scope="row">${k}</th><td>${v || "—"}</td></tr>`;
    const moonRise = moon.alwaysUp ? "Up all day" : moon.alwaysDown ? "Down all day" : tf(moon.rise) || "No moonrise this day";
    const moonSet = moon.alwaysUp || moon.alwaysDown ? "—" : tf(moon.set) || "No moonset this day";
    body.querySelector(".sm-out").innerHTML = `
      <table class="sm-table" aria-label="Sun and moon times">
        ${row("Sunrise", tf(sun.sunrise))}${row("Sunset", tf(sun.sunset))}
        ${row("First light (civil dawn)", tf(sun.dawn))}${row("Last light (civil dusk)", tf(sun.dusk))}
        ${row("Solar noon", tf(sun.solarNoon))}
        ${row("Daylight", sun.sunrise && sun.sunset && !isNaN(sun.sunrise) ? dur(sun.sunset - sun.sunrise) : "—")}
        ${row("Moonrise", esc(moonRise))}${row("Moonset", esc(moonSet))}
        ${row("Moon phase", `<span aria-hidden="true">${pe}</span> ${pn} · ${Math.round(ill.fraction * 100)}% lit`)}
        ${row("Next full moon", nf ? dfmt(nf) : "—")}${row("Next new moon", nn ? dfmt(nn) : "—")}
      </table>
      <div class="sec-src">Calculated on this device: sun and moon phase with <a href="https://github.com/mourner/suncalc" target="_blank" rel="noopener">SunCalc</a> 1.9.0 (BSD-2-Clause); moonrise/moonset with Schlyter\'s lunar series (topocentric). For ${lake.lat.toFixed(4)}, ${lake.lng.toFixed(4)} on ${esc(dfmt(day))}. Times in ${esc(tz())}; checked against the U.S. Naval Observatory to within about 2 minutes.</div>`;
  }
  document.addEventListener("mfa:lakecard", (e) => {
    const lake = e.detail.lake;
    if (!lake || !Number.isFinite(lake.lat) || !Number.isFinite(lake.lng)) return;
    const { body, summary } = T.cardSection(e.detail.extras, { id: "secSunMoon", title: "🌅 Sun & moon", order: 20 });
    body.innerHTML = `<div class="tool-row sm-date">
        <button type="button" class="tool-btn" data-sm="prev" aria-label="Previous day">‹</button>
        <input type="date" class="tool-input" id="smDate" aria-label="Date for sun and moon times" />
        <button type="button" class="tool-btn" data-sm="next" aria-label="Next day">›</button>
        <button type="button" class="tool-btn" data-sm="today" aria-label="Today">Today</button></div>
      <div class="sm-out"></div>`;
    const inp = body.querySelector("#smDate");
    let day = new Date();
    const set = (d) => {
      day = d; inp.value = ymd(d); render(body, lake, d);
      const { sun } = compute(lake, d);
      const today = ymd(d) === ymd(new Date());
      summary.textContent = `🌅 ${today ? "" : dfmt(d) + ": "}Sunrise ${tf(sun.sunrise) || "—"} · Sunset ${tf(sun.sunset) || "—"}`;
    };
    inp.addEventListener("change", () => { const [y, m, dd] = inp.value.split("-").map(Number); if (y) set(new Date(y, m - 1, dd)); });
    body.querySelector('[data-sm="prev"]').onclick = () => set(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1));
    body.querySelector('[data-sm="next"]').onclick = () => set(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
    body.querySelector('[data-sm="today"]').onclick = () => set(new Date());
    set(day);
  });
  window.mfaSunMoon = { compute, phaseName, nextPhase };
})();
