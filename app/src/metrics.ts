/* The ledger's arithmetic, ported from app.js with the `state` made explicit.
 *
 * Every screen asks the same handful of questions — what did this month cost,
 * what does each account hold today, how much was actually spent (not moved),
 * can we project the rest of the month — and Gate C's parity checks compare the
 * answers to the shipping app's. So the rules here are copied, not rewritten:
 * checkpoints are authoritative for the moment they were saved, transfers and
 * balance adjustments are neutral, savings (`RS`) never enters budget math.
 *
 * Nothing in this file touches the DOM or storage. Callers pass the document
 * they loaded; the functions only read it.
 */
import type { CentsSettings, CentsState, Entry } from '../lib/types.ts';
import { CATEGORIES, METHODS } from '../lib/seed.ts';
import { daysInMonth, localDateKey, monthKey, previousMonthKey, today } from './format.ts';

export const ACCOUNT_METHOD_IDS = ['AIB', 'Revolut', 'RS'];
export const GIFT_CARD_IDS = ['TG', 'LG', 'AG'];
/** Every method with a balance the app reconciles (cash is counted, not
 *  reconciled, so it is deliberately absent). */
export const BALANCE_METHOD_IDS = ['AIB', 'Revolut', 'RS', 'TG', 'LG', 'AG'];
/** Revolut Savings: moving money in or out of savings is not spending. */
export const BUDGET_EXCLUDED_METHOD_IDS = ['RS'];

export interface Checkpoint {
  date: string;
  at?: string;
  balance: number;
}

type Method = { id: string; label: string };

export function everyMethod(settings: CentsSettings): Method[] {
  const custom = Array.isArray(settings?.customMethods) ? settings.customMethods : [];
  return [...METHODS, ...custom.map((m) => ({ id: String(m.id), label: String(m.label || m.id) }))];
}

export function methodById(settings: CentsSettings, id: string): Method | null {
  return everyMethod(settings).find((method) => method.id === id) || null;
}

/** The short name a balance row uses: `TG · Tesco` reads as `Tesco`. */
export function methodShort(settings: CentsSettings, id: string): string {
  const method = methodById(settings, id);
  if (!method) return id;
  return method.label.includes(' · ') ? method.label.split(' · ')[1] : method.label;
}

export function methodLabel(settings: CentsSettings, id: string): string {
  return methodById(settings, id)?.label || id;
}

/** Category names come from the built-ins plus the document's own additions. */
export function categoryLabel(settings: CentsSettings, id: string): string {
  const custom = Array.isArray(settings?.customCategories) ? settings.customCategories : [];
  const found = [...CATEGORIES, ...custom.map((c) => ({ id: String(c.id), label: String(c.label || c.id) }))]
    .find((category) => category.id === id);
  return found?.label || id;
}

/** Balance methods, normalised to one sorted array per method. */
export function checkpointsFor(settings: CentsSettings): Record<string, Checkpoint[]> {
  const configured = (settings?.balanceCheckpoints || {}) as Record<string, unknown>;
  const out: Record<string, Checkpoint[]> = {};
  for (const id of BALANCE_METHOD_IDS) {
    const list = configured[id];
    out[id] = Array.isArray(list) ? (list as Checkpoint[]) : [];
  }
  return out;
}

/** The latest checkpoint on or before `targetDate`, or null. */
export function checkpointFor(
  checkpoints: Record<string, Checkpoint[]>,
  methodId: string,
  targetDate: string,
): Checkpoint | null {
  const list = checkpoints?.[methodId];
  if (!Array.isArray(list)) return null;
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index].date <= targetDate) return list[index];
  }
  return null;
}

/** Manual Load/Withdraw adjustments move money between tracked balances rather
 *  than representing real spending. The balance editor writes a deterministic
 *  `<method> load|withdrawal|spend` description, so both new and legacy entries
 *  are recognised without a schema change. Case-insensitive: the balance editor
 *  writes "Aldi withdrawal" and the quick field title-cases the same phrase. */
export function isBalanceAdjustmentEntry(settings: CentsSettings, entry: Entry): boolean {
  const details = entry?.details;
  if (typeof details !== 'string') return false;
  const text = details.trim().toLowerCase();
  const short = methodShort(settings, String(entry.method || '')).toLowerCase();
  return text === `${short} load` || text === `${short} withdrawal` || text === `${short} spend`;
}

