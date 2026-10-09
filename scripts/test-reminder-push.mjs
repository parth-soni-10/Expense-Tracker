#!/usr/bin/env node
/**
 * Local integration harness for the reminder push pipeline.
 *
 *   0. the ciphertext against RFC 8291's own published test vector
 *   0b. the VAPID seed this repo generates is always signable
 *   0c. where the signing pair comes from: a configured pair is used only when
 *         it really is a pair, and otherwise one is derived from a secret the
 *         deploy already has (the fallback that makes push work on a site whose
 *         environment was never configured, and the reason a swapped pair can
 *         no longer be served as if it were public)
 *   1-11. browser subscribe → server store → scheduled dispatch → delivery
 *         to a FAKE local push service → dead-subscription pruning →
 *         unsubscribe → two profiles on one device
 *   7c. a device that has only just subscribed: 404/410 on a record seconds old
 *         is not a death verdict (a measurement of real FCM is in the section)
 *   12. the dispatcher reads the record's own clock, not UTC's
 *   13. the key the browser is handed is the key the dispatcher signs with
 *   14. the LOCAL scheduler raises its banner AT ITS HOUR, and never as a
 *         catch-up on the moment the site is opened
 *   15. closed-app push is gated on the browser's capability, never on the
 *         device it runs on — a desktop with nothing open at the hour needs
 *         the same path a phone does
 *   16. the reminder survives a storage that will not keep it: a refused
 *         marker write must not become a banner every minute, and a blocked
 *         read must not become "the reminder is off"
 *   17. the zone a travelling device announces to the sender: re-told on
 *         start only when subscribed, mismatched and permitted — and a
 *         refused announce leaves the old record so the NEXT start retries
 *   18. the background wake: one banner a day across the three paths, and a
 *         deferral to an armed push that EXPIRES — a scheduler that stopped
 *         sending hands the day back rather than silencing the net forever
 *   19-21. the bills hint the sender appends, the read path behind it, and the
 *         probe that answers "is my reminder still deliverable?"
 *   22. the sender's own heartbeat, and the HTTP trigger (reminders-tick) that
 *         runs the same job when the platform's cron stops firing
 *
 *   node scripts/test-reminder-push.mjs
 *
 * Check 0 exists because the rest of this file CANNOT catch a wrong key
 * derivation on its own: encryptor and decryptor live in the same repo, so a
 * scheme both agree on passes here while every real browser discards the push
 * (the failure mode this harness was blind to until the vector was added).
 * The vector is the RFC's fixed salt/key material, so the expected bytes are
 * an external constant rather than anything this repo computed.
 *
 * Runs fully in-process: the functions fall back to the shared in-memory
 * store outside Netlify's runtime (lib/store.mjs), and the fake push service
 * decrypts the aes128gcm body the way a browser does — header salt, per-info
 * expansions, padding delimiter checked. The dispatcher gets an injectable
 * clock so the "due now" case is deterministic, not flaky.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---------- verifying the VAPID JWT, the way a push service does ----------
// The harness used to record the Authorization header and assert the `k` inside
// it, and nothing more — so the SIGNATURE was never checked anywhere, and a JWS
// assembled from DER's own integer bytes (63/65/66 bytes instead of ES256's
// fixed 64) travelled this whole suite as a success while every real push
// service rejected it. That shipped: a phone that showed nothing, for a push the
// app called sent. This is the check that closes the blind spot, and the fake
// service below applies it to EVERY request it receives.
const b64u = (s) => Buffer.from(s, 'base64url');

/** DER SEQUENCE of two INTEGERs, from a raw r || s signature (to re-verify). */
function rawToDer(raw) {
  const int = (buf) => {
    let b = buf;
    while (b.length > 1 && b[0] === 0) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32, 64))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** Why this Authorization header is not good enough for this audience, or null.
 *  Every reason is one a push service would refuse on. */
function vapidFailure(auth, audience) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(String(auth || ''));
  if (!m) return `authorization is not "vapid t=…, k=…": ${auth}`;
  const [, token, k] = m;
  const [h, c, s] = token.split('.');
  if (!h || !c || !s) return `JWT has ${token.split('.').length} parts`;
  let header; let claims; let sig;
  try {
    header = JSON.parse(b64u(h).toString('utf8'));
    claims = JSON.parse(b64u(c).toString('utf8'));
    sig = b64u(s);
  } catch (e) { return `JWT is not decodable: ${e.message}`; }
  if (header.alg !== 'ES256') return `alg=${header.alg}`;
  const point = b64u(k);
  if (point.length !== 65 || point[0] !== 4) return `k is ${point.length} bytes`;
  // The one that shipped: ES256 is r || s, 32 bytes each, always.
  if (sig.length !== 64) return `signature is ${sig.length} bytes, not 64 (r and s must each be 32)`;
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  if (!crypto.createVerify('SHA256').update(`${h}.${c}`).verify(pub, rawToDer(sig))) return 'signature does not verify';
  if (claims.aud !== audience) return `aud=${claims.aud}, want ${audience}`;
  if (!(claims.exp > Math.floor(Date.now() / 1000))) return `exp=${claims.exp} is in the past`;
  if (typeof claims.sub !== 'string' || !/^(mailto:|https:)/.test(claims.sub)) return `sub=${claims.sub}`;
  return null;
}

// ---------- fake push service (verifies + decrypts like a real one) ----------
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const AUTH = crypto.randomBytes(16);
let received = [];
let endpointAlive = true;
// A registration the service has not been told about YET — a device that
// subscribed a moment ago, which is exactly what a real FCM answers 404/410 to.
// Counted down, so the app's retry meets a service that has caught up;
// Infinity keeps it cold for the cases that must never settle.
let unregistered = 0;
let endpointHits = 0;
// A push service that answers and says NO, with this status. The other way a
// delivery fails is not an answer at all (an endpoint with nothing behind it,
// no status) and the app has to tell the two apart — see 7b.
let refuseWith = null;
// The VAPID Authorization header of the most recent request. A real push
// service checks it, which is why it is worth asserting: the key the browser
// was handed and the key the dispatcher signs with must be the same one, or
// every push is accepted by the service and dropped by the browser in silence.
let lastAuth = null;
// Every header of the most recent push request. The delivery-timing contract
// rides here: a real push service acts on Urgency (Android defers a
// normal-urgency message in doze until the phone next wakes — how a 20:00
// reminder arrived hours late) and on TTL (the bound on lateness for a device
// that is unreachable), so neither can drift without a test saying so.
let lastHeaders = null;
const fakePushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    lastAuth = req.headers.authorization || null;
    lastHeaders = req.headers;
    // Authentication comes first, as it does on a real service: a request whose
    // VAPID JWT does not hold up never reaches the endpoint's own state, so a
    // broken signature shows up as a 401 and a delivery the suite does not see.
    const badAuth = vapidFailure(lastAuth, `http://${req.headers.host}`);
    if (badAuth) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end(badAuth); return; }
    if (!endpointAlive) { res.writeHead(410); res.end(); return; }
    endpointHits += 1;
    if (unregistered > 0) {
      if (unregistered !== Infinity) unregistered -= 1;
      res.writeHead(410); res.end(); return;
    }
    // Authenticated, so the request is real — now the service's own answer.
    if (refuseWith) { res.writeHead(refuseWith, { 'Content-Type': 'text/plain' }); res.end('no'); return; }
    try {
      const body = Buffer.concat(chunks);
      // aes128gcm header: salt(16) | rs(4) | idlen(1) | as_public(idlen)
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const ciphertext = body.subarray(21 + idlen);
      const ecdhSecret = ua.computeSecret(asPublic);
      const hkdf = (salt, ikm, info, len) => {
        const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
        const out = []; let prev = Buffer.alloc(0);
        for (let i = 1; Buffer.concat(out).length < len; i += 1) {
          prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
          out.push(prev);
        }
        return Buffer.concat(out).subarray(0, len);
      };
      // ecdh_secret -> IKM (WebPush: info), then CEK and NONCE per RFC 8291
      // section 3.4: both expansions are salted with the header salt, and the
      // nonce gets its own info string.
      const ikm = hkdf(AUTH, ecdhSecret, Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(subscription.keys.p256dh, 'base64url'), asPublic]), 32);
      const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
      const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
      const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      dec.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plain = Buffer.concat([dec.update(ciphertext.subarray(0, ciphertext.length - 16)), dec.final()]);
      // RFC 8291 section 4: a receiver MUST check the padding delimiter.
      if (plain[plain.length - 1] !== 2) throw new Error('bad padding delimiter');
      received.push(JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8')));
      res.writeHead(201); res.end();
    } catch (e) {
      received.push({ decryptError: e.message });
      res.writeHead(400); res.end();
    }
  });
});
// Port 0 = let the OS pick a free one. A hard-coded port would make this
// suite fail on a machine (or build container) where that port is taken, and
// it is wired into the deploy as a gate.
await new Promise(r => fakePushServer.listen(0, r));
const pushPort = fakePushServer.address().port;
// Keep the process exit clean on Windows: an open listening handle at
// exit trips a libuv assertion in some Node builds.
fakePushServer.unref();

const subscription = {
  endpoint: `http://localhost:${pushPort}/fake-push`,
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: AUTH.toString('base64url') },
};

// ---------- env + fresh in-memory store per run ----------
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
process.env.APP_PASSWORD = 'test-password-123';
process.env.APP_PASSWORD_SAM = 'sam-password-123';
delete process.env.APP_PASSWORD_KATE;
// The fake push service below is http://localhost, and reminders-push accepts a
// loopback endpoint only when this is set — the exception is opt-in precisely so
// that no deploy accepts one (see validSubscription). Check 2b pins the opt-in
// in both directions, so it can never quietly become the default again.
process.env.CENTS_TEST_LOCALHOST_PUSH = '1';
const { generateVapidKeys, encryptPayload, pushSend, vapidSeed, vapidConfig } = await import('../netlify/functions/lib/webpush.mjs');
const keys = generateVapidKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;

// The store is a module singleton; importing store.mjs BEFORE the handlers
// and letting the fallback resolve in-memory means everything in this
// process shares one map. (No cross-run leakage: process exits at end.)
const { default: pushHandler } = await import('../netlify/functions/reminders-push.mjs');
const sendModule = await import('../netlify/functions/reminders-send.mjs');
const sendHandler = sendModule.default;
const tickModule = await import('../netlify/functions/reminders-tick.mjs');
const tickHandler = tickModule.default;
const runModule = await import('../netlify/functions/lib/reminder-run.mjs');
const { getStore, openStore } = await import('../netlify/functions/lib/store.mjs');

