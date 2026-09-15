/* ============================================================
   Netlify Function v2 — GitHub sync proxy for cents.

   Reads/writes a single JSON file in a configured GitHub repo via
   the Contents API, gated by an admin password sent via the
   X-Cents-Password header. The PAT itself lives only in this
   function's environment, never in the client bundle.

   Required env vars:
     GITHUB_TOKEN    fine-grained PAT, repo contents: read+write
     REPO_OWNER      e.g. "yourname"
     REPO_NAME       e.g. "cents-data"
     REPO_BRANCH     default "main"
     REPO_FILE       default "data.json"
     APP_PASSWORD    any string the client sends in X-Cents-Password
                     (must be at least 8 characters)

   Auth hardening:
     * APP_PASSWORD is compared in constant time.
     * Failed attempts are throttled per client IP (in-memory,
       best-effort — resets on cold start) and each failure sleeps
       500ms to slow brute force.
     * CORS reflects the request Origin (with Vary) instead of
       granting every origin — cross-origin clients still work,
       but the blanket '*' is gone.
   ============================================================ */

import { safeEqual, createFailureThrottle } from './lib/auth.mjs';

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password, X-Cents-Setup-Token',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

const GH_API = 'https://api.github.com';
// Netlify's hard cap for synchronous function request payloads is 6 MB, so
// the platform rejects anything larger regardless of this guard. 5 MB was
// too tight for a couple of 2 MB base64 audio notes; 6 MB is the real ceiling.
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_AMOUNT = 1_000_000;
const VALID_TYPES = new Set(['expense', 'credit', 'transfer', 'note']);
const VALID_METHODS = new Set(['AIB', 'Revolut', 'RS', 'TG', 'LG', 'AG', 'Cash']);
const BASE_CATEGORIES = new Set(['gro', 'travel', 'misc', 'rent', 'GC']);
const BALANCE_METHODS = ['AIB', 'Revolut', 'RS', 'TG', 'LG', 'AG'];
const VALID_COIN_KEYS = new Set(['50', '20', '10', '5', '2', '1', '0.5', '0.2', '0.1', '0.05']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// In-memory sliding-window throttle: 15 failed auth attempts per IP per 5 min.
const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function validLegacyBalanceMap(value) {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([methodId, rawBalance]) => {
    const balance = Number(rawBalance);
    return BALANCE_METHODS.includes(methodId)
      && Number.isFinite(balance)
      && Math.abs(balance) <= MAX_AMOUNT
      && Math.round(balance * 100) / 100 === balance;
  });
}

function validDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day;
}

function validCheckpoint(point) {
  const balance = Number(point?.balance);
  return !!point && typeof point === 'object' && !Array.isArray(point)
    && validDate(point.date)
    && Number.isFinite(balance)
    && Math.abs(balance) <= MAX_AMOUNT
    && Math.round(balance * 100) / 100 === balance
    && (point.at == null || (typeof point.at === 'string' && point.at.length <= 100 && Number.isFinite(Date.parse(point.at))));
}
function validMutationHistory(history, entry, allowedCategoryIds) {
  if (history == null) return true;
  if (!Array.isArray(history) || history.length > 1000) return false;
  let previousAt = 0;
  for (const point of history) {
    const at = Date.parse(point?.at);
    const createdAt = Date.parse(point?.createdAt);
    const amount = Number(point?.amount);
    if (!point || typeof point !== 'object' || Array.isArray(point)
      || typeof point.at !== 'string' || point.at.length > 100
      || typeof point.createdAt !== 'string' || point.createdAt.length > 100
      || !Number.isFinite(at) || !Number.isFinite(createdAt) || at > Date.now() || createdAt > at
      || (previousAt > 0 && at <= previousAt)
      || (entry?.createdAt != null && Date.parse(entry.createdAt) !== createdAt)
      || !validDate(point.date) || !VALID_TYPES.has(point.type)
      || !VALID_METHODS.has(point.method) || !allowedCategoryIds.has(point.category)
      || !Number.isFinite(amount) || amount < 0
      || amount > MAX_AMOUNT || Math.round(amount * 100) / 100 !== amount
      || (point.type === 'note' && amount !== 0)) return false;
    previousAt = at;
  }
  // Mutation history without an updatedAt marker is detached from the current
  // entry and cannot be applied safely by the client.
  if (history.length > 0 && (entry?.updatedAt == null || entry?.createdAt == null)) return false;
  // Every edited entry must carry the complete previous-version chain and the
  // current updatedAt must identify its latest mutation. Otherwise the client
  // cannot safely subtract the version that was present at reconciliation.
  if (entry?.updatedAt != null) {
    if (history.length === 0 || Date.parse(entry.updatedAt) !== previousAt) return false;
  }
  return true;
}