export function isSpendingEntry(settings: CentsSettings, entry: Entry): boolean {
  return entry.type === 'expense' && !entry.transferId && !isBalanceAdjustmentEntry(settings, entry);
}

export function isBudgetExcluded(entry: Entry): boolean {
  return entry?.budgetExcluded === true;
}

export function isBudgetSpendingEntry(settings: CentsSettings, entry: Entry): boolean {
  return isSpendingEntry(settings, entry)
    && !isBudgetExcluded(entry)
    && !BUDGET_EXCLUDED_METHOD_IDS.includes(String(entry.method || ''));
}

export function isIncomeEntry(settings: CentsSettings, entry: Entry): boolean {
  return entry.type === 'credit' && !entry.transferId && !isBalanceAdjustmentEntry(settings, entry);
}

export function isBudgetIncomeEntry(settings: CentsSettings, entry: Entry): boolean {
  return isIncomeEntry(settings, entry)
    && !isBudgetExcluded(entry)
    && !BUDGET_EXCLUDED_METHOD_IDS.includes(String(entry.method || ''));
}

export function entriesForMonth(entries: Entry[], key: string): Entry[] {
  return entries.filter((e) => monthKey(String(e.date || '')) === key);
}

/** Month net: spending minus income, both budget-eligible. */
export function totalForMonth(settings: CentsSettings, entries: Entry[], key: string): number {
  return entriesForMonth(entries, key).reduce(
    (sum, e) => sum + (isBudgetSpendingEntry(settings, e) ? Number(e.amount) || 0
      : isBudgetIncomeEntry(settings, e) ? -(Number(e.amount) || 0) : 0),
    0,
  );
}

export function catTotalsForEntries(settings: CentsSettings, entries: Entry[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of entries) {
    if (!isSpendingEntry(settings, e)) continue;
    const key = String(e.category || '');
    totals[key] = (totals[key] || 0) + (Number(e.amount) || 0);
  }
  return totals;
}

/** The signed move one entry makes on one balance. Gift cards are special: a
 *  gift-card *category* expense on a card is a load (money arriving), which is
 *  how the balance editor and the quick-add field both record a top-up. */
export function balanceDelta(entry: Entry, methodId: string): number {
  if (!entry || entry.type === 'note' || entry.method !== methodId) return 0;
  const amount = Number(entry.amount) || 0;
  if (GIFT_CARD_IDS.includes(methodId)) {
    if (entry.type === 'credit' || entry.category === 'GC') return amount;
    return -amount;
  }
  return entry.type === 'credit' ? amount : -amount;
}

function entryMutationTime(entry: Entry): number {
  if (!entry) return NaN;
  const updated = entry.updatedAt ? Date.parse(String(entry.updatedAt)) : NaN;
  if (Number.isFinite(updated)) return updated;
  return entry.createdAt ? Date.parse(String(entry.createdAt)) : NaN;
}

function entryVersionAt(entry: Entry, timestamp: number): Entry {
  if (!entry || !Number.isFinite(timestamp)) return entry;
  const history = Array.isArray(entry.mutationHistory) ? (entry.mutationHistory as Entry[]) : [];
  const nextMutation = history.find((point) => Date.parse(String(point.at)) > timestamp);
  return nextMutation ? { ...nextMutation, createdAt: nextMutation.createdAt || entry.createdAt } : entry;
}

function versionIncludedAtCheckpoint(version: Entry | null | undefined, checkpointDate: string, checkpointTime: number): boolean {
  if (!version || String(version.date) > checkpointDate) return false;
  if (String(version.date) < checkpointDate) return true;
  const createdTime = version.createdAt ? Date.parse(String(version.createdAt)) : NaN;
  return !Number.isFinite(checkpointTime) || !Number.isFinite(createdTime) || createdTime <= checkpointTime;
}

/** The part of an entry that still applies after a checkpoint was saved.
 *
 *  Entries dated after the checkpoint are new activity. Entries already inside
 *  the checkpoint are neutral unless they were mutated afterwards — then only
 *  the net current-vs-historical effect applies, which is what keeps an edit
 *  that moves a transaction to another date, account or type honest. */
