/* cents. service worker — minimal, network-first.
 *
 * Install is deliberately instant: no precache. Chrome counts the app as
 * installable the moment this worker is active, so a heavyweight
 * caches.addAll(...) during install only delays it — and on a flaky mobile
 * connection one failed fetch stalls the install event entirely, which is
 * exactly the "install never appears" bug this worker exists to avoid.
 * The shell is captured lazily by the runtime cache on the first controlled
 * load instead, so offline boot still works after one full online visit.
 *
 * Network-first: every request tries the network and only falls back to a
 * cached copy when offline. It never serves stale content while online.
 */
const CACHE = 'cents-v1';

self.addEventListener('install', () => self.skipWaiting());

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
