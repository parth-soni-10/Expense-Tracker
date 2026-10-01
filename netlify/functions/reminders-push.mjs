/* ============================================================
   reminders-push.mjs — Web Push subscription management for the
   daily reminder.

   GET  → { publicKey }  (the VAPID public key; the client needs it
          before calling pushManager.subscribe)
   POST { subscription, profileName, time, zone }
        → stores the subscription keyed by its endpoint hash AND the
          request's profile, tagged with the schedule to deliver at.
          Auth: the profile's app password in X-Cents-Password
          (+ X-Cents-Profile), exactly like sync.
   DELETE { subscription }
        → removes the stored subscription for THIS profile (user
          turned the reminder off, or the browser revoked it).
          Same auth.
   PUT   → sends an immediate test push to the caller's stored
           subscription. Same auth. A record that is only seconds old is
           not judged dead by a 404/410 from the push service — the send
           is retried once, and answered 425 while the registration is
           still arriving (pushSendWarming in lib/webpush.mjs).

   Why the app password gates this: a subscription endpoint URL is
   a capability — anyone who has it can push to that browser. We
   only accept subscriptions from someone who can already read the
   data, and we bind the stored record to the profile that created
   it, so one profile can neither read nor silence another's
   reminder.

   Storage: one Blobs key per (endpoint, profile) under "push/",
   { profileId, profileName, time, zone, subscription, createdAt }.
   The endpoint is never stored in plaintext; the key is
   SHA-256(endpoint) so URL-bearing keys cannot be enumerated, and
   re-subscribing overwrites cleanly.

   Env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, see
   scripts/generate-vapid-keys.mjs) and VAPID_SUBJECT (optional).
   Both keys are resolved through vapidConfig() in lib/webpush.mjs,
   which uses the configured pair only when it is a real, matching
   one and otherwise derives a pair from a server-only secret the
   deploy already has — so push works on a site whose environment
   was never configured by hand, and a swapped pair can never be
   served. Also: the profile's own app password (see
   lib/profiles.mjs) for auth.
   ============================================================ */

import { createHash } from 'node:crypto';
import { getStore } from './lib/store.mjs';
import { pushSendWarming, vapidConfig, PUSH_WARMUP_RETRY_MS } from './lib/webpush.mjs';
import { safeEqual, createFailureThrottle } from './lib/auth.mjs';
import { resolveProfileForAuth, profileAuthMessage, DEFAULT_PROFILE } from './lib/profiles.mjs';

const PUSH_PREFIX = 'push:';
const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password, X-Cents-Profile',
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

/*  One browser has ONE push subscription, shared by every profile on the
   device, so the stored key pairs the endpoint hash with the profile id:
   two profiles on one phone each keep their own schedule (and deleting one
   profile cannot silence the other). Records written before this function
   knew about profiles are keyed by endpoint alone and belong to the default
   profile; they are still honoured, and removed on the next re-subscribe so
   the same reminder is never delivered twice. */
function endpointKey(endpoint, profileId) {
  return `${PUSH_PREFIX}${createHash('sha256').update(String(endpoint)).digest('hex')}:${profileId}`;
}
function legacyEndpointKey(endpoint) {
  return PUSH_PREFIX + createHash('sha256').update(String(endpoint)).digest('hex');
}

/** Loopback, private-network or metadata addresses — never a push destination. */
function isLocalOrPrivateHostname(hostname) {
  // The trailing dot is a fully-qualified name for the same host
  // (`https://localhost./` resolves to loopback), so it is stripped before the
  // comparison rather than left as a way around it.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (host.includes(':')) { // IPv6 literal
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
      || /^::ffff:(127\.|10\.|192\.168\.)/.test(host);
  }
  return false;
}

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return false;
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 2000) return false;
  let url;
  try { url = new URL(sub.endpoint); } catch { return false; }
  // The endpoint is client-supplied and the server POSTs to it, so this decides
  // whether a stored subscription is a push destination or a way to make the
  // function fetch something else. Real push services are https on a public
  // host, and both are required — a deploy can then never be aimed at the
  // runtime's own loopback (the Lambda runtime API answers there), a private
  // network, or a metadata address.
  //
  // One exception, asked for explicitly: the integration harness runs a fake
  // push service on http://localhost and sets CENTS_TEST_LOCALHOST_PUSH itself
  // (scripts/test-reminder-push.mjs, documented in the README's testing
  // section). It is unset on a deploy, which is the whole point — this used to
  // be an unconditional localhost allowance, so every deploy accepted an
  // endpoint pointing at its own host, from any authenticated account.
  const testLoopback = process.env.CENTS_TEST_LOCALHOST_PUSH === '1';
  if (url.protocol !== 'https:') {
    if (!(testLoopback && url.protocol === 'http:' && url.hostname === 'localhost')) return false;
  } else if (isLocalOrPrivateHostname(url.hostname)) {
    return false;
  }
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length < 40 || keys.p256dh.length > 400) return false;
  if (typeof keys.auth !== 'string' || keys.auth.length < 12 || keys.auth.length > 400) return false;
  return /^[A-Za-z0-9_-]+$/.test(keys.p256dh) && /^[A-Za-z0-9_-]+$/.test(keys.auth);
}

