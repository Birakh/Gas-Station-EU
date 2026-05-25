// HTTPS is required for service workers.
// GitHub Pages provides HTTPS automatically.

// INCREMENT THIS TO v2, v3, etc. every time you push an update.
// Changing the name triggers the install event, which re-caches all assets,
// and the activate event, which deletes the old cache.
const CACHE_NAME = 'atsprit-v1';

// Assets to pre-cache on install.
// These exact CDN URLs must match what index.html loads.
// If you update Leaflet or Chart.js versions in index.html, update them here too.
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  // Leaflet 1.9.4 — must match index.html <link> and <script> src exactly
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  // Chart.js 4.4.1 — must match index.html <script> src exactly
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// ── Install: open the cache and add all precache URLs ──────────────────────
// waitUntil keeps the service worker alive until caching completes.
// If any URL fails to fetch, the entire install fails — the old SW stays active.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
});

// ── Activate: delete every cache that doesn't match CACHE_NAME ─────────────
// This runs after the new SW takes control, removing stale v1/v2/etc. caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
});

// ── Fetch: two strategies depending on the request URL ─────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Strategy A — Network first, cache fallback
  // Used for ./data/ paths (stations.json, brent.json, history/*.json).
  // Rationale: stale fuel prices are actively misleading; always prefer fresh data.
  // Only fall back to cache if the network request fails entirely (user is offline).
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Clone before consuming: Response body can only be read once.
          // Store the fresh response in cache while also returning it to the page.
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return networkResponse;
        })
        .catch(() => {
          // Network failed — try cache. If the cache also misses, the page's
          // own error handling will show the "Failed to load data" message.
          return caches.match(event.request);
        })
    );
    return;
  }

  // Strategy B — Cache first, network fallback
  // Used for everything else: index.html, CDN assets, manifest.json.
  // Rationale: these assets change only on deploy (SW version bump handles invalidation).
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      // Not in cache — fetch from network and cache for next time.
      return fetch(event.request).then((networkResponse) => {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
      // If both cache and network fail, the browser shows its own offline error.
      // index.html is pre-cached so this only affects uncached runtime requests.
    })
  );
});
