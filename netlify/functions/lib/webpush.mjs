/* ============================================================
   lib/webpush.mjs — minimal Web Push (RFC 8030 + 8291 + VAPID
   RFC 8292) on plain node:crypto. Zero npm dependencies, matching
   this repo's no-build, no-node_modules deploy model.

   Supports the `aes128gcm` content encoding only (aesgcm is
   legacy; every browser push service shipping today accepts
   aes128gcm). Keys are the P-256 curves both sides already
   negotiate for the subscription itself.

   Exports:
     generateVapidKeys() -> { publicKey, privateKey } (base64url)
     pushSend(sub, payload, vapid) -> { ok } | { ok:false, gone }
       gone=true means the subscription is dead (404/410 or
       malformed keys) and the caller should delete it.
     vapidSeed(privateKey) -> Buffer
       The one place that decides whether key material is a
       usable P-256 seed — read the note on it before tightening
       the length check.
     encryptPayload(sub, payloadUtf8, deterministic)
       Exported for the RFC 8291 test-vector check in
       scripts/test-reminder-push.mjs. Production only ever goes
       through pushSend, which passes no `deterministic`, so the
       ephemeral key and salt are random per message.
     vapidConfig(env?) -> { ok, subject, publicKey, privateKey, source }
       The signing pair every function uses, resolved in one place.
       The explicitly configured pair wins when it is really a pair;
       otherwise the pair is derived from a server-only secret the
       deploy already has. Read the note on it before changing the
       precedence or the secret list — the pair is the one piece of
       configuration whose absence is invisible from inside this repo.
   ============================================================ */

import { createECDH, createCipheriv, createHmac, createPrivateKey, createSign, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// P-256: the private key is one scalar of at most 32 bytes.
const SEED_BYTES = 32;

/**
 * A 32-byte P-256 private key, from either raw bytes or its base64url form.
 *
 * The short form is ACCEPTED, not rejected, and that is the whole point of
 * this function existing. Node's ECDH.getPrivateKey() does not left-pad a
 * scalar, so a key whose leading byte is zero comes back one byte short — 84
 * of 20,000 generated keys, measured — and the base64url of that is 42
 * characters instead of 43. Left-padding with a zero restores exactly the
 * same number (a dropped leading zero byte never carried information), so a
 * key in that shape is a valid key, not a corrupt one.
 *
 * Getting this wrong is not a small bug: generateVapidKeys() writes keys
 * through here, so a strict length check means this module refuses to sign
 * with a key this module itself just produced. That shipped, and it cost a
 * deploy: the push guard draws a fresh key pair on every run, one run drew a
 * key of this shape, and the build died inside the scheduled dispatcher with
 * "bad VAPID private key length" — an error naming nothing that pointed at the
 * generator. An operator who pastes such a key into VAPID_PRIVATE_KEY hits the
 * same wall, at send time, on every reminder.
 *
 * Anything longer than a seed is still refused loudly: the usual way to get
 * one is pasting VAPID_PUBLIC_KEY (65 bytes) into the private variable, and
 * silently truncating that would sign with a number nobody chose.
 */
export function vapidSeed(key) {
  const seed = Buffer.isBuffer(key)
    ? key
    : (typeof key === 'string' && key.length ? Buffer.from(key, 'base64url') : null);
  if (!seed) throw new Error('VAPID_PRIVATE_KEY is not set');
  if (seed.length > SEED_BYTES) {
    throw new Error(`bad VAPID private key length: ${seed.length} bytes, but a P-256 private key is a ${SEED_BYTES}-byte base64url seed (is VAPID_PUBLIC_KEY in the private variable?)`);
  }
  return seed.length === SEED_BYTES ? seed : Buffer.concat([Buffer.alloc(SEED_BYTES - seed.length), seed]);
}

function endpointAudience(endpoint) {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** VAPID JWT (ES256) authorization header value for one push endpoint. */
function vapidAuthorization({ audience, subject, publicKey, privateKey, expirySeconds = 12 * 3600 }) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: now + expirySeconds,
    sub: subject.startsWith('mailto:') ? subject : `mailto:${subject}`,
  }));
  const signingInput = `${header}.${claims}`;
  // ES256 = ECDSA P-256/SHA-256; node emits DER, Web Push wants raw r||s.
  // JWK private EC keys require the public coordinates too, so derive the
  // point from the 32-byte seed first.
  const seed = vapidSeed(privateKey);
  const derive = createECDH('prime256v1');
  derive.setPrivateKey(seed);
  const point = derive.getPublicKey(); // 0x04 || X(32) || Y(32)
  const key = createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256', d: privateKey,
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const der = createSign('SHA256').update(signingInput).sign(key);
  const rLen = der[3];
  const r = der.subarray(4, 4 + rLen);
  const sLen = der[5 + rLen];
  const s = der.subarray(6 + rLen, 6 + rLen + sLen);
  // JWS wants the signature as the FIXED-WIDTH pair r || s — 32 bytes each
  // (RFC 7518 section 3.4) — and node hands back DER instead. DER's INTEGER
  // encoding is minimal: it drops a leading zero byte from a value that does
  // not need one, and ADDS a zero sign byte to a value whose top bit is set,
  // so each integer comes back 31, 32 or 33 bytes long. Copying DER's own
  // bytes through is therefore a malformed signature most of the time —
  // measured at 74% of signings (of 400: 199 came back 65 bytes, 95 came back
  // 66, one was 64 with its two halves still the wrong ones) — and a push
  // service rejects a JWT whose signature is not the fixed-width pair, with no
  // notification on the phone for a message this repo reported as sent. Each
  // integer is the same number as its LAST 32 bytes either way.
  const fixed = (int) => {
    const bytes = int.length > 32 ? int.subarray(int.length - 32) : int;
    return bytes.length === 32 ? bytes : Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
  };
  const raw = Buffer.concat([fixed(r), fixed(s)]);
  return `vapid t=${signingInput}.${raw.toString('base64url')}, k=${publicKey}`;
}

