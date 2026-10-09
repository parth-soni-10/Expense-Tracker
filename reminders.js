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
        See syncPeriodicReminder / sw.js's dailyReminderWake.   All three dedupe through one record in Cache Storage (the
   worker cannot read localStorage): every path writes "today"
   there when it shows a banner and reads it before showing one — see
   markWakeFired. The record also carries WHICH path delivered it and when
   (the modal shows it, because "did it ever fire?" was unanswerable).

   Two rules keep the first two paths honest about each other:
     * the wake defers to an armed push only while that push is PROVEN alive —
       the server reports its scheduler's own last run through the push probe
       (verifyReminderPush), and that heartbeat sets an expiry on the deferral
       (mirrorWakeRecord). Without it, a platform whose cron stops invoking the
       function leaves a device that defers forever and NEVER fires.
     * a device that is open at the hour also fires the server's tick
       (triggerServerTick), so any open copy of the app is a trigger for the
       devices that are closed — and the reply refreshes the heartbeat.

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
 * How long the wake may keep deferring to a push the page last saw the server
 * actually sending, and how long ago that server may have run.
 *
 * The deferral is a bet — the wake stays quiet because a push is coming at the
 * hour — and the thing it bets on can stop without saying so: a platform that
 * stops invoking the scheduled function, a site that loses its store, a VAPID
 * pair that stops signing. A device cannot see any of that; what it CAN see is
 * the sender's own heartbeat, which the push probe returns (see
 * verifyReminderPush). So: the scheduler ran within the hour → trust tonight;
 * it has not run → withdraw the bet and let the wake cover the day (late beats
 * never); nothing ever heard → trust, so a device that has not probed yet (or
 * is on an older deploy) keeps the on-time path it already had.
 */
const SCHEDULER_ALIVE_MS = 90 * 60 * 1000; // the cron runs every minute
const PUSH_TRUST_MS = 26 * 60 * 60 * 1000; // one day of cover, from the last check

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

/**
 * Mirror this profile's schedule for the wake to read — and whether an on-time
 * push is armed for this device.
 *
 * The `push` field is not bookkeeping: a wake that fires BEFORE the hour marks
 * the day as delivered (`markReminderFired`), and the push handler drops any
 * message for a day that already has its banner — so an early wake does not
 * just add a notification, it CANCELS the one the server is about to send at
 * the hour the user chose. The wake's early fire exists for a device with no
 * other closed-app path, and a subscription is the opposite of that: the
 * on-time delivery runs on the server, which does not care whether the phone
 * is awake. So the worker reads this field and yields (see sw.js's
 * dailyReminderWake). It means "a push is armed", never "a push is certainly
 * alive" — verifyReminderPush below is what keeps the two the same, and a
 * subscription that has died leaves the wake to cover the day as before.
 */
function mirrorWakeRecord() {
  const s = readSettings();
  const alive = schedulerAlive(s);
  return queueWakePatch({
    enabled: s.enabled,
    time: s.time,
    push: s.pushSubscribed,
    // The expiry on the deferral the worker makes (see SCHEDULER_ALIVE_MS).
    // 0 is a withdrawn bet, not an absent field: the worker reads it as "do not
    // yield", which is exactly what a scheduler that is not running deserves.
    pushAliveUntil: s.pushSubscribed && alive !== false ? Date.now() + PUSH_TRUST_MS : 0,
    at: new Date().toISOString(),
  });
}

/** Write today's date into the record: this path showed the reminder, and which
 *  path it was — the record is the only place the three can be told apart, and
 *  the modal reads it back so "did it ever fire?" has an answer. */
function markWakeFired(day) {
  return queueWakePatch({ fired: day, by: 'page', at: new Date().toISOString() });
}

/**
 * Has the server's own scheduler been heard from recently? Tri-state on
 * purpose: true = ran recently, false = it has run and is not running now (or
 * cannot sign), null = nothing has ever been reported, which is not the same
 * claim as either.
 */
function schedulerAlive(s = readSettings()) {
  if (s.schedulerOk === false) return false;
  if (!s.schedulerAt) return null;
  const at = Date.parse(s.schedulerAt);
  if (!Number.isFinite(at)) return null;
  return Date.now() - at <= SCHEDULER_ALIVE_MS;
}

/** The scheduler's verdict for the modal: what it is, and when it last ran. */
export function reminderSchedulerStatus() {
  const s = readSettings();
  const alive = schedulerAlive(s);
  return { state: alive === false ? 'dead' : alive === true ? 'alive' : 'unknown', at: s.schedulerAt, ok: s.schedulerOk };
}

/**
 * The last reminder this device actually received, and by which path — read
 * from the same record every path writes. `by` is 'push' (the server sent it),
 * 'wake' (the browser's own background wake) or 'page' (the app was open).
 * Null when nothing has ever been recorded, which is itself the answer to
 * "it never fired".
 */
