#!/usr/bin/env node
/**
 * Cloud storage contract test — the durable path.
 *
 * `netlify/functions/lib/cloud.mjs` keeps each profile's document in the
 * deployment's durable store (the KV namespace, reached through a module the
 * Worker hands in) and mirrors it into GitHub when a mirror is configured.
 * Nothing is auto-detected from the host, so every other test exercises only
 * the fallback branch, where the GitHub mirror is the commit point. That
 * leaves the code that actually runs in production as the one path no test
 * reaches — which is what `useBlobsModule` in lib/store.mjs exists for: this
 * file hands the store a durable, getStore-compatible module and drives the
 * REAL sync and profiles-admin handlers against it, with a stubbed GitHub
 * API, no network and nothing written anywhere.
 *
 * What it pins down, all through the handlers the browser talks to:
 *   - a fresh deployment migrates: first read seeds Blobs from the mirror
 *   - after that the mirror is written, not read (a read touches GitHub zero times)
 *   - the primary is genuinely primary (GitHub down, reads still work)
 *   - a save commits the primary first and hands the mirror off afterwards, so
 *     the backup can never lead the store that decides whether the save worked
 *     and a code host is never in the path of a keystroke
 *   - the version token is the document's hash, so an identical re-push is not
 *     a conflict while a stale or absent one is
 *   - losing the mirror is survivable; losing the primary is reported
 *   - the owner's tab policy lands where the account's device will read it
 *   - THE MIRROR GAP: every save ends by comparing the record's version against
 *     the repo blob's own bytes and recording the verdict with the document, so
 *     a mirror that silently fell behind is a fact the next reader sees — and a
 *     difference nobody has judged yet reads as pending, never as a gap
 *   - FEEDBACK: the one public write lands as `fb:cents:<uuid>` in the same
 *     namespace with a 90-day TTL, refuses oversize/empty/non-POST, and answers
 *     the honeypot without keeping anything
 *
 * Run: node scripts/test-cloud.mjs
 * Also a step in scripts/run-guards.mjs.
 */
const REPO = new URL('..', import.meta.url).href.replace(/\/$/, '');

process.env.APP_PASSWORD = 'test-password-1234';
process.env.APP_PASSWORD_SAM = 'sam-password-123456';
process.env.GITHUB_TOKEN = 'stub-token';
// The root secret the owner's invite links are encrypted with (see
// lib/secret.mjs). 16+ characters, because shorter is refused as key material.
process.env.CENTS_SECRET = 'cents-root-secret-for-tests';
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
const { versionOf, classifyMirror, MIRROR_STATES } = await import(REPO + '/netlify/functions/lib/cloud.mjs');

// ---- stub the GitHub Contents API the mirror talks to -----------------------
// It enforces the two rules the real API does, because the mirror's retry logic
// exists precisely for them: a write must carry the current sha, and a sha that
// has moved is a conflict.
const mirrors = new Map(); // file → text
const shas = new Map();    // file → sha
let nextSha = 0;
// When set, every PUT waits on it before it touches the mirror. The hand-off
// test at the end opens it by hand, which is how "the answer came back while the
// mirror write was still open" is proven instead of timed.
let gate = null;
// When set, a PUT stores this INSTEAD of what it was handed — a second writer
// winning the race. It is the reason the gap check reads the blob back rather
// than trusting the write's own answer, which in this case is a cheerful 200.
let overwrite = null;
const gh = { calls: [], broken: null };
// `/repos/<owner>/<repo>/contents/<file>?ref=<branch>` → `<file>`. Anchored on
// `contents/` (not `repos/`) and cut at the query, so a read and the write that
// follows it land on the same key.
const fileOf = url => (/\/contents\/([^?]+)/.exec(String(url)) || [undefined, '?'])[1].split('/').map(decodeURIComponent).join('/');
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
    if (gate) await gate;
    const body = JSON.parse(opts.body);
    if (mirrors.has(file)) {
      if (!body.sha) return json({ message: 'sha was not supplied' }, 422);
      if (body.sha !== shas.get(file)) return json({ message: 'does not match' }, 409);
    }
    mirrors.set(file, overwrite != null ? overwrite : Buffer.from(body.content, 'base64').toString('utf8'));
    const sha = `sha-${++nextSha}`;
    shas.set(file, sha);
    return json({ content: { sha }, commit: { sha: 'commit-' + sha } });
  }
  return new Response('unexpected ' + method, { status: 500 });
};

