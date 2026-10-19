#!/usr/bin/env node
/**
 * Freezes an `expense-tracker:v1` (schemaVersion 2) document for the
 * load-existing-document test.
 *
 * It is built with the OLD modules (`storage.js` + `seed.js` at the repo root),
 * because the point of the test is that a document written by the shipping app
 * still loads in the ported code. The document is synthetic: a small ledger
 * covering the shapes the app actually stores — ordinary expenses and income, a
 * transfer pair, a split leg, a load adjustment, a recurring bill, a custom
 * category and method, a balance checkpoint, a Tesco week and a deleted-entry
 * tombstone. No profile, PIN, credential or cloud data is included, and nothing
 * is read from the device.
 *
 * Run: node scripts/make-cents-fixture.mjs
 * Writes: scripts/fixtures/expense-tracker-v1.schema2.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
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

const { validateState, saveState, loadState } = await import('../storage.js');
const { uid } = await import('../storage.js');

const at = '2026-10-12T09:30:00.000Z';
const entry = (over = {}) => ({
  id: uid(),
  date: '2026-10-12',
  type: 'expense',
  category: 'gro',
  details: 'Fixture row',
  amount: 4.47,
  method: 'Revolut',
  note: '',
  createdAt: at,
  ...over,
});

const transferId = uid();
const splitId = uid();
const deletedId = uid();

const document = validateState({
  schemaVersion: 2,
  entries: [
    entry({ details: 'Lidl groceries', amount: 4.47, method: 'Revolut', note: 'fixture' }),
    entry({ date: '2026-10-11', details: 'Pay', type: 'credit', category: 'misc', amount: 250, method: 'AIB' }),
    entry({ date: '2026-10-10', details: 'To savings', type: 'expense', category: 'misc', amount: 50, method: 'AIB', transferId }),
    entry({ date: '2026-10-10', details: 'To savings', type: 'credit', category: 'misc', amount: 50, method: 'RS', transferId }),
    entry({ date: '2026-10-09', details: 'Dinner split (mine)', type: 'expense', category: 'misc', amount: 12.5, method: 'AIB', splitId }),
    entry({ date: '2026-10-08', details: 'Dinner split (theirs)', type: 'expense', category: 'misc', amount: 12.5, method: 'AIB', splitId }),
    entry({ date: '2026-10-01', details: 'Top-up', type: 'note', category: 'misc', amount: 0, method: 'AIB', budgetExcluded: true }),
    entry({ date: '2026-10-07', details: 'Tesco shift pay', type: 'credit', category: 'misc', amount: 312.4, method: 'AIB' }),
  ],
  settings: {
    monthlyBudget: 900,
    currency: '€',
    customCategories: [{ id: 'fixcat', label: 'Fixture category' }],
    customMethods: [{ id: 'FXM', label: 'Fixture method' }],
    methodHidden: ['AG'],
    recurring: [
      { id: uid(), details: 'Fixture bill', amount: 12.99, category: 'bil', method: 'AIB', frequency: 'monthly', day: 5, active: true },
    ],
    coins: { aiB: { amount: 0, updatedAt: at } },
    tescoVouchers: 15,
    categoryBudgets: { gro: 240 },
    balanceCheckpoints: { AIB: [{ date: '2026-10-01', balance: 1200, at }] },
    deletedEntryIds: [deletedId],
    enabledTabs: ['dashboard', 'add', 'history', 'balances', 'tesco', 'insights'],
    tescoRates: { base: 13.85, sunday: 1.3, night: 1.1, bankHoliday: 1.5, sundayPremium: 3 },
    tescoWeekNos: { '2026-10-05': 41 },
    tescoPayLedger: { '2026-10-07': { id: uid(), amount: 312.4, by: 'fill' } },
  },
  tesco: {
    shifts: [{ id: uid(), date: '2026-10-07', start: '09:00', end: '17:00', breakMin: 30, note: 'fixture' }],
    payslips: [{ id: uid(), payDate: '2026-10-15', gross: 312.4, paye: 20, usc: 5, prsi: 4, pension: 0 }],
  },
  lastLocalChangeAt: at,
});

if (!saveState(document)) throw new Error('fixture: saveState refused the document');
const stored = loadState();
if (JSON.stringify(stored) !== JSON.stringify(document)) throw new Error('fixture: the old code does not round-trip its own document');

const out = resolve(here, 'fixtures/expense-tracker-v1.schema2.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`fixture: wrote ${out} — ${document.entries.length} entries, schemaVersion ${document.schemaVersion}`);