function call(handler, method, body, extraHeaders = {}) {
  const req = new Request('http://localhost/.netlify/functions/reminders-push', {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Cents-Password': 'test-password-123', ...extraHeaders },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return handler(req, {});
}
const text = (r) => r.text();

const results = {};
// `detail` is only printed when a check fails, and several calls below have
// always passed one — it used to be dropped on the floor, which is the wrong
// time to lose the only evidence of what was met.
const check = (name, pass, detail) => {
  results[name] = !!pass;
  if (!pass) console.log(`  \u2717 ${name}${detail === undefined ? '' : ` \u2014 ${detail}`}`);
};

// ---------- 0e. every signature is a well-formed ES256 JWS ----------
// A single signature proves nothing here, which is how the bug below shipped:
// DER's INTEGER encoding drops a leading zero byte or adds a sign byte about
// three times in four, so copying those bytes into the JWS produces a
// 63/65/66-byte signature MOST of the time and a valid-looking one the rest —
// a one-shot check would pass a quarter of the time and, worse, the suite had
// no check at all. Twenty-four signings, each verified by the fake service as a
// real one verifies it, make a miss a 4 × 10^-15 coincidence.
let signedOk = 0;
for (let i = 0; i < 24; i += 1) {
  const r = await pushSend(subscription, { title: 'signature batch', body: 'b', tag: `batch-${i}` }, {
    subject: 'mailto:test@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey,
  });
  if (r.ok) signedOk += 1;
}
check('every VAPID signature is a 64-byte ES256 JWS a push service accepts', signedOk === 24, `${signedOk}/24 accepted`);
received.length = 0;

// ---------- 0. RFC 8291 section 5 / appendix A test vector ----------
// Fixed salt, sender private key and receiver keys from the RFC, so this is
// the only assertion here whose expected value comes from outside this repo.
const RFC8291_VECTOR_SUB = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const vectorBody = encryptPayload(RFC8291_VECTOR_SUB, 'When I grow up, I want to be a watermelon', {
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
}).toString('base64url');
check('rfc8291-test-vector', vectorBody ===
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg'
  + 'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVB'
  + 'St2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');

// ---------- 0b. the key material this repo generates ----------
// Node's ECDH.getPrivateKey() never left-pads: a P-256 key whose leading byte
// is zero comes back a byte short (84 of 20,000 keys, measured), so
// generateVapidKeys() used to hand out a 42-character seed that the signing
// code in the same module refused with "bad VAPID private key length". Nothing
// in the environment was involved, which is exactly why it looked like a
// deploy-only failure: the build drew such a key and died inside a scheduled
// run. Both halves are pinned here — a seed in that short shape still signs,
// and the generator never emits one.
// A REAL pair whose scalar begins with a zero byte, so the short form is a key
// rather than a made-up string: the signing path pads the seed back to 32
// bytes, and the JWT it signs now has to verify against the point that seed
// really owns (the fake push service checks that — see vapidFailure).
const paddedSeed = Buffer.concat([Buffer.alloc(1, 0), Buffer.from(keys.privateKey, 'base64url').subarray(1)]);
const droppedZero = paddedSeed.subarray(1).toString('base64url'); // 42 chars: the shape a dropped zero byte produces
const droppedPublic = (() => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(paddedSeed);
  return ecdh.getPublicKey().toString('base64url');
})();
const droppedZeroSign = await pushSend(subscription, { title: 'cents. — test reminder', body: 'key padding' }, {
  subject: 'mailto:test@example.com', publicKey: droppedPublic, privateKey: droppedZero,
}).then(
  r => r.ok === true,
  e => e.message, // a throw here IS the regression; report it instead of dying
);
check('a seed whose leading zero byte was dropped still signs', droppedZeroSign === true, droppedZeroSign);
check('the short form is left-padded to the curve size',
  vapidSeed(droppedZero).length === 32 && vapidSeed(droppedZero)[0] === 0,
  `${vapidSeed(droppedZero).length} bytes`);
check('a full-length seed passes through unchanged',
  vapidSeed(keys.privateKey).equals(Buffer.from(keys.privateKey, 'base64url')));
check('a public key pasted as the private key is still refused',
  (() => { try { vapidSeed(keys.publicKey); return false; } catch { return true; } })());
let unpadded = 0;
for (let i = 0; i < 3000; i += 1) {
  if (Buffer.from(generateVapidKeys().privateKey, 'base64url').length !== 32) unpadded += 1;
}
check('every generated key is already a full-length seed', unpadded === 0, `${unpadded} of 3000 unpadded`);

// ---------- 0c. where the signing pair comes from ----------
// The pair is the one piece of configuration whose mistakes are invisible from
// inside this repo: a deploy whose variables are set but not yet delivered
// answers 503 (measured on this project's own site, twice, while chasing it),
// and a deploy whose two values are SWAPPED serves the private half as if it
// were public. That second one is the worse failure — this endpoint is
// unauthenticated by design, so the seed becomes public, and no browser will
// subscribe with it either (32 bytes is not a point), so push is broken in both
// directions at once while the app can only report a generic error. Both
// outcomes are pinned here, as pure calls against a supplied env.
const OTHER_PAIR = generateVapidKeys();
const deployedSecret = { GITHUB_TOKEN: 'a-deploy-secret-long-enough-to-derive-from' };
check('a configured, matching pair is used as given',
  vapidConfig({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }).source === 'env');
check('a pair whose halves are swapped is ignored, not served', (() => {
  const c = vapidConfig({ VAPID_PUBLIC_KEY: keys.privateKey, VAPID_PRIVATE_KEY: keys.publicKey, ...deployedSecret });
  return c.ok === true && c.source === 'derived:GITHUB_TOKEN' && c.publicKey !== keys.privateKey;
})());
check('a public key that belongs to another pair is ignored', (() => {
  const c = vapidConfig({ VAPID_PUBLIC_KEY: OTHER_PAIR.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, ...deployedSecret });
  return c.ok === true && c.source === 'derived:GITHUB_TOKEN' && c.publicKey !== OTHER_PAIR.publicKey;
})());
check('one half on its own is ignored',
  vapidConfig({ VAPID_PUBLIC_KEY: keys.publicKey, ...deployedSecret }).source === 'derived:GITHUB_TOKEN');
check('derivation is deterministic', (() => {
  const a = vapidConfig(deployedSecret), b = vapidConfig(deployedSecret);
  return a.publicKey === b.publicKey && a.privateKey === b.privateKey;
})());
check('and the derived pair really is a pair', (() => {
  const c = vapidConfig(deployedSecret);
  const point = Buffer.from(c.publicKey, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(vapidSeed(c.privateKey));
  return point.length === 65 && point[0] === 4 && ecdh.getPublicKey().equals(point);
})());
check('a different secret derives a different pair',
  vapidConfig(deployedSecret).publicKey
  !== vapidConfig({ GITHUB_TOKEN: 'another-deploy-secret-long-enough' }).publicKey);
// A secret short enough to guess makes the private half brute-forceable, since
// this file is public and would then be the only unknown.
check('a guessable secret is not key material', vapidConfig({ GITHUB_TOKEN: 'short' }).ok === false);
check('with nothing to derive from there is no pair, and the reason names both ways out', (() => {
  const none = vapidConfig({});
  return none.ok === false && /VAPID_PUBLIC_KEY/.test(none.error) && /GITHUB_TOKEN/.test(none.error);
})());
// Existing is not enough: the derived pair must sign and encrypt like any other.
const derivedCfg = vapidConfig(deployedSecret);
received.length = 0;
const derivedPush = await pushSend(subscription, { title: 'cents. — derived pair', body: 'derived' },
  { subject: derivedCfg.subject, publicKey: derivedCfg.publicKey, privateKey: derivedCfg.privateKey });
check('the derived pair signs a real push',
  derivedPush.ok === true && received.length === 1 && received[0].title === 'cents. — derived pair');

// The CLIENT half of the same judgement, because it is the one that has to name
// a bad key on a phone — and a length threshold cannot do it: the 43-character
// seed is longer than any "looks like a key" threshold, which is exactly the
// value a swapped pair serves. The browser's refusal arrives as an
// InvalidAccessError, and without this the app called it a network error.
const { validPublicKey } = await import('../reminders.js');
check('the client accepts a real public key', validPublicKey(keys.publicKey) === true);
check('and refuses the private seed served as one', validPublicKey(keys.privateKey) === false);
check('and refuses a truncated key', validPublicKey(keys.publicKey.slice(0, 40)) === false);

// ---------- 0d. what a Chromium-based Android browser requires ----------
// Chrome on Android subscribes from a plain tab (unlike iOS, which needs the
// app added to the Home Screen first), so it is the surface a phone test most
// often lands on — and it asks for two things the iOS path does not:
//   * the notification permission to be GRANTED, asked for from the click,
//     because subscribe() is refused outright when it is denied and the prompt
//     itself is only allowed inside a user gesture;
//   * a gcm_sender_id in the web app manifest, for the Android browsers that
//     still take the GCM path (Samsung Internet, Opera). The value is Chrome's
//     own push sender id, which is public and the same for every site — a
//     project-specific number here is a subscription no push service accepts.
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
check('the manifest carries the sender id Chromium Android looks for',
  manifest.gcm_sender_id === '103953800507', String(manifest.gcm_sender_id));
const swSource = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
check('the worker shows the notification a push delivers',
  /addEventListener\('push'/.test(swSource) && /showNotification\(/.test(swSource));
check('and tapping it opens the app', /addEventListener\('notificationclick'/.test(swSource));
const remindersSource = readFileSync(new URL('../reminders.js', import.meta.url), 'utf8');
check('the subscribe is userVisibleOnly, which Chrome requires',
  /userVisibleOnly:\s*true/.test(remindersSource));
// Scoped to the subscribe function: the same call appears elsewhere in the
// file, and "somewhere before it" is not the order that matters.
const fnStart = remindersSource.indexOf('export async function subscribeReminderPush');
const askAt = remindersSource.indexOf('await requestNotificationPermission()', fnStart);
const subscribeAt = remindersSource.indexOf('pushManager.subscribe', fnStart);
check('and permission is asked for first, inside the same call',
  fnStart > -1 && askAt > fnStart && subscribeAt > fnStart && askAt < subscribeAt,
  `ask@${askAt} subscribe@${subscribeAt} fn@${fnStart}`);

// ---------- 1. GET returns the VAPID public key ----------
const keyResp = await call(pushHandler, 'GET');
check('get-public-key', (JSON.parse(await text(keyResp))).publicKey === keys.publicKey);

// A site with no push keys must say so in a way the app can act on: 503 (the
// site isn't configured yet) rather than a bare 500, naming the variables to
// set. The client turns exactly this into "push isn't switched on for this
// site yet" instead of "key HTTP 500".
const savedKeys = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
const savedGithubToken = process.env.GITHUB_TOKEN;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
// "Unconfigured" now means no key material at all, so the derive-from secret
// has to be out of the picture too — otherwise this asserts the fallback rather
// than the 503 (and on a machine that happens to export GITHUB_TOKEN it would
// fail for the wrong reason).
delete process.env.GITHUB_TOKEN;
const unconfigured = await call(pushHandler, 'GET');
const unconfiguredText = await text(unconfigured);
check('unconfigured-push-503', unconfigured.status === 503 && /VAPID_PUBLIC_KEY/.test(unconfiguredText));
check('and the 503 names the other way out of it', /GITHUB_TOKEN/.test(unconfiguredText), unconfiguredText);
[process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = savedKeys;
if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
else process.env.GITHUB_TOKEN = savedGithubToken;

// ---------- 2. auth required ----------
const unauth = await call(pushHandler, 'POST', { subscription }, { 'X-Cents-Password': 'wrong-password' });
check('auth-required', unauth.status === 401);

// ---------- 2b. the loopback exception is opt-in, and private hosts stay out --
// The endpoint is client-supplied and the server POSTs to it, so this is the
// line between a push destination and a way to aim the function at something
// else. It used to accept any http://localhost unconditionally, in production.
delete process.env.CENTS_TEST_LOCALHOST_PUSH;
const loopbackNoOptIn = await call(pushHandler, 'POST', { subscription, time: '20:00', zone: 'UTC' });
check('a loopback endpoint is refused without the harness opt-in', loopbackNoOptIn.status === 400, `got ${loopbackNoOptIn.status}`);
process.env.CENTS_TEST_LOCALHOST_PUSH = '1';
const metadata = await call(pushHandler, 'POST', {
  subscription: { ...subscription, endpoint: 'https://169.254.169.254/latest/meta-data/' }, time: '20:00', zone: 'UTC',
});
check('a metadata address is refused even over https', metadata.status === 400, `got ${metadata.status}`);
const privateNet = await call(pushHandler, 'POST', {
  subscription: { ...subscription, endpoint: 'https://10.1.2.3/hook' }, time: '20:00', zone: 'UTC',
});
check('a private-network address is refused over https', privateNet.status === 400, `got ${privateNet.status}`);
// A trailing dot is the same host, fully qualified — the first thing worth
// trying against a name-based check.
const dotted = await call(pushHandler, 'POST', {
  subscription: { ...subscription, endpoint: 'https://localhost./hook' }, time: '20:00', zone: 'UTC',
});
check('a fully-qualified loopback name is refused', dotted.status === 400, `got ${dotted.status}`);
// The fix must not cost push itself: a real service's host is still accepted,
// and is removed again so the store this suite counts later stays clean.
const publicPush = { ...subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' };
const accepted = await call(pushHandler, 'POST', { subscription: publicPush, time: '20:00', zone: 'UTC' });
check('a real push service endpoint is still accepted', accepted.status === 200, `got ${accepted.status}`);
await call(pushHandler, 'DELETE', { subscription: publicPush });

// ---------- 3. subscribe (stored, normalized time) ----------
const subResp = JSON.parse(await text(await call(pushHandler, 'POST', {
  subscription, time: '25:99', zone: 'Europe/Dublin',
})));
check('subscribe-normalizes-time', subResp.stored === true && subResp.time === '20:00');

// ---------- 4. malformed subscription rejected ----------
const badSub = await call(pushHandler, 'POST', {
  subscription: { endpoint: 'https://x.example', keys: { p256dh: 'short', auth: 'no' } }
});
check('invalid-subscription-rejected', badSub.status === 400);

// ---------- 5. dispatcher delivers when due (clock injected) ----------
// Now in Dublin local time; set the record's time to exactly that so the
// next dispatcher run is due.
const dublinNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const [dh, dm] = dublinNow.split(':').map(Number);
await call(pushHandler, 'POST', {
  subscription, time: `${String(dh).padStart(2, '0')}:${String(dm).padStart(2, '0')}`, zone: 'Europe/Dublin',
});
received.length = 0;
// The dispatcher reads `new Date()` internally; the record's time is 'now',
// so the run is due unless the minute ticks past mid-run — acceptable.
await sendHandler(null, {});
check('scheduled-delivery', received.length === 1 && received[0].title === 'cents. — time to upload your transactions');
check('payload-has-generic-body', received.length === 1 && received[0].body === "Log today's spending while it's fresh.");
check('push-is-high-urgency', !!lastHeaders && lastHeaders.urgency === 'high',
  `urgency=${lastHeaders && lastHeaders.urgency}`);
check('push-ttl-bounds-lateness-at-an-hour', !!lastHeaders && Number(lastHeaders.ttl) <= 3600,
  `ttl=${lastHeaders && lastHeaders.ttl}`);

// ---------- 6. no double-send within the same day ----------
received.length = 0;
await sendHandler(null, {});
check('no-double-send-same-day', received.length === 0);

// ---------- 7. dead subscription (410) pruned ----------
const store = await getStore();
// Time = current UTC HH:MM so the record is due on the next run.
const utcNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
await store.setJSON('push:prune-test', { time: utcNow, zone: 'UTC', lastFiredDate: '1999-01-01', subscription: { endpoint: `http://localhost:${pushPort}/fake-push`, keys: subscription.keys } });
endpointAlive = false;
const sendResp2 = await sendHandler(null, {});
endpointAlive = true;
const pruneKeys = (await store.list('push:')).map(k => k.key);
check('dead-subscription-pruned', !pruneKeys.includes('push:prune-test') && sendResp2 !== null);

// ---------- 7b. a service that says no, told apart from one that is gone ----------
// Two ways a delivery ends that are NOT "the subscription is dead": the service
// answered and refused (a status — a subscription bound to a key the sender no
// longer signs with, most often, which no later run will heal) and the service
// could not be reached (no status — transient, and the next run may deliver it).
// The app has to say which, because a phone that shows nothing is the symptom of
// both: the test push names the status, and the scheduled run's one-line summary
// counts what was refused — `sent=0` on its own was the same line for a push
// service that refused everything and one that had nothing to send.
await store.setJSON('push:refuse-test', {
  time: utcNow, zone: 'UTC', lastFiredDate: '1999-01-01',
  subscription: { endpoint: `http://localhost:${pushPort}/fake-push`, keys: subscription.keys },
});
refuseWith = 503;
const refusedTest = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint });
const refusedBody = await text(refusedTest);
check('a refused test push names the status the push service gave',
  refusedTest.status === 502 && refusedBody.includes('(HTTP 503)'), `${refusedTest.status} ${refusedBody}`);
const runLogs = [];
const realLog = console.log;
const captureRun = async () => {
  runLogs.length = 0;
  console.log = (...args) => { runLogs.push(args.join(' ')); };
  try { await sendHandler(null, {}); } finally { console.log = realLog; }
  return runLogs.join(' | ');
};
const refusedRun = await captureRun();
check('the scheduled run counts a service that refused',
  /sent=0\b/.test(refusedRun) && /rejected=1\b/.test(refusedRun), refusedRun);
// An endpoint with nothing behind it is the other state — the connection is
// refused, so there is no status and nothing to count as refused; the record  // stays due precisely so the next run can try again. A port that was just
// closed is the honest way to reproduce that (destroying the socket on the
// server side is not: the client's fetch then waits for a response that never
// comes rather than failing).
// Out of the store before the next run, or it would be delivered to a service
// that is answering again, and that run would not be a clean 'nothing sent'.
await store.del('push:refuse-test');
refuseWith = null;
const deadPort = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
await store.setJSON('push:unreachable-test', {
  time: utcNow, zone: 'UTC', lastFiredDate: '1999-01-01',
  subscription: { endpoint: `http://localhost:${deadPort}/fake-push`, keys: subscription.keys },
});
const unreachableRun = await captureRun();
check('a service it could not reach is transient, not refused',
  /sent=0\b/.test(unreachableRun) && /rejected=0\b/.test(unreachableRun), unreachableRun);
// Leave the store as section 8 expects to find it.
await store.del('push:unreachable-test');

// ---------- 7c. a device that has only just subscribed ----------
// Pressing Enable push and Send test push in the same breath used to be answered
// by the push service with 404/410 — a registration it has not been told about
// yet — and that verdict is the app's own "this device is dead, drop it" signal.
// So the one flow this feature exists for deleted the stored subscription and
// told the user to re-enable push, for a device that was perfectly healthy.
//
// Measured against real FCM, one first-ever subscription per browser: a push at
// 0.01 s and at 0.51 s after subscribe() came back 404/410; the same push at 1 s,
// and at every longer delay, was accepted. The verdict is therefore decided by
// AGE: a gone on a record younger than the warm-up is asked once more, and
// reported as `warming` — never as `gone`, because callers delete on that key —
// if the service still does not know it. An established record keeps the old
// meaning, so a browser that really did unsubscribe is still pruned.
const { subscriptionWarmingUp, pushSendWarming, PUSH_WARMUP_MS } = await import('../netlify/functions/lib/webpush.mjs');
const vapidForCall = { subject: 'mailto:test@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey };
const warmSubscription = { endpoint: `http://localhost:${pushPort}/fake-push`, keys: subscription.keys };
const nowMs = Date.now();
check('a subscription seconds old is warming up',
  subscriptionWarmingUp(new Date(nowMs - 2000).toISOString(), nowMs) === true);
check('one older than the window is not',
  subscriptionWarmingUp(new Date(nowMs - PUSH_WARMUP_MS - 1000).toISOString(), nowMs) === false);
check('and a stamp that cannot be read is not warming either',
  subscriptionWarmingUp(undefined, nowMs) === false
  && subscriptionWarmingUp('not a date', nowMs) === false
  && subscriptionWarmingUp(new Date(nowMs + 60000).toISOString(), nowMs) === false);

// (a) the retry itself: the service does not know the registration on the first
// ask and does on the second — one record, two attempts, one delivery.
unregistered = 1;
endpointHits = 0;
received.length = 0;
const warmed = await pushSendWarming(warmSubscription, { title: 'cents. — warm-up', body: 'x', tag: 'cents-warmup' },
  vapidForCall, { createdAt: new Date().toISOString(), sleep: async () => {} });
check('a gone on a seconds-old subscription is asked again',
  warmed.ok === true && endpointHits === 2, `${JSON.stringify(warmed)} after ${endpointHits} attempt(s)`);
check('and the second ask delivers exactly one push',
  received.length === 1, `delivered ${received.length}`);

// (b) the same through the endpoint the app actually calls: press Enable push,
// then Send test push, and the test works.
unregistered = 1;
endpointHits = 0;
await call(pushHandler, 'POST', { subscription, time: '20:00', zone: 'UTC' });
received.length = 0;
const warmTest = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint });
check('Send test push straight after Enable push succeeds',
  warmTest.status === 200 && received.length === 1, `${warmTest.status}, delivered ${received.length}`);
check('and the stored subscription is still there after it',
  (await store.list('push:')).length === 1, `${(await store.list('push:')).length} record(s)`);

// (c) a service still cold after the retry: the answer is "in a moment", not
// "re-enable push", and nothing is deleted.
unregistered = Infinity;
received.length = 0;
const coldTest = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint });
const coldBody = await text(coldTest);
check('a subscription the service still does not know is answered 425, not 410',
  coldTest.status === 425 && /still registering/.test(coldBody), `${coldTest.status} ${coldBody}`);
check('and it names how long to wait', coldTest.headers.get('retry-after') === '2', String(coldTest.headers.get('retry-after')));
check('and the record survives it, so a healthy device is not unsubscribed by a test',
  (await store.list('push:')).length === 1, `${(await store.list('push:')).length} record(s)`);
const cold = await pushSendWarming(warmSubscription, { title: 'x', body: 'x', tag: 'cents-warmup' },
  vapidForCall, { createdAt: new Date().toISOString(), sleep: async () => {} });
check('and a warming result carries no `gone` key for a caller to prune on',
  cold.ok === false && cold.warming === true && !('gone' in cold), JSON.stringify(cold));

// (d) the age gate must not make every push immortal: an ESTABLISHED record that
// the service says is gone is still pruned and still answered 410.
const [establishedKey] = (await store.list('push:')).map(k => k.key);
await store.setJSON(establishedKey, {
  ...(await store.getJSON(establishedKey)),
  createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
});
const established = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint });
check('an established subscription is still pruned on 410',
  established.status === 410 && (await store.list('push:')).length === 0, `${established.status}`);
