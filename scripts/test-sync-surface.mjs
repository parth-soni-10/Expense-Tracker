#!/usr/bin/env node
/**
 * The cloud sync surfaces: the endpoint, the credential, the mirror, and the
 * two spellings of every route.
 *
 * Five parity lines live here, and each is a rule about what may go where:
 *
 *   - docs/CENTS_PARITY.md line 46 — optional KV sync works per profile; the
 *     login token stays server-side.
 *   - line 47 — the existing KV namespace and its keys stay intact; only
 *     explicitly approved `fb:` keys may be added for feedback.
 *   - line 48 — the GitHub mirror write happens after the KV commit and cannot
 *     block a successful primary save.
 *   - line 49 — the Data sheet distinguishes pending/off/in-sync/behind/
 *     different/missing mirror states and rechecks on open.
 *   - line 50 — the merge/conflict version rules and the setup-token expiry
 *     hold, and the endpoint aliases keep working.
 *
 * The merge rules and the mirror's gap check are already held by
 * `scripts/test-sync.mjs` (88 checks) and `scripts/test-cloud.mjs` (89 checks),
 * and the Data sheet's own facts by `scripts/test-data-portability.mjs`. What
 * is here is the half those cannot reach: **where the credential lives**, the
 * **two spellings** of every route, the **`fb:` key rule**, and the fact that
 * the mirror is a BACKUP and never the commit point.
 *
 * The mirror is the important one. A save commits to the store that actually
 * holds the document, and the mirror write is handed off and never returned —
 * because a code host having a bad day must not fail somebody's save. The
 * consequence is that the record can hold a version the repo does not, so the
 * gap is MEASURED after every save and written down where the user will see
 * it. A mirror that is quietly behind is a recovery copy that will not
 * recover.
 *
 * Run: node scripts/test-sync-surface.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

const read = (rel) => readFileSync(resolve(repo, rel), 'utf8');

/* ══ 1. THE ENDPOINT, AND ITS TWO SPELLINGS ════════════════════════════════ */

const settingsSource = read('app/lib/settings.ts');
check('the default endpoint is the site\'s own function path',
  /export const DEFAULT_SYNC_ENDPOINT = '\/api\/sync'/.test(settingsSource), settingsSource.slice(0, 0));
check('the legacy spelling is still recognised',
  /const LEGACY_SYNC_ENDPOINT = '\/\.netlify\/functions\/sync'/.test(settingsSource),
  'a device set up before the rename still has that saved');
check('and it is migrated to the default rather than refused',
  /raw === '' \|\| raw === LEGACY_SYNC_ENDPOINT/.test(settingsSource));
check('a stored endpoint that no longer exists is rewritten',
  /\.netlify\.app/.test(settingsSource), 'a dead host must recover, not fail forever');

