/* ============================================================
   Client sync primitives \u2014 talk to the sync endpoint the Worker serves.

   Every call returns a discriminated result object so the caller
   can render a precise status without guessing what went wrong:
     { ok: true,  ...payload }
     { ok: false, reason: 'auth' | 'network' | 'empty' | 'not_configured' | 'conflict' | 'rejected' | 'http', status?, message? }

   'conflict' (409/422) means the cloud moved and a pull+merge+retry helps.
   'rejected' (400/413) means the server refused THIS content - our validator
   or the platform's 6 MB request cap - so retrying the same bytes cannot
   succeed and the caller must surface it instead of looping.

   The proxy hides the GitHub PAT; only the profile's password is sent
   in the X-Cents-Password header.

   Profiles: the active profile's id rides along in the
   X-Cents-Profile header. The proxy resolves it to a per-profile
   password (APP_PASSWORD_<ID>; APP_PASSWORD for the default id) and a
   per-profile cloud file (data-<id>.json), so two profiles on one
   device never see each other's entries or balances in the cloud
   either.
   ============================================================ */

import { getSyncSettings, patchSyncSettings, isValidEndpoint, DEFAULT_SYNC_ENDPOINT } from './settings.js';
import { getActiveProfileId, profileEnvName } from './profiles.js';

const TIMEOUT_MS = 12000;

// A single sync payload is kept under 6 MB: the platform this was written
// against refused a larger body before the function ever ran, and this check is
// what turns that into a message instead of a silent failure.
// body ever runs, so an oversize payload can never be fixed by retrying. Catching
// it here also avoids pushing megabytes of doomed upload over a phone's data.
// The function's own cap stays the backstop for non-browser callers.
const MAX_PUSH_BYTES = 6 * 1024 * 1024;

/** Which failure class an HTTP status belongs to (see the header comment). */
// Every 4xx that is not a genuine conflict is 'rejected': the server refused
// this request — payload too large, invalid data, bad permissions, wrong repo —
// and none of those improve by resending the same bytes. Retrying them on a
// timer is how a permanent 403 (token without contents:write) becomes a request
// every 15 seconds. 5xx and platform errors stay transient, because they do
// recover on their own.
function reasonForStatus(status) {
  if (status === 409 || status === 422) return 'conflict';
  if (status >= 400 && status < 500) return 'rejected';
  return 'http';
}

function oversizeMessage(content) {
  const notes = Array.isArray(content?.entries) ? content.entries.filter(e => e?.audioData) : [];
  const noteMb = notes.reduce((sum, e) => sum + e.audioData.length, 0) / (1024 * 1024);
  const mb = n => n.toFixed(1);
  return `Cloud copy is too large to upload (6 MB limit). ${notes.length} audio note${notes.length === 1 ? '' : 's'} account for ${mb(noteMb)} MB - remove some to sync.`;
}

const HINT_BY_STATUS = {
  400: ' - bad request, check endpoint',
  404: ' - endpoint not found, check URL',
  500: ' - server error, check the Worker\'s env vars (GITHUB_TOKEN, REPO_OWNER, REPO_NAME, and this profile\'s app password)',
  502: ' - gateway error, the function crashed - check the Worker\'s logs & env vars',
  503: ' - function unavailable, may be cold-starting - retry',
};

/**
 * The host a sync endpoint points at, for a message the owner has to act on: a
 * device left pointing at a stale deployment is otherwise indistinguishable
 * from a wrong password, and naming the host is what tells the two apart.
 */
function endpointHost(endpoint) {
  const base = (typeof location !== 'undefined' && location.href) ? location.href : 'https://localhost';
  try { return new URL(endpoint, base).host; } catch { return ''; }
}

/**
 * What a 401 from the sync endpoint MEANS, worded once for both callers.
 *
 * It used to be written out twice, and both copies ended in "- check the
 * APP_PASSWORD secret", which sends the owner to the wrong place. The server's
 * own words ("Bad app password") are true and, on their own, useless: the
 * credential it refused is the one saved on THIS device, and the usual reason
 * it is refused is that it was saved before the secret was changed. Read as an
 * instruction, the old wording produced exactly the wrong move — the owner
 * checks and even re-sets the server secret, which is already right, and the
 * device goes on sending the old password. So the message names what was
 * refused, which profile's secret it has to match, which host refused it, and
 * the one action that fixes it.
 */
