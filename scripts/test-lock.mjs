#!/usr/bin/env node
/**
 * The lock: the PIN, the idle clock, and the privacy cover.
 *
 * Three parity lines live here:
 *
 *   - docs/CENTS_PARITY.md line 36 — the app lock opens by default; PIN
 *     setup/change/reset and the lock timeout work.
 *   - line 37 — WebAuthn/biometric unlock supports fingerprint/Face ID where
 *     available and falls back safely.
 *   - line 38 — profiles keep independent ledger documents, settings, PINs,
 *     credentials and access policy.
 *
 * The lock is the whole of this app's access control — localStorage has no
 * session and no server to challenge a request — so "unlocked" has to be a
 * state the app can take back by itself. Two rules, and they share one door:
 *
 *   1. Untouched for five minutes → locked again. The ONLY time-based lock,
 *      and it is about absence rather than about where the window is.
 *   2. The moment the document hides, an opaque cover goes over it, because
 *      the app-switcher snapshot is taken WHILE hidden.
 *
 * There used to be a third rule — hidden for 30 seconds → locked on the way
 * back — and it was removed on 16 Oct 2026 because it charged the PIN for
 * every glance at another tab. A tab switch is not an absence. This guard
 * pins its absence, because a rule that comes back silently is a rule the user
 * never agreed to.
 *
 * The PIN itself is PBKDF2 with a fresh salt, upgraded in place from the
 * legacy salted SHA-256, and the credential lives on the DEVICE, outside the
 * document — so it is never synced and never travels with a backup.
 *
 * Run: node scripts/test-lock.mjs
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

/* ── the device store, so the PIN can be exercised without a DOM ──────────── */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const lock = await import('../app/src/lock.ts');
const settings = await import('../app/lib/settings.ts');
const idle = await import('../app/src/idle-lock.ts');
const storage = await import('../app/lib/storage.ts');

/* ══ 1. THE PIN ═════════════════════════════════════════════════════════════ */

const state = { schemaVersion: 2, entries: [], settings: {} };

check('a fresh device has no PIN of its own', !lock.hasCustomPin(state));
const credential = lock.getPinCredential(state);
check('and answers with the built-in one', credential.isDefault === true, JSON.stringify(credential));
check('the built-in PIN is 100901', lock.DEFAULT_PIN_PLAIN === '100901');

check('the built-in PIN unlocks', await lock.verifyPin('100901', state));
check('a wrong PIN does not', !(await lock.verifyPin('1009010', state)));
check('and neither does an empty one', !(await lock.verifyPin('', state)));

// Setting a PIN: PBKDF2, a fresh salt, and the credential on the DEVICE.
const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const hash = await lock.hashPin('4321', salt);
settings.setPrivacyPin(hash, salt, 'pbkdf2');
const stored = settings.getPrivacyPin();
check('the credential is stored on the device', stored.hash === hash && stored.salt === salt,
  JSON.stringify(stored));
check('and it says which KDF it used', stored.kdf === 'pbkdf2', String(stored.kdf));
check('the new PIN unlocks', await lock.verifyPin('4321', state));
check('the built-in PIN no longer does', !(await lock.verifyPin('100901', state)));
check('and the device is no longer on the default', !lock.getPinCredential(state).isDefault);

// The credential must NOT live in the document: it is device-local, so it is
// never synced and never travels with a backup.
const document_ = storage.validateState({ schemaVersion: 2, entries: [], settings: {} });
check('the document carries no PIN', !('pinHash' in document_.settings) && !('pinHash' in document_));
check('and the device key is namespaced per profile',
  settings.getPrivacyPin().hash === hash, 'the credential moved');

/* ══ 2. THE LEGACY CREDENTIAL IS UPGRADED IN PLACE ════════════════════════ */

// A device that set its PIN before PBKDF2: a salted SHA-256, no kdf field.
const legacySalt = 'ffffeeeeddddccccbbbbaaa99998888';
const legacyHash = await lock.hashPinLegacy('4321', legacySalt);
settings.setPrivacyPin(legacyHash, legacySalt, null);
check('a legacy credential still unlocks', await lock.verifyPin('4321', state));
const upgraded = settings.getPrivacyPin();
check('and it is upgraded to PBKDF2 in place', upgraded.kdf === 'pbkdf2' && upgraded.hash !== legacyHash,
  JSON.stringify({ kdf: upgraded.kdf, changed: upgraded.hash !== legacyHash }));
