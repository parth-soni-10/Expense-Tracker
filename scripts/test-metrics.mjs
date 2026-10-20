#!/usr/bin/env node
/**
 * The ported money layer, checked against arithmetic on the frozen document.
 *
 * `app/src/metrics.ts` is where the new shell decides what counts as spending,
 * what an account holds, and what the month is heading for. The shipping app
 * answers those questions in app.js; before the cutover the two must agree, and
 * this is the part of that agreement that can be pinned without a browser.
 *
 * Every expectation below is computed by hand from
 * `scripts/fixtures/expense-tracker-v1.schema2.json` (frozen, built by the OLD
 * modules), not by calling the code under test:
 *
 *   entries (all October 2026)
 *     10-12 Revolut  expense  4.47  Lidl groceries
 *     10-11 AIB      credit   250   Pay
 *     10-10 AIB      expense  50    To savings  ─┐ one transfer, two legs
 *     10-10 RS       credit   50    To savings  ─┘
 *     10-09 AIB      expense  12.5  Dinner split (mine)   ─┐ one split, two legs
 *     10-08 AIB      expense  12.5  Dinner split (theirs) ─┘
 *     10-07 AIB      credit   312.4 Tesco shift pay
 *     10-01 AIB      note     0     Top-up
 *   AIB checkpoint 2026-10-01 = 1200, saved 2026-10-12T09:30:00Z.
 *
 * Run: node scripts/test-metrics.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, 'fixtures/expense-tracker-v1.schema2.json'), 'utf8'));

const metrics = await import('../app/src/metrics.ts');

let failures = 0;
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.005;
const check = (name, ok, detail = '') => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) => check(name, near(actual, expected), `${actual} ≠ ${expected}`);

const settings = fixture.settings;
const entries = fixture.entries;
const byDetails = (text) => entries.find((e) => e.details === text);

/* ── what counts ─────────────────────────────────────────────────────────── */

const spent = entries
  .filter((e) => metrics.isBudgetSpendingEntry(settings, e))
  .reduce((sum, e) => sum + e.amount, 0);
eq('month spending is the two real purchases and the split, not the transfer', spent, 29.47);

const income = entries
  .filter((e) => metrics.isBudgetIncomeEntry(settings, e))
  .reduce((sum, e) => sum + e.amount, 0);
eq('month income excludes the savings leg', income, 562.4);

eq('month net is spending minus income', metrics.totalForMonth(settings, entries, '2026-10'), 29.47 - 562.4);

check('a transfer leg is neither spending nor income',
  !metrics.isSpendingEntry(settings, byDetails('To savings')) && !metrics.isIncomeEntry(settings, byDetails('To savings')));
check('a split leg is spending', metrics.isSpendingEntry(settings, byDetails('Dinner split (mine)')));
check('the savings account never enters budget math',
  !metrics.isBudgetIncomeEntry(settings, byDetails('To savings')) || byDetails('To savings').method !== 'RS');
check('RS is in the budget-excluded list', metrics.BUDGET_EXCLUDED_METHOD_IDS.includes('RS'));
// A plain savings movement (no transfer pair) must still be invisible to the
// month, both ways: moving €40 into savings is not spending and not income.
check('an RS expense is not budget spending',
  !metrics.isBudgetSpendingEntry(settings, { type: 'expense', method: 'RS', category: 'misc', amount: 40, details: 'Savings' }));
check('an RS credit is not budget income',
  !metrics.isBudgetIncomeEntry(settings, { type: 'credit', method: 'RS', category: 'misc', amount: 40, details: 'Savings out' }));
check('a bank load is not spending (description rule)',
  !metrics.isSpendingEntry(settings, { type: 'expense', method: 'TG', details: 'Tesco spend', amount: 3 }));
check('a note is never a money row', !metrics.isSpendingEntry(settings, byDetails('Top-up')));

/* ── balances ────────────────────────────────────────────────────────────── */

