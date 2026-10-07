/* ============================================================
   reminders.js — daily "upload your transactions" reminder.

   Stored per device (default 20:00 local time). Three delivery
   paths, because a web app can be closed at any moment:
     1. While the app is OPEN (any tab, locked or not): a
        timer checks each minute whether the day's
        reminder time has passed and not yet fired, then
        shows an in-app toast + a system Notification at
        that hour. The ONE tick that does not raise a
        banner is the scheduler's own start-up tick: there
        the time has passed by an unknown margin and the
        user is the one who just opened the app, so a
        banner there is a notification popping as the site
        loads rather than a reminder at its hour. See
        showReminderNotification.
     2. On ANY browser that can do Web Push — phone or desktop,
        tab or installed PWA — a subscription is sent to the
        server, whose Scheduled Function delivers a real push at
        the chosen local time even when the app is closed. This
        reaches a device with nothing open at the hour, but it
        needs the app password (cloud sync) to subscribe. See
        reminders-push.mjs.
     3. The background wake (Periodic Background Sync): the
        browser runs the service worker's `periodicsync` event
        in the background for an INSTALLED app — no server, no
        sync, no password. It is the closed-app path for a
        phone that never sets up sync, and it is best-effort:
        the browser picks the moment, so path 2 stays the
        on-time one and this is the safety net under both.
        See syncPeriodicReminder / sw.js's dailyReminderWake.

   All three dedupe through one record in Cache Storage (the
   worker cannot read localStorage): every path writes "today"
   there when it shows a banner and reads it before showing
   one — see markWakeFired.

   Every key and the fire state ("last fired" date) are namespaced per
   profile, so each user is reminded about their own data.
   ============================================================ */

import { getSyncSettings } from './settings.js';
import { nsKey, activeProfile, getActiveProfileId } from './profiles.js';

const KEY = () => nsKey('reminder');

// ---------- the background wake's record (shared with sw.js) ----------
// The worker cannot read this page's localStorage — a different storage area
// entirely — so a background wake would know nothing: not whether the reminder
// is on, not what hour it is at, not whether today already happened. The
// schedule is mirrored into Cache Storage for it, and the day every path
// delivers is written back through the same record — the one place the page,
// the scheduled push and the wake can all meet. Same cache and key as sw.js;
// the two are pinned against each other in scripts/test-reminder-push.mjs, and
// `activate` keeps this cache for the same reason it keeps the build baseline:
// a deploy must not re-arm a day that already had its reminder.
const WAKE_CACHE = 'cents-reminder';
const WAKE_KEY = '/__cents-reminder';
// The sync tag IS the notification tag: one string from register to banner,
// so the three paths announce one notification rather than three.
const WAKE_TAG = 'cents-daily-reminder';
// A FLOOR on how often the browser may wake the worker, not a schedule — the
// browser picks the moment (that is what makes this path best-effort). 12h
// lets it land once a day while leaving room for a day whose only wake came
// before the reminder hour.
const WAKE_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Merge `patch` into the worker's record, keeping every field not named.
 * The read-modify-write IS the point: a plain write of just this page's
 * fields would erase the `fired` day a wake or the push recorded and hand
 * the user a second banner for it. Never throws — best effort at every call.
 */
async function patchWakeRecord(patch) {
  if (typeof caches === 'undefined') return; // not a browser (the Node guards)
  try {
    const cache = await caches.open(WAKE_CACHE);
    const hit = await cache.match(WAKE_KEY);
    const prev = hit ? await hit.json() : null;
    const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
    await cache.put(WAKE_KEY, new Response(JSON.stringify({ ...base, ...patch })));
  } catch {
    // A record that cannot be written costs at most a missed/extra banner;
    // the page's own reminder runs either way.
  }
}

// Every record write goes through ONE chain. tick() writes the schedule and
// the day back to back (patchReminderSettings, then markWakeFired), and two
// patches in flight together would each read the OLD record — the slower put
// would win with a stale base, and a `fired` written from before the mirror's
// `enabled: true` is exactly how a wake stops firing while everything on
// screen looks right. The chain keeps each read-modify-write atomic in this
// process; the worker's own concurrent write is cross-process and self-heals
// at the next start, when syncPeriodicReminder re-mirrors the schedule.
let wakeWriteChain = Promise.resolve();
function queueWakePatch(patch) {
  wakeWriteChain = wakeWriteChain.then(() => patchWakeRecord(patch));
  return wakeWriteChain; // patchWakeRecord never rejects, so the chain never breaks
}

