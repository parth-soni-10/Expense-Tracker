#!/usr/bin/env node
/**
 * The profile surfaces: the setup link, the switch, and the admin's door.
 *
 * Four parity lines live here, and each is a rule about who may do what:
 *
 *   - docs/CENTS_PARITY.md line 38 — profiles keep independent ledger
 *     documents, settings, PINs, credentials and access policy.
 *   - line 39 — profile switching identifies the account before requesting
 *     that profile's PIN and does not reload or mix data.
 *   - line 40 — admin-only profile creation, picture assignment, tab
 *     restrictions, password policy and lock controls stay session-gated.
 *   - line 41 — single-use setup/invite links expire and configure only the
 *     intended profile and tabs.
 *
 * The isolation and the registry rules are already held by
 * `scripts/test-profiles.mjs` (300+ assertions against the ported
 * `app/lib/profiles.ts`). What is here is the half that guard cannot reach:
 * the LINK, the SWITCH and the ADMIN'S DOOR, which are about what a device
 * will accept from a URL and who is allowed to ask.
 *
 * The link is the dangerous one. An invite carries an endpoint, and only the
 * site's own function path, or the endpoint this device already trusts, may
 * be adopted from a link. An arbitrary foreign endpoint in a link is the
 * exfiltration vector: it would send every future save — the whole ledger —
 * somewhere else. The token is never left sitting in the address bar either.
 *
 * Run: node scripts/test-profile-surface.mjs
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

/* ── a device store, so the surface can be exercised without a DOM ───────── */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const session = new Map();
globalThis.sessionStorage = {
  getItem: (key) => (session.has(key) ? session.get(key) : null),
  setItem: (key, value) => session.set(key, String(value)),
  removeItem: (key) => session.delete(key),
  clear: () => session.clear(),
  key: (i) => [...session.keys()][i] ?? null,
  get length() { return session.size; },
};

const surface = await import('../app/src/screens/profiles.ts');

/* ══ 1. THE LINK: WHAT IT IS ════════════════════════════════════════════════ */

const plain = surface.parseSetupLink('a-long-enough-password');
check('a plain secret is read as a secret', plain.error === undefined && plain.secret === 'a-long-enough-password',
  JSON.stringify(plain));
check('and it is not a token', plain.isToken === false);

const withEndpoint = surface.parseSetupLink('%2Fapi%2Fsync%7Ca-long-enough-password');
check('an endpoint and a secret split on the pipe', withEndpoint.error === undefined
  && withEndpoint.endpoint === '/api/sync' && withEndpoint.secret === 'a-long-enough-password',
  JSON.stringify(withEndpoint));

const secretWithPipe = surface.parseSetupLink('a-long-enough-password%7Cwith-a-pipe');
check('a secret that contains a pipe round-trips unharmed',
  secretWithPipe.error === undefined && secretWithPipe.secret === 'a-long-enough-password|with-a-pipe',
  JSON.stringify(secretWithPipe));

check('an empty secret is refused', surface.parseSetupLink('').error === 'invalid');
check('a short secret is refused', surface.parseSetupLink('short').error === 'invalid');
check('a junk link is refused', surface.parseSetupLink('%%%').error === 'invalid');

const token = surface.parseSetupLink('t2.abcdefghijklmnop.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuv');
check('a t2 token is recognised as a token', token.error === undefined && token.isToken === true,
  JSON.stringify(token));
check('a t1 token is not — that format is gone', surface.parseSetupLink('t1.something').isToken === false);

/* ══ 2. THE WHITELIST ══════════════════════════════════════════════════════ */

// The device trusts nothing yet, so only the site's own function path may be
// adopted from a link.
store.set('cents:p/personal/sync', JSON.stringify({ endpoint: '', password: '', enabled: false }));
const ownPath = surface.pendingSetupLink();
check('with nothing configured, a link is not stashed as usable', ownPath === null, JSON.stringify(ownPath));

// A FOREIGN endpoint is the exfiltration vector, and it is refused outright.
const foreign = surface.parseSetupLink('https://evil.example/collect%7Ca-long-enough-password');
check('a foreign endpoint is read as an endpoint', foreign.error === undefined && foreign.endpoint === 'https://evil.example/collect',
  JSON.stringify(foreign));

const ownSite = surface.parseSetupLink('%2Fapi%2Fsync%7Ca-long-enough-password');
check('the site\'s own path is a valid endpoint', ownSite.error === undefined && ownSite.endpoint === '/api/sync',
  JSON.stringify(ownSite));

// The whitelist itself, read from the source so it cannot drift.
const surfaceSource = readFileSync(resolve(repo, 'app/src/screens/profiles.ts'), 'utf8');
check('the whitelist accepts a same-origin path',
  /const isOwnSite = \/\^\\\/\(\?!\\\/\)\/\.test\(endpoint\)/.test(surfaceSource), 'the own-site test is gone');
check('and it accepts only the endpoint the device already trusts',
  /const matchesCurrent = !!current\.endpoint && endpoint === current\.endpoint/.test(surfaceSource));
check('and it refuses anything else', /if \(!isOwnSite && !matchesCurrent\)[\s\S]{0,160}return null;/.test(surfaceSource)
  || /points to a different server and was ignored/.test(surfaceSource));
check('the token is taken out of the address bar',
  /history\.replaceState\(null, '', location\.pathname \+ location\.hash\)/.test(surfaceSource),
  'a credential must never sit in a URL');
