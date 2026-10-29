/* Mike's Fishing App service worker.
 * - App files + lake data: network-first, cached copy used when offline.
 * - Leaflet/markercluster from unpkg (versioned URLs): cache-first.
 * - USGS National Map tiles (public domain) saved per lake by "Save lake for offline":
 *   served from those caches when present. Viewed tiles are NOT bulk-cached.
 * - OpenStreetMap and Esri tiles are never cached here (OSM tile policy forbids
 *   bulk downloading; Esri imagery terms do not allow offline caching).
 */
importScripts("./js/shell-files.js");
const RUNTIME = "mfa-runtime-v1";
const TILE_PREFIX = "mfa-tiles-";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(RUNTIME).then(async (c) => {
      // Shell + CDN only; the 17 MB data files are cached as the app loads them.
      await Promise.all(
        self.MFA_SHELL.concat(self.MFA_CDN).map((u) =>
          fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null)
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== RUNTIME && !k.startsWith(TILE_PREFIX) && k.startsWith("mfa-")).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isCacheableSameOrigin(url) {
  const p = url.pathname;
  return p === "/" || /\.(html|js|css|svg|png|json|geojson|webmanifest|txt)$/.test(p);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "basemap.nationalmap.gov" && url.pathname.includes("/tile/")) {
    event.respondWith(
      caches.match(req.url, { ignoreVary: true }).then((hit) => hit || fetch(req))
    );
    return;
  }

  if (url.hostname === "unpkg.com") {
    event.respondWith(
      caches.match(req.url).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok || res.type === "opaque") {
              const copy = res.clone();
              caches.open(RUNTIME).then((c) => c.put(req.url, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // NWS, OSM, Esri, DNR… go straight to the network.

  const isNav = req.mode === "navigate";
  if (!isNav && !isCacheableSameOrigin(url)) return;
  // Cache key without the query string so ?v=… cache-busters still hit offline.
  const key = isNav ? new URL("./", self.registration.scope).href : url.origin + url.pathname;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = (await caches.match(key)) || (isNav ? await caches.match(new URL("./index.html", self.registration.scope).href) : null);
        if (hit) return hit;
        return new Response(isNav ? "<h1>Offline</h1><p>Open the app once while online, then save a lake for offline.</p>" : "", {
          status: 503,
          headers: { "Content-Type": isNav ? "text/html" : "text/plain" },
        });
      })
  );
});
