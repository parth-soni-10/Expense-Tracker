/* Insights: the range analysis the dashboard links into.
 *
 * Ported from `screenInsights()` in insights.js, with the arithmetic passed
 * through `src/metrics.ts` so a figure here cannot disagree with the dashboard
 * that sent the reader here. What it keeps: the URL-carried range (`?from=&to=`),
 * the five quick ranges, the one-sentence narrative with its comparison against
 * the preceding period of the same length, the five stat cells, the category
 * breakdown, the month-by-month totals, the twelve-month entry density and a
 * back-to-top control — all of it class-only, because the served shell runs
 * under `style-src 'self'` and the shipped screen is built out of inline styles
 * and an inline-width chart.
 *
 * The chart bars are native `<progress>` elements, which is why there is no
 * width written from script. The density grid is the kit's `github-activity`
 * host: it wants the dates, and the card says what it is.
 *
 * What is not here: the calendar heat board's per-day popovers (slice 5's
 * year-in-review surface), the range CSV export and the flatpickr calendar. The
 * two date inputs are the shipped screen's own fallback and are enough to reach
 * any range; the export is recorded in docs/DEFERRED_TESTS.md, not pretended.
 */
import type { CentsSettings } from '../../lib/types.ts';
import { el } from '../dom.ts';
import { fmt, monthKey, monthLabel, today } from '../format.ts';
import {
  catTotalsForEntries,
  categoryLabel,
  entriesForMonth,
  isBudgetIncomeEntry,
  isBudgetSpendingEntry,
  isSpendingEntry,
  methodShort,
} from '../metrics.ts';
import { navigate } from '../router.ts';
import type { ScreenContext } from './context.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in `YYYY-MM-DD`, so a hand-edited URL cannot invent one. */
function isDay(value: string): boolean {
  if (!DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Shift a day key by whole days, in UTC, so a DST change cannot move it. */
function offsetDay(day: string, days: number): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(time)) return day;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function statCard(label: string, value: string, hint: string): HTMLElement {
  return el('div', { class: 'card insight-stat' },
    el('div', { class: 'eyebrow', title: hint }, label),
    el('div', { class: 'display-num insight-stat-value' }, value),
  );
}

/** A labelled row with a proportion bar, shared by both breakdowns. */
function barRow(label: string, amount: number, share: number, caption: string): HTMLElement {
  return el('div', { class: 'insight-bar-row' },
    el('span', { class: 'insight-bar-name' }, label),
    el('progress', {
      class: 'insight-bar',
      max: '100',
      value: String(Math.max(0, Math.min(100, Math.round(share)))),
      'aria-label': `${label}: ${caption}`,
    }),
    el('span', { class: 'insight-bar-share muted' }, `${Math.round(share)}%`),
    el('span', { class: 'display-num insight-bar-amount' }, fmt(amount)),
  );
}

export function renderInsights({ state, params }: ScreenContext): HTMLElement {
  const settings: CentsSettings = state.settings || {};
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const root = el('div', { class: 'page-section insights-section' });

  /* ── the range, from the URL ────────────────────────────────────────────── */

  // The shipped screen opens on 90 days ending today, counts the start as
  // −89 so the preset and the range agree, and corrects a reversed range
  // instead of printing a misleading total.
  const fromParam = params.get('from') || '';
  const toParam = params.get('to') || '';
  let from = isDay(fromParam) ? fromParam : offsetDay(today(), -89);
  let to = isDay(toParam) ? toParam : today();
  if (from > to) [from, to] = [to, from];

  const inRange = (day: string): boolean => day >= from && day <= to;
  const rangeEntries = entries.filter((entry) => inRange(String(entry.date || '')));
  const spending = rangeEntries.filter((entry) => isSpendingEntry(settings, entry));
  const spentTotal = spending.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const rangeIncome = rangeEntries.filter((entry) => isBudgetIncomeEntry(settings, entry))
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const rangeSpend = rangeEntries.filter((entry) => isBudgetSpendingEntry(settings, entry))
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const catTotals = catTotalsForEntries(settings, spending);
  const topCategory = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0] || null;
  const methodTotals: Record<string, number> = {};
  for (const entry of spending) {
    methodTotals[String(entry.method)] = (methodTotals[String(entry.method)] || 0) + (Number(entry.amount) || 0);
  }
  const topMethod = Object.entries(methodTotals).sort((a, b) => b[1] - a[1])[0] || null;
  const savingsRate = rangeIncome > 0 ? Math.round(((rangeIncome - rangeSpend) / rangeIncome) * 100) : null;

  // The period of the same length immediately before this one, so "less than
  // the preceding period" compares like with like.
  const spanDays = Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
  const previousFrom = offsetDay(from, -spanDays);
  const previousTo = offsetDay(from, -1);
  const previousSpend = spanDays
    ? entries.filter((entry) => {
      const day = String(entry.date || '');
      return day >= previousFrom && day <= previousTo && isSpendingEntry(settings, entry);
    }).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0)
    : 0;
  const delta = spentTotal - previousSpend;

  const writeRange = (nextFrom: string, nextTo: string): void => {
    const next = new URLSearchParams(params);
    next.set('from', nextFrom);
    next.set('to', nextTo);
    navigate('insights', next, { replace: true });
  };

  const fromInput = el('input', {
    type: 'date', class: 'insight-date', value: from,
    'aria-label': 'From date',
    onChange: (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      if (isDay(value)) writeRange(value, to);
    },
  });
  const toInput = el('input', {
    type: 'date', class: 'insight-date', value: to,
    'aria-label': 'To date',
    onChange: (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      if (isDay(value)) writeRange(from, value);
    },
  });

  /* ── the quick ranges ───────────────────────────────────────────────────── */

  const lastMonthDate = new Date(Date.UTC(Number(monthKey(today()).slice(0, 4)), Number(monthKey(today()).slice(5, 7)) - 2, 1));
  const lastMonth = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const lastMonthEnd = offsetDay(`${monthKey(offsetDay(`${lastMonth}-01`, 31)).slice(0, 7)}-01`, -1);
  const earliest = entries.reduce((min, entry) => (String(entry.date || '') < min ? String(entry.date || '') : min), today());
  const presets: Array<{ label: string; from: string; to: string }> = [
    { label: 'This month', from: `${monthKey(today())}-01`, to: today() },
    { label: 'Last month', from: `${lastMonth}-01`, to: lastMonthEnd },
    { label: 'Last 90 days', from: offsetDay(today(), -89), to: today() },
    { label: 'Year to date', from: `${today().slice(0, 4)}-01-01`, to: today() },
    { label: 'All time', from: earliest, to: today() },
  ];

  const presetRow = el('div', { class: 'insight-presets', role: 'group', 'aria-label': 'Quick ranges' },
    el('span', { class: 'eyebrow' }, 'Range'),
    ...presets.map((preset) => {
      const on = preset.from === from && preset.to === to;
      return el('button', {
        type: 'button',
        class: 'pill pill-cat insight-preset',
        'aria-pressed': on ? 'true' : 'false',
        dataset: { active: on ? 'true' : 'false' },
        onClick: () => writeRange(preset.from, preset.to),
      }, preset.label);
    }),
    from === fromParam || to === toParam
      ? el('button', {
        type: 'button',
        class: 'btn-link insight-reset',
        onClick: () => navigate('insights', new URLSearchParams()),
      }, 'Reset')
      : null,
  );

  root.append(el('div', { class: 'insight-range' },
    el('span', { class: 'eyebrow' }, 'Between'),
    fromInput,
    el('span', { class: 'muted' }, 'and'),
    toInput,
  ), presetRow);

  /* ── the short version ──────────────────────────────────────────────────── */

  root.append(el('div', { class: 'card insight-narrative' },
    el('div', { class: 'eyebrow' }, 'The short version'),
    el('p', { class: 'serif insight-narrative-text' }, spending.length
      ? `You spent ${fmt(spentTotal)} in this range${topCategory ? `, led by ${categoryLabel(settings, topCategory[0])} at ${fmt(topCategory[1])}` : ''}.`
      : 'Log a few expenses and your spending story will appear here.'),
    previousSpend > 0
      ? el('div', { class: 'insight-narrative-note muted' },
        `${fmt(Math.abs(delta))} ${delta <= 0 ? 'less' : 'more'} than the preceding period.`)
      : null,
  ));

  if (!entries.length) {
    root.append(el('div', { class: 'card empty insight-empty' },
      el('p', { class: 'muted' }, 'Nothing logged yet. Your spending story, the density and the month totals appear once there is a ledger.'),
      el('a', { class: 'btn btn-primary', href: '#add' }, 'Add your first entry'),
    ));
    return root;
  }

  /* ── the five cells ─────────────────────────────────────────────────────── */

  const months = new Map<string, number>();
  for (const entry of spending) {
    const key = monthKey(String(entry.date || ''));
    months.set(key, (months.get(key) || 0) + (Number(entry.amount) || 0));
  }
  const monthList = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const average = monthList.length ? monthList.reduce((sum, [, value]) => sum + value, 0) / monthList.length : 0;
  const activeCategories = new Set(spending.map((entry) => String(entry.category || ''))).size;

  root.append(el('div', { class: 'insight-stats' },
    statCard('Average / month', fmt(average), 'Spending divided over the months this range touches.'),
    statCard('Top method', topMethod ? `${methodShort(settings, topMethod[0])} · ${fmt(topMethod[1])}` : '-',
      'The payment method that carried the most money in this range.'),
    statCard('Spending entries', String(spending.length), 'Rows that count against a budget.'),
    statCard('Categories active', String(activeCategories), 'Distinct categories with spending in this range.'),
    statCard('Savings rate', savingsRate === null ? '-' : `${savingsRate}%`,
      'Income left after budget spending, as a share of income. A range with no income reads -, not 0%.'),
  ));

  /* ── where it went ──────────────────────────────────────────────────────── */

  const categories = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  root.append(el('div', { class: 'card insight-panel' },
    el('div', { class: 'row between insight-panel-head' },
      el('span', { class: 'eyebrow' }, 'By category'),
      el('span', { class: 'muted' }, `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`),
    ),
    categories.length
      ? el('div', { class: 'insight-bars' }, ...categories.map(([id, amount]) => barRow(
        categoryLabel(settings, id), amount, spentTotal > 0 ? (amount / spentTotal) * 100 : 0, 'share of this range',
      )))
      : el('div', { class: 'empty' }, 'No spending in this range.'),
  ));

  /* ── month by month, and the twelve-month density ───────────────────────── */

  const biggestMonth = monthList.reduce((max, [, value]) => Math.max(max, value), 0);
  const monthCard = el('div', {
    class: 'card insight-panel',
    // The kit's analytics-chart gives the card its expand control and the resize
    // broadcast; the bars inside are the table's own.
    'data-ui': 'analytics-chart',
    'data-ui-label': 'Month by month',
  },
  el('div', { class: 'row between insight-panel-head' },
    el('span', { class: 'eyebrow' }, 'Month by month'),
    el('span', { class: 'muted' }, `${monthList.length} month${monthList.length === 1 ? '' : 's'}`),
  ),
  monthList.length
    ? el('div', { class: 'insight-bars' }, ...monthList.map(([key, amount]) => barRow(
      monthLabel(key), amount, biggestMonth > 0 ? (amount / biggestMonth) * 100 : 0, 'against the biggest month in range',
    )))
    : el('div', { class: 'empty' }, 'No spending in this range.'),
  );

  // The twelve months that END at this range's end date, so the grid follows the
  // range the rest of the screen honours instead of the wall clock.
  const yearStart = offsetDay(to, -364);
  const yearDates = entries
    .filter((entry) => {
      const day = String(entry.date || '');
      return entry.type !== 'note' && day >= yearStart && day <= to;
    })
    .map((entry) => String(entry.date));
  const densityCard = el('div', {
    class: 'card insight-panel insight-density',
    'data-ui': 'github-activity',
    'data-ui-label': 'Entries logged in the last twelve months',
    'data-ui-dates': yearDates.join(','),
  },
  el('div', { class: 'row between insight-panel-head' },
    el('span', { class: 'eyebrow' }, 'Entries logged'),
    el('span', { class: 'muted' }, '12 months'),
  ),
  el('div', { class: 'insight-density-body' },
    el('p', { class: 'muted insight-density-note' },
      `${yearDates.length} entr${yearDates.length === 1 ? 'y' : 'ies'} in the twelve months to ${to}.`),
  ),
  );

  root.append(el('div', { class: 'insight-grid' }, monthCard, densityCard));

  /* ── the calendar heat board, for the month the range ends in ───────────── */

  const heatKey = monthKey(to);
  const heatByDay = new Map<string, number>();
  for (const entry of entriesForMonth(entries, heatKey)) {
    if (!isSpendingEntry(settings, entry)) continue;
    const day = String(entry.date || '');
    heatByDay.set(day, (heatByDay.get(day) || 0) + (Number(entry.amount) || 0));
  }
  const hottest = Math.max(0, ...heatByDay.values());
  const [heatYear, heatMonth] = heatKey.split('-').map(Number);
  const dayCount = new Date(Date.UTC(heatYear, heatMonth, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(heatYear, heatMonth - 1, 1)).getUTCDay();
  const lead = (firstDow + 6) % 7;

  const board = el('div', { class: 'heat-board', role: 'list', 'aria-label': `Spending by day, ${monthLabel(heatKey)}` });
  for (let i = 0; i < lead; i += 1) board.append(el('span', { class: 'heat-blank', 'aria-hidden': 'true' }));
  for (let day = 1; day <= dayCount; day += 1) {
    const key = `${heatKey}-${String(day).padStart(2, '0')}`;
    const amount = heatByDay.get(key) || 0;
    // Five levels rather than a computed shade: the level is an attribute, so
    // the colour lives in the stylesheet and nothing here writes a style.
    const level = amount === 0 ? '0' : hottest === 0 ? '0'
      : amount >= hottest * 0.75 ? '4' : amount >= hottest * 0.5 ? '3' : amount >= hottest * 0.25 ? '2' : '1';
    board.append(el('span', {
      class: 'heat-day',
      role: 'listitem',
      dataset: { level },
      title: amount > 0 ? `${friendlyKey(key)}: ${fmt(amount)}` : `${friendlyKey(key)}: nothing logged`,
      'aria-label': `${friendlyKey(key)}: ${amount > 0 ? fmt(amount) : 'nothing logged'}`,
    }, String(day)));
  }
  root.append(el('div', { class: 'card insight-panel' },
    el('div', { class: 'row between insight-panel-head' },
      el('span', { class: 'eyebrow' }, `Daily, ${monthLabel(heatKey)}`),
      el('span', { class: 'muted' }, 'Mon first'),
    ),
    board,
  ));

  /* ── back to the top of a long screen ───────────────────────────────────── */

  root.append(el('button', {
    type: 'button',
    class: 'btn btn-ghost insight-top',
    'data-ui': 'scroll-island',
    'data-ui-label': 'Back to top',
    onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  }, 'Back to top'));

  return root;
}

/** `12 Oct` without pulling a formatter into a title attribute. */
function friendlyKey(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
