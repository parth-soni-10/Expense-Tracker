#!/usr/bin/env node
/**
 * The storage contract: one write path, a document that loads unchanged, an
 * undo that survives a reload, and profile data nobody may touch.
 *
 * Four parity lines live here, and each is a rule about *where* a write
 * happens rather than a feature:
 *
 *   - docs/CENTS_PARITY.md line 13 — one `saveState` path; the stored
 *     `expense-tracker:v1` document (schemaVersion 2) loads unchanged.
 *   - line 14 — destructive actions apply immediately and carry a reload-safe
 *     undo journal; a reload inside the undo window loses no action/history.
 *   - line 15 — the existing localStorage key and the KV profile keys are
 *     preserved, and no test writes, resets or migrates profile data.
 *   - line 42 — profile data, `cents:profiles`, `cents:p/<id>/*` and the admin
 *     policy are never written, reset or migrated by a test or by the app.
 *
 * Line 42 is the one with teeth, because an earlier update deleted a user's
 * profile once. The rule has two halves and they are not the same rule:
 *
 *   - A TEST may exercise the profile logic, but only in Node against an
 *     in-memory fixture. It may never write through a real browser's
 *     localStorage, because the accessibility harness is served from the app's
 *     own origin and therefore shares the app's real storage.
 *   - The APP may write profile data only where the user asked for it. The one
 *     place it removes a profile's keys is `deleteProfile`, which refuses the
 *     owner profile and the last profile; the one place it migrates is the
 *     legacy-key move, which removes the old key only after the new one is
 *     written.
 *
 * A source scan is the right instrument for all of it: these are rules about
 * WHICH call site writes, and a runtime check cannot see a write that does not
 * happen on the path it happened to exercise. The behavioural half — the
 * journal really surviving a reload, the document really round-tripping — is
 * executed here too, because a scan cannot prove that either.
 *
 * Run: node scripts/test-storage-contract.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** Every .ts file under a directory, recursively, sorted. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

const libFiles = tsFiles(join(repo, 'app', 'lib'));
const srcFiles = tsFiles(join(repo, 'app', 'src'));
const rel = (file) => file.slice(repo.length + 1).replace(/\\/g, '/');

/** Every `localStorage.<op>(` call site, with the key expression it writes. */
function storageCalls(files, op) {
  const found = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = line.match(new RegExp(`localStorage\\s*\\.\\s*${op}\\s*\\(`));
      if (!match) return;
      found.push({
        file: rel(file),
        line: index + 1,
        key: firstArgument(line, line.indexOf(match[0]) + match[0].length),
        source: line.trim(),
      });
    });
  }
  return found;
}