function hkdfSha256(salt, ikm, info, length) {
  // RFC 5869 extract + expand with HMAC-SHA256.
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const chunks = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(chunks).length < length; i += 1) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest();
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

/** RFC 8291 aes128gcm encryption of `payloadUtf8` for one subscription.
 *  `deterministic` ({ asPrivate, salt }, both base64url) pins the ephemeral
 *  key pair and the salt so the RFC's published test vector can be
 *  reproduced; omit it and both are random per message. */
export function encryptPayload({ p256dh, auth }, payloadUtf8, deterministic = null) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) {
    throw new Error('bad subscription keys');
  }

  const ecdh = createECDH('prime256v1');
  if (deterministic?.asPrivate) ecdh.setPrivateKey(Buffer.from(deterministic.asPrivate, 'base64url'));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // ecdh_secret -> IKM (HKDF with the auth secret as salt).
  const prkInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdfSha256(authSecret, ecdhSecret, prkInfo, 32);

  // IKM -> CEK (16 bytes) + NONCE (12 bytes). RFC 8291 section 3.4: the HKDF
  // salt for this step is the random salt that rides in the content-coding
  // header, and the nonce is expanded under its own info string. Both are
  // load-bearing for interop — derive them under an empty salt, or expand the
  // nonce under the cek_info, and the body authenticates against keys no
  // browser computes. Nothing reports an error: the push service accepts the
  // POST, the browser drops the message, and the reminder silently never
  // arrives. (scripts/test-reminder-push.mjs pins this against the RFC's own
  // vector, so the failure can't come back.)
  const salt = deterministic?.salt ? Buffer.from(deterministic.salt, 'base64url') : randomBytes(16);
  const cek = hkdfSha256(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfSha256(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Single record: payload || 0x02 delimiter (final-record flag).
  const record = Buffer.concat([Buffer.from(payloadUtf8, 'utf8'), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | asPublic(65)
  const header = Buffer.alloc(21);
  salt.copy(header, 0);                     // salt — the one the CEK/nonce used
  header.writeUInt32BE(4096, 16);           // rs
  header.writeUInt8(65, 20);                // idlen
  return Buffer.concat([header, asPublic, ciphertext]);
}

/* ---------- which pair the site signs with ---------- */

// P-256's group order: a private scalar must fall in [1, n-1]. A uniformly
// random 256-bit value is essentially always below it, and the retry loop in
// deriveVapidPair is what makes "essentially" exact rather than a bet.
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
// Both labels are part of the derivation, so changing either one changes every
// derived key — i.e. re-binds every existing subscription. Hence the version.
const VAPID_DERIVE_INFO = 'cents/vapid/derive/v1';
const VAPID_DERIVE_SALT = 'cents/vapid/keys/v1';
// Only a server-only, high-entropy secret may be key material, and
// APP_PASSWORD is deliberately NOT in this list even though every deploy has
// one: it is eight-ish characters a human chose and the user can read it,
// while this file is public — the password would be the only unknown, so
// anyone holding the public key could brute-force the private half offline.
//
// CENTS_SECRET comes first so the deployment's own root secret is the key
// material, and GITHUB_TOKEN stays behind it: a deployment configured the old
// way derives exactly the pair it derived before (no subscription re-bound by
// this change), while one configured the new way stops having a code host in the
// middle of its push keys. See lib/secret.mjs.
const VAPID_DERIVE_SECRETS = ['CENTS_SECRET', 'GITHUB_TOKEN'];
const MIN_SECRET_LENGTH = 16;

/** A P-256 seed and its public point, derived from one secret. */
function deriveVapidPair(secret) {
  const ikm = Buffer.from(String(secret), 'utf8');
  for (let counter = 0; counter < 255; counter += 1) {
    const info = Buffer.concat([Buffer.from(VAPID_DERIVE_INFO, 'utf8'), Buffer.from([counter])]);
    const seed = hkdfSha256(Buffer.from(VAPID_DERIVE_SALT, 'utf8'), ikm, info, SEED_BYTES);
    const scalar = BigInt(`0x${seed.toString('hex')}`);
    if (scalar > 0n && scalar < P256_ORDER) {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(seed);
      return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(seed) };
    }
  }
  return null;
}

/** True when these two strings really are one P-256 key pair. */
function pairIsValid(publicKey, privateKey) {
  try {
    const point = Buffer.from(publicKey, 'base64url');
    // 65 bytes, 0x04 — the raw uncompressed point a browser takes as
    // applicationServerKey. Anything else is refused before it is served.
    if (point.length !== 65 || point[0] !== 4) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(vapidSeed(privateKey)); // throws on anything but a seed
    return ecdh.getPublicKey().equals(point);
  } catch {
    return false;
  }
}

/**
 * The VAPID pair and contact the functions sign with, resolved once.
 *
 * The explicit pair (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY) is what the README
 * tells an operator to set, and it wins — but only after it is CHECKED, which
 * is the whole point of this function existing rather than three lines of
 * `process.env` in each handler.
 *
 * A pair that is present but wrong is worse than no pair at all. This endpoint
 * is unauthenticated by design (a browser needs the key before it can
 * subscribe), so whatever sits in VAPID_PUBLIC_KEY is served to anyone who
 * asks. The mistake the two names invite is pasting them swapped, which is not
 * hypothetical: it happened on this project's own deploy, and the seed was
 * then served in the 200 body as if it were a public key — burned, because it
 * can sign pushes as the site, and no browser would accept it as a subscribe
 * key either (32 bytes is not a point), so push was broken in both directions
 * at once and the app could only report a generic failure.
 *
 * So: the configured pair is used only when the public half is a real point
 * and the private half derives it. Otherwise it is ignored, loudly, and the
 * pair is DERIVED from a secret the deploy already has — which is what makes
 * the endpoint self-configuring, and what lets an operator retire a bad pair
 * by deleting it rather than by pasting new values.
 *
 * Both halves of the pipeline resolve through here, and that is load-bearing:
 * the endpoint that hands out the public key and the scheduled sender that
 * signs with the private one must agree, or browsers bind subscriptions to a
 * key nothing ever signs with and the reminder silently never arrives.
 */
export function vapidConfig(env = process.env) {
  const subject = env.VAPID_SUBJECT || 'cents@example.com';
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;

  if (publicKey && privateKey) {
    if (pairIsValid(publicKey, privateKey)) {
      return { ok: true, subject, publicKey, privateKey, source: 'env' };
    }
    console.warn('cents: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are set but are not a usable P-256 pair (swapped values?) - ignoring them and deriving a pair instead');
  } else if (publicKey || privateKey) {
    console.warn('cents: only one of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is set - deriving a pair instead');
  }

  for (const name of VAPID_DERIVE_SECRETS) {
    const secret = env[name];
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue;
    const pair = deriveVapidPair(secret);
    if (pair) {
      console.log(`cents: VAPID keys derived from ${name}`);
      return { ok: true, subject, ...pair, source: `derived:${name}` };
    }
  }

  return {
    ok: false,
    error: 'no push key material: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY '
      + `(a matching P-256 pair) in the site env vars, or make ${VAPID_DERIVE_SECRETS.join(' / ')} available to this function so the pair can be derived from it`,
  };
}

export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // Public key: raw uncompressed point (65 bytes) — exactly the form
  // browsers take as applicationServerKey. Private: the seed, padded to its
  // full 32 bytes (see vapidSeed) — unpadded, this function would hand out a
  // 42-character key that the signing code below it refuses.
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(vapidSeed(ecdh.getPrivateKey())) };
}