unregistered = 0;

// (e) the scheduled run must not prune one either, and must say what it met —
// `sent=0` on its own is the same line for "nothing was due" and "the device was
// not registered yet".
await call(pushHandler, 'POST', { subscription, time: utcNow, zone: 'UTC' });
unregistered = Infinity;
received.length = 0;
const warmRun = await captureRun();
check('the scheduled run does not prune a warming subscription',
  /warming=1\b/.test(warmRun) && /pruned=0\b/.test(warmRun) && (await store.list('push:')).length === 1, warmRun);
unregistered = 0;
for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k); // section 8 expects an empty store

// The client half of the same rule, pinned from source: reminders.js reads
// localStorage and app.js touches the DOM on evaluation, so neither can be
// imported here. What must hold is the ORDER — 425 is its own reason, and only
// the real 410 may clear the stored subscription — because a test push that
// switches push OFF over a healthy device is the bug this section exists for.
const remindersSrc = readFileSync(new URL('../reminders.js', import.meta.url), 'utf8');
const testPushSrc = remindersSrc.slice(remindersSrc.indexOf('export async function sendTestPush'),
  remindersSrc.indexOf('export async function updateReminderPushTime'));
check('the app reads 425 as "still warming", not as a dead subscription',
  /status === 425\)\s*return \{ ok: false, reason: 'warming' \};/.test(testPushSrc),
  (testPushSrc.match(/status === 425[^;]*;/) || ['no 425 branch in sendTestPush'])[0]);
const warmAt = testPushSrc.indexOf("reason: 'warming'");
const clearAt = testPushSrc.indexOf('patchReminderSettings({ pushSubscribed: false');
check('and takes that verdict before anything clears the stored subscription',
  warmAt > -1 && clearAt > warmAt, `warming at ${warmAt}, clearing at ${clearAt}`);
check('and only the real 410 still clears it',
  testPushSrc.split('patchReminderSettings({ pushSubscribed: false').length - 1 === 1);
check('and the reminder modal has a sentence for that reason',
  /warming: '/.test(readFileSync(new URL('../app.js', import.meta.url), 'utf8')));

// ---------- 8. unsubscribe removes the record ----------
await call(pushHandler, 'POST', {
  subscription, time: '20:00', zone: 'UTC',
});
const delResp = await call(pushHandler, 'DELETE', { subscription });
const keysAfterDel = (await store.list('push:')).map(k => k.key);
check('unsubscribe-removes', delResp.status === 200 && keysAfterDel.length === 0);

// ---------- 9. test push (PUT) sends immediately ----------
await call(pushHandler, 'POST', {
  subscription, time: '20:00', zone: 'UTC',
});
received.length = 0;
const testResp = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint });
check('test-push-sent', testResp.status === 200 && received.length === 1 && received[0].title === 'cents. — test reminder');

// ---------- 10. test push rejects a wrong password ----------
const foreign = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint }, { 'X-Cents-Password': 'wrong-password' });
check('test-push-auth-rejected', foreign.status === 401);

// ---------- 11. two profiles, one device ----------
// One browser has ONE push subscription shared by every profile, so the two
// profiles' schedules are stored as separate records against that endpoint.
// Each profile keeps its own reminder and its own credential, and neither can
// reach or silence the other's.
await call(pushHandler, 'POST', {
  subscription, time: '20:00', zone: 'UTC',
}, { 'X-Cents-Password': 'test-password-123' });
const samSubscribe = await call(pushHandler, 'POST', {
  subscription, profileName: 'Sam', time: '07:30', zone: 'Europe/Dublin',
}, { 'X-Cents-Password': 'sam-password-123', 'X-Cents-Profile': 'sam' });
check('a second profile stores its own record', samSubscribe.status === 200);
const bothKeys = (await store.list('push:')).map(k => k.key);
check('records are keyed per profile, not per device',
  bothKeys.some(k => k.endsWith(':personal')) && bothKeys.some(k => k.endsWith(':sam')), bothKeys.join(', '));

received.length = 0;
const samTest = await call(pushHandler, 'PUT', { endpoint: subscription.endpoint },
  { 'X-Cents-Password': 'sam-password-123', 'X-Cents-Profile': 'sam' });
check('a profile can test its own subscription', samTest.status === 200 && received.length === 1);
check('the test push names that profile', received[0]?.body === 'Push works for Sam.', received[0]?.body);

received.length = 0;
await call(pushHandler, 'PUT', { endpoint: subscription.endpoint }, { 'X-Cents-Password': 'test-password-123' });
check('the default profile tests its own record', received[0]?.body === 'Push is working.', received[0]?.body);

// The dispatcher delivers whatever each record carries, so a profile with
// push off simply has no record — it does not follow another profile's time.
const nowUtc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
await call(pushHandler, 'POST', { subscription, time: nowUtc, zone: 'UTC' }, { 'X-Cents-Password': 'test-password-123' });
await call(pushHandler, 'POST', { subscription, profileName: 'Sam', time: nowUtc, zone: 'UTC' },
  { 'X-Cents-Password': 'sam-password-123', 'X-Cents-Profile': 'sam' });
received.length = 0;
await sendHandler(null, {});
check('both profiles are delivered, one push each', received.length === 2, `delivered ${received.length}`);
check('each push names the right profile',
  received.some(r => r.body === "Log today's spending while it's fresh.")
  && received.some(r => r.body === 'Quick tally for Sam — it takes a minute.'),
  JSON.stringify(received.map(r => r.body)));

const samDelete = await call(pushHandler, 'DELETE', { subscription },
  { 'X-Cents-Password': 'sam-password-123', 'X-Cents-Profile': 'sam' });
const afterSamDelete = (await store.list('push:')).map(k => k.key);
check('unsubscribing one profile removes only its record',
  samDelete.status === 200 && !afterSamDelete.some(k => k.endsWith(':sam')) && afterSamDelete.some(k => k.endsWith(':personal')),
  afterSamDelete.join(', '));
check('a profile id cannot be used with another profile\u2019s password',
  (await call(pushHandler, 'DELETE', { subscription }, { 'X-Cents-Password': 'test-password-123', 'X-Cents-Profile': 'sam' })).status === 401);
const noEnvProfile = await call(pushHandler, 'POST', { subscription, time: '20:00', zone: 'UTC' },
  { 'X-Cents-Password': 'guessing-a-password', 'X-Cents-Profile': 'kate' });
check('a profile with no env var cannot subscribe', noEnvProfile.status === 500, `got ${noEnvProfile.status}`);
check('and it is not silently served by the default password',
  (await call(pushHandler, 'POST', { subscription, time: '20:00', zone: 'UTC' }, { 'X-Cents-Password': 'test-password-123', 'X-Cents-Profile': 'kate' })).status === 500);

// ---------- 12. the dispatcher reads the record's own clock ----------
// A record carries an IANA zone + HH:MM and is due when THAT zone's local time
// falls inside the sender's look-back window. A zone far ahead of UTC is what tells the two
// apart: a dispatcher comparing UTC wall time fires at the wrong moment, and —
// because "today" in that zone is already tomorrow — a once-a-day marker kept in
// UTC would let it fire again around that zone's midnight.
const AHEAD = 'Pacific/Kiritimati'; // UTC+14, the largest offset in use
const hhmm = (zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const ymd = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
// Store the records directly (like check 7) so an old marker can never be the
// reason nothing fired: each one starts a day behind on purpose.
const tzRecord = (time, zone) => ({
  time, zone, lastFiredDate: '1999-01-01',
  subscription: { endpoint: `http://localhost:${pushPort}/fake-push`, keys: subscription.keys },
});
for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k);

await store.setJSON('push:tz-ahead', tzRecord(hhmm(AHEAD), AHEAD));
received.length = 0;
await sendHandler(null, {});
check('a zone ahead of UTC is due at its own local time',
  received.length === 1, `delivered ${received.length} at ${AHEAD} local ${hhmm(AHEAD)}`);
check('its once-a-day marker is that zone\u2019s date, not UTC\u2019s',
  (await store.getJSON('push:tz-ahead'))?.lastFiredDate === ymd(AHEAD),
  `${(await store.getJSON('push:tz-ahead'))?.lastFiredDate} vs UTC ${ymd('UTC')}`);
received.length = 0;
await sendHandler(null, {});
check('and the same local day is not delivered twice', received.length === 0, `delivered ${received.length}`);

// The same wall clock read as UTC is not this zone's local time, so a record
// holding it is not due. Zones fourteen hours apart never share a slot, which
// is what makes this deterministic rather than lucky.
await store.setJSON('push:tz-utc-clock', tzRecord(hhmm('UTC'), AHEAD));
received.length = 0;
await sendHandler(null, {});
check('a UTC-clock time stored in that zone is not due', received.length === 0, `delivered ${received.length}`);

// Nor is an hour past the zone's own local time — the inverse direction.
const [aheadHour, aheadMinute] = hhmm(AHEAD).split(':').map(Number);
await store.setJSON('push:tz-off-by-an-hour', tzRecord(
  `${String((aheadHour + 1) % 24).padStart(2, '0')}:${String(aheadMinute).padStart(2, '0')}`, AHEAD));
received.length = 0;
await sendHandler(null, {});
check('an hour off the zone\u2019s local time is not due', received.length === 0, `delivered ${received.length}`);

// ---------- 13. the browser's key and the sender's key are the same key ----------
// A browser binds its subscription to the applicationServerKey it subscribed
// with, and a push service rejects a JWT signed by any other key. Two resolves
// of the same configuration must therefore agree — and now that the pair can be
// derived, the property to pin is that the derivation is deterministic, which
// this asserts through the live endpoint and the live dispatcher instead of
// against vapidConfig() alone.
const swapBack = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
process.env.GITHUB_TOKEN = 'a-deploy-secret-long-enough-to-derive-from';
const derivedKeyResp = await call(pushHandler, 'GET');
const derivedKey = (JSON.parse(await text(derivedKeyResp))).publicKey;
for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k);
await call(pushHandler, 'POST', { subscription, time: hhmm('UTC'), zone: 'UTC' });
received.length = 0;
lastAuth = null;
await sendHandler(null, {});
check('with no configured pair the endpoint serves a derived one',
  derivedKeyResp.status === 200 && derivedKey !== keys.publicKey);
check('and the dispatcher signs with exactly that key',
  received.length === 1 && String(lastAuth).includes(`k=${derivedKey}`),
  `${received.length} delivered; header ${String(lastAuth).slice(0, 60)}`);