export async function readLastReminderDelivery() {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(WAKE_CACHE);
    const hit = await cache.match(WAKE_KEY);
    const rec = hit ? await hit.json() : null;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    if (typeof rec.fired !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec.fired)) return null;
    return {
      day: rec.fired,
      by: typeof rec.by === 'string' && rec.by ? rec.by : null,
      at: typeof rec.at === 'string' && rec.at ? rec.at : null,
    };
  } catch {
    return null; // an unreadable record is "nothing known", never a delivery
  }
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
  // The server's own last scheduler run, as the push probe reported it. Only a
  // timestamp with `schedulerOk: false` means "it ran and could not sign"; a
  // missing timestamp means "never asked", which must not read as a failure.
  const schedulerAt = typeof source.schedulerAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(source.schedulerAt)
    ? source.schedulerAt : null;
  const schedulerOk = source.schedulerOk === true ? true : source.schedulerOk === false ? false : null;
  return { enabled, time, lastFiredDate, pushSubscribed, pushEndpoint, pushZone, schedulerAt, schedulerOk };
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
  // Any open copy of the app is a trigger for the copies that are closed: the
  // same idempotent tick the platform's cron runs, fired at the hour the user
  // chose. Best effort and never awaited — a device with no sync has nothing
  // to fire it with, and its own banner has already been raised by then.
  triggerServerTick().catch(() => {});
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
    if (s.pushSubscribed && notificationPermission() === 'granted') {
      // A device whose zone no longer matches the one the server was told keeps
      // its push on the old zone's hour; re-announce it.
      if (s.pushZone !== currentZone()) updateReminderPushTime().catch(() => {});
      // Then check the subscription itself — and this one needs no clock or
      // travel to be wrong. A start is the only moment the device can find out
      // that the reminder it promises has quietly stopped existing, so the
      // check runs here rather than only when the settings screen is opened.
      verifyReminderPush().catch(() => {}); // best effort; the app is up either way
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

// The same honesty about the push half, and it is the half that fails silently.
// `pushSubscribed` in this device's own settings says a subscription was once
// stored; it cannot say that the SERVER still holds it (the scheduled sender
// prunes a record the push service calls gone, and a store that loses one takes
// the reminder with it) nor that the subscription is still bound to the key the
// server signs with (browsers bind one at subscribe time, and a push signed by
// any other key is refused — a rejection the sender can only count). Both look
// exactly like a reminder that fires only when the app is open. So the verdict
// is checked against the live subscription and the live server, never assumed.
let pushState = { state: 'unknown' }; // 'live' | 'healed' | 'off' | 'unreachable' | 'no-sync' | 'unsupported' | 'permission' | 'probe-failed' | 'key-mismatch' | 'no-record' | 'no-subscription' | 'unavailable' | 'unknown'

export function reminderPushStatus() {
  return { ...pushState };
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

/** The sibling URL that runs the sender's job on demand (same directory). */
function tickEndpoint(syncEndpoint) {
  if (typeof syncEndpoint !== 'string' || !syncEndpoint) return null;
  const m = /^(.*\/)[^/]+$/.exec(syncEndpoint);
  return m ? `${m[1]}reminders-tick` : null;
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

/**
 * Is the closed-app reminder actually still deliverable to THIS device?
 *
 * Two silent deaths, each of which looks exactly like a reminder that fires
 * only while the app is open, and neither of which anything else can notice:
 *
 *   1. the subscription is GONE. Chrome drops a push subscription on its own
 *      schedule (a rotated FCM token, a browser update, an OS that cleared the
 *      site's data), and the server-side record can go with it — the scheduled
 *      sender prunes one the push service calls gone. The device's own
 *      `pushSubscribed: true` is a memory of a subscribe that did happen, which
 *      is why it is not the truth about what happens tonight.
 *   2. the subscription is bound to a DIFFERENT KEY than the server signs with.
 *      The pair comes from the site's env vars or is derived from a secret
 *      (see lib/webpush.mjs), and changing either changes the key — after
 *      which every push the sender signs is refused by the push service and
 *      counted in a log nobody reads. A browser binds its subscription at
 *      subscribe() time, so the only repair is a new subscription.
 *
 * Both repairs are the same operation — subscribe again and store the record
 * again — and both are safe to attempt without a prompt, because this only runs
 * for a device that already has permission. A failure to reach the server is
 * NOT a verdict: nothing is cleared, nothing is re-subscribed, and the status
 * says so, because a phone in a tunnel must not have its reminder torn down.
 */
export async function verifyReminderPush() {
  const settle = (state, extra = {}) => { pushState = { state, at: Date.now(), ...extra }; return { ...pushState }; };
  const s = getReminderSettings();
  if (!s.pushSubscribed) return settle('off', { ok: true });
  if (!pushSupported()) return settle('unsupported');
  const sync = getSyncSettings();
  const base = sync.enabled ? pushEndpoint(sync.endpoint) : null;
  if (!base || !sync.password) return settle('no-sync');
  if (notificationPermission() !== 'granted') return settle('permission');
  let reg = null;
  try { reg = await navigator.serviceWorker.ready; } catch { return settle('unavailable'); }
  if (!reg || typeof reg.pushManager?.getSubscription !== 'function') return settle('unavailable');
  let sub = null;
  try { sub = await reg.pushManager.getSubscription(); } catch { return settle('unavailable'); }
  if (!sub) {
    // 1a. Nothing for a push to arrive at. Repair, don't ask — and if the
    // repair itself fails, say THAT rather than blaming the browser for not
    // handing over a subscription it no longer has.
    const healed = await subscribeReminderPush();
    return healed.ok ? settle('healed', { ok: true, healed: 'subscription' })
      : settle('no-subscription', { reason: healed.reason });
  }
  // The key the server would sign with, and the key this subscription is bound
  // to. `options` is the browser's own record of the subscribe() call; a
  // browser that does not expose it skips this check rather than guessing at
  // it (the probe below still answers for the record itself).
  let keyResp = null;
  try { keyResp = await pushFetch(base, { method: 'GET' }); } catch { return settle('unreachable'); }
  if (!keyResp.ok) return settle('unreachable', { status: keyResp.status });
  let publicKey = null;
  try { publicKey = (await keyResp.json()).publicKey; } catch { publicKey = null; }
  if (validPublicKey(publicKey)) {
    let bound = null;
    try {
      const raw = sub.options && sub.options.applicationServerKey;
      if (raw) bound = new Uint8Array(raw);
    } catch { bound = null; }
    if (bound) {
      const current = b64urlToBytes(publicKey);
      const same = bound.length === current.length && bound.every((b, i) => b === current[i]);
      if (!same) {
        // 2. Bound to a key the sender does not hold: every push is refused.
        try { await sub.unsubscribe(); } catch { /* dead to us either way */ }
        const healed = await subscribeReminderPush();
        return healed.ok ? settle('healed', { ok: true, healed: 'key' })
          : settle('key-mismatch', { reason: healed.reason });
      }
    }
  }
  // 1b. The record itself: the address the sender writes to. Asking is the only
  // way to know, and the ask (PUT with a probe) never sends a notification.
  let probe = null;
  try { probe = await probePushRecord(base, sync.password, sub.endpoint); } catch { return settle('unreachable'); }
  if (probe.status === 404) {
    const healed = await subscribeReminderPush();
    return healed.ok ? settle('healed', { ok: true, healed: 'record' })
      : settle('no-record', { reason: healed.reason });
  }
  if (!probe.ok) return settle('probe-failed', { status: probe.status });
  // The probe answers with the sender's own heartbeat as well as this device's
  // record. Keep it: "your device is stored" and "the sender is running" are
  // two different promises, and the second one is what a platform whose cron
  // has stopped breaks — silently, with a phone that shows nothing and an app
  // that still reads "Push is on". mirrorWakeRecord turns it into the worker's
  // deferral expiry.
  let scheduler = null;
  try { scheduler = (await probe.json())?.scheduler ?? null; } catch { scheduler = null; }
  if (scheduler && typeof scheduler.ranAt === 'string') {
    patchReminderSettings({ schedulerAt: scheduler.ranAt, schedulerOk: scheduler.ok === true });
  } else {
    // A server that reports no heartbeat at all (an older deploy) is not a
    // dead scheduler: keep the answer unknown rather than inventing either.
    patchReminderSettings({ schedulerAt: null, schedulerOk: null });
  }
  return settle('live', { ok: true });
}

/**
 * Fire the server's own sender job right now — the same run the platform's
 * scheduled function makes (netlify/functions/reminders-tick.mjs). Returns
 * `{ ok, scheduler }` where scheduler is the run's heartbeat.
 *
 * Two callers, one job: the reminder firing while this device is open (so any
 * open copy of the app is a trigger for the closed ones), and the modal's
 * "the scheduler has not run" repair, which needs both to run and to report.
 */
export async function triggerServerTick() {
  const sync = getSyncSettings();
  if (!sync.enabled || !sync.endpoint || !sync.password) return { ok: false, reason: 'no-sync' };
  const base = tickEndpoint(sync.endpoint);
  if (!base) return { ok: false, reason: 'invalid_endpoint' };
  try {
    const resp = await pushFetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...profileHeaders(sync.password) },
      body: '{}',
    });
    const body = await resp.json().catch(() => null);
    // The status rides along on every failure: "could not be reached" and "a
    // server answered and said no" are different problems, and only one of them
    // is worth retrying.
    if (!resp.ok) return { ok: false, reason: resp.status === 401 ? 'auth' : 'http', status: resp.status, message: `HTTP ${resp.status}` };
    const scheduler = body && body.scheduler && typeof body.scheduler === 'object' ? body.scheduler : null;
    if (scheduler && typeof scheduler.ranAt === 'string') {
      patchReminderSettings({ schedulerAt: scheduler.ranAt, schedulerOk: scheduler.ok === true });
    }
    return { ok: true, scheduler };
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'tick failed' };
  }
}

/**
 * Ask the server whether it still holds this device's record — WITHOUT sending
 * a test notification, which is what the plain PUT above (Send test push) is
 * for. Same authentication, same record lookup, no delivery.
 */
async function probePushRecord(base, password, endpoint) {
  return pushFetch(base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...profileHeaders(password) },
    body: JSON.stringify({ probe: true, endpoint }),
  });
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
