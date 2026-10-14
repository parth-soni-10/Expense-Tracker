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
const CACHE = 'cents-v24';
// The build this device was last served on a navigation, so a redeploy can be
// told apart from a first visit. Its OWN cache, and `activate` deliberately does
// not sweep it: the shell cache above is versioned and a bump has to delete it,
// but the baseline has exactly the opposite job — it must survive the deploy
// that changed the shell, or the first check after a bump is a first sighting
// again. See "which build this device last saw" at the foot of this file for why
// it is in Cache Storage rather than a variable.
const BUILD_CACHE = 'cents-build';
const BUILD_KEY = '/__cents-build';
// The daily reminder's schedule and its "already fired today" record, mirrored
// here by the page (a service worker cannot read the page's localStorage — a
// different storage area entirely). Its OWN cache, and `activate` deliberately
// does not sweep it for the same reason as the baseline above: the record is
// what stops a second banner for a day that already had one, and a deploy that
// cleared it would re-arm an afternoon the push or a wake already covered.
// See the background wake at the foot of this file.
const REMINDER_CACHE = 'cents-reminder';
const REMINDER_KEY = '/__cents-reminder';
// One tag from register to banner: the local scheduler, the server's push and
// this worker's own wake all announce the same reminder under it, so whichever
// path reaches the device first defines the notification the others replace.
const REMINDER_TAG = 'cents-daily-reminder';
// The reminder's words — byte-for-byte the generic (no profile name) copy the
// sender ships. A wake has no payload and cannot know whose profile
// is active, so it says what the server would say without a name; both halves
// are pinned against each other in scripts/test-reminder-push.mjs.
const REMINDER_TITLE = 'cents. — time to upload your transactions';
const REMINDER_BODY = 'Log today\'s spending while it\'s fresh.';
// The Tesco Pay ENGINE is on the boot path (it feeds the dashboard figures); the
// screen beside it is fetched on the first visit to the tab, so it has to be
// warm for that visit to work offline.
// Note: this array is read by check-sw-shell.mjs and check-boot-payload.mjs with
// a naive quoted-string scan, so keep comments out of it (an apostrophe inside
// would pair with a real opening quote and shred the list).
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/seed.js',
  '/settings.js',
  '/storage.js',
  '/csv.js',
  '/sync.js',
  '/sync-merge.js',
  '/profiles.js',
  '/reminders.js',
  '/tesco-pay.js',
  '/tesco.js',
  // The Insights screen and its Year in review modal — the same shape as the
  // Tesco screen: fetched on the first visit to #insights, so a cold offline
  // open of that tab needs it warm.
  '/insights.js',
  // tesco.js imports this the moment it loads, so the first offline visit to
  // #tesco needs it warm for the same reason. The OCR engine it feeds is NOT
  // here: 6 MB of wasm + traineddata, fetched on the first scan — a cold offline
  // scan cannot work regardless, so precaching it would cost every user.
  '/ocr-pixels.js',
  // Pulled in at boot (and from the Data menu) for the Lidl receipt pull —
  // small, and a cold offline open must not lose a module the app loads.
  '/lidl.js',
  // The bank statement mapper, reached only from the Data menu — deferred for
  // the same reason every screen is, and warm so an offline import still works.
  '/bank-import.js',
  // The Tesco gift-card balance check, wired the same way (boot + Data row).
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== BUILD_CACHE && k !== REMINDER_CACHE).map((k) => caches.delete(k))))
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

// ── One reminder a day, from whichever path gets there first ─────
// Three paths can raise today's reminder: the page's scheduler (app open), the
// scheduled push below (server, needs cloud sync) and the background wake at
// the foot of this file (no server at all). They cannot see each other's state
// — the page's own marker lives in localStorage, which this worker cannot read
// — so they agree through THIS record instead: every path writes the day here
// when it shows a banner, and every path reads it before showing one. Cache
// Storage is the only place all three meet, and `activate` keeps it (above) for
// the same reason it keeps the build baseline: a deploy must not re-arm the day.

/** The record as it stands, or null when the page has never mirrored one. */
async function reminderRecord() {
  try {
    const hit = await (await caches.open(REMINDER_CACHE)).match(REMINDER_KEY);
    const data = hit ? await hit.json() : null;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null; // an unreadable record reads as "nothing known", never as "already fired"
  }
}

/** Today's date in the device's own zone — the same key the page marks. */
function reminderDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Today already had its reminder — from the page scheduler or a wake. */
async function reminderFiredToday() {
  const record = await reminderRecord();
  return !!record && record.fired === reminderDay();
}

/**
 * Record today as shown, keeping the schedule fields the page mirrored.
 *
 * `by` and `at` are for the page, not for the dedupe: the three paths write
 * the same field and the record is the only place they can be told apart, so
 * the app's reminder modal can answer "did it ever actually fire, and which
 * path delivered it?" — the question a silent reminder leaves the user with.
 */
async function markReminderFired(day = reminderDay(), by = 'wake') {
  try {
    const record = await reminderRecord();
    await (await caches.open(REMINDER_CACHE)).put(
      REMINDER_KEY,
      new Response(JSON.stringify({ ...(record || {}), fired: day, by, at: new Date().toISOString() }))
    );
  } catch {
    // A record that cannot be written costs a possible repeat (the shared tag
    // replaces it), never the banner itself.
  }
}