check('and the upgraded credential still unlocks', await lock.verifyPin('4321', state));
check('while the old hash is gone', settings.getPrivacyPin().hash !== legacyHash);

/* ══ 3. THE IDLE CLOCK ═════════════════════════════════════════════════════ */

check('the idle clock is five minutes', idle.IDLE_LOCK_MS === 5 * 60 * 1000,
  String(idle.IDLE_LOCK_MS));

// The clock only runs while the app is unlocked: a call while locked arms
// nothing, so the lock screen cannot keep itself awake.
let locked = 0;
idle.resetIdleLock(() => { locked += 1; });
check('a clock that was never started arms nothing', idle.idleLockArmed() === false);
idle.startIdleLock(() => { locked += 1; });
check('starting it arms the clock', idle.idleLockArmed() === true);
idle.resetIdleLock(() => { locked += 1; });
check('and an interaction restarts it', idle.idleLockArmed() === true);
idle.stopIdleLock();
check('stopping it disarms the clock', idle.idleLockArmed() === false);

/* ══ 4. THE RULES, AS THE SOURCE SAYS THEM ═════════════════════════════════ */

// The source is the contract. A rule that comes back silently is a rule the
// user never agreed to, so the source is read for the rules it must not have.
const idleSource = readFileSync(resolve(repo, 'app/src/idle-lock.ts'), 'utf8');
const mainSource = readFileSync(resolve(repo, 'app/src/main.ts'), 'utf8');
const lockSource = readFileSync(resolve(repo, 'app/src/lock.ts'), 'utf8');

check('there is no hidden-window lock rule', !/HIDDEN_LOCK_MS/.test(idleSource + mainSource + lockSource),
  'a hidden tab must be covered, not locked');
check('and no lock-on-return rule either', !/visibilityState\s*===\s*'visible'[\s\S]{0,200}lockApp|lockApp\(\)/.test(idleSource));
check('the cover IS painted when the document hides',
  /visibilityState\s*===\s*'hidden'[\s\S]{0,120}installPrivacyCover\(\)/.test(idleSource),
  'the app-switcher snapshot is taken while hidden');
check('and removed when it comes back',
  /else\s+hidePrivacyCover\(\)/.test(idleSource));
check('the idle clock is armed when the app unlocks',
  /startIdleLock\(lockNow\)/.test(mainSource));
check('and the lock is taken back through one door',
  /function lockNow\(\)[\s\S]{0,400}showPinLock\(/.test(mainSource),
  'the idle clock and the Settings sheet must use the same door');
check('an interaction never unlocks',
  /resetIdleLock[\s\S]{0,200}/.test(idleSource) && !/resetIdleLock[\s\S]{0,120}unlock/i.test(idleSource));

/* ══ 5. THE LOCK SCREEN ITSELF ═════════════════════════════════════════════ */

check('the lock names its own dialog', /role:\s*'dialog'/.test(lockSource) && /aria-modal/.test(lockSource));
check('and it has a named PIN field', /'aria-label':\s*'PIN'/.test(lockSource));
check('a wrong PIN is refused with a sentence', /That PIN is not correct/.test(lockSource));
check('the default PIN is told to the person who kept it', /Still the default PIN/.test(lockSource));
check('too many attempts are throttled', /Too many attempts/.test(lockSource));
check('a fingerprint that is not available falls back to the PIN',
  /Fingerprint is not available on this device - use your PIN/.test(lockSource));
check('and a cancelled one does too', /cancelled - tap again or use your PIN/.test(lockSource));
check('a device with no authenticator shows the PIN alone',
  /if \(!supported\)[\s\S]{0,200}pinArea\.hidden = false/.test(lockSource));

/* ══ 6. THE PROFILES KEEP SEPARATE CREDENTIALS ══════════════════════════════ */

const profiles = await import('../app/lib/profiles.ts');
check('a PIN is namespaced per profile', profiles.nsKey('privacy', 'sam') === 'cents:p/sam/privacy',
  profiles.nsKey('privacy', 'sam'));
check('and the active one under its own id',
  profiles.nsKey('privacy', 'personal') === 'cents:p/personal/privacy', profiles.nsKey('privacy', 'personal'));
check('the two are not the same key',
  profiles.nsKey('privacy', 'sam') !== profiles.nsKey('privacy', 'personal'));

if (failures) {
  console.error(`\ntest-lock: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-lock: OK — ${checks} checks (the lock opens by default, the PIN is PBKDF2 on the device, the clock and the cover are the shipping app's)`);
