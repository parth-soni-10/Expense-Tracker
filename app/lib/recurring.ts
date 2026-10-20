/* ============================================================
   Recurring bills and paydays.

   A schedule is a row in `settings.recurring`: what it is, how much, which
   account, how often, and the next date it lands. The rules that decide *when*
   it lands are here, and they are here rather than in the screen because a
   date that advances wrongly is a schedule that fires on the wrong day and
   nobody notices until the money is wrong.

   Two things the date arithmetic must not do:

   - A monthly schedule must land on the SAME day of the month every time. The
     shipping app passed a 1-based month straight into a 0-based index, so
     every monthly advance skipped a month — August became October.
   - A schedule that cannot advance must stop, not spin. A `while (nextDate <=
     …)` walk with no bound is how a stalled schedule turns into a hung tab, so
     every walk here carries a budget.

   A yearly schedule lands on the same date a year on, CLAMPED to the month it
   lands in: a 29 February schedule has to reach 28 February rather than skip
   a year.
   ============================================================ */
import { RECURRING_FREQUENCIES } from './seed.ts';

export interface RecurringRule {
  id: string;
  type?: string;
  details?: string;
  amount?: number;
  method?: string;
  category?: string;
  frequency: string;
  dayOfMonth?: number;
  nextDate: string;
  note?: string;
  [field: string]: unknown;
}

export type RecurringResult =
  | { ok: true; rule: RecurringRule }
  | { ok: false; error: string };

/** Days a day-anchored cadence steps. Anything not in here is month-anchored
 *  (monthly/yearly) and lands on a day of a month instead. */
export const FREQUENCY_STEPS: Record<string, number> = { daily: 1, weekly: 7, fortnightly: 14 };

