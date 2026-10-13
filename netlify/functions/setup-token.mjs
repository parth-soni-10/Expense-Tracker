/* ============================================================
   Function — setup-token issuance + redemption (served from
   /.netlify/functions/setup-token by worker.js, and derived from the sync
   endpoint by the app's own sync.js).

   POST with header  X-Cents-Password: <app password>
     → issues an ENCRYPTED, 30-day setup token for embedding in a
       ?centsSync= link (instead of the raw password). The payload
       is AES-256-GCM encrypted with a key derived from the
       deployment's root secret (CENTS_SECRET, or GITHUB_TOKEN for a
       deployment configured before that name existed — see
       lib/secret.mjs), so the password is unrecoverable from the
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
   read without the root secret, expire after 30 days, and are
   invalidated by first use.
   The issue path is protected by the same constant-time compare,
   failure sleep, and per-IP throttle as sync.mjs.

   Required env vars: CENTS_SECRET (or GITHUB_TOKEN), plus the
   profile's own password: APP_PASSWORD, or APP_PASSWORD_<ID>. The
   store is the deployment's durable one; it falls back to in-memory
   where no store is bound.
   ============================================================ */

import { createHash } from 'node:crypto';
import { issueSetupToken, redeemSetupToken, SETUP_TOKEN_TTL_MS } from './lib/tokens.mjs';
import { safeEqual, createFailureThrottle } from './lib/auth.mjs';
import { resolveProfileForAuth, profileAuthMessage } from './lib/profiles.mjs';
import { getStore } from './lib/store.mjs';
import { rootSecret } from './lib/secret.mjs';

// In-memory sliding-window throttle: 15 failed issue attempts per IP per 5 min.
const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password, X-Cents-Setup-Token, X-Cents-Profile',
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

  const profile = resolveProfileForAuth(request);
  if (!profile.ok) return err(profileAuthMessage(profile), 500, cors);
  const expected = profile.expected;
  const root = rootSecret();
  if (!root.ok) return err(root.error, 500, cors);
  const secret = root.secret;

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
      // Tokens can't be forged without the root secret, so a failure here
      // means junk or an expired/unknown link. Throttle + sleep to absorb the
      // noise.
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
    // The profile id rides back so a second device adopts the same id —
    // and therefore the same cloud file — instead of guessing a slug. The tab
    // policy rides with it, so an account invited by the owner arrives already
    // configured with the tabs they allowed.
    return ok({
      password: redeemed.password,
      profile: redeemed.profileId,
      ...(redeemed.tabs ? { tabs: redeemed.tabs } : {}),
    }, 200, cors);
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
      token: issueSetupToken(secret, expected, profile.id),
      expiresInDays: Math.round(SETUP_TOKEN_TTL_MS / (24 * 60 * 60 * 1000)),
    }, 200, cors);
  }
  return err('Missing X-Cents-Password or X-Cents-Setup-Token header', 400, cors);
};
