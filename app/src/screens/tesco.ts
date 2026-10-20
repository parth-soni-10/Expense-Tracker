/* Tesco Pay: the pay-month snapshot, the pay weeks and the shifts behind them.
 *
 * The engine is not here — `app/lib/tesco-pay.ts` is the ported engine (rates,
 * Sunday premium, PAYE/USC/PRSI/pension, week starts, pay dates) and
 * `scripts/test-tesco.mjs` holds it against the workbook. This screen is the
 * surface: it reads `state.tesco` through that engine, so every figure here is
 * the one the workbook and the dashboard would compute, and a week's money is
 * simulated once per week rather than prorated across a month boundary.
 *
 * Ported from `screenTesco()` in tesco.js. What it keeps: the month the reader
 * is looking at (`?month=`, defaulting to this month), the four figures the rest
 * of the app quotes for it (hours, anticipated net, received, and what is still
 * expected), and the pay weeks the month contains, each with its own hours, gross
 * and what it did against the estimate. It is read-only on purpose: writing a
 * shift or a payslip the app cannot yet import a roster for is a different
 * batch's job, and a write path without the import half would be a way to make
 * the ledger disagree with the sheet it came from.
 *
 * What is not here: the shift form, the payslip editor, the week-off card, the
 * workbook/CSV import and export, and the ledger write for a received payment.
 * All of them are `tesco.js` features in their own right and are recorded in
 * docs/DEFERRED_TESTS.md rather than sketched.
 */
import type { CentsSettings } from '../../lib/types.ts';
import { el } from '../dom.ts';
import { fmt, monthKey, monthLabel, previousMonthKey, today } from '../format.ts';
import {
  TESCO_RATE_DEFAULTS,
  buildPayWeeks,
  monthSummary,
  payDateOf,
  r2,
  simulateTax,
  weekVsEstimate,
} from '../../lib/tesco-pay.ts';
import { navigate } from '../router.ts';
import type { ScreenContext } from './context.ts';

const MONTH = /^\d{4}-\d{2}$/;

