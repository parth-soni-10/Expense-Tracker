/* cents. service worker — network-first, with a non-blocking shell warm.
 *
 * The behaviour is the shipping app's (install never awaits a precache, so
 * Chrome marks the app installable immediately; the shell is warmed in the
 * background, one entry at a time so a single failure cannot fail the worker;
 * every request is network-first and only falls back to the cache offline).
 *
 * What changed is the shell list: this worker serves the `app/` shell — the
 * built entry, its stylesheets and the external boot scripts — rather than the
 * root app's module graph.
 */
const CACHE = 'cents-app-v4';
// The build this device was last served on a navigation, so a redeploy can be
// told apart from a first visit. Its own cache: `activate` sweeps every other
// cache but deliberately not this one, because it has to outlive the deploy it
// is comparing against.
const BUILD_CACHE = 'cents-build';
const BUILD_KEY = '/__cents-build';
// Read by check-sw-shell.mjs / check-boot-payload.mjs with a quoted-string scan,
// so keep comments and apostrophes out of this array.
const SHELL = [
  '/',
  '/index.html',
  '/dist/main.js',
  '/styles.css',
  '/ui.css',
  '/ui.js',
  // The dashboard figures: the kernel, the mount and one file per figure. They
  // are deferred scripts on every load, so an offline dashboard needs them warm
  // or the three cards stay empty.
  '/hairline/kernel.js',
  '/hairline/mount.js',
  '/hairline/balance-tide.js',
  '/hairline/envelope-garden.js',
  '/hairline/receipt-constellation.js',
  '/styles/shell.css',
  '/styles/dashboard.css',
  '/styles/screens.css',
  '/theme-init.js',
  '/boot-watch.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/space-grotesk-latin.woff2',
  '/fonts/ibm-plex-mono-400-latin.woff2',
  '/fonts/ibm-plex-mono-500-latin.woff2'
];

self.addEventListener('install', () => {
  self.skipWaiting();
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
  // Only same-origin static responses are cached: the sync endpoint is
  // same-origin, and its response is the user's whole document. Anything under
  // the API prefix, the legacy functions path, or carrying the app's auth
  // header passes through and is never written to Cache Storage.
  const url = new URL(e.request.url);
  const cacheable = url.origin === self.location.origin
    && !url.pathname.startsWith('/api/')
    && !url.pathname.startsWith('/.netlify/')
    && !e.request.headers.has('X-Cents-Password');
  // `cache: 'no-store'` keeps the browser's HTTP cache from answering with a
  // previous build while online; the copy below still fills the offline cache.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok && cacheable) {
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

/** The body of the navigation document this device was last served, or null. */
async function lastBuild() {
  try {
    const hit = await (await caches.open(BUILD_CACHE)).match(BUILD_KEY);
    return hit ? await hit.text() : null;
  } catch (err) {
    return null;
  }
}

/** Record the build now being served and answer whether that is a CHANGE. A
 *  first sighting is silent; only a redeploy after a baseline reports one. */
async function noteBuild(text) {
  const prev = await lastBuild();
  if (prev === text) return false;
  try {
    await (await caches.open(BUILD_CACHE)).put(new Request(BUILD_KEY), new Response(text));
  } catch (err) {
    // A baseline that cannot be written only costs a missed notification later.
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

async function maybeBroadcastBuildChange(request, response) {
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return;
  }
  if (await noteBuild(text)) await tellClients(new URL(request.url).href);
}

// A long-lived installed copy may never navigate again, so the page asks for a
// re-check when it regains focus (main.ts posts this on visibilitychange).
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'centsCheckUpdate') return;
  event.source?.postMessage({ type: 'centsCheckUpdateStart' });
  fetch('/index.html', { cache: 'no-store' })
    .then(async (res) => {
      if (!res || !res.ok) return;
      const copy = res.clone();
      const text = await res.text();
      const url = new URL('/index.html', self.location.origin).href;
      if (!(await noteBuild(text))) return;
      caches.open(CACHE).then((c) => c.put(new Request('/index.html'), copy)).catch(() => {});
      await tellClients(url);
    })
    .catch(() => {});
});
