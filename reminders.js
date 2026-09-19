/* ============================================================
   reminders.js — daily "upload your transactions" reminder.

   Per-profile setting (default 20:00 local time). Two delivery
   paths, because a web app can be closed at any moment:
     1. While the app is OPEN (any tab, locked or not): a
        setTimeout loop checks each minute whether the day's
        reminder time has passed and not yet fired, then shows an
        in-app toast + a system Notification (if permitted).
     2. On MOBILE web apps (installed PWA, or any phone browser), a
        Web Push subscription is sent to the server, whose Scheduled
        Function delivers a real push at the chosen local time even
        when the app is closed. Desktop is intentionally excluded:
        there the app lives in a tab and the in-app scheduler above
        is the right surface. See reminders-push.mjs.

   Fire state ("last fired" date) is per profile so each user is
   reminded about their own data.
   ============================================================ */

import { nsKey, activeProfile, getActiveProfileId } from './profiles.js';
import { getSyncSettings } from './settings.js';

const KEY = () => nsKey('reminder');

function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const time = typeof source.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(source.time)
    ? source.time : '20:00';
  const enabled = source.enabled === true;
  const lastFiredDate = typeof source.lastFiredDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.lastFiredDate)
    ? source.lastFiredDate : null;
  const pushSubscribed = source.pushSubscribed === true;
  const pushEndpoint = typeof source.pushEndpoint === 'string' && source.pushEndpoint ? source.pushEndpoint : null;
  return { enabled, time, lastFiredDate, pushSubscribed, pushEndpoint };
}

export function getReminderSettings() {
  try {
    const raw = localStorage.getItem(KEY());
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return normalize(null);
  }
}

export function patchReminderSettings(patch) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  // Merge onto stored state FIRST, then normalize the merged object so an
  // invalid patch field is dropped without resetting the untouched ones.
  const clean = normalize({ ...getReminderSettings(), ...source });
  try { localStorage.setItem(KEY(), JSON.stringify(clean)); } catch (e) { /* read-only storage */ }
  return clean;
}

/** Local YYYY-MM-DD for a Date (defaults to now). */
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Milliseconds until the next occurrence of HH:MM local time. */
function msUntil(time, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
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

/** Show the reminder now: system notification (if allowed) + a callback the
 *  app uses for its in-app toast. Safe to call while locked. */
export function showReminderNotification(profileName) {
  const title = 'cents. — time to upload your transactions';
  const body = profileName ? `Quick tally for ${profileName} — it takes a minute.` : 'Log today\'s spending while it\'s fresh.';
  if (notificationPermission() === 'granted') {
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

function fire() {
  let profileName = null;
  try { profileName = activeProfile().name; } catch { /* registry unavailable */ }
  const payload = showReminderNotification(profileName);
  for (const fn of listeners) { try { fn(payload); } catch { /* listener error never breaks the loop */ } }
}

function tick() {
  const s = getReminderSettings();
  const todayKey = localDateKey();
  if (!s.enabled || s.lastFiredDate === todayKey) return;
  const [h, m] = s.time.split(':').map(Number);
  const now = new Date();
  const due = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  if (due) {
    patchReminderSettings({ lastFiredDate: todayKey });
    fire();
  }
}

/** Start the minute-check loop. Idempotent; runs regardless of lock state. */
export function startReminderScheduler() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 60 * 1000);
  // Catch devices that sleep through the interval boundary.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  }
}

// ---------- closed-app push (Web Push via the Netlify functions) ----------
// While the app is open, the scheduler above is enough. When it is closed,
// delivery needs a real Web Push subscription: the browser hands us an
// endpoint + keys, the server stores them per profile, and a scheduled
// function fires the push at the profile's local time. Subscribing requires
// the profile's app password (same credential as cloud sync) so random
// sites cannot seed reminders into someone's store.

const PUSH_TIMEOUT_MS = 12000;

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

async function pushFetch(url, init, timeoutMs = PUSH_TIMEOUT_MS) {
  return Promise.race([
    fetch(url, { cache: 'no-store', ...init }),
    new Promise((_res, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
}

/**
 * Closed-app push is a mobile-web-app feature only: phones (any mobile
 * browser, installed PWA or not). Desktop is intentionally excluded —
 * including desktop-installed PWAs — because there the app lives in a tab
 * on a machine that is on, and the in-app scheduler is the right surface.
 * Matches the UA convention of app.js's isMobileDevice().
 */
function mobileWebApp() {
  return typeof window !== 'undefined'
    && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

export function pushSupported() {
  return mobileWebApp()
    && typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/**
 * Subscribe this browser to closed-app reminders for the ACTIVE profile.
 * Requires sync to be configured (the app password gates the store).
 * Returns { ok: true } or { ok: false, reason, message? }.
 */
export async function subscribeReminderPush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }; // includes desktop: mobile web apps only
  const sync = getSyncSettings();
  if (!sync.enabled || !sync.endpoint || !sync.password) return { ok: false, reason: 'no-sync' };
  const base = pushEndpoint(sync.endpoint);
  if (!base) return { ok: false, reason: 'invalid_endpoint' };
  try {
    const keyResp = await pushFetch(base, { method: 'GET' });
    if (!keyResp.ok) return { ok: false, reason: 'http', message: `key HTTP ${keyResp.status}` };
    const { publicKey } = await keyResp.json();
    if (typeof publicKey !== 'string' || publicKey.length < 40) return { ok: false, reason: 'http', message: 'bad VAPID key' };

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToBytes(publicKey),
      });
    }
    const subJson = sub.toJSON();
    let profileName = null;
    try { profileName = activeProfile().name; } catch { /* registry unavailable */ }
    const resp = await pushFetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cents-Password': sync.password,
        'X-Cents-Profile': getActiveProfileId() || 'personal',
      },
      body: JSON.stringify({
        subscription: subJson,
        profileId: getActiveProfileId() || 'personal',
        profileName,
        time: getReminderSettings().time,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      }),
    });
    if (resp.status === 401) return { ok: false, reason: 'auth' };
    if (!resp.ok) return { ok: false, reason: 'http', message: `HTTP ${resp.status}` };
    patchReminderSettings({ pushSubscribed: true, pushEndpoint: sub.endpoint });
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
          headers: {
            'Content-Type': 'application/json',
            'X-Cents-Password': sync.password,
            'X-Cents-Profile': getActiveProfileId() || 'personal',
          },
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

/** Ask the server to push a test message to this profile's subscription. */
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
        'X-Cents-Password': sync.password,
        'X-Cents-Profile': getActiveProfileId() || 'personal',
      },
      body: JSON.stringify({ endpoint: s.pushEndpoint }),
    });
    if (resp.ok) return { ok: true };
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

/** Re-announce the current time/zone for this profile after a time change. */
export async function updateReminderPushTime() {
  const s = getReminderSettings();
  if (!s.pushSubscribed) return { ok: true, skipped: true };
  return subscribeReminderPush(); // POST overwrites the stored record
}
