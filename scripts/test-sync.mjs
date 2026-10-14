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
 * Also a step in scripts/run-guards.mjs.
 */
import { readFileSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).href.replace(/\/$/, '');

process.env.APP_PASSWORD = 'test-password-1234';
process.env.APP_PASSWORD_SAM = 'sam-password-123456';
delete process.env.APP_PASSWORD_KATE;
process.env.GITHUB_TOKEN = 'stub-token';
// The root secret the recovery links are encrypted with, under the name a new
// deployment sets (GITHUB_TOKEN is the fallback for one configured before that
// name existed — see lib/secret.mjs). It has to clear that module's length
// floor, which is why it is not the short GitHub stub above: a link encrypted
// with a guessable secret is a password anyone can read.
process.env.CENTS_SECRET = 'cents-root-secret-for-tests';
const ROOT_SECRET = process.env.CENTS_SECRET;
process.env.REPO_OWNER = 'stub-owner';
process.env.REPO_NAME = 'stub-repo';
process.env.REPO_BRANCH = 'main';
process.env.REPO_FILE = 'data.json';

// ---- stub the GitHub Contents API the function talks to ----
// One entry per FILE, so a request for another profile's document cannot be
// mistaken for this one's: the whole point of the profile tests below.
const clouds = new Map();
const fileOf = url => (/\/contents\/([^?]+)/.exec(String(url)) || [, '?'])[1].split('/').map(decodeURIComponent).join('/');
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const file = fileOf(url);
  if (method === 'GET') {
    if (!clouds.has(file)) return new Response('not found', { status: 404 });
    return json({ content: Buffer.from(clouds.get(file), 'utf8').toString('base64'), sha: 'sha-' + clouds.get(file).length });
  }
  if (method === 'PUT') {
    const stored = Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8');
    clouds.set(file, stored);
    return json({ content: { sha: 'sha-' + stored.length }, commit: { sha: 'c1' } });
  }
  return new Response('unexpected ' + method, { status: 500 });
};
const stored = () => clouds.get('data.json') || null;