[process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = swapBack;
delete process.env.GITHUB_TOKEN;

// ---------- 14. the local scheduler fires at its hour, not on open ----------
// The scheduler runs tick() the moment the app starts, so a day whose reminder
// time had already passed raised a SYSTEM banner the instant the site was
// opened. That is how a "daily reminder" ends up only ever being seen on open
// and never at 20:00 — and the first fix for it (suppress the banner whenever
// the page was in front) was on the wrong axis: it silenced the ONE case where
// a reminder is actually due, with the app open and waiting at the hour. The
// axis is time. Every tick the app has been alive across raises the banner
// whether or not you are looking at it; the start-up tick is a catch-up on a
// moment already gone, and it marks the day off with the in-app toast alone.
{
  const made = [];
  class FakeNotification {
    constructor(title, opts) { this.title = title; this.opts = opts; made.push(this); }
    close() {}
  }
  FakeNotification.permission = 'granted';
  const saved = {
    setInterval: globalThis.setInterval,
    hadNotification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification'),
    Notification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification') ? globalThis.Notification : undefined,
    hadDocument: Object.prototype.hasOwnProperty.call(globalThis, 'document'),
    document: Object.prototype.hasOwnProperty.call(globalThis, 'document') ? globalThis.document : undefined,
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    window: Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined,
    hadLocalStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
    localStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined,
  };
  const reminderStore = new Map();
  const localStore = {
    getItem: (k) => (reminderStore.has(k) ? reminderStore.get(k) : null),
    setItem: (k, v) => reminderStore.set(k, String(v)),
    removeItem: (k) => reminderStore.delete(k),
  };
  // No real timer: the scheduler's minute loop would otherwise hold the process
  // open, and the tick it takes at start is synchronous either way.
  globalThis.setInterval = () => ({});
  globalThis.localStorage = localStore;
  globalThis.Notification = FakeNotification;
  // `'Notification' in window` is what notificationsSupported() reads.
  globalThis.window = globalThis;
  const visListeners = [];
  globalThis.document = {
    visibilityState: 'visible', // the state the site is in when it is OPENED
    addEventListener: (type, fn) => { if (type === 'visibilitychange') visListeners.push(fn); },
    dispatchEvent: () => { for (const fn of visListeners) fn(); return true; },
  };
  try {
    const local = await import('../reminders.js');
    const d = new Date();
    const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    local.patchReminderSettings({ enabled: true, time: '00:00', lastFiredDate: null });
    const seen = [];
    local.onReminderFired((payload) => seen.push(payload));
    local.startReminderScheduler();
    check('the start-up tick raises NO banner — that is the moment the site was opened',
      made.length === 0, `banners=${made.length}`);
    check('but it still marks the day done and nudges in-app',
      local.getReminderSettings().lastFiredDate === todayKey && seen.length === 1,
      `marker=${local.getReminderSettings().lastFiredDate} toasts=${seen.length}`);
    // A tick the app has been alive across: the return to a backgrounded tab,
    // which is the same path the minute loop takes (both pass catchUp=false).
    local.patchReminderSettings({ lastFiredDate: null });
    globalThis.document.dispatchEvent();
    check('a reminder at its hour raises the system banner EVEN with the page in front',
      made.length === 1, `banners=${made.length}`);
    check('and still reaches the in-app toast', seen.length === 2, `toasts=${seen.length}`);
    local.showReminderNotification('Parth');
    check('Test now — a plain call — raises the banner',
      made.length === 2 && made[1].opts.body.includes('Parth'), `banners=${made.length}`);
    FakeNotification.permission = 'default';
    local.showReminderNotification(null);
    check('without permission nothing shows', made.length === 2, `banners=${made.length}`);
    const remindersSource = readFileSync(new URL('../reminders.js', import.meta.url), 'utf8');
    check('there is exactly one place a banner is constructed',
      (remindersSource.match(/new Notification\(/g) || []).length === 1);
    check('and the scheduler reaches it only through that one function',
      /function fire\([\s\S]{0,400}?showReminderNotification\(/.test(remindersSource)
      && !/function fire\([\s\S]{0,400}?new Notification\(/.test(remindersSource));
    check('the start-up tick is the catch-up and the minute loop is not',
      /tick\(true\);\s*\n\s*timer = setInterval\(\(\) => tick\(false\)/.test(remindersSource));
  } finally {
    if (saved.hadNotification) globalThis.Notification = saved.Notification;
    else delete globalThis.Notification;
    if (saved.hadDocument) globalThis.document = saved.document;
    else delete globalThis.document;
    if (saved.hadWindow) globalThis.window = saved.window;
    else delete globalThis.window;
    if (saved.hadLocalStorage) globalThis.localStorage = saved.localStorage;
    else delete globalThis.localStorage;
    globalThis.setInterval = saved.setInterval;
  }
}

// ---------- 15. closed-app push is gated on capability, never on the device ----------
// pushSupported() asked whether the user agent looked like a phone for the
// whole life of the feature, on the reasoning that on desktop the app lives in
// a tab on a machine that is on and the in-app scheduler is the right surface.
// Section 14 is why that reasoning fails: at 20:00 the tab is not open, so the
// only thing that ever fired was the scheduler's start-up catch-up — a
// reminder seen on open and never at its hour. A browser with nothing running
// has no local scheduler at all, and Web Push is the only path that reaches
// it, so this gate is the whole of the difference between a reminder that
// arrives and one that does not.
{
  const saved = {
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    window: Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined,
    // `navigator` is a getter-only global in Node, so it has to be redefined
    // rather than assigned — and restored by its own original descriptor.
    navDesc: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    hadNotification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification'),
    Notification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification') ? globalThis.Notification : undefined,
    hadLocalStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
    localStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined,
  };
  const phoneUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const emptyStore = new Map();
  globalThis.localStorage = {
    getItem: (k) => (emptyStore.has(k) ? emptyStore.get(k) : null),
    setItem: (k, v) => emptyStore.set(k, String(v)),
    removeItem: (k) => emptyStore.delete(k),
  };
  const withBrowser = (ua, { serviceWorker = true, pushManager = true } = {}) => {
    const nav = { userAgent: ua };
    if (serviceWorker) nav.serviceWorker = {};
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true, enumerable: true });
    globalThis.window = globalThis;
    if (pushManager) globalThis.window.PushManager = class {};
    else delete globalThis.window.PushManager;
    globalThis.Notification = class {};
  };
  try {
    const reminders = await import('../reminders.js');
    withBrowser(desktopUA);
    const desktop = reminders.pushSupported();
    withBrowser(phoneUA);
    const phone = reminders.pushSupported();
    check('closed-app push is offered on a desktop browser', desktop === true, `desktop=${desktop}`);
    check('and still on a phone', phone === true, `phone=${phone}`);
    withBrowser(desktopUA, { serviceWorker: false });
    check('a browser with no service worker is not a push browser',
      reminders.pushSupported() === false);
    withBrowser(desktopUA, { pushManager: false });
    check('nor one with no PushManager', reminders.pushSupported() === false);
    // The gate is passed by a desktop browser: what stops it next is sync,
    // which is a configuration the user has or has not done — never the device.
    withBrowser(desktopUA);
    const gated = await reminders.subscribeReminderPush();
    check('a desktop subscription gets past the gate and stops on sync instead',
      gated.ok === false && gated.reason === 'no-sync', JSON.stringify(gated));
    const remindersSource = readFileSync(new URL('../reminders.js', import.meta.url), 'utf8');
    const supportedSrc = (remindersSource.match(/export function pushSupported\(\)[\s\S]{0,400}?\n\}/) || [''])[0];
    check('pushSupported asks only about capabilities',
      /'serviceWorker' in navigator/.test(supportedSrc)
      && /'PushManager' in window/.test(supportedSrc)
      && /'Notification' in window/.test(supportedSrc));
    check('and nothing in the module reads the user agent at all',
      !/userAgent|mobileWebApp|Android\|iPhone/i.test(remindersSource));
  } finally {
    if (saved.hadWindow) globalThis.window = saved.window;
    else delete globalThis.window;
    if (saved.navDesc) Object.defineProperty(globalThis, 'navigator', saved.navDesc);
    else delete globalThis.navigator;
    if (saved.hadNotification) globalThis.Notification = saved.Notification;
    else delete globalThis.Notification;
    if (saved.hadLocalStorage) globalThis.localStorage = saved.localStorage;
    else delete globalThis.localStorage;
  }
}

// ---------- 16. the reminder survives a storage that will not keep it ----------
// Both failure modes are silent and continuous. `lastFiredDate` is written from
// inside a try/catch, so a full quota means the next tick reads "not fired yet"
// and fires again — a system banner plus an in-app toast every 60 seconds for
// the rest of the day, from a reminder set once. And a blocked or corrupt read
// answers normalize(null), i.e. `enabled: false`, so the armed reminder simply
// stops existing for the session. The session copy is the truth; storage is
// write-through, and the cache is keyed by the profile key so a profile switch
// still changes whose schedule is running.
{
  const reminderStore = new Map();
  let blockWrites = false;
  let blockReads = false;
  const localStore = {
    getItem(k) { if (blockReads) throw new Error('storage blocked'); return reminderStore.has(k) ? reminderStore.get(k) : null; },
    setItem(k, v) { if (blockWrites) throw new Error('quota exceeded'); reminderStore.set(k, String(v)); },
    removeItem(k) { reminderStore.delete(k); },
  };
  const saved = {
    hadLocalStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
    localStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined,
    hadNotification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification'),
    Notification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification') ? globalThis.Notification : undefined,
    hadDocument: Object.prototype.hasOwnProperty.call(globalThis, 'document'),
    document: Object.prototype.hasOwnProperty.call(globalThis, 'document') ? globalThis.document : undefined,
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    window: Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined,
    setInterval: globalThis.setInterval,
  };
  globalThis.localStorage = localStore;
  globalThis.window = globalThis;
  const visListeners = [];
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { if (type === 'visibilitychange') visListeners.push(fn); },
    dispatchEvent: () => { for (const fn of visListeners) fn(); return true; },
  };
  let minuteTick = null;
  globalThis.setInterval = (fn) => { minuteTick = fn; return {}; };
  const banners = [];
  class FakeNotification {
    constructor(title, opts) { this.title = title; this.opts = opts; banners.push(this); }
    close() {}
  }
  FakeNotification.permission = 'granted';
  globalThis.Notification = FakeNotification;
  /** Run one scenario against its own module instance — `startReminderScheduler`
   *  is a no-op the second time, and each instance needs its own `timer`. */
  const scenario = async (query, mode) => {
    reminderStore.clear();
    blockReads = false;
    blockWrites = false;
    const seen = [];
    const edge = await import(`../reminders.js?${query}`);
    edge.onReminderFired((p) => seen.push(p));
    // Armed while storage is still healthy, so what follows is a storage
    // failure and not a mistyped setting.
    edge.patchReminderSettings({ enabled: true, time: '00:00', lastFiredDate: null });
    banners.length = 0;
    if (mode === 'read') {
      blockReads = true;
      check('an unreadable store does not report the armed reminder as off',
        edge.getReminderSettings().enabled === true && edge.getReminderSettings().time === '00:00',
        JSON.stringify(edge.getReminderSettings()));
    } else {
      blockWrites = true; // the quota is now full
    }
    edge.startReminderScheduler(); // the start-up tick: a catch-up
    const afterStart = seen.length;
    minuteTick();
    minuteTick();
    if (mode === 'write') edge.patchReminderSettings({ lastFiredDate: null }); // re-arm, still blocked
    if (mode === 'read') minuteTick();
    return { seen: seen.length, afterStart, banners: banners.length, edge };
  };
  try {
    const readBlocked = await scenario('edge=read', 'read');
    check('with the store unreadable the reminder still fires once',
      readBlocked.afterStart === 1 && readBlocked.seen >= 1,
      `start=${readBlocked.afterStart} total=${readBlocked.seen}`);
    check('and a blocked read raises no banner of its own on the start-up tick',
      readBlocked.banners === 0, `banners=${readBlocked.banners}`);
    const writeBlocked = await scenario('edge=write', 'write');
    check('with the marker unwritable the start-up tick still nudges once, with no banner',
      writeBlocked.afterStart === 1 && writeBlocked.banners === 0,
      `start=${writeBlocked.afterStart} banners=${writeBlocked.banners}`);
    check('and a refused marker write does NOT become a banner every minute',
      writeBlocked.seen === 1, `toasts=${writeBlocked.seen}`);
    const edgeSource = readFileSync(new URL('../reminders.js', import.meta.url), 'utf8');
    check('the session copy is keyed by the profile key, so a switch re-reads',
      /if \(cacheKey !== key\)/.test(edgeSource) && /const key = KEY\(\);/.test(edgeSource));
    check('and a refused write keeps the change in memory rather than dropping it',
      /function writeSettings\(next\)[\s\S]{0,300}?cached = next;/.test(edgeSource), true);
    // Both delivery paths are one reminder: the scheduled push and the local
    // scheduler carry the same tag, so a subscribed device shows one — without
    // it, a phone with push on gets a second notification from a different
    // process right after the first.
    // The tag lives in the shared run now (the scheduled function and the HTTP
    // trigger are one job); the pin follows it there.
    const senderSource = readFileSync(new URL('../netlify/functions/lib/reminder-run.mjs', import.meta.url), 'utf8');
    const localTag = (edgeSource.match(/tag: '([a-z-]+)'/) || [])[1];
    const pushTag = (senderSource.match(/tag: '([a-z-]+)'/) || [])[1];
    check('the local banner and the scheduled push are tagged as one notification',
      !!localTag && localTag === pushTag, `local=${localTag} push=${pushTag}`);
  } finally {
    if (saved.hadLocalStorage) globalThis.localStorage = saved.localStorage;
    else delete globalThis.localStorage;
    if (saved.hadNotification) globalThis.Notification = saved.Notification;
    else delete globalThis.Notification;
    if (saved.hadDocument) globalThis.document = saved.document;
    else delete globalThis.document;
    if (saved.hadWindow) globalThis.window = saved.window;
    else delete globalThis.window;
    globalThis.setInterval = saved.setInterval;
  }
}

// ---------- 17. the zone a travelling device announces ----------
// The scheduled sender aims at the zone it was TOLD, and it is only told on
// subscribe or on a time change — so a phone that crossed a border kept
// pushing at the old zone's hour while the local scheduler above used the new
// one: two halves of one reminder, hours apart, with nothing on screen saying
// which was right. The fix re-announces on start when the recorded zone
// disagrees with this device's own, and every gate around it exists to stop
// the fix being worse than the bug: never without granted permission
// (starting the app must never be what asks for the prompt — not even a key
// fetch), never for a device that is not subscribed, never when the zones
// already agree (that is EVERY ordinary boot, and it must not POST), and
// never as a swallowed verdict — a refused announce must leave the old
// record in place so the next start sees the same disagreement and retries.
// Each scenario gets a fresh module instance: `timer` and the session cache
// are module state, so a second start on one instance is a no-op.
{
  const reminderStore = new Map();
  const localStore = {
    getItem: (k) => (reminderStore.has(k) ? reminderStore.get(k) : null),
    setItem: (k, v) => reminderStore.set(k, String(v)),
    removeItem: (k) => reminderStore.delete(k),
  };
  const saved = {
    hadLocalStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
    localStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined,
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    window: Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined,
    navDesc: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    hadNotification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification'),
    Notification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification') ? globalThis.Notification : undefined,
    hadPushManager: Object.prototype.hasOwnProperty.call(globalThis, 'PushManager'),
    PushManager: Object.prototype.hasOwnProperty.call(globalThis, 'PushManager') ? globalThis.PushManager : undefined,
    hadFetch: Object.prototype.hasOwnProperty.call(globalThis, 'fetch'),
    fetch: Object.prototype.hasOwnProperty.call(globalThis, 'fetch') ? globalThis.fetch : undefined,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
  };
  // pushFetch races every request against a 12s timer it never clears, and
  // this section makes several — twelve ref'd seconds at exit is suite
  // slowness nobody can attribute. Unref only: the race is untouched, and the
  // flushes below use the ORIGINAL timer so they always fire.
  const realSetTimeout = saved.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => {
    const t = realSetTimeout(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
  globalThis.localStorage = localStore;
  globalThis.window = globalThis;
  class FakeNotification {
    constructor(title, opts) { this.title = title; this.opts = opts; }
    close() {}
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = async () => FakeNotification.permission;
  globalThis.Notification = FakeNotification;
  globalThis.PushManager = class {};
  // A subscription the browser still holds, bound to the key the server signs
  // with. The SAME boots this section measures also run the start-up push check
  // (section 18 — "what `pushSubscribed` cannot say"), and a device that check
  // can CONFIRM writes nothing, so the announce counts below stay the announce's
  // own. Returning null here would make every one of these starts look like a
  // device whose subscription the browser had dropped, and the repair POST that
  // follows would be counted as zone traffic.
  const pointBytes = (b64) => {
    const buf = Buffer.from(String(b64), 'base64url');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };
  const heldSub = {
    endpoint: 'http://push-ep/local',
    options: { userVisibleOnly: true, applicationServerKey: pointBytes(keys.publicKey) },
    toJSON: () => ({ endpoint: 'http://push-ep/local', keys: { p256dh: 'x', auth: 'y' } }),
    unsubscribe: async () => true,
  };
  const fakeReg = {
    pushManager: {
      getSubscription: async () => heldSub,
      subscribe: async () => ({
        endpoint: 'http://push-ep/local',
        toJSON: () => ({ endpoint: 'http://push-ep/local', keys: { p256dh: 'x', auth: 'y' } }),
      }),
    },
  };
  // `navigator` is a getter-only global in Node, so it is redefined rather
  // than assigned — and restored by its own original descriptor.
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { ready: Promise.resolve(fakeReg), getRegistration: async () => null } },
    configurable: true, writable: true, enumerable: true,
  });
  let fetchLog = []; // { method, url, body } per call, in order
  let postOk = true;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    if (method === 'GET') {
      fetchLog.push({ method, url: String(url) });
      return { ok: true, status: 200, json: async () => ({ publicKey: keys.publicKey }) };
    }
    let body = null;
    try { body = JSON.parse(init.body || 'null'); } catch { body = null; }
    fetchLog.push({ method, url: String(url), body });
    return { ok: postOk, status: postOk ? 200 : 500, json: async () => ({}) };
  };
  globalThis.setInterval = () => ({}); // the minute loop must not hold the process open

  const { nsKey } = await import('../profiles.js');
  const REMINDER_KEY = nsKey('reminder');
  const SYNC_KEY = nsKey('sync');
  // The zone THIS machine is in, computed the way the module computes it and
  // asserted against the module's answer — never hardcoded: the suite runs in
  // whatever zone its machine happens to be in.
  const expectedZone = (() => {
    try {
      return (typeof Intl !== 'undefined' && Intl.DateTimeFormat
        && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    } catch { return 'UTC'; }
  })();
  const seedStore = (reminder = {}) => {
    reminderStore.clear();
    reminderStore.set(REMINDER_KEY, JSON.stringify({ enabled: false, ...reminder }));
    reminderStore.set(SYNC_KEY, JSON.stringify({
      enabled: true, endpoint: 'http://localhost:8161/api/sync', password: 'pw-for-zone-tests',
    }));
    fetchLog = [];
    postOk = true;
    FakeNotification.permission = 'granted';
  };
  const storedZone = () => {
    try {
      const raw = reminderStore.get(REMINDER_KEY);
      const zone = (raw ? JSON.parse(raw) : {}).pushZone;
      return zone === undefined ? null : zone;
    } catch { return '<unreadable>'; }
  };
  const logOf = (m) => fetchLog.filter((f) => f.method === m).length;
  const seq = () => fetchLog.map((f) => f.method).join(',');
  let tzN = 0;
  const freshInstance = async () => { tzN += 1; return import(`../reminders.js?edge=tz${tzN}`); };
  const flush = () => new Promise((r) => realSetTimeout(r, 25));
  try {
    // (a) The subscribe is where the zone is first told to the sender — and
    // where it is remembered, which is what every later start compares to.
    seedStore();
    const first = await freshInstance();
    const sub = await first.subscribeReminderPush();
    check('a subscribe remembers the zone it announced',
      sub.ok === true && storedZone() === expectedZone,
      `ok=${sub.ok} stored=${storedZone()} expected=${expectedZone}`);
    const firstPost = fetchLog.find((f) => f.method === 'POST');
    check('and the zone travels in the announce body, to the push endpoint',
      !!firstPost && firstPost.body?.zone === expectedZone
        && /reminders-push$/.test(firstPost.url),
      JSON.stringify({ zone: firstPost && firstPost.body && firstPost.body.zone, url: firstPost && firstPost.url }));

    // (b) A device that travelled: the record says one zone, this device is in
    // another — the start-up re-announce is the whole fix.
    seedStore({ pushSubscribed: true, pushEndpoint: 'http://push-ep/local', pushZone: 'Old/Zone' });
    const travelled = await freshInstance();
    travelled.startReminderScheduler();
    await flush();
    check('a start after travelling re-announces the new zone',
      storedZone() === expectedZone && logOf('POST') === 1,
      `stored=${storedZone()} log=${seq()}`);
    // The subscribe and the verify share this boot, so the ORDER is asserted on
    // the announce alone (exactly one POST, after a key fetch) — the sequence
    // that matters is what section (a) pins byte for byte, where the boot makes
    // no other request.
    check('in the order the sender needs: key first, then the record',
      logOf('POST') === 1
        && fetchLog.findIndex((f) => f.method === 'GET') < fetchLog.findIndex((f) => f.method === 'POST'),
      seq());

    // (c) The gates. Permission first: starting the app must never be what
    // asks for the prompt, so a non-granted start does not even fetch the key.
    seedStore({ pushSubscribed: true, pushEndpoint: 'http://push-ep/local', pushZone: 'Old/Zone' });
    FakeNotification.permission = 'default';
    const unprompted = await freshInstance();
    unprompted.startReminderScheduler();
    await flush();
    check('without granted permission the start announces nothing at all',
      fetchLog.length === 0 && storedZone() === 'Old/Zone',
      `log=${seq()} stored=${storedZone()}`);

    // A device that never subscribed has nothing to re-tell either.
    seedStore({ pushSubscribed: false, pushZone: null });
    const bare = await freshInstance();
    bare.startReminderScheduler();
    await flush();
    check('and a device that never subscribed announces nothing',
      fetchLog.length === 0, seq());

    // (d) Idempotence: a boot whose recorded zone already agrees must be
    // silent — this is every ordinary start of the app, and it must not POST.
    seedStore({ pushSubscribed: true, pushEndpoint: 'http://push-ep/local', pushZone: expectedZone });
    const settled = await freshInstance();
    settled.startReminderScheduler();
    await flush();
    check('a start whose zone already agrees does not announce again',
      logOf('POST') === 0 && storedZone() === expectedZone,
      `log=${seq()} stored=${storedZone()}`);

    // (e) Backfill: subscriptions made before zones were recorded have none —
    // null !== zone, so the same start re-tells the sender.
    seedStore({ pushSubscribed: true, pushEndpoint: 'http://push-ep/local' });
    const legacy = await freshInstance();
    legacy.startReminderScheduler();
    await flush();
    check('an old subscription with no recorded zone is backfilled on start',
      storedZone() === expectedZone && logOf('POST') === 1,
      `stored=${storedZone()} log=${seq()}`);

    // (f) Failure is not a verdict: a refused announce leaves the OLD record
    // in place, so the next open of the app sees the same disagreement and
    // tries again — two POSTs across two starts, one landing.
    seedStore({ pushSubscribed: true, pushEndpoint: 'http://push-ep/local', pushZone: 'Old/Zone' });
    postOk = false;
    const refused = await freshInstance();
    refused.startReminderScheduler();
    await flush();
    const zoneAfterRefusal = storedZone();
    postOk = true;
    const retry = await freshInstance();
    retry.startReminderScheduler();
    await flush();
    check('a refused announce leaves the record for the next start to retry',
      zoneAfterRefusal === 'Old/Zone' && storedZone() === expectedZone && logOf('POST') === 2,
      `after=${zoneAfterRefusal} now=${storedZone()} posts=${logOf('POST')}`);

    // The source pins: the gates and the single zone-read are the half no
    // behavioral run can see — a second Intl read still answers correctly on
    // THIS machine, and dropping the subscription gate still skips for an
    // unsubscribed device (updateReminderPushTime has one of its own).
    const tzSource = readFileSync(new URL('../reminders.js', import.meta.url), 'utf8');
    check('the device zone is read in exactly one place in the module',
      (tzSource.match(/resolvedOptions\(\)/g) || []).length === 1,
      String((tzSource.match(/resolvedOptions\(\)/g) || []).length));
    check('the announce body carries that one read',
      /zone:\s*currentZone\(\)/.test(tzSource));
    check('the start gate is subscription AND disagreement AND permission',
      /s\.pushSubscribed && notificationPermission\(\) === 'granted'[\s\S]{0,400}?s\.pushZone !== currentZone\(\)/.test(tzSource)
        && /notificationPermission\(\) === 'granted'/.test(tzSource));
    check('and the announce is best effort: a failure can never break the start',
      /updateReminderPushTime\(\)\.catch\(\(\) => \{\}\)/.test(tzSource));
    check('an unreadable zone falls back to UTC rather than to nothing',
      /function currentZone\(\)[\s\S]{0,240}?\|\| 'UTC'/.test(tzSource)
        && /catch \{ return 'UTC'; \}/.test(tzSource));
  } finally {
    if (saved.hadLocalStorage) globalThis.localStorage = saved.localStorage;
    else delete globalThis.localStorage;
    if (saved.hadWindow) globalThis.window = saved.window;
    else delete globalThis.window;
    if (saved.navDesc) Object.defineProperty(globalThis, 'navigator', saved.navDesc);
    else delete globalThis.navigator;
    if (saved.hadNotification) globalThis.Notification = saved.Notification;
    else delete globalThis.Notification;
    if (saved.hadPushManager) globalThis.PushManager = saved.PushManager;
    else delete globalThis.PushManager;
    if (saved.hadFetch) globalThis.fetch = saved.fetch;
    else delete globalThis.fetch;
    globalThis.setInterval = saved.setInterval;
    globalThis.setTimeout = saved.setTimeout;
  }
}

// ---------- 18. the background wake: closed-app delivery without sync ----------
// Three paths raise the daily reminder — the page's scheduler (app open), the
// scheduled push (server, needs the sync password) and this wake — and the
// phone this section is about has set up NEITHER: no sync, no password, app
// closed. The wake is the browser running the worker's `periodicsync` event in
// the background for an INSTALLED app, so everything that can go wrong with it
// is checked here against the REAL worker: it must honour the schedule (a wake
// is not a reminder — the browser picks the moment, so firing on any wake
// would put the nudge at whatever hour the phone felt like), it must know when
// today already happened (the paths cannot see each other's localStorage, so
// they meet in one Cache Storage record), and the page must never claim
// delivery the register did not actually accept — the modal's row promises a
// notification on the strength of that verdict alone.
{
  // ---- the real worker, run against fakes ----
  // sw.js cannot be imported (a classic worker script has top-level `self` and
  // no exports), so its source is evaluated once per scenario in a function
  // scope with `self`, `caches` and `Date` injected: handlers land in a map,
  // the record in a Map of Maps, and the clock is a fixed local Saturday
  // 2026-10-03 20:30 — deterministic in every timezone the suite runs in,
  // because every date the worker computes is built from THOSE local parts.
  const fixedNow = new Date(2026, 9, 3, 20, 30, 0, 0);
  const TODAY = '2026-10-03';
  const YESTERDAY = '2026-10-02';

  const bootWorker = () => {
    const events = {};
    const shown = [];
    const records = new Map();
    const deleted = [];
    const fakeSelf = {
      addEventListener: (type, fn) => { events[type] = fn; },
      location: { origin: 'https://cents-app.netlify.app' },
      skipWaiting: () => {},
      registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } },
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
    };
    const fakeCaches = {
      open: async (name) => ({
        match: async (key) => {
          const bucket = records.get(name);
          const text = bucket ? bucket.get(key) : undefined;
          return text === undefined ? undefined : new Response(text);
        },
        put: async (key, value) => {
          if (!records.has(name)) records.set(name, new Map());
          records.get(name).set(key, await value.text());
        },
        add: async () => {},
      }),
      keys: async () => [...records.keys()],
      delete: async (name) => { deleted.push(name); return records.delete(name); },
      match: async () => undefined,
    };
    class FakeDate extends Date {
      constructor(...args) {
        if (args.length === 0) super(fixedNow.getTime());
        else super(...args);
      }
      static now() { return fixedNow.getTime(); }
    }
    // `Date` shadows the global inside the worker's scope; everything else the
    // script touches (Response, Request, URL, JSON) is the real one.
    new Function('self', 'caches', 'Date', swSource)(fakeSelf, fakeCaches, FakeDate);
    return { events, shown, records, deleted };
  };
  const seedRecord = (env, record) => {
    if (record !== undefined) env.records.set('cents-reminder', new Map([['/__cents-reminder', JSON.stringify(record)]]));
  };
  const readRecord = (env) => {
    const bucket = env.records.get('cents-reminder');
    const text = bucket ? bucket.get('/__cents-reminder') : undefined;
    return text === undefined ? null : JSON.parse(text);
  };
  const dispatchWake = (env, tag = 'cents-daily-reminder') => {
    let waited = null;
    env.events.periodicsync({ tag, waitUntil: (p) => { waited = p; } });
    return waited; // null for a tag the handler declines — awaiting it is a no-op
  };
  const dispatchPush = (env, payload) => {
    let waited = null;
    env.events.push({ data: { json: () => payload }, waitUntil: (p) => { waited = p; } });
    return waited;
  };

  // A1: due + enabled + not yet fired → the banner, in the words every other
  // path uses, with the shared tag and the day recorded behind it.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '20:00' });
    await dispatchWake(env);
    check('a due wake raises the reminder in the sender\'s own words',
      env.shown.length === 1
        && env.shown[0].title === 'cents. — time to upload your transactions'
        && env.shown[0].opts.body === "Log today's spending while it's fresh.",
      JSON.stringify(env.shown[0] || null));
    check('and it is one notification with the rest: shared tag, renotify, deep link',
      env.shown[0].opts.tag === 'cents-daily-reminder'
        && env.shown[0].opts.renotify === true
        && env.shown[0].opts.data && env.shown[0].opts.data.url === '/index.html#add',
      env.shown[0] && env.shown[0].opts.tag);
    check('and the day is recorded so the other paths stay quiet',
      readRecord(env) && readRecord(env).fired === TODAY && readRecord(env).enabled === true,
      JSON.stringify(readRecord(env)));
  }
  // A2: the wake must not repeat its own day.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '20:00', fired: TODAY });
    await dispatchWake(env);
    check('a second wake the same day is silent', env.shown.length === 0, String(env.shown.length));
  }
  // A3: before the hour (clock 20:30, schedule 21:00) with yesterday done →
  // wait: the browser's moment is not the reminder's hour.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00', fired: YESTERDAY });
    await dispatchWake(env);
    check('a wake before the hour waits for the hour rather than firing early',
      env.shown.length === 0, String(env.shown.length));
  }
  // A4: a record older than yesterday means a whole day slipped past every
  // wake (phase-locked before the hour) — a late reminder beats a skipped one.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00', fired: '2026-10-01' });
    await dispatchWake(env);
    check('a record older than yesterday means a day slipped — it catches up instead of never firing',
      env.shown.length === 1 && readRecord(env).fired === TODAY,
      `shown=${env.shown.length} fired=${readRecord(env) && readRecord(env).fired}`);
  }
  // A5: the first wake ever, still before the hour — the browser may not
  // repeat one before midnight, so the day gets its reminder rather than a wait.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00' });
    await dispatchWake(env);
    check('a first wake with no day recorded announces rather than waiting for a wake that may not come',
      env.shown.length === 1, String(env.shown.length));
  }
  // A6: the schedule is off — a wake is the browser's decision, not permission.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: false, time: '20:00' });
    await dispatchWake(env);
    check('a wake with the reminder switched off stays silent', env.shown.length === 0, String(env.shown.length));
  }
  // A7: the page never mirrored a schedule → nothing to remind about.
  {
    const env = bootWorker();
    await dispatchWake(env);
    check('a schedule the page never mirrored is silent rather than assumed',
      env.shown.length === 0, String(env.shown.length));
  }
  // A8: another periodic tag is not this reminder's business.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '20:00' });
    await dispatchWake(env, 'some-other-periodic-sync');
    check("only the reminder's own sync tag reaches the reminder",
      env.shown.length === 0, String(env.shown.length));
  }
  // A9/A10: the dedupe runs BOTH directions across the two closed-app paths —
  // the shared tag only replaces a visible notification (renotify re-alerts);
  // the record is what makes the second path silent.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '20:00' });
    await dispatchPush(env, { title: 'cents. — time to upload your transactions', body: "Quick tally for Parth — it takes a minute.", tag: 'cents-daily-reminder' });
    check('the scheduled push records the day it delivered',
      env.shown.length === 1 && readRecord(env).fired === TODAY,
      `shown=${env.shown.length} ${JSON.stringify(readRecord(env))}`);
    check('and it names the path that delivered and when — the modal reads that back',
      readRecord(env).by === 'push' && typeof readRecord(env).at === 'string',
      JSON.stringify(readRecord(env)));
    await dispatchWake(env);
    check('then the wake is quiet — one reminder a day across both closed-app paths',
      env.shown.length === 1, String(env.shown.length));
  }
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '20:00' });
    await dispatchWake(env);
    await dispatchPush(env, { title: 'x', body: 'y', tag: 'cents-daily-reminder' });
    check('and a push arriving after the wake is quiet too — the record deduplicates, the tag would only re-alert',
      env.shown.length === 1, String(env.shown.length));
  }
  // A11: a deploy must not re-arm the day — activate keeps the record's cache
  // exactly as it keeps the build baseline, and sweeps only the stale shell.
  {
    const env = bootWorker();
    env.records.set('cents-v23-old', new Map());
    env.records.set('cents-build', new Map([['/__cents-build', 'baseline']]));
    seedRecord(env, { enabled: true, fired: TODAY });
    let waited = null;
    env.events.activate({ waitUntil: (p) => { waited = p; } });
    await waited;
    check('activate sweeps the old shell but keeps the build baseline and the reminder record',
      env.deleted.length === 1 && env.deleted[0] === 'cents-v23-old'
        && env.records.has('cents-build') && env.records.has('cents-reminder'),
      JSON.stringify(env.deleted));
  }
  // A12: an armed push IS the on-time path, and the catch-up has to yield to
  // it. The early fire marks the day as delivered, and the push handler drops
  // any message for a day that already has its banner — so a wake that fires
  // before the hour does not ADD a notification, it CANCELS the one the server
  // is about to send at the hour the user chose. That is the whole reported
  // failure: "Push is on", a subscription the sender is happy to deliver to
  // every day at 20:00, and a phone whose only reminder arrives at whatever
  // moment the browser decided to wake the worker.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00', fired: '2026-10-01', push: true, pushAliveUntil: fixedNow.getTime() + 60 * 60 * 1000 });
    await dispatchWake(env);
    check('a wake before the hour never pre-empts an armed push — the catch-up would cancel the hour it exists to cover',
      env.shown.length === 0 && readRecord(env).fired === '2026-10-01',
      `shown=${env.shown.length} ${JSON.stringify(readRecord(env))}`);
  }
  // A13: with NO subscription the rule above is untouched — this is the case
  // section A4 pins from the other side, and it is why the yield is a field on
  // the record rather than "a push row exists in the app somewhere".
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00', fired: '2026-10-01', push: false });
    await dispatchWake(env);
    check('the same day with no push armed still catches up — the net is withdrawn only for a device with a better path',
      env.shown.length === 1, String(env.shown.length));
  }
  // A14: once the hour has PASSED the wake keeps its own duty. A push is
  // bounded (TTL 3600 — see pushSend), so a phone that was unreachable at its
  // hour has nothing else left to fire it, and the field must not reach here.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '20:00', push: true });
    await dispatchWake(env);
    check('after the hour an armed push does not silence the wake — a push that expired is a day with no reminder',
      env.shown.length === 1, String(env.shown.length));
  }
  // A15/A16: the deferral A12 makes carries an EXPIRY, and this is the failure
  // it exists for. A subscription is stored, the platform's scheduled function
  // stops being invoked (an incident, not a bug in this repo — the dashboard
  // keeps counting down to the next run), and a wake that deferred to a bare
  // boolean would stay quiet for ever: no push, no wake, no reminder, while the
  // app still says "Push is on". Two shapes are not a promise: a horizon that
  // passed, and one that was never granted at all.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00', fired: '2026-10-01', push: true, pushAliveUntil: fixedNow.getTime() - 1000 });
    await dispatchWake(env);
    check('an expired push deferral hands the day back to the wake — a sender that stopped must not silence the net',
      env.shown.length === 1 && readRecord(env).fired === TODAY,
      `shown=${env.shown.length} ${JSON.stringify(readRecord(env))}`);
  }
  {
    const env = bootWorker();
    seedRecord(env, { enabled: true, time: '21:00', fired: '2026-10-01', push: true });
    await dispatchWake(env);
    check('and a deferral that was never granted is not one — the net keeps its own duty',
      env.shown.length === 1, String(env.shown.length));
  }
  // A17: a reminder switched OFF cannot arrive. The toggle drops this device's
  // record at the server (the app's own unsubscribe), but a push can already be
  // in flight, or the delete can fail — so the page mirrors `enabled` into the
  // record and the banner is dropped here.
  {
    const env = bootWorker();
    seedRecord(env, { enabled: false, time: '20:00' });
    await dispatchPush(env, { title: 'cents. — time to upload your transactions', body: 'x', tag: 'cents-daily-reminder' });
    check('a push for a reminder the user switched off never raises a banner',
      env.shown.length === 0, String(env.shown.length));
  }

  // ---- the page half: arming, withdrawing, and the two markers ----
  const savedWake = {
    hadLocalStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
    localStorage: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined,
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    window: Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined,
    navDesc: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    hadNotification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification'),
    Notification: Object.prototype.hasOwnProperty.call(globalThis, 'Notification') ? globalThis.Notification : undefined,
    hadMatchMedia: Object.prototype.hasOwnProperty.call(globalThis, 'matchMedia'),
    matchMedia: Object.prototype.hasOwnProperty.call(globalThis, 'matchMedia') ? globalThis.matchMedia : undefined,
    hadCaches: Object.prototype.hasOwnProperty.call(globalThis, 'caches'),
    caches: Object.prototype.hasOwnProperty.call(globalThis, 'caches') ? globalThis.caches : undefined,
    setInterval: globalThis.setInterval,
    // The push half below needs the two functions it talks to. Every other
    // section in this file uses the suite's real fake push service on
    // localhost; this one is about what the PAGE asks and what it repairs, so
    // the transport is a stub whose answers each check sets.
    fetch: globalThis.fetch,
  };
  try {
    const pageStore = new Map();
    globalThis.localStorage = {
      getItem: (k) => (pageStore.has(k) ? pageStore.get(k) : null),
      setItem: (k, v) => pageStore.set(k, String(v)),
      removeItem: (k) => pageStore.delete(k),
    };
    globalThis.window = globalThis;
    class FakeNotification {
      constructor(title, opts) { this.title = title; this.opts = opts; }
      close() {}
    }
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = async () => FakeNotification.permission;
    globalThis.Notification = FakeNotification;
    const registerCalls = [];
    const unregisterCalls = [];
    let registerError = null;
    const workingReg = {
      periodicSync: {
        register: async (tag, opts) => {
          if (registerError) throw registerError; // the browser's own refusal
          registerCalls.push({ tag, opts });
        },
        unregister: async (tag) => { unregisterCalls.push(tag); },
      },
    };
    const plainReg = {}; // a worker without the Periodic Background Sync API
    const nav = {
      serviceWorker: { ready: Promise.resolve(workingReg), getRegistration: async () => workingReg },
      permissions: { query: async () => ({ state: 'granted' }) },
    };
    // `navigator` is a getter-only global in Node, so it is redefined rather
    // than assigned — and restored by its own original descriptor.
    Object.defineProperty(globalThis, 'navigator', {
      value: nav, configurable: true, writable: true, enumerable: true,
    });
    let installed = true;
    globalThis.matchMedia = (query) => ({ matches: installed && /display-mode/.test(String(query)) });
    const wakeRecords = new Map();
    globalThis.caches = {
      open: async (name) => ({
        match: async (key) => {
          const bucket = wakeRecords.get(name);
          const text = bucket ? bucket.get(key) : undefined;
          return text === undefined ? undefined : new Response(text);
        },
        put: async (key, value) => {
          if (!wakeRecords.has(name)) wakeRecords.set(name, new Map());
          wakeRecords.get(name).set(key, await value.text());
        },
      }),
      keys: async () => [...wakeRecords.keys()],
      delete: async (name) => wakeRecords.delete(name),
      match: async () => undefined,
    };
    globalThis.setInterval = () => ({}); // the minute loop must not hold the process open
    const flush = () => new Promise((r) => setTimeout(r, 0)); // drains the write chain (all microtasks)
    const mirrored = () => {
      const bucket = wakeRecords.get('cents-reminder');
      const text = bucket ? bucket.get('/__cents-reminder') : undefined;
      return text === undefined ? null : JSON.parse(text);
    };
    const realToday = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    const wmod = await import('../reminders.js?wake=18');

    // B1: an installed app with permission arms the wake, and mirrors the
    // schedule where the worker can read it.
    wmod.patchReminderSettings({ enabled: true, time: '20:00', lastFiredDate: null });
    let status = await wmod.syncPeriodicReminder();
    check('an installed app with permission arms the background wake',
      status.state === 'on' && registerCalls.length === 1, JSON.stringify(status));
    check("the sync tag is the notification tag — one string from register to banner",
      registerCalls[0] && registerCalls[0].tag === 'cents-daily-reminder',
      registerCalls[0] && registerCalls[0].tag);
    check('and the interval is a floor measured in hours — a floor, never a claim to a schedule',
      registerCalls[0] && registerCalls[0].opts && registerCalls[0].opts.minInterval >= 60 * 60 * 1000,
      String(registerCalls[0] && registerCalls[0].opts && registerCalls[0].opts.minInterval));
    check('the schedule is mirrored where the worker can read it',
      mirrored() && mirrored().enabled === true && mirrored().time === '20:00',
      JSON.stringify(mirrored()));

    // B2: the page's words are the worker's words (and the server's — pinned
    // by "payload-has-generic-body" above), so no path can sound different.
    const copy = wmod.showReminderNotification(null);
    check('the page, the worker and the server speak with one voice',
      copy.title === 'cents. — time to upload your transactions'
        && copy.body === "Log today's spending while it's fresh.", JSON.stringify(copy));

    // B3: off withdraws the wake itself, not just the page's loop — tonight
    // must not fire from a schedule the user just closed.
    wmod.patchReminderSettings({ enabled: false });
    status = await wmod.syncPeriodicReminder();
    check('switching the reminder off withdraws the wake, not just the page timer',
      status.state === 'off' && unregisterCalls.length === 1 && registerCalls.length === 1,
      JSON.stringify({ status, unregisterCalls, registered: registerCalls.length }));

    // B4: no permission → no register. A wake whose showNotification would
    // throw is not delivery, and arming must never be what asks for the prompt.
    FakeNotification.permission = 'default';
    wmod.patchReminderSettings({ enabled: true });
    status = await wmod.syncPeriodicReminder();
    check('without notification permission the wake is not armed, and the status says permission',
      status.state === 'unavailable' && status.reason === 'permission' && registerCalls.length === 1,
      JSON.stringify(status));
    FakeNotification.permission = 'granted';

    // B5: a browser with a worker but no periodicSync → unsupported, no throw.
    nav.serviceWorker = { ready: Promise.resolve(plainReg), getRegistration: async () => plainReg };
    status = await wmod.syncPeriodicReminder();
    check('a browser without the API reports unsupported rather than pretending',
      status.state === 'unsupported', JSON.stringify(status));
    nav.serviceWorker = { ready: Promise.resolve(workingReg), getRegistration: async () => workingReg };

    // B6: the browser's own refusal lands in the status — the modal AWAITS
    // this before redrawing, so a rejection would hang the toggle.
    registerError = Object.assign(new Error('nope'), { name: 'SecurityError' });
    status = await wmod.syncPeriodicReminder();
    check('a refused register is a verdict the modal can show, never a rejection it hangs on',
      status.state === 'unavailable' && status.reason === 'SecurityError' && registerCalls.length === 1,
      JSON.stringify(status));
    registerError = null;

    // B7: a phone that has only VISITED the site — the browser runs these
    // wakes only for installed apps, so a tab must not be told otherwise.
    installed = false;
    registerCalls.length = 0;
    status = await wmod.syncPeriodicReminder();
    check('an uninstalled tab is told the truth — not armed, reason not-installed',
      status.state === 'unavailable' && status.reason === 'not-installed' && registerCalls.length === 0,
      JSON.stringify(status));
    installed = true;

    // B8: re-mirroring the schedule keeps the day the worker wrote. A plain
    // overwrite would erase it and re-arm an afternoon already delivered.
    wakeRecords.set('cents-reminder', new Map([['/__cents-reminder', JSON.stringify({ enabled: true, time: '20:00', fired: realToday })]]));
    wmod.patchReminderSettings({ time: '21:00' });
    await flush();
    check('re-arming the time keeps the day the worker recorded',
      mirrored() && mirrored().fired === realToday && mirrored().time === '21:00',
      JSON.stringify(mirrored()));

    // B9: the scheduler's own tick writes its half. The start-up tick is the
    // catch-up (banner suppressed, day marked in-app) — and the day is marked
    // for the WORKER too, or a wake arriving later that night would raise a
    // second banner for a day the user already nudged by opening the app.
    // The record is reset first so the assertion sees the tick's own write.
    wmod.patchReminderSettings({ enabled: true, time: '00:00', lastFiredDate: null });
    await flush();
    wakeRecords.set('cents-reminder', new Map([['/__cents-reminder', JSON.stringify({ enabled: true, time: '00:00' })]]));
    wmod.startReminderScheduler();
    await flush();
    check("the scheduler's start-up tick marks the day for the worker as well as the page",
      wmod.getReminderSettings().lastFiredDate === realToday
        && mirrored() && mirrored().fired === realToday && mirrored().enabled === true,
      JSON.stringify({ page: wmod.getReminderSettings().lastFiredDate, wake: mirrored() }));
    check('and a start arms the wake beside the loop — no sync, no password, no prompt',
      registerCalls.length === 1 && registerCalls[0].tag === 'cents-daily-reminder',
      JSON.stringify(registerCalls));

    // ---- the push half: what `pushSubscribed` cannot say ----
    // The failure this exists for: "Push is on", a row promising a notification
    // with the app closed, and no reminder at the hour — because the RECORD the
    // sender writes to is gone (it prunes one the push service calls gone) or
    // because the subscription is bound to a key the server no longer signs
    // with (every push refused, counted in a log nobody reads). Neither is
    // visible from the device unless it asks, and asking is what heals them.
    const { patchSyncSettings } = await import('../settings.js');
    patchSyncSettings({
      enabled: true,
      endpoint: 'https://cents-app.netlify.app/.netlify/functions/sync',
      password: 'pw-test',
    });
    globalThis.window.PushManager = class {}; // pushSupported() reads this
    const pointBytes = (b64) => {
      const buf = Buffer.from(String(b64), 'base64url');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    };
    const OLD_KEY = generateVapidKeys().publicKey; // a pair the server no longer holds
    const pushToken = { p256dh: 'p'.repeat(60), auth: 'a'.repeat(20) };
    let subscribed = 0;
    let unsubscribed = 0;
    let currentSub = null;
    let submitted = null; // the last POST body — what the server was told
    const makeSub = (endpoint, applicationServerKey) => ({
      endpoint,
      options: { userVisibleOnly: true, applicationServerKey },
      toJSON: () => ({ endpoint, keys: pushToken }),
      // A real unsubscribe drops the browser's binding, and subscribe() then
      // creates a NEW one — the repair for a dead key rests on that, so the
      // fake has to do it too rather than leaving a subscription behind.
      unsubscribe: async () => {
        unsubscribed += 1;
        if (currentSub && currentSub.endpoint === endpoint) currentSub = null;
        return true;
      },
    });
    workingReg.pushManager = {
      getSubscription: async () => currentSub,
      subscribe: async () => {
        subscribed += 1;
        currentSub = makeSub(`https://push.example/sub-${subscribed}`, pointBytes(keys.publicKey));
        return currentSub;
      },
    };
    const netCalls = [];
    let keyStatus = 200;
    let probeStatus = 200;
    let netDown = false;
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : null;
      const headers = init.headers || {};
      netCalls.push({ url: String(url), method, body, password: headers['X-Cents-Password'] });
      if (netDown) throw new TypeError('offline'); // a phone in a tunnel
      if (method === 'GET') return new Response(JSON.stringify({ publicKey: keys.publicKey }), { status: keyStatus });
      if (method === 'PUT') return new Response('{}', { status: probeStatus });
      submitted = body;
      return new Response(JSON.stringify({ stored: true }), { status: 200 });
    };

    // C1: a healthy subscription is CONFIRMED, not assumed — and confirming it
    // is read-only: one key lookup, one probe, no notification, no writes.
    currentSub = makeSub('https://push.example/current', pointBytes(keys.publicKey));
    wmod.patchReminderSettings({ pushSubscribed: true, pushEndpoint: currentSub.endpoint });
    await flush();
    netCalls.length = 0;
    let verdict = await wmod.verifyReminderPush();
    check('a live subscription is verified against the server rather than assumed',
      verdict.state === 'live' && verdict.ok === true, JSON.stringify(verdict));
    check('and verifying it delivers nothing — one key lookup and one probe, no push, no writes',
      netCalls.length === 2 && netCalls[0].method === 'GET' && netCalls[1].method === 'PUT'
        && netCalls[1].body && netCalls[1].body.probe === true && subscribed === 0,
      JSON.stringify(netCalls.map(c => c.method)));
    check('the probe asks about THIS device, at the push endpoint, with this profile\'s password',
      netCalls[1].body.endpoint === 'https://push.example/current'
        && netCalls[1].url.endsWith('/reminders-push') && netCalls[1].password === 'pw-test',
      JSON.stringify(netCalls[1]));

    // C2: the record is gone — the sender pruned it on a push service's "gone",
    // which is the one delete the device never hears about. The reminder is dead
    // until the subscription is stored again, so the check is a repair.
    probeStatus = 404;
    netCalls.length = 0;
    verdict = await wmod.verifyReminderPush();
    check('a record the server no longer holds is repaired, not merely reported',
      verdict.state === 'healed' && verdict.healed === 'record', JSON.stringify(verdict));
    check('and the repair stores the live subscription again, with this device\'s schedule',
      !!submitted && submitted.subscription.endpoint === 'https://push.example/current'
        && submitted.time === wmod.getReminderSettings().time
        && submitted.zone === new Intl.DateTimeFormat().resolvedOptions().timeZone,
      JSON.stringify(submitted));
    check('with push left switched on — the row must not go dark over a repair it made',
      wmod.getReminderSettings().pushSubscribed === true, JSON.stringify(wmod.getReminderSettings()));

    // C3: bound to a key the server no longer signs with. Every push it sends is
    // refused by the push service — invisible everywhere except the sender's own
    // counter — and a browser binds its subscription at subscribe() time, so the
    // only repair is a new subscription.
    currentSub = makeSub('https://push.example/old-key', pointBytes(OLD_KEY));
    wmod.patchReminderSettings({ pushSubscribed: true, pushEndpoint: currentSub.endpoint });
    probeStatus = 200;
    const unsubsBefore = unsubscribed;
    submitted = null;
    verdict = await wmod.verifyReminderPush();
    check('a subscription bound to a key the server no longer signs with is re-subscribed, not left to fail in silence',
      verdict.state === 'healed' && verdict.healed === 'key' && unsubscribed === unsubsBefore + 1,
      JSON.stringify(verdict));
    check('and the NEW subscription is the one stored — the old binding cannot be talked round',
      !!submitted && submitted.subscription.endpoint === 'https://push.example/sub-1'
        && wmod.getReminderSettings().pushEndpoint === 'https://push.example/sub-1',
      JSON.stringify({ submitted: submitted && submitted.subscription.endpoint, settings: wmod.getReminderSettings().pushEndpoint }));

    // C4: offline. A phone in a tunnel must not have its reminder torn down: no
    // write, no re-subscribe, and a status that says "could not check" rather
    // than a verdict on a device nobody could reach.
    netDown = true;
    const before = currentSub.endpoint;
    wmod.patchReminderSettings({ pushSubscribed: true, pushEndpoint: before });
    const subsBefore = subscribed;
    verdict = await wmod.verifyReminderPush();
    netDown = false;
    check('a device that cannot reach the server keeps its subscription and its flag — unreachable is not a verdict',
      verdict.state === 'unreachable' && wmod.getReminderSettings().pushSubscribed === true
        && currentSub.endpoint === before && subscribed === subsBefore,
      JSON.stringify(verdict));

    // C5: the browser dropped the subscription itself (a rotated token, an OS
    // that cleared the site's data). Nothing the server signs can be delivered
    // to a device that is not listening, and `pushSubscribed: true` is then a
    // promise about a subscription that exists nowhere but in the settings.
    currentSub = null;
    verdict = await wmod.verifyReminderPush();
    check('a subscription the browser no longer holds is re-created rather than reported',
      verdict.state === 'healed' && verdict.healed === 'subscription' && subscribed === subsBefore + 1,
      JSON.stringify(verdict));

    // C6: and the worker is TOLD, because the yield in A12 rests on this field
    // alone. Every settings write carries it — the mirror is a patch, so a
    // withdrawal has to be written as a value rather than left as an old key.
    wmod.patchReminderSettings({ pushSubscribed: false });
    await flush();
    check('the mirror withdraws the armed-push field when push is switched off',
      mirrored() && mirrored().push === false, JSON.stringify(mirrored()));
    wmod.patchReminderSettings({ pushSubscribed: true, pushEndpoint: currentSub.endpoint });
    await flush();
    check('and mirrors it again with a subscription, so the wake yields to the on-time path',
      mirrored() && mirrored().push === true && mirrored().enabled === true,
      JSON.stringify(mirrored()));
  } finally {
    if (savedWake.hadLocalStorage) globalThis.localStorage = savedWake.localStorage;
    else delete globalThis.localStorage;
    if (savedWake.hadWindow) globalThis.window = savedWake.window;
    else delete globalThis.window;
    if (savedWake.navDesc) Object.defineProperty(globalThis, 'navigator', savedWake.navDesc);
    else delete globalThis.navigator;
    if (savedWake.hadNotification) globalThis.Notification = savedWake.Notification;
    else delete globalThis.Notification;
    if (savedWake.hadMatchMedia) globalThis.matchMedia = savedWake.matchMedia;
    else delete globalThis.matchMedia;
    if (savedWake.hadCaches) globalThis.caches = savedWake.caches;
    else delete globalThis.caches;
    globalThis.fetch = savedWake.fetch;
    globalThis.setInterval = savedWake.setInterval;
  }

  // ---- the halves no behavioral run can reach ----
  const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const modalAt = appSource.indexOf('function openReminderSettings');
  const modalBody = appSource.slice(modalAt, appSource.indexOf('\nfunction isTopModal', modalAt));
  const modalWakes = (modalBody.match(/syncPeriodicReminder\(\)/g) || []).length;
  // Each call site by its OWN shape — a count would pass with any one of the
  // three gone, and each is a different promise: the toggle withdraws tonight,
  // the Allow click re-arms right after the prompt, the open probe corrects a
  // row drawn before the verdict landed.
  check('the modal re-arms the wake from the toggle, the Allow click and open',
    modalAt > -1
      && /then\(\(\) => syncPeriodicReminder\(\)\)/.test(modalBody)
      && /await syncPeriodicReminder\(\)/.test(modalBody)
      && /syncPeriodicReminder\(\)\.catch\(\(\) => \{\}\)\.then\(draw\)/.test(modalBody),
    String(modalWakes));
  check('and it imports the status the row is drawn from',
    /reminderPushStatus, reminderSchedulerStatus, readLastReminderDelivery, triggerServerTick, reminderServerSchedule \} from '\.\/reminders\.js'/.test(appSource)
      && /periodicReminderStatus\(\)/.test(modalBody)
      && /reminderPushStatus\(\)/.test(modalBody));
  // The two sentences the modal could not say, and both are why a reminder that
  // never fires used to look identical to one that does: what the server's own
  // scheduler is doing (`reminderSchedulerStatus`, from the sender's heartbeat),
  // and whether a reminder ever actually ARRIVED here
  // (`readLastReminderDelivery`, from the record every path writes).
  check('the modal reports the server scheduler, and not as a guess',
    /const sched = reminderSchedulerStatus\(\)/.test(modalBody)
      && /The server's scheduler last ran/.test(modalBody)
      && /no closed-app push is being sent/.test(modalBody));
  // A run that sends to none of the devices it found (every push refused) and a
  // run with nothing due are the same sentence — "the scheduler is running" —
  // and they are fixed by completely different things: the first by
  // re-registering this device, the second by looking at the record's own time
  // and zone. The counts ride in the heartbeat, the modal names the refused
  // case, and that case gets the same one-tap repair a dead verdict gets.
  check('a run the push service refused is named, and repairs like a dead verdict',
    /const refusedAll = !!runCounts && runCounts\.considered > 0 && runCounts\.sent === 0 && runCounts\.rejected > 0;/.test(modalBody)
      && /the push service refused \$\{runCounts\.rejected\}/.test(modalBody)
      && /const needReRegister = s\.pushSubscribed && !!pushUsable && \(PUSH_HEALABLE\[pushVerdict\.state\] \|\| refusedAll\);/.test(modalBody));
  // …and the declaration ORDER, because this is not style: a `const` does not
  // hoist, so a reader above the declaration is a throw the moment the modal
  // opens — and the counts are read by both the repair button and the
  // scheduler sentence, so there is one declaration with two readers.
  check('the run counts are declared above every reader (a const does not hoist)',
    modalBody.indexOf('const runCounts = sched.counts;') > -1
      && modalBody.indexOf('const runCounts = sched.counts;') < modalBody.indexOf('const needReRegister =')
      && modalBody.indexOf('const refusedAll =') > -1
      && modalBody.indexOf('const refusedAll =') < modalBody.indexOf('const needReRegister =')
      && modalBody.indexOf('const refusedAll =') < modalBody.indexOf('const schedulerText ='),
    'needReRegister must not read refusedAll before it is declared');
  // "has not been checked yet" and "the server has never run its scheduler" are
  // the same `schedulerAt: null` and completely different news.
  check('and a server that has never run its scheduler says that, not "not checked"',
    /sched\.state === 'never'/.test(modalBody)
      && /The server has never run its scheduler/.test(modalBody)
      && /\(s\.schedulerChecked && !s\.schedulerAt\) \? 'never' : 'unknown'/.test(remindersSource)
      && /rejected: Number\(scheduler\.rejected\) \|\| 0,/.test(remindersSource));
  // The one half of a closed-app reminder neither side can see alone: the
  // sender's due check reads the RECORD's time and zone, so a stale copy pushes
  // at the old hour while the picker shows the new one, and a zone Intl cannot
  // read makes every run answer "not due" and send nothing, for ever. Kept as
  // an OBSERVATION, repaired on the spot, and reported by the modal.
  check('the server\'s own copy of the schedule is read back and compared',
    /const serverTime = typeof source\.serverTime === 'string'/.test(remindersSource)
      && /const serverZone = typeof source\.serverZone === 'string'/.test(remindersSource)
      && /export function reminderServerSchedule\(\)/.test(remindersSource)
      && /matches: s\.serverTime === s\.time && s\.serverZone === localZone && zoneUsable\(s\.serverZone\)/.test(remindersSource));
  check('a zone the sender cannot parse counts as a mismatch, not as agreement',
    /try \{ new Intl\.DateTimeFormat\('en-GB', \{ timeZone: zone \}\); return true; \}/.test(remindersSource)
      && /if \(!zone\) return false;/.test(remindersSource)
      && /catch \{ return false; \} \/\/ isDue\(\) answers false for ever: nothing is ever sent/.test(remindersSource));
  check('and a mismatch is REWRITTEN, not merely described',
    /serverTime: typeof payload\.time === 'string' \? payload\.time : null,/.test(remindersSource)
      && /const observed = reminderServerSchedule\(\);/.test(remindersSource)
      && /if \(observed && !observed\.matches\) \{\s*\n\s*const fixed = await updateReminderPushTime\(\)\.catch\(\(\) => null\);/.test(remindersSource)
      && /fixed && fixed\.ok === true\) patchReminderSettings\(\{ pushTimeFixedAt: new Date\(\)\.toISOString\(\) \}\)/.test(remindersSource));
  check('the probe hands the record\'s own zone back with its time',
    /zone: found\.record\.zone \|\| null,/.test(readFileSync(new URL('../netlify/functions/reminders-push.mjs', import.meta.url), 'utf8')));
  check('and the modal says which hour the server is aimed at, or that it is aimed at none',
    /triggerServerTick, reminderServerSchedule \} from '\.\/reminders\.js'/.test(appSource)
      && /const serverScheduleText = !srv \? null/.test(modalBody)
      && /that is the hour it pushes at\./.test(modalBody)
      && /so no scheduled push can be sent at all\./.test(modalBody)
      && /not the \$\{srv\.localTime\} \$\{srv\.localZone\} set here\./.test(modalBody)
      && /s\.pushSubscribed && pushUsable && serverScheduleText \? \$\('div'/.test(modalBody));
  // …and the half the heartbeat cannot answer: a running scheduler that never
  // reaches THIS device. "No push has been sent to this device yet" beside
  // "last ran 2 min ago — push is being sent" is the refused-subscription pair.
  check('and what the server has actually sent to this device, if anything',
    /Last push sent to this device/.test(modalBody)
      && /No push has been sent to this device yet/.test(modalBody)
      && /s\.pushDeliveredAt/.test(modalBody)
      && /if \(typeof payload\.lastFiredAt === 'string'\) patch\.pushDeliveredAt = payload\.lastFiredAt;/.test(remindersSource));
  check('and it answers "did it ever fire?" with the path and the time',
    /readLastReminderDelivery\(\)\.catch\(\(\) => null\)\.then\(d => \{ lastDelivery = d; draw\(\); \}\)/.test(modalBody)
      && /const DELIVERY_BY = \{ push: 'sent by the server', wake:/.test(appSource)
      && /No reminder has reached this device yet/.test(modalBody));
  // The repair for the one failure re-registering cannot touch: run the
  // sender's job now. It needs no new credential (the app already holds the
  // sync password) and it either delivers the day or names why not.
  check('and a scheduler that is not running is offered a one-tap run, not a sentence',
    /sched\.state !== 'alive'/.test(modalBody)
      && /await triggerServerTick\(\)/.test(modalBody)
      && /'Run server reminder now'/.test(modalBody));
  // Off is off: the toggle that switches the reminder off drops this device's
  // push record too, or the server keeps sending a reminder the user cancelled
  // (a record's existence IS the server's memory that a device wants pushes).
  check('switching the reminder off withdraws the push record with it',
    /if \(!enabled && s\.pushSubscribed\) \{/.test(modalBody)
      && /unsubscribeReminderPush\(\)\.catch\(\(\) => \{\}\)\.then\(\(\) => \{/.test(modalBody));
  check('the row claims a background reminder only when the register said on',
    /Background reminder is on/.test(modalBody)
      && /periodicReminderStatus\(\)\.state === 'on'/.test(modalBody));
  const swTag = /const REMINDER_TAG = '([^']+)'/.exec(swSource)?.[1];
  const pageTag = /const WAKE_TAG = '([^']+)'/.exec(remindersSource)?.[1];
  check('worker and page declare one tag for the whole chain',
    !!swTag && swTag === pageTag, `${swTag} / ${pageTag}`);
  const schedAt = remindersSource.indexOf('export function startReminderScheduler');
  const schedBody = remindersSource.slice(schedAt, remindersSource.indexOf('// ---------- closed-app push', schedAt));
  check('a start arms the wake last and best effort, after the loop is running',
    /syncPeriodicReminder\(\)\.catch\(\(\) => \{\}\)/.test(schedBody)
      && schedBody.indexOf('visibilitychange') < schedBody.indexOf('syncPeriodicReminder()'));
  const syncAt = remindersSource.indexOf('export async function syncPeriodicReminder');
  const syncBody = remindersSource.slice(syncAt, remindersSource.indexOf('// ---------- closed-app push', syncAt));
  check('arming the wake never asks for permission — starting the app must not prompt',
    syncAt > -1 && !/requestNotificationPermission/.test(syncBody));
  check('every settings write mirrors the schedule the wake reads',
    /function writeSettings\(next\)[\s\S]{0,400}?mirrorWakeRecord\(\);/.test(remindersSource));
  check("the tick writes the day into the worker's record beside the page's",
    /patchReminderSettings\(\{ lastFiredDate: todayKey \}\);[\s\S]{0,900}?markWakeFired\(todayKey\);/.test(remindersSource));
  // Two writes in flight would each read the OLD record and the slower put
  // would win with a stale base — a `fired` written from before the mirror's
  // `enabled: true` is how a wake stops firing while everything looks right.
  check('record writes are chained so a mirror cannot erase the day beside it',
    /wakeWriteChain = wakeWriteChain\.then\(\(\) => patchWakeRecord\(patch\)\)/.test(remindersSource)
      && /return queueWakePatch\(\{[\s\S]{0,200}?push: s\.pushSubscribed,/.test(remindersSource)
      && /return queueWakePatch\(\{ fired: day, by: 'page', at: new Date\(\)\.toISOString\(\) \}\)/.test(remindersSource));
  // The yield itself: pinned in the worker's own text because the property that
  // makes it correct is WHERE it sits — a `push` check inside the due-time
  // branch would silence the one path with nothing else behind it (A14), and a
  // check outside the `!due` branch would never run.
  const wakeAt = swSource.indexOf('async function dailyReminderWake');
  const wakeBody = swSource.slice(wakeAt, swSource.indexOf('self.addEventListener(\'notificationclick\'', wakeAt));
  check('the wake yields to an armed push, and only before the hour — after it the net has nothing else behind it',
    wakeAt > -1
      && /if \(!due\) \{\s*\n\s*if \(pushCoversHour\(record, now\.getTime\(\)\)\) return;[\s\S]{0,200}?if \(record\.fired === yesterday\) return;\s*\n\s*\}/.test(wakeBody),
    wakeBody.slice(wakeBody.indexOf('if (!due)'), wakeBody.indexOf('if (!due)') + 220));
  // …and the deferral that branch makes EXPIRES. A bare `record.push === true`
  // is the version that shipped and the version that fails silently: the
  // platform stops invoking the sender, and the wake — the only path left with
  // nothing behind it — keeps waiting for a push that is never sent.
  check('and the deferral is a promise with a horizon, not an armed flag',
    /function pushCoversHour\(record, nowMs\) \{\s*\n\s*if \(record\.push !== true\) return false;\s*\n\s*const until = Number\(record\.pushAliveUntil\);\s*\n\s*return Number\.isFinite\(until\) && until > nowMs;\s*\n\s*\}/.test(swSource)
      && !/if \(record\.push === true\) return;/.test(swSource));
  // The page's own half of the same rule: `push` is only ever mirrored from the
  // live setting, so a device that switches push off gets its net back.
  check('the armed-push field comes from the live setting, never a constant',
    /mirrorWakeRecord\(\) \{\s*\n\s*const s = readSettings\(\);\s*\n\s*const alive = schedulerAlive\(s\);/.test(remindersSource)
      && /pushAliveUntil: s\.pushSubscribed && alive !== false \? Date\.now\(\) \+ PUSH_TRUST_MS : 0,/.test(remindersSource));
  // The horizon is written from the SENDER's own heartbeat, which the push
  // probe reports — a scheduler that ran is trusted, one that has not is not,
  // and one nobody has ever heard from is left alone rather than blamed.
  check('and the horizon is decided by what the server said, not by hope',
    /schedulerAt: scheduler\.ranAt, schedulerOk: scheduler\.ok === true/.test(remindersSource)
      && /if \(s\.schedulerOk === false\) return false;/.test(remindersSource));
  // A device that is OPEN at the hour also fires the server's own run, so the
  // devices that are closed still get their push on a platform whose cron has
  // gone quiet — any copy of the app that is running is a trigger for the rest.
  const fireAt = remindersSource.indexOf('function fire(');
  const fireBody = remindersSource.slice(fireAt, remindersSource.indexOf('function tick(', fireAt));
  check('a device that fires its own reminder also fires the server\'s run — any open app is a trigger for the closed ones',
    fireAt > -1 && /triggerServerTick\(\)\.catch\(\(\) => \{\}\);/.test(fireBody), fireBody.slice(0, 120));
  // And the check is run where it can be: on a start, beside the zone
  // re-announce, gated on a device that is subscribed AND permitted. A prompt
  // must never come out of starting the app, and a device that never subscribed
  // has nothing to check.
  check('a start re-checks a subscribed device\'s push — the only moment a silently dead reminder can be found',
    /s\.pushSubscribed && notificationPermission\(\) === 'granted'[\s\S]{0,600}?verifyReminderPush\(\)\.catch/.test(schedBody));
  check('and the check never asks for permission — it runs for a device that already granted it',
    /export async function verifyReminderPush[\s\S]{0,1400}?notificationPermission\(\) !== 'granted'\) return settle\('permission'\)/.test(remindersSource)
      && !/export async function verifyReminderPush[\s\S]{0,1600}?requestNotificationPermission\(\)/.test(remindersSource));
  // The modal's two new halves: the probe that asks, and the repair offered at
  // the failure rather than described three taps away.
  check('the modal asks the server about a subscribed device, once per open',
    /if \(!pushProbed && s\.pushSubscribed && pushUsable && pushVerdict\.state === 'unknown'\)/.test(modalBody)
      && /verifyReminderPush\(\)\.catch\(\(\) => \{\}\)\.then\(draw\)/.test(modalBody));
  check('and a failure the server can fix is offered as one tap, not as a sentence',
    /'Re-register'/.test(modalBody) && /await unsubscribeReminderPush\(\);\s*\n\s*const r = await subscribeReminderPush\(\);/.test(modalBody)
      && /PUSH_HEALABLE\[pushVerdict\.state\]/.test(modalBody));
  // An event's `currentTarget` is only set WHILE the event is being dispatched,
  // so a handler that reaches for it after an await throws ("Cannot set
  // properties of null (setting 'disabled')"), dies there, and leaves the
  // button disabled with no toast — a tap that really did the thing and said
  // nothing, which is indistinguishable from a feature that does not work.
  // Measured live on Send test push. Every async handler here captures its
  // button first, and the rule is per handler so a new one cannot slip in.
  const asyncHandlers = modalBody.split('onClick: async (ev) => {').slice(1);
  check('every async handler in the modal captures its button before it awaits',
    asyncHandlers.length >= 4
      && asyncHandlers.every((h) => /const btn = ev\.currentTarget;/.test(h)
        && (h.match(/ev\.currentTarget/g) || []).length === 1),
    JSON.stringify(asyncHandlers.map((h) => (h.match(/ev\.currentTarget/g) || []).length)));
  check('the row reports the verdict, not the toggle that produced it',
    /PUSH_VERDICT_TEXT\[pushVerdict\.state\] \|\| PUSH_VERDICT_TEXT\.live/.test(modalBody)
      && /'no-record':/.test(modalBody) && /'key-mismatch':/.test(modalBody));
  // Both maps are plain data and both are read out of the file's own text: a
  // state can offer the repair and have no sentence for it, and the fallback
  // (`|| PUSH_VERDICT_TEXT.live`) would then print the all-clear — "the reminder
  // reaches you even when cents. is closed" — over a subscription the code has
  // just decided is DEAD. That is the defect this pins, and it is one line away
  // at all times.
  const textMap = /\n    const PUSH_VERDICT_TEXT = (\{[\s\S]*?\n    \});/.exec(modalBody)?.[1];
  const healMap = /\n    const PUSH_HEALABLE = (\{[^}]*\});/.exec(modalBody)?.[1];
  const parse = (src) => { try { return new Function(`return ${src}`)(); } catch { return null; } };
  const verdicts = parse(textMap);
  const healable = parse(healMap);
  check('every state that offers a repair has a sentence of its own — a healable verdict must never print the all-clear',
    !!verdicts && !!healable && Object.keys(healable).every((k) => k in verdicts)
      && Object.keys(verdicts).length >= 8,
    JSON.stringify({ healable: healable && Object.keys(healable), sentenced: verdicts && Object.keys(verdicts) }));
  check('and the verdicts that are not failures keep their own words',
    !!verdicts && !!verdicts.live && !!verdicts.unreachable && !!verdicts.unknown
      && !verdicts.unreachable.includes('Re-register'),
    JSON.stringify(verdicts));
}