function shiftMonth(key: string, step: number): string {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + step, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(key: string): string {
  return shiftMonth(key, 1);
}

function cell(label: string, value: string, tone: '' | 'positive' | 'negative'): HTMLElement {
  return el('div', { class: 'card tesco-cell' },
    el('div', { class: 'eyebrow' }, label),
    el('div', { class: `display-num tesco-cell-value${tone ? ` is-${tone}` : ''}` }, value),
  );
}

/** `09:00 – 17:00`, or the stated hours for a booked week off. */
function shiftWhen(shift: Record<string, any>): string {
  if (shift.start && shift.end) return `${shift.start} – ${shift.end}`;
  return shift.hours != null ? `${shift.hours}h booked` : '—';
}

export function renderTesco({ state, params }: ScreenContext): HTMLElement {
  const settings: CentsSettings = state.settings || {};
  const tesco = state.tesco || { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] };
  const shifts = Array.isArray(tesco.shifts) ? tesco.shifts : [];
  const payslips = Array.isArray(tesco.payslips) ? tesco.payslips : [];
  const overrides = (settings.tescoRates || {}) as Record<string, number>;
  const rates = { ...TESCO_RATE_DEFAULTS, ...overrides };
  const root = el('div', { class: 'page-section tesco-section' });

  const requested = params.get('month') || '';
  const key = MONTH.test(requested) && Number.isFinite(Date.parse(`${requested}-01T00:00:00Z`))
    ? requested
    : monthKey(today());
  const [year, month] = key.split('-').map(Number);
  const now = today();

  const go = (next: string): void => {
    const query = new URLSearchParams(params);
    query.set('month', next);
    navigate('tesco', query, { replace: true });
  };

  /* ── the month's four figures ───────────────────────────────────────────── */

  const summary = monthSummary(shifts, payslips, rates, year, month - 1, now);
  const gap = r2(summary.anticipated - summary.received);

  root.append(el('div', { class: 'tesco-month' },
    el('button', {
      type: 'button', class: 'btn btn-ghost tesco-month-step', 'aria-label': 'Previous month',
      onClick: () => go(previousMonthKey(key)),
    }, '←'),
    el('div', { class: 'tesco-month-label' },
      el('div', { class: 'eyebrow' }, 'Pay month'),
      el('div', { class: 'serif tesco-month-name' }, monthLabel(key)),
    ),
    el('button', {
      type: 'button', class: 'btn btn-ghost tesco-month-step', 'aria-label': 'Next month',
      onClick: () => go(key === monthKey(now) ? key : nextMonth(key)),
    }, '→'),
    key !== monthKey(now)
      ? el('button', {
        type: 'button', class: 'btn-link tesco-month-now',
        onClick: () => navigate('tesco', new URLSearchParams()),
      }, 'This month')
      : null,
  ));

  root.append(el('div', { class: 'tesco-cells' },
    cell('Hours', `${summary.hours}h`, ''),
    cell('Anticipated (est. net)', fmt(summary.anticipated), 'positive'),
    cell('Received', fmt(summary.received), ''),
    cell(gap >= 0 ? 'Still to come' : 'Over the estimate', fmt(Math.abs(gap)), gap >= 0 ? '' : 'negative'),
  ));

  if (!shifts.length) {
    root.append(el('div', { class: 'card empty tesco-empty' },
      el('p', { class: 'muted' }, 'No shifts yet. The pay weeks appear here once a shift is logged.'),
    ));
    return root;
  }

  /* ── the pay weeks this month contains ──────────────────────────────────── */

  const weeks = buildPayWeeks(shifts, payslips, rates);
  const inMonth = (iso: string): boolean => {
    const date = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(date) && new Date(date).getUTCFullYear() === year && new Date(date).getUTCMonth() === month - 1;
  };
  const monthWeeks = weeks.filter((week: any) => inMonth(week.weekStart));

  const weekList = el('div', { class: 'tesco-weeks' });
  for (const week of monthWeeks as any[]) {
    const sim = week.gross > 0 ? simulateTax(week.gross, rates) : null;
    const vs = weekVsEstimate(week, rates);
    const paid = inMonth(payDateOf(week.weekStart)) && payDateOf(week.weekStart) <= now;
    weekList.append(el('div', { class: 'card tesco-week' },
      el('div', { class: 'row between tesco-week-head' },
        el('span', { class: 'eyebrow' }, `Week of ${week.weekStart}`),
        el('span', { class: `pill tesco-week-state${paid ? ' is-paid' : ''}` }, paid ? 'Paid' : 'Expected'),
      ),
      el('div', { class: 'tesco-week-figs' },
        el('span', null, el('strong', null, `${week.hours}h`), ' worked'),
        el('span', null, 'Gross ', el('strong', null, fmt(week.gross))),
        el('span', null, 'Est. net ', el('strong', null, sim ? fmt(sim.net) : '—')),
        el('span', null, 'Pay date ', el('strong', null, payDateOf(week.weekStart))),
        week.bankPaid != null
          ? el('span', null, 'Bank ', el('strong', null, fmt(week.bankPaid)))
          : null,
        vs
          ? el('span', { class: `tesco-week-vs ${vs.delta < 0 ? 'is-negative' : 'is-positive'}` },
            `${vs.delta < 0 ? '−' : '+'}${fmt(Math.abs(vs.delta))} vs est ${vs.against}`)
          : null,
      ),
      el('div', { class: 'tesco-shift-list' }, ...week.shifts.map((shift: any) => el('div', { class: 'tesco-shift' },
        el('span', { class: 'tesco-shift-date muted' }, shift.date),
        el('span', { class: 'tesco-shift-when' }, shiftWhen(shift)),
        el('span', { class: 'tesco-shift-note muted' }, String(shift.note || '')),
        el('span', { class: 'display-num tesco-shift-pay' },
          (() => {
            const pay = shift.gross == null ? null : Number(shift.gross);
            if (Number.isFinite(pay)) return fmt(pay as number);
            if (shift.hours != null) return `${shift.hours}h`;
            return '—';
          })()),
      ))),
    ));
  }

  root.append(el('div', { class: 'card tesco-panel' },
    el('div', { class: 'row between tesco-panel-head' },
      el('span', { class: 'eyebrow' }, `Pay weeks · ${monthWeeks.length}`),
      el('span', { class: 'muted' }, 'Week starts Sunday · pay date Thursday'),
    ),
    monthWeeks.length ? weekList : el('div', { class: 'empty' }, 'No pay week starts in this month.'),
  ));

  /* ── what the ledger already knows ──────────────────────────────────────── */

  const paidIn = (state.entries || []).filter((entry) => {
    const day = String(entry.date || '');
    return inMonth(day) && day <= now && entry.type === 'credit'
      && /tesco/i.test(String(entry.details || ''));
  });
  const landed = paidIn.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  root.append(el('div', { class: 'card tesco-panel' },
    el('div', { class: 'row between tesco-panel-head' },
      el('span', { class: 'eyebrow' }, 'Pay in the ledger'),
      el('a', { class: 'btn-link', href: `#history?q=tesco` }, 'Open History'),
    ),
    paidIn.length
      ? el('div', { class: 'tesco-ledger' },
        el('p', { class: 'muted tesco-ledger-note' },
          `${paidIn.length} income row${paidIn.length === 1 ? '' : 's'} this month naming Tesco, ${fmt(landed)} in all.`),
        ...paidIn.map((entry) => el('div', { class: 'tesco-ledger-row' },
          el('span', { class: 'muted' }, String(entry.date)),
          el('span', { class: 'tesco-ledger-detail' }, String(entry.details || 'Tesco')),
          el('span', { class: 'display-num is-positive' }, `+${fmt(Number(entry.amount) || 0)}`),
        )))
      : el('p', { class: 'muted tesco-ledger-note' },
        'No Tesco income has landed this month yet. A payment recorded on the Add screen appears here.'),
  ));

  return root;
}