export async function pushSend(subscription, payloadObject, vapid) {
  // Callers pass the browser's subscription shape ({ endpoint, keys:
  // { p256dh, auth } }); accept a flat { p256dh, auth } too.
  const keys = subscription && subscription.keys ? subscription.keys : subscription;
  const audience = endpointAudience(subscription && subscription.endpoint);
  if (!audience) return { ok: false, gone: true };
  let body;
  try {
    body = encryptPayload(keys, JSON.stringify(payloadObject));
  } catch {
    return { ok: false, gone: true }; // malformed keys — prune
  }
  const headers = {
    // A reminder is only useful NEAR its hour, and these two headers are what
    // decide when a phone that was idle at that hour finally shows it:
    //   * Urgency 'high' — with the old 'normal', Android's doze/battery
    //     saver deferred the message to the next maintenance window: measured
    //     as a daily reminder arriving HOURS after the time it was set to,
    //     at whatever moment the phone next woke. High urgency is delivered
    //     promptly through doze; one notification a day is exactly what high
    //     priority is not an abuse of.
    //   * TTL 1 hour (was 4) — the bound on lateness for a device that is
    //     genuinely unreachable. A "time to upload your transactions" four
    //     hours late is a surprise, not a reminder; past an hour the day's
    //     nudge has nothing left to say. The wake path still covers a day
    //     whose push expired.
    TTL: '3600',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Urgency: 'high',
    Authorization: vapidAuthorization({ audience, ...vapid }),
  };
  try {
    const resp = await fetch(subscription.endpoint, { method: 'POST', headers, body });
    if (resp.ok) return { ok: true };
    if (resp.status === 404 || resp.status === 410) return { ok: false, gone: true };
    return { ok: false, gone: false, status: resp.status };
  } catch {
    return { ok: false, gone: false };
  }
}