// ---------- 19. the reminder says what bills are due ----------
// The sender appends a hint to the body, counted from the profile's OWN
// synced document. Three things to hold: the read must go through the one
// store/key sync writes (a second copy of either is an empty store, and an
// empty store reads exactly like "nothing due"), the count is against the
// record's own local date (a zone ahead of UTC is already tomorrow — the hint
// must not announce a bill a day early), and it never throws — a hint is not
// worth the delivery it rides on.
{
  const { billsDueHint } = sendModule;
  const dayAfter = (ymdStr, days) => new Date(new Date(`${ymdStr}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
  const todayStr = ymd('UTC');
  const tomorrowStr = dayAfter(todayStr, 1);
  const yesterdayStr = dayAfter(todayStr, -1);

  // ---- the counting rule on its own ----
  const docWith = (nextDates) => ({ settings: { recurring: nextDates.map(nextDate => ({ nextDate })) } });
  check('no document says nothing', billsDueHint(null, todayStr) === '');
  check('no recurring list says nothing', billsDueHint({ settings: {} }, todayStr) === '');
  check('a bill due today is counted', billsDueHint(docWith([todayStr]), todayStr) === ' 1 bill due.');
  check('an overdue bill is counted — late needs paying more',
    billsDueHint(docWith([yesterdayStr]), todayStr) === ' 1 bill due.');
  check('tomorrow is not due today', billsDueHint(docWith([tomorrowStr]), todayStr) === '');
  check('due and overdue count, future does not',
    billsDueHint(docWith([yesterdayStr, todayStr, tomorrowStr]), todayStr) === ' 2 bills due.',
    JSON.stringify(billsDueHint(docWith([yesterdayStr, todayStr, tomorrowStr]), todayStr)));
  check('a malformed entry never counts',
    billsDueHint({ settings: { recurring: [null, 'x', {}, { nextDate: 42 }] } }, todayStr) === '');
  check('a malformed local date says nothing',
    billsDueHint(docWith([todayStr]), '') === '' && billsDueHint(docWith([todayStr]), undefined) === '');
  check('a document that throws is swallowed, not raised', (() => {
    try { return billsDueHint({ get settings() { throw new Error('boom'); } }, todayStr) === ''; }
    catch { return false; }
  })());

  // ---- the read path: one store, one key, the record's own date ----
  // The job lives in ONE place, and both entry points run THAT: the scheduled
  // function is the platform's clock, the HTTP trigger is the one a user can
  // point anywhere else when that clock stops. A second copy of the loop would
  // be a second answer to "was this device already sent to today".
  const senderSource = readFileSync(new URL('../netlify/functions/reminders-send.mjs', import.meta.url), 'utf8');
  const tickSource = readFileSync(new URL('../netlify/functions/reminders-tick.mjs', import.meta.url), 'utf8');
  const runSource = readFileSync(new URL('../netlify/functions/lib/reminder-run.mjs', import.meta.url), 'utf8');
  check('both entry points run the same job rather than keeping a copy each',
    /await runReminderTick\(\{ store \}\)/.test(senderSource) && /await runReminderTick\(\{ store \}\)/.test(tickSource)
      && !/for \(const key of keys\)/.test(senderSource) && !/for \(const key of keys\)/.test(tickSource));
  check('the run reads the document through cloud.mjs, not a copy',
    /import \{ CLOUD_STORE, keyFor \} from '\.\/cloud\.mjs'/.test(runSource)
      && !/openStore\('cents-cloud'\)/.test(runSource));
  check('the hint is appended to the body, keyed by profile and date',
    /\+\s*\(await billsHint\(rec\.profileId, localDate\)\)/.test(runSource));
  check('and every run records a heartbeat the app can read',
    /export async function writeSchedulerHeartbeat/.test(runSource)
      && /await record\(summary\);/.test(runSource)
      && /export async function readSchedulerHeartbeat/.test(runSource));

  // ---- end to end: a profile with bills gets them appended ----
  const { store: cloud } = await openStore('cents-cloud');
  await cloud.setJSON('doc/personal.json', {
    v: 1, version: 1, updatedAt: Date.now(),
    content: { settings: { recurring: [
      { nextDate: todayStr, details: 'Broadband' },
      { nextDate: yesterdayStr, details: 'Rent' },
      { nextDate: tomorrowStr, details: 'Gas' },
    ] } },
  });
  for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k);
  const hintRecord = (over = {}) => ({
    time: hhmm('UTC'), zone: 'UTC', lastFiredDate: '1999-01-01',
    subscription: { endpoint: `http://localhost:${pushPort}/fake-push`, keys: subscription.keys },
    ...over,
  });
  await store.setJSON('push:hint-due', hintRecord({ profileId: 'personal', profileName: 'Sam' }));
  received.length = 0;
  await sendHandler(null, {});
  check('the body carries the bills that are due',
    received.length === 1 && received[0].body === 'Quick tally for Sam — it takes a minute. 2 bills due.',
    JSON.stringify(received.map(r => r.body)));

  // A record with no profile has no document to read — guessing one profile's
  // bills for another device is worse than saying nothing.
  await store.setJSON('push:hint-noprofile', hintRecord({ profileName: '' }));
  received.length = 0;
  await sendHandler(null, {});
  check('a record with no profile keeps the plain body',
    received.length === 1 && received[0].body === "Log today's spending while it's fresh.",
    JSON.stringify(received.map(r => r.body)));

  // No synced document — cloud sync never configured — is the plain line too.
  await store.setJSON('push:hint-nodoc', hintRecord({ profileId: 'nobody', profileName: 'Kay' }));
  received.length = 0;
  await sendHandler(null, {});
  check('a profile with no synced document keeps the plain body',
    received.length === 1 && received[0].body === 'Quick tally for Kay — it takes a minute.',
    JSON.stringify(received.map(r => r.body)));

  await cloud.del('doc/personal.json');
  for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k);
}

