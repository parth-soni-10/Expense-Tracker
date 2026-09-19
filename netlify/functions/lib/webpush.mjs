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
   ============================================================ */

import { createECDH, createCipheriv, createHmac, createPrivateKey, createSign, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

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
  const seed = Buffer.from(privateKey, 'base64url');
  if (seed.length !== 32) throw new Error('bad VAPID private key length');
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

/** RFC 8291 aes128gcm encryption of `payloadUtf8` for one subscription. */
function encryptPayload({ p256dh, auth }, payloadUtf8) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) {
    throw new Error('bad subscription keys');
  }

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // ecdh_secret -> PRK (HKDF with the auth secret as salt).
  const prkInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const prk = hkdfSha256(authSecret, ecdhSecret, prkInfo, 32);

  // PRK -> CEK (16 bytes) + NONCE (12 bytes).
  const cekNonceInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
  const okm = hkdfSha256(Buffer.alloc(0), prk, cekNonceInfo, 16 + 12);
  const cek = okm.subarray(0, 16);
  const nonce = okm.subarray(16, 28);

  // Single record: payload || 0x02 delimiter (final-record flag).
  const record = Buffer.concat([Buffer.from(payloadUtf8, 'utf8'), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | asPublic(65)
  const header = Buffer.alloc(21);
  randomBytes(16).copy(header, 0);          // salt
  header.writeUInt32BE(4096, 16);           // rs
  header.writeUInt8(65, 20);                // idlen
  return Buffer.concat([header, asPublic, ciphertext]);
}

export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // Public key: raw uncompressed point (65 bytes) — exactly the form
  // browsers take as applicationServerKey. Private: raw 32-byte seed.
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
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