/** Mirror this profile's schedule for the wake to read. */
function mirrorWakeRecord() {
  const s = readSettings();
  return queueWakePatch({ enabled: s.enabled, time: s.time });
}

/** Write today's date into the record: this path showed the reminder. */
function markWakeFired(day) {
  return queueWakePatch({ fired: day });
}

// The settings are re-read on EVERY tick, and localStorage is neither a
// reliable reader nor a reliable writer — and both failure modes are silent
// and continuous:
//   * a full quota makes the `lastFiredDate` write throw (the setter is in a
//     try/catch), so the next tick reads "not fired yet" and fires again — a
//     system banner plus an in-app toast every 60 seconds for the rest of the
//     day, from a reminder the user set once;
//   * a blocked or corrupt read makes normalize(null) answer `enabled: false`,
//     so the reminder the user armed stops existing for the whole session and
//     nothing ever tells them why.
// So this session's copy is the truth and storage is write-through. `storageOk`
// drops to false on the first failed read or write, after which memory wins.
// The cache is keyed by the profile key because that key is what changes when
// a profile is switched — without it a switch would keep the previous person's
// schedule running against this person's data.
let cacheKey = null;
let cached = null;
let storageOk = true;

function readSettings() {
  const key = KEY();
  if (cacheKey !== key) { cacheKey = key; cached = null; storageOk = true; }
  if (!storageOk) return cached; // a failed read or write: this session's copy
  try {
    const raw = localStorage.getItem(key);
    cached = normalize(raw ? JSON.parse(raw) : null);
    return cached;
  } catch {
    storageOk = false;
    if (!cached) cached = normalize(null); // an unreadable store is not "off"
    return cached;
  }
}

/** Write-through: memory first, so a refused write cannot undo the change. */
function writeSettings(next) {
  cached = next;
  try { localStorage.setItem(cacheKey, JSON.stringify(next)); }
  catch { storageOk = false; } // read-only or full: the session still holds it
  // Mirror every change to the worker's record — the schedule a background
  // wake reads must not wait for the next boot (and the toggle off must
  // withdraw it now, not later). Best effort; the page never waits on it.
  mirrorWakeRecord();
  return next;
}

/** The zone the device is in right now — the one the scheduled sender should
 *  be aiming at. Never assumed: an unset or unreadable value is UTC, because a
 *  wrong zone is a reminder at the wrong hour and UTC is at least one a user
 *  can reason about. */
function currentZone() {
  try {
    return (typeof Intl !== 'undefined' && Intl.DateTimeFormat
      && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  } catch { return 'UTC'; }
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const time = typeof source.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(source.time)
    ? source.time : '20:00';
  // The zone the last subscription announced. Only meaningful for a device that
  // is subscribed — see the re-announce on start.
  const pushZone = typeof source.pushZone === 'string' && source.pushZone ? source.pushZone : null;
  const enabled = source.enabled === true;
  const lastFiredDate = typeof source.lastFiredDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.lastFiredDate)
    ? source.lastFiredDate : null;
  const pushSubscribed = source.pushSubscribed === true;
  const pushEndpoint = typeof source.pushEndpoint === 'string' && source.pushEndpoint ? source.pushEndpoint : null;
  return { enabled, time, lastFiredDate, pushSubscribed, pushEndpoint, pushZone };
}

export function getReminderSettings() {
  return { ...readSettings() };
}

export function patchReminderSettings(patch) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  // Merge onto stored state FIRST, then normalize the merged object so an
  // invalid patch field is dropped without resetting the untouched ones.
  const clean = normalize({ ...readSettings(), ...source });
  return writeSettings(clean);
}

/** Local YYYY-MM-DD for a Date (defaults to now). */
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/** Ask the browser for notification permission. Returns the resulting state. */
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

/**
 * What is DUE, said the same way the sender says it.
 *
 * The push path counts bills from the profile's synced document; the local
 * path (system banner + in-app toast) has no document — reminders.js is the
 * module the scheduler, the worker wake and the push client all share, and it
 * must not import app state. So app.js hands in the source once at boot. Same
 * leading space, same pluralisation, same "due means nextDate <= today": the
 * words are supposed to be independent of how the reminder is delivered.
 */
let dueBillsHint = () => '';
export function setDueBillsProvider(fn) {
  dueBillsHint = typeof fn === 'function' ? fn : () => '';
}