/* ---------- a subscription too new for "gone" to mean dead ----------

   A push service does not know a registration the moment subscribe() resolves.
   Measured against real FCM, one first-ever subscription per browser: a push
   sent 0.01 s and 0.51 s after subscribe() came back 404/410, and the same push
   at 1 s — and at every longer delay — was accepted. Chrome hands out the
   endpoint locally and registers it a moment later.

   404/410 is the app's own "this device is dead, drop it" signal, so taken at
   face value the one thing this project wants to work — press Enable push,
   then Send test push straight away — deleted the stored subscription and told
   the user to re-enable push, for a device that was perfectly healthy. My own
   live run opened with exactly that: the daily sender's first attempt at a
   second-old record answered 404, pruned it, and the next run had nothing to
   send to.

   So which verdict is which is decided by AGE. A gone on a record younger than
   the warm-up is not a death: ask once more after the measured window has
   passed, and if it is still unknown, say so — `warming`, with NO `gone` key,
   because callers delete the record on that key. An established subscription
   keeps the old meaning, so a browser that really did unsubscribe is still
   pruned on the next run.

   Two details that are load-bearing: a record with no readable createdAt is
   NOT warm (an unreadable stamp must not make every push immortal, and it is
   also how a hand-written record in the test suite reaches the prune path),
   and the retry is injectable so the suite can exercise both attempts without
   sleeping.
*/
export const PUSH_WARMUP_MS = 30 * 1000;
export const PUSH_WARMUP_RETRY_MS = 2 * 1000;

/** True when this record is too young for a push service's "gone" to be believed. */
export function subscriptionWarmingUp(createdAt, now = Date.now(), warmupMs = PUSH_WARMUP_MS) {
  const born = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(born)) return false;
  const age = now - born;
  return age >= 0 && age < warmupMs;
}

/**
 * pushSend for a stored record: a `gone` verdict on a subscription that is
 * still warming up is retried once, and reported as `{ ok: false, warming:
 * true }` (never `gone`) if the service still does not know it.
 */
export async function pushSendWarming(subscription, payloadObject, vapid, options = {}) {
  const {
    createdAt = null,
    warmupMs = PUSH_WARMUP_MS,
    retryMs = PUSH_WARMUP_RETRY_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  const first = await pushSend(subscription, payloadObject, vapid);
  if (first.ok || !first.gone) return first;
  if (!subscriptionWarmingUp(createdAt, Date.now(), warmupMs)) return first;
  await sleep(retryMs);
  const second = await pushSend(subscription, payloadObject, vapid);
  if (second.ok || !second.gone) return second;
  return { ok: false, warming: true };
}
