#!/usr/bin/env node
/**
 * The Data sheet's own numbers (slice 5, docs/CATCHUP_PLAN.md batch 21).
 *
 * Most of the sheet is wiring: `parseBackup`, `parseEntriesCsv`, `entriesCsv`,
 * `mergeStates` and `mirrorStatus` each already have a guard. What the screen
 * adds is four claims of its own that nothing else checked:
 *
 *   1. the size and count it prints are the ones a person acts on — kilobytes
 *      that never round to "0 KB" for a real document, and a plural that does
 *      not say "1 entries";
 *   2. a restore is PLANNED before it is offered, so "nothing to restore" is a
 *      statement about the merge rather than a guess, and planning one touches
 *      neither the document it was handed nor storage;
 *   3. the merge is the same newest-version-wins union a sync uses — a file
 *      cannot roll back a newer local row, and a tombstone still holds against
 *      a file that never heard about the deletion;
 *   4. a restored ledger re-anchors Cash: the merge keeps this device's settings
 *      when its stamp is newer, which is exactly how a restore arrives with
 *      entries on Cash and a €0.00 balance — so the file's figure is adopted
 *      when there is nothing to defend, and the rows win when there is.
 *
 * Run: node scripts/test-data-portability.mjs
 * Also a step in scripts/run-guards.mjs.
 */
class MemoryStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const {
  adoptBackupCash,
  documentBytes,
  entryCountLabel,
  formatBytes,
  planRestore,
  storageLabel,
} = await import('../app/src/data-report.ts');
const { validateState } = await import('../app/lib/storage.ts');
const { cashBalance, computeCashTotal } = await import('../app/src/metrics.ts');

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) pass += 1;
  else failures.push(name + (detail ? ` - ${detail}` : ''));
};
const noThrow = (name, fn) => {
  try { const value = fn(); pass += 1; return value; }
  catch (error) { failures.push(`${name} threw: ${error && error.message}`); return undefined; }
};

/** A validated entry. `createdAt` is the version the merge compares when there
 *  is no `updatedAt` (validateEntry drops an updatedAt whose history is gone). */
const entry = (overrides = {}) => ({
  id: 'e1',
  date: '2026-10-12',
  type: 'expense',
  category: 'gro',
  details: 'Lidl',
  amount: 4.47,
  method: 'AIB',
  note: '',
  createdAt: '2026-10-12T09:00:00.000Z',
  ...overrides,
});

const doc = (entries, settings = {}) => validateState({
  entries,
  settings,
  tesco: { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] },
  schemaVersion: 2,
});

// ============================================================
// 1. The two facts the sheet prints
// ============================================================
check('no document is 0 KB, not "NaN KB"', formatBytes(0) === '0 KB', formatBytes(0));
check('a negative size is the same as none', formatBytes(-5) === '0 KB', formatBytes(-5));
check('a tiny document still reads 1 KB', formatBytes(100) === '1 KB', formatBytes(100));
check('1024 bytes is 1 KB', formatBytes(1024) === '1 KB', formatBytes(1024));
check('1536 bytes rounds to 2 KB', formatBytes(1536) === '2 KB', formatBytes(1536));
check('a megabyte is 1.0 MB', formatBytes(1024 * 1024) === '1.0 MB', formatBytes(1024 * 1024));
check('five megabytes is 5.0 MB', formatBytes(5 * 1024 * 1024) === '5.0 MB', formatBytes(5 * 1024 * 1024));

// localStorage holds UTF-16, so the sheet's size is two bytes a character of
// the text actually on disk — not the length of an in-memory object.
check('the size is UTF-16 as stored', documentBytes('abc') === 6, documentBytes('abc'));
check('no stored text is no bytes', documentBytes(null) === 0, documentBytes(null));

check('persistent says so', storageLabel(2048, true) === '2 KB \u00b7 persistent', storageLabel(2048, true));
check('best-effort says so', storageLabel(2048, false) === '2 KB \u00b7 best-effort', storageLabel(2048, false));
check('an unanswerable platform is not called persistent',
  storageLabel(2048, null) === '2 KB \u00b7 persistence unknown', storageLabel(2048, null));

check('one entry is singular', entryCountLabel(1) === '1 entry', entryCountLabel(1));
check('zero is plural', entryCountLabel(0) === '0 entries', entryCountLabel(0));
check('twelve is plural', entryCountLabel(12) === '12 entries', entryCountLabel(12));
check('junk is not NaN entries', entryCountLabel('x') === '0 entries', entryCountLabel('x'));

// ============================================================
// 2. A restore is planned, the plan is pure, and an identical file is nothing
// ============================================================
const base = doc([entry()]);
const identical = planRestore(base, JSON.parse(JSON.stringify(base)));
check('a file this device already holds changes nothing', identical.changed === false, JSON.stringify({ added: identical.added, changed: identical.changed }));
check('and adds no rows', identical.added === 0, identical.added);

const before = JSON.stringify(base);
noThrow('planning a merge of a junk document', () => planRestore(base, null));
check('planning a merge does not touch the document it was handed', JSON.stringify(base) === before);

const extra = doc([entry(), entry({ id: 'e2', details: 'Aldi', amount: 12.4 })]);
const planned = planRestore(base, extra);
check('a file with one new row adds one', planned.added === 1, planned.added);
check('and is a change', planned.changed === true);
check('the merged document holds both rows', planned.merged.entries.length === 2, planned.merged.entries.length);
check('the merge result is a validated document', planned.merged.schemaVersion === 2);

