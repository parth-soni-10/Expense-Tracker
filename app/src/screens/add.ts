/* Add: the quick line, and the structured form behind "More".
 *
 * The quick line is the app's main input and goes through the ported parser
 * (`src/quick-entry.ts`), which `scripts/test-parity-money.mjs` holds to the
 * shipping parser line by line. The preview shows what will be written before
 * anything is written — merchant, amount, method, category, date, and whether
 * the line becomes a transfer pair or a split — so a mis-parse is visible
 * before it is stored.
 *
 * The form keeps the URL contract (`docs/URL_CONTRACT.md`): `#add?more=1` opens
 * it, `&type=credit` selects Income, and toggling either writes the query with
 * `replaceState`, so Back never steps through a fold or a type change.
 */
import type { CentsState, Entry } from '../../lib/types.ts';
import { CATEGORIES } from '../../lib/seed.ts';
import { uid } from '../../lib/storage.ts';
import { el } from '../dom.ts';
import { friendlyDate, monthLabel, parseAmount, today } from '../format.ts';
import { methodLabel, methodShort } from '../metrics.ts';
import { methodOptions } from '../../lib/methods.ts';
import { overPreciseAmount, parseNaturalLanguage, quickEntryLegs, type ParsedEntry } from '../quick-entry.ts';
import { navigate } from '../router.ts';
import { takeSharedText } from '../share.ts';
import { toast } from '../toast.ts';
import type { ScreenContext } from './context.ts';

function categoryLabel(id: string): string {
  return CATEGORIES.find((category) => category.id === id)?.label || id;
}

/** One line describing what a parsed entry will write. */
function describeParsed(state: CentsState, parsed: ParsedEntry): string {
  const amount = `€${(parsed.amount || 0).toFixed(2)}`;
  if (parsed.type === 'transfer' && parsed.transfer) {
    return `${amount} · transfer ${methodShort(state.settings, parsed.transfer.from)} → ${methodShort(state.settings, parsed.transfer.to)}`;
  }
  if (parsed.split && parsed.split.length >= 2) {
    return `${amount} · split ${parsed.split.map((s) => `${methodShort(state.settings, s.method)} €${s.amount.toFixed(2)}`).join(' + ')}`;
  }
  return `${amount} · ${methodLabel(state.settings, String(parsed.method))} · ${categoryLabel(String(parsed.category))}`;
}

