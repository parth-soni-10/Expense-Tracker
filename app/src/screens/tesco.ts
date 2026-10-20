/* Tesco Pay: the pay-month snapshot, the pay weeks, the sheet, and the ways
 * into both.
 *
 * The engine is not here — `app/lib/tesco-pay.ts` is the ported engine (rates,
 * Sunday premium, PAYE/USC/PRSI/pension, week starts, pay dates) and
 * `app/lib/tesco-sheet.ts` is the sheet's own two tables (one row per shift, a
 * tax table of pay runs) with the rules they import and export by. This screen
 * is the surface: it reads `state.tesco` through those two, so every figure
 * here is the one the workbook and the dashboard would compute, and a week's
 * money is simulated once per week rather than prorated across a month
 * boundary.
 *
 * The write side lives in `screens/tesco-write.ts`, and it is a separate file
 * because it is a separate job: this one renders what is stored, that one
 * changes it. The rules both obey are the rules the ported modules own — a
 * hand edit is validated by the same rules an import is, so an edit can never
 * write a row the importer would have refused.
 *
 * What is not here, and why: the roster-photo reader and the word-list parser
 * that read a photographed grid were both removed from the shipping app on
 * purpose (`97fb40f`, and batch 34 for the parser), and `scripts/check-image-
 * hygiene.mjs` pins that absence. A roster now arrives by Quick entry, the
 * shift form or the workbook/CSV import.
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
  receivedByPayDate,
  simulateTax,
  weekStartOf,
  weekVsEstimate,
} from '../../lib/tesco-pay.ts';
import { navigate } from '../router.ts';
import { trackAction } from '../actions.ts';
import { toast } from '../toast.ts';
import {
  buildAddShiftCard,
  buildBankPayEditor,
  buildDataCard,
  buildPayslipActions,
  buildQuickEntryCard,
  buildRatesCard,
  buildShiftActions,
  buildWeekOffCard,
  fillTescoPayDate,
  recordTescoPayToLedger,
  tescoState,
} from './tesco-write.ts';
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

export function renderTesco(ctx: ScreenContext): HTMLElement {
  const settings: CentsSettings = ctx.state.settings || {};
  const stored = tescoState(ctx);
  const shifts = stored.shifts;
  const payslips = stored.payslips;
  const rates = stored.rates;
  const root = el('div', { class: 'page-section tesco-section' });

  const requested = ctx.params.get('month') || '';
  const key = MONTH.test(requested) && Number.isFinite(Date.parse(`${requested}-01T00:00:00Z`))
    ? requested
    : monthKey(today());
  const [year, month] = key.split('-').map(Number);
  const now = today();

  const go = (next: string): void => {
    const query = new URLSearchParams(ctx.params);
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

  /* ── the ways in: quick entry, a form, a week off ───────────────────────── */

  root.append(el('div', { class: 'tesco-write-grid' },
    buildQuickEntryCard(ctx),
    buildAddShiftCard(ctx),
    buildWeekOffCard(ctx),
  ));

  if (!shifts.length) {
    root.append(el('div', { class: 'card empty tesco-empty' },
      el('p', { class: 'muted' }, 'No shifts yet. Add one above, and the pay weeks appear here.'),
    ));
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
        buildShiftActions(ctx, shift),
      ))),
      // The week's own net, typed off a bank statement — never derived.
      buildBankPayEditor(ctx, week.weekStart),
    ));
  }

  root.append(el('div', { class: 'card tesco-panel' },
    el('div', { class: 'row between tesco-panel-head' },
      el('span', { class: 'eyebrow' }, `Pay weeks · ${monthWeeks.length}`),
      el('span', { class: 'muted' }, 'Week starts Sunday · pay date Thursday'),
    ),
    monthWeeks.length ? weekList : el('div', { class: 'empty' }, 'No pay week starts in this month.'),
  ));

  /* ── the tax table: one row per pay run ─────────────────────────────────── */

  if (payslips.length) {
    const slipRows = el('div', { class: 'tesco-slips' });
    for (const payslip of [...payslips].sort((a, b) => String(b.weekStart).localeCompare(String(a.weekStart)))) {
      const total = (Number(payslip.paye) || 0) + (Number(payslip.usc) || 0)
        + (Number(payslip.prsi) || 0) + (Number(payslip.futureFund) || 0);
      slipRows.append(el('div', { class: 'tesco-slip' },
        el('span', { class: 'tesco-slip-week' }, String(payslip.weekStart)),
        el('span', { class: 'tesco-slip-date muted' }, `paid ${payDateOf(weekStartOf(String(payslip.weekStart)))}`),
        el('span', { class: 'tesco-slip-tax muted' },
          `PAYE ${fmt(Number(payslip.paye) || 0)} · USC ${fmt(Number(payslip.usc) || 0)} · PRSI ${fmt(Number(payslip.prsi) || 0)}`),
        el('span', { class: 'display-num' }, fmt(total)),
        buildPayslipActions(ctx, payslip),
      ));
    }
    root.append(el('div', { class: 'card tesco-panel' },
      el('div', { class: 'row between tesco-panel-head' },
        el('span', { class: 'eyebrow' }, `Tax figures · ${payslips.length}`),
        el('span', { class: 'muted' }, 'One row per pay run'),
      ),
      slipRows,
    ));
  }

  /* ── the rules, and the file in and out ─────────────────────────────────── */

  root.append(el('div', { class: 'tesco-write-grid' },
    buildRatesCard(ctx),
    buildDataCard(ctx),
  ));

  /* ── what the ledger already knows ──────────────────────────────────────── */

  const paidIn = (ctx.state.entries || []).filter((entry) => {
    const day = String(entry.date || '');
    return inMonth(day) && day <= now && entry.type === 'credit'
      && /tesco/i.test(String(entry.details || ''));
  });
  const landed = paidIn.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);

  // The ledger's side: the pay the tab already knows about, written into the
  // ledger so the money reaches Balances without anyone pressing Fill. The
  // rules — create only where the ledger is silent, follow the recorded figure
  // while the line is still the one this app wrote, and never bring a deleted
  // line back — live in `tescoPayLedgerWrites`.
  const recorded = receivedByPayDate(stored.shifts, stored.payslips, rates, today());
  const fillable = Object.keys(recorded)
    .filter((date) => inMonth(date) && date <= now && Number(recorded[date].amount) > 0)
    .sort();

  const ledgerPanel = el('div', { class: 'card tesco-panel' },
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
  );

  if (fillable.length) {
    const fillList = el('div', { class: 'tesco-fill-list' });
    for (const date of fillable) {
      fillList.append(el('div', { class: 'tesco-fill-row' },
        el('span', { class: 'tesco-slip-week' }, date),
        el('span', { class: 'muted' }, fmt(Number(recorded[date].amount))),
        el('button', {
          type: 'button', class: 'btn btn-ghost', 'aria-label': `Put the pay of ${date} in the ledger`,
          onClick: () => {
            const result = fillTescoPayDate(ctx, date);
            if (!result.ok) { toast(result.note || 'That week has nothing to record.'); return; }
            toast(result.note || 'Recorded.', { label: 'Undo', run: () => { ctx.refresh(); } });
            ctx.refresh();
          },
        }, 'Put in ledger'),
      ));
    }
    ledgerPanel.append(el('div', { class: 'tesco-fill' },
      el('div', { class: 'eyebrow' }, 'Not in the ledger yet'),
      fillList,
      el('div', { class: 'add-actions' },
        el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => {
            const written = recordTescoPayToLedger(ctx);
            if (!written) { toast('The ledger already has these.'); return; }
            const before = JSON.parse(JSON.stringify((ctx.state as any).entries || []));
            const step = trackAction(ctx.save, {
              label: 'Record the Tesco pay in the ledger',
              undo: () => { written.undo(); },
            });
            toast(written.note, { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
            void before;
            ctx.refresh();
          },
        }, 'Record all of them'),
      ),
    ));
  }

  root.append(ledgerPanel);

  void settings;
  void TESCO_RATE_DEFAULTS;
  return root;
}
