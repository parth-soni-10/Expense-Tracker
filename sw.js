/* cents. service worker — network-first, with a non-blocking shell warm.
 *
 * Install stays instant: the worker never awaits a precache, so Chrome marks
 * the app installable the moment it activates (a heavyweight addAll() here is
 * exactly the "install never appears" bug this avoids). Instead the shell is
 * warmed in the background — each entry individually caught so one failure can
 * never fail the worker — which lets the first visit still populate the cache
 * for a later offline open. The runtime cache below fills in anything the warm
 * missed, so offline boot is guaranteed after one full online visit.
 *
 * Network-first: every request tries the network and only falls back to a
 * cached copy when offline. It never serves stale content while online.
 */
const CACHE = 'cents-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/seed.js',
  '/settings.js',
  '/storage.js',
  '/sync.js',
  '/sync-merge.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/vendor/sweetalert2.min.js',
  '/fonts/space-grotesk-latin.woff2',
  '/fonts/ibm-plex-mono-400-latin.woff2',
  '/fonts/ibm-plex-mono-500-latin.woff2'
];

self.addEventListener('install', () => {
  self.skipWaiting();
  // Fire-and-forget warm: populates the cache during this first visit without
  // gating activation. The controlled page keeps the worker alive long enough
  // for these to complete in practice.
  caches.open(CACHE).then((c) => {
    SHELL.forEach((url) => c.add(url).catch(() => {}));
  });
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Cache anything fetched while online so a later offline session
        // still works.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => {
          if (hit) return hit;
          if (e.request.mode === 'navigate') return caches.match('/index.html');
          return Response.error();
        })
      )
  );
});