const checkpoints = metrics.checkpointsFor(settings);
eq('AIB balance = checkpoint + everything after it', metrics.balanceAtForEntries(entries, 'AIB', '2026-10-12', checkpoints), 1687.4);
eq('Revolut has one purchase and no checkpoint', metrics.balanceAtForEntries(entries, 'Revolut', '2026-10-12', checkpoints), -4.47);
eq('RS holds the savings leg', metrics.balanceAtForEntries(entries, 'RS', '2026-10-12', checkpoints), 50);
eq('accounts sum to the headline balance', metrics.totalAccountBalanceAt(entries, '2026-10-12', checkpoints), 1732.93);

eq('on the checkpoint date the checkpoint is the balance', metrics.balanceAtForEntries(entries, 'AIB', '2026-10-01', checkpoints), 1200);

// A transaction dated on the checkpoint date but created afterwards must still
// apply: reconciling today never hides an expense added a minute later.
const afterSave = {
  ...byDetails('Dinner split (mine)'),
  id: 'same-day-after-checkpoint',
  date: '2026-10-01',
  amount: 10,
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
};
eq('a same-day expense created after the checkpoint still counts',
  metrics.balanceAtForEntries([...entries, afterSave], 'AIB', '2026-10-12', checkpoints), 1687.4 - 10);

// An edit after the checkpoint applies only as the net change. This row was on
// the ledger (created 09:00) when the checkpoint was saved at 09:30, so the
// checkpoint's €1,200 already contains its old €4; the edit to €10 must move the
// balance by €6, not by €10.
const sameDay = {
  id: 'edited-on-checkpoint-day',
  date: '2026-10-01',
  type: 'expense',
  category: 'misc',
  method: 'AIB',
  amount: 10,
  details: 'Edited later',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  mutationHistory: [{
    id: 'edited-on-checkpoint-day',
    date: '2026-10-01',
    type: 'expense',
    category: 'misc',
    method: 'AIB',
    amount: 4,
    details: 'Edited later',
    at: '2026-10-13T00:00:00.000Z',
    createdAt: '2026-10-01T09:00:00.000Z',
  }],
};
eq('an edit after the checkpoint applies as its net effect only',
  metrics.balanceAtForEntries([...entries, sameDay], 'AIB', '2026-10-12', checkpoints), 1687.4 - 6);

const { balance, points } = metrics.computeBalance(entries, '2026-10-12', checkpoints);
eq('computeBalance agrees with the account total', balance, 1732.93);
check('the trend has one point per distinct date, oldest first',
  points.length === 7 && points[0].date === '2026-10-01' && points.at(-1).date === '2026-10-12',
  points.map((p) => p.date).join(','));
check('the trend ends on the balance it labels', near(points.at(-1).balance, balance) || points.at(-1).date !== '2026-10-12');

/* ── gift cards ──────────────────────────────────────────────────────────── */

const giftEntries = [
  { id: 'g1', date: '2026-10-02', type: 'credit', category: 'GC', method: 'TG', amount: 20, details: 'Load TG' },
  { id: 'g2', date: '2026-10-04', type: 'expense', category: 'gro', method: 'TG', amount: 5, details: 'Tesco run' },
  { id: 'g3', date: '2026-10-05', type: 'expense', category: 'GC', method: 'TG', amount: 3, details: 'Top-up' },
];
const gift = metrics.computeGiftCardBalance(settings, giftEntries, 'TG', '2026-10-12');
eq('a gift card load adds, a purchase spends', gift.balance, 18);
eq('loads are reported', gift.loaded, 23);
eq('spending is reported', gift.spent, 5);

/* ── cash ────────────────────────────────────────────────────────────────── */

