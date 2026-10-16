/* ============================================================
   lib/tokens.mjs — encrypted, expiring setup tokens shared by
   the functions under netlify/functions/.

   A sync setup link must never carry the APP_PASSWORD in a form
   anyone can read: the URL lands in access logs, browser history,
   and anything in between. A signed base64url payload was not
   enough — base64url is not encryption, so anyone who saw the
   token could decode the password out of it. The payload is
   encrypted with AES-256-GCM instead, so the token is opaque
   without the server secret; only the function, which holds
   CENTS_SECRET (lib/secret.mjs), can redeem it for the password
   over TLS.

   GCM provides confidentiality AND integrity: a tampered token
   fails authentication and redeems to nothing.

   Tokens are additionally SINGLE-USE: setup-token.mjs records the
   hash of every redeemed token in the durable store and rejects
   re-redemption, so a leaked link stops being a capability after
   its first use. This module is pure crypto/expiry — consumption
   tracking lives in the function.

   Format: t2.<iv-b64url>.<ciphertext-b64url>.<tag-b64url>
   plaintext = JSON { p: <password>, e: <expiry epoch ms>, i: <profile id>,
                       t: <enabled tabs, optional> }

   `i` is what makes a link usable on a SECOND device holding the same
   profiles: the receiving device adopts the id (and with it the cloud file
   data-<id>.json and the APP_PASSWORD_<ID> credential) instead of asking the
   user to retype a name and hope the slug matches. Tokens minted before this
   field existed simply redeem as the default profile.

   WHY WEBCRYPTO AND NOT node:crypto (16 Oct 2026)
   ----------------------------------------------
   This module used to build its key, nonce and cipher with `node:crypto` —
   createHash, createCipheriv, getAuthTag, Buffer — the same way it had on
   the host this code moved off. On the deployed site that made ONE feature
   fail in a way nothing else could reveal: tapping Copy in Cloud sync
   answered `{"error":"Unexpected server error","code":500}` ("i am unable
   to generate a link") while every other endpoint on the same deployment
   kept working — sync itself, the profiles admin, and the password compare
   in this very function, which uses createHash and timingSafeEqual.

   What the deployment can be measured to have DONE says most of the way:
   a wrong password on that same route still answers 401 `Bad app password`
   and the 500 is _router.js's own catch, so the throw was inside
   issueSetupToken — after the compare, with the environment intact. What
   only that function does is node-only plumbing: the CIPHER half of
   node:crypto (createCipheriv/getAuthTag) and Node's Buffer codec for
   base64url. Those are exactly the parts a bundled node:crypto gets wrong:
   workerd only implemented createCipheriv/createDecipheriv on 12 Mar 2025
   and Wrangler only stopped substituting its unenv mock on 22 Mar 2025
   (4.4.0), so anything older throws `[unenv] crypto.createCipheriv is not
   implemented yet!` AT CALL TIME — invisible until a link is minted or
   redeemed, and invisible to every guard, because nothing else encrypts.

   It is pinned rather than reproduced, because it cannot be reproduced here
   any more: a current wrangler no longer mocks the cipher, and the
   older-runtime replay that was tried failed for an unrelated reason (no
   `process` global — a cause this deployment demonstrably does not have,
   since its password compare answers 401 rather than 500). So the fix
   removes that whole node-only surface rather than betting on which piece of
   it went missing, and check-worker-config fails on Buffer or a cipher
   returning, not just on the cipher.

   WebCrypto is the right substrate regardless: `crypto.subtle` and
   `crypto.getRandomValues` are native in every runtime this app targets —
   workerd, Node, a browser — and cannot be mocked out by a bundler's
   polyfill preset. The key is still SHA-256(secret) and the bytes are still
   standard AES-256-GCM, so the FORMAT is unchanged: a token minted by the
   old node:crypto build redeems here, and this module's tokens decrypt
   under the old code. Both directions are pinned in scripts/test-profiles.mjs
   ("a token minted by the old node:crypto build still redeems") — the second
   direction is what keeps a link working across the deploy that changes it.

   Note the async: WebCrypto's operations return promises, so the two
   exported functions are async and every caller awaits them.
   ============================================================ */

import { DEFAULT_PROFILE, isProfileId } from './profiles.mjs';

export const SETUP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_PREFIX = 't2.';
const IV_LENGTH = 12;   // 96-bit GCM nonce
const TAG_LENGTH = 16;  // GCM auth tag
const KEY_LENGTH = 32;  // SHA-256 of the secret → AES-256

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** base64url, over bytes, with no platform codec: atob/btoa would be one
 *  more thing a runtime has to provide, and this is twenty lines. */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 63];
  }
  return out; // unpadded: the alphabet is URL-safe and the length is derivable
}