// ---------- 21. the probe: "is my reminder still deliverable?" ----------
// A record the sender has pruned leaves a device whose app still reads "Push is
// on" and whose reminder arrives only when the app is opened. The device cannot
// know without asking, and the ask has to be safe to make on EVERY start — which
// rules out the call that already exists (PUT without a flag is Send test push,
// and it delivers a notification). So the probe is the same lookup with a flag,
// and the point of this section is the thing it must not do.
{
  const endpoint = subscription.endpoint;
  await pushHandler(new Request('http://localhost/.netlify/functions/reminders-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cents-Password': 'test-password-123' },
    body: JSON.stringify({ subscription, profileName: 'Parth', time: '20:00', zone: 'Europe/Dublin' }),
  }), {});
  received = [];
  const probed = await call(pushHandler, 'PUT', { probe: true, endpoint });
  const probedBody = await probed.json().catch(() => null);
  check('a probe is answered about the record that exists',
    probed.status === 200 && probedBody && probedBody.stored === true, `${probed.status} ${JSON.stringify(probedBody)}`);
  check('and it delivers NOTHING — a probe that notified would be a banner on every start',
    received.length === 0, String(received.length));
  check('the probe carries the record\'s own time back, so the app can say what it checked',
    probedBody && probedBody.time === '20:00', JSON.stringify(probedBody));

  // The healthy device is the case that must stay silent; the dead one is the
  // case the app acts on, and "not here" has to be distinguishable from
  // "wrong password" — one is a repair, the other is a setup problem.
  const missing = await call(pushHandler, 'PUT', { probe: true, endpoint: 'https://push.example/never-stored' });
  check('a probe for a record the server does not hold says so rather than sending',
    missing.status === 404 && received.length === 0, String(missing.status));
  const unauthed = await pushHandler(new Request('http://localhost/.netlify/functions/reminders-push', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ probe: true, endpoint }),
  }), {});
  check('and a probe is authenticated like every other write — the record is not a public read',
    unauthed.status === 401, String(unauthed.status));
  for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k);
}

