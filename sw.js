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
const CACHE = 'cents-v15';
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
  '/reminders.js',
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

// ── Push-driven update checks ────────────────────────────────────
// Navigations are the only moment the worker re-diffs index.html on its own.
// A long-lived PWA opened from the home screen may never navigate again, so
// the page asks the worker to re-check ("centsCheckUpdate") when the tab
// regains focus after being away — this is what makes a redeploy reach a
// phone that has been sitting on the lock screen for days.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'centsCheckUpdate') return;
  event.source?.postMessage({ type: 'centsCheckUpdateStart' });
  fetch('/index.html', { cache: 'no-store' })
    .then(async (res) => {
      if (!res || !res.ok) return;
      // Clone BEFORE reading: a body can only be consumed once, so cloning
      // after res.text() would throw and the cache refresh below would never
      // run (the catch would silently eat it).
      const copy = res.clone();
      const text = await res.text();
      const url = new URL('/index.html', self.location.origin).href;
      const prev = buildSeen.get(url);
      buildSeen.set(url, text);
      if (prev === undefined || prev === text) return;
      // Also refresh the cached navigation fallback so an offline open after
      // this point boots the new build, not the stale one.
      caches.open(CACHE).then((c) => c.put(new Request('/index.html'), copy)).catch(() => {});
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
      for (const client of clients) client.postMessage({ type: 'centsNewBuild', url });
    })
    .catch(() => {});
});

// ── Daily reminder Web Push (closed-app delivery) ────────────────
// The scheduled function (reminders-send.mjs) pushes an encrypted payload
// { title, body, tag }; the browser decrypts it and hands it here. Payloads
// are tiny and trusted (our own server), but parsing is still guarded — a
// malformed push must never throw inside the SW.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'cents.', body: event.data ? event.data.text() : 'Daily reminder.' };
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'cents.';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'Time to upload your transactions.',
    tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : 'cents-daily-reminder',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Deep-link straight into the app; the lock screen does its job first.
    data: { url: '/index.html#add' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/index.html';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        await client.focus().catch(() => {});
        if (client.navigate && target !== '/index.html') await client.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
