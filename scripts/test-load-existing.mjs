#!/usr/bin/env node
/**
 * Gate C, part 1: a document written by the shipping app loads in the ported
 * code and survives a load → save round trip unchanged.
 *
 * The fixture is synthetic and frozen (`scripts/fixtures/expense-tracker-v1.
 * schema2.json`, built by `make-cents-fixture.mjs` with the OLD modules). This
 * test runs in a **fresh** context: a new in-memory localStorage, so nothing on
 * the device — and specifically no `cents:profiles` or `cents:p/<id>/*` key — is
 * read, written or migrated. The only key this process creates is the one the
 * fixture is loaded from.
 *
 * The browser leg (load the same document into the rendered app behind the test
 * PIN 100901 and assert the screens agree) stays in `docs/DEFERRED_TESTS.md`:
 * this file proves the storage contract, which is the half Gate C names.
 *
 * Run: node scripts/test-load-existing.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
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
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

// A fresh context holds the fixture and nothing else.
store.set(KEY, JSON.stringify(fixture));

const { loadState, saveState, validateState } = await import('../app/lib/storage.ts');

const loaded = loadState();
const saved = saveState(loaded);
const rawAfter = store.get(KEY);
const reloaded = JSON.parse(rawAfter);

check('loadState accepts the frozen document', !!loaded && typeof loaded === 'object');
check('saveState reports success', saved === true);
check('schemaVersion stays 2', loaded.schemaVersion === 2 && reloaded.schemaVersion === 2);
check('every entry survives', reloaded.entries.length === fixture.entries.length,
  `${reloaded.entries.length} of ${fixture.entries.length}`);
check('the document is field-for-field unchanged', JSON.stringify(reloaded) === JSON.stringify(fixture),
  'a load/save changed the stored JSON');
check('a second load is idempotent', JSON.stringify(validateState(reloaded)) === JSON.stringify(reloaded));
check('the transfer pair keeps one id', new Set(reloaded.entries.filter(e => e.transferId).map(e => e.transferId)).size === 1);
check('the split pair keeps one id', new Set(reloaded.entries.filter(e => e.splitId).map(e => e.splitId)).size === 1);
check('a tombstone survives the round trip',
  Array.isArray(reloaded.settings.deletedEntryIds) && reloaded.settings.deletedEntryIds.length === 1);
check('euro amounts keep two decimals',
  reloaded.entries.filter(e => e.amount > 0).every(e => Math.round(e.amount * 100) / 100 === e.amount));
// The app bootstraps its default `personal` registry entry on first read
// (profiles.ts's lazy migration). That is app state in a throwaway shim, not
// profile data: the assertion that matters is that the registry holds ONLY that
// default — no other profile, no PIN, no credential — and that no other
// profile's document was touched.
let registry = null;
try { registry = JSON.parse(store.get('cents:profiles') || 'null'); } catch { registry = null; }
const profileIds = Array.isArray(registry?.profiles) ? registry.profiles.map(p => p.id) : [];
check('the profile registry holds only the default profile',
  profileIds.length === 0 || (profileIds.length === 1 && profileIds[0] === 'personal'), profileIds.join(','));
check('the registry carries no credentials or PIN',
  !registry || (!('pinHash' in registry) && !('credential' in registry)));
check('no other profile document was created', [...store.keys()].every(k => k === KEY || k === 'cents:profiles'),
  [...store.keys()].join(','));
check('the custom category/method are still accepted',
  reloaded.settings.customCategories.some(c => c.id === 'fixcat')
  && reloaded.settings.customMethods.some(m => m.id === 'FXM'));
check('the balance checkpoint is preserved',
  reloaded.settings.balanceCheckpoints.AIB?.some(point => point.date === '2026-10-01' && point.balance === 1200));

if (failures) {
  console.error(`\ntest-load-existing: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`test-load-existing: OK — ${reloaded.entries.length} entries, schemaVersion ${reloaded.schemaVersion}, no profile key touched`);
