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
const CACHE = 'cents-v32';
// The build this device was last served on a navigation, so a redeploy can be
// told apart from a first visit. Its OWN cache, and `activate` deliberately does
// not sweep it: the shell cache above is versioned and a bump has to delete it,
// but the baseline has exactly the opposite job — it must survive the deploy
// that changed the shell, or the first check after a bump is a first sighting
// again. See "which build this device last saw" at the foot of this file for why
// it is in Cache Storage rather than a variable.
const BUILD_CACHE = 'cents-build';
const BUILD_KEY = '/__cents-build';
// The Tesco Pay ENGINE is on the boot path (it feeds the dashboard figures); the
// screen beside it is fetched on the first visit to the tab, so it has to be
// warm for that visit to work offline.
// Note: this array is read by check-sw-shell.mjs and check-boot-payload.mjs with
// a naive quoted-string scan, so keep comments out of it (an apostrophe inside
// would pair with a real opening quote and shred the list).
// The last of the four kit pairs is the header's theme switch: app.js builds it
// on the boot path, so both files have to be warm for a cold offline open.
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/glide-select.css',
  '/glide-select.js',
  '/jelly-radio.css',
  '/jelly-radio.js',
  '/rubber-segment.css',
  '/rubber-segment.js',
  '/squish-switch.css',
  '/squish-switch.js',
  '/slide-commit.css',
  '/slide-commit.js',
  '/seed.js',
  '/settings.js',
  '/storage.js',
  '/csv.js',
  '/sync.js',
  '/sync-merge.js',
  '/profiles.js',
  '/tesco-pay.js',
  '/tesco.js',
  // The Insights screen and its Year in review modal — the same shape as the
  // Tesco screen: fetched on the first visit to #insights, so a cold offline
  // open of that tab needs it warm.
  '/insights.js',
  // The bank statement mapper, reached only from the Data menu — deferred for
  // the same reason every screen is, and warm so an offline import still works.
  '/bank-import.js',
  // The PWA manifest and icons: not a screen, but the only files the browser
  // asks for by itself, before any line of this code runs.
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== BUILD_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Only same-origin STATIC responses are cached. The sync endpoint is
  // same-origin by default (/api/sync), so an origin check alone
  // would persist the response — the user's whole synced document, every entry,
  // amount and note in it — in Cache Storage, where it survives until the next
  // cache version bump and is readable without the app password. It would also
  // be replayed as the answer to a later offline sync GET, handing the app a
  // stale cloud copy as if it were fresh. Anything under the Worker's API
  // prefix, anything under the pre-rename functions path a device may still be
  // using, and anything the app authenticates with a header, is passed straight
  // through and never written to the cache.
  const url = new URL(e.request.url);
  const cacheable = url.origin === self.location.origin
    && !url.pathname.startsWith('/api/')
    && !url.pathname.startsWith('/.netlify/')
    && !e.request.headers.has('X-Cents-Password');
  // `cache: 'no-store'` stops the browser's own HTTP cache from short-circuiting
  // the network, so a redeployed build is always fetched fresh while online.
  // The success copy below still populates the offline cache, so a later
  // offline open gets the most recently downloaded version.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok && cacheable) {
          // Both clones are taken in THIS tick. The page consumes the response
          // the moment this promise settles, and a clone taken after that
          // throws ("body already used") — which is the other way the redeploy
          // notification below goes missing without a word.
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          if (e.request.mode === 'navigate') maybeBroadcastBuildChange(e.request, res.clone());
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

// ── Which build this device last saw ─────────────────────────────
// A redeploy swaps the served index.html. The worker diffs the document it just
// fetched against the one it saw last and tells the open tabs, so a tab that has
// not navigated reloads instead of showing the previous build.
//
// THAT BASELINE HAS TO OUTLIVE THE WORKER. It used to be a Map in the worker's
// own scope, and a service worker is torn down after about thirty seconds idle —
// so by the time a phone has been in a pocket for a few days, the worker that
// saw the last build is long gone. Held in memory only, the first check after
// every restart looked like "no baseline yet", and the branch below records a
// first sighting silently on purpose. So the ONE case this machinery exists for —
// a PWA that has not navigated since the deploy — stored the new build, reported
// nothing, and kept showing the old one until the app was killed by hand. It is
// in Cache Storage now, and it is read fresh on every comparison rather than
// mirrored, because two sources of truth for this is a race waiting to happen.

/** The body of the navigation document this device was last served, or null. */
async function lastBuild() {
  try {
    const hit = await (await caches.open(BUILD_CACHE)).match(BUILD_KEY);
    return hit ? await hit.text() : null;
  } catch (err) {
    return null;
  }
}

/**
 * Record the build now being served and answer whether that is a CHANGE — i.e.
 * whether the tabs need telling. A first sighting (no baseline at all, which is
 * a new device rather than a redeploy) is recorded silently; only a redeploy
 * that arrives after a baseline exists reports one.
 */
async function noteBuild(text) {
  const prev = await lastBuild();
  if (prev === text) return false;
  try {
    await (await caches.open(BUILD_CACHE)).put(new Request(BUILD_KEY), new Response(text));
  } catch (err) {
    // A baseline that can't be written only costs a missed notification later.
  }
  return prev !== null;
}

async function tellClients(url) {
  if (!self.clients || typeof self.clients.matchAll !== 'function') return;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clients) {
    client.postMessage({ type: 'centsNewBuild', url });
  }
}

// A navigation. The tab that asked is being handed this very document, so it is
// already getting the new build; the broadcast is for the OTHER tabs — a
// background tab that has not navigated is the one left showing the previous
// build. The served document can receive it too when it is already a client, and
// that is harmless: its reload lands on a baseline that now matches, and the app
// declines to reload while a modal or a field is busy, so it can happen at most
// once per deploy. `response` is a clone the caller took before the page could
// consume the body.
async function maybeBroadcastBuildChange(request, response) {
  let text;
  try {
    text = await response.text();
  } catch (err) {
    // A body that can't be read shouldn't break serving the page.
    return;
  }
  if (await noteBuild(text)) await tellClients(new URL(request.url).href);
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
      if (!(await noteBuild(text))) return;
      // Also refresh the cached navigation fallback so an offline open after
      // this point boots the new build, not the stale one.
      caches.open(CACHE).then((c) => c.put(new Request('/index.html'), copy)).catch(() => {});
      await tellClients(url);
    })
    .catch(() => {});
});
