/* The Dashboard screen, ported from `screenDashboard()` in the shipping app.js.
 *
 * What is here is the part of that screen that is pure ledger arithmetic: the
 * month's headline and balance, the net-worth trend, the pulse (runway, spent,
 * projected, remaining, safe-to-spend today, average day, burn rate), the budget
 * bar, the category totals, the recent ledger and the low-gift-card notice.
 * Every figure comes from `src/metrics.ts`, so a number on this screen cannot
 * disagree with the same number on Balances or Insights.
 *
 * The three Hairline figures are here too: the balance tide, the month's budget
 * envelopes and the newest receipts, mounted from the same numbers this render
 * already computed (src/figures.ts owns the vendored kernel's handles).
 *
 * What is deliberately not here yet (tracked in docs/CENTS_PARITY.md, not
 * claimed by this file): recurring items, the Tesco pay card, the paper-voucher
 * notice and the balance rows — those are slices 3–4.
 *
 * Class-only: the served app runs under `style-src 'self'`, so nothing writes a
 * style attribute. Layout that the old screen expressed inline lives in
 * `styles/dashboard.css`.
 */
import type { CentsSettings, CentsState, Entry } from '../../lib/types.ts';
import { CATEGORIES } from '../../lib/seed.ts';
import { el } from '../dom.ts';
import { friendlyDate, fmt, monthKey, monthLabel, parseAmount, today } from '../format.ts';
import { paintFigures, type FigureData } from '../figures.ts';
import {
  GIFT_CARD_IDS,
  catTotalsForEntries,
  computeGiftCardBalance,
  dashboardSummary,
  entriesForMonth,
  isBudgetIncomeEntry,
  isBudgetSpendingEntry,
  methodLabel,
  methodShort,
  safeToSpend,
} from '../metrics.ts';

export interface DashboardContext {
  state: CentsState;
  /** Persist the document. Returns false when storage refused the write. */
  save: () => boolean;
  /** Re-render the screen after a change this screen owns (the budget). */
  refresh: () => void;
}

const MAX_BALANCE = 1e9;