// Settings follow the newer change stamp, exactly as a sync does: a file with no
// stamp of its own cannot overwrite this device's settings, and saying so is
// better than a restore that appears to work and changes nothing.
const staleSettings = planRestore(base, { settings: { monthlyBudget: 750 } });
check('a settings-only file with no newer stamp changes nothing', staleSettings.changed === false);
check('and the device\u2019s own budget stands', staleSettings.merged.settings.monthlyBudget === 1100,
  staleSettings.merged.settings.monthlyBudget);

// ...while a file that IS fresher (the ordinary export/import case across
// devices) carries its settings with it.
const freshSettings = planRestore(
  { ...base, lastLocalChangeAt: '2026-10-18T10:00:00.000Z' },
  { settings: { monthlyBudget: 750 }, lastLocalChangeAt: '2026-10-19T10:00:00.000Z' },
);
check('a fresher settings-only file is a change', freshSettings.changed === true);
check('with no rows added', freshSettings.added === 0, freshSettings.added);
check('and the budget is adopted', freshSettings.merged.settings.monthlyBudget === 750, freshSettings.merged.settings.monthlyBudget);

// Tesco shifts ride the same document, so a file that carries only shifts is a
// merge too — the old app's toast counts them separately for that reason.
const shifts = planRestore(base, { tesco: { shifts: [{ id: 's1', date: '2026-09-01', start: '09:00', end: '17:00' }] } });
check('a shifts-only file counts its shifts', shifts.addedShifts === 1, shifts.addedShifts);
check('and is a change', shifts.changed === true);

// ============================================================
// 3. Newest wins, and a tombstone still holds
// ============================================================
const local = doc([entry({ amount: 4.47, createdAt: '2026-10-12T09:00:00.000Z' })]);
const newerFile = doc([entry({ amount: 6, createdAt: '2026-10-12T10:00:00.000Z' })]);
const newerWins = planRestore(local, newerFile);
check('the newer copy of a row wins the merge',
  newerWins.merged.entries[0].amount === 6, newerWins.merged.entries[0].amount);
check('and the row is not duplicated', newerWins.merged.entries.length === 1, newerWins.merged.entries.length);

const olderFile = doc([entry({ amount: 1.99, createdAt: '2026-10-12T08:00:00.000Z' })]);
const localWins = planRestore(local, olderFile);
check('a file cannot roll back a newer local row',
  localWins.merged.entries[0].amount === 4.47, localWins.merged.entries[0].amount);

const tombstoned = doc([], { deletedEntryIds: ['e1'] });
const withDeleted = planRestore(tombstoned, doc([entry()]));
check('a tombstone holds against a file that never heard of the deletion',
  withDeleted.merged.entries.length === 0, withDeleted.merged.entries.length);
check('a resurrected row is not counted as added', withDeleted.added === 0, withDeleted.added);

// ============================================================
// 4. Cash re-anchors, because a merge otherwise keeps this device's €0.00
// ============================================================
const emptyCash = doc([]);
const fileWithCoins = doc([], { coins: { '2': 1 } });
check('the file figure is adopted when this device has no cash balance',
  adoptBackupCash(emptyCash, fileWithCoins) === true);
check('and it is the file\u2019s \u20ac2.00', cashBalance(emptyCash.settings, emptyCash.entries) === 2,
  cashBalance(emptyCash.settings, emptyCash.entries));

const hasCash = doc([], { coins: { '1': 5 } });
check('a device with its own figure keeps it', adoptBackupCash(hasCash, fileWithCoins) === false);
check('and the figure is unchanged', cashBalance(hasCash.settings, hasCash.entries) === 5,
  cashBalance(hasCash.settings, hasCash.entries));

// No figure in the file at all: the rows are the truth, which is what makes a
// restored all-coins copy follow its own Cash entries instead of freezing.
const cashRows = doc([entry({ method: 'Cash', amount: 3 })]);
const noFigure = doc([]);
check('an all-rows copy is re-anchored to its rows', adoptBackupCash(cashRows, noFigure) === true,
  JSON.stringify(cashRows.settings.coinsManual));
check('by following the entries', cashRows.settings.coinsManual === false, String(cashRows.settings.coinsManual));
check('so the balance is minus the cash rows', cashBalance(cashRows.settings, cashRows.entries) === -3,
  cashBalance(cashRows.settings, cashRows.entries));
check('the coin count still adds up', computeCashTotal(cashRows.settings.coins || {}) === 0);

// A file that has nothing to say about cash and a device with no Cash rows and
// no balance is left alone.
const plain = doc([]);
check('nothing to re-anchor means nothing is written', adoptBackupCash(plain, doc([])) === false);

// ============================================================
const total = pass + failures.length;
if (failures.length) {
  console.error(`test-data-portability: ${failures.length} FAILED, ${pass} passed\n`);
  for (const failure of failures) console.error(`  \u2717 ${failure}`);
  process.exit(1);
}
console.log(`test-data-portability: OK \u2014 ${total} checks (the Data sheet\u2019s size and counts, a planned merge, newest-wins with tombstones, and the cash re-anchor)`);
