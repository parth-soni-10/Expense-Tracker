/* ============================================================
   Year in review.

   The one thing in this app worth putting on paper: what the year earned,
   what it spent, and what the answer is. It is a real surface — the figures
   come from the ledger, the year is the one that is running, and every
   number here is the same arithmetic the dashboard and the Insights screen
   use, so the three can never disagree.

   Ported from `openYearInReview()` in the shipping app's insights.js, and
   kept to its three exits:

   · PRINT — the review is the thing worth printing, and the print
     stylesheet shows ONLY this sheet: the app behind it, the nav and the
     toast stack are all suppressed. The class goes on the BODY, so the
     print sheet is the only thing on the page. Some embedded webviews never
     fire `afterprint`, so the class is swept on a timer as well — a
     half-printed page that stays hidden is worse than a printed one with a
     stray class on it.

   · COPY SUMMARY — the same figures as text, for a message or a note.

   · CLOSE — and Escape, because a sheet you cannot leave is a trap.
   ============================================================ */
import { el } from '../dom.ts';
import { toast } from '../toast.ts';
import { fmt, friendlyDate, monthLabel } from '../format.ts';
import { categoryLabel, isBudgetIncomeEntry, isBudgetSpendingEntry } from '../metrics.ts';
import type { CentsState } from '../../lib/types.ts';

export interface ReviewRow {
  label: string;
  value: string;
  tone: '' | 'positive' | 'negative';
}

export interface YearReview {
  year: number;
  rows: ReviewRow[];
  /** The plain text the Copy button offers. */
  text: string;
}

/** The year's figures, from the ledger.
 *
 *  The same entries the rest of the app counts: spending and income are the
 *  budget's definitions, so a figure here cannot disagree with the
 *  dashboard's. */
export function yearReview(state: CentsState, year: number): YearReview {
  const entries = (Array.isArray(state.entries) ? state.entries : []) as any[];
  const settings = (state.settings || {}) as any;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const yearEntries = entries.filter((entry) => String(entry.date || '') >= from && String(entry.date || '') <= to);
  const spending = yearEntries.filter((entry) => isBudgetSpendingEntry(settings, entry));
  const income = yearEntries.filter((entry) => isBudgetIncomeEntry(settings, entry));

  const totalSpent = spending.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const totalEarned = income.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const net = totalEarned - totalSpent;

  const byCategory: Record<string, number> = {};
  for (const entry of spending) {
    const key = String(entry.category || 'misc');
    byCategory[key] = (byCategory[key] || 0) + (Number(entry.amount) || 0);
  }
  const topCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];

  const byDay: Record<string, { count: number; total: number }> = {};
  for (const entry of spending) {
    const key = String(entry.date || '');
    const current = byDay[key] || { count: 0, total: 0 };
    byDay[key] = { count: current.count + 1, total: current.total + (Number(entry.amount) || 0) };
  }
  const busiestDay = Object.entries(byDay).sort((a, b) => b[1].total - a[1].total)[0];

  const byMonth: Record<string, number> = {};
  for (const entry of spending) {
    const key = String(entry.date || '').slice(0, 7);
    byMonth[key] = (byMonth[key] || 0) + (Number(entry.amount) || 0);
  }
  const bestMonth = Object.entries(byMonth).sort((a, b) => a[1] - b[1])[0];
  const worstMonth = Object.entries(byMonth).sort((a, b) => b[1] - a[1])[0];

  const rows: ReviewRow[] = [
    { label: 'Total earned', value: fmt(totalEarned), tone: 'positive' },
    { label: 'Total spent', value: fmt(totalSpent), tone: 'negative' },
    { label: 'Net', value: fmt(net), tone: net >= 0 ? 'positive' : 'negative' },
    { label: 'Entries logged', value: String(yearEntries.length), tone: '' },
    {
      label: 'Top category',
      value: topCategory ? `${categoryLabel(settings, topCategory[0])} · ${fmt(topCategory[1])}` : '—',
      tone: '',
    },
    { label: 'Best month', value: bestMonth ? `${monthLabel(bestMonth[0])} · ${fmt(bestMonth[1])}` : '—', tone: '' },
    { label: 'Toughest month', value: worstMonth ? `${monthLabel(worstMonth[0])} · ${fmt(worstMonth[1])}` : '—', tone: '' },
    {
      label: 'Busiest day',
      value: busiestDay
        ? `${friendlyDate(busiestDay[0])} — ${busiestDay[1].count} entries, ${fmt(busiestDay[1].total)}`
        : '—',
      tone: '',
    },
  ];

  return {
    year,
    rows,
    text: rows.map((row) => `${row.label}: ${row.value}`).join('\n'),
  };
}

/** Open the review. */
export function openYearInReview(state: CentsState, year = new Date().getFullYear()): void {
  const review = yearReview(state, year);
  const dialog = el('dialog', { class: 'history-dialog', id: 'year-review' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card year-review' });

  const close = (): void => { dialog.close(); };
  dialog.addEventListener('close', () => { dialog.remove(); });

  card.append(
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, `Your ${review.year} in review`),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close the year in review', onClick: close }, 'Close'),
    ),
  );

  for (const row of review.rows) {
    card.append(el('div', { class: 'year-review-row' },
      el('span', { class: 'muted' }, row.label),
      el('span', { class: `display-num year-review-value${row.tone ? ` is-${row.tone}` : ''}` }, row.value),
    ));
  }

  card.append(el('div', { class: 'add-actions' },
    el('button', {
      type: 'button', class: 'btn btn-ghost',
      onClick: () => {
        // The class goes on the BODY, so the print sheet is the only thing on
        // the page. Some embedded webviews never fire `afterprint`, so the
        // class is swept on a timer as well.
        document.body.classList.add('printing-review');
        const done = (): void => {
          document.body.classList.remove('printing-review');
          window.removeEventListener('afterprint', done);
        };
        window.addEventListener('afterprint', done);
        setTimeout(done, 30_000);
        window.print();
      },
    }, 'Print'),
    el('button', {
      type: 'button', class: 'btn btn-ghost',
      onClick: () => {
        const text = review.text;
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).then(
            () => toast('Copied to clipboard!'),
            () => toast('Could not copy.'),
          );
          return;
        }
        toast('Could not copy.');
      },
    }, 'Copy summary'),
    el('button', { type: 'button', class: 'btn btn-primary', onClick: close }, 'Close'),
  ));

  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}