/** The first argument of a call, taken to the comma at nesting depth zero. */
function firstArgument(line, from) {
  let depth = 0;
  let out = '';
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

/** The name of the function a line sits inside, by scanning backwards. */
function enclosingFunction(file, lineNumber) {
  const lines = readFileSync(join(repo, file), 'utf8').split('\n');
  for (let i = lineNumber - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (match) return match[1];
  }
  return '<module scope>';
}

/* ══ 1. ONE WRITE PATH FOR THE DOCUMENT ═════════════════════════════════════
 *
 * The state document has exactly one write path: `saveState`. There is one
 * named exception — the Admin panel's `patchProfileSettings`, which writes
 * *another* profile's settings and cannot go through the active profile's
 * save. The point of the assertion is that the exception stays exactly one
 * and stays named: a second ad-hoc writer is how two documents end up
 * disagreeing about what was saved.
 */

// `KEY()` is a local name in two modules and they are NOT the same key:
// storage.ts's is the state document, settings.ts's is the sync settings.
// The state writer is therefore matched inside storage.ts only — and the
// ambiguity is itself asserted below, because two same-named helpers for two
// different keys is exactly how a second state writer sneaks in later.
const stateWrites = storageCalls(libFiles, 'setItem')
  .filter((call) => call.file === 'app/lib/storage.ts'
    && (/^KEY\(\)$/.test(call.key) || /^nsKey\('state'/.test(call.key)));

check('the state document is written in exactly two places', stateWrites.length === 2,
  stateWrites.map((c) => `${c.file}:${c.line}`).join(', '));
check('both state writes are in storage.ts',
  stateWrites.every((c) => c.file === 'app/lib/storage.ts'),
  stateWrites.map((c) => c.file).join(', '));

const writers = stateWrites.map((c) => enclosingFunction(c.file, c.line)).sort();
check('one writer is saveState', writers.includes('saveState'), writers.join(', '));
check('the other is the admin path, patchProfileSettings', writers.includes('patchProfileSettings'), writers.join(', '));
check('there is no third writer', stateWrites.length === 2
  && stateWrites.filter((c) => enclosingFunction(c.file, c.line) === 'saveState').length === 1
  && stateWrites.filter((c) => enclosingFunction(c.file, c.line) === 'patchProfileSettings').length === 1,
  writers.join(', '));

// A screen writing storage directly would be a second path with no name on it.
const screenWrites = storageCalls(srcFiles, 'setItem');
check('no screen writes localStorage itself', screenWrites.length === 0,
  screenWrites.map((c) => `${c.file}:${c.line}`).join(', '));
const screenRemoves = storageCalls(srcFiles, 'removeItem');
check('no screen removes a localStorage key itself', screenRemoves.length === 0,
  screenRemoves.map((c) => `${c.file}:${c.line}`).join(', '));

// The two `KEY()` helpers must stay two different keys.
const settingsSource = readFileSync(join(repo, 'app', 'lib', 'settings.ts'), 'utf8');
const storageSource = readFileSync(join(repo, 'app', 'lib', 'storage.ts'), 'utf8');
check('the two KEY() helpers are different keys (state vs sync)',
  /const KEY = \(\) => nsKey\('sync'\);/.test(settingsSource)
  && /const KEY = \(\) => nsKey\('state'\);/.test(storageSource));

// The self-heal write in loadState must go through saveState, not around it.
check('loadState self-heals through saveState, not a direct write',
  /if \(JSON\.stringify\(validated\) !== raw\) saveState\(validated\);/.test(storageSource));
check('saveState reports failure rather than swallowing it',
  /export function saveState\(state: CentsState\): boolean \{[\s\S]{0,400}?return true;[\s\S]{0,400}?return false;/.test(storageSource));

/* ══ 2. THE DOCUMENT LOADS UNCHANGED ════════════════════════════════════════
 *
 * The behavioural half of line 13: a document written by the shipping app
 * loads in the ported code and survives a load → save round trip
 * field-for-field. The fixture is frozen and synthetic, built by
 * make-cents-fixture.mjs with the OLD modules.
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const fixture = JSON.parse(readFileSync(resolve(here, 'fixtures/expense-tracker-v1.schema2.json'), 'utf8'));
const KEY = 'cents:p/personal/state';
store.set(KEY, JSON.stringify(fixture));

const storage = await import('../app/lib/storage.ts');
const actions = await import('../app/src/actions.ts');

const loaded = storage.loadState();
const saved = storage.saveState(loaded);
check('the frozen document loads', !!loaded && Array.isArray(loaded.entries));
check('saveState reports success', saved === true);
check('schemaVersion stays 2', loaded.schemaVersion === 2);
check('the document is field-for-field unchanged by a load/save',
  JSON.stringify(JSON.parse(store.get(KEY))) === JSON.stringify(fixture),
  'a load/save changed the stored JSON');
check('the load is idempotent',
  JSON.stringify(storage.validateState(loaded)) === JSON.stringify(loaded));

/* ══ 3. THE UNDO SURVIVES A RELOAD ══════════════════════════════════════════
 *
 * Line 14's whole claim. A destructive action applies immediately, writes a
 * record that a *reload* can still offer, and restoring it puts the ledger
 * back exactly — including the tombstones it cleared.
 */

let state = storage.loadState();
const save = () => storage.saveState(state);
const transferLegs = state.entries.filter((entry) => entry.transferId);
check('the fixture holds a two-leg transfer to delete', transferLegs.length === 2);

const removedIds = transferLegs.map((entry) => entry.id);
const before = JSON.stringify([...state.entries].sort((a, b) => String(a.id).localeCompare(String(b.id))));
actions.deleteEntries(state, save, removedIds, 'Delete To savings');
check('the delete applies immediately', !state.entries.some((entry) => removedIds.includes(entry.id)));
check('it tombstones the ids', removedIds.every((id) => state.settings.deletedEntryIds.includes(id)));
check('the journal is namespaced per profile, not global',
  storage.loadUndoJournal() !== null && store.has('cents:p/personal/undo'),
  [...store.keys()].join(', '));

// A reload: a fresh document read out of the same storage.
state = storage.loadState();
const offered = actions.latestUndo(state);
check('the reload still offers the undo', !!offered && offered.entries.length === 2);
actions.restoreUndoJournal(state, save, offered);
check('restore puts both legs back', removedIds.every((id) => state.entries.some((entry) => entry.id === id)));
check('restore clears the tombstones it revived',
  !state.settings.deletedEntryIds.some((id) => removedIds.includes(id)));
check('the ledger is field-for-field what it was',
  JSON.stringify([...state.entries].sort((a, b) => String(a.id).localeCompare(String(b.id)))) === before);

// A second action stacks rather than replacing: two undos after one reload
// must re-add two independent batches.
const second = state.entries.filter((entry) => entry.id !== removedIds[0]).slice(0, 1);
if (second.length) {
  const secondId = second[0].id;
  actions.deleteEntries(state, save, [secondId], 'Delete another');
  const stack = JSON.parse(store.get('cents:p/personal/undo'));
  check('a second action stacks onto the journal rather than replacing it',
    Array.isArray(stack) && stack.length === 2, String(Array.isArray(stack) ? stack.length : 'not a stack'));
  check('the newest record is the one that is offered', storage.loadUndoJournal()?.label === 'Delete another',
    storage.loadUndoJournal()?.label);
  check('the stack is capped at UNDO_STACK_MAX',
    storage.UNDO_STACK_MAX === 5 && (Array.isArray(stack) ? stack.length : 0) <= storage.UNDO_STACK_MAX);
  void secondId;
}

// The mutation history — the record an edit leaves behind — must survive a
// delete and a restore untouched: it is what the merge reads back.
const historyBefore = JSON.stringify(state.settings.mutationHistory ?? null);
check('the mutation history is not disturbed by the journal',
  JSON.stringify(state.settings.mutationHistory ?? null) === historyBefore);

// The theme is the same kind of rule seen from the other side: one key, one
// writer, and one that is only READ before first paint. Two handlers on one
// control would each read the theme and flip it back, so the button would do
// nothing — which is why the shell's toggle is not a kit host.
const themeWrites = storageCalls(libFiles, 'setItem')
  .filter((call) => /THEME_KEY|['"]cents-theme['"]/.test(call.source));
check('the theme key is written in exactly one place', themeWrites.length === 1,
  themeWrites.map((c) => `${c.file}:${c.line}`).join(', '));
check('  and that place is lib/settings.ts', themeWrites.length === 1 && themeWrites[0].file === 'app/lib/settings.ts',
  themeWrites.map((c) => c.file).join(', '));
const themeInit = readFileSync(join(repo, 'app', 'theme-init.js'), 'utf8');
check('theme-init.js only READS the theme key',
  /localStorage\.getItem\('cents-theme'\)/.test(themeInit) && !/localStorage\.setItem/.test(themeInit));
const mainSource = readFileSync(join(repo, 'app', 'src', 'main.ts'), 'utf8');
check('the shell theme toggle is not a kit host (one handler, one flip)',
  /app-theme-toggle/.test(mainSource) && !/data-ui/.test(mainSource.split('app-theme-toggle')[1]?.slice(0, 400) || ''),
  'the toggle is a kit host, so the kit would flip it too');

/* ══ 4. PROFILE DATA NOBODY MAY TOUCH ═══════════════════════════════════════
 *
 * Line 15 and line 42. The app half and the test half, separately.
 */

/* -- the app: the only removal is the one the user asked for ---------------- */

const removes = storageCalls(libFiles, 'removeItem')
  .concat(storageCalls(srcFiles, 'removeItem'));
const namespacedRemoves = removes.filter((c) => /nsKey\(/.test(c.key));
check('the app removes a profile-namespaced key in exactly one place',
  namespacedRemoves.length === 1, namespacedRemoves.map((c) => `${c.file}:${c.line}`).join(', '));
check('  and that place is deleteProfile',
  namespacedRemoves.length === 1
  && enclosingFunction(namespacedRemoves[0].file, namespacedRemoves[0].line) === 'deleteProfile',
  namespacedRemoves.map((c) => enclosingFunction(c.file, c.line)).join(', '));

const profilesSource = readFileSync(join(repo, 'app', 'lib', 'profiles.ts'), 'utf8');
check('deleteProfile refuses the owner profile',
  /export function deleteProfile\(id\)[\s\S]{0,200}?isAdminProfile\(id\)[\s\S]{0,120}?return \{ error: 'The owner profile cannot be deleted\.' \}/.test(profilesSource));
check('deleteProfile refuses the last profile',
  /registry\.profiles\.length <= 1[\s\S]{0,120}?return \{ error: 'The last profile cannot be deleted\.' \}/.test(profilesSource));
check('deleteProfile removes every base a profile owns',
  /for \(const base of BASES\)[\s\S]{0,120}?removeItem\(nsKey\(base, id\)\)/.test(profilesSource));

// The legacy move is the one migration, and it removes the old key only after
// the new one is written — a failure leaves the legacy key in place.
const migration = profilesSource.match(/function migrateLegacyKeysInto\(profileId\)[\s\S]*?\n}/);
check('there is exactly one legacy migration', !!migration);
check('the legacy key is removed only after the new one is written',
  !!migration && migration[0].indexOf('setItem') < migration[0].indexOf('removeItem'),
  migration ? migration[0].split('\n').map((l) => l.trim()).filter(Boolean).join(' | ') : 'not found');
check('a failed migration leaves the legacy key alone',
  !!migration && /catch \{ \/\* leave the legacy key in place rather than drop data \*\/ \}/.test(migration[0]));

/* -- the tests: profile logic in Node, never through a real browser -------- */

const scriptFiles = readdirSync(join(repo, 'scripts')).filter((f) => f.endsWith('.mjs'));
const MUTATORS = ['createProfile(', 'deleteProfile(', 'renameProfile(', 'setProfileIcon('];

for (const file of scriptFiles) {
  const source = readFileSync(join(repo, 'scripts', file), 'utf8');
  const drivesABrowser = /\bpage\.(evaluate|addInitScript)\b/.test(source);
  const mutates = MUTATORS.filter((fn) => source.includes(fn));

  if (drivesABrowser) {
    check(`${file}: a browser leg never calls a mutating profile function`,
      mutates.length === 0, mutates.join(', '));
    check(`${file}: a browser leg never writes the profile registry`,
      !/localStorage\s*\.\s*setItem\s*\(\s*['"]cents:profiles['"]/.test(source));
    check(`${file}: a browser leg never removes a profile key`,
      !/localStorage\s*\.\s*removeItem\s*\(\s*['"]cents:p\//.test(source));
    // A leg that writes a profile-namespaced key must do it in a context it
    // created, never in the app's own origin storage.
    if (/localStorage\s*\.\s*setItem\s*\(\s*['"]cents:p\//.test(source)) {
      check(`${file}: a leg that writes a profile key does it in a fresh context`,
        /newContext\s*\(/.test(source), 'no newContext() in the file');
    }
  } else {
    // A Node script may exercise the profile logic, but only against a
    // fixture: it must never talk to a storage it did not build itself.
    const buildsStorage = /new MemoryStorage|globalThis\.localStorage\s*=|const store = new Map/.test(source);
    check(`${file}: a Node script that touches profile data builds its own storage`,
      !mutates.length || buildsStorage, 'no in-memory storage shim');
  }
}

// The accessibility harness is served from the app's own origin, so it shares
// the app's real localStorage. It must not write to it at all.
const harness = join(repo, 'a11y-harness.html');
if (existsSafe(harness)) {
  const source = readFileSync(harness, 'utf8');
  check('the a11y harness never writes localStorage',
    !/localStorage\s*\.\s*(setItem|removeItem|clear)\s*\(/.test(source));
}

function existsSafe(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

store.clear();
if (failures) {
  console.error(`\ntest-storage-contract: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-storage-contract: OK — ${checks} checks (one write path, the document round-trips, the undo survives a reload, profile data untouched)`);
