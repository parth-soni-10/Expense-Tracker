/* ============================================================
   Client sync primitives \u2014 talk to the Netlify Function proxy.

   Every call returns a discriminated result object so the caller
   can render a precise status without guessing what went wrong:
     { ok: true,  ...payload }
     { ok: false, reason: 'auth' | 'network' | 'empty' | 'not_configured' | 'conflict' | 'http', status?, message? }

   The proxy hides the GitHub PAT; only the password the user set
   as APP_PASSWORD is sent in the X-Cents-Password header.
   ============================================================ */

import { getSyncSettings, patchSyncSettings, isValidEndpoint } from './settings.js';

const TIMEOUT_MS = 12000;

const HINT_BY_STATUS = {
  400: ' - bad request, check endpoint',
  404: ' - endpoint not found, check URL',
  500: ' - server error, check Netlify env vars (GITHUB_TOKEN, REPO_OWNER, REPO_NAME, APP_PASSWORD)',
  502: ' - gateway error, function crashed - check Netlify function logs & env vars',
  503: ' - function unavailable, may be cold-starting - retry',
};

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function authedFetch(init = {}) {
  const s = getSyncSettings();
  if (!s.endpoint || !s.password) {
    return { ok: false, reason: 'not_configured' };
  }
  const headers = new Headers(init.headers || {});
  headers.set('X-Cents-Password', s.password);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let resp;
  try {
    resp = await withTimeout(fetch(s.endpoint, { ...init, headers, cache: 'no-store' }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  if (resp.status === 401) {
    let serverErr = '';
    try { serverErr = (await resp.json()).error || ''; } catch {}
    patchSyncSettings({ lastError: serverErr || 'auth failed', lastErrorAt: new Date().toISOString() });
    return { ok: false, reason: 'auth', status: 401, message: serverErr ? `${serverErr} - check Netlify env APP_PASSWORD` : 'auth failed - check Netlify env APP_PASSWORD' };
  }
  return { ok: true, resp };
}

/** GET the cloud file. Returns content + sha + lastModifiedAt, or { content: null } if no file yet. */
export async function syncPull() {
  const r = await authedFetch({ method: 'GET' });
  if (!r.ok) return r;
  let body;
  try { body = await r.resp.json(); }
  catch { return { ok: false, reason: 'http', message: 'invalid JSON from proxy' }; }
  if (body?.error) return { ok: false, reason: 'http', message: body.error };
  if (body?.malformed) return { ok: false, reason: 'http', message: 'malformed cloud data' };
  return {
    ok: true,
    content: body.content,
    sha: body.sha,
    branch: body.branch,
    lastModifiedAt: body.lastModifiedAt || null,
    commitSha: body.commitSha || null,
  };
}

/** PUT the cloud file. Provide the latest known sha if you have it; omit for first push. */
export async function syncPush(content, { sha = null, message = 'cents: update expenses' } = {}) {
  const r = await authedFetch({
    method: 'PUT',
    body: JSON.stringify({ content, sha, message }),
  });
  if (!r.ok) return r;
  let body;
  try { body = await r.resp.json(); }
  catch { return { ok: false, reason: 'http', message: 'invalid JSON from proxy' }; }
  if (body?.error) return { ok: false, reason: 'http', message: body.error };
  if (body?.conflict) {
    return { ok: false, reason: 'conflict' };
  }
  return { ok: true, sha: body.sha, commit: body.commit, branch: body.branch };
}

/** Used by the Settings modal "Test connection" button \u2014 hits GET on a non-existent to validate auth. */
export async function syncTestConnection(endpoint, password) {
  const candidateEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!candidateEndpoint || !isValidEndpoint(candidateEndpoint) || !password) return { ok: false, reason: 'invalid_endpoint' };
  let resp;
  try {
    resp = await withTimeout(fetch(candidateEndpoint, {
      method: 'GET',
      headers: { 'X-Cents-Password': password },
      cache: 'no-store',
    }), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message || 'fetch failed' };
  }
  if (resp.status === 401) {
    let serverErr = '';
    try { serverErr = (await resp.json()).error || ''; } catch {}
    return { ok: false, reason: 'auth', status: 401, message: serverErr ? `${serverErr} - check Netlify env APP_PASSWORD` : 'auth failed - check Netlify env APP_PASSWORD' };
  }
  if (!resp.ok) {
    let msg = '';
    try { msg = (await resp.json()).error || ''; } catch {}
    const hint = HINT_BY_STATUS[resp.status]
      || (resp.status >= 500 ? ' - server error, check Netlify function logs' : '')
      || (resp.status >= 400 ? ' - check endpoint URL' : '');
    return { ok: false, reason: 'http', status: resp.status, message: msg || 'HTTP ' + resp.status + hint };
  }
  return { ok: true };
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
