/* The recurring manager: the bills and paydays on repeat.
 *
 * Ported from the shipping app's recurring surfaces in app.js, and kept to the
 * rules `app/lib/recurring.ts` owns, because a date that advances wrongly is a
 * schedule that fires on the wrong day and nobody notices until the money is
 * wrong.
 *
 * Three things this surface has to get right, and each is a decision rather
 * than a style:
 *
 *   · a monthly schedule lands on the SAME day of the month every time (the
 *     shipping app passed a 1-based month into a 0-based index, so every
 *     monthly advance skipped a month — August became October);
 *   · "Paid" logs the occurrence and advances the schedule past it, so the
 *     same logical charge can never be paid twice, and it is ONE undo step;
 *   · "Skip" advances the schedule without logging anything, which is what a
 *     holiday week or a delayed direct debit needs.
 *
 * The suggestion is the other half: a charge worth putting on the schedule,
 * found in the ledger itself — three of the same, spread at least five days
 * apart, regular enough to read as a cadence rather than a coincidence.
 */
import { el } from '../dom.ts';
import { rehomeToast, toast } from '../toast.ts';
import { trackAction } from '../actions.ts';
import { uid } from '../../lib/storage.ts';
import { CATEGORIES, RECURRING_FREQUENCIES } from '../../lib/seed.ts';
import { methodOptions } from '../../lib/methods.ts';
import {
  advancePast,
  computeInitialNextDate,
  daysUntil,
  frequencyLabel,
  makeRecurringRule,
  recurringSuggestion,
  type RecurringRule,
} from '../../lib/recurring.ts';
import { today } from '../format.ts';
import type { ScreenContext } from './context.ts';

function rulesOf(ctx: ScreenContext): RecurringRule[] {
  const rules = (ctx.state.settings as any).recurring;
  return Array.isArray(rules) ? rules : [];
}

