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
  const raw = Buffer.concat([r, s]);
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
    // TTL 4 hours: if the device is unreachable that long, the message
    // expires instead of surprising the user much later.
    TTL: '14400',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Urgency: 'normal',
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
