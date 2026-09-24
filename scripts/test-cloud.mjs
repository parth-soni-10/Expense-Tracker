#!/usr/bin/env node
/**
 * Cloud storage contract test — the durable path.
 *
 * `netlify/functions/lib/cloud.mjs` keeps each profile's document in Netlify
 * Blobs and mirrors it into GitHub. On this machine `@netlify/blobs` does not
 * resolve (there is no node_modules — the runtime supplies it), so every other
 * test exercises only the fallback branch, where the GitHub mirror is the
 * commit point. That leaves the code that actually runs in production as the
 * one path no test reaches — which is what `useBlobsModule` in lib/store.mjs
 * exists for: this file hands the store a Blobs-compatible module and drives
 * the REAL sync and profiles-admin handlers against it, with a stubbed GitHub
 * API, no network and nothing written anywhere.
 *
 * What it pins down, all through the handlers the browser talks to:
 *   - a fresh deployment migrates: first read seeds Blobs from the mirror
 *   - after that the mirror is written, not read (a read touches GitHub zero times)
 *   - the primary is genuinely primary (GitHub down, reads still work)
 *   - the version token is the document's hash, so an identical re-push is not
 *     a conflict while a stale or absent one is
 *   - losing the mirror is survivable; losing the primary is reported
 *   - the owner's tab policy lands where the account's device will read it
 *
 * Run: node scripts/test-cloud.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
const REPO = new URL('..', import.meta.url).href.replace(/\/$/, '');

process.env.APP_PASSWORD = 'test-password-1234';
process.env.APP_PASSWORD_SAM = 'sam-password-123456';
process.env.GITHUB_TOKEN = 'stub-token';
process.env.REPO_OWNER = 'stub-owner';
process.env.REPO_NAME = 'stub-repo';
process.env.REPO_BRANCH = 'main';
process.env.REPO_FILE = 'data.json';

// ---- the store's Blobs seam -------------------------------------------------
// One shared backing map, so swapping the module (to make writes fail) keeps the
// data that is already there — the point of a primary is that it persists.
const backing = new Map(); // store name → Map(key → string)
function fakeBlobs({ failWrite = false } = {}) {
  return {
    getStore(name) {
      if (!backing.has(name)) backing.set(name, new Map());
      const map = backing.get(name);
      return {
        async get(key) {
          const v = map.get(key);
          return v === undefined ? null : v;
        },
        async set(key, value) {
          if (failWrite) throw new Error('primary write unavailable');
          map.set(key, String(value));
          return { modified: true };
        },
        async delete(key) { map.delete(key); return { deleted: true }; },
        async list({ prefix = '' } = {}) {
          return { blobs: [...map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
        },
      };
    },
  };
}
const storedRecord = (store, key) => {
  const raw = backing.get(store)?.get(key);
  return raw ? JSON.parse(raw) : null;
};

const { useBlobsModule } = await import(REPO + '/netlify/functions/lib/store.mjs');
const { versionOf } = await import(REPO + '/netlify/functions/lib/cloud.mjs');

// ---- stub the GitHub Contents API the mirror talks to -----------------------
// It enforces the two rules the real API does, because the mirror's retry logic
// exists precisely for them: a write must carry the current sha, and a sha that
// has moved is a conflict.
const mirrors = new Map(); // file → text
const shas = new Map();    // file → sha
let nextSha = 0;
const gh = { calls: [], broken: null };
// `/repos/<owner>/<repo>/contents/<file>?ref=<branch>` → `<file>`. Anchored on
// `contents/` (not `repos/`) and cut at the query, so a read and the write that
// follows it land on the same key.
const fileOf = url => (/\/contents\/([^?]+)/.exec(String(url)) || [, '?'])[1].split('/').map(decodeURIComponent).join('/');
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const file = fileOf(url);
  gh.calls.push(`${method} ${file}`);
  if (gh.broken === 'all' || (gh.broken === 'put' && method === 'PUT')) {
    return new Response('github is down', { status: 500 });
  }
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' },
  });
  if (method === 'GET') {
    if (!mirrors.has(file)) return new Response('not found', { status: 404 });
    const text = mirrors.get(file);
    return json({
      content: Buffer.from(text, 'utf8').toString('base64'),
      sha: shas.get(file), size: Buffer.byteLength(text), commit: { sha: 'commit-' + shas.get(file) },
    });
  }
  if (method === 'PUT') {
    const body = JSON.parse(opts.body);
    if (mirrors.has(file)) {
      if (!body.sha) return json({ message: 'sha was not supplied' }, 422);
      if (body.sha !== shas.get(file)) return json({ message: 'does not match' }, 409);
    }
    mirrors.set(file, Buffer.from(body.content, 'base64').toString('utf8'));
    const sha = `sha-${++nextSha}`;
    shas.set(file, sha);
    return json({ content: { sha }, commit: { sha: 'commit-' + sha } });
  }
  return new Response('unexpected ' + method, { status: 500 });
};

const { default: sync } = await import(REPO + '/netlify/functions/sync.mjs');
const { default: admin } = await import(REPO + '/netlify/functions/profiles-admin.mjs');

const call = (method, body, password = 'test-password-1234', profile = null) => sync(new Request(
  'https://cents.test/.netlify/functions/sync',
  {
    method,
    headers: {
      'content-type': 'application/json',
      'x-cents-password': password,
      ...(profile ? { 'x-cents-profile': profile } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  },
), {});
const policy = payload => admin(new Request('https://cents.test/.netlify/functions/profiles-admin', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-cents-password': 'test-password-1234' },
  body: JSON.stringify(payload),
}), {});

let pass = 0;
const fails = [];
const check = (label, ok, extra = '') => ok ? pass++ : fails.push(`${label}${extra ? ' — ' + extra : ''}`);
const DOC_KEY = 'doc/personal.json';
const SAM_KEY = 'doc/sam.json';

// A document in the mirror and nothing in Blobs: a deployment that predates
// this module, which is the state every existing site upgrades from.
const legacy = { version: 2, entries: [{ id: 'e1', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 12.5, details: 'milk', note: '' }], settings: { monthlyBudget: 750 } };
mirrors.set('data.json', JSON.stringify(legacy));
shas.set('data.json', 'sha-legacy');
useBlobsModule(fakeBlobs()); // installs the durable store (and drops any cached one)

// ---- migration: the first read seeds the primary from the mirror -----------
gh.calls.length = 0;
const first = await call('GET');
const firstBody = await first.json();
check('a fresh deployment reads its document from the mirror', firstBody.content?.settings?.monthlyBudget === 750, JSON.stringify(firstBody).slice(0, 160));
check('and seeds the primary with it', storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 750);
check('the seeded version is the document hash', firstBody.sha === versionOf(mirrors.get('data.json')), `${firstBody.sha} vs ${versionOf(mirrors.get('data.json'))}`);
check('seeding reads GitHub once and writes nothing to it', gh.calls.filter(c => c.startsWith('GET')).length === 1 && !gh.calls.some(c => c.startsWith('PUT')), gh.calls.join(', '));

// The upgrade path for a client that still holds the old git-file sha: one
// conflict, then its own pull-merge-retry puts it right.
const legacySha = await call('PUT', { content: legacy, sha: 'sha-legacy' });
check('a token from the old store conflicts once', legacySha.status === 200 && (await legacySha.json()).conflict === true);

// ---- the primary answers, and the mirror is written, not read --------------
gh.calls.length = 0;
const second = await call('GET');
const secondBody = await second.json();
check('a seeded document is served without touching GitHub', gh.calls.length === 0, gh.calls.join(', '));
check('and still returns the same content', secondBody.content?.settings?.monthlyBudget === 750);

const edited = { ...legacy, settings: { monthlyBudget: 800 } };
const push = await call('PUT', { content: edited, sha: secondBody.sha });
const pushed = await push.json();
// A conflict is also a 200, so assert on the body: a real save answers with the
// new token, and nothing else does.
check('a write with the current version is accepted', push.status === 200 && !pushed.conflict && !!pushed.sha, `${push.status} ${JSON.stringify(pushed)}`);
check('and the primary holds the new document', storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 800);
check('and the mirror was written to match', JSON.parse(mirrors.get('data.json')).settings.monthlyBudget === 800);
check('the returned token is the new document\u2019s own hash', !!pushed.sha && pushed.sha === versionOf(JSON.stringify(edited, null, 2)), pushed.sha);
check('the answer names the mirror commit it wrote', /^commit-sha-\d+$/.test(pushed.commit || ''), String(pushed.commit));

// ---- the version token decides every conflict -------------------------------
const stale = await call('PUT', { content: edited, sha: 'not-the-current-version' });
check('a stale token conflicts', (await stale.json()).conflict === true);
const absent = await call('PUT', { content: edited, sha: null });
check('a null token conflicts once a document exists', (await absent.json()).conflict === true);
const again = await call('PUT', { content: edited, sha: pushed.sha });
const againBody = await again.json();
check('re-pushing identical content is not a conflict', !againBody.conflict && againBody.sha === pushed.sha, JSON.stringify(againBody));
const after = await (await call('GET')).json();
check('and the version is unchanged by it', after.sha === pushed.sha, `${after.sha} vs ${pushed.sha}`);

// ---- the primary is genuinely primary --------------------------------------
gh.calls.length = 0;
gh.broken = 'all';
const offline = await call('GET');
const offlineBody = await offline.json();
check('reads keep working with GitHub entirely down', offline.status === 200 && offlineBody.content?.settings?.monthlyBudget === 800, `got ${offline.status}`);
check('and never even call it', gh.calls.length === 0, gh.calls.join(', '));
gh.broken = 'put';
const noMirror = await call('PUT', { content: { ...edited, settings: { monthlyBudget: 820 } }, sha: offlineBody.sha });
const noMirrorBody = await noMirror.json();
check('losing the mirror does not fail the save', noMirror.status === 200 && !!noMirrorBody.sha, `${noMirror.status} ${JSON.stringify(noMirrorBody)}`);
check('and the answer admits the mirror did not take it', noMirrorBody.commit === null, String(noMirrorBody.commit));
check('and the primary still moved', storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 820);
gh.broken = null;

// ---- losing the primary is reported, not hidden ----------------------------
const current = (await (await call('GET')).json()).sha;
useBlobsModule(fakeBlobs({ failWrite: true }));
const brokenPrimary = await call('PUT', { content: { ...edited, settings: { monthlyBudget: 900 } }, sha: current });
const brokenBody = await brokenPrimary.json();
check('losing the primary fails the save instead of reporting success', brokenPrimary.status === 502, `got ${brokenPrimary.status}`);
check('and the refusal explains itself rather than being a bare internal error', /Saving to the cloud failed/.test(brokenBody.error || ''), JSON.stringify(brokenBody));
const duringOutage = await (await call('GET')).json();
check('and reads still answer from the mirror', duringOutage.content?.settings?.monthlyBudget === 820, JSON.stringify(duringOutage.content?.settings));

useBlobsModule(fakeBlobs());
const recovered = await call('GET');
const recoveredBody = await recovered.json();
check('once the primary recovers, reads answer from it again', recoveredBody.content?.settings?.monthlyBudget === 820, JSON.stringify(recoveredBody.content?.settings));
const recoverPush = await call('PUT', { content: { ...edited, settings: { monthlyBudget: 950 } }, sha: recoveredBody.sha });
check('and saves work again', recoverPush.status === 200 && storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 950, `got ${recoverPush.status}`);

// The recovery path this module documents: drop the primary record and the next
// read hands the profile back to the mirror and seeds it again.
backing.get('cents-cloud').delete(DOC_KEY);
const reseeded = await (await call('GET')).json();
check('deleting the primary record falls back to the mirror', reseeded.content?.settings?.monthlyBudget === 950, JSON.stringify(reseeded.content?.settings));
check('and seeds the primary from it again', storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 950);

// ---- profiles stay in separate documents -----------------------------------
const samPut = await call('PUT', { content: { version: 2, entries: [], settings: { monthlyBudget: 111 } }, sha: null }, 'sam-password-123456', 'sam');
check('a profile writes its own document', samPut.status === 200 && storedRecord('cents-cloud', SAM_KEY)?.content?.settings?.monthlyBudget === 111);
check('which leaves the default profile\u2019s record alone', storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 950, JSON.stringify(storedRecord('cents-cloud', DOC_KEY)?.content?.settings));
check('and a different mirror file', JSON.parse(mirrors.get('data-sam.json')).settings.monthlyBudget === 111);
check('the default password still cannot reach it', (await call('GET', null, 'test-password-1234', 'sam')).status === 401);

// ---- the owner's tab policy lands where the account reads it ---------------
const applied = await policy({ action: 'policy', profile: 'sam', enabledTabs: ['dashboard', 'history'] });
const appliedBody = await applied.json();
check('the owner can write an account policy', applied.status === 200 && appliedBody.applied === true, `${applied.status} ${JSON.stringify(appliedBody)}`);
check('and it lands in the primary', JSON.stringify(storedRecord('cents-cloud', SAM_KEY)?.content?.settings?.enabledTabs) === '["dashboard","history"]', JSON.stringify(storedRecord('cents-cloud', SAM_KEY)?.content?.settings));
check('and in that account mirror too', JSON.stringify(JSON.parse(mirrors.get('data-sam.json')).settings.enabledTabs) === '["dashboard","history"]');
const samSees = await (await call('GET', null, 'sam-password-123456', 'sam')).json();
check('and the account device reads it back', JSON.stringify(samSees.content?.settings?.enabledTabs) === '["dashboard","history"]', JSON.stringify(samSees.content?.settings));
check('the policy write did not disturb the entries', JSON.stringify(samSees.content?.entries) === '[]');
// An account the owner invites may never have synced: there is no document to
// carry a policy then, which is not an error — the next invite carries it.
process.env.APP_PASSWORD_KATE = 'kate-password-12345';
const pending = await (await policy({ action: 'policy', profile: 'kate', enabledTabs: ['dashboard'] })).json();
check('a never-synced account reports pending, not failure', pending.pending === true, JSON.stringify(pending));
check('and no document is invented for it', storedRecord('cents-cloud', 'doc/kate.json') === null);
delete process.env.APP_PASSWORD_KATE;

if (fails.length) {
  console.error(`test-cloud: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`test-cloud: OK — ${pass} checks passed (Blobs is the primary, GitHub the mirror, and the version token decides conflicts)`);