function validIncomingSettings(settings) {
  if (settings == null) return true;
  if (typeof settings !== 'object' || Array.isArray(settings)) return false;
  // Unknown settings keys are passed through rather than rejected (matching
  // the client's `...safeSettings` spread), so a future client-side settings
  // field never breaks every cloud push/pull until the server gains
  // validation for it. Device-only secrets are still always refused.
  if (Object.prototype.hasOwnProperty.call(settings, 'pinHash')) return false;
  if (settings.monthlyBudget != null
    && (!Number.isFinite(Number(settings.monthlyBudget)) || Number(settings.monthlyBudget) < 0 || Number(settings.monthlyBudget) > MAX_AMOUNT
      || Math.round(Number(settings.monthlyBudget) * 100) / 100 !== Number(settings.monthlyBudget))) return false;
  if (settings.currency != null && (typeof settings.currency !== 'string' || settings.currency.length < 1 || settings.currency.length > 8)) return false;
  if (!validLegacyBalanceMap(settings.accountOpenings) || !validLegacyBalanceMap(settings.giftCardOpenings)) return false;
  if (settings.openingBalance != null) {
    const openingBalance = Number(settings.openingBalance);
    if (!Number.isFinite(openingBalance) || Math.abs(openingBalance) > MAX_AMOUNT
      || Math.round(openingBalance * 100) / 100 !== openingBalance) return false;
  }
  if (settings.balanceCheckpoints != null) {
    if (typeof settings.balanceCheckpoints !== 'object' || Array.isArray(settings.balanceCheckpoints)) return false;
    for (const [methodId, points] of Object.entries(settings.balanceCheckpoints)) {
      if (!BALANCE_METHODS.includes(methodId) || !Array.isArray(points) || points.length > 1000 || !points.every(validCheckpoint)) return false;
      const dates = new Set(points.map(point => point.date));
      if (dates.size !== points.length) return false;
    }
  }
  const allowedCategoryIds = new Set(BASE_CATEGORIES);
  if (settings.customCategories != null) {
    if (!Array.isArray(settings.customCategories) || settings.customCategories.length > 100) return false;
    const ids = new Set();
    for (const category of settings.customCategories) {
      if (!category || typeof category !== 'object' || typeof category.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(category.id)
        || category.id.length > 80 || ids.has(category.id) || BASE_CATEGORIES.has(category.id)
        || typeof category.label !== 'string' || category.label.trim().length < 1 || category.label.length > 80) return false;
      ids.add(category.id);
      allowedCategoryIds.add(category.id);
    }
  }
  if (settings.recurring != null) {
    if (!Array.isArray(settings.recurring) || settings.recurring.length > 500) return false;
    const ids = new Set();
    for (const recurring of settings.recurring) {
      const amount = Number(recurring?.amount);
      if (!recurring || typeof recurring !== 'object' || typeof recurring.id !== 'string' || recurring.id.length === 0 || recurring.id.length > 200 || ids.has(recurring.id)
        || !['expense', 'credit'].includes(recurring.type) || !VALID_METHODS.has(recurring.method)
        || !allowedCategoryIds.has(recurring.category)
        || !validDate(recurring.nextDate) || !['weekly', 'monthly'].includes(recurring.frequency)
        || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT || Math.round(amount * 100) / 100 !== amount
        || !Number.isInteger(Number(recurring.dayOfMonth)) || Number(recurring.dayOfMonth) < 1 || Number(recurring.dayOfMonth) > 31
        || typeof recurring.details !== 'string' || recurring.details.length > 5000
        || (recurring.note != null && (typeof recurring.note !== 'string' || recurring.note.length > 10000))) return false;
      ids.add(recurring.id);
    }
  }
  if (settings.coins != null) {
    if (typeof settings.coins !== 'object' || Array.isArray(settings.coins)) return false;
    for (const [key, value] of Object.entries(settings.coins)) {
      if (!VALID_COIN_KEYS.has(key) || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > MAX_AMOUNT) return false;
    }
  }
  if (settings.tescoVouchers != null) {
    const vouchers = Number(settings.tescoVouchers);
    if (!Number.isFinite(vouchers) || vouchers < 0 || vouchers > MAX_AMOUNT
      || Math.round(vouchers * 100) / 100 !== vouchers) return false;
  }
  if (settings.categoryBudgets != null) {
    if (typeof settings.categoryBudgets !== 'object' || Array.isArray(settings.categoryBudgets)) return false;
    for (const [categoryId, value] of Object.entries(settings.categoryBudgets)) {
      if (!allowedCategoryIds.has(categoryId)) return false;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT || Math.round(amount * 100) / 100 !== amount) return false;
    }
  }
  return true;
}