export function openRecurringManager(ctx: ScreenContext): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'recurring-manager' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card recurring-manager' });

  const close = (): void => {
    dialog.close();
  };
  // Escape closes a modal too, and that path does not go through the Close
  // button — so the element is removed on the `close` event rather than at
  // the call site. A sheet left behind is a sheet with a stale id, and the
  // next one to open would duplicate it.
  dialog.addEventListener('close', () => {
    rehomeToast();
    dialog.remove();
    ctx.refresh();
  });

  const list = el('div', { class: 'recurring-list' });
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  /* ── the new-rule form ──────────────────────────────────────────────────── */

  const detailsField = el('input', { type: 'text', class: 'add-input', 'aria-label': 'What repeats', autocomplete: 'off', maxlength: '80' }) as HTMLInputElement;
  const amountField = el('input', { type: 'text', class: 'add-input', inputmode: 'decimal', 'aria-label': 'Amount in euros', autocomplete: 'off' }) as HTMLInputElement;
  const frequencySelect = el('select', { class: 'add-input', 'aria-label': 'How often it repeats' },
    ...RECURRING_FREQUENCIES.map((frequency) => el('option', { value: frequency }, frequencyLabel(frequency, 1))),
  ) as HTMLSelectElement;
  const dayField = el('input', { type: 'number', class: 'add-input', min: '1', max: '31', value: '1', 'aria-label': 'Day of the month' }) as HTMLInputElement;
  const methodSelect = el('select', { class: 'add-input', 'aria-label': 'Payment method' },
    ...methodOptions(ctx.state.settings).map((option) => el('option', { value: option.id }, option.label)),
  ) as HTMLSelectElement;
  const categorySelect = el('select', { class: 'add-input', 'aria-label': 'Category' },
    ...CATEGORIES.map((category) => el('option', { value: category.id }, category.label)),
  ) as HTMLSelectElement;

  const writeRule = (rule: RecurringRule): void => {
    const settings = ctx.state.settings as any;
    const existing = rulesOf(ctx);
    const at = existing.findIndex((r) => r.id === rule.id);
    if (at === -1) settings.recurring = [...existing, rule];
    else settings.recurring = existing.map((r, i) => (i === at ? rule : r));
  };

  const addRule = (): void => {
    const made = makeRecurringRule({
      id: `rec_${uid()}`,
      type: 'expense',
      details: detailsField.value,
      amount: Number(amountField.value),
      method: methodSelect.value,
      category: categorySelect.value,
      frequency: frequencySelect.value,
      dayOfMonth: Number(dayField.value),
    });
    if (made.ok === false) {
      status.textContent = made.error;
      return;
    }
    status.textContent = '';
    writeRule(made.rule);
    ctx.save();
    detailsField.value = '';
    amountField.value = '';
    toast(`Recurring "${made.rule.details}" added — next ${made.rule.nextDate}.`);
    draw();
  };

  /* ── the list ───────────────────────────────────────────────────────────── */

  const pay = (rule: RecurringRule): void => {
    const date = rule.nextDate;
    const entry = {
      id: uid(),
      createdAt: new Date().toISOString(),
      date,
      type: rule.type || 'expense',
      category: rule.category || 'misc',
      details: rule.details || '',
      amount: Number(rule.amount) || 0,
      method: rule.method || 'AIB',
      note: rule.note || '',
    };
    const oldDate = rule.nextDate;
    ctx.state.entries.push(entry as any);
    ctx.state.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // Advance the schedule past the paid date, so the same logical charge can
    // never be paid twice. ISO dates compare correctly as strings.
    const advanced = advancePast(rule, date);
    rule.nextDate = advanced.nextDate;
    const step = trackAction(ctx.save, {
      label: `Paid ${rule.details}`,
      entries: [entry as any],
      undo: () => {
        ctx.state.entries = ctx.state.entries.filter((e) => e.id !== entry.id);
        const tombstones = Array.isArray(ctx.state.settings.deletedEntryIds) ? ctx.state.settings.deletedEntryIds : [];
        ctx.state.settings.deletedEntryIds = tombstones.filter((id) => id !== entry.id);
        rule.nextDate = oldDate;
        ctx.save();
      },
    });
    toast(`Paid: ${rule.details}`, { label: 'Undo', run: () => { step.undo(); draw(); } });
    draw();
  };

  const skip = (rule: RecurringRule): void => {
    const oldDate = rule.nextDate;
    const advanced = advancePast(rule, rule.nextDate);
    rule.nextDate = advanced.nextDate;
    const step = trackAction(ctx.save, {
      label: `Skipped ${rule.details}`,
      undo: () => { rule.nextDate = oldDate; ctx.save(); },
    });
    toast(`Skipped: ${rule.details} — next ${rule.nextDate}.`, { label: 'Undo', run: () => { step.undo(); draw(); } });
    draw();
  };

  const remove = (rule: RecurringRule): void => {
    const before = rulesOf(ctx);
    writeRule({ ...rule, id: '' });
    (ctx.state.settings as any).recurring = before.filter((r) => r.id !== rule.id);
    const step = trackAction(ctx.save, {
      label: `Removed ${rule.details}`,
      undo: () => { (ctx.state.settings as any).recurring = before; ctx.save(); },
    });
    toast(`Removed "${rule.details}".`, { label: 'Undo', run: () => { step.undo(); draw(); } });
    draw();
  };

  const draw = (): void => {
    list.replaceChildren();
    const rules = rulesOf(ctx);

    for (const rule of rules) {
      const days = daysUntil(rule.nextDate);
      const when = days === 0 ? 'today' : (days === 1 ? 'tomorrow' : (days < 0 ? `${Math.abs(days)} days ago` : `in ${days} days`));
      list.append(el('div', { class: 'recurring-row' },
        el('div', { class: 'recurring-row-text' },
          el('div', { class: 'recurring-row-label' }, rule.details || 'Untitled'),
          el('div', { class: 'recurring-row-meta muted' },
            `${frequencyLabel(rule.frequency, rule.dayOfMonth)} · next ${rule.nextDate} (${when})`),
        ),
        el('div', { class: 'recurring-row-actions' },
          el('button', {
            type: 'button', class: 'btn btn-primary', 'aria-label': `Pay ${rule.details}`,
            onClick: () => pay(rule),
          }, 'Paid'),
          el('button', {
            type: 'button', class: 'btn btn-ghost', 'aria-label': `Skip ${rule.details}`,
            onClick: () => skip(rule),
          }, 'Skip'),
          el('button', {
            type: 'button', class: 'btn-link', 'aria-label': `Remove ${rule.details}`,
            onClick: () => remove(rule),
          }, 'Remove'),
        ),
      ));
    }

    if (!rules.length) {
      list.append(el('p', { class: 'muted' }, 'Nothing repeats yet. Add a bill or a payday below.'));
    }

    // The suggestion: a charge worth putting on the schedule, found in the
    // ledger itself. Silent when there is no pattern, and when one is already
    // scheduled.
    const suggestion = recurringSuggestion(ctx.state.entries, rules);
    if (suggestion) {
      const cadence = frequencyLabel(suggestion.frequency, suggestion.dayOfMonth);
      list.append(el('div', { class: 'card recurring-suggestion' },
        el('div', { class: 'eyebrow' }, 'Worth repeating'),
        el('p', { class: 'muted' },
          `"${suggestion.entry.details}" appears ${suggestion.count} times, ${cadence.toLowerCase()}.`),
        el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => {
            const made = makeRecurringRule({
              id: `rec_${uid()}`,
              type: suggestion.entry.type,
              details: suggestion.entry.details,
              amount: suggestion.entry.amount,
              method: suggestion.entry.method,
              category: suggestion.entry.category,
              frequency: suggestion.frequency,
              dayOfMonth: suggestion.dayOfMonth,
              nextDate: computeInitialNextDate(suggestion.frequency, suggestion.dayOfMonth),
            });
            if (!made.ok) return;
            writeRule(made.rule);
            ctx.save();
            toast(`Recurring "${made.rule.details}" added — next ${made.rule.nextDate}.`);
            draw();
          },
        }, 'Add to repeating'),
      ));
    }
  };

  card.append(
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Recurring'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close recurring', onClick: close }, 'Close'),
    ),
    list,
    el('div', { class: 'card recurring-form' },
      el('div', { class: 'eyebrow' }, 'Add a repeating item'),
      el('div', { class: 'add-row' },
        detailsField,
        amountField,
      ),
      el('div', { class: 'add-row' },
        frequencySelect,
        dayField,
      ),
      el('div', { class: 'add-row' },
        methodSelect,
        categorySelect,
      ),
      el('div', { class: 'add-actions' },
        el('button', { type: 'button', class: 'btn btn-primary', onClick: addRule }, 'Add'),
      ),
    ),
    status,
  );

  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
  draw();
  void today;
}
