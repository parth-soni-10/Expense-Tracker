/* ============================================================
   Function v2 — cloud sync proxy for cents, bundled into the Worker.

   Holds each profile's JSON document in the deployment's durable store
   (a KV namespace on Cloudflare) and mirrors it
   into a configured GitHub repo. Gated by an admin password sent via
   the X-Cents-Password header; the PAT itself lives only in this
   function's environment, never in the client bundle. lib/cloud.mjs
   owns the storage model (primary, mirror, version tokens, migration),
   including the order of the two writes: the store commits first and the
   GitHub mirror follows it, handed to this request's waitUntil so a save
   never waits on a code host that is only keeping a spare copy.

   Required env vars:
     GITHUB_TOKEN    fine-grained PAT, repo contents: read+write
     REPO_OWNER      e.g. "yourname"
     REPO_NAME       e.g. "cents-data"
     REPO_BRANCH     default "main"
     REPO_FILE       default "data.json"
     APP_PASSWORD    any string the client sends in X-Cents-Password
                     (must be at least 8 characters)

   Profiles: the client sends X-Cents-Profile (<profile-id>, a short
   slug). The password is resolved per profile — APP_PASSWORD for the
   default "personal" id, APP_PASSWORD_<ID> for any other, with NO
   fallback between them — and the document is kept under that id,
   privately in that store and mirrored to data-<id>.json.
   Two profiles therefore never share a password or a document, so one
   profile's credential cannot read another's data. A profile whose
   env var is missing is refused with the name to set, rather than
   silently sharing the owner's password.

   Auth hardening:
     * the resolved password is compared in constant time.
     * Failed attempts are throttled per client IP (in-memory,
       best-effort — resets on cold start) and each failure sleeps
       500ms to slow brute force.
     * CORS reflects the request Origin (with Vary) instead of
       granting every origin — cross-origin clients still work,
       but the blanket '*' is gone.

   The mirror gap. lib/cloud.mjs owns each profile's document in the durable
   store and mirrors it to GitHub, and it compares the two after every save —
   the record's version token against the repo blob's own bytes — because a
   mirror that failed is logged rather than returned (a code host must not fail
   somebody's save). This function is where that verdict becomes visible:

     GET            answers with the verdict the last save recorded, plus
                    whether a mirror exists at all (mirrorConfigured). Costs
                    nothing: it rides along with the record the read already
                    returned.
     GET ?mirror=1  measures it now — the record against the blob — and answers
                    with the verdict ALONE, no document. This is what the
                    app's Data screen asks for, so opening that screen cannot
                    cost a re-download of the ledger.
     PUT            answers with the verdict when this deployment could reach
                    one before answering (a host with no waitUntil: local runs,
                    the tests). On a real deployment the mirror write and its
                    check are handed to waitUntil, so `mirror` is null there —
                    which means "not measured yet", never "in sync".
   ============================================================ */

import { RECURRING_FREQUENCIES } from '../../seed.js';
import { safeEqual, createFailureThrottle } from './lib/auth.mjs';
import { resolveProfileForAuth, profileAuthMessage, cloudFileFor } from './lib/profiles.mjs';
import { ghConfig, mirrorConfigured } from './lib/gh.mjs';
import { readCloudDoc, writeCloudDoc, mirrorGap, CloudError } from './lib/cloud.mjs';

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    // X-Cents-Profile belongs here: the client sends it on every call, and a
    // cross-origin endpoint (a self-hosted sync domain) is preflighted, which
    // same-origin requests never are — so omitting it made sync work only when
    // the endpoint was on this origin. Same list as setup-token and profiles-admin.
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password, X-Cents-Setup-Token, X-Cents-Profile',
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
        || !validDate(recurring.nextDate) || !RECURRING_FREQUENCIES.includes(recurring.frequency)
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
      || (entry.audioType != null && (entry.type !== 'note' || typeof entry.audioType !== 'string' || !/^audio\/[a-z0-9.+-]+$/i.test(entry.audioType)))) return false;
  }
  for (const group of transferGroups.values()) {
    const debit = group.find(entry => entry.type === 'expense');
    const credit = group.find(entry => entry.type === 'credit');
    if (group.length !== 2 || !debit || !credit || debit.amount !== credit.amount
      || debit.date !== credit.date || debit.method === credit.method) return false;
  }
  return true;
}