/** Bytes from base64url, or null for anything that is not one. Strict, like
 *  the cipher's own tag check: junk in a token is a rejected token, never a
 *  silently empty buffer. */
function fromBase64url(str) {
  if (typeof str !== 'string' || str.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((str.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < str.length; i += 1) {
    const digit = B64_ALPHABET.indexOf(str[i]);
    if (digit < 0) return null;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (value >> bits) & 0xff;
      at += 1;
    }
  }
  return at === out.length ? out : out.subarray(0, at);
}

/** SHA-256 of the secret → a 32-byte AES-256 key, imported for GCM. Deterministic
 *  and unique per deployment (CENTS_SECRET differs per site). SHA-256 is the same
 *  derivation the node:crypto build used, so a secret that minted links before
 *  this change still decrypts them — the KEY BYTES are what has to match, and
 *  importKey is WebCrypto's own requirement (a CryptoKey, never raw bytes). */
async function aesKey(secret) {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(String(secret))));
  if (raw.length !== KEY_LENGTH) throw new Error('unexpected key length');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Tab routes a policy in a token may name. Bounded and shape-checked here so
 *  a token can never carry anything but tab names (the receiving device
 *  filters them again against its own list). */
const TAB_RE = /^[a-z]{1,16}$/;
export function cleanTabs(value) {
  if (!Array.isArray(value)) return null;
  const out = [...new Set(value.filter(v => typeof v === 'string' && TAB_RE.test(v)))].slice(0, 12);
  return out.length ? out : null;
}

/** Mint an encrypted setup token for the given password.
 *  `tabs` rides along so an account's tab policy reaches the device that
 *  adopts it — the owner sets it before sending the link, and the link carries
 *  it, rather than depending on the cloud file already existing. */
export async function issueSetupToken(secret, password, profileId = DEFAULT_PROFILE, now = Date.now(), tabs = null) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await aesKey(secret);
  const policy = cleanTabs(tabs);
  const payload = JSON.stringify({
    p: String(password),
    e: now + SETUP_TOKEN_TTL_MS,
    i: isProfileId(profileId) ? profileId : DEFAULT_PROFILE,
    ...(policy ? { t: policy } : {}),
  });
  // WebCrypto appends the GCM tag to the ciphertext; the token's format
  // keeps them in separate segments, so they are split here and rejoined on
  // the way back in. The bytes are standard AES-GCM either way, which is why
  // the two implementations interoperate.
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
    key,
    textEncoder.encode(payload),
  ));
  const tag = sealed.subarray(sealed.length - TAG_LENGTH);
  const ciphertext = sealed.subarray(0, sealed.length - TAG_LENGTH);
  return `${TOKEN_PREFIX}${toBase64url(iv)}.${toBase64url(ciphertext)}.${toBase64url(tag)}`;
}

/** Redeem a setup token.
 *  Returns { ok: true, password, profileId, tabs } when authentic and unexpired,
 *  { ok: false, expired: true } when authentic but past its expiry,
 *  { ok: false, expired: false } when invalid (tampered / wrong key /
 *  malformed). The expired/invalid distinction lets the caller tell a
 *  genuinely expired link apart from a password that merely looks like a
 *  token — only the latter may fall back to the password path. */
export async function redeemSetupToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4000 || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, expired: false };
  }
  const parts = token.slice(TOKEN_PREFIX.length).split('.');
  if (parts.length !== 3) return { ok: false, expired: false };
  const [ivB64, ctB64, tagB64] = parts;
  const iv = fromBase64url(ivB64);
  const ciphertext = fromBase64url(ctB64);
  const tag = fromBase64url(tagB64);
  if (!iv || !ciphertext || !tag) return { ok: false, expired: false };
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH
    || ciphertext.length === 0 || ciphertext.length > 2048) {
    return { ok: false, expired: false };
  }
  // One buffer again for the cipher: WebCrypto expects ciphertext||tag.
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.length);

  let plaintext;
  try {
    const key = await aesKey(secret);
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 }, key, sealed);
    plaintext = textDecoder.decode(opened);
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
  return {
    ok: true,
    password: payload.p,
    profileId: isProfileId(payload.i) ? payload.i : DEFAULT_PROFILE,
    tabs: cleanTabs(payload.t),
  };
}
