#!/usr/bin/env node
/**
 * Profile isolation harness.
 *
 * Profiles exist so one device can hold several private ledgers: separate
 * entries, balances, PINs and cloud files. That promise rests on two things
 * that are easy to break silently — the client namespacing every storage key,
 * and the sync proxy resolving a credential per profile — so both are asserted
 * here, plus the migration that moves a pre-profiles device into "personal".
 *
 * The regressions this is written against, both real:
 *   * a profile whose env var is missing falling back to APP_PASSWORD, which
 *     silently made the owner's password a master key for every profile;
 *   * a delete that removed some of a profile's keys but not all, leaving one
 *     profile's data to be read back as the next profile's.
 *
 * Run: node scripts/test-profiles.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

class MemoryStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) pass += 1;
  else failures.push(name + (detail ? ` - ${detail}` : ''));
};

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

// Every instance below is imported with a fresh query string: initProfiles()
// runs at module load, so observing a first-run path needs its own instance.

// ---------------------------------------------- 1. first run + migration
const legacyState = JSON.stringify({ entries: [{ id: 'old' }], settings: { monthlyBudget: 1100 } });
localStorage = new MemoryStorage({
  'expense-tracker:v1': legacyState,
  'cents:privacySettings': '{"pinHash":"deadbeef"}',
  'cents:syncSettings': '{"enabled":true}',
  'cents:reminder': '{"time":"19:00"}',
  'expense-tracker:unreadable': '{"entries":[',
});
const first = await import('../profiles.js?first-run');
check('a first run creates exactly the personal profile',
  JSON.stringify(first.listProfiles().map(p => p.id)) === '["personal"]', JSON.stringify(first.listProfiles()));
check('the personal profile is active', first.getActiveProfileId() === 'personal');
check('the legacy document moves into the profile',
  localStorage.getItem('cents:p/personal/state') === legacyState);
check('the legacy key is removed, not duplicated', localStorage.getItem('expense-tracker:v1') === null);
check('every legacy base is migrated',
  ['quarantine', 'privacy', 'sync', 'reminder'].every(base => localStorage.getItem(`cents:p/personal/${base}`) != null
    && localStorage.getItem({ quarantine: 'expense-tracker:unreadable', privacy: 'cents:privacySettings', sync: 'cents:syncSettings', reminder: 'cents:reminder' }[base]) === null));
check('the registry is written',
  JSON.parse(localStorage.getItem('cents:profiles')).profiles.length === 1);

// ------------------------------------------------- 2. namespacing + env name
check('the live document key is namespaced per profile',
  first.nsKey('state') === 'cents:p/personal/state', first.nsKey('state'));
check('an explicit profile id can be asked for', first.nsKey('sync', 'sam') === 'cents:p/sam/sync');
check('the default profile keeps the original env var', first.profileEnvName('personal') === 'APP_PASSWORD');
check('a second profile names its own env var', first.profileEnvName('sam-p') === 'APP_PASSWORD_SAM_P',
  first.profileEnvName('sam-p'));
check('base names never collide across profiles',
  ['state', 'quarantine', 'privacy', 'bio', 'sync', 'undo', 'alerts', 'reminder']
    .every(base => first.nsKey(base, 'sam') !== first.nsKey(base, 'personal')));

// ------------------------------------------------ 3. session choice + order
check('a fresh tab has made no profile choice', first.hasSessionChoice() === false);
sessionStorage = new MemoryStorage({ 'cents:activeProfile': 'kate' });
localStorage = new MemoryStorage({
  'cents:profiles': JSON.stringify({
    v: 1,
    profiles: [{ id: 'personal', name: 'Personal' }, { id: 'kate', name: 'Kate' }],
    lastUsedId: 'personal',
  }),
});
const choosing = await import('../profiles.js?session-order');
check('the session choice beats lastUsedId', choosing.getActiveProfileId() === 'kate', choosing.getActiveProfileId());
check('a chosen tab reports that it has chosen', choosing.hasSessionChoice() === true);
check('the registry remembers the choice for the next fresh tab',
  JSON.parse(localStorage.getItem('cents:profiles')).lastUsedId === 'kate');
check('setActiveProfileId refuses an unknown id', choosing.setActiveProfileId('nobody') === false);
check('setActiveProfileId accepts a known id and follows it', choosing.setActiveProfileId('personal') === true
  && choosing.getActiveProfileId() === 'personal');

// A session id that no longer exists must not strand the app outside every
// profile — the registry is the source of truth.
sessionStorage = new MemoryStorage({ 'cents:activeProfile': 'deleted-long-ago' });
const stale = await import('../profiles.js?stale-session');
check('a stale session id falls back to the registry', stale.getActiveProfileId() === 'personal', stale.getActiveProfileId());

// ------------------------------------------- 4. registry mutations (rules)
const reg = (profiles, lastUsedId = profiles[0].id) => new MemoryStorage({
  'cents:profiles': JSON.stringify({ v: 1, profiles, lastUsedId }),
});
localStorage = reg([{ id: 'personal', name: 'Personal' }]);
sessionStorage = new MemoryStorage();
const m = await import('../profiles.js?mutations');
check('an empty name is refused', !!m.createProfile('   ').error);
check('an over-long name is refused', !!m.createProfile('x'.repeat(25)).error);
check('a name with no usable characters is refused', !!m.createProfile('!!!').error);
const made = m.createProfile('Sam P.');
check('a valid name is accepted and slugged', made.profile?.id === 'sam-p', JSON.stringify(made));
check('a duplicate name is refused', !!m.createProfile('sam p.').error);
const colliding = m.createProfile('Sam-P');
check('a colliding slug is disambiguated, not merged', colliding.profile?.id === 'sam-p-2', JSON.stringify(colliding));
check('the registry list cannot be mutated from outside',
  (() => { const list = m.listProfiles(); list.pop(); return m.listProfiles().length === 3; })());
const renamed = m.renameProfile('sam-p', 'Sam');
check('a rename keeps the id (and so the cloud file)', renamed.profile?.id === 'sam-p' && renamed.profile?.name === 'Sam', JSON.stringify(renamed));
check('a rename to an existing name is refused', !!m.renameProfile('sam-p', 'Sam-P').error);
check('a rename of an unknown profile is refused', !!m.renameProfile('nobody', 'Nobody').error);

// The cap: six profiles, and the last one can never be deleted.
localStorage = reg([{ id: 'personal', name: 'Personal' }]);
const capped = await import('../profiles.js?cap');
for (const name of ['A', 'B', 'C', 'D', 'E']) check(`profile "${name}" is created`, !capped.createProfile(name).error);
const over = capped.createProfile('F');
check('a seventh profile is refused with a clear reason', !!over.error && /6 profiles/.test(over.error), over.error);
// Deleting down to one, then refusing the last.
for (const id of ['a', 'b', 'c', 'd', 'e']) capped.deleteProfile(id);
check('deleting is allowed down to the last profile', capped.listProfiles().length === 1, JSON.stringify(capped.listProfiles()));
check('the last profile cannot be deleted', !!capped.deleteProfile('personal').error);
check('deleting an unknown profile is refused', !!capped.deleteProfile('ghost').error);

// --------------------------------- 5. a delete removes every key it owned
localStorage = reg([{ id: 'personal', name: 'Personal' }, { id: 'sam', name: 'Sam' }]);
sessionStorage = new MemoryStorage();
const deleting = await import('../profiles.js?delete');
const BASES = ['state', 'quarantine', 'privacy', 'bio', 'sync', 'undo', 'alerts', 'reminder'];
for (const base of BASES) {
  localStorage.setItem(deleting.nsKey(base, 'sam'), 'sam-secret');
  localStorage.setItem(deleting.nsKey(base, 'personal'), 'personal-secret');
}
const gone = deleting.deleteProfile('sam');
check('the delete reports success', gone.ok === true, JSON.stringify(gone));
check('every namespaced base of that profile is gone',
  BASES.every(base => localStorage.getItem(deleting.nsKey(base, 'sam')) === null));
check('the surviving profile keeps every one of its keys',
  BASES.every(base => localStorage.getItem(deleting.nsKey(base, 'personal')) === 'personal-secret'));
check('the registry no longer lists it', !deleting.listProfiles().some(p => p.id === 'sam'));
check('the undo journal of another profile survives the delete',
  localStorage.getItem('cents:p/personal/undo') === 'personal-secret');

// ------------------------------------- 6. adopting a profile from a link
localStorage = reg([{ id: 'personal', name: 'Personal' }]);
const adopting = await import('../profiles.js?adopt');
const adopted = adopting.createProfile('Sam', { id: 'sam' });
check('an explicit id is honoured', adopted.profile?.id === 'sam', JSON.stringify(adopted));
check('adopting an existing id is idempotent, not a duplicate',
  adopting.createProfile('Sam', { id: 'sam' }).existing === true);
check('only one profile came out of the double adoption', adopting.listProfiles().length === 2,
  JSON.stringify(adopting.listProfiles()));
// A name that collides on the link's device is not a reason to lose the id.
const clashing = adopting.createProfile('Personal', { id: 'kate' });
check('an adopted id keeps its id even when the name is taken', clashing.profile?.id === 'kate', JSON.stringify(clashing));
check('the clashing adopted name is disambiguated', clashing.profile?.name !== 'Personal', clashing.profile?.name);
check('a hostile id is refused', !!adopting.createProfile('Evil', { id: '../../etc/passwd' }).error);
check('an uppercase id is refused (ids are slugs)', !!adopting.createProfile('Evil', { id: 'Evil' }).error);

// ============================ 6b. admin: who is it, and writing their tabs
// The admin is the owner's profile ("personal"): its credential is the site's
// APP_PASSWORD, so it is the only profile that may manage the others, and it
// must not be deletable — that would leave nobody able to open the panel.
localStorage = reg([{ id: 'personal', name: 'Personal' }, { id: 'sam', name: 'Sam' }]);
sessionStorage = new MemoryStorage();
const admin = await import('../profiles.js?admin');
check('the owner profile is the admin', admin.isAdminProfile('personal') === true);
check('another profile is not', admin.isAdminProfile('sam') === false);
check('the owner profile cannot be deleted', !!admin.deleteProfile('personal').error, JSON.stringify(admin.deleteProfile('personal')));
check('the admin survives that refusal', admin.listProfiles().length === 2);
// A registry from before that rule existed, with no "personal" profile.
localStorage = reg([{ id: 'kate', name: 'Kate' }, { id: 'sam', name: 'Sam' }]);
const legacyAdmin = await import('../profiles.js?admin-legacy');
check('without a personal profile the first one is the admin',
  legacyAdmin.isAdminProfile('kate') === true && legacyAdmin.isAdminProfile('sam') === false);

// The admin writes into the TARGET's document, so the restriction travels with
// that user's data — and everything else in their document must survive.
const now = new Date().toISOString();
localStorage = reg([{ id: 'personal', name: 'Personal' }, { id: 'sam', name: 'Sam' }]);
localStorage.setItem('cents:p/sam/state', JSON.stringify({
  entries: [{ id: 'sam-1', date: '2026-09-21', type: 'expense', method: 'AIB', category: 'gro', amount: 4, details: 'keep me', note: '' }],
  settings: { monthlyBudget: 321, onboarded: true },
  lastLocalChangeAt: now,
}));
const storage = await import('../storage.js?admin-write');
const before = storage.loadStateFor('sam');
check('another profile\u2019s document can be read', before.entries.length === 1 && before.settings.monthlyBudget === 321);
check('and defaults to every tab', before.settings.enabledTabs.length === 6, JSON.stringify(before.settings.enabledTabs));
check('the patch reports success', storage.patchProfileSettings('sam', { enabledTabs: ['dashboard', 'add'] }) === true);
const after = storage.loadStateFor('sam');
check('the patch applied to the target', after.settings.enabledTabs.join() === 'dashboard,add', JSON.stringify(after.settings.enabledTabs));
check('the target keeps its entries', after.entries.length === 1 && after.entries[0].details === 'keep me');
check('and its other settings', after.settings.monthlyBudget === 321);
check('the admin\u2019s own document was not touched', storage.loadStateFor('personal').settings.enabledTabs.length === 6,
  JSON.stringify(storage.loadStateFor('personal').settings.enabledTabs));
check('a hostile list is normalised on the way in',
  storage.patchProfileSettings('sam', { enabledTabs: ['tesco', 'bogus'] })
  && storage.loadStateFor('sam').settings.enabledTabs.join() === 'dashboard,tesco',
  JSON.stringify(storage.loadStateFor('sam').settings.enabledTabs));
// A full device must report the failure rather than pretend it saved.
const realSet = localStorage.setItem.bind(localStorage);
localStorage.setItem = () => { throw new Error('quota'); };
check('a rejected write is reported, not swallowed', storage.patchProfileSettings('sam', { enabledTabs: ['dashboard'] }) === false);
localStorage.setItem = realSet;
check('and the document is unchanged after that failure',
  storage.loadStateFor('sam').settings.enabledTabs.join() === 'dashboard,tesco');

// ================================ 6c. profile pictures (device-local icons)
localStorage = reg([{ id: 'personal', name: 'Personal' }, { id: 'sam', name: 'Sam' }]);
sessionStorage = new MemoryStorage();
const pics = await import('../profiles.js?pictures');
check('a fresh profile has no picture', pics.listProfiles().find(p => p.id === 'sam').icon === undefined);
const painted = pics.setProfileIcon('sam', 'robot');
check('a picture can be chosen', painted.ok === true && painted.profile.icon === 'robot');
check('and it is readable back from the registry', pics.listProfiles().find(p => p.id === 'sam').icon === 'robot');
check('it is written to storage, not held in memory', JSON.parse(localStorage.getItem('cents:profiles')).profiles.find(p => p.id === 'sam').icon === 'robot');
check('another profile is untouched', pics.listProfiles().find(p => p.id === 'personal').icon === undefined);
check('the picture can be cleared back to an initial', pics.setProfileIcon('sam', null).profile.icon === undefined);
check('an over-long id is bounded, not stored raw', pics.setProfileIcon('sam', 'x'.repeat(80)).profile.icon.length === 24);
check('a picture for an unknown profile is refused', !!pics.setProfileIcon('nobody', 'cat').error);
check('choosing a picture does not disturb the name or the id',
  pics.setProfileIcon('sam', 'ghost').profile.name === 'Sam'
  && pics.listProfiles().find(p => p.id === 'sam').id === 'sam');

// The data-loss guard: a registry written BEFORE pictures existed has no icon
// field, and must still be accepted. Rejecting it would rebuild the registry
// and strand every profile's data.
localStorage = reg([{ id: 'personal', name: 'Personal' }, { id: 'sam', name: 'Sam' }]);
const older = await import('../profiles.js?pre-pictures');
check('a registry from before pictures still loads', older.listProfiles().length === 2, JSON.stringify(older.listProfiles()));
// And a corrupt picture is dropped, not treated as a corrupt registry.
localStorage = reg([
  { id: 'personal', name: 'Personal', icon: { evil: true } },
  { id: 'sam', name: 'Sam', icon: 'z'.repeat(200) },
]);
const salvage = await import('../profiles.js?bad-pictures');
check('a malformed picture does not invalidate the registry', salvage.listProfiles().length === 2, JSON.stringify(salvage.listProfiles()));
check('the malformed picture is dropped', salvage.listProfiles().every(p => p.icon === undefined));
check('the rest of the profile survives it',
  salvage.listProfiles().map(p => p.name).join() === 'Personal,Sam'
  && salvage.isAdminProfile('personal') === true);

// ================================================ 7. server-side resolution
process.env.APP_PASSWORD = 'default-password-1234';
process.env.APP_PASSWORD_SAM_P = 'sam-password-123456';
delete process.env.APP_PASSWORD_KATE;
const srv = await import('../netlify/functions/lib/profiles.mjs');
const req = (profile) => new Request('https://cents.test/sync', {
  headers: profile ? { 'x-cents-profile': profile } : {},
});

const def = srv.resolveProfileForAuth(req());
check('no header resolves to the default profile', def.ok && def.id === 'personal' && def.envName === 'APP_PASSWORD');
check('the default profile uses APP_PASSWORD', def.expected === 'default-password-1234');
const sam = srv.resolveProfileForAuth(req('sam-p'));
check('a named profile resolves to its own env var', sam.ok && sam.envName === 'APP_PASSWORD_SAM_P');
check('that profile gets its own password', sam.expected === 'sam-password-123456');
const kate = srv.resolveProfileForAuth(req('kate'));
check('a profile with no env var is refused', kate.ok === false && kate.problem === 'missing');
check('NO profile ever falls back to APP_PASSWORD', kate.expected === null
  && srv.resolveProfileForAuth(req('kate')).expected !== process.env.APP_PASSWORD,
  'the shared password would have become a master key');
check('the refusal names the exact env var to set',
  /APP_PASSWORD_KATE/.test(srv.profileAuthMessage(kate)), srv.profileAuthMessage(kate));
process.env.APP_PASSWORD_SHORT = 'tiny';
const short = srv.resolveProfileForAuth(req('short'));
check('a too-short profile password is refused', short.ok === false && short.problem === 'too-short');
check('the operator sees which variable is too short', /APP_PASSWORD_SHORT/.test(srv.profileAuthMessage(short)));
delete process.env.APP_PASSWORD_SHORT;
check('a hostile profile header cannot name an arbitrary env var',
  srv.profileIdFromHeader('__proto__') === 'personal'
  && srv.profileIdFromHeader('a/b') === 'personal'
  && srv.profileIdFromHeader('..') === 'personal'
  && srv.profileIdFromHeader('APP_PASSWORD') === 'personal');
check('an over-long id is rejected', srv.profileIdFromHeader('x'.repeat(30)) === 'personal');
check('profile ids are strictly validated', srv.isProfileId('sam-p') && !srv.isProfileId('-sam'));

check('the default profile keeps the configured cloud file', srv.cloudFileFor('personal', 'data.json') === 'data.json');
check('a second profile gets a sibling cloud file',
  srv.cloudFileFor('sam-p', 'data.json') === 'data-sam-p.json', srv.cloudFileFor('sam-p', 'data.json'));
check('a file without an extension still gets a distinct name',
  srv.cloudFileFor('sam', 'ledger') === 'ledger-sam', srv.cloudFileFor('sam', 'ledger'));

// =========================================== 8. setup tokens carry the id
const { issueSetupToken, redeemSetupToken } = await import('../netlify/functions/lib/tokens.mjs');
const SECRET = 'stub-github-token';
const forSam = issueSetupToken(SECRET, 'sam-password-123456', 'sam-p');
const back = redeemSetupToken(SECRET, forSam);
check('a token round-trips its password', back.ok && back.password === 'sam-password-123456');
check('a token round-trips the profile it belongs to', back.profileId === 'sam-p', back.profileId);
check('a token minted with no profile is the default one',
  redeemSetupToken(SECRET, issueSetupToken(SECRET, 'default-password-1234')).profileId === 'personal');
check('a hostile profile id cannot be smuggled into a token',
  redeemSetupToken(SECRET, issueSetupToken(SECRET, 'default-password-1234', '../../etc')).profileId === 'personal');

// A link minted before this field existed must still redeem — as the default.
const key = createHash('sha256').update(SECRET).digest();
const iv = randomBytes(12);
const legacyCipher = createCipheriv('aes-256-gcm', key, iv);
const legacyPlain = JSON.stringify({ p: 'default-password-1234', e: Date.now() + 86400000 });
const legacyToken = `t2.${iv.toString('base64url')}.${Buffer.concat([legacyCipher.update(legacyPlain, 'utf8'), legacyCipher.final()]).toString('base64url')}.${legacyCipher.getAuthTag().toString('base64url')}`;
const legacyBack = redeemSetupToken(SECRET, legacyToken);
check('a pre-profiles token still redeems', legacyBack.ok && legacyBack.password === 'default-password-1234');
check('a pre-profiles token belongs to the default profile', legacyBack.profileId === 'personal');
check('a tampered token is rejected',
  redeemSetupToken(SECRET, legacyToken.slice(0, -2) + (legacyToken.endsWith('AA') ? 'BB' : 'AA')).ok === false);

// ---------------------------------------------------------------- report
if (failures.length) {
  console.error(`test-profiles: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`test-profiles: OK - ${pass} assertions passed (isolation, migration, credentials fail closed)`);
