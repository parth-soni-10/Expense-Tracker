#!/usr/bin/env node
/**
 * The undo journal, including the half that matters: the reload.
 *
 * A destructive action applies immediately and can be undone — but the six
 * seconds a toast lives for are not the only window in which a mis-tap should
 * be recoverable. The shipping app writes the removed rows to a capped stack in
 * localStorage (`cents:p/<id>/undo`) before the toast is even shown, and the
 * next page load offers the same undo.
 *
 * This guard runs the ported path (`app/src/actions.ts` + `app/lib/storage.ts`)
 * in a fresh in-memory localStorage: delete a group, read the journal back,
 * simulate a reload with a document that no longer holds those rows, restore,
 * and assert both the ledger and the tombstones are whole again. The real
 * browser's storage is never touched.
 *
 * Run: node scripts/test-undo-journal.mjs
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
store.set('cents:p/personal/state', JSON.stringify(fixture));

const actions = await import('../app/src/actions.ts');
const storage = await import('../app/lib/storage.ts');

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

let state = storage.loadState();
const save = () => {
  const ok = storage.saveState(state);
  if (ok) store.set('cents:p/personal/state', JSON.stringify(state));
  return ok;
};

const before = JSON.stringify(state.entries);
const transferLegs = state.entries.filter((entry) => entry.transferId);
check('the fixture holds a two-leg transfer to delete', transferLegs.length === 2);

/* ── delete applies immediately, and writes the journal ───────────────────── */

const removedIds = transferLegs.map((entry) => entry.id);
const step = actions.deleteEntries(state, save, removedIds, 'Delete To savings');
check('delete removes every leg at once', !state.entries.some((entry) => removedIds.includes(entry.id)));
check('delete tombstones the ids so a sync cannot resurrect them',
  removedIds.every((id) => state.settings.deletedEntryIds.includes(id)));
check('the stored document lost the rows', !JSON.parse(store.get('cents:p/personal/state')).entries.some((entry) => removedIds.includes(entry.id)));

const record = storage.loadUndoJournal();
check('a reload-safe record was written', !!record);
check('  it names the action', record?.label === 'Delete To savings', record?.label);
check('  it holds both removed legs', record?.entries?.length === 2, String(record?.entries?.length));

/* ── the reload: a new document, same storage ─────────────────────────────── */

state = storage.loadState();
check('the reloaded document is the post-delete one', !state.entries.some((entry) => removedIds.includes(entry.id)));
const offered = actions.latestUndo(state);
check('the reload offers the undo', !!offered && offered.entries.length === 2);

actions.restoreUndoJournal(state, save, offered);
check('restore puts both legs back', removedIds.every((id) => state.entries.some((entry) => entry.id === id)));
check('restore clears the tombstones it revived',
  !state.settings.deletedEntryIds.some((id) => removedIds.includes(id)));
check('the ledger is field-for-field what it was', JSON.stringify(
  [...state.entries].sort((a, b) => String(a.id).localeCompare(String(b.id))),
) === JSON.stringify(
  JSON.parse(before).sort((a, b) => String(a.id).localeCompare(String(b.id))),
));

/* ── one record, spent once ───────────────────────────────────────────────── */

const fresh = storage.loadUndoJournal();
check('the record is still there until it is spent', !!fresh);
storage.popUndoJournal();
check('popping it leaves nothing to offer', storage.loadUndoJournal() === null);
check('a second pop is harmless', (storage.popUndoJournal(), storage.loadUndoJournal() === null));

/* ── checkpoints are journalled too ───────────────────────────────────────── */

const checkpoints = await import('../app/src/checkpoints.ts');
const point = state.settings.balanceCheckpoints?.AIB?.[0];
check('the fixture has an AIB checkpoint to remove', point?.date === '2026-10-01');
const removedPoint = checkpoints.removeCheckpoint(state, 'AIB', '2026-10-01');
check('removing a checkpoint takes it out of the document', !!removedPoint && !state.settings.balanceCheckpoints.AIB.some((p) => p.date === '2026-10-01'));
actions.trackAction(save, {
  label: 'Remove AIB balance',
  undo: () => { state.settings.balanceCheckpoints.AIB = [...state.settings.balanceCheckpoints.AIB, removedPoint].sort((a, b) => a.date.localeCompare(b.date)); },
  checkpoints: [{ methodId: 'AIB', point: removedPoint }],
});
const cpRecord = storage.loadUndoJournal();
check('the checkpoint removal is journalled', cpRecord?.checkpoints?.[0]?.methodId === 'AIB', JSON.stringify(cpRecord?.checkpoints?.[0] || null));
state = storage.loadState();
actions.restoreUndoJournal(state, save, cpRecord);
check('restoring re-adds the checkpoint at its date',
  state.settings.balanceCheckpoints.AIB.some((p) => p.date === '2026-10-01' && p.balance === 1200));

/* ── a stale offer cannot outlive its action ─────────────────────────────── */

// After the rows are back, the old record describes nothing that is missing.
check('a spent record is skipped rather than offered again',
  actions.missingJournalData(state, cpRecord).entries.length === 0
  && actions.missingJournalData(state, cpRecord).checkpoints.length === 0);

store.clear();
if (failures) {
  console.error(`\ntest-undo-journal: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-undo-journal: OK — ${checks} checks (delete applies at once, survives a reload, restores exactly)`);
