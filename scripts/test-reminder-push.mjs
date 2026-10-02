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
const fakePushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    lastAuth = req.headers.authorization || null;
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
const { getStore } = await import('../netlify/functions/lib/store.mjs');

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
// could not be reached (no status — transient, and the next slot may deliver it).
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
// refused, so there is no status and nothing to count as refused; the record
// stays due precisely so the next slot can try again. A port that was just
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
// falls inside the 15-minute slot. A zone far ahead of UTC is what tells the two
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
    const senderSource = readFileSync(new URL('../netlify/functions/reminders-send.mjs', import.meta.url), 'utf8');
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

fakePushServer.close();
await new Promise(r => setTimeout(r, 50)); // let in-flight sockets drain
const failed = Object.entries(results).filter(([, v]) => !v);
console.log(JSON.stringify(results, null, 1));
console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(', ')}` : 'ALL REMINDER-PUSH INTEGRATION CHECKS PASSED');
process.exitCode = failed.length ? 1 : 0;
