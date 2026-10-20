#!/usr/bin/env node
/**
 * Gate C: the three money rules that are cheapest to break and hardest to see.
 *
 *   1. The quick-entry parser — what a typed line becomes.
 *   2. Euro precision — money is stored in cents, so a third decimal is refused
 *      rather than truncated or rounded.
 *   3. Split and transfer semantics — one group id per logical transaction, and
 *      the two linked legs an account-to-card move needs.
 *
 * The parser and the leg builder live in `app.js`, which is a DOM program and
 * cannot be imported into Node. This file therefore LIFTS the declarations it
 * tests out of that file and runs the real source, rather than re-implementing
 * the rules: an edit to app.js is what this guard sees, and a copy of the rules
 * here could never pass while the app disagreed with it. Every slice is taken
 * between two anchors that must both exist, so a move or a rename fails loudly
 * instead of silently testing nothing.
 *
 * The ledger half is imported from the ported core (`app/lib/storage.ts`, types
 * stripped by Node), because the pairs have to survive a load/save round trip —
 * not just be constructed correctly.
 *
 * Run: node scripts/test-parity-money.mjs     (Node 22+)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appjs = readFileSync(resolve(here, '../app.js'), 'utf8');

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- lift the shipping declarations -----------------------------------------

/** `function name(...) { ... }` up to the first closing brace in column 0 —
 *  this file is formatted with top-level declarations flush left, so that is
 *  the end of the declaration and not a brace inside it. */
function liftFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js has no function ${name}() — this guard cannot test what it asserts`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`app.js: ${name}() has no closing brace at column 0`);
  return source.slice(start, end + 3);
}

/** The contiguous quick-entry block: the parser, the description cleaner, the
 *  split-slice detector, the precision rule and the leg builder. Taken as one
 *  slice because they are one region of the file, and every name below is
 *  referenced by another in it. */
function liftQuickBlock(source) {
  const start = source.indexOf('function parseNaturalLanguage(text)');
  const end = source.indexOf('function duplicateGroups(');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('app.js: the quick-entry block no longer sits between parseNaturalLanguage() and duplicateGroups()');
  }
  return source.slice(start, end);
}

const lifted = [
  liftFunction(appjs, 'localDateKey'),
  'const today = () => localDateKey();',
  liftFunction(appjs, 'parseAmount'),
  appjs.slice(appjs.indexOf('function categoryFromDescription('), appjs.indexOf('function previousMonthKey(')),
  liftQuickBlock(appjs),
].join('\n');

const build = new Function('uid', 'nowIso', `${lifted}
return { parseAmount, parseNaturalLanguage, overPreciseAmount, quickEntryLegs, cleanQuickDescription };`);

let counter = 0;
const quick = build(() => `leg-${++counter}`, () => '2026-10-20T09:00:00.000Z');
const { parseAmount, parseNaturalLanguage, overPreciseAmount, quickEntryLegs } = quick;

const localDateKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const todayKey = localDateKey();
const yesterdayKey = localDateKey(new Date(Date.now() - 86400000));

// ---- 1. the quick-entry parser ---------------------------------------------

const lidl = parseNaturalLanguage('lidl groceries 4.47 revolut');
check('the example line parses', !!lidl && !lidl.error, JSON.stringify(lidl));
check('  amount is 4.47', lidl?.amount === 4.47, String(lidl?.amount));
check('  it is an expense', lidl?.type === 'expense', lidl?.type);
check('  Revolut is the method', lidl?.method === 'Revolut', lidl?.method);
check('  groceries is the category', lidl?.category === 'gro', lidl?.category);
check('  the description drops the amount and the method', lidl?.details === 'Lidl Groceries', lidl?.details);
check('  it is dated today', lidl?.date === todayKey, lidl?.date);

const coffee = parseNaturalLanguage('coffee 3.50 cash');
check('cash is read as the method', coffee?.method === 'Cash', coffee?.method);
check('a plain description survives', coffee?.details === 'Coffee', coffee?.details);

const tescoYesterday = parseNaturalLanguage('Spent €18.50 at Tesco from Revolut yesterday');
check('a currency symbol is not an amount twice', tescoYesterday?.amount === 18.5, String(tescoYesterday?.amount));
check('"yesterday" is the previous day', tescoYesterday?.date === yesterdayKey, tescoYesterday?.date);
check('the description keeps the merchant only', tescoYesterday?.details === 'Tesco', tescoYesterday?.details);

check('a grouped thousand is not read as 1.20', parseNaturalLanguage('rent 1,200')?.amount === 1200,
  String(parseNaturalLanguage('rent 1,200')?.amount));
check('a multiplier is applied', parseNaturalLanguage('2 × 4.50')?.amount === 9,
  String(parseNaturalLanguage('2 × 4.50')?.amount));

const salary = parseNaturalLanguage('salary 2500 received');
check('income is a credit', salary?.type === 'credit', salary?.type);
check('income falls back to the primary account', salary?.method === 'AIB', salary?.method);

const noAmount = parseNaturalLanguage('lunch with sam');
check('a line with no amount is refused, with a reason', !!noAmount?.error, JSON.stringify(noAmount));
check('an empty line parses to nothing', parseNaturalLanguage('   ') === null);

// ---- 2. euro precision ------------------------------------------------------

const amountCases = [
  ['4.47', 4.47], ['€4.47', 4.47], ['4,47', 4.47], ['1,234.56', 1234.56],
  ['1,200', 1200], ['4.4', 4.4], ['12', 12],
  ['', NaN], ['abc', NaN], ['-3.00', NaN], ['2500', 2500],
];
for (const [input, expected] of amountCases) {
  const got = parseAmount(input);
  const ok = Number.isNaN(expected) ? Number.isNaN(got) : got === expected;
  check(`parseAmount(${JSON.stringify(input)}) is ${expected}`, ok, String(got));
}

const overCases = [
  ['lidl 4.477', '4.477'],
  ['spent 4.4770 on coffee', '4.4770'],
  ['rent 1,234.567', '1,234.567'],
  ['lidl 4.47', null],
  ['rent 1,200', null],
  ['rent 1,200.50', null],
  ['rent 1.200.000', null],
  ['call 12.07.2026 about it', null],
  ['coffee 3.5', null],
];
for (const [input, expected] of overCases) {
  const got = overPreciseAmount(input);
  check(`overPreciseAmount(${JSON.stringify(input)}) is ${expected}`, got === expected, String(got));
}

const truncated = parseNaturalLanguage('lidl 4.477');
check('the quick entry refuses a third decimal instead of truncating it',
  !!truncated?.error && /4\.477/.test(truncated.error), JSON.stringify(truncated));
check('the refusal says what to do', /two places/.test(truncated?.error || ''), truncated?.error);
check('a two-decimal line still parses', parseNaturalLanguage('lidl 4.47')?.amount === 4.47);

// The storage half: the validator drops a non-cent amount rather than rounding
// it. A fresh in-memory localStorage keeps the device — and its profile data —
// untouched (the same shim test-load-existing.mjs uses).
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const { validateState, saveState, loadState } = await import('../app/lib/storage.ts');
const KEY = 'cents:p/personal/state';

const dirty = validateState({
  schemaVersion: 2,
  settings: {},
  tesco: {},
  entries: [
    { id: 'a', date: '2026-10-01', type: 'expense', category: 'misc', details: 'Fine', amount: 4.47, method: 'AIB' },
    { id: 'b', date: '2026-10-01', type: 'expense', category: 'misc', details: 'Three decimals', amount: 4.477, method: 'AIB' },
    { id: 'c', date: '2026-10-01', type: 'expense', category: 'misc', details: 'Float drift', amount: 0.1 + 0.2, method: 'AIB' },
  ],
});
check('a cent-exact amount is stored', dirty.entries.some(e => e.id === 'a'));
check('a three-decimal amount is dropped, not rounded', !dirty.entries.some(e => e.id === 'b'),
  JSON.stringify(dirty.entries.map(e => [e.id, e.amount])));
check('float drift is dropped, not rounded to 0.30', !dirty.entries.some(e => e.id === 'c'),
  JSON.stringify(dirty.entries.map(e => [e.id, e.amount])));

// ---- 3. split and transfer semantics ---------------------------------------

const transferLegs = quickEntryLegs(parseNaturalLanguage('tesco load 20 from revolut'));
check('a card load becomes exactly two legs', transferLegs.length === 2, String(transferLegs.length));
check('  one debit and one credit',
  transferLegs.map(l => l.type).sort().join(',') === 'credit,expense', transferLegs.map(l => l.type).join(','));
check('  both legs share one transferId',
  transferLegs[0]?.transferId && transferLegs[0].transferId === transferLegs[1]?.transferId);
check('  the money leaves the named account and lands on the card',
  transferLegs.find(l => l.type === 'expense')?.method === 'Revolut'
  && transferLegs.find(l => l.type === 'credit')?.method === 'TG',
  transferLegs.map(l => `${l.type}:${l.method}`).join(','));
check('  the amounts and dates match',
  transferLegs[0]?.amount === 20 && transferLegs[1]?.amount === 20
  && transferLegs[0]?.date === transferLegs[1]?.date);
check('  the legs are distinct rows', transferLegs[0]?.id && transferLegs[0].id !== transferLegs[1]?.id);
check('  neither leg is a split leg', transferLegs.every(l => !l.splitId));

const splitLegs = quickEntryLegs(parseNaturalLanguage('groceries 24: 10 cash, 14 revolut'));
check('a mixed payment becomes one leg per method', splitLegs.length === 2, String(splitLegs.length));
check('  both legs share one splitId',
  splitLegs[0]?.splitId && splitLegs[0].splitId === splitLegs[1]?.splitId);
check('  each leg carries its own method and amount',
  splitLegs[0]?.method === 'Cash' && splitLegs[0]?.amount === 10
  && splitLegs[1]?.method === 'Revolut' && splitLegs[1]?.amount === 14,
  splitLegs.map(l => `${l.method}:${l.amount}`).join(','));
check('  the legs add up to the parsed total',
  Math.round(splitLegs.reduce((s, l) => s + l.amount, 0) * 100) / 100 === 24);
check('  a split is not a transfer', splitLegs.every(l => !l.transferId));

const singleLegs = quickEntryLegs(parseNaturalLanguage('lidl groceries 4.47 revolut'));
check('a plain line becomes one leg', singleLegs.length === 1, String(singleLegs.length));
check('  with no group id at all', !singleLegs[0]?.transferId && !singleLegs[0]?.splitId);
check('  an error parses to no legs', quickEntryLegs({ error: 'no amount' }).length === 0);

// The document round trip: a group that is correct when built must still be a
// group after the validator has seen it, or history would show two rows.
store.set(KEY, JSON.stringify({ schemaVersion: 2, settings: {}, tesco: {}, entries: transferLegs }));
const reloadedTransfer = loadState();
check('the transfer pair survives a save/load round trip', reloadedTransfer.entries.length === 2,
  String(reloadedTransfer.entries.length));
check('  with one shared transferId',
  new Set(reloadedTransfer.entries.map(e => e.transferId)).size === 1
  && !!reloadedTransfer.entries[0].transferId);
check('  and the two methods still differ',
  new Set(reloadedTransfer.entries.map(e => e.method)).size === 2);

store.set(KEY, JSON.stringify({ schemaVersion: 2, settings: {}, tesco: {}, entries: splitLegs }));
const reloadedSplit = loadState();
check('the split group survives a save/load round trip', reloadedSplit.entries.length === 2,
  String(reloadedSplit.entries.length));
check('  with one shared splitId and its legs intact',
  new Set(reloadedSplit.entries.map(e => e.splitId)).size === 1
  && reloadedSplit.entries.reduce((s, e) => s + e.amount, 0) === 24);

// An orphan leg is the failure the pair exists to prevent: half a transfer
// would either spend money that never left or credit a card nobody funded.
const orphan = validateState({
  schemaVersion: 2, settings: {}, tesco: {},
  entries: [{ id: 'x', date: '2026-10-01', type: 'transfer', category: 'misc', details: 'Half', amount: 20, method: 'Revolut', transferId: 'gone' }],
});
check('a lone transfer leg is demoted to an ordinary expense',
  orphan.entries.length === 1 && orphan.entries[0].type === 'expense', orphan.entries[0]?.type);
check('  and loses the dangling transferId', !orphan.entries[0]?.transferId);

const mismatched = validateState({
  schemaVersion: 2, settings: {}, tesco: {},
  entries: [
    { id: 'p', date: '2026-10-01', type: 'expense', category: 'misc', details: 'Move', amount: 20, method: 'Revolut', transferId: 'pair' },
    { id: 'q', date: '2026-10-01', type: 'credit', category: 'misc', details: 'Move', amount: 25, method: 'TG', transferId: 'pair' },
  ],
});
check('a pair whose legs disagree is not kept as a transfer',
  mismatched.entries.length === 2 && mismatched.entries.every(e => !e.transferId),
  JSON.stringify(mismatched.entries.map(e => [e.amount, e.transferId])));
check('  both legs stay visible as transactions',
  mismatched.entries.every(e => e.type === 'expense' || e.type === 'credit'));

// ---- verdict ----------------------------------------------------------------

store.clear();
if (failures) {
  console.error(`\ntest-parity-money: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-parity-money: OK — ${checks} checks (quick entry, euro precision, split/transfer pairs)`);
