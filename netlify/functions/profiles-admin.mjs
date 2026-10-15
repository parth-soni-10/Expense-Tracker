/* ============================================================
   Function — profile administration, for the OWNER only (served from
   /api/profiles-admin by functions/_router.js, and under its pre-rename
   /.netlify/functions/profiles-admin spelling for a device that stored it).

   The owner shares one deployed site with friends; each friend signs
   in on their own phone with their own account. Two things the owner
   needs for that, neither of which the regular sync path can do:

   POST { action: 'invite', profile: '<id>', enabledTabs: [...] }
     → mints a setup token for THAT account, embedding its own
       password. The owner never needs to know that password (it sits
       as a secret on the Worker, APP_PASSWORD_<ID>) and never has to sign in
       as them: they send the link, the friend's phone adopts the
       account and keeps the only working copy. The account's current
       tab policy rides inside the token, so what the owner set before
       sending is what the friend's app applies on arrival.

   POST { action: 'policy', profile: '<id>', enabledTabs: [...] }
     → writes that account's tab policy into its cloud file, for an
       account that is already syncing from another device. Only
       settings.enabledTabs is touched: this endpoint cannot read or
       write anyone's entries, deliberately — an owner who holds the
       site password gains no sight of what their friends spend.

   Auth: the caller must present the DEFAULT profile's password
   (APP_PASSWORD) — that is the owner's credential. A friend's own
   password is refused here, and the owner's password is refused on
   the regular sync path for a profile that is not theirs. Same
   constant-time compare, failure sleep and per-IP throttle as the
   other functions.

   Env vars: CENTS_SECRET (or GITHUB_TOKEN), plus REPO_OWNER/REPO_NAME/
   REPO_BRANCH/REPO_FILE and APP_PASSWORD, plus APP_PASSWORD_<ID> for
   each account being invited (the refusal names the exact variable to
   set). The root secret is what encrypts the invite links, so it is the
   only one of these that has to stay the same from one deploy to the
   next — see lib/secret.mjs.
   ============================================================ */

import { safeEqual, createFailureThrottle } from './lib/auth.mjs';
import { isProfileId, passwordEnvName, DEFAULT_PROFILE, profileAuthMessage } from './lib/profiles.mjs';
import { issueSetupToken, SETUP_TOKEN_TTL_MS, cleanTabs } from './lib/tokens.mjs';
import { ghConfig } from './lib/gh.mjs';
import { rootSecret } from './lib/secret.mjs';
import { readCloudDoc, writeCloudDoc, CloudError } from './lib/cloud.mjs';

const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
  if (origin) { cors['Access-Control-Allow-Origin'] = origin; cors['Vary'] = 'Origin'; }
  return cors;
}

const ok = (body, status = 200, cors = {}) => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...cors } },
);
const err = (msg, status = 400, cors = {}) => ok({ error: msg, code: status }, status, cors);

export default async (request, _context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);
  if (request.method !== 'POST') return err('Method not allowed', 405, cors);

  // Owner-only, and deliberately resolved from APP_PASSWORD rather than the
  // request's X-Cents-Profile header: the header names whose file a request
  // touches, but administration is the owner's business no matter which
  // account their browser happens to have open.
  const ownerPassword = process.env.APP_PASSWORD;
  if (!ownerPassword) return err(`No password configured for the owner profile - set ${passwordEnvName(DEFAULT_PROFILE)} as a secret on the Worker (>= 8 characters)`, 500, cors);
  if (ownerPassword.length < 8) return err('APP_PASSWORD must be at least 8 characters', 500, cors);

  const throttle = failureThrottle.check(request);
  if (!throttle.ok) {
    return new Response(JSON.stringify({ error: 'Too many failed attempts - retry later', code: 429 }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(throttle.retryAfterSeconds), ...cors } });
  }
  const presented = request.headers.get('x-cents-password') || '';
  if (!safeEqual(presented, ownerPassword)) {
    throttle.record();
    await new Promise(r => setTimeout(r, 500)); // slow brute force
    return err('Bad app password', 401, cors);
  }

  let body;
  try { body = JSON.parse(await request.text() || '{}'); }
  catch { return err('Body is not valid JSON', 400, cors); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err('Body must be an object', 400, cors);

  const action = body.action;
  const target = typeof body.profile === 'string' ? body.profile.trim() : '';
  if (!isProfileId(target)) return err('Body.profile must be a profile id (lowercase letters, digits, dashes)', 400, cors);
  const tabs = cleanTabs(body.enabledTabs);

  const root = rootSecret();
  if (!root.ok) return err(root.error, 500, cors);
  const secret = root.secret;

  // The target account's own credential. No fallback to APP_PASSWORD: an
  // account without its own variable cannot sync, so it cannot be invited.
  const envName = passwordEnvName(target);
  const targetPassword = process.env[envName];
  if (!targetPassword) return err(profileAuthMessage({ id: target, envName, problem: 'missing' }), 500, cors);
  if (targetPassword.length < 8) return err(profileAuthMessage({ id: target, envName, problem: 'too-short' }), 500, cors);

  try {
    if (action === 'invite') {
      return ok({
        token: issueSetupToken(secret, targetPassword, target, Date.now(), tabs),
        profile: target,
        expiresInDays: Math.round(SETUP_TOKEN_TTL_MS / (24 * 60 * 60 * 1000)),
        tabs: tabs || null,
      }, 200, cors);
    }

    if (action === 'policy') {
      if (!tabs) return err('Body.enabledTabs must be a non-empty array of tab names', 400, cors);
      return await applyPolicy({ target, tabs, cors });
    }

    return err('Body.action must be "invite" or "policy"', 400, cors);
  } catch (e) {
    // An unreachable store is a real, reportable failure with its own status;
    // anything else is an internal fault we log rather than describe.
    if (e instanceof CloudError) return err(e.message, e.status || 502, cors);
    console.error('cents profiles-admin: unexpected error', e?.message || e);
    return err('Unexpected error', 500, cors);
  }
};

/** Merge a tab policy into an account's cloud document, preserving everything
 *  else. Retries once on a version conflict, since a conflict here just means
 *  the account pushed in between. */
async function applyPolicy({ target, tabs, cors }) {
  const config = ghConfig();
  if (!config.owner || !config.repo) return err('REPO_OWNER / REPO_NAME env vars not set on the function', 500, cors);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const doc = await readCloudDoc(target, config);
    if (!doc.exists) {
      // Nothing synced yet: there is no document to carry a policy. The owner's
      // next invite carries it instead, which is why this is not an error.
      return ok({ ok: true, profile: target, pending: true }, 200, cors);
    }
    if (!doc.content || typeof doc.content !== 'object' || Array.isArray(doc.content)) {
      return err('That account\'s cloud copy is not readable JSON', 409, cors);
    }

    const settings = doc.content.settings;
    const next = {
      ...doc.content,
      settings: { ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}), enabledTabs: tabs },
      // Stamped like a local edit, so the receiving device keeps this policy
      // rather than treating its own older copy as the newer side.
      lastLocalChangeAt: new Date().toISOString(),
    };

    const write = await writeCloudDoc(target, config, {
      content: next,
      expectedVersion: doc.version,
      message: `cents: tab policy for ${target}`,
    });
    if (write.conflict) continue; // the account pushed in between - re-read and retry
    if (write.error) return err(write.error, 502, cors);
    return ok({ ok: true, profile: target, applied: true, tabs }, 200, cors);
  }
  return err('That account synced while the policy was being written - try again', 409, cors);
}
