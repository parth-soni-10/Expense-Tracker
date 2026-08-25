/* ============================================================
   lib/tokens.mjs — encrypted, expiring setup tokens shared by
   the Netlify functions.

   A sync setup link must never carry the APP_PASSWORD in a form
   anyone can read: the URL lands in access logs, browser history,
   and anything in between. Earlier versions signed a base64url
   payload with HMAC, but base64url is not encryption — anyone who
   saw the token could decode the password out of it. This version
   encrypts the payload with AES-256-GCM, so the token is opaque
   without the server secret; only the function (which holds
   GITHUB_TOKEN) can redeem it for the password over TLS.

   The encryption key is derived from GITHUB_TOKEN (SHA-256), which
   both functions already hold, so no new secret has to be
   provisioned. GCM provides confidentiality AND integrity: a
   tampered token fails authentication and redeems to null.

   Tokens are additionally SINGLE-USE: setup-token.mjs records the
   hash of every redeemed token in the durable store (Netlify
   Blobs) and rejects re-redemption, so a leaked link stops being
   a capability after its first use. This module is pure
   crypto/expiry — consumption tracking lives in the function.

   Format: t2.<iv-b64url>.<ciphertext-b64url>.<tag-b64url>
   plaintext = JSON { p: <password>, e: <expiry epoch ms> }
   ============================================================ */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const SETUP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_PREFIX = 't2.';
const IV_LENGTH = 12;   // 96-bit GCM nonce
const TAG_LENGTH = 16;  // GCM auth tag

function keyFromSecret(secret) {
  // SHA-256 of the PAT → 32-byte AES-256 key. Deterministic and unique
  // per deployment (GITHUB_TOKEN differs per site).
  return createHash('sha256').update(String(secret)).digest();
}

/** Mint an encrypted setup token for the given password. */
export function issueSetupToken(secret, password, now = Date.now()) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const payload = JSON.stringify({ p: String(password), e: now + SETUP_TOKEN_TTL_MS });
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_PREFIX}${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

/** Redeem a setup token.
 *  Returns { ok: true, password } when authentic and unexpired,
 *  { ok: false, expired: true } when authentic but past its expiry,
 *  { ok: false, expired: false } when invalid (tampered / wrong key /
 *  malformed). The expired/invalid distinction lets the caller tell a
 *  genuinely expired link apart from a password that merely looks like a
 *  token — only the latter may fall back to the password path. */
export function redeemSetupToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4000 || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, expired: false };
  }
  const parts = token.slice(TOKEN_PREFIX.length).split('.');
  if (parts.length !== 3) return { ok: false, expired: false };
  const [ivB64, ctB64, tagB64] = parts;
  let iv, ciphertext, tag;
  try {
    iv = Buffer.from(ivB64, 'base64url');
    ciphertext = Buffer.from(ctB64, 'base64url');
    tag = Buffer.from(tagB64, 'base64url');
  } catch {
    return { ok: false, expired: false };
  }
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH
    || ciphertext.length === 0 || ciphertext.length > 2048) {
    return { ok: false, expired: false };
  }
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return { ok: false, expired: false }; // wrong key, tampered tag, or malformed ciphertext
  }
  let payload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return { ok: false, expired: false };
  }
  if (!payload || typeof payload.p !== 'string' || !payload.p
    || typeof payload.e !== 'number' || !Number.isFinite(payload.e)) {
    return { ok: false, expired: false };
  }
  if (payload.e <= now) return { ok: false, expired: true };
  return { ok: true, password: payload.p };
}