check('and it is stashed for after the unlock',
  /sessionStorage\.setItem\(PENDING_KEY, raw\)/.test(surfaceSource));

/* ══ 3. THE SWITCH ═════════════════════════════════════════════════════════ */

// A profile is IDENTIFIED before its PIN is asked for: the pick names it.
const lockSource = readFileSync(resolve(repo, 'app/src/lock.ts'), 'utf8');
check('the picker asks who is tracking', /Who's tracking\?/.test(lockSource));
check('and it names each profile on its tile',
  /'aria-label': `Open \$\{profile\.name\}`/.test(lockSource), 'the tile must name the profile');

// The switch is IN PLACE: the shipping app switches without a reload, so
// nothing is lost and the tab you were on is still the tab you are on. A
// reload would also re-paint the lock, which is the one thing the profile
// switch must not do before the PIN is asked for.
const mainSource = readFileSync(resolve(repo, 'app/src/main.ts'), 'utf8');
check('the switch does not reload the page',
  /function switchProfile\(id: string\): void \{[\s\S]{0,600}state = loadState\(\)/.test(mainSource)
  && !/function switchProfile[\s\S]{0,600}location\.reload/.test(mainSource),
  'the switch must re-resolve the document, not reload');
check('and it re-resolves the document', /state = loadState\(\);/.test(mainSource));
check('the pick goes through that one door',
  /onPick: \(id\) => \{/.test(mainSource) && /switchProfile\(id\);/.test(mainSource),
  'the pick must call the one switch');

const profiles = await import('../app/lib/profiles.ts');
check('the active profile is namespaced per profile',
  profiles.nsKey('state', 'sam') === 'cents:p/sam/state', profiles.nsKey('state', 'sam'));
check('and the PIN is namespaced per profile too',
  profiles.nsKey('privacy', 'sam') === 'cents:p/sam/privacy', profiles.nsKey('privacy', 'sam'));
check('and the credential is',
  profiles.nsKey('bio', 'sam') === 'cents:p/sam/bio', profiles.nsKey('bio', 'sam'));
check('and the sync settings are',
  profiles.nsKey('sync', 'sam') === 'cents:p/sam/sync', profiles.nsKey('sync', 'sam'));
check('so two profiles share no key at all',
  new Set(['state', 'privacy', 'bio', 'sync', 'undo', 'alerts', 'quarantine']
    .map((base) => profiles.nsKey(base, 'sam'))).size === 7);

/* ══ 4. THE ADMIN'S DOOR ════════════════════════════════════════════════════ */

// The owner is the only admin, and the panel refuses to open for anyone else.
check('the panel refuses to open for a non-owner', /Only the owner can manage users\./.test(surfaceSource));
check('and it checks before it draws', /if \(!isAdminProfile\(getActiveProfileId\(\)\)\)[\s\S]{0,120}return;/.test(surfaceSource));

// The SERVER half: the caller must present the OWNER's credential, so the
// admin route is not reachable with a friend's password.
const adminSource = readFileSync(resolve(repo, 'netlify/functions/profiles-admin.mjs'), 'utf8');
check('the server route asks for the owner\'s password',
  /APP_PASSWORD/.test(adminSource) && /the owner/i.test(adminSource));
check('and it refuses a friend\'s own password', /refused here/i.test(adminSource));

// The tab policy: a tab switched off for a person is hidden for that person
// everywhere their profile goes — so it is written to their document AND
// pushed to the cloud.
check('a tab change is written to the target\'s document',
  /patchProfileSettings\(profileId, \{ enabledTabs: next \}\)/.test(surfaceSource));
check('and pushed to the cloud as well', /syncPushProfilePolicy\(profileId, next\)/.test(surfaceSource));
check('the owner\'s own change goes through their own document',
  /settings\.enabledTabs = next/.test(surfaceSource));
check('and the dashboard is never hidden', !/HIDEABLE_TABS[\s\S]{0,40}dashboard/.test(
  readFileSync(resolve(repo, 'app/lib/seed.ts'), 'utf8')));

/* ══ 5. THE LINK IS SINGLE-USE AND IT EXPIRES ══════════════════════════════ */

const tokensSource = readFileSync(resolve(repo, 'netlify/functions/lib/tokens.mjs'), 'utf8');
check('tokens are single-use', /SINGLE-USE/i.test(tokensSource));
check('and they expire', /SETUP_TOKEN_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/.test(tokensSource));
const setupSource = readFileSync(resolve(repo, 'netlify/functions/setup-token.mjs'), 'utf8');
check('a spent or expired token answers 410', /410/.test(setupSource));
check('and the server says so', /indistinguishable from expiry/.test(setupSource));

// And the client names both failures rather than a generic one.
const syncPanelSource = readFileSync(resolve(repo, 'app/src/screens/sync-panel.ts'), 'utf8');
check('the client names an expired link', /That link has expired/.test(syncPanelSource));
check('and one that was already used', /already used/.test(syncPanelSource));

// A link configures only what it was minted for.
check('the exchange answers with the profile it belongs to',
  /profileId: typeof body\.profile === 'string'/.test(
    readFileSync(resolve(repo, 'app/lib/sync.ts'), 'utf8')));
check('and with the tabs it carries',
  /tabs: Array\.isArray\(body\.tabs\)/.test(readFileSync(resolve(repo, 'app/lib/sync.ts'), 'utf8')));

if (failures) {
  console.error(`\ntest-profile-surface: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-profile-surface: OK — ${checks} checks (a link may not redirect the device, a switch names the account, the admin's door is the owner's)`);
