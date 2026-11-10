/* Mike's Fishing App service worker.
 * - App files + lake data: network-first, cached copy used when offline.
 * - Leaflet/markercluster from unpkg (versioned URLs): cache-first.
 * - USGS National Map tiles (public domain) saved per lake by "Save lake for offline":
 *   served from those caches when present. Viewed tiles are NOT bulk-cached.
 * - OpenStreetMap and Esri tiles are never cached here (OSM tile policy forbids
 *   bulk downloading; Esri imagery terms do not allow offline caching).
 */
importScripts("./js/shell-files.js");
const SHELL = self.MFA_SHELL_CACHE;
const DATA = self.MFA_DATA_CACHE;
const LEGACY = self.MFA_RUNTIME_LEGACY;
const TILE_PREFIX = self.MFA_TILE_PREFIX || "mfa-tiles-";

function cacheNameFor(url) {
  try {
    const p = new URL(url, self.location.origin).pathname;
    if (p === "/data" || p.startsWith("/data/")) return DATA;
  } catch (_) {}
  return SHELL;
}

function putInCache(key, res) {
  caches.open(cacheNameFor(key)).then((c) => c.put(key, res));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then(async (c) => {
      // Shell + CDN only; lake data and contour shards are cached as the app
      // loads them (into MFA_DATA_CACHE, which survives a shell version bump).
      await Promise.all(
        self.MFA_SHELL.concat(self.MFA_CDN).map((u) =>
          fetch(u).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null)
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Only drop previous shell caches. Never delete mfa-data-*, mfa-tiles-*,
  // or the legacy mfa-runtime-v1 cache (saved contours and lake data live there).
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("mfa-shell-") && k !== SHELL)
          .map((k) => caches.delete(k))
      )
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
              putInCache(req.url, copy);
            }
            return res;
          })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // NWS, OSM, Esri, DNR… go straight to the network.

  const isNav = req.mode === "navigate";
  const path = url.pathname;
  const isSeoDoc = /(?:^|\/)lakes\//.test(path) || /(?:^|\/)404\.html$/.test(path);
  // Static /lakes/ pages and 404.html must never be served the map SPA shell.
  if (isNav && isSeoDoc) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            putInCache(url.origin + path, copy);
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(url.origin + path);
          if (hit) return hit;
          return new Response("<h1>Offline</h1><p>This directory page is not saved for offline use. Open the map home page instead.</p>", {
            status: 503,
            headers: { "Content-Type": "text/html" },
          });
        })
    );
    return;
  }
  if (!isNav && !isCacheableSameOrigin(url)) return;
  // Cache key without the query string so ?v=… cache-busters still hit offline.
  const key = isNav ? new URL("./", self.registration.scope).href : url.origin + url.pathname;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          putInCache(key, copy);
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