function validTime(time) {
  return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function recordFrom({ profileId, profileName, time, zone, subscription }) {
  return {
    profileId,
    // Display-only (the notification body); bounded like the registry's names.
    profileName: typeof profileName === 'string' ? profileName.slice(0, 24) : '',
    time: validTime(time) ? time : '20:00',
    // IANA zone the device reported at subscribe time. The scheduled sender
    // resolves HH:MM in this zone. An unknown zone id is rejected here so
    // the sender can treat every stored zone as resolvable or UTC.
    zone: typeof zone === 'string' && zone.length > 1 && zone.length <= 40 && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone) ? zone : 'UTC',
    subscription: { endpoint: subscription.endpoint, keys: subscription.keys },
    createdAt: new Date().toISOString(),
  };
}

/** The stored record for this endpoint + profile, if any. */
async function findRecord(store, endpoint, profileId) {
  const key = endpointKey(endpoint, profileId);
  const record = await store.getJSON(key);
  if (record) return { key, record };
  if (profileId !== DEFAULT_PROFILE) return null;
  // Pre-profiles record: same endpoint, keyed alone, no profile tag.
  const legacyKey = legacyEndpointKey(endpoint);
  const legacy = await store.getJSON(legacyKey);
  return legacy ? { key: legacyKey, record: legacy } : null;
}

export default async (request, _context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);

  // Public: hand out the VAPID public key (not a secret — it ships in the
  // page anyway when subscribing).
  if (request.method === 'GET') {
    const vapid = vapidConfig();
    // 503, not 500: this is the site not being configured yet, not a crash, and
    // the client turns it into "push isn't switched on for this site" instead of
    // a bare HTTP error. Both keys are needed before a push can be encrypted,
    // so a public key alone is not enough to advertise.
    if (!vapid.ok) return err(`Push is not configured on this site yet - ${vapid.error}`, 503, cors);
    return ok({ publicKey: vapid.publicKey }, 200, cors);
  }

  const throttle = failureThrottle.check(request);
  if (!throttle.ok) {
    return new Response(JSON.stringify({ error: 'Too many failed attempts - retry later', code: 429 }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(throttle.retryAfterSeconds), ...cors } });
  }

  const profile = resolveProfileForAuth(request);
  if (!profile.ok) return err(profileAuthMessage(profile), 500, cors);
  if (!safeEqual(request.headers.get('x-cents-password') || '', profile.expected)) {
    throttle.record();
    await new Promise(r => setTimeout(r, 500));
    return err('Bad app password', 401, cors);
  }
  const auth = profile;

  let body = {};
  try { body = JSON.parse(await request.text() || '{}'); }
  catch { return err('Body is not valid JSON', 400, cors); }

  const store = await getStore();

  // ---------- UNSUBSCRIBE ----------
  if (request.method === 'DELETE') {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string') return err('Body.subscription.endpoint is required', 400, cors);
    const found = await findRecord(store, sub.endpoint, auth.id);
    if (found) await store.del(found.key);
    return ok({ removed: true }, 200, cors);
  }

  // ---------- TEST PUSH ----------
  if (request.method === 'PUT') {
    const found = typeof body.endpoint === 'string' ? await findRecord(store, body.endpoint, auth.id) : null;
    if (!found) {
      // Do not reveal whether the endpoint exists under another profile.
      return err('No push subscription found for this profile', 404, cors);
    }
    const { key, record } = found;
    const vapid = vapidConfig();
    if (!vapid.ok) return err('VAPID keys not configured on the function', 500, cors);
    const result = await pushSendWarming(record.subscription, {
      title: 'cents. — test reminder',
      body: record.profileName ? `Push works for ${record.profileName}.` : 'Push is working.',
      tag: 'cents-reminder-test',
    }, { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    { createdAt: record.createdAt });
    if (result.gone) {
      await store.del(key);
      return err('Subscription is no longer valid - re-enable push', 410, cors);
    }
    // A device that pressed Enable push and then Send test push within the same
    // breath. Nothing is wrong and nothing is deleted: the push service has not
    // been told about the registration yet (measured at under a second on real
    // FCM, and pushSendWarming already asked a second time). So the answer says
    // "in a moment", not "re-enable push" — the app keeps push switched on.
    if (result.warming) {
      return err('This device is still registering with the push service - try again in a moment', 425,
        { ...cors, 'Retry-After': String(Math.ceil(PUSH_WARMUP_RETRY_MS / 1000)) });
    }
    // The status rides along: a 401/403 here is the push service refusing our
    // VAPID signature (a key that no longer matches the subscription the browser
    // holds), which is a different problem from a 5xx at the far end — and the
    // first one is invisible without the code, because the app only has a
    // "nothing arrived" to report.
    if (!result.ok) return err(`Push service rejected the test message${result.status ? ` (HTTP ${result.status})` : ''}`, 502, cors);
    return ok({ sent: true }, 200, cors);
  }

  // ---------- SUBSCRIBE ----------
  if (request.method === 'POST') {
    const sub = body.subscription;
    if (!validSubscription(sub)) return err('Body.subscription is not a valid Web Push subscription', 400, cors);
    const record = recordFrom({
      profileId: auth.id,
      profileName: body.profileName,
      time: body.time,
      zone: body.zone,
      subscription: sub,
    });
    await store.setJSON(endpointKey(sub.endpoint, auth.id), record);
    // Drop a record written before profiles existed for this same endpoint,
    // or this device would receive the reminder twice.
    await store.del(legacyEndpointKey(sub.endpoint));
    return ok({ stored: true, time: record.time }, 200, cors);
  }

  return err('Method not allowed', 405, cors);
};
