/* Small GPX 1.1 helpers shared by waypoints and tracks. */
(function () {
  "use strict";
  const xesc = (s) => String(s == null ? "" : s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  function doc(inner, name) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Mike's Fishing App (mikesfishingapp.com)" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${xesc(name || "Mike's Fishing App export")}</name><time>${new Date().toISOString()}</time></metadata>\n${inner}</gpx>\n`;
  }
  function wpt(w) {
    return `<wpt lat="${(+w.lat).toFixed(7)}" lon="${(+w.lng).toFixed(7)}">${w.time ? `<time>${xesc(w.time)}</time>` : ""}<name>${xesc(w.name)}</name>${w.notes ? `<desc>${xesc(w.notes)}</desc>` : ""}</wpt>\n`;
  }
  function trk(t) {
    const pts = t.points
      .map((p) => `<trkpt lat="${(+p.lat).toFixed(7)}" lon="${(+p.lng).toFixed(7)}"><time>${new Date(p.t).toISOString()}</time>${p.spd != null ? `<extensions><speed>${(+p.spd).toFixed(2)}</speed></extensions>` : ""}</trkpt>`)
      .join("\n");
    return `<trk><name>${xesc(t.name)}</name><trkseg>\n${pts}\n</trkseg></trk>\n`;
  }
  function download(filename, text) {
    const blob = new Blob([text], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function parse(text) {
    const d = new DOMParser().parseFromString(text, "application/xml");
    if (d.querySelector("parsererror")) throw new Error("Not a valid GPX file");
    if (!d.documentElement || d.documentElement.localName !== "gpx") throw new Error("Not a GPX file");
    const txt = (el, tag) => { const x = el.getElementsByTagNameNS("*", tag)[0]; return x ? x.textContent.trim() : ""; };
    const wpts = [...d.getElementsByTagNameNS("*", "wpt")].map((el) => ({
      lat: parseFloat(el.getAttribute("lat")), lng: parseFloat(el.getAttribute("lon")),
      name: txt(el, "name"), notes: txt(el, "desc") || txt(el, "cmt"), time: txt(el, "time"),
    })).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng) && Math.abs(w.lat) <= 90 && Math.abs(w.lng) <= 180);
    return { wpts };
  }
  window.mfaGpx = { doc, wpt, trk, download, parse, xesc };
})();