export function entryDeltaAfterCheckpoint(
  entry: Entry,
  methodId: string,
  targetDate: string,
  checkpoint: Checkpoint | null,
): number {
  if (!entry) return 0;
  if (!checkpoint) return String(entry.date) <= targetDate ? balanceDelta(entry, methodId) : 0;
  const checkpointTime = checkpoint.at
    ? Date.parse(checkpoint.at)
    : Date.parse(`${checkpoint.date}T23:59:59.999Z`);
  const historical = entryVersionAt(entry, checkpointTime);
  const mutationTime = entryMutationTime(entry);
  const historicalCreated = historical?.createdAt ? Date.parse(String(historical.createdAt)) : NaN;
  const changedAfterCheckpoint = Number.isFinite(mutationTime) && mutationTime > checkpointTime;
  const oldEffect = changedAfterCheckpoint
    && Number.isFinite(historicalCreated) && historicalCreated <= checkpointTime
    && versionIncludedAtCheckpoint(historical, checkpoint.date, checkpointTime)
    ? balanceDelta(historical, methodId) : 0;
  const currentEffect = String(entry.date) <= targetDate
    && (String(entry.date) > checkpoint.date || changedAfterCheckpoint)
    ? balanceDelta(entry, methodId) : 0;
  return currentEffect - oldEffect;
}

/** Balance of one method at the end of a date, using the latest checkpoint on or
 *  before it. Same-day transactions created after the checkpoint still count. */
export function balanceAtForEntries(
  entries: Entry[],
  methodId: string,
  targetDate: string,
  checkpoints: Record<string, Checkpoint[]>,
): number {
  const checkpoint = checkpointFor(checkpoints, methodId, targetDate);
  const startBalance = checkpoint?.balance || 0;
  return entries.reduce((total, entry) => {
    if (!checkpoint) return total + (String(entry.date) <= targetDate ? balanceDelta(entry, methodId) : 0);
    return total + entryDeltaAfterCheckpoint(entry, methodId, targetDate, checkpoint);
  }, startBalance);
}

/** Book balance from the original baseline, deliberately ignoring later
 *  reconciliations. Explains the variance; never feeds a displayed balance. */
export function bookBalanceAt(
  entries: Entry[],
  methodId: string,
  targetDate: string,
  checkpoints: Record<string, Checkpoint[]>,
): number {
  const baseline = checkpoints?.[methodId]?.find((point) => point.date === '1970-01-01')?.balance || 0;
  return entries
    .filter((entry) => String(entry.date) <= targetDate)
    .reduce((balance, entry) => balance + balanceDelta(entry, methodId), baseline);
}

export function totalAccountBalanceAt(
  entries: Entry[],
  date: string,
  checkpoints: Record<string, Checkpoint[]>,
): number {
  return ACCOUNT_METHOD_IDS.reduce((sum, id) => sum + balanceAtForEntries(entries, id, date, checkpoints), 0);
}

/** Headline balance plus the sparkline's points, on the same end-of-day
 *  checkpoint-aware actuals so the figure and the trend cannot disagree.
 *
 *  Only the 30 most recent distinct dates are computed: each one is an O(n)
 *  walk, and computing every historical date made the dashboard quadratic. */
export function computeBalance(
  entries: Entry[],
  asOfDate: string,
  checkpoints: Record<string, Checkpoint[]>,
): { balance: number; points: Array<{ date: string; balance: number }> } {
  const sorted = [...entries]
    .filter((e) => String(e.date) <= asOfDate && ACCOUNT_METHOD_IDS.includes(String(e.method || '')))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (String(a.id) < String(b.id) ? -1 : 1));
  const points: Array<{ date: string; balance: number }> = [];
  for (let index = sorted.length - 1; index >= 0 && points.length < 30; index--) {
    const e = sorted[index];
    if (points.at(-1)?.date === e.date) continue;
    points.push({ date: String(e.date), balance: totalAccountBalanceAt(entries, String(e.date), checkpoints) });
  }
  points.reverse();
  return { balance: totalAccountBalanceAt(entries, asOfDate, checkpoints), points };
}