/** The reminder's words, independent of how it is delivered: the system banner
 *  and the in-app toast say the same thing, and only one of them is ever the
 *  right one. */
function reminderCopy(profileName) {
  let hint = '';
  try { hint = dueBillsHint() || ''; } catch { hint = ''; } // a hint never costs a delivery
  return {
    title: 'cents. — time to upload your transactions',
    body: (profileName
      ? `Quick tally for ${profileName} — it takes a minute.`
      : 'Log today\'s spending while it\'s fresh.') + hint,
  };
}

/** Show the reminder now: a system notification (if permitted) plus the payload
 *  the app turns into its in-app toast. Safe to call while locked.
 *
 *  `catchUp` is the whole of the rule, and it is about WHEN rather than what is
 *  on screen. The scheduler runs `tick()` the moment the app starts, so a day
 *  whose reminder time had already passed used to raise a SYSTEM banner the
 *  instant the site was opened — the user experienced a "daily reminder" that
 *  only ever appeared on open, never at its hour, and suppressing the banner
 *  whenever the page was in front was the wrong fix: it silenced the one case
 *  where a reminder is actually due, with the app open and waiting at 20:00.
 *  So the banner is raised for every tick EXCEPT the start-up one: at the hour
 *  it fires whether or not the page is in front (that is the reminder working),
 *  and on open the day is marked off with the toast alone (that is a catch-up
 *  on a moment already gone, not a reminder). */
export function showReminderNotification(profileName = null, { catchUp = false } = {}) {
  const { title, body } = reminderCopy(profileName);
  if (notificationPermission() === 'granted' && !catchUp) {
    try {
      const n = new Notification(title, { body, tag: 'cents-daily-reminder', renotify: true });
      n.onclick = () => { try { window.focus(); } catch { /* window gone */ } n.close(); };
    } catch { /* SW-based fallback is handled by the push path */ }
  }
  return { title, body };
}

// ---------- scheduler (single loop for the whole app) ----------
let timer = null;
const listeners = new Set();

/** The app registers a callback that renders the in-app toast. */
export function onReminderFired(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fire(catchUp = false) {
  let profileName = null;
  try { profileName = activeProfile().name; } catch { /* registry unavailable */ }
  const payload = showReminderNotification(profileName, { catchUp });
  for (const fn of listeners) { try { fn(payload); } catch { /* listener error never breaks the loop */ } }
}

function tick(catchUp = false) {
  const s = getReminderSettings();
  const todayKey = localDateKey();
  if (!s.enabled || s.lastFiredDate === todayKey) return;
  const [h, m] = s.time.split(':').map(Number);
  const now = new Date();
  const due = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  if (due) {
    patchReminderSettings({ lastFiredDate: todayKey });
    // The same day, in the storage the worker can see. Both markers exist for
    // the same reason — "today is done" — and the catch-up (start-up) tick
    // writes it too: a user who opened the app after the hour got the in-app
    // nudge, and a banner arriving later would be a second nudge for a day
    // that already had one. Unpatched by "Test now", which re-arms the day on
    // purpose (it resets lastFiredDate but has no business touching the wake).
    markWakeFired(todayKey);
    fire(catchUp);
  }
}

/** Start the minute-check loop. Idempotent; runs regardless of lock state.
 *
 *  The start-up tick is the ONLY catch-up: it exists so a day whose hour passed
 *  while the app was shut still counts as done (and still nudges in-app), but
 *  it must not raise a banner, because it runs on every open of the site. Every
 *  later tick — the minute loop, the return to a backgrounded tab — is a moment
 *  the app has been alive across, and those raise the reminder. */
export function startReminderScheduler() {
  if (timer) return;
  // The scheduled sender aims at the zone it was TOLD, which is only ever
  // sent on subscribe or on a time change — so a device that travels keeps its
  // push on the old zone's hour while the local scheduler above uses the new
  // one, and the two halves of the same reminder drift apart. Re-announce on
  // start when they disagree. Guarded on granted permission so starting the app
  // can never surface a permission prompt the user did not ask for; a failed
  // announce is retried on the next start, and an old subscription without a
  // recorded zone is backfilled the same way.
  {
    const s = getReminderSettings();
    if (s.pushSubscribed && s.pushZone !== currentZone()
        && notificationPermission() === 'granted') {
      updateReminderPushTime().catch(() => {}); // best effort; the app is up either way
    }
  }
  tick(true);
  timer = setInterval(() => tick(false), 60 * 1000);
  // Catch devices that sleep through the interval boundary.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(false); });
  }
  // Arm the background wake beside the loop above — always last and always
  // best effort: it is the closed-app half for a device with no cloud sync,
  // and a browser that cannot do it only leaves the status the modal reads.
  syncPeriodicReminder().catch(() => {});
}