function validIncomingState(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content) || !Array.isArray(content.entries)
    || !validIncomingSettings(content.settings)) return false;
  if (content.entries.length > MAX_ENTRIES) return false;
  const allowedCategoryIds = new Set([
    ...BASE_CATEGORIES,
    ...(Array.isArray(content.settings?.customCategories) ? content.settings.customCategories.map(category => category.id) : []),
  ]);
  const ids = new Set();
  const transferGroups = new Map();
  for (const entry of content.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const amount = Number(entry.amount);
    const details = entry.details == null ? '' : entry.details;
    const note = entry.note == null ? '' : entry.note;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200 || ids.has(entry.id)) return false;
    ids.add(entry.id);
    if (entry.type === 'transfer' && !entry.transferId) return false;
    if (entry.type === 'note' && amount !== 0) return false;
    if (entry.transferId) {
      if (typeof entry.transferId !== 'string' || entry.transferId.length > 200) return false;
      if (!transferGroups.has(entry.transferId)) transferGroups.set(entry.transferId, []);
      transferGroups.get(entry.transferId).push(entry);
    }
    if (!validDate(entry.date)
      || !VALID_TYPES.has(entry.type)
      || !VALID_METHODS.has(entry.method)
      || !allowedCategoryIds.has(entry.category)
      || Number.isFinite(amount) === false || amount < 0 || amount > MAX_AMOUNT
      || Math.round(amount * 100) / 100 !== amount
      || typeof details !== 'string' || details.length > 5000
      || typeof note !== 'string' || note.length > 10000
      || (entry.createdAt != null && (typeof entry.createdAt !== 'string' || entry.createdAt.length > 100
        || !Number.isFinite(Date.parse(entry.createdAt)) || Date.parse(entry.createdAt) > Date.now()))
      || (entry.updatedAt != null && (typeof entry.updatedAt !== 'string' || entry.updatedAt.length > 100
        || !Number.isFinite(Date.parse(entry.updatedAt)) || Date.parse(entry.updatedAt) > Date.now()
        || (entry.createdAt != null && Date.parse(entry.updatedAt) < Date.parse(entry.createdAt))))
      || !validMutationHistory(entry.mutationHistory, entry, allowedCategoryIds)
       || (entry.audioData != null && (entry.type !== 'note' || typeof entry.audioData !== 'string'
        || !/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(entry.audioData)
        || entry.audioData.length > 2_000_000))
      || (entry.audioType != null && (entry.type !== 'note' || typeof entry.audioType !== 'string' || !/^audio\/[a-z0-9.+-]+$/i.test(entry.audioType)))
      || (entry.settled != null && typeof entry.settled !== 'boolean')) return false;
  }
  for (const group of transferGroups.values()) {
    const debit = group.find(entry => entry.type === 'expense');
    const credit = group.find(entry => entry.type === 'credit');
    if (group.length !== 2 || !debit || !credit || debit.amount !== credit.amount
      || debit.date !== credit.date || debit.method === credit.method) return false;
  }
  return true;
}

