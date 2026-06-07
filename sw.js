// HTTPS is required for service workers.
// GitHub Pages provides HTTPS automatically.

// INCREMENT THIS when you push an update to force all users to get fresh assets.
// v3: cache-busting added to all data/ fetches; network-first enforced for /data/ URLs.
const CACHE_NAME = 'atsprit-v3';

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

// ── Install: pre-cache all static assets ──────────────────────────────────────
// waitUntil keeps the SW alive until caching completes.
// If any URL fails to fetch, install fails and the old SW stays active.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

// ── Activate: delete stale caches ─────────────────────────────────────────────
// Runs after the new SW takes control, removes atsprit-v1, v2, etc.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

// ── Fetch: two strategies ──────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Strategy A — Network first, cache fallback.
  // Applied to ALL /data/ requests including cache-busted URLs (which contain ?cb=).
  // Rationale: fuel prices and Brent data must always be fresh; stale prices mislead users.
  // The ?cb= query parameter from bust() means each request has a unique URL, so the
  // browser won't serve a cached response at the HTTP level either.
  if (url.includes('/data/')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Clone before consuming — Response body can only be read once.
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return networkResponse;
        })
        .catch(() => {
          // Network failed (user offline) — try cache as fallback.
          // If cache also misses, the app's own error handling shows the error banner.
          return caches.match(event.request);
        })
    );
    return;
  }

  // Strategy B — Cache first, network fallback.
  // Applied to index.html, CDN assets, manifest.json.
  // These only change on deploy (CACHE_NAME bump handles invalidation).
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      // Not in cache — fetch from network and cache for next time.
      return fetch(event.request).then((networkResponse) => {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});
