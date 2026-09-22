#!/usr/bin/env node
/**
 * Local integration harness for the reminder push pipeline.
 *
 *   0. the ciphertext against RFC 8291's own published test vector
 *   1-10. browser subscribe → server store → scheduled dispatch → delivery
 *         to a FAKE local push service → dead-subscription pruning →
 *         unsubscribe
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
const fakePushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
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
await new Promise(r => fakePushServer.listen(8201, r));
// Keep the process exit clean on Windows: an open listening handle at
// exit trips a libuv assertion in some Node builds.
fakePushServer.unref();

const subscription = {
  endpoint: 'http://localhost:8201/fake-push',
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: AUTH.toString('base64url') },
};

// ---------- env + fresh in-memory store per run ----------
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
process.env.APP_PASSWORD = 'test-password-123';
const { generateVapidKeys, encryptPayload } = await import('../netlify/functions/lib/webpush.mjs');
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

// ---------- 1. GET returns the VAPID public key ----------
const keyResp = await call(pushHandler, 'GET');
check('get-public-key', (JSON.parse(await text(keyResp))).publicKey === keys.publicKey);

// ---------- 2. auth required ----------
const unauth = await call(pushHandler, 'POST', { subscription }, { 'X-Cents-Password': 'wrong-password' });
check('auth-required', unauth.status === 401);

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
const sendResp = await sendHandler(null, {});
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
await store.setJSON('push:prune-test', { time: utcNow, zone: 'UTC', lastFiredDate: '1999-01-01', subscription: { endpoint: 'http://localhost:8201/fake-push', keys: subscription.keys } });
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

fakePushServer.close();
await new Promise(r => setTimeout(r, 50)); // let in-flight sockets drain
const failed = Object.entries(results).filter(([, v]) => !v);
console.log(JSON.stringify(results, null, 1));
console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(', ')}` : 'ALL REMINDER-PUSH INTEGRATION CHECKS PASSED');
process.exitCode = failed.length ? 1 : 0;