// ---------- background wake (Periodic Background Sync) ----------
// The third path from the header: no server, no sync, no page open. The
// browser runs the worker's `periodicsync` event in the background for an
// INSTALLED app, and the wake reads the mirrored schedule above to decide
// whether to notify. Capability gates only — never the sync password: the
// phone this exists for has neither, which is the whole point of the path.

// The modal's one honest answer about the wake: 'on' only after a register the
// browser actually ACCEPTED — never "probably", because the row it drives
// promises a notification the user would otherwise only notice the absence of.
let wakeState = { state: 'unknown' }; // 'on' | 'off' | 'unsupported' | 'unavailable' | 'unknown'

export function periodicReminderStatus() {
  return { ...wakeState };
}

/**
 * Arm (or withdraw) the background wake for the current schedule. Called on
 * every start and whenever the reminder toggle or the notification permission
 * changes; resolves to the status for the modal. Two verdicts deserve their
 * wording: 'unsupported' is a browser without the API at all, while
 * 'unavailable' with reason 'not-installed' is Chrome on a phone that has only
 * VISITED the site — the browser runs these wakes only for installed apps, so
 * a tab must not be told otherwise; for a tab, cloud sync (or the app being
 * open) is the honest answer the modal already gives.
 */
export async function syncPeriodicReminder() {
  const settle = (state, reason = null) => { wakeState = { state, reason }; return { ...wakeState }; };
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return settle('unsupported');
    // `ready` never settles when no worker is registered at all — and this is
    // awaited by the modal before its redraw — so it races a bounded, unref'd
    // wait. Losing the race reports 'unknown', never a verdict.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 5000);
        if (t && typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (!reg) return settle('unknown');
    if (!('periodicSync' in reg) || typeof reg.periodicSync.register !== 'function') return settle('unsupported');
    // Install state is the gate, not capability alone — see the docblock: the
    // browser only RUNS these wakes for an installed app, so success here is
    // what the modal's promise rests on.
    if (typeof matchMedia !== 'function' || !matchMedia('(display-mode: standalone)').matches) {
      return settle('unavailable', 'not-installed');
    }
    // Mirror before registering: the first wake must find the schedule (an
    // event can arrive before the next settings write runs), and the register
    // below is what makes that wake possible in the first place.
    await mirrorWakeRecord();
    const s = getReminderSettings();
    if (!s.enabled) {
      // Toggled off: withdraw the wake now rather than at the next boot, so
      // tonight cannot fire from a schedule the user just closed.
      try { await reg.periodicSync.unregister(WAKE_TAG); } catch { /* never registered */ }
      return settle('off');
    }
    // No banner without permission — registering would only schedule wakes
    // whose showNotification is guaranteed to throw. The modal's Allow row is
    // how this gets granted; this function is never what asks for it.
    if (notificationPermission() !== 'granted') return settle('unavailable', 'permission');
    try {
      const queried = await navigator.permissions?.query?.({ name: 'periodic-background-sync' });
      if (queried && queried.state === 'denied') return settle('unavailable', 'denied');
    } catch { /* a browser that will not answer is one register() can judge */ }
    await reg.periodicSync.register(WAKE_TAG, { minInterval: WAKE_MIN_INTERVAL_MS });
    return settle('on');
  } catch (e) {
    // The browser's own refusal — most often a site that is not installed, or
    // a device whose engagement with it is still too low to earn wakes.
    // Reported, never swallowed: the modal must not promise a closed-app
    // reminder this phone will not deliver.
    return settle('unavailable', (e && e.name) || 'error');
  }
}

// ---------- closed-app push (Web Push via the Netlify functions) ----------
// While the app is open, the scheduler above is enough. When it is closed,
// delivery needs a real Web Push subscription: the browser hands us an
// endpoint + keys, the server stores them, and a scheduled function fires
// the push at the chosen local time. Subscribing requires the app password
// (same credential as cloud sync) so random sites cannot seed reminders
// into someone's store.

const PUSH_TIMEOUT_MS = 12000;

/** Auth headers for the push functions: this profile's password + its id. */
function profileHeaders(password) {
  return { 'X-Cents-Password': password, 'X-Cents-Profile': getActiveProfileId() || 'personal' };
}

