#!/usr/bin/env node
/**
 * Sync-function contract test.
 *
 * `netlify/functions/sync.mjs` is the only path cloud data takes, and its shape
 * is easy to break from either side without noticing: it wants `PUT` with
 * `{ content: <state> }` (not POST, not a bare state), it validates aggressively
 * before writing, and it stores whatever the validator lets through — so a
 * rejected field is not an error the UI shows, it is data that quietly stops
 * syncing. This drives the real handler with a stubbed GitHub API (no network,
 * no token, nothing written anywhere) and asserts the round trip, including the
 * Tesco Pay state and its rates.
 *
 * Run: node scripts/test-sync.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
const REPO = new URL('..', import.meta.url).href.replace(/\/$/, '');

process.env.APP_PASSWORD = 'test-password-1234';
process.env.GITHUB_TOKEN = 'stub-token';
process.env.REPO_OWNER = 'stub-owner';
process.env.REPO_NAME = 'stub-repo';
process.env.REPO_BRANCH = 'main';
process.env.REPO_FILE = 'data.json';

// ---- stub the GitHub Contents API the function talks to ----
let stored = null, sha = null;
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'GET') {
    if (!stored) return new Response('not found', { status: 404 });
    return json({ content: Buffer.from(stored, 'utf8').toString('base64'), sha });
  }
  if (method === 'PUT') {
    stored = Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8');
    sha = 'sha-' + stored.length;
    return json({ content: { sha }, commit: { sha: 'c1' } });
  }
  return new Response('unexpected ' + method, { status: 500 });
};

const { default: handler } = await import(REPO + '/netlify/functions/sync.mjs');
const call = (method, body, password = 'test-password-1234') => handler(new Request('https://cents.test/.netlify/functions/sync', {
  method,
  headers: { 'content-type': 'application/json', 'x-cents-password': password },
  body: body ? JSON.stringify(body) : undefined,
}), {});

const tesco = {
  shifts: [{ id: 's1', date: '2026-09-19', start: '07:00', end: '15:00' }],
  payslips: [{ id: 'p1', weekStart: '2026-09-19', paye: 33.18, usc: 7.55, prsi: 23.12, futureFund: 8.26 }],
  tombstones: { shifts: { s0: '2026-09-01' }, payslips: {} },
};
const state = { version: 2, entries: [], settings: { monthlyBudget: 900, tescoRates: { normal: 15 } }, tesco };

let pass = 0;
const fails = [];
const check = (label, ok, extra = '') => ok ? pass++ : fails.push(`${label}${extra ? ' — ' + extra : ''}`);

const put = await call('PUT', { content: state });
check('PUT { content } accepted', put.status === 200, `got ${put.status} ${(await put.text()).slice(0, 140)}`);

const get = await call('GET');
check('GET returns 200', get.status === 200, `got ${get.status}`);
const body = await get.json();
// The document may come back bare or nested; accept either, but assert the data.
const doc = body && typeof body.content === 'object' && body.content ? body.content : body;
check('tesco.shifts round-trip', JSON.stringify(doc?.tesco?.shifts) === JSON.stringify(tesco.shifts), JSON.stringify(doc?.tesco?.shifts));
check('tesco.payslips round-trip', JSON.stringify(doc?.tesco?.payslips) === JSON.stringify(tesco.payslips));
check('tesco tombstones round-trip', JSON.stringify(doc?.tesco?.tombstones) === JSON.stringify(tesco.tombstones));
check('settings.tescoRates round-trip', doc?.settings?.tescoRates?.normal === 15, JSON.stringify(doc?.settings));

// Positive controls: the guard rails are still doing their job.
const shape = await call('PUT', state);
check('a bare state (no { content }) is rejected', shape.status === 400, `got ${shape.status}`);
const bad = await call('PUT', { content: { version: 2, entries: 'not-an-array', settings: {} } });
check('malformed entries rejected (400)', bad.status === 400, `got ${bad.status}`);
const badAuth = await call('GET', null, 'wrong-password');
check('wrong password rejected (401)', badAuth.status === 401, `got ${badAuth.status}`);
const noAuth = await handler(new Request('https://cents.test/.netlify/functions/sync', { method: 'GET' }), {});
check('missing password rejected (401)', noAuth.status === 401, `got ${noAuth.status}`);

// The platform refuses a synchronous function request over 6 MB before the
// function body runs, and nothing the user does locally makes the same payload
// smaller — so the message has to name what to remove.
const huge = await call('PUT', { content: { version: 2, entries: [], settings: {}, pad: 'x'.repeat(6 * 1024 * 1024) } });
const hugeText = await huge.text();
check('a body over 6 MB is refused with an actionable message', huge.status === 413 && /audio notes/.test(hugeText), `got ${huge.status} ${hugeText.slice(0, 120)}`);

// ---- the client's half of that contract ---------------------------------
// The retry logic keys off the failure CLASS, so the class must follow the
// status: 409/422 means the cloud moved and a pull+merge+retry helps, while
// 400/413 means the server refused these exact bytes and a retry can only fail
// the same way (that conflation is how an oversize payload looped forever).
const serverFetch = globalThis.fetch;
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
mem.set('cents:syncSettings', JSON.stringify({
  enabled: true,
  endpoint: 'https://cents.test/.netlify/functions/sync',
  password: 'test-password-1234',
}));
const { syncPush } = await import(REPO + '/sync.js');
const tiny = { version: 2, entries: [], settings: {} };
const clientCalls = [];
let clientBody = { error: 'server said no' };
let clientStatus = 400;
globalThis.fetch = async (url, opts = {}) => {
  clientCalls.push(opts.method || 'GET');
  return new Response(JSON.stringify(clientBody), { status: clientStatus, headers: { 'content-type': 'application/json' } });
};

for (const [status, expected] of [
  [400, 'rejected'], [403, 'rejected'], [404, 'rejected'], [413, 'rejected'],
  [409, 'conflict'], [422, 'conflict'], [500, 'http'], [502, 'http'],
]) {
  clientStatus = status;
  clientBody = { error: 'server said no' };
  const r = await syncPush(tiny);
  check(`HTTP ${status} maps to '${expected}'`, r.ok === false && r.reason === expected, `got ${r.reason}`);
}
clientStatus = 200;
clientBody = { conflict: true };
const raced = await syncPush(tiny);
check("the function's conflict flag maps to 'conflict'", raced.ok === false && raced.reason === 'conflict', raced.reason);

clientCalls.length = 0;
const oversized = await syncPush({ version: 2, entries: [{ id: 'n1', audioData: 'data:audio/webm;base64,' + 'A'.repeat(7 * 1024 * 1024) }], settings: {} });
check('an oversize payload is refused before any upload',
  oversized.ok === false && oversized.reason === 'rejected' && clientCalls.length === 0,
  `${oversized.reason}, ${clientCalls.length} request(s) made`);
check('that refusal names the cause', /audio note/.test(oversized.message || ''), oversized.message);
globalThis.fetch = serverFetch;

if (fails.length) {
  console.error(`test-sync: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`test-sync: OK — ${pass} checks passed (cloud state, including Tesco Pay, survives the round trip)`);