/** Gift-card balance plus how much was loaded and spent since its checkpoint. */
export function computeGiftCardBalance(
  settings: CentsSettings,
  entries: Entry[],
  methodId: string,
  asOfDate = today(),
): { balance: number; loaded: number; spent: number } {
  const checkpoints = checkpointsFor(settings);
  const balance = balanceAtForEntries(entries, methodId, asOfDate, checkpoints);
  const checkpoint = checkpointFor(checkpoints, methodId, asOfDate);
  let loaded = 0;
  let spent = 0;
  for (const entry of entries) {
    if (entry.method !== methodId || String(entry.date) > asOfDate || entry.type === 'note') continue;
    if (checkpoint) {
      const delta = entryDeltaAfterCheckpoint(entry, methodId, asOfDate, checkpoint);
      if (delta > 0) loaded += delta;
      else if (delta < 0) spent += -delta;
      continue;
    }
    if (isBalanceAdjustmentEntry(settings, entry)) continue;
    if (entry.type === 'credit' || entry.category === 'GC') loaded += Number(entry.amount) || 0;
    else if (entry.type === 'expense') spent += Number(entry.amount) || 0;
  }
  return { balance, loaded, spent };
}

/* ── cash ─────────────────────────────────────────────────────────────────── */

export const COINS = [
  { val: 50, label: '€50' },
  { val: 20, label: '€20' },
  { val: 10, label: '€10' },
  { val: 5, label: '€5' },
  { val: 2, label: '€2' },
  { val: 1, label: '€1' },
  { val: 0.5, label: '50c' },
  { val: 0.2, label: '20c' },
  { val: 0.1, label: '10c' },
  { val: 0.05, label: '5c' },
];

export const COINS_DEFAULT: Record<string, number> = Object.fromEntries(COINS.map((c) => [String(c.val), 0]));

export function computeCashTotal(coins: Record<string, number>): number {
  let total = 0;
  for (const c of COINS) total += (Number(coins[String(c.val)]) || 0) * c.val;
  return Math.round(total * 100) / 100;
}

/** Fewest-piece breakdown of an amount, largest denomination first. */
export function coinsForAmount(rawTotal: number): Record<string, number> {
  const out: Record<string, number> = {};
  let remaining = Math.max(0, Math.round((Number(rawTotal) || 0) * 100) / 100);
  for (const c of COINS) {
    if (remaining <= 0) break;
    const valCents = Math.round(c.val * 100);
    const budgetCents = Math.round(remaining * 100);
    if (budgetCents < valCents) continue;
    const count = Math.floor(budgetCents / valCents);
    if (count > 0) out[String(c.val)] = count;
    remaining = Math.round((remaining - count * c.val) * 100) / 100;
  }
  return out;
}

export function cashDeltaOf(entry: Entry): number {
  if (!entry || entry.type === 'note' || entry.method !== 'Cash' || entry.type === 'transfer') return 0;
  const amount = Number(entry.amount) || 0;
  return entry.type === 'credit' ? amount : -amount;
}

/** Cash on hand: the coin counter while the user maintains it, otherwise the
 *  anchored base plus every cash entry since. */
export function cashBalance(settings: CentsSettings, entries: Entry[]): number {
  const coins = { ...COINS_DEFAULT, ...((settings?.coins || {}) as Record<string, number>) };
  if (settings?.coinsManual !== false) return computeCashTotal(coins);
  const base = Number.isFinite(+((settings as any)?.cashBase)) ? Number((settings as any).cashBase) : computeCashTotal(coins);
  const delta = entries.reduce((sum, entry) => sum + cashDeltaOf(entry), 0);
  return Math.round((base + delta) * 100) / 100;
}

/* ── projections ──────────────────────────────────────────────────────────── */

// A projection needs a month behind it, not a weekend.
const PROJECTION_MIN_DAYS = 7;
const PROJECTION_MIN_ENTRIES = 3;

export function recurringEntryKey(x: Record<string, any> | Entry | null | undefined): string {
  return [
    String(x?.type || ''),
    String(x?.details || '').trim().toLowerCase(),
    Math.round((Number(x?.amount) || 0) * 100),
    String(x?.method || ''),
    String(x?.category || ''),
  ].join('|');
}

function recurringKeySet(settings: CentsSettings): Set<string> | null {
  const list = settings?.recurring;
  return Array.isArray(list) && list.length ? new Set(list.map((entry) => recurringEntryKey(entry as any))) : null;
}

export interface Forecast {
  spent: number;
  projected: number | null;
  projectedReady: boolean;
  budget: number;
  remaining: number | null;
  dailyAverage: number;
  previousDaily: number | null;
  elapsed: number;
  totalDays: number;
}

