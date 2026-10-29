/* Files the service worker keeps for offline use (shared by sw.js and offline.js). */
(function (g) {
  g.MFA_SHELL_VERSION = "2026-10-29b";
  g.MFA_SHELL = [
    "./",
    "./index.html",
    "./app.js",
    "./styles.css",
    "./favicon.svg",
    "./js/shell-files.js",
    "./js/tools.js",
    "./js/offline.js",
    "./js/gpx.js",
    "./js/waypoints.js",
  ];
  g.MFA_DATA = [
    "./data/lakes.geojson",
    "./data/contours.geojson",
    "./data/launches.geojson",
    "./data/sources.json",
  ];
  g.MFA_CDN = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
    "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css",
    "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
  ];
})(typeof self !== "undefined" ? self : window);