export function utcDateKey(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function daysInMonthParts(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** How far a `while (nextDate <= …)` walk may go before it gives up. A daily
 *  schedule paid six months late needs ~180 steps; a monthly one needs one. */
export function advanceBudget(frequency: string): number {
  return frequency === 'daily' ? 400 : 48;
}

/** The next occurrence of a schedule, given where it is now. */
export function advanceRecurringDate(current: string, frequency: string, dayOfMonth?: number): string {
  const [year, month, day] = current.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return current;
  const step = FREQUENCY_STEPS[frequency];
  if (step) {
    const date = new Date(Date.UTC(year, month - 1, day + step));
    return utcDateKey(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
  if (frequency === 'yearly') {
    const targetYear = year + 1;
    const monthIndex = month - 1;
    return utcDateKey(targetYear, monthIndex,
      Math.min(Number(dayOfMonth) || day, daysInMonthParts(targetYear, monthIndex)));
  }
  if (frequency === 'monthly') {
    // `month` from the ISO split is 1-based (8 = August). Advance by one month,
    // then convert back to utcDateKey's 0-based index.
    const rawMonth = month + 1;
    const nextYear = year + Math.floor(rawMonth / 12);
    const normalized1Based = rawMonth % 12 || 12;
    const monthIndex = normalized1Based - 1;
    return utcDateKey(nextYear, monthIndex,
      Math.min(Number(dayOfMonth) || day, daysInMonthParts(nextYear, monthIndex)));
  }
  return current;
}

/** Human form of a schedule: the day-anchored cadences are just the cadence,
 *  the month-anchored ones carry the day they land on ("Monthly · 1st"). */
export function frequencyLabel(frequency: string, dayOfMonth?: number): string {
  if (frequency === 'monthly' || frequency === 'yearly') {
    const day = Number(dayOfMonth) || 1;
    return `${frequency === 'monthly' ? 'Monthly' : 'Yearly'} · ${day}${ordinal(day)}`;
  }
  return { daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly' }[frequency] || 'Weekly';
}

export function ordinal(n: number): string {
  // The SUFFIX, not the whole ordinal: a caller writes `${day}${ordinal(day)}`.
  // 1st, 2nd, 3rd, 11th, 21st — the two-digit cases are the ones a naive
  // `n % 10` gets wrong, and this is the rule the shipping app used.
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const value = Math.floor(Number(n) || 0) % 100;
  return suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0];
}

/** The first occurrence of a new schedule: the next one on or after `now`. */
export function computeInitialNextDate(frequency: string, dayOfMonth?: number, now: Date = new Date()): string {
  const requestedDay = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
  const step = FREQUENCY_STEPS[frequency];
  if (step) {
    // Day-anchored: walk the cadence forward from this month's requested day
    // until it stands in the future.
    let candidate = new Date(now.getFullYear(), now.getMonth(),
      Math.min(requestedDay, daysInMonthParts(now.getFullYear(), now.getMonth())));
    candidate.setHours(0, 0, 0, 0);
    let guard = 0;
    while (candidate <= now && guard++ < advanceBudget(frequency)) {
      candidate.setDate(candidate.getDate() + step);
    }
    return localDateKey(candidate);
  }
  // Month-anchored: this month's day (monthly), or the same date next year
  // (yearly) — either way the next one on or after now.
  const spanMonths = frequency === 'yearly' ? 12 : 1;
  let year = now.getFullYear();
  let month = now.getMonth();
  let day = Math.min(requestedDay, daysInMonthParts(year, month));
  if (new Date(year, month, day) <= now) {
    month += spanMonths;
    year += Math.floor(month / 12);
    month %= 12;
    day = Math.min(requestedDay, daysInMonthParts(year, month));
  }
  return utcDateKey(year, month, day);
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Whole days from `from` to `date`; negative when the date has passed. */
export function daysUntil(date: string, from: Date = new Date()): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  const base = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  if (!Number.isFinite(target)) return Number.POSITIVE_INFINITY;
  return Math.round((target - base) / 86400000);
}

/** Advance a schedule past a date, with a bound. Returns the date it stopped
 *  on, and whether the walk was cut short by the budget. */
export function advancePast(rule: RecurringRule, date: string): { nextDate: string; exhausted: boolean } {
  let nextDate = rule.nextDate;
  let guard = 0;
  const budget = advanceBudget(rule.frequency);
  while (nextDate <= date && guard++ < budget) {
    const advanced = advanceRecurringDate(nextDate, rule.frequency, rule.dayOfMonth);
    if (advanced === nextDate) return { nextDate, exhausted: true };
    nextDate = advanced;
  }
  return { nextDate, exhausted: guard >= budget };
}

/** The next occurrences of a schedule within a horizon, earliest first.
 *  `limit` is what the CALLER needs: a card reads six, while a projection over
 *  the horizon has to count every one of them — a daily bill capped at six
 *  would project a fifth of itself. */
export function upcomingOccurrences(rule: RecurringRule, horizonDays = 30, limit = 6, now: Date = new Date()): string[] {
  const out: string[] = [];
  let date = rule.nextDate;
  // The slowest cadence is daily at a step a day, so horizon + 2 walks always
  // reach past the horizon; anything beyond that means the schedule cannot
  // advance and would spin.
  let guard = 0;
  const budget = horizonDays + 2;
  while (guard++ <= budget) {
    const days = daysUntil(date, now);
    if (days > horizonDays) break;
    if (days >= 0) out.push(date);
    if (out.length >= limit) break;
    const advanced = advanceRecurringDate(date, rule.frequency, rule.dayOfMonth);
    if (advanced === date) break;
    date = advanced;
  }
  return out.slice(0, limit);
}

/** A charge worth putting on the schedule, found in the ledger itself.
 *
 *  Three occurrences of the same description at the same amount, spread at
 *  least five days apart and regular enough to read as a cadence rather than a
 *  coincidence — two gaps have to agree within a few days of each other, or
 *  "rent + a one-off + rent" would look monthly. A rule that already covers the
 *  description and amount silences it.
 *
 *  Returns the most recent matching entry (which carries the description,
 *  amount, account and category a new rule copies) and the cadence the gaps
 *  describe. A gap that is neither a supported cadence nor within a month of
 *  one is left alone rather than filed under the nearest fit: a quarterly bill
 *  suggested as yearly would be wrong by nine months, and wrong schedules are
 *  worse than no suggestion. */
export function recurringSuggestion(entries: any[], rules: RecurringRule[]): {
  key: string;
  entry: any;
  count: number;
  frequency: string;
  median: number;
  dayOfMonth: number;
} | null {
  const pair = (details: unknown, amount: unknown): string =>
    `${String(details || '').trim().toLowerCase()}|${Math.round((Number(amount) || 0) * 100)}`;
  const taken = new Set((rules || []).map((rule) => pair(rule.details, rule.amount)));
  const groups = new Map<string, any[]>();
  for (const entry of entries || []) {
    if (!entry || (entry.type !== 'expense' && entry.type !== 'credit')) continue;
    const key = pair(entry.details, entry.amount);
    if (key === '|' || taken.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  const candidates: Array<{ key: string; entry: any; count: number; frequency: string; median: number; dayOfMonth: number }> = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    const dates = list.map((entry) => entry.date).sort();
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i += 1) {
      gaps.push(Math.round((Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)) / 86400000));
    }
    if (gaps.some((gap) => gap < 5)) continue; // a habit, not a bill
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (Math.max(...gaps) - Math.min(...gaps) > Math.max(3, Math.round(median * 0.5))) continue;
    let frequency: string;
    if (median <= 45) frequency = median <= 10 ? 'weekly' : median <= 20 ? 'fortnightly' : 'monthly';
    else if (median >= 330 && median <= 400) frequency = 'yearly';
    else continue;
    const last = list.reduce((a, b) => (a.date > b.date ? a : b));
    candidates.push({
      key,
      entry: last,
      count: list.length,
      frequency,
      median,
      dayOfMonth: Number(String(last.date).slice(8, 10)),
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.count - a.count || (b.entry.date > a.entry.date ? 1 : -1));
  return candidates[0];
}

/** Build a rule from typed values, refusing the ones that cannot be scheduled. */
export function makeRecurringRule(input: {
  id: string;
  type?: string;
  details?: string;
  amount?: number;
  method?: string;
  category?: string;
  frequency: string;
  dayOfMonth?: number;
  nextDate?: string;
  note?: string;
}, now: Date = new Date()): RecurringResult {
  const details = String(input.details || '').trim();
  if (!details) return { ok: false, error: 'Say what this is.' };
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount.' };
  if (!RECURRING_FREQUENCIES.includes(input.frequency)) {
    return { ok: false, error: 'Choose how often it repeats.' };
  }
  const dayOfMonth = Math.min(31, Math.max(1, Number(input.dayOfMonth) || 1));
  return {
    ok: true,
    rule: {
      id: input.id,
      type: input.type || 'expense',
      details,
      amount: Math.round(amount * 100) / 100,
      method: input.method || 'AIB',
      category: input.category || 'misc',
      frequency: input.frequency,
      dayOfMonth,
      nextDate: input.nextDate || computeInitialNextDate(input.frequency, dayOfMonth, now),
      note: input.note || '',
    },
  };
}