/** Month-to-date spending and the run-rate projection.
 *
 *  The run rate is VARIABLE spending: a rent the ledger schedules is the same
 *  euros every month, so dividing it by the days elapsed turns day 6 into "you
 *  burn €850 a day". Fixed charges are spent, never projected. */
export function spendingForecast(
  settings: CentsSettings,
  entries: Entry[],
  key = monthKey(today()),
  now = new Date(),
): Forecast {
  const current = entriesForMonth(entries, key);
  const expenses = current.filter((e) => isBudgetSpendingEntry(settings, e));
  const spent = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  // `now` is an argument so a test can pin the day; with the default it is the
  // same clock the shipping app reads.
  const nowKey = monthKey(localDateKey(now));
  const elapsed = key === nowKey ? now.getDate() : daysInMonth(key);
  const totalDays = daysInMonth(key);
  const keys = recurringKeySet(settings);
  const variable = keys ? expenses.filter((e) => !keys.has(recurringEntryKey(e))) : expenses;
  const variableSpent = variable.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const dailyAverage = elapsed > 0 ? variableSpent / elapsed : 0;
  const ready = elapsed >= PROJECTION_MIN_DAYS && variable.length >= PROJECTION_MIN_ENTRIES;
  const projected = ready ? spent + dailyAverage * Math.max(0, totalDays - elapsed) : null;
  const budget = +(settings?.monthlyBudget as number) || 0;
  const previous = entriesForMonth(entries, previousMonthKey(key)).filter((e) => isBudgetSpendingEntry(settings, e));
  const previousDaily = previous.length
    ? previous.reduce((sum, e) => sum + (Number(e.amount) || 0), 0) / daysInMonth(previousMonthKey(key))
    : null;
  return {
    spent,
    projected,
    projectedReady: ready,
    budget,
    remaining: projected === null ? null : budget - projected,
    dailyAverage,
    previousDaily,
    elapsed,
    totalDays,
  };
}

/** What is left of the budget, shared over the days left in the month. The one
 *  figure on the dashboard that changes daily behaviour, so its rule lives here
 *  with the rest of the arithmetic rather than inline in the screen. */
export function safeToSpend(
  settings: CentsSettings,
  spent: number,
  now = new Date(),
): { safeToday: number | null; remainingBudget: number; daysLeft: number } {
  const budget = +(settings?.monthlyBudget as number) || 0;
  const daysLeft = Math.max(1, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1);
  const remainingBudget = Math.max(0, budget - spent);
  return { safeToday: budget ? remainingBudget / daysLeft : null, remainingBudget, daysLeft };
}

export function computeRunway(
  settings: CentsSettings,
  entries: Entry[],
  balance: number,
  key = monthKey(today()),
  now = new Date(),
): { balance: number; dailyAvg: number; projectedEnd: number; daysToZero: number | null } {
  const forecast = spendingForecast(settings, entries, key, now);
  const dailyAvg = forecast.dailyAverage;
  const daysLeft = Math.max(0, forecast.totalDays - forecast.elapsed);
  const projectedEnd = balance - dailyAvg * daysLeft;
  const daysToZero = balance > 0 && dailyAvg > 0 ? Math.floor(balance / dailyAvg) : null;
  return { balance, dailyAvg, projectedEnd, daysToZero };
}

/** The state a screen needs for the dashboard's headline figures. */
export function dashboardSummary(state: CentsState, asOfDate = today()) {
  const settings = state.settings || {};
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const key = monthKey(asOfDate);
  const monthEntries = entriesForMonth(entries, key);
  const expenses = monthEntries.filter((e) => isBudgetSpendingEntry(settings, e));
  const income = monthEntries.filter((e) => isBudgetIncomeEntry(settings, e));
  const checkpoints = checkpointsFor(settings);
  const { balance, points } = computeBalance(entries, asOfDate, checkpoints);
  const forecast = spendingForecast(settings, entries, key);
  const budget = +(settings.monthlyBudget as number) || 0;
  const spent = forecast.spent;
  return {
    key,
    expenses,
    income,
    spent,
    incomeSum: income.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    budget,
    percent: budget ? Math.min(100, (spent / budget) * 100) : 0,
    balance,
    points,
    cash: cashBalance(settings, entries),
    forecast,
    runway: computeRunway(settings, entries, balance, key),
    catTotals: catTotalsForEntries(settings, expenses),
  };
}