export function renderAdd({ state, params, save }: ScreenContext): HTMLElement {
  const root = el('div', { class: 'page-section add-section' });
  const showMore = params.get('more') === '1';
  let type: 'expense' | 'credit' = params.get('type') === 'credit' ? 'credit' : 'expense';

  const setUrl = (): void => {
    const next = new URLSearchParams();
    if (showMore) next.set('more', '1');
    if (type === 'credit') next.set('type', 'credit');
    navigate('add', next, { replace: true });
  };

  /* ── quick entry ───────────────────────────────────────────────────────── */

  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });
  const preview = el('div', { class: 'add-preview', 'aria-live': 'polite' });
  const input = el('textarea', {
    id: 'quick-entry',
    class: 'add-quick',
    rows: '2',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Quick entry',
    placeholder: 'lidl groceries 4.47 revolut',
  }) as HTMLTextAreaElement;

  const clearPreview = () => {
    preview.replaceChildren();
    status.textContent = '';
    status.className = 'add-status';
  };

  const renderPreview = (): void => {
    const raw = input.value.trim();
    preview.replaceChildren();
    status.textContent = '';
    status.className = 'add-status';
    if (!raw) return;
    const parsed = parseNaturalLanguage(raw);
    if (!parsed) return;
    if (parsed.error) {
      status.textContent = parsed.error;
      status.classList.add('is-error');
      return;
    }
    preview.append(
      el('div', { class: 'add-preview-main' },
        el('span', { class: 'add-preview-details' }, String(parsed.details || 'Entry')),
        el('span', { class: 'add-preview-meta muted' }, describeParsed(state, parsed)),
      ),
      el('span', { class: 'pill add-preview-date' }, friendlyDate(String(parsed.date))),
    );
  };

  // Text shared in from another app goes into the QUICK entry, and it is
  // consumed ONCE — the share may have landed while the app was locked, so it
  // waits for this screen. Nothing is stored: the preview names what the line
  // will become, and the user still presses Add.
  const shared = takeSharedText();
  if (shared) {
    input.value = shared;
    renderPreview();
    queueMicrotask(() => { if (input.isConnected) input.focus(); });
    toast('Shared into the quick entry - check the preview, then Add.');
  }

  const addQuick = (): void => {
    const raw = input.value.trim();    if (!raw) {
      status.textContent = 'Type what you spent, for example “coffee 3.50 cash”.';
      status.className = 'add-status is-error';
      return;
    }
    const parsed = parseNaturalLanguage(raw);
    if (!parsed || parsed.error) {
      status.textContent = parsed?.error || 'That line could not be read.';
      status.className = 'add-status is-error';
      return;
    }
    const legs = quickEntryLegs(parsed, uid, new Date().toISOString());
    if (!legs.length) {
      status.textContent = 'That line could not be read.';
      status.className = 'add-status is-error';
      return;
    }
    state.entries.push(...legs);
    const ok = save();
    input.value = '';
    clearPreview();
    status.textContent = ok
      ? `Added ${parsed.details} — €${(parsed.amount || 0).toFixed(2)}.`
      : 'Could not save on this device. The entry is on screen but not on disk.';
    status.className = `add-status${ok ? ' is-ok' : ' is-error'}`;
    // No re-render here: this screen shows no ledger totals, and redrawing it
    // would throw away the confirmation the reader is looking at.
    input.focus();
  };

  const quickCard = el('div', { class: 'card add-card' },
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Quick entry'),
      el('span', { class: 'muted add-hint' }, `today · ${monthLabel(today().slice(0, 7))}`),
    ),
    input,
    preview,
    status,
    el('div', { class: 'add-actions' },
      el('button', { type: 'submit', class: 'btn btn-primary', onClick: addQuick }, 'Add'),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        onClick: () => {
          const raw = input.value.trim();
          const parsed = raw ? parseNaturalLanguage(raw) : null;
          if (parsed && !parsed.error) setFormFromParsed(parsed);
          openMore();
        },
      }, 'Edit details'),
    ),
  );
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      addQuick();
    }
  });
  input.addEventListener('input', renderPreview);

  /* ── structured form ───────────────────────────────────────────────────── */

  const detailField = el('input', { id: 'entry-details', class: 'add-input', type: 'text', autocomplete: 'off', 'aria-label': 'Description' }) as HTMLInputElement;
  const amountField = el('input', { id: 'entry-amount', class: 'add-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Amount in euros' }) as HTMLInputElement;
  const dateField = el('input', { id: 'entry-date', class: 'add-input', type: 'date', value: today(), max: today(), 'aria-label': 'Date' }) as HTMLInputElement;
  const noteField = el('input', { id: 'entry-note', class: 'add-input', type: 'text', autocomplete: 'off', 'aria-label': 'Note' }) as HTMLInputElement;
  const categorySelect = el('select', { id: 'entry-category', class: 'add-input', 'aria-label': 'Category' },
    ...CATEGORIES.map((category) => el('option', { value: category.id }, category.label)),
  ) as HTMLSelectElement;
  // The picker offers the methods the document holds, not a static list: a
  // method the user added is here, and one they took out of the pickers is
  // not. `methodOptions` is the one list every picker reads.
  const methodSelect = el('select', { id: 'entry-method', class: 'add-input', 'aria-label': 'Payment method' },
    ...methodOptions(state.settings).map((method) => el('option', { value: method.id }, method.label)),
  ) as HTMLSelectElement;
  const formStatus = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const expenseTab = el('button', { type: 'button', class: 'pill', 'aria-pressed': 'true' }, 'Expense');
  const incomeTab = el('button', { type: 'button', class: 'pill', 'aria-pressed': 'false' }, 'Income');
  const syncTabs = (): void => {
    expenseTab.setAttribute('aria-pressed', type === 'expense' ? 'true' : 'false');
    incomeTab.setAttribute('aria-pressed', type === 'credit' ? 'true' : 'false');
    expenseTab.classList.toggle('is-on', type === 'expense');
    incomeTab.classList.toggle('is-on', type === 'credit');
    methodSelect.replaceChildren(...methodOptions(state.settings)
      .filter((method) => (type === 'credit' ? ['AIB', 'Revolut', 'RS'].includes(method.id) : true))
      .map((method) => el('option', { value: method.id }, method.label)));
    if (type === 'credit') methodSelect.value = 'AIB';
  };
  expenseTab.addEventListener('click', () => { type = 'expense'; setUrl(); syncTabs(); });
  incomeTab.addEventListener('click', () => { type = 'credit'; setUrl(); syncTabs(); });

  const submitForm = (): void => {
    const amountText = amountField.value.trim();
    const overPrecise = overPreciseAmount(amountText);
    if (overPrecise) {
      formStatus.textContent = `${overPrecise} has more decimals than euros have cents - round it to two places first.`;
      formStatus.className = 'add-status is-error';
      amountField.setAttribute('aria-invalid', 'true');
      return;
    }
    const amount = parseAmount(amountText);
    if (!Number.isFinite(amount) || amount <= 0) {
      formStatus.textContent = 'Enter an amount greater than zero.';
      formStatus.className = 'add-status is-error';
      amountField.setAttribute('aria-invalid', 'true');
      return;
    }
    amountField.removeAttribute('aria-invalid');
    const details = detailField.value.trim();
    const date = dateField.value || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) {
      formStatus.textContent = 'Pick a date that is not in the future.';
      formStatus.className = 'add-status is-error';
      return;
    }
    const entry: Entry = {
      id: uid(),
      date,
      type,
      category: categorySelect.value || 'misc',
      details: details || 'Entry',
      amount,
      method: methodSelect.value || 'AIB',
      note: noteField.value.trim(),
      createdAt: new Date().toISOString(),
    };
    state.entries.push(entry);
    const ok = save();
    formStatus.textContent = ok
      ? `Added ${String(entry.details)} — €${amount.toFixed(2)}.`
      : 'Could not save on this device.';
    formStatus.className = `add-status${ok ? ' is-ok' : ' is-error'}`;
    detailField.value = '';
    amountField.value = '';
    noteField.value = '';
    detailField.focus();
  };

  const form = el('form', {
    class: 'card add-card add-form',
    onSubmit: (event: Event) => { event.preventDefault(); submitForm(); },
  },
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Details'),
      el('div', { class: 'add-tabs', role: 'group', 'aria-label': 'Entry type' }, expenseTab, incomeTab),
    ),
    el('label', { class: 'add-label', for: 'entry-details' }, 'Description'),
    detailField,
    el('div', { class: 'add-row' },
      el('div', null,
        el('label', { class: 'add-label', for: 'entry-amount' }, 'Amount (€)'),
        amountField,
      ),
      el('div', null,
        el('label', { class: 'add-label', for: 'entry-date' }, 'Date'),
        dateField,
      ),
    ),
    el('div', { class: 'add-row' },
      el('div', null,
        el('label', { class: 'add-label', for: 'entry-category' }, 'Category'),
        categorySelect,
      ),
      el('div', null,
        el('label', { class: 'add-label', for: 'entry-method' }, 'Paid with'),
        methodSelect,
      ),
    ),
    el('label', { class: 'add-label', for: 'entry-note' }, 'Note (optional)'),
    noteField,
    formStatus,
    el('div', { class: 'add-actions' },
      el('button', { type: 'submit', class: 'btn btn-primary' }, 'Add entry'),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        onClick: () => {
          form.hidden = true;
          navigate('add', type === 'credit' ? { type: 'credit' } : {}, { replace: true });
          input.focus({ preventScroll: true });
        },
      }, 'Hide details'),
    ),
  );

  // The form stays in the DOM and is folded with `hidden`: "Edit details" fills
  // it from the parsed line, and a re-render would throw those values away.
  // `more` in the URL therefore writes the fold through `replaceState` only.
  function setFormFromParsed(parsed: ParsedEntry): void {
    detailField.value = String(parsed.details || '');
    amountField.value = parsed.amount ? parsed.amount.toFixed(2) : '';
    dateField.value = String(parsed.date || today());
    categorySelect.value = String(parsed.category || 'misc');
    if (methodOptions(state.settings).some((method) => method.id === parsed.method)) methodSelect.value = String(parsed.method);
    type = parsed.type === 'credit' ? 'credit' : 'expense';
    syncTabs();
  }

  function openMore(): void {
    form.hidden = false;
    const next = new URLSearchParams();
    next.set('more', '1');
    if (type === 'credit') next.set('type', 'credit');
    navigate('add', next, { replace: true });
    detailField.focus({ preventScroll: true });
    form.scrollIntoView({ block: 'nearest' });
  }

  root.append(quickCard, form);
  form.hidden = !showMore;
  syncTabs();
  return root;
}