const { default: sync } = await import(REPO + '/netlify/functions/sync.mjs');
const { default: admin } = await import(REPO + '/netlify/functions/profiles-admin.mjs');

const call = (method, body, password = 'test-password-1234', profile = null, context = {}) => sync(new Request(
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
), context);
// The on-demand gap check — the request the app's Data menu makes.
const mirrorCheck = (password = 'test-password-1234', profile = null) => sync(new Request(
  'https://cents.test/.netlify/functions/sync?mirror=1',
  {
    method: 'GET',
    headers: { 'x-cents-password': password, ...(profile ? { 'x-cents-profile': profile } : {}) },
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

// ---- the save is bounded by the primary; the mirror follows it --------------
// A save waits on the store that decides whether it worked and on nothing else,
// and the backup never leads that store. Two things carry the weight here: the
// record ends up holding the sha the mirror ANSWERED with (so the next save
// updates the mirror in one call instead of colliding with its own last write),
// and a caller that can hand work to the platform is answered while the mirror
// PUT is still open.
check('the record carries the sha the mirror answered with',
  storedRecord('cents-cloud', DOC_KEY)?.ghSha === shas.get('data.json'),
  `${storedRecord('cents-cloud', DOC_KEY)?.ghSha} vs ${shas.get('data.json')}`);
gh.calls.length = 0;
const oneCall = await (await call('PUT', { content: { ...edited, settings: { monthlyBudget: 810 } }, sha: after.sha })).json();
// Exactly one PUT, and it comes FIRST: the sha the last write answered with is
// on the record, so this save updates the mirror without reading it back to find
// out what it is holding. (The GET that follows is the gap check, which has to
// come after the write it judges — see the section on it below.)
check('a save after a mirror write updates the mirror in one call',
  (gh.calls[0] || '').startsWith('PUT') && gh.calls.filter(c => c.startsWith('PUT')).length === 1,
  gh.calls.join(', '));
check('and still answers with the new token', !oneCall.conflict && !!oneCall.sha, JSON.stringify(oneCall));

let openGate = null;
gate = new Promise(resolve => { openGate = resolve; });
const handedOff = [];
gh.calls.length = 0;
const quick = await call(
  'PUT',
  { content: { ...edited, settings: { monthlyBudget: 830 } }, sha: oneCall.sha },
  'test-password-1234', null, { waitUntil: promise => handedOff.push(promise) },
);
const quickBody = await quick.json();
check('a save is not gated on the mirror', !quickBody.conflict && !!quickBody.sha, JSON.stringify(quickBody));
check('and the primary already holds the document', storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 830);
check('and it says so rather than naming a commit it does not have yet', quickBody.commit === null, String(quickBody.commit));
check('while the mirror write is still open',
  handedOff.length === 1 && gh.calls.some(c => c.startsWith('PUT'))
    && JSON.parse(mirrors.get('data.json')).settings.monthlyBudget === 810,
  gh.calls.join(', '));
openGate();
await handedOff[0];
check('the handed-off mirror write lands on its own',
  JSON.parse(mirrors.get('data.json')).settings.monthlyBudget === 830,
  String(mirrors.get('data.json')).slice(0, 100));
check('and the record learns that sha once it does',
  storedRecord('cents-cloud', DOC_KEY)?.ghSha === shas.get('data.json'),
  `${storedRecord('cents-cloud', DOC_KEY)?.ghSha} vs ${shas.get('data.json')}`);
gate = null;

// ---- the primary is genuinely primary --------------------------------------
gh.calls.length = 0;
gh.broken = 'all';
const offline = await call('GET');
const offlineBody = await offline.json();
check('reads keep working with GitHub entirely down', offline.status === 200 && offlineBody.content?.settings?.monthlyBudget === 830, `got ${offline.status}`);
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
gh.calls.length = 0;
const brokenPrimary = await call('PUT', { content: { ...edited, settings: { monthlyBudget: 900 } }, sha: current });
const brokenBody = await brokenPrimary.json();
check('losing the primary fails the save instead of reporting success', brokenPrimary.status === 502, `got ${brokenPrimary.status}`);
check('and the refusal explains itself rather than being a bare internal error', /Saving to the cloud failed/.test(brokenBody.error || ''), JSON.stringify(brokenBody));
check('and a save the primary refused never reached the mirror',
  !gh.calls.some(c => c.startsWith('PUT')),
  gh.calls.join(', '));
check('so the backup still holds only what the store accepted',
  JSON.parse(mirrors.get('data.json')).settings.monthlyBudget === 830,
  String(mirrors.get('data.json')).slice(0, 100));
const duringOutage = await (await call('GET')).json();
// The mirror holds the NEWER 830 here, so answering 820 is what says this read
// came from the primary — the same store the refused write could not reach.
check('and reads still answer from the primary, not the newer backup copy',
  duringOutage.content?.settings?.monthlyBudget === 820
    && JSON.parse(mirrors.get('data.json')).settings.monthlyBudget === 830,
  JSON.stringify(duringOutage.content?.settings));

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

// ---- the mirror gap: measured after every save, and written down -----------
// A save commits to the store and hands the mirror to waitUntil, so the repo can
// lag the record in SILENCE — the failure is logged, never returned, because a
// code host must not fail somebody's save. That silence is the whole problem
// this section covers: every save now ends by reading the blob back and
// comparing its hash with the record's version, and the verdict is recorded with
// the document, where the app's Data menu can read it.
//
// The vocabulary itself is pure, so it is pinned in one place before any of the
// plumbing is exercised — every branch the classifier can take, and the fact
// that each one is a state the consumers know.
const vocabulary = [
  classifyMirror({ recordExists: false }),
  classifyMirror({ recordExists: true, blobExists: null }),
  classifyMirror({ recordExists: true, blobExists: false }),
  classifyMirror({ recordExists: true, blobExists: true, recordVersion: 'a', mirrorVersion: 'a' }),
  classifyMirror({ recordExists: true, blobExists: true, recordVersion: 'a', mirrorVersion: 'b', wrote: null }),
  classifyMirror({ recordExists: true, blobExists: true, recordVersion: 'a', mirrorVersion: 'b', wrote: true }),
  classifyMirror({ recordExists: true, blobExists: true, recordVersion: 'a', mirrorVersion: 'b', wrote: false }),
];
check('every comparison the classifier can make is a state its consumers know',
  vocabulary.every(s => MIRROR_STATES.includes(s)), vocabulary.join(', '));
check('and the seven branches are seven different answers',
  new Set(vocabulary).size === 7, vocabulary.join(', '));

// A save whose mirror write lands: the two agree, and the record says so.
const at950 = await (await call('GET')).json();
const settled = await (await call('PUT', { content: { ...edited, settings: { monthlyBudget: 960 } }, sha: at950.sha })).json();
let rec = storedRecord('cents-cloud', DOC_KEY);
check('a save records a mirror verdict with the document',
  rec.mirror?.state === 'in_sync', JSON.stringify(rec.mirror));
check('and the verdict names the version it judged rather than just saying "fine"',
  rec.mirror?.recordVersion === rec.version && rec.mirror.mirrorVersion === rec.version,
  JSON.stringify({ verdict: rec.mirror, record: rec.version }));
check('and says whether the write it judged actually landed',
  rec.mirror?.wrote === true, String(rec.mirror?.wrote));
check('and the answer to that save carries the same verdict as the record',
  settled.mirror?.state === 'in_sync', JSON.stringify(settled.mirror));

// A plain read hands the recorded verdict back for free: it rode along with the
// record the read already fetched, and a read that measured would make every
// poll cost a GitHub round trip.
gh.calls.length = 0;
const verdictRead = await (await call('GET')).json();
check('a plain read hands back the recorded verdict',
  verdictRead.mirror?.state === 'in_sync', JSON.stringify(verdictRead.mirror));
check('without measuring anything to do it', gh.calls.length === 0, gh.calls.join(', '));

// The on-demand check the Data menu asks for: the verdict alone, no document.
gh.calls.length = 0;
const live = await (await mirrorCheck()).json();
check('an on-demand check answers with a verdict and no document',
  live.mirror?.state === 'in_sync' && live.content === undefined,
  JSON.stringify(live).slice(0, 200));
check('and it compares the record against the blob and reads nothing else',
  gh.calls.join(', ') === 'GET data.json', gh.calls.join(', '));

// The gap itself: a save whose mirror write was refused still commits, and this
// time the refusal is a fact on the record instead of a line in a log.
gh.broken = 'put';
const missedMirrorRes = await call('PUT', { content: { ...edited, settings: { monthlyBudget: 970 } }, sha: settled.sha });
const missedMirror = await missedMirrorRes.json();
rec = storedRecord('cents-cloud', DOC_KEY);
check('a save the mirror refused is recorded as a gap, not as a pass',
  rec.mirror?.state === 'behind' && rec.mirror.wrote === false, JSON.stringify(rec.mirror));
check('the verdict names the older blob it found in the repo',
  rec.mirror.mirrorVersion === versionOf(mirrors.get('data.json')) && rec.mirror.mirrorVersion !== rec.version,
  JSON.stringify({ mirror: rec.mirror.mirrorVersion, record: rec.version }));
check('and the answer to that save says the same thing',
  missedMirror.mirror?.state === 'behind', JSON.stringify(missedMirror.mirror));
check('while the save itself still succeeded, which is the whole point',
  missedMirrorRes.status === 200 && !missedMirror.conflict
    && storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 970,
  `${missedMirrorRes.status} ${JSON.stringify(missedMirror).slice(0, 120)}`);
gh.broken = null;
const stillGap = await (await mirrorCheck()).json();
check('an on-demand check reports the same gap',
  stillGap.mirror?.state === 'behind', JSON.stringify(stillGap.mirror));

// A write that reported success is not the same as the repo holding it. This is
// the case the read-back exists for: the PUT answered 200, and the blob is
// somebody else's version — which only a comparison can tell you.
overwrite = JSON.stringify({ ...edited, settings: { monthlyBudget: 1 } });
const stolen = await (await call('PUT', { content: { ...edited, settings: { monthlyBudget: 980 } }, sha: stillGap.mirror.recordVersion })).json();
overwrite = null;
rec = storedRecord('cents-cloud', DOC_KEY);
check('a mirror that answered success but holds another version reports diverged',
  rec.mirror?.state === 'diverged' && rec.mirror.wrote === true, JSON.stringify(rec.mirror));
check('and that verdict is not the one the write believed',
  stolen.mirror?.state === 'diverged', JSON.stringify(stolen.mirror));

// The file being gone is its own answer, with its own remedy (a path or a
// credential), and must not be reported as a mirror that is merely old.
mirrors.delete('data.json');
const gone = await (await mirrorCheck()).json();
check('a repo with no file at that path reports missing',
  gone.mirror?.state === 'missing' && gone.mirror.mirrorVersion === null, JSON.stringify(gone.mirror));

// A difference NOBODY has judged yet is pending, not a gap. This is a real,
// repeatable state rather than a race to paper over: a save answers before its
// mirror write, so a check taken a second later lands here.
mirrors.set('data.json', JSON.stringify({ ...edited, settings: { monthlyBudget: 2 } }));
shas.set('data.json', 'sha-other');
rec = storedRecord('cents-cloud', DOC_KEY);
rec.mirror = null;
backing.get('cents-cloud').set(DOC_KEY, JSON.stringify(rec));
const unclaimed = await (await mirrorCheck()).json();
check('a difference nobody has judged yet is pending, not a gap',
  unclaimed.mirror?.state === 'pending', JSON.stringify(unclaimed.mirror));

// A code host that cannot be read is "not checked" — which is not a pass: the
// one answer this may never give is a reassuring one it cannot support.
gh.broken = 'all';
const blind = await (await mirrorCheck()).json();
check('a repo that cannot be read reports unverifiable rather than fine',
  blind.mirror?.state === 'unverifiable', JSON.stringify(blind.mirror));
gh.broken = null;

// Nothing saved yet is not a gap either, and neither is a deployment with no
// mirror at all: each has a remedy of its own, and inventing a failure for them
// would train the reader to ignore the line.
backing.get('cents-cloud').delete(DOC_KEY);
check('with no document there is nothing to compare',
  (await (await mirrorCheck()).json()).mirror?.state === 'no_document');
const savedToken = process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;
gh.calls.length = 0;
const unmirrored = await (await mirrorCheck()).json();
check('with no mirror configured the check says so and calls nobody',
  unmirrored.mirror?.state === 'unconfigured' && gh.calls.length === 0, gh.calls.join(', '));
process.env.GITHUB_TOKEN = savedToken;

// ---- no mirror configured is a supported shape, not an outage --------------
// Last, because it empties one profile's document on purpose. A deployment with
// no token has no mirror at all (lib/gh.mjs's mirrorConfigured), which is the
// same "one durable primary" shape the site ran on with Blobs — so a missing
// document must read as absent, and a save must still commit. Reporting either
// one as a code host that failed would make a deployment that never had a token
// look permanently broken.
//
// The same is true of the shape every LOCAL run has: `wrangler pages dev` reads
// a repo's `.dev.vars` but NOT wrangler.toml's `[vars]`, so a local deployment
// has no repo coordinates at all while its KV is bound and its password is
// right. Refusing the request for that (the `REPO_OWNER / REPO_NAME env vars not
// set on the function` 500 the Sync screen used to show) failed a deployment
// whose cloud copy was working, so both halves of the mirror's configuration go
// away here, not just the token.
const savedMirrorEnv = ['GITHUB_TOKEN', 'REPO_OWNER', 'REPO_NAME', 'REPO_BRANCH', 'REPO_FILE']
  .map(name => [name, process.env[name]]);
for (const [name] of savedMirrorEnv) delete process.env[name];
gh.calls.length = 0;
gh.broken = 'all';
backing.get('cents-cloud').delete(DOC_KEY);
const noMirrorRead = await call('GET');
const noMirrorReadBody = await noMirrorRead.json();
check('with no mirror configured, a missing document reads as absent, not as an error',
  noMirrorRead.status === 200 && noMirrorReadBody.content === null && noMirrorReadBody.sha === null,
  `${noMirrorRead.status} ${JSON.stringify(noMirrorReadBody)}`);
check('and it never calls a code host it has no credential for', gh.calls.length === 0, gh.calls.join(', '));
check('and it names the missing mirror instead of refusing the read',
  noMirrorReadBody.mirrorConfigured === false, String(noMirrorReadBody.mirrorConfigured));
const noMirrorSave = await call('PUT', { content: { version: 2, entries: [], settings: { monthlyBudget: 1234 } }, sha: null });
check('and the store still commits the save',
  noMirrorSave.status === 200 && storedRecord('cents-cloud', DOC_KEY)?.content?.settings?.monthlyBudget === 1234,
  `got ${noMirrorSave.status}`);
const noMirrorCheck = await (await mirrorCheck()).json();
check('and the on-demand mirror check answers unconfigured, not an error',
  noMirrorCheck.mirror?.state === 'unconfigured', JSON.stringify(noMirrorCheck.mirror));
for (const [name, value] of savedMirrorEnv) if (value === undefined) delete process.env[name]; else process.env[name] = value;
gh.broken = null;

// ---- feedback: the one route that writes a raw, expiring key -----------------
// It is the app's only public write and its only key that is SUPPOSED to
// vanish, so both halves are pinned: what lands in KV (prefix, shape, TTL) and
// what the route refuses (non-POST, oversize, empty, honeypot). It reaches the
// namespace directly rather than through the Blobs-shaped store, because that
// wrapper cannot carry `expirationTtl` — which is why this test injects the raw
// namespace instead of reusing `fakeBlobs`.
const { useFeedbackKv } = await import(REPO + '/netlify/functions/lib/feedback-kv.mjs');
const { default: feedback, FEEDBACK_TTL } = await import(REPO + '/netlify/functions/feedback.mjs');

const feedbackPuts = [];
const fakeFeedbackKv = {
  async get() { return null; },
  async put(key, value, options) { feedbackPuts.push({ key, value, options }); },
};
useFeedbackKv(fakeFeedbackKv);

const fb = (method, body) => feedback(new Request('https://cents.test/api/feedback', {
  method,
  headers: { 'content-type': 'application/json' },
  ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
}), {});

const accepted = await fb('POST', { message: '  the calendar is a day out  ' });
const acceptedBody = await accepted.json();
const written = feedbackPuts[0];
let storedNote = null;
try { storedNote = JSON.parse(written.value); } catch { /* failed below */ }
check('feedback accepts a message and answers 201',
  accepted.status === 201 && acceptedBody.ok === true, `${accepted.status} ${JSON.stringify(acceptedBody)}`);
check("it stores under fb:cents:<id>, under no other site's prefix",
  /^fb:cents:[0-9a-f-]{36}$/.test(written?.key || ''), String(written?.key));
check('the stored note is the trimmed message, its source and an ISO timestamp',
  storedNote?.message === 'the calendar is a day out' && storedNote?.source === 'cents'
    && /^\d{4}-\d{2}-\d{2}T/.test(storedNote?.createdAt || ''), JSON.stringify(storedNote));
check('the key expires in 90 days — the TTL is part of the contract, not a default',
  written?.options?.expirationTtl === FEEDBACK_TTL && FEEDBACK_TTL === 60 * 60 * 24 * 90,
  String(written?.options?.expirationTtl));
check('and the answer is uncacheable JSON',
  accepted.headers.get('cache-control') === 'no-store'
    && (accepted.headers.get('content-type') || '').startsWith('application/json'),
  `${accepted.headers.get('cache-control')} / ${accepted.headers.get('content-type')}`);

const writesBeforeSpam = feedbackPuts.length;
const honeypot = await fb('POST', { message: 'buy my thing', website: 'https://spam.example' });
check('the honeypot answers like a success and writes nothing',
  honeypot.status === 202 && (await honeypot.json()).ok === true && feedbackPuts.length === writesBeforeSpam,
  `${honeypot.status} / writes ${feedbackPuts.length - writesBeforeSpam}`);

check('an empty message is refused', (await fb('POST', { message: '   ' })).status === 400);
check('a 2001-character message is refused', (await fb('POST', { message: 'x'.repeat(2001) })).status === 400);
check('a body over 4 KB is refused', (await fb('POST', { message: 'x'.repeat(5000) })).status === 413);
check('malformed JSON is a 400, not a 500', (await fb('POST', '{not json')).status === 400);
check('GET is not a write path', (await fb('GET')).status === 405);

useFeedbackKv(null);
const unbound = await fb('POST', { message: 'hello' });
check('with no KV bound it says so instead of throwing',
  unbound.status === 503 && (await unbound.json()).error === 'Feedback is not configured', String(unbound.status));
useFeedbackKv(fakeFeedbackKv);

if (fails.length) {
  console.error(`test-cloud: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`test-cloud: OK — ${pass} checks passed (the store is the primary, GitHub the mirror when one is configured, the version token decides conflicts, and feedback writes one expiring key)`);