function pushEndpoint(syncEndpoint) {
  if (typeof syncEndpoint !== 'string' || !syncEndpoint) return null;
  const m = /^(.*\/)[^/]+$/.exec(syncEndpoint);
  return m ? `${m[1]}reminders-push` : null;
}

function b64urlToBytes(b64url) {
  const normalized = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  const binary = atob(normalized + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * True when a server-supplied key is something a browser will accept as
 * `applicationServerKey`: base64url for the 65-byte uncompressed P-256 point,
 * 0x04 first.
 *
 * A length threshold is not this check, and the difference is not academic: the
 * 43-character PRIVATE seed is longer than any "looks like a key" threshold, and
 * serving it is exactly what a site with its two VAPID values swapped does. The
 * browser then refuses the subscribe with an InvalidAccessError, and the app
 * reported a network error — for a server that was reachable and answering 200,
 * which sent the diagnosis off in the wrong direction for a while. So the check
 * is the one the browser makes, and its verdict gets its own reason.
 */
export function validPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length < 80) return false;
  try {
    const point = b64urlToBytes(publicKey);
    return point.length === 65 && point[0] === 4;
  } catch {
    return false;
  }
}

async function pushFetch(url, init, timeoutMs = PUSH_TIMEOUT_MS) {
  return Promise.race([
    fetch(url, { cache: 'no-store', ...init }),
    new Promise((_res, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
}

/**
 * Closed-app push: any browser that can actually do Web Push — phone or
 * desktop, tab or installed PWA. It was phones only for the feature's whole
 * life, on the reasoning that on desktop the app lives in a tab on a machine
 * that is on and the in-app scheduler is the right surface. The daily
 * reminder's own symptom disproved that: at 20:00 the tab is not open, so the
 * only thing that ever fired was path 1's start-up catch-up. A browser with
 * nothing running has no local scheduler at all, and this is the one path
 * that reaches it. The gate is therefore the CAPABILITY and never the user
 * agent — a phone with no push support fails here too, and a desktop with it
 * passes. Requires cloud sync, since the app password gates the push store.
 */
export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/**
 * Subscribe this browser to closed-app reminders.
 * Requires sync to be configured (the app password gates the store).
 * Returns { ok: true } or { ok: false, reason, message? }.
 */
export async function subscribeReminderPush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }; // a capability this browser lacks, never the device it runs on
  const sync = getSyncSettings();
  if (!sync.enabled || !sync.endpoint || !sync.password) return { ok: false, reason: 'no-sync' };
  const base = pushEndpoint(sync.endpoint);
  if (!base) return { ok: false, reason: 'invalid_endpoint' };
  try {
    const keyResp = await pushFetch(base, { method: 'GET' });
    // The server says push has no key material yet - a setup problem, not a
    // failure the user can retry around, so it gets its own reason. Its body
    // names the way out (which variables to set, or which secret to expose),
    // so that is carried rather than paraphrased.
    if (keyResp.status === 503) {
      const body = await keyResp.json().catch(() => null);
      const detail = typeof body?.error === 'string' ? body.error.replace(/\.?\s*$/, '') : null;
      return { ok: false, reason: 'not-configured', message: detail };
    }
    if (!keyResp.ok) return { ok: false, reason: 'http', message: `key HTTP ${keyResp.status}` };
    const { publicKey } = await keyResp.json();
    if (!validPublicKey(publicKey)) return { ok: false, reason: 'bad-key' };

    // Ask for notification permission HERE, before subscribing, and inside the
    // click that got us here — a Chromium-based browser refuses a subscribe
    // whose permission is denied, and the prompt is only allowed from a user
    // gesture. Letting subscribe() make the request turns a permission problem
    // into a browser-specific error that names the wrong thing.
    //
    // Chrome on Android is the surface this matters most on: it subscribes
    // from a plain tab (iOS needs the app on the Home Screen first), so it is
    // the one that reaches a permission prompt this app never asked for.
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      // A previously denied permission cannot be re-prompted at all, so the
      // way out is the browser's own site settings — a different instruction
      // from "tap Allow", which is why they are different reasons.
      return { ok: false, reason: permission === 'denied' ? 'permission-blocked' : 'permission-denied' };
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // A refusal here is the browser's own verdict — an invalid key, a denied
      // permission, iOS before the app is on the Home Screen — and calling it a
      // network failure is a misreport, not a simplification.
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64urlToBytes(publicKey),
        });
      } catch (e) {
        const detail = [e?.name, e?.message].filter(Boolean).join(': ');
        return { ok: false, reason: 'subscribe-failed', message: detail || 'subscribe failed' };
      }
    }
    const subJson = sub.toJSON();
    let profileName = null;
    try { profileName = activeProfile().name; } catch { /* registry unavailable */ }
    const resp = await pushFetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...profileHeaders(sync.password),
      },
      body: JSON.stringify({
        subscription: subJson,
        profileName,
        time: getReminderSettings().time,
        zone: currentZone(),
      }),
    });
    if (resp.status === 401) return { ok: false, reason: 'auth' };
    if (!resp.ok) return { ok: false, reason: 'http', message: `HTTP ${resp.status}` };
    patchReminderSettings({ pushSubscribed: true, pushEndpoint: sub.endpoint, pushZone: currentZone() });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'subscribe failed' };
  }
}