const { default: handler } = await import(REPO + '/netlify/functions/sync.mjs');
const { MIRROR_STATES } = await import(REPO + '/netlify/functions/lib/cloud.mjs');
const call = (method, body, password = 'test-password-1234', profile = null) => handler(new Request('https://cents.test/.netlify/functions/sync', {
  method,
  headers: {
    'content-type': 'application/json',
    'x-cents-password': password,
    ...(profile ? { 'x-cents-profile': profile } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
}), {});
// The gap check, as the app's Data menu asks for it.
const mirrorCall = (password = 'test-password-1234', profile = null) => handler(new Request('https://cents.test/.netlify/functions/sync?mirror=1', {
  method: 'GET',
  headers: { 'x-cents-password': password, ...(profile ? { 'x-cents-profile': profile } : {}) },
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

// ---- the mirror gap, from the endpoint's side ------------------------------
// A save's answer carries the verdict when the deployment could reach one before
// answering; the on-demand check answers with the verdict and NOTHING else,
// because the Data menu asks for it on every open and a reply carrying the
// document would make that cost a re-download of the ledger.
const gapBefore = await (await call('GET')).json();
const gapPut = await (await call('PUT', { content: { ...state, settings: { ...state.settings, monthlyBudget: 901 } }, sha: gapBefore.sha })).json();
check('a save answers with the mirror verdict it could reach',
  gapPut.mirror?.state === 'in_sync', JSON.stringify(gapPut.mirror));
check('and the verdict is one of the vocabulary the app renders',
  MIRROR_STATES.includes(gapPut.mirror?.state), String(gapPut.mirror?.state));

const checked = await mirrorCall();
const checkedBody = await checked.json();
check('the on-demand check answers 200 with a verdict',
  checked.status === 200 && MIRROR_STATES.includes(checkedBody.mirror?.state), `${checked.status} ${JSON.stringify(checkedBody).slice(0, 160)}`);
check('and no document rides along with it', checkedBody.content === undefined, JSON.stringify(Object.keys(checkedBody)));
check('and it names whether this deployment has a mirror at all',
  checkedBody.mirrorConfigured === true, String(checkedBody.mirrorConfigured));
// This deployment's store is an in-memory map (not durable), so the mirror IS
// the commit point and there is no record to compare against. "Nothing to
// compare" is the honest answer, and it must not be dressed up as "fine".
check('with no record to compare it says so rather than passing',
  checkedBody.mirror.state === 'no_document', checkedBody.mirror.state);
const uncheckedAuth = await mirrorCall('wrong-password');
check('the check is behind the same credential as the rest of the endpoint',
  uncheckedAuth.status === 401, `got ${uncheckedAuth.status}`);

// ---- the preflight has to allow what the client actually sends -----------
// A cross-origin endpoint (the self-hosted sync domain the CSP allows) is
// preflighted; a same-origin one never is. So a header missing from the
// allow-list breaks sync only for people pointing the app at their own domain,
// which is invisible on the default deployment — X-Cents-Profile was missing
// here while the client sent it on every single call. The names are read out of
// sync.js so this cannot drift from the client, and anything the client sends
// that the list omits fails the build.
const clientHeaders = [...new Set([
  ...[...readFileSync(new URL('../sync.js', import.meta.url), 'utf8').matchAll(/X-Cents-[A-Za-z-]+/g)].map(m => m[0]),
  'Content-Type',
])];
const preflight = await handler(new Request('https://cents.test/.netlify/functions/sync', {
  method: 'OPTIONS', headers: { origin: 'https://self-hosted.example' },
}), {});
const allowed = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
const missing = clientHeaders.filter(h => !allowed.includes(h.toLowerCase()));
check('the preflight allows every header the client sends', preflight.status === 200 && missing.length === 0, missing.join(', '));
check('and reflects the caller\u2019s origin rather than granting any',
  preflight.headers.get('access-control-allow-origin') === 'https://self-hosted.example'
  && preflight.headers.get('vary') === 'Origin', String(preflight.headers.get('access-control-allow-origin')));

// ---- profiles: one profile cannot reach another's document ---------------
// A second profile syncs to its own file with its own password, and neither
// credential works on the other profile. The shared-password fallback that
// this replaces made APP_PASSWORD a master key for every profile.
const samState = { version: 2, entries: [{ id: 'sam-1', date: '2026-09-21', type: 'expense', method: 'AIB', category: 'gro', amount: 4, details: '', note: '' }], settings: { monthlyBudget: 321 } };
const samPut = await call('PUT', { content: samState }, 'sam-password-123456', 'sam');
check('a profile writes with its own password', samPut.status === 200, `got ${samPut.status} ${(await samPut.text()).slice(0, 140)}`);
check('a profile writes to its own cloud file', clouds.has('data-sam.json') && JSON.parse(clouds.get('data-sam.json')).settings.monthlyBudget === 321);
check('and leaves the default profile\u2019s file alone', !stored().includes('sam-1'));
const samGet = await call('GET', null, 'sam-password-123456', 'sam');
const samDoc = await samGet.json();
check('a profile reads back only its own document', samDoc?.content?.settings?.monthlyBudget === 321, JSON.stringify(samDoc?.content?.settings));
check('the default profile is a different document', !stored().includes('321'));

const sharedOnProfile = await call('GET', null, 'test-password-1234', 'sam');
check('the default password is refused for another profile (401)', sharedOnProfile.status === 401, `got ${sharedOnProfile.status}`);
const profileOnDefault = await call('GET', null, 'sam-password-123456');
check("a profile's password is refused for the default profile (401)", profileOnDefault.status === 401, `got ${profileOnDefault.status}`);
const noEnv = await call('GET', null, 'whatever-password', 'kate');
const noEnvText = await noEnv.text();
check('a profile with no env var is refused, not shared', noEnv.status === 500, `got ${noEnv.status}`);
check('and the refusal names the env var to set', /APP_PASSWORD_KATE/.test(noEnvText), noEnvText.slice(0, 160));
const hostile = await call('GET', null, 'test-password-1234', '../../etc/passwd');
check('a hostile profile header falls back to the default profile, not a path', hostile.status === 200, `got ${hostile.status}`);

// ---- profiles-admin: the owner invites an account, and sets its tabs -----
// One deployed site, shared with friends. The owner must be able to hand out an
// account (and control which tabs it opens) WITHOUT ever signing in as that
// person or holding their entries — so this endpoint is the only place where
// the owner's credential can touch another account's cloud file, and it must
// touch nothing but the tab policy.
const { default: adminHandler } = await import(REPO + '/netlify/functions/profiles-admin.mjs');
const { redeemSetupToken } = await import(REPO + '/netlify/functions/lib/tokens.mjs');
const admin = (payload, password = 'test-password-1234') => adminHandler(new Request('https://cents.test/.netlify/functions/profiles-admin', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-cents-password': password },
  body: JSON.stringify(payload ?? {}),
}), {});

const invited = await admin({ action: 'invite', profile: 'sam', enabledTabs: ['dashboard', 'add', 'insights'] });
check('the owner can mint an invite for another account', invited.status === 200, `got ${invited.status} ${(await invited.text()).slice(0, 160)}`);
const inviteBody = await (await admin({ action: 'invite', profile: 'sam', enabledTabs: ['dashboard', 'add', 'insights'] })).json();
const redeemedInvite = redeemSetupToken(ROOT_SECRET, inviteBody.token);
check('the invite carries that account\u2019s own password',
  redeemedInvite.ok && redeemedInvite.password === 'sam-password-123456', JSON.stringify(redeemedInvite && { ok: redeemedInvite.ok }));
check('and names the account it belongs to', redeemedInvite.profileId === 'sam', redeemedInvite.profileId);
check('and carries the tab policy set before sending it',
  JSON.stringify(redeemedInvite.tabs) === JSON.stringify(['dashboard', 'add', 'insights']), JSON.stringify(redeemedInvite.tabs));

const asFriend = await admin({ action: 'invite', profile: 'sam' }, 'sam-password-123456');
check('a friend\u2019s own password cannot mint invites (401)', asFriend.status === 401, `got ${asFriend.status}`);
const badAction = await admin({ action: 'wipe', profile: 'sam' });
check('an unknown action is refused (400)', badAction.status === 400, `got ${badAction.status}`);
const hostileTarget = await admin({ action: 'invite', profile: '../../etc/passwd' });
check('a hostile account id is refused, not used as a path (400)', hostileTarget.status === 400, `got ${hostileTarget.status}`);
const noEnvInvite = await admin({ action: 'invite', profile: 'kate' });
const noEnvInviteText = await noEnvInvite.text();
check('inviting an account with no credential is refused (500)', noEnvInvite.status === 500, `got ${noEnvInvite.status}`);
check('and the refusal names the env var to set', /APP_PASSWORD_KATE/.test(noEnvInviteText), noEnvInviteText.slice(0, 160));

// A deployment whose only candidate secret is a short PAT must refuse to mint an
// invite rather than encrypt one with guessable key material — the link carries a
// password, and the derivation is in this public repo.
const savedRootSecret = process.env.CENTS_SECRET;
const savedGithubStub = process.env.GITHUB_TOKEN;
delete process.env.CENTS_SECRET;
process.env.GITHUB_TOKEN = 'short';
const noRoot = await admin({ action: 'invite', profile: 'sam' });
const noRootText = await noRoot.text();
check('no usable root secret: an invite is refused (500)', noRoot.status === 500, `got ${noRoot.status}`);
check('and the refusal names CENTS_SECRET', /CENTS_SECRET/.test(noRootText), noRootText.slice(0, 160));
process.env.CENTS_SECRET = savedRootSecret;
process.env.GITHUB_TOKEN = savedGithubStub;

// The policy write: it must land in that account's file, preserve every entry,
// and change ONLY settings.enabledTabs.
const samBefore = JSON.parse(clouds.get('data-sam.json'));
const policy = await admin({ action: 'policy', profile: 'sam', enabledTabs: ['dashboard', 'history'] });
check('the owner can write an account\u2019s tab policy', policy.status === 200, `got ${policy.status}`);
const policyBody = await policy.json();
check('and it reports the write as applied', policyBody.applied === true, JSON.stringify(policyBody));
const samAfter = JSON.parse(clouds.get('data-sam.json'));
check('the policy lands in that account\u2019s own file',
  JSON.stringify(samAfter.settings.enabledTabs) === JSON.stringify(['dashboard', 'history']), JSON.stringify(samAfter.settings.enabledTabs));
check('the entries are left exactly as they were',
  JSON.stringify(samAfter.entries) === JSON.stringify(samBefore.entries), JSON.stringify(samAfter.entries));
// Everything but the policy and the freshness stamp is byte-identical: the
// stamp is what makes the receiving device keep this policy over its own older
// copy, and it is the only other field this endpoint may add.
const stripStamp = d => { const { lastLocalChangeAt, ...rest } = d; return rest; };
const stripEnabled = d => ({ ...d, settings: (() => { const { enabledTabs, ...s } = d.settings; return s; })() });
check('and nothing else in that document is touched',
  JSON.stringify(stripEnabled(stripStamp(samAfter))) === JSON.stringify(stripEnabled(stripStamp(samBefore))),
  JSON.stringify(stripEnabled(stripStamp(samAfter))));
check('the default profile\u2019s file is untouched by any of it', !stored().includes('enabledTabs'));

// The account the owner is inviting may never have synced. There is no document
// to carry a policy then, which is not an error — the next invite carries it.
const pending = await admin({ action: 'policy', profile: 'kate', enabledTabs: ['dashboard'] });
check('a policy for a never-synced account is refused before the env check', pending.status === 500, `got ${pending.status}`);
process.env.APP_PASSWORD_KATE = 'kate-password-12345';
const pending2 = await admin({ action: 'policy', profile: 'kate', enabledTabs: ['dashboard'] });
const pendingBody = await pending2.json();
check('with a credential but no cloud copy it reports pending, not failure',
  pending2.status === 200 && pendingBody.pending === true, `${pending2.status} ${JSON.stringify(pendingBody)}`);
check('and it does not invent a cloud file for them', !clouds.has('data-kate.json'));
const badTabs = await admin({ action: 'policy', profile: 'kate', enabledTabs: 'all' });
check('a malformed tab list is refused (400)', badTabs.status === 400, `got ${badTabs.status}`);
delete process.env.APP_PASSWORD_KATE;

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
const { syncPull, syncPush, syncCheckMirror, mirrorStatus } = await import(REPO + '/sync.js');
const tiny = { version: 2, entries: [], settings: {} };
const clientCalls = [];
const clientUrls = [];
let clientBody = { error: 'server said no' };
let clientStatus = 400;
globalThis.fetch = async (url, opts = {}) => {
  clientCalls.push(opts.method || 'GET');
  clientUrls.push(String(url));
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

// A pull names the profile it spoke for, so a response that lands after the
// user switched profiles can be dropped instead of merged into the wrong
// document (app.js: staleResponse).
clientStatus = 200;
clientBody = { content: { version: 2, entries: [], settings: {} }, sha: 'abc' };
const stamped = await syncPull();
check('a successful pull names its profile', stamped.ok === true && stamped.profile === 'personal', `profile=${stamped.profile}`);
clientStatus = 401;
clientBody = { error: 'nope' };
const refused = await syncPull();
check('a refused pull names its profile too', refused.ok === false && refused.profile === 'personal', `profile=${refused.profile}`);

clientCalls.length = 0;
const oversized = await syncPush({ version: 2, entries: [{ id: 'n1', audioData: 'data:audio/webm;base64,' + 'A'.repeat(7 * 1024 * 1024) }], settings: {} });
check('an oversize payload is refused before any upload',
  oversized.ok === false && oversized.reason === 'rejected' && clientCalls.length === 0,
  `${oversized.reason}, ${clientCalls.length} request(s) made`);
check('that refusal names the cause', /audio note/.test(oversized.message || ''), oversized.message);

// ---- the client's half of the mirror gap ---------------------------------
// The verdict has to reach the screen without being invented on the way: a save
// and a pull both carry it when the proxy measured it, the on-demand check is
// its own request, and a reply that is not a verdict is never a pass.
clientStatus = 200;
clientBody = { sha: 's1', commit: 'c1', branch: 'main', mirror: { state: 'in_sync', recordVersion: 'r1', mirrorVersion: 'r1', wrote: true } };
const pushedWithVerdict = await syncPush(tiny);
check('a save hands on the verdict when the proxy measured one',
  pushedWithVerdict.ok === true && pushedWithVerdict.mirror?.state === 'in_sync', JSON.stringify(pushedWithVerdict));
clientBody = { sha: 's1', commit: null, branch: 'main', mirror: null };
const pushedDeferred = await syncPush(tiny);
check('and a save whose mirror was handed off carries none, rather than a false pass',
  pushedDeferred.ok === true && pushedDeferred.mirror === null, JSON.stringify(pushedDeferred));
clientBody = { content: tiny, sha: 'abc', mirror: { state: 'diverged', recordVersion: 'r1', mirrorVersion: 'm9', wrote: true } };
const pulledWithVerdict = await syncPull();
check('a pull carries the verdict the last save recorded',
  pulledWithVerdict.mirror?.state === 'diverged', JSON.stringify(pulledWithVerdict.mirror));

clientUrls.length = 0;
clientBody = { mirror: { state: 'behind', checkedAt: new Date().toISOString(), recordVersion: 'r1', mirrorVersion: 'm0', wrote: false }, mirrorConfigured: true };
const verdict = await syncCheckMirror();
check('the check asks the configured endpoint with the check on it',
  clientUrls[0] === 'https://cents.test/.netlify/functions/sync?mirror=1', clientUrls[0]);
check('and hands the verdict back', verdict.ok === true && verdict.mirror.state === 'behind', JSON.stringify(verdict));
clientBody = { mirrorConfigured: true };
const noVerdict = await syncCheckMirror();
check('a reply that is not a verdict is not a pass',
  noVerdict.ok === false && /verdict/.test(noVerdict.message || ''), JSON.stringify(noVerdict));

// What the Data menu does with one. `gap` is the only thing that may colour the
// line, and the two mistakes available here are both silent: crying a gap at a
// mirror that is fine, and calling an unchecked one fine.
for (const state of ['behind', 'diverged', 'missing', 'unverifiable']) {
  check(`"${state}" is reported as a gap`, mirrorStatus({ state }).gap === true, JSON.stringify(mirrorStatus({ state })));
}
for (const state of ['in_sync', 'no_document', 'unconfigured', 'pending']) {
  check(`"${state}" is not reported as a gap`, mirrorStatus({ state }).gap === false, JSON.stringify(mirrorStatus({ state })));
}
check('nothing checked yet is not a pass',
  mirrorStatus(null).known === false && mirrorStatus(null).gap === false, JSON.stringify(mirrorStatus(null)));
check('and a state from a newer proxy is not a pass either',
  mirrorStatus({ state: 'from-the-future' }).known === true && mirrorStatus({ state: 'from-the-future' }).gap === false,
  JSON.stringify(mirrorStatus({ state: 'from-the-future' })));
// Every state needs BOTH wordings: the row's sentence and the toast's shorter
// one (which is on screen for a few seconds and has no room for the row's).
check('every state the client words is one the server can send, with both of its sentences',
  ['in_sync', 'pending', 'behind', 'diverged', 'missing', 'unverifiable', 'no_document', 'unconfigured']
    .every(state => MIRROR_STATES.includes(state)
      && !!mirrorStatus({ state }).detail && !!mirrorStatus({ state }).notice));
check('a verdict with a timestamp says when it was checked',
  /Checked /.test(mirrorStatus({ state: 'in_sync', checkedAt: new Date().toISOString() }).detail),
  mirrorStatus({ state: 'in_sync', checkedAt: new Date().toISOString() }).detail);
globalThis.fetch = serverFetch;

if (fails.length) {
  console.error(`test-sync: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`test-sync: OK — ${pass} checks passed (cloud state, including Tesco Pay, survives the round trip)`);
