/* ============================================================
   Netlify Function — setup-token issuance + redemption.

   POST with header  X-Cents-Password: <app password>
     → issues an ENCRYPTED, 30-day setup token for embedding in a
       ?centsSync= link (instead of the raw password). The payload
       is AES-256-GCM encrypted with a key derived from
       GITHUB_TOKEN, so the password is unrecoverable from the
       token without the server secret.
   POST with header  X-Cents-Setup-Token: <token>
     → redeems the token for the app password — ONCE. Redemption
       records the token's hash in the durable store (Netlify
       Blobs) atomically, so a spent link can never be redeemed
       again (the receiving device keeps the real password and
       keeps syncing; only the LINK is single-use). An already-
       spent token returns 410, indistinguishable from expiry to
       the client, which is correct: both mean "generate a fresh
       link".

   Auth model: whoever holds an UNUSED token holds the capability —
   treat setup links like passwords. Tokens cannot be forged or
   read without GITHUB_TOKEN, expire after 30 days, and are
   invalidated by first use.
   The issue path is protected by the same constant-time compare,
   failure sleep, and per-IP throttle as sync.mjs.

   Required env vars: same as sync.mjs (GITHUB_TOKEN, APP_PASSWORD).
   Blobs need no configuration inside Netlify Functions; the store
   falls back to in-memory outside the Netlify runtime.
   ============================================================ */

import { createHash } from 'node:crypto';
import { issueSetupToken, redeemSetupToken, SETUP_TOKEN_TTL_MS } from './lib/tokens.mjs';
import { safeEqual, createFailureThrottle } from './lib/auth.mjs';
import { getStore } from './lib/store.mjs';

// In-memory sliding-window throttle: 15 failed issue attempts per IP per 5 min.
const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password, X-Cents-Setup-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

// The store holds only SHA-256 hashes of spent tokens, never token material
// and never the password. Key prefix keeps the namespace collision-free.
const SPENT_PREFIX = 'spent:';

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export default async (request, _context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);
  if (request.method !== 'POST') return err('Method not allowed', 405, cors);

  const expected = process.env.APP_PASSWORD;
  if (!expected) return err('APP_PASSWORD env var not set on the function', 500, cors);
  if (expected.length < 8) {
    return err('APP_PASSWORD must be at least 8 characters - set a stronger password in Netlify env', 500, cors);
  }
  const secret = process.env.GITHUB_TOKEN;
  if (!secret) return err('GITHUB_TOKEN env var not set on the function', 500, cors);

  const token = request.headers.get('x-cents-setup-token');
  const password = request.headers.get('x-cents-password');

  if (token) {
    // Redeem path: a valid UNUSED token proves the holder was given the link.
    // The same per-IP failure throttle guards this path (mirroring the issue
    // path) so a flood of junk/invalid token attempts can't hammer redemption.
    const throttle = failureThrottle.check(request);
    if (!throttle.ok) {
      return new Response(JSON.stringify({ error: 'Too many failed attempts - retry later', code: 429 }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(throttle.retryAfterSeconds),
            ...cors,
          },
        });
    }
    const redeemed = redeemSetupToken(secret, token);
    if (!redeemed.ok) {
      // Tokens can't be forged without GITHUB_TOKEN, so a failure here means
      // junk or an expired/unknown link. Throttle + sleep to absorb the noise.
      throttle.record();
      await new Promise(r => setTimeout(r, 500));
      // 410 (Gone) for a genuinely expired link; 401 for anything invalid.
      // The distinction lets the client avoid treating an expired real token
      // as a password-shaped secret.
      if (redeemed.expired) return err('Setup token expired - generate a new link', 410, cors);
      return err('Setup token is invalid', 401, cors);
    }
    // Consume atomically: only the first redemption of a given token wins.
    // Both a spent token and an expired one surface as 410 — the client's
    // only correct action either way is "generate a fresh link".
    const store = await getStore();
    try {
      const { modified } = await store.claimIfNew(`${SPENT_PREFIX}${tokenHash(token)}`, { at: Date.now() });
      if (!modified) {
        return err('Setup token already used - generate a new link', 410, cors);
      }
    } catch {
      // Store unavailable: fail closed rather than letting a token be
      // redeemed an unbounded number of times. The user can retry; nothing
      // has been recorded.
      return err('Could not verify setup token - try again', 503, cors);
    }
    return ok({ password: redeemed.password }, 200, cors);
  }
  if (password) {
    const throttle = failureThrottle.check(request);
    if (!throttle.ok) {
      return new Response(JSON.stringify({ error: 'Too many failed attempts - retry later', code: 429 }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(throttle.retryAfterSeconds),
            ...cors,
          },
        });
    }
    if (!safeEqual(password, expected)) {
      throttle.record();
      await new Promise(r => setTimeout(r, 500)); // slow brute force
      return err('Bad app password', 401, cors);
    }
    return ok({
      token: issueSetupToken(secret, expected),
      expiresInDays: Math.round(SETUP_TOKEN_TTL_MS / (24 * 60 * 60 * 1000)),
    }, 200, cors);
  }
  return err('Missing X-Cents-Password or X-Cents-Setup-Token header', 400, cors);
};