async function ghFetch(path, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var not set on the function');
  const url = path.startsWith('http') ? path : `${GH_API}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cents-app',
      ...(opts.headers || {}),
    },
  });
}

function cfg() {
  return {
    owner:  process.env.REPO_OWNER,
    repo:   process.env.REPO_NAME,
    branch: process.env.REPO_BRANCH || 'main',
    file:   (process.env.REPO_FILE || 'data.json').replace(/^\/+/, ''),
  };
}

function decodeBase64(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}
function encodeBase64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

export default async (request, _context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);

  const expected = process.env.APP_PASSWORD;
  if (!expected) return err('APP_PASSWORD env var not set on the function', 500, cors);
  if (expected.length < 8) {
    return err('APP_PASSWORD must be at least 8 characters - set a stronger password in Netlify env', 500, cors);
  }

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
  const got = request.headers.get('x-cents-password') || '';
  if (!safeEqual(got, expected)) {
    throttle.record();
    await new Promise(r => setTimeout(r, 500)); // slow brute force
    return err('Bad app password', 401, cors);
  }

  const { owner, repo, branch, file } = cfg();
  if (!owner || !repo) return err('REPO_OWNER / REPO_NAME env vars not set on the function', 500, cors);

  try {
    // ---------- READ ----------
    if (request.method === 'GET') {
      const r = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`);
      if (r.status === 404) return ok({ content: null, sha: null, branch }, 200, cors);
      if (!r.ok) {
        const text = await r.text();
        console.error('cents sync: github read failed', r.status, text.slice(0, 400));
        return err('Reading the cloud copy failed', r.status, cors);
      }
      const j = await r.json();
      const text = decodeBase64(j.content || '');
      let parsed = null;
      let malformed = false;
      try {
        parsed = text.trim() ? JSON.parse(text) : null;
        malformed = !!text.trim() && !validIncomingState(parsed);
      } catch {
        malformed = true;
      }
      return ok({
        content: parsed,
        malformed,
        sha: j.sha,
        branch,
        size: j.size,
        // Contents API responses usually omit commit timestamps. The client
        // stores its edit timestamp in the validated document, so use that as
        // a safe fallback for local-vs-cloud freshness checks.
        lastModifiedAt: j.updated_at || j.commit?.author?.date || parsed?.lastLocalChangeAt || null,
        commitSha: j.commit?.sha || null,
        path: j.path || file,
      }, 200, cors);
    }

    // ---------- WRITE ----------
    if (request.method === 'PUT') {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
        return err('Request body is too large', 413, cors);
      }
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { return err('Body is not valid JSON', 400, cors); }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return err('Request body must be an object', 400, cors);
      }
      const incoming = body.content;
      if (!validIncomingState(incoming)) {
        return err('Body.content contains invalid or excessive expense data', 400, cors);
      }

      const sha = body.sha == null || body.sha === '' ? null : body.sha;
      if (sha !== null && (typeof sha !== 'string' || sha.length > 200 || /[\r\n]/.test(sha))) {
        return err('Body.sha is invalid', 400, cors);
      }
      const msg    = typeof body.message === 'string' && body.message.trim()
                       ? body.message.trim().slice(0, 200)
                       : 'cents: update expenses';
      const branchParam = body.branch == null || body.branch === '' ? branch : body.branch;
      if (typeof branchParam !== 'string' || branchParam.length > 200 || !/^(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(branchParam)) {
        return err('Body.branch is invalid', 400, cors);
      }
      const encoded = encodeBase64(JSON.stringify(incoming, null, 2));

      const putBody = { message: msg, content: encoded, branch: branchParam };
      if (sha) putBody.sha = sha;

      const r = await ghFetch(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}`,
        { method: 'PUT', body: JSON.stringify(putBody) }
      );

      if (r.status === 409) {
        return ok({ conflict: true, status: r.status }, 200, cors);
      }
      if (!r.ok) {
        const text = await r.text();
        console.error('cents sync: github write failed', r.status, text.slice(0, 400));
        return err('Saving to the cloud failed', r.status, cors);
      }

      const j = await r.json();
      return ok({
        sha: j.content?.sha || null,
        commit: j.commit?.sha || null,
        branch: branchParam,
        lastModifiedAt: j.commit?.author?.date || j.content?.updated_at || null,
      }, 200, cors);
    }

    return err('Method not allowed', 405, cors);
  } catch (e) {
    // Never echo internals to the client — log the real cause server-side so
    // it stays diagnosable without leaking GitHub/error detail to the caller.
    console.error('cents sync: unexpected error', e?.message || e);
    return err('Unexpected sync error', 500, cors);
  }
};