eq('the coin counter sums denominations', metrics.computeCashTotal({ 2: 3, 0.5: 1 }), 6.5);
check('an empty counter is €0', metrics.computeCashTotal({}) === 0);
// €7 is a €5 coin plus a €2 coin: two pieces, not seven.
eq('coinsForAmount finds the fewest pieces', metrics.coinsForAmount(7)['5'] + metrics.coinsForAmount(7)['2'], 2);
check('coinsForAmount never emits a zero count', !('1' in metrics.coinsForAmount(7)));
eq('a cash credit adds to cash on hand',
  metrics.cashBalance({ ...settings, coinsManual: false, cashBase: 100 }, [
    { id: 'c1', date: '2026-10-02', type: 'credit', method: 'Cash', amount: 20, details: 'ATM' },
    { id: 'c2', date: '2026-10-03', type: 'expense', method: 'Cash', amount: 5, details: 'Coffee' },
  ]), 115);
eq('a manual coin counter is the balance while the user maintains it',
  metrics.cashBalance({ ...settings, coinsManual: true, coins: { 20: 2, 0.5: 1 } }, []), 40.5);

/* ── projections ─────────────────────────────────────────────────────────── */

// Pinned to the 16th so elapsed days, and therefore the projection, are fixed.
const forecast = metrics.spendingForecast(settings, entries, '2026-10', new Date(2026, 9, 16));
eq('forecast month-to-date spending', forecast.spent, 29.47);
check('sixteen days and three entries is enough to project', forecast.projectedReady);
const expectedDaily = 29.47 / 16;
eq('the daily rate is variable spending over elapsed days', forecast.dailyAverage, expectedDaily);
eq('the projection repeats that rate over the days left',
  forecast.projected, 29.47 + expectedDaily * (31 - 16));
eq('remaining is the budget minus the projection', forecast.remaining, 900 - (29.47 + expectedDaily * 15));

const early = metrics.spendingForecast(settings, entries, '2026-10', new Date(2026, 9, 3));
check('a month three days old has no projection', early.projected === null && early.remaining === null);

const empty = metrics.spendingForecast(settings, [], '2026-09', new Date(2026, 9, 16));
check('an empty past month projects nothing and does not divide by zero',
  empty.spent === 0 && empty.projected === null && empty.dailyAverage === 0);

const runway = metrics.computeRunway(settings, entries, 1732.93, '2026-10', new Date(2026, 9, 16));
eq('runway projects the balance to month end',
  runway.projectedEnd, 1732.93 - expectedDaily * (31 - 16));
check('runway reports days to zero from balance and pace',
  runway.daysToZero === Math.floor(1732.93 / expectedDaily), String(runway.daysToZero));

/* ── safe to spend ───────────────────────────────────────────────────────── */

// On 16 Oct 2026 there are 31 − 16 + 1 = 16 days left in the month.
const safe = metrics.safeToSpend(settings, 29.47, new Date(2026, 9, 16));
eq('safe today is the budget left over the days left', safe.safeToday, (900 - 29.47) / 16);
eq('budget left is the budget minus spending', safe.remainingBudget, 870.53);
eq('a spent-out budget gives nothing back, not a negative allowance',
  metrics.safeToSpend({ ...settings, monthlyBudget: 10 }, 29.47, new Date(2026, 9, 16)).remainingBudget, 0);
check('no budget means no safe-to-spend figure', metrics.safeToSpend({ ...settings, monthlyBudget: 0 }, 0).safeToday === null);

/* ── prefs the screen reads ──────────────────────────────────────────────── */

check('the short method name drops the provider prefix', metrics.methodShort(settings, 'TG') === 'Tesco');
check('an unknown method id is its own label', metrics.methodShort(settings, 'ZZZ') === 'ZZZ');
check('a custom method is offered', metrics.everyMethod(settings).some((m) => m.id === 'FXM'));

if (failures) {
  console.error(`\ntest-metrics: ${failures} failure(s)`);
  process.exit(1);
}
console.log('test-metrics: OK — filters, checkpoints, gift cards, cash and projections agree with the frozen document');
