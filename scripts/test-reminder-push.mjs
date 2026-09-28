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
 *   12. the dispatcher reads the record's own clock, not UTC's
 *   13. the key the browser is handed is the key the dispatcher signs with
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

// ---------- fake push service (decrypts like a real one) ----------
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const AUTH = crypto.randomBytes(16);
let received = [];
let endpointAlive = true;
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
    if (!endpointAlive) { res.writeHead(410); res.end(); return; }
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
const check = (name, pass) => { results[name] = !!pass; if (!pass) console.log(`  ✗ ${name}`); };

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
const droppedZero = Buffer.alloc(31, 7).toString('base64url'); // 42 chars: the shape a dropped zero byte produces
const droppedZeroSign = await pushSend(subscription, { title: 'cents. — test reminder', body: 'key padding' }, {
  subject: 'mailto:test@example.com', publicKey: keys.publicKey, privateKey: droppedZero,
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

fakePushServer.close();
await new Promise(r => setTimeout(r, 50)); // let in-flight sockets drain
const failed = Object.entries(results).filter(([, v]) => !v);
console.log(JSON.stringify(results, null, 1));
console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(', ')}` : 'ALL REMINDER-PUSH INTEGRATION CHECKS PASSED');
process.exitCode = failed.length ? 1 : 0;