/**
 * May this wake stay quiet because the server is about to push the reminder?
 *
 * That is what the page's `push` field asks, and on its own it is a promise
 * with no end: a subscription is stored, the sender stops being called (nothing
 * in this repo would say so — the app's own trigger is the only clock left),
 * and the device defers to a push that is never sent.
 * Nothing arrives, ever, while every screen in the app reads "Push is on".
 *
 * So the deferral carries an EXPIRY, written by the page (mirrorWakeRecord) from
 * the sender's own heartbeat, which the push probe reports. A positive, future
 * `pushAliveUntil` means the server was heard from recently; anything else —
 * an expired horizon, a zero, a record from a page that never checked — means
 * this wake keeps its own duty, late rather than never. Once the hour has
 * passed the field is not consulted at all (see the caller): a push is bounded
 * by its TTL, so a phone that was unreachable at its hour has nothing else left.
 */
function pushCoversHour(record, nowMs) {
  if (record.push !== true) return false;
  const until = Number(record.pushAliveUntil);
  return Number.isFinite(until) && until > nowMs;
}

/** The one notification shape every path shows — tag/icon/deep-link cannot drift. */
function reminderNotification(body, tag) {
  return {
    body,
    tag,
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Deep-link straight into the app; the lock screen does its job first.
    data: { url: '/index.html#add' },
  };
}

// ── Daily reminder Web Push (closed-app delivery) ────────────────
// The reminder run (lib/reminder-run.mjs, reached over HTTP) pushes an
// encrypted payload { title, body, tag }; the browser decrypts it and hands it
// here. Payloads
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
  const options = reminderNotification(
    typeof payload.body === 'string' ? payload.body : REMINDER_BODY,
    typeof payload.tag === 'string' && payload.tag ? payload.tag : REMINDER_TAG
  );
  event.waitUntil((async () => {
    // A day that already had its reminder (the page was open at the hour, or a
    // wake got there first) must not get a second banner: the shared tag would
    // only REPLACE the first — renotify re-alerts — rather than deduplicate it.
    if (await reminderFiredToday()) return;
    // And a reminder the user switched OFF cannot arrive at all. The switch
    // drops this device's record at the server (the app's own unsubscribe), but
    // a push can already be in flight, or that delete can fail on a train —
    // and the page mirrors `enabled` into this record on every settings write,
    // so a reminder cancelled on the sofa does not ring from the pocket.
    const record = await reminderRecord();
    if (record && record.enabled === false) return;
    await self.registration.showNotification(title, options);
    await markReminderFired(undefined, 'push');
  })());
});

// ── The background wake (Periodic Background Sync) ───────────────
// The third path, and the one for a phone with no cloud sync: the browser
// wakes an INSTALLED app's worker in the background on its own schedule (the
// page's register tag and minInterval are a FLOOR, not a schedule — the
// browser picks the moment), and the wake decides from the record above
// whether this day still needs its reminder. Best-effort by nature: it can
// never be the on-time path, only the safety net under the other two.
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== REMINDER_TAG) return;
  event.waitUntil(dailyReminderWake());
});

/**
 * One wake, three gates — each one a way a background wake could misfire:
 *   * the record must say the reminder is ON. The wake is the browser's
 *     decision, not the user's; the page's own schedule is what says this
 *     user wants a banner (and an unregister after the toggle can still race
 *     one last event);
 *   * the hour must have passed. The browser wakes when IT likes — firing on
 *     any wake would put the reminder at whatever moment the phone felt like;
 *   * today must not already have it. The page scheduler and the push write
 *     the day here; the shared tag hides a second banner (it replaces it) but
 *     the replacement still re-alerts.
 * Plus the record older than YESTERDAY rule: if every wake so far has landed
 * BEFORE the hour — the browser's choice of moment, not ours — the due-time
 * gate alone would never fire at all, and a whole day would pass with no
 * closed-app reminder from any path. A late reminder beats a skipped one; a
 * record from yesterday means today is simply waiting its turn.
 *
 * And the one thing that rule must NOT do: pre-empt the hour itself. The catch-
 * up fire below marks the day as delivered, and the push handler drops any
 * message for a day that already has its banner — so an early wake does not add
 * a notification, it CANCELS the on-time one the server is about to send. That
 * is why `record.push` ends it: a device with an armed subscription has its
 * closed-app reminder delivered by the SERVER at the hour the user chose, which
 * needs nothing awake here, so the catch-up has nothing to cover — and it is
 * exactly the device whose 20:00 reminder would be eaten by a 03:00 wake. With
 * no subscription the record cannot exist, and the rule is unchanged: a late
 * reminder beats a skipped one.
 *
 * Which makes that deferral the one place this net can be talked out of its job
 * for good, so it is not a bare boolean: pushCoversHour() requires an unexpired
 * horizon the page wrote from the SENDER's own heartbeat. A server that has
 * stopped sending withdraws it, and this path takes the day back.
 */
async function dailyReminderWake() {
  try {
    const record = await reminderRecord();
    if (!record || record.enabled !== true) return;
    const day = reminderDay();
    if (record.fired === day) return;
    const now = new Date();
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(record.time));
    const dueAt = match ? Number(match[1]) * 60 + Number(match[2]) : 20 * 60; // normalize()'s own default
    const due = now.getHours() * 60 + now.getMinutes() >= dueAt;
    if (!due) {
      if (pushCoversHour(record, now.getTime())) return; // the server has this hour covered
      const yesterday = reminderDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
      if (record.fired === yesterday) return;
    }
    await self.registration.showNotification(REMINDER_TITLE, reminderNotification(REMINDER_BODY, REMINDER_TAG));
    await markReminderFired(day, 'wake');
  } catch {
    // A failed wake costs at most one reminder; it must never take the worker down.
  }
}

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
