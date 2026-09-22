/* ============================================================
   reminders-push.mjs — Web Push subscription management for the
   daily reminder.

   GET  → { publicKey }  (the VAPID public key; the client needs it
          before calling pushManager.subscribe)
   POST { subscription, time }
        → stores the subscription keyed by a hash of its endpoint,
          tagged with the schedule to deliver at. Auth: the app
          password in X-Cents-Password, exactly like sync.
   DELETE { subscription }
        → removes the stored subscription (user turned the reminder
          off, or the browser revoked it). Same auth.
   PUT   → sends an immediate test push to the caller's stored
           subscription. Same auth.

   Why the app password gates this: a subscription endpoint URL is
   a capability — anyone who has it can push to that browser. We
   only accept subscriptions from someone who can already read the
   data, and the scheduled sender delivers whatever schedule each
   stored record carries.

   Storage: one Blobs key per subscription under "push/",
   { time, zone, subscription, createdAt }.
   The endpoint is never stored in plaintext; the key is
   SHA-256(endpoint) so URL-bearing keys cannot be enumerated, and
   duplicates (same endpoint re-subscribed) overwrite cleanly.

   Env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, see
   scripts/generate-vapid-keys.mjs), plus APP_PASSWORD for auth.
   ============================================================ */

import { createHash } from 'node:crypto';
import { getStore } from './lib/store.mjs';
import { pushSend } from './lib/webpush.mjs';
import { safeEqual, createFailureThrottle } from './lib/auth.mjs';

const PUSH_PREFIX = 'push:';
const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
  if (origin) { cors['Access-Control-Allow-Origin'] = origin; cors['Vary'] = 'Origin'; }
  return cors;
}

const ok = (body, status = 200, cors = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...cors } },
);
const err = (msg, status = 400, cors = {}) => ok({ error: msg, code: status }, status, cors);

function endpointKey(endpoint) {
  return PUSH_PREFIX + createHash('sha256').update(String(endpoint)).digest('hex');
}

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return false;
  // Real push services are always https; localhost http is allowed so the
  // integration harness (scripts/test-reminder-push.mjs) can run a fake
  // push service locally.
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 2000) return false;
  if (!/^https:\/\//.test(sub.endpoint) && !/^http:\/\/localhost(:\d+)?\//.test(sub.endpoint)) return false;
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length < 40 || keys.p256dh.length > 400) return false;
  if (typeof keys.auth !== 'string' || keys.auth.length < 12 || keys.auth.length > 400) return false;
  return /^[A-Za-z0-9_-]+$/.test(keys.p256dh) && /^[A-Za-z0-9_-]+$/.test(keys.auth);
}

function validTime(time) {
  return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function recordFrom({ time, zone, subscription }) {
  return {
    time: validTime(time) ? time : '20:00',
    // IANA zone the device reported at subscribe time. The scheduled sender
    // resolves HH:MM in this zone. An unknown zone id is rejected here so
    // the sender can treat every stored zone as resolvable or UTC.
    zone: typeof zone === 'string' && zone.length > 1 && zone.length <= 40 && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone) ? zone : 'UTC',
    subscription: { endpoint: subscription.endpoint, keys: subscription.keys },
    createdAt: new Date().toISOString(),
  };
}

/** Resolve true when the request carries the app password. */
function authenticate(request) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  const got = request.headers.get('x-cents-password') || '';
  return safeEqual(got, expected);
}

export default async (request, _context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);

  // Public: hand out the VAPID public key (not a secret — it ships in the
  // page anyway when subscribing).
  if (request.method === 'GET') {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    // 503, not 500: this is the site not being configured yet, not a crash, and
    // the client turns it into "push isn't switched on for this site" instead of
    // a bare HTTP error. Both keys are needed before a push can be encrypted,
    // so a public key alone is not enough to advertise.
    if (!publicKey || !process.env.VAPID_PRIVATE_KEY) {
      return err('Push is not configured on this site yet - set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Netlify', 503, cors);
    }
    return ok({ publicKey }, 200, cors);
  }

  const throttle = failureThrottle.check(request);
  if (!throttle.ok) {
    return new Response(JSON.stringify({ error: 'Too many failed attempts - retry later', code: 429 }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(throttle.retryAfterSeconds), ...cors } });
  }

  const authed = authenticate(request);
  if (!authed) {
    throttle.record();
    await new Promise(r => setTimeout(r, 500));
    return err('Bad app password', 401, cors);
  }

  let body = {};
  try { body = JSON.parse(await request.text() || '{}'); }
  catch { return err('Body is not valid JSON', 400, cors); }

  const store = await getStore();

  // ---------- UNSUBSCRIBE ----------
  if (request.method === 'DELETE') {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string') return err('Body.subscription.endpoint is required', 400, cors);
    await store.del(endpointKey(sub.endpoint));
    return ok({ removed: true }, 200, cors);
  }

  // ---------- TEST PUSH ----------
  if (request.method === 'PUT') {
    const key = body.endpoint ? endpointKey(body.endpoint) : null;
    const record = key ? await store.getJSON(key) : null;
    if (!record) {
      return err('No push subscription found for this endpoint', 404, cors);
    }
    const vapid = { subject: process.env.VAPID_SUBJECT || 'cents@example.com', publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    if (!vapid.publicKey || !vapid.privateKey) return err('VAPID keys not configured on the function', 500, cors);
    const result = await pushSend(record.subscription, {
      title: 'cents. — test reminder',
      body: 'Push is working.',
      tag: 'cents-reminder-test',
    }, vapid);
    if (result.gone) {
      await store.del(key);
      return err('Subscription is no longer valid - re-enable push', 410, cors);
    }
    if (!result.ok) return err('Push service rejected the test message', 502, cors);
    return ok({ sent: true }, 200, cors);
  }

  // ---------- SUBSCRIBE ----------
  if (request.method === 'POST') {
    const sub = body.subscription;
    if (!validSubscription(sub)) return err('Body.subscription is not a valid Web Push subscription', 400, cors);
    const record = recordFrom({
      time: body.time,
      zone: body.zone,
      subscription: sub,
    });
    await store.setJSON(endpointKey(sub.endpoint), record);
    return ok({ stored: true, time: record.time }, 200, cors);
  }

  return err('Method not allowed', 405, cors);
};