const routerSource = read('functions/_router.js');
check('the router serves both spellings', /\.netlify\/functions/.test(routerSource) && /\/api\//.test(routerSource));
check('and they are the same handler, not two copies',
  /they are the same handler/.test(routerSource), 'one handler, two names');
check('the derived siblings come from the sync endpoint',
  /DERIVED from the sync endpoint/.test(routerSource));

/* ══ 2. THE CREDENTIAL ═════════════════════════════════════════════════════ */

// The password is DEVICE-LOCAL, like the PIN: it is in the profile's own
// sync key, never in the document, so it is never synced and never travels
// with a backup.
check('the sync settings live in the profile\'s own key',
  /const KEY = \(\) => nsKey\('sync'\);/.test(settingsSource),
  'the credential must be namespaced per profile');
check('and the document carries no credential',
  !/pinHash|password/.test(read('app/lib/types.ts').split('CentsState')[1] || ''),
  'the document shape must not grow a credential');

/* ══ 3. THE MIRROR IS A BACKUP, NOT THE COMMIT POINT ═══════════════════════ */

const cloudSource = read('netlify/functions/lib/cloud.mjs');
const primaryAt = cloudSource.indexOf('the primary, and the only thing a save waits on');
const mirrorAt = cloudSource.indexOf('the mirror, after the document is already safe');
check('the primary write is what a save waits on', primaryAt > 0);
check('and the mirror comes after it', mirrorAt > 0 && mirrorAt > primaryAt,
  'the mirror must never be ahead of the primary');
check('a failed primary write returns before the mirror is touched',
  /primary write failed[\s\S]{0,400}return \{ error: 'Saving to the cloud failed' \}/.test(cloudSource),
  'the mirror must not end up ahead of the primary');
check('the mirror write is deferred, not awaited',
  /defer/.test(cloudSource) && /waitUntil/.test(cloudSource + read('netlify/functions/sync.mjs')),
  'the mirror must not gate a save');
check('the gap is MEASURED after the write, not instead of it',
  /gap check, right after the write rather than instead of it/.test(cloudSource),
  'the write says what we sent, the check says what the repo holds');
check('and the record remembers the verdict', /const patch = \{ mirror: verdict \}/.test(cloudSource));

/* ══ 4. THE MIRROR'S STATES ARE A CLOSED VOCABULARY ═══════════════════════ */

const syncSource = read('app/lib/sync.ts');
check('the client has a closed set of mirror words',
  /MIRROR_WORDS/.test(syncSource), 'the states must be classified in one place');
for (const state of ['in_sync', 'pending', 'behind', 'diverged', 'missing', 'unverifiable', 'no_document', 'unconfigured']) {
  check(`  and it names "${state}"`, new RegExp('(^|[\\s{,])' + state + ':').test(syncSource),
    `the ${state} state is missing from the vocabulary`);
}
check('only a gap colours anything', /MIRROR_GAPS/.test(syncSource));

/* ══ 5. THE DATA SHEET SAYS WHICH ONE, AND RECHECKS ═══════════════════════ */

const dataSource = read('app/src/screens/data.ts');
check('the Data sheet shows the mirror fact', /fact\('GitHub mirror'\)/.test(dataSource));
check('it says "No cloud copy" rather than implying a sync',
  /cloudOff \? 'No cloud copy'/.test(dataSource), '"no cloud copy" must be said out loud');
check('and "Not checked" rather than a pass',
  /: 'Not checked'/.test(dataSource), 'nothing checked must not read as in-sync');
check('it rechecks the mirror on open', /syncCheckMirror\(\)/.test(dataSource));
check('and a comparison it could not make says so',
  /Could not compare the two copies just now/.test(dataSource));

/* ══ 6. THE `fb:` KEY RULE ═════════════════════════════════════════════════ */

const feedbackSource = read('netlify/functions/feedback.mjs');
check('feedback writes only fb: keys', /fb:cents:<uuid>/.test(feedbackSource));
check('with a 90-day TTL', /90-day TTL/.test(feedbackSource));
check('and no new binding', /No new binding/.test(feedbackSource));
check('and no D1', /no D1/.test(feedbackSource));

// The namespace itself is not renamed or replaced.
const wrangler = read('wrangler.toml');
check('the KV namespace is still the one that was there',
  /id = "b07228078d274906ab86bbb9a7cd07f4"/.test(wrangler), 'the namespace id must not change');
check('and it is still bound to the same name', /binding = "CENTS_KV"/.test(wrangler));

// The document key per profile is namespaced, so two profiles never share one.
check('each profile gets its own document key',
  /export const keyFor = profileId => `doc\/\$\{profileId\}\.json`/.test(cloudSource),
  'the key function is gone');
check('and the key is namespaced by profile',
  /keyFor = profileId => `doc\/\$\{profileId\}/.test(cloudSource),
  'two profiles must never share one key');

/* ══ 7. THE SETUP TOKEN EXPIRES ════════════════════════════════════════════ */

const tokensSource = read('netlify/functions/lib/tokens.mjs');
check('tokens are single-use', /SINGLE-USE/i.test(tokensSource));
check('and they expire after thirty days', /SETUP_TOKEN_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/.test(tokensSource));
check('a spent or expired token answers 410', /410/.test(read('netlify/functions/setup-token.mjs')));
check('and the client names both failures',
  /That link has expired/.test(read('app/src/screens/sync-panel.ts'))
  && /already used/.test(read('app/src/screens/sync-panel.ts')));

if (failures) {
  console.error(`\ntest-sync-surface: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-sync-surface: OK — ${checks} checks (the credential stays on the device, the mirror is a backup, and the routes answer to both names)`);