function categoryLabel(settings: CentsSettings, id: string): string {
  const custom = Array.isArray(settings?.customCategories) ? settings.customCategories : [];
  const found = [...CATEGORIES, ...custom.map((c) => ({ id: String(c.id), label: String(c.label || c.id) }))]
    .find((category) => category.id === id);
  return found?.label || id;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

/** A labelled figure with an optional link and explanation, as the pulse grid
 *  renders them: `screen readers hear the label, the hint explains the term`. */
function stat(label: string, value: string, tone: '' | 'positive' | 'negative', hint: string, href?: string): HTMLElement {
  const figure = el('span', { class: 'display-num pulse-figure-value' }, value);
  const host = href
    ? el('a', { class: 'pulse-figure-link', href, 'aria-label': `${label} details` }, figure)
    : figure;
  // Every pulse figure is the kit's counter: it counts up to the value this
  // render computed and then restores that exact text, so the number never
  // disagrees with the ledger, and a reader who asked for less motion lands on
  // it immediately. The anchor is the host where the figure links somewhere, so
  // the accessible name and the counted text are the same node.
  host.setAttribute('data-ui', 'animated-counter');
  const valueEl = el('div', { class: `display-num pulse-figure${tone ? ` is-${tone}` : ''}` }, host);
  return el('div', { class: 'pulse-stat' },
    el('div', { class: 'eyebrow', title: hint }, label, el('span', { class: 'pulse-hint', 'aria-hidden': 'true' }, '\u24d8')),
    valueEl,
  );
}

/** The one sentence the pulse leads with, chosen exactly as the shipping app
 *  chooses it: balance first, then runway, then projection, then tracking. */
function pulseHeadline(summary: ReturnType<typeof dashboardSummary>) {
  const { balance, forecast, runway } = summary;
  if (balance <= 0) {
    return { headline: fmt(0), caption: 'balance', message: 'Your balance is at or below zero.', tone: 'negative', status: 'Watch out' };
  }
  if (runway.dailyAvg > 0 && runway.daysToZero !== null && runway.daysToZero <= 30) {
    return { headline: `${Math.max(1, runway.daysToZero)} days`, caption: 'to €0', message: 'At your current pace.', tone: 'negative', status: 'Watch out' };
  }
  if (forecast.projectedReady && forecast.budget && (forecast.projected ?? 0) > forecast.budget) {
    return {
      headline: `${Math.round(((forecast.projected ?? 0) / forecast.budget) * 100)}%`,
      caption: 'of budget',
      message: `Projected ${fmt(forecast.projected ?? 0)} against ${fmt(forecast.budget)}.`,
      tone: 'negative',
      status: 'Over budget',
    };
  }
  if (forecast.budget && forecast.projectedReady) {
    return {
      headline: fmt(Math.max(0, forecast.remaining ?? 0)),
      caption: 'left this month',
      message: 'You are comfortably within budget.',
      tone: 'positive',
      status: 'On track',
    };
  }
  return {
    headline: fmt(balance),
    caption: 'balance',
    message: forecast.budget ? 'Projection starts after a week of entries.' : 'Set a monthly budget to see your pace.',
    tone: 'muted',
    status: 'Tracking',
  };
}

function giftCardNotice(state: CentsState): HTMLElement | null {
  const settings = state.settings || {};
  const entries = state.entries || [];
  const used = (id: string) => entries.some((e) => e.method === id)
    || ((settings.balanceCheckpoints as any)?.[id] || []).length > 0;
  const cards = GIFT_CARD_IDS
    .filter(used)
    .map((id) => ({ id, label: methodShort(settings, id), balance: computeGiftCardBalance(settings, entries, id).balance }))
    .filter((card) => card.balance < 5);
  if (!cards.length) return null;
  const over = cards.every((card) => card.balance <= 0);
  return el('div', { class: 'card dashboard-alert', role: 'alert' },
    el('div', { class: 'dashboard-alert-body' },
      el('div', { class: 'dashboard-alert-title' }, over ? 'Gift card over its balance' : 'Gift card running low'),
      el('div', { class: 'muted dashboard-alert-text' }, cards.map((card) => (card.balance > 0
        ? `${card.label} has ${fmt(card.balance)} left`
        : `${card.label} is ${fmt(Math.abs(card.balance))} over its balance`)).join(' · ')),
    ),
    el('a', { class: 'btn btn-ghost dashboard-alert-action', href: '#balances' }, 'Open Balances'),
  );
}

export function renderDashboard({ state, save, refresh }: DashboardContext): HTMLElement {
  const settings = state.settings || {};
  const entries: Entry[] = Array.isArray(state.entries) ? state.entries : [];
  const summary = dashboardSummary(state);
  const now = new Date();
  const root = el('div', { class: 'page-section dashboard-section' });

  /* ── hero ──────────────────────────────────────────────────────────────── */

  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  const live = el('p', { class: 'dashboard-live', role: 'status', 'aria-live': 'polite' });
  const commitBudget = (raw: string): boolean => {
    const value = parseAmount(raw);
    if (!Number.isFinite(value) || value < 0 || value > MAX_BALANCE) return false;
    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = setTimeout(() => {
      if (value === (+(settings.monthlyBudget as number) || 0)) return;
      settings.monthlyBudget = value;
      live.textContent = value > 0 ? 'Budget updated.' : 'Budget cleared.';
      if (!save()) live.textContent = 'Budget could not be saved on this device.';
      refresh();
    }, 250);
    return true;
  };

  const budgetInput = el('input', {
    id: 'budget-input',
    class: 'dashboard-budget-input',
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    value: String(summary.budget || ''),
    placeholder: '-',
    'aria-label': 'Monthly budget in euros',
    // The field saves a quarter second after typing stops, which is worth saying
    // out loud on hover rather than leaving the reader to press Enter and hope.
    'data-ui': 'warm-tooltip',
    'data-ui-tip': 'Saves a moment after you stop typing',
    oninput: (event: Event) => {
      const field = event.target as HTMLInputElement;
      if (!commitBudget(field.value)) {
        field.setAttribute('aria-invalid', 'true');
        live.textContent = 'Enter a non-negative number.';
      } else {
        field.removeAttribute('aria-invalid');
      }
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
    },
  });

  const balanceTone = summary.balance >= 0 ? 'is-positive' : 'is-negative';
  root.append(el('div', { class: 'page-title-row dashboard-hero' },
    el('div', null,
      el('div', { class: 'eyebrow' }, monthLabel(summary.key)),
      el('p', { class: 'dashboard-total' },
        el('span', { class: 'serif' }, fmt(summary.spent)),
        el('span', { class: 'dashboard-budget' }, summary.budget ? `/ ${fmt(summary.budget)}` : ''),
      ),
      el('p', { class: 'dashboard-context' },
        el('span', null, 'Balance '),
        el('span', { class: `signed-chip ${balanceTone}` }, fmt(summary.balance)),
        el('span', { class: 'muted' }, `Cash ${fmt(summary.cash)}`),
      ),
    ),
    el('div', { class: 'dashboard-actions' },
      el('label', { class: 'eyebrow', for: 'budget-input' }, 'Budget'),
      el('div', { class: 'budget-field' }, budgetInput),
      el('a', { class: 'btn btn-primary', href: '#add' }, 'New entry'),
    ),
  ));
  root.append(live);

  /* ── net worth trend ───────────────────────────────────────────────────── */

  if (summary.points.length >= 2) {
    const trend = summary.points.at(-1)!.date < today()
      ? [...summary.points, { date: today(), balance: summary.balance }]
      : summary.points;
    const last30 = trend.slice(-30);
    const vals = last30.map((point) => point.balance);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const range = mx - mn || 1;
    const isUp = vals[vals.length - 1] >= vals[0];
    const sparkH = 40, sparkW = 300;
    const step = sparkW / (vals.length - 1);
    const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${sparkH - ((v - mn) / range) * (sparkH - 4) - 2}`).join(' ');
    const areaD = `${d} L ${(vals.length - 1) * step} ${sparkH} L 0 ${sparkH} Z`;
    root.append(el('div', { class: `card dashboard-full net-worth-strip ${isUp ? 'is-up' : 'is-down'}` },
      el('div', { class: 'net-worth-head' },
        el('div', { class: 'eyebrow' }, 'Net worth'),
        el('div', { class: `display-num ${summary.balance >= 0 ? 'is-positive' : 'is-negative'}` }, fmt(summary.balance)),
      ),
      svg('svg', { viewBox: `0 0 ${sparkW} ${sparkH}`, class: 'net-worth-spark', 'aria-label': `Net worth trend, ${isUp ? 'up' : 'down'} from ${fmt(vals[0])} to ${fmt(summary.balance)}`, role: 'img' },
        svg('path', { d: areaD, class: 'net-worth-area' }),
        svg('path', { d, class: 'net-worth-line' }),
      ),
    ));
  }

  /* ── pulse ─────────────────────────────────────────────────────────────── */

  const heading = pulseHeadline(summary);
  const { safeToday, remainingBudget } = safeToSpend(settings, summary.spent, now);
  const forecast = summary.forecast;
  root.append(el('div', { class: 'card financial-pulse' },
    el('div', { class: 'pulse-heading' },
      el('div', null,
        el('div', { class: 'eyebrow' }, 'Pulse'),
        el('div', { class: 'pulse-headline' },
          el('span', { class: `serif is-${heading.tone}` }, heading.headline),
          el('span', { class: 'muted' }, heading.caption),
        ),
        el('div', { class: 'muted pulse-message' }, heading.message),
      ),
      el('span', { class: `pulse-status is-${heading.tone}` }, heading.status),
    ),
    el('div', { class: 'pulse-grid' },
      stat('Runway', summary.runway.dailyAvg > 0 && summary.runway.daysToZero !== null ? `${summary.runway.daysToZero} days` : '-', '',
        'Days until today\u2019s balance runs out at your current daily pace. Fixed charges like rent are spent, not repeated.', '#balances'),
      stat('Spent', fmt(forecast.spent), 'negative', 'Everything this month that counts against your budget.', '#history'),
      stat('Projected', forecast.projected === null ? '\u00b7' : fmt(forecast.projected), 'negative',
        'Where the month lands at your current pace. Shown once there is a week of entries to read.', '#insights'),
      forecast.budget && forecast.projectedReady
        ? stat('Remaining', fmt(forecast.remaining ?? 0), '', 'What is left of the budget if the month lands where it is heading.', '#balances')
        : stat('Balance', fmt(summary.balance), '', 'Balance across every tracked account.', '#balances'),
      summary.budget ? stat('Safe today', fmt(safeToday ?? 0), remainingBudget <= 0 ? 'negative' : '',
        'What is left of this month\u2019s budget, shared over the days left in it.') : null,
      stat('Avg / day', fmt(forecast.dailyAverage), 'negative',
        'This month\u2019s variable spending divided by the days elapsed \u2014 fixed bills left out.'),
      summary.budget && summary.spent > 0 && forecast.projectedReady
        ? stat('Burn rate', `${Math.round(((forecast.projected ?? 0) / summary.budget) * 100)}%`, '',
          'This month projected at your current pace, as a share of your budget.')
        : null,
    ),
  ));

  /* ── budget bar ────────────────────────────────────────────────────────── */

  if (summary.budget > 0) {
    root.append(el('div', {
      class: 'card budget-card',
      // The kit's budget-card reads the percent and the bar off the card itself,
      // so the number above and the bar below cannot describe different months.
      'data-ui': 'budget-card',
      'data-ui-percent': summary.percent.toFixed(1),
      'data-ui-label': 'Spent of budget',
    },
      el('div', { class: 'row between' },
        el('span', { class: 'eyebrow' }, 'Spent of budget'),
        el('a', { class: 'btn-link', href: '#insights' }, 'Where it went →'),
        el('span', { class: 'serif budget-percent' }, `${summary.percent.toFixed(1)}%`),
      ),
      el('progress', {
        class: `budget-bar${summary.percent > 90 ? ' is-over' : ''}`,
        max: '100',
        value: summary.percent.toFixed(1),
        'aria-label': 'Spent of budget',
        'data-ui-bar': '',
      }),
      el('div', { class: 'budget-facts' },
        el('span', null, 'Income ', el('strong', { class: 'is-positive' }, fmt(summary.incomeSum))),
        el('span', null, 'Net ', el('strong', null, fmt(summary.incomeSum - summary.spent))),
        el('span', null, 'Month elapsed ',
          el('strong', null, `${Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100)}%`)),
      ),
    ));
  }

  /* ── notices and milestones ────────────────────────────────────────────── */

  const notice = giftCardNotice(state);
  if (notice) root.append(notice);

  const monthsUnderBudget = (() => {
    const budget = +(settings.monthlyBudget as number) || 0;
    if (!budget) return 0;
    let count = 0;
    for (const key of new Set(entries.map((e) => monthKey(String(e.date || ''))))) {
      const spent = entriesForMonth(entries, key)
        .filter((e) => isBudgetSpendingEntry(settings, e))
        .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
      if (spent > 0 && spent <= budget) count += 1;
    }
    return count;
  })();
  const chips: HTMLElement[] = [];
  if (entries.length) chips.push(el('span', { class: 'pill', title: 'Total entries logged' }, `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} logged`));
  if (monthsUnderBudget >= 1) chips.push(el('span', { class: 'pill', title: 'Months where spending stayed within budget' }, `${monthsUnderBudget} month${monthsUnderBudget === 1 ? '' : 's'} under budget`));
  if (chips.length) root.append(el('div', { class: 'dashboard-full milestone-chips' }, ...chips));

  /* ── the ledger drawn ───────────────────────────────────────────────────── */

  const catTotals = catTotalsForEntries(settings, summary.expenses);
  const ordered = [...entries]
    .filter((entry) => entry.type !== 'note')
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (String(a.id) < String(b.id) ? 1 : -1));
  // Each figure is fed the numbers this render already computed: the net worth
  // points above (plus today), this month's category budgets against the same
  // totals the "By category" panel lists, and the newest entries in the order
  // the Recent panel shows them. Nothing is read twice, so a figure cannot
  // disagree with the card beside it.
  const tidePoints = summary.points.slice(-13).map((point) => ({ date: point.date, balance: point.balance }));
  const tideLast = tidePoints[tidePoints.length - 1];
  if (!tideLast || tideLast.date < today()) tidePoints.push({ date: today(), balance: summary.balance });
  const categoryBudgets = (settings as any).categoryBudgets || {};
  const envelopes = Object.entries(categoryBudgets)
    .filter(([, limit]) => +(limit as any) > 0)
    .slice(0, 6)
    .map(([id, limit]) => ({ label: categoryLabel(settings, id), spent: catTotals[id] || 0, limit: +(limit as any) }));

  const figureCard = (id: string, label: string): HTMLElement => el('figure', { class: 'hairline-card' },
    el('figcaption', { class: 'eyebrow' }, label),
    el('div', { class: 'hairline-figure', id }),
    el('p', { class: 'hairline-read', 'data-hairline-read': '', 'aria-live': 'polite' }, 'rest'),
  );
  // `role="group"` is what makes the label mean something: a bare aria-label on
  // a div is ignored, and the three figures are one section of the page.
  root.append(el('div', { class: 'figures-card', role: 'group', 'aria-label': 'The ledger drawn' },
    figureCard('cents-balance-tide', 'Balance tide'),
    figureCard('cents-envelope-garden', 'Envelope garden'),
    figureCard('cents-receipt-constellation', 'Receipt constellation'),
  ));
  // The hosts are only reachable by id once `main.ts` has appended this root, so
  // the paint waits a frame. If the figure scripts never loaded, `paintFigures`
  // draws nothing and says nothing: a dashboard without figures is still the
  // dashboard.
  const figures: FigureData = {
    balances: tidePoints,
    envelopes,
    receipts: ordered.slice(0, 9).map((entry) => ({
      title: String(entry.details || 'Entry'),
      amount: Number(entry.amount) || 0,
      date: String(entry.date || ''),
    })),
  };
  requestAnimationFrame(() => paintFigures(figures));

  /* ── this month by category, and the recent ledger ─────────────────────── */

  const cats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const catCard = el('div', { class: 'card dashboard-panel' },
    el('div', { class: 'row between dashboard-panel-head' },
      el('span', { class: 'eyebrow' }, 'By category'),
      el('span', { class: 'muted' }, 'this month'),
    ),
    cats.length === 0
      ? el('div', { class: 'empty' }, 'Nothing logged yet.')
      : el('div', { class: 'cat-list' }, ...cats.map(([id, value]) => {
        const share = summary.spent > 0 ? Math.round((value / summary.spent) * 100) : 0;
        return el('div', { class: 'cat-row' },
          el('span', { class: 'cat-name' }, categoryLabel(settings, id)),
          el('progress', { class: 'cat-progress', max: '100', value: String(share), 'aria-label': `${categoryLabel(settings, id)} share of the month` }),
          el('span', { class: 'cat-share muted' }, `${share}%`),
          el('span', { class: 'display-num cat-amount' }, fmt(value)),
        );
      })),
  );

  const recent = ordered.slice(0, 5);
  const recentCard = el('div', { class: 'card dashboard-panel' },
    el('div', { class: 'row between dashboard-panel-head' },
      el('span', { class: 'eyebrow' }, 'Recent'),
      el('a', { class: 'btn-link', href: '#history' }, 'See all '),
    ),
    recent.length === 0
      ? el('div', { class: 'empty' }, 'No entries yet.')
      : el('div', { class: 'recent-list' }, ...recent.flatMap((entry) => {
        const amount = Number(entry.amount) || 0;
        const isCredit = entry.type === 'credit';
        return [
          el('span', { class: 'recent-date muted' }, friendlyDate(String(entry.date || ''))),
          el('div', { class: 'recent-what' },
            el('div', { class: 'recent-title' }, String(entry.details || '-')),
            el('div', { class: 'recent-meta muted' }, `${categoryLabel(settings, String(entry.category || ''))} · ${methodLabel(settings, String(entry.method || ''))}`),
          ),
          el('span', { class: `display-num recent-amount ${isCredit ? 'is-positive' : 'is-negative'}` }, `${isCredit ? '+' : ''}${fmt(amount)}`),
          el('span', { class: 'recent-method' }, el('span', { class: 'pill' }, methodShort(settings, String(entry.method || '')))),
        ];
      })),
  );

  root.append(el('div', { class: 'dashboard-grid' }, catCard, recentCard));

  /* ── income this month, so the hero's net is explainable ───────────────── */
  const income = entriesForMonth(entries, summary.key).filter((entry) => isBudgetIncomeEntry(settings, entry));
  if (income.length) {
    root.append(el('div', { class: 'card dashboard-panel' },
      el('div', { class: 'eyebrow' }, 'Income this month'),
      el('div', { class: 'income-list' }, ...income.map((entry) => el('div', { class: 'income-row' },
        el('span', { class: 'muted' }, friendlyDate(String(entry.date || ''))),
        el('span', { class: 'income-title' }, String(entry.details || 'Income')),
        el('span', { class: 'display-num is-positive' }, `+${fmt(Number(entry.amount) || 0)}`),
      ))),
    ));
  }

  return root;
}
