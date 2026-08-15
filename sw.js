/* cents. service worker — minimal, network-first.
 *
 * The app's deploy model is "always fresh": Netlify serves every asset with
 * no-cache, must-revalidate. This worker respects that — every request tries
 * the network first and only falls back to a cached copy when the network is
 * actually unavailable. It never serves stale content while online.
 *
 * Its other job is installability: Chrome requires a fetch-handling service
 * worker before a site can be installed as a standalone app.
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
  '/vendor/sweetalert2.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
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
        // Warm the runtime cache with anything fetched while online, so a
        // later offline session (e.g. lazy-loaded vendor libs) still works.
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