/** Drop this browser's stored subscription (server + local push manager). */
export async function unsubscribeReminderPush() {
  const s = getReminderSettings();
  const sync = getSyncSettings();
  try {
    if (s.pushEndpoint && sync.endpoint && sync.password) {
      const base = pushEndpoint(sync.endpoint);
      if (base) {
        await pushFetch(base, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...profileHeaders(sync.password) },
          body: JSON.stringify({ subscription: { endpoint: s.pushEndpoint } }),
        }).catch(() => {}); // best effort — the local unsubscribe matters most
      }
    }
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await sub.unsubscribe().catch(() => {});
  } finally {
    patchReminderSettings({ pushSubscribed: false, pushEndpoint: null });
  }
  return { ok: true };
}

/** Ask the server to push a test message to this device's subscription. */
export async function sendTestPush() {
  const s = getReminderSettings();
  const sync = getSyncSettings();
  if (!s.pushSubscribed || !s.pushEndpoint) return { ok: false, reason: 'not-subscribed' };
  const base = pushEndpoint(sync.endpoint);
  if (!base) return { ok: false, reason: 'invalid_endpoint' };
  try {
    const resp = await pushFetch(base, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...profileHeaders(sync.password),
      },
      body: JSON.stringify({ endpoint: s.pushEndpoint }),
    });
    if (resp.ok) return { ok: true };
    // 425 is the server saying "this device is still registering with the push
    // service" — a test push fired straight after Enable push, before the
    // push service has been told about the registration. Push stays ON: the
    // subscription is healthy, so nothing is unsubscribed and the user is not
    // sent back to Enable push over a device that is fine (the server has
    // already asked the service a second time — see pushSendWarming).
    if (resp.status === 425) return { ok: false, reason: 'warming' };
    if (resp.status === 410) {
      patchReminderSettings({ pushSubscribed: false, pushEndpoint: null });
      return { ok: false, reason: 'stale', message: 'Subscription expired - re-enable push.' };
    }
    if (resp.status === 401) return { ok: false, reason: 'auth' };
    return { ok: false, reason: 'http', message: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'test failed' };
  }
}

/** Re-announce the current time/zone after a time change. */
export async function updateReminderPushTime() {
  const s = getReminderSettings();
  if (!s.pushSubscribed) return { ok: true, skipped: true };
  return subscribeReminderPush(); // POST overwrites the stored record
}

/**
 * Drop the stored push record for ANY profile id, using that profile's own
 * namespaced sync + reminder settings. Called before a profile is deleted:
 * its subscription would otherwise keep waking this device for a profile
 * that no longer exists. Best effort — the local delete is what matters.
 */
export async function unsubscribePushForProfile(profileId) {
  let sync = null;
  let reminder = null;
  try { sync = JSON.parse(localStorage.getItem(nsKey('sync', profileId)) || 'null'); } catch { sync = null; }
  try { reminder = JSON.parse(localStorage.getItem(nsKey('reminder', profileId)) || 'null'); } catch { reminder = null; }
  const endpoint = reminder?.pushEndpoint;
  const base = endpoint && sync?.endpoint ? pushEndpoint(sync.endpoint) : null;
  if (!base || !sync?.password) return { ok: false, reason: 'not-subscribed' };
  try {
    const resp = await pushFetch(base, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Cents-Password': sync.password, 'X-Cents-Profile': profileId },
      body: JSON.stringify({ subscription: { endpoint } }),
    });
    return { ok: resp.ok, reason: resp.ok ? null : `http ${resp.status}` };
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'unsubscribe failed' };
  }
}