// ---------- 22. the sender's heartbeat, and the trigger that replaces a dead cron ----------
// Two halves of one failure. A platform whose scheduled function stops being
// invoked sends nothing at all, and from a phone that is indistinguishable from
// a subscription that died: no notification, and an app that still reads "Push
// is on". So every run leaves a heartbeat the device can read (which is what
// lets its background wake stop deferring — section 18), and the same run is
// reachable over HTTP for whoever can keep a schedule when the platform cannot.
{
  const dueRecord = (over = {}) => ({
    time: hhmm('UTC'), zone: 'UTC', lastFiredDate: '1999-01-01',
    subscription: { endpoint: `http://localhost:${pushPort}/fake-push`, keys: subscription.keys },
    profileId: 'personal', profileName: 'Parth', ...over,
  });

  // ---- the heartbeat: every run says it ran ----
  await store.del('meta:reminder-send');
  received.length = 0;
  await store.setJSON('push:beat-test', dueRecord());
  await sendHandler(null, {});
  const beat = await runModule.readSchedulerHeartbeat(store);
  check('a run records when it happened and what it met',
    !!beat && typeof beat.ranAt === 'string' && beat.ok === true
      && beat.considered >= 1 && beat.sent >= 1,
    JSON.stringify(beat));
  await store.del('push:beat-test');
  await sendHandler(null, {});
  const beatAfterQuietRun = await runModule.readSchedulerHeartbeat(store);
  check('and a run with nothing due still says it ran — silence is not the same as absence',
    !!beatAfterQuietRun && typeof beatAfterQuietRun.ranAt === 'string' && beatAfterQuietRun.sent === 0,
    JSON.stringify(beatAfterQuietRun));

  // ---- the trigger: the same job, reachable by URL ----
  await store.setJSON('push:tick-test', dueRecord());
  received.length = 0;
  const denied = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick', { method: 'POST' }), {});
  check('the trigger refuses to run without the app password', denied.status === 401, String(denied.status));
  const ran = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cents-Password': 'test-password-123' },
  }), {});
  const ranBody = await ran.json();
  check('the trigger runs the sender\'s own job and delivers the due reminder',
    ran.status === 200 && received.length === 1 && ranBody.scheduler && ranBody.scheduler.sent === 1,
    `${ran.status} ${JSON.stringify(ranBody)} delivered=${received.length}`);
  check('and it answers with the run\'s own heartbeat, which the app stores',
    !!ranBody.scheduler && typeof ranBody.scheduler.ranAt === 'string' && ranBody.scheduler.ok === true,
    JSON.stringify(ranBody.scheduler));
  received.length = 0;
  const again = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick', {
    method: 'POST', headers: { 'X-Cents-Password': 'test-password-123' },
  }), {});
  const againBody = await again.json();
  check('a second trigger the same day delivers nothing — it is the same idempotent job, not a second sender',
    again.status === 200 && received.length === 0 && againBody.scheduler.sent === 0,
    `${again.status} delivered=${received.length} ${JSON.stringify(againBody.scheduler)}`);
  // A cron service that can only reach a URL, and a named profile's own password.
  const viaQuery = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick?password=test-password-123', { method: 'GET' }), {});
  check('a cron that can only reach a URL is served too — GET plus ?password=', viaQuery.status === 200, String(viaQuery.status));
  const otherProfile = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick?password=test-password-123&profile=sam', { method: 'GET' }), {});
  check('and ?profile= checks the password against THAT profile\'s own variable, not the default one',
    otherProfile.status === 401, String(otherProfile.status));
  const ownProfile = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick?password=sam-password-123&profile=sam', { method: 'GET' }), {});
  check('so a named profile can fire the run with its own password', ownProfile.status === 200, String(ownProfile.status));
  await store.del('push:tick-test');

  // ---- what the app is told: the probe carries the heartbeat, and the one
  // fact the heartbeat cannot. A scheduler that runs while every message to ONE
  // subscription is refused (a retired token, a subscription bound to a key the
  // service will not sign for) is a healthy server and a silent phone — the pair
  // nothing else can tell apart, and the reason the probe also reports when this
  // device was last actually sent to.
  await call(pushHandler, 'POST', { subscription, profileName: 'Parth', time: hhmm('UTC'), zone: 'UTC' });
  received.length = 0;
  const delivered = await tickHandler(new Request('http://localhost/.netlify/functions/reminders-tick', {
    method: 'POST', headers: { 'X-Cents-Password': 'test-password-123' },
  }), {});
  check('the trigger delivers to the device the app subscribed with',
    delivered.status === 200 && received.length === 1, `status=${delivered.status} delivered=${received.length}`);
  const probed = await call(pushHandler, 'PUT', { probe: true, endpoint: subscription.endpoint });
  const probedBody = await probed.json().catch(() => null);
  check('the probe hands the sender\'s heartbeat to the device that asks',
    probed.status === 200 && !!probedBody && !!probedBody.scheduler
      && typeof probedBody.scheduler.ranAt === 'string' && probedBody.scheduler.considered >= 1,
    JSON.stringify(probedBody));
  // …and the RECORD'S OWN schedule beside it, because that — not the device's
  // picker — is what the sender's due check reads. A copy that went stale is a
  // push at the 0LD hour while every screen on the device reads the new one,
  // and nothing else can see it.
  check('and the record\'s own time and zone, which decide when the push is sent',
    probedBody.time === hhmm('UTC') && probedBody.zone === 'UTC',
    JSON.stringify({ time: probedBody.time, zone: probedBody.zone }));
  check('and what that run MET, not only when it ran',
    typeof probedBody.scheduler.rejected === 'number' && typeof probedBody.scheduler.pruned === 'number'
      && typeof probedBody.scheduler.warming === 'number',
    JSON.stringify(probedBody.scheduler));
  check('and it says when this device was last actually pushed to',
    typeof probedBody.lastFiredAt === 'string', JSON.stringify(probedBody));
  check('and a probe still delivers NOTHING while answering', received.length === 1, String(received.length));
  for (const k of (await store.list('push:')).map(i => i.key)) await store.del(k);
}

fakePushServer.close();
await new Promise(r => setTimeout(r, 50)); // let in-flight sockets drain
const failed = Object.entries(results).filter(([, v]) => !v);
console.log(JSON.stringify(results, null, 1));
console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(', ')}` : 'ALL REMINDER-PUSH INTEGRATION CHECKS PASSED');
process.exitCode = failed.length ? 1 : 0;
