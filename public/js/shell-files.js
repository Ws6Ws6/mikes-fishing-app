/* Files the service worker keeps for offline use (shared by sw.js and offline.js). */
(function (g) {
  g.MFA_SHELL_VERSION = "2026-11-10y";
  // Shell cache may be replaced on a version bump. Data, contour shards, and
  // per-lake tile caches must survive a bump so saved lakes still work offline.
  g.MFA_SHELL_CACHE = "mfa-shell-" + g.MFA_SHELL_VERSION;
  g.MFA_DATA_CACHE = "mfa-data-v1";
  g.MFA_RUNTIME_LEGACY = "mfa-runtime-v1";
  g.MFA_TILE_PREFIX = "mfa-tiles-";
  g.MFA_SHELL = [
    "./",
    "./index.html",
    "./app.js",
    "./styles.css",
    "./favicon.svg",
    "./favicon.ico",
    "./vendor/leaflet/leaflet.css",
    "./vendor/leaflet/leaflet.js",
    "./vendor/leaflet.markercluster/MarkerCluster.css",
    "./vendor/leaflet.markercluster/MarkerCluster.Default.css",
    "./vendor/leaflet.markercluster/leaflet.markercluster.js",
    "./js/shell-files.js",
    "./js/tools.js",
    "./js/offline.js",
    "./js/gpx.js",
    "./js/waypoints.js",
    "./js/tracks.js",
    "./js/weather.js",
    "./js/radar.js",
    "./vendor/suncalc/suncalc.js",
    "./js/sunmoon.js",
    "./js/dnrfish.js",
    "./js/regs.js",
    "./js/launchfilter.js",
    "./js/depthband.js",
    "./js/install.js",
    "./manifest.webmanifest",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-maskable-192.png",
    "./icons/icon-maskable-512.png",
    "./icons/apple-touch-icon.png",
  ];
  g.MFA_DATA = [
    "./data/lakes.geojson",
    "./data/launches.geojson",
    "./data/sources.json",
    "./data/dnr_fish.json",
    "./data/regs.json",
    "./data/launch_attrs.json",
  ];
  g.MFA_CDN = [];
})(typeof self !== "undefined" ? self : window);
