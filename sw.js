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
const CACHE = 'cents-v7';
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
  // Only same-origin responses are cached. Cross-origin requests — notably
  // the sync endpoint GET, whose response contains the user's synced expense
  // data — are passed through and never written to the cache.
  const isSameOrigin = new URL(e.request.url).origin === self.location.origin;
  // `cache: 'no-store'` stops the browser's own HTTP cache from short-circuiting
  // the network, so a redeployed build is always fetched fresh while online.
  // The success copy below still populates the offline cache, so a later
  // offline open gets the most recently downloaded version.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok && isSameOrigin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          maybeBroadcastBuildChange(e.request, res);
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

// Remember the body of every navigation document we've served this SW
// instance. If a fresh fetch comes back with a different body, the site was
// redeployed — tell any open, controlled tab to reload so it leaves the old
// build behind instead of showing stale UI until the user manually refreshes.
const buildSeen = new Map(); // url -> text
async function maybeBroadcastBuildChange(request, response) {
  if (request.mode !== 'navigate') return;
  if (!self.clients || typeof self.clients.matchAll !== 'function') return;
  const url = new URL(request.url).href;
  try {
    const text = await response.clone().text();
    const prev = buildSeen.get(url);
    // No baseline yet (first navigation under this worker) — record it and
    // stop, so adopting a fresh SW mid-session doesn't force a pointless
    // reload. Only a real body change (a redeploy) triggers a broadcast.
    if (prev === undefined) { buildSeen.set(url, text); return; }
    if (prev !== text) {
      buildSeen.set(url, text);
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
      for (const client of clients) {
        client.postMessage({ type: 'centsNewBuild', url });
      }
    }
  } catch (err) {
    // A body that can't be read shouldn't break serving the page.
  }
}