function authFailureMessage(profileId, endpoint, serverErr) {
  const id = profileId || 'personal';
  const secret = profileEnvName(id);
  const host = endpointHost(endpoint);
  const where = host ? `${secret} on ${host}` : secret;
  return `${serverErr || 'auth failed'} - the password saved on this device was refused for profile "${id}" (${where}). Re-enter it in Cloud sync.`;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function authedFetch(init = {}, endpointOverride = null) {
  const s = getSyncSettings();
  if (!s.endpoint || !s.password) {
    return { ok: false, reason: 'not_configured' };
  }
  const headers = new Headers(init.headers || {});
  headers.set('X-Cents-Password', s.password);
  headers.set('X-Cents-Profile', getActiveProfileId() || 'personal');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let resp;
  try {
    // endpointOverride is the same endpoint with a query on it — the gap
    // check's `?mirror=1`. It goes through this one function so the credential,
    // the profile header and the timeout are the same ones every other call
    // uses; a second fetch here is how one of them quietly stops being sent.
    resp = await withTimeout(fetch(endpointOverride || s.endpoint, { ...init, headers, cache: 'no-store' }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  if (resp.status === 401) {
    let serverErr = '';
    try { serverErr = (await resp.json()).error || ''; } catch {}
    // Name the credential this PROFILE uses, not the default one: a second
    // profile with the default password is refused by design.
    const message = authFailureMessage(getActiveProfileId(), s.endpoint, serverErr);
    // The stored copy is the same sentence the toast shows, so the sync screen's
    // "Last error:" line is as actionable as the failure that produced it.
    patchSyncSettings({ lastError: message, lastErrorAt: new Date().toISOString() });
    return { ok: false, reason: 'auth', status: 401, message };
  }
  return { ok: true, resp };
}

/** GET the cloud file. Returns content + sha + lastModifiedAt, or { content: null } if no file yet.
 *
 *  The result names the profile it was fetched for. A response can land after
 *  the user switched profiles, and merging one person's file into another's
 *  document is the worst thing this app could do — so the caller checks. */
export async function syncPull() {
  const profile = getActiveProfileId() || 'personal';
  const r = await authedFetch({ method: 'GET' });
  if (!r.ok) return { ...r, profile };
  let body;
  try { body = await r.resp.json(); }
  catch { return { ok: false, reason: 'http', message: 'invalid JSON from proxy' }; }
  if (body?.error) return { ok: false, reason: 'http', message: body.error };
  if (body?.malformed) return { ok: false, reason: 'http', message: 'malformed cloud data' };
  return {
    ok: true,
    profile,
    content: body.content,
    sha: body.sha,
    branch: body.branch,
    lastModifiedAt: body.lastModifiedAt || null,
    commitSha: body.commitSha || null,
    // The gap verdict the last save recorded, and whether this deployment has a
    // mirror at all. Absent on a reply from an older proxy, which reads as
    // "nothing recorded" rather than as a gap.
    mirror: body.mirror || null,
    mirrorConfigured: body.mirrorConfigured !== false,
  };
}

/** PUT the cloud file. Provide the latest known sha if you have it; omit for first push. */
export async function syncPush(content, { sha = null, message = 'cents: update expenses' } = {}) {
  const payload = JSON.stringify({ content, sha, message });
  if (new TextEncoder().encode(payload).byteLength > MAX_PUSH_BYTES) {
    return { ok: false, reason: 'rejected', message: oversizeMessage(content) };
  }
  const r = await authedFetch({ method: 'PUT', body: payload });
  if (!r.ok) return r;
  const status = r.resp.status;
  let body;
  try { body = await r.resp.json(); }
  catch { return { ok: false, reason: 'http', status, message: 'invalid JSON from proxy' }; }
  if (body?.conflict) return { ok: false, reason: 'conflict', status };
  if (body?.error) return { ok: false, reason: reasonForStatus(status), status, message: body.error };
  if (!r.resp.ok) return { ok: false, reason: reasonForStatus(status), status, message: `HTTP ${status}` };
  return { ok: true, sha: body.sha, commit: body.commit, branch: body.branch, mirror: body.mirror || null };
}

/**
 * Ask the proxy to compare the cloud record's version against the GitHub blob
 * now, and answer with the verdict alone.
 *
 * The save path already does this after every save and records the verdict with
 * the document, so this is the on-demand half: the Data screen asks when it
 * opens, because a gap that appeared a minute ago — on another device, or in a
 * save whose check never came back — should not need a fresh save to become
 * visible. The reply carries no document, so asking cannot cost a re-download of
 * the ledger.
 *
 * `reason` follows the same vocabulary as the rest of this file: 'network' when
 * the proxy could not be reached, 'auth' when the credential was refused, 'http'
 * otherwise. A caller that cannot check must say it could not, NOT that the
 * mirror is fine.
 */
export async function syncCheckMirror() {
  const profile = getActiveProfileId() || 'personal';
  const s = getSyncSettings();
  if (!s.endpoint || !s.password) return { ok: false, reason: 'not_configured', profile };
  const url = s.endpoint + (s.endpoint.includes('?') ? '&' : '?') + 'mirror=1';
  const r = await authedFetch({ method: 'GET' }, url);
  if (!r.ok) return { ...r, profile };
  let body;
  try { body = await r.resp.json(); }
  catch { return { ok: false, reason: 'http', message: 'invalid JSON from proxy', profile }; }
  if (body?.error) return { ok: false, reason: 'http', message: body.error, profile };
  // A reply without a verdict is not a verdict: reporting it as one would put
  // "in sync" on screen for a proxy that answered something else entirely.
  if (!body?.mirror || typeof body.mirror.state !== 'string') {
    return { ok: false, reason: 'http', message: 'no mirror verdict from the proxy', profile };
  }
  return { ok: true, profile, mirror: body.mirror, mirrorConfigured: body.mirrorConfigured !== false };
}

/** Used by the Settings modal "Test connection" button \u2014 hits GET on a non-existent to validate auth. */
export async function syncTestConnection(endpoint, password) {
  const candidateEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!candidateEndpoint || !isValidEndpoint(candidateEndpoint) || !password) return { ok: false, reason: 'invalid_endpoint' };
  let resp;
  try {
    resp = await withTimeout(fetch(candidateEndpoint, {
      method: 'GET',
      headers: { 'X-Cents-Password': password, 'X-Cents-Profile': getActiveProfileId() || 'personal' },
      cache: 'no-store',
    }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  if (resp.status === 401) {
    let serverErr = '';
    try { serverErr = (await resp.json()).error || ''; } catch {}
    return { ok: false, reason: 'auth', status: 401, message: authFailureMessage(getActiveProfileId(), candidateEndpoint, serverErr) };
  }
  if (!resp.ok) {
    let msg = '';
    try { msg = (await resp.json()).error || ''; } catch {}
    const hint = HINT_BY_STATUS[resp.status]
      || (resp.status >= 500 ? ' - server error, check the Worker\'s logs' : '')
      || (resp.status >= 400 ? ' - check endpoint URL' : '');
    return { ok: false, reason: 'http', status: resp.status, message: msg || 'HTTP ' + resp.status + hint };
  }
  return { ok: true };
}

/** Derive the sibling setup-token function URL from the sync endpoint.
 *  Works for the same-origin default (/api/sync → /api/setup-token) and for
 *  custom endpoints that follow the same endpoint layout — including the
 *  pre-rename name a device may still have saved, which sits in the same
 *  directory and derives the same sibling. Returns null when the endpoint has
 *  no path segment to replace. */
function setupTokenEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return null;
  const m = /^(.*\/)[^/]+$/.exec(endpoint);
  return m ? `${m[1]}setup-token` : null;
}

/** Ask the Worker to mint a signed, expiring setup token. The link
 *  that goes into the URL contains this token — never the raw password. */
export async function syncIssueSetupToken() {
  const s = getSyncSettings();
  if (!s.endpoint || !s.password) return { ok: false, reason: 'not_configured' };
  const url = setupTokenEndpoint(s.endpoint);
  if (!url) return { ok: false, reason: 'invalid_endpoint' };
  let resp;
  try {
    resp = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'X-Cents-Password': s.password, 'X-Cents-Profile': getActiveProfileId() || 'personal', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      cache: 'no-store',
    }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  if (!resp.ok) {
    let msg = '';
    try { msg = (await resp.json()).error || ''; } catch {}
    return { ok: false, reason: 'http', status: resp.status, message: msg || 'HTTP ' + resp.status };
  }
  let body;
  try { body = await resp.json(); }
  catch { return { ok: false, reason: 'http', message: 'invalid JSON from proxy' }; }
  if (!body || typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 4000) {
    return { ok: false, reason: 'http', message: 'malformed setup token response' };
  }
  return { ok: true, token: body.token, expiresInDays: body.expiresInDays || null };
}

/** Redeem a setup token for the real app password, over TLS. The endpoint
 *  used is the one the LINK pointed at (endpointOverride), because on the
 *  receiving device sync is not configured yet. */
export async function syncExchangeSetupToken(token, endpointOverride = null) {
  const s = getSyncSettings();
  const endpoint = endpointOverride || s.endpoint || DEFAULT_SYNC_ENDPOINT;
  const url = setupTokenEndpoint(endpoint);
  if (!url) return { ok: false, reason: 'invalid_endpoint' };
  let resp;
  try {
    resp = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'X-Cents-Setup-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      cache: 'no-store',
    }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  if (resp.status === 410) {
    let serverErr = '';
    try { serverErr = (await resp.json()).error || ''; } catch {}
    return { ok: false, reason: 'expired', status: 410, message: serverErr || 'setup token expired' };
  }
  if (resp.status === 401) {
    let serverErr = '';
    try { serverErr = (await resp.json()).error || ''; } catch {}
    return { ok: false, reason: 'auth', status: 401, message: serverErr || 'setup token rejected' };
  }
  if (!resp.ok) {
    let msg = '';
    try { msg = (await resp.json()).error || ''; } catch {}
    return { ok: false, reason: 'http', status: resp.status, message: msg || 'HTTP ' + resp.status };
  }
  let body;
  try { body = await resp.json(); }
  catch { return { ok: false, reason: 'http', message: 'invalid JSON from proxy' }; }
  if (!body || typeof body.password !== 'string' || !body.password) {
    return { ok: false, reason: 'http', message: 'malformed setup token response' };
  }
  return {
    ok: true,
    password: body.password,
    // Which profile this password belongs to, so the receiving device can
    // adopt the same id (and therefore the same cloud file) instead of
    // guessing a slug from a name.
    profileId: typeof body.profile === 'string' && body.profile ? body.profile : null,
    // The tab policy the link carried, applied by the adopting device.
    tabs: Array.isArray(body.tabs) ? body.tabs.filter(t => typeof t === 'string') : null,
  };
}

/** Derive the sibling profiles-admin function URL from the sync endpoint. */
function adminEndpoint(endpoint) {
  return setupTokenEndpoint(endpoint)?.replace(/\/setup-token$/, '/profiles-admin') || null;
}

/** Owner-only administration: mint an invite for one account, or write that
 *  account's tab policy into its cloud file. Both are authorised by the
 *  owner's own password — a friend's password is refused server-side, and the
 *  owner's is refused on that account's own data path. */
async function postAdmin(payload, { expectTabs = false } = {}) {
  const s = getSyncSettings();
  if (!s.endpoint || !s.password) return { ok: false, reason: 'not_configured' };
  const url = adminEndpoint(s.endpoint);
  if (!url) return { ok: false, reason: 'invalid_endpoint' };
  let resp;
  try {
    resp = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'X-Cents-Password': s.password, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  let body = null;
  try { body = await resp.json(); } catch { /* fall through to the status */ }
  if (!resp.ok) {
    return { ok: false, reason: resp.status === 401 ? 'auth' : 'http', status: resp.status, message: body?.error || `HTTP ${resp.status}` };
  }
  if (!body || body.error) return { ok: false, reason: 'http', message: body?.error || 'malformed admin response' };
  if (expectTabs && (typeof body.token !== 'string' || body.token.length < 20)) {
    return { ok: false, reason: 'http', message: 'malformed invite response' };
  }
  return { ok: true, ...body };
}

/** Mint an invite link for one account. `tabs` is the policy the link carries. */
export function syncIssueProfileInvite(profileId, tabs = null) {
  return postAdmin({ action: 'invite', profile: profileId, enabledTabs: tabs || undefined }, { expectTabs: true });
}

/** Write an account's tab policy into its cloud file (for an account that is
 *  not on this device, or whose copy here is not the one that syncs).
 *  Returns { pending: true } when that account has not synced yet — there is
 *  no document to carry the policy, and the next invite does instead. */
export function syncPushProfilePolicy(profileId, tabs) {
  return postAdmin({ action: 'policy', profile: profileId, enabledTabs: tabs });
}

/** Status string used by the header indicator. Pure function over settings. */
export function syncStatus() {
  const s = getSyncSettings();
  if (!s.enabled) return { state: 'off', label: 'Sync off' };
  if (!s.endpoint || !s.password) return { state: 'incomplete', label: 'Set a password to enable' };
  if (s.lastError) return { state: 'error', label: 'Sync error', detail: s.lastError };
  if (!s.lastSyncAt) return { state: 'ready', label: 'Ready to sync' };
  return { state: 'ok', label: `Synced ${relativeTime(s.lastSyncAt)}` };
}

/* ---------- the GitHub mirror's gap ----------
 *
 * The mirror is a second copy of the ledger in a repo, written after the store
 * that actually commits a save, and its failure is logged rather than returned —
 * a code host having a bad day must not fail somebody's save. The proxy measures
 * the consequence after every save (the record's version against the repo blob's
 * own bytes) and this is the wording for what it found. The states are
 * lib/cloud.mjs's, and `gap: true` is the one thing a caller has to act on: the
 * copy in the repo is NOT the copy the app is serving.
 */
// `detail` is the Data menu's sentence (it has room); `notice` is the same fact
// for a toast, which is on screen for a few seconds and has none.
const MIRROR_WORDS = {
  in_sync: {
    label: 'In sync',
    detail: 'The repo holds this exact version.',
    notice: 'the copy in the repo matches your cloud copy.',
  },
  behind: {
    label: 'Behind',
    detail: 'The save did not reach GitHub - the copy there is an older one. The next save retries it; your data is safe in the cloud store either way.',
    notice: 'the repo copy is older than your cloud copy. Your data is safe; the next save retries it.',
  },
  diverged: {
    label: 'Different copy',
    detail: 'GitHub holds a different version than this device - another device wrote it after this one, or it was edited by hand.',
    notice: 'the repo holds a different version than this device.',
  },
  missing: {
    label: 'Not in the repo',
    detail: 'There is no file at that path in the repo: it was deleted, or its path (REPO_FILE) changed.',
    notice: 'the file is not in the repo any more - deleted, or its path changed.',
  },
  unverifiable: {
    label: 'Not checked',
    detail: 'GitHub could not be read, so the two copies could not be compared.',
    notice: 'GitHub could not be read, so the two copies could not be compared.',
  },
  no_document: {
    label: 'Nothing saved yet',
    detail: 'There is no cloud copy to compare a repo copy against.',
    notice: 'there is no cloud copy to compare a repo copy against.',
  },
  unconfigured: {
    label: 'Off',
    detail: 'No GitHub mirror is configured for this deployment - nothing to compare, nothing missing.',
    notice: 'no GitHub mirror is configured for this deployment.',
  },
};

/** The states that mean the repo does not hold what the app is serving. */
const MIRROR_GAPS = new Set(['behind', 'diverged', 'missing', 'unverifiable']);

/**
 * The Data screen's line for the mirror, from a verdict (or nothing yet).
 *
 * `known: false` is a real answer — nothing has been checked — and is rendered
 * as such rather than as a pass, because the one thing this line must never do
 * is read as "fine" when nobody looked.
 */
export function mirrorStatus(verdict) {
  const state = verdict && typeof verdict.state === 'string' ? verdict.state : null;
  if (!state) return { state: 'unknown', known: false, gap: false, label: 'Checking\u2026', detail: '', notice: '' };
  const words = MIRROR_WORDS[state]
    || { label: 'Not checked', detail: 'The proxy answered with a state this app does not know.', notice: 'the proxy answered with a state this app does not know.' };
  const when = typeof verdict.checkedAt === 'string' && relativeTime(verdict.checkedAt)
    ? ` Checked ${relativeTime(verdict.checkedAt)}.`
    : '';
  return {
    state,
    known: true,
    gap: MIRROR_GAPS.has(state),
    label: words.label,
    detail: words.detail + when,
    notice: words.notice,
  };
}

export function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

/** Tiny pub/sub so the header indicator can re-render after sync state changes. */
const subs = new Set();
export function subscribeSync(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function notifySyncChange() {
  for (const fn of subs) { try { fn(); } catch {} }
}