export default async (request, context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);

  const profile = resolveProfileForAuth(request);
  if (!profile.ok) return err(profileAuthMessage(profile), 500, cors);
  const expected = profile.expected;

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

  const config = ghConfig();
  const { owner, repo, branch } = config;
  if (!owner || !repo) return err('REPO_OWNER / REPO_NAME env vars not set on the function', 500, cors);

  try {
    // ---------- READ ----------
    if (request.method === 'GET') {
      // The on-demand gap check. Answered before the document is even read,
      // because the caller wants the comparison and not the ledger: the request
      // carries a credential and a profile and nothing else.
      if (new URL(request.url).searchParams.get('mirror')) {
        const gap = await mirrorGap(profile.id, config);
        return ok({ mirror: gap, mirrorConfigured: mirrorConfigured() }, 200, cors);
      }
      const doc = await readCloudDoc(profile.id, config);
      if (!doc.exists) return ok({ content: null, sha: null, branch, mirror: null, mirrorConfigured: mirrorConfigured() }, 200, cors);
      // The same judgement as before: a document that cannot be parsed (its
      // content stays null) or that the client-side validator would refuse is
      // reported, so the client stops instead of merging half a file.
      const malformed = !validIncomingState(doc.content);
      return ok({
        content: doc.content,
        malformed,
        // Opaque to the client, exactly like the git sha it replaces: it only
        // echoes this back on the next write. See lib/cloud.mjs.
        sha: doc.version,
        branch,
        // Whatever timestamp the store that answered knows. The client stores
        // its edit timestamp in the validated document, so that is the fallback
        // for local-vs-cloud freshness checks.
        lastModifiedAt: doc.updatedAt,
        commitSha: doc.commitSha,
        // The last save's gap verdict (never measured here — a plain read must
        // not cost a GitHub round trip), and whether this deployment has a
        // mirror at all. Both are for the app's Data screen.
        mirror: doc.mirror || null,
        mirrorConfigured: mirrorConfigured(),
        path: cloudFileFor(profile.id, config.file),
      }, 200, cors);
    }

    // ---------- WRITE ----------
    if (request.method === 'PUT') {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
        return err('Request body is too large (6 MB limit) - remove audio notes to shrink the cloud copy', 413, cors);
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
      const result = await writeCloudDoc(profile.id, config, {
        content: incoming,
        expectedVersion: sha,
        message: msg,
        branch: branchParam,
        // Handed to the platform so the mirror runs after the answer, not
        // before it. Absent on a local run (and in the tests), where the
        // mirror is awaited as it always was — see lib/cloud.mjs.
        defer: context?.waitUntil ? promise => context.waitUntil(promise) : null,
      });
      if (result.conflict) return ok({ conflict: true, status: 409 }, 200, cors);
      if (result.error) return err(result.error, 502, cors);

      return ok({
        sha: result.version,
        commit: result.commitSha,
        branch: branchParam,
        lastModifiedAt: result.updatedAt,
        // The gap verdict, when this deployment could measure it before
        // answering. Null on a real deployment, where the mirror write and its
        // check went to waitUntil: it means "not measured yet", never "in
        // sync", and the next GET (or a ?mirror=1 check) is where the answer
        // lands.
        mirror: result.mirror || null,
      }, 200, cors);
    }

    return err('Method not allowed', 405, cors);
  } catch (e) {
    // A store that could not be reached is a real, reportable failure with the
    // store's own status; anything else is an internal fault we log rather than
    // describe, so GitHub/error detail never reaches the caller.
    if (e instanceof CloudError) return err(e.message, e.status || 502, cors);
    console.error('cents sync: unexpected error', e?.message || e);
    return err('Unexpected sync error', 500, cors);
  }
};
