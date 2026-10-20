/* History: the ledger, newest first, with the actions that change it.
 *
 * Rows are grouped the way money is spent: the two legs of a transfer are one
 * row, the legs of a mixed payment are one row, and the amounts of a group are
 * summed once. Editing or deleting a grouped row acts on every leg, because
 * half a transfer is not a transaction — it is a balance that lies.
 *
 * Destructive actions apply immediately and offer undo, and the record of what
 * was removed lives in the reload-safe journal (`src/actions.ts`), so an undo
 * that arrives after a refresh still has the rows to put back.
 */
import type { CentsState, Entry } from '../../lib/types.ts';
import { CATEGORIES, METHODS } from '../../lib/seed.ts';
import { uid } from '../../lib/storage.ts';
import { deleteEntries, latestUndo, restoreUndoJournal, trackAction } from '../actions.ts';
import { el } from '../dom.ts';
import { friendlyDate, fmt, parseAmount, today } from '../format.ts';
import { categoryLabel, methodLabel, methodShort } from '../metrics.ts';
import { navigate } from '../router.ts';
import { toast } from '../toast.ts';
import type { ScreenContext } from './context.ts';

// The reload offer is made once per page load: it describes a reload, so
  // repeating it after every re-render would nag about the same action.
let offeredJournal = false;

interface Row {
  key: string;
  entries: Entry[];
  date: string;
  details: string;
  category: string;
  methods: string[];
  amount: number;
  type: string;
  excluded: boolean;
}

/** Transactions as the reader thinks of them: one row per logical payment. */
export function groupEntries(entries: Entry[]): Row[] {
  const rows = new Map<string, Row>();
  for (const entry of entries) {
    if (entry.type === 'note') continue;
    const groupId = entry.transferId || entry.splitId;
    const key = groupId ? `${groupId}` : entry.id;
    const existing = rows.get(key);
    const amount = Number(entry.amount) || 0;
    if (!existing) {
      rows.set(key, {
        key,
        entries: [entry],
        date: String(entry.date || ''),
        details: String(entry.details || 'Entry'),
        category: String(entry.category || 'misc'),
        methods: [String(entry.method || '')],
        amount,
        type: String(entry.type || 'expense'),
        excluded: entry.budgetExcluded === true,
      });
      continue;
    }
    existing.entries.push(entry);
    existing.amount += amount;
    if (!existing.methods.includes(String(entry.method || ''))) existing.methods.push(String(entry.method || ''));
    // A group is one payment: it is an expense if any leg took money out.
    if (entry.type === 'expense') existing.type = 'expense';
    existing.excluded = existing.excluded && entry.budgetExcluded === true;
  }
  // A transfer's two legs are the SAME money: its row shows one leg's amount,
  // not the sum (which read as double the moved amount).
  for (const row of rows.values()) {
    if (row.entries[0].transferId) {
      row.amount = Number(row.entries[0].amount) || 0;
      row.type = 'transfer';
    }
  }
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date)
    || String(b.entries[0].id).localeCompare(String(a.entries[0].id)));
}

function rowAmount(row: Row): string {
  if (row.type === 'transfer') return fmt(row.amount);
  return `${row.type === 'credit' ? '+' : ''}${fmt(row.amount)}`;
}

export function renderHistory({ state, params, save, refresh }: ScreenContext): HTMLElement {
  const root = el('div', { class: 'page-section history-section' });
  const allMonths = [...new Set(state.entries.filter((entry) => entry.type !== 'note')
    .map((entry) => String(entry.date || '').slice(0, 7)))].sort().reverse();
  let month = params.get('month') || '';
  let query = params.get('q') || '';

  const writeUrl = (): void => {
    const next = new URLSearchParams();
    if (month) next.set('month', month);
    if (query.trim()) next.set('q', query.trim());
    navigate('history', next, { replace: true });
  };

  const search = el('input', {
    id: 'history-search',
    class: 'history-search',
    type: 'search',
    autocomplete: 'off',
    placeholder: 'Search the ledger',
    'aria-label': 'Search the ledger',
    value: query,
  }) as HTMLInputElement;

  const monthRow = el('div', { class: 'history-months', role: 'group', 'aria-label': 'Filter by month' });
  const list = el('div', { class: 'history-list' });
  const summary = el('p', { class: 'history-summary muted', role: 'status', 'aria-live': 'polite' });

  const drawMonths = (): void => {
    monthRow.replaceChildren(
      el('button', {
        type: 'button',
        class: `pill history-month${month ? '' : ' is-on'}`,
        'aria-pressed': month ? 'false' : 'true',
        onClick: () => { month = ''; writeUrl(); drawMonths(); drawList(); },
      }, 'All'),
      ...allMonths.map((key) => el('button', {
        type: 'button',
        class: `pill history-month${month === key ? ' is-on' : ''}`,
        'aria-pressed': month === key ? 'true' : 'false',
        onClick: () => { month = month === key ? '' : key; writeUrl(); drawMonths(); drawList(); },
      }, new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${key}-01T00:00:00Z`)))),
    );
  };

  const matches = (row: Row): boolean => {
    if (month && row.date.slice(0, 7) !== month) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystack = [row.details, categoryLabel(state.settings, row.category),
      ...row.methods.map((id) => methodLabel(state.settings, id))]
      .join(' ').toLowerCase();
    return haystack.includes(q);
  };

  /* ── the edit dialog ───────────────────────────────────────────────────── */

  const openEditor = (row: Row): void => {
    const first = row.entries[0];
    const dialog = el('dialog', { class: 'history-dialog', 'aria-label': 'Edit entry' });
    const details = el('input', { class: 'add-input', type: 'text', value: String(first.details || ''), 'aria-label': 'Description' }) as HTMLInputElement;
    const amount = el('input', { class: 'add-input', type: 'text', inputmode: 'decimal', value: (Number(first.amount) || 0).toFixed(2), 'aria-label': 'Amount in euros' }) as HTMLInputElement;
    const date = el('input', { class: 'add-input', type: 'date', value: String(first.date || today()), max: today(), 'aria-label': 'Date' }) as HTMLInputElement;
    const category = el('select', { class: 'add-input', 'aria-label': 'Category' },
      ...CATEGORIES.map((option) => el('option', { value: option.id, selected: option.id === first.category }, option.label)),
    ) as HTMLSelectElement;
    const method = el('select', { class: 'add-input', 'aria-label': 'Payment method' },
      ...METHODS.map((option) => el('option', { value: option.id, selected: option.id === first.method }, option.label)),
    ) as HTMLSelectElement;
    const note = el('input', { class: 'add-input', type: 'text', value: String(first.note || ''), 'aria-label': 'Note' }) as HTMLInputElement;
    const message = el('p', { class: 'add-status', role: 'status' });

    const commit = (): void => {
      const value = parseAmount(amount.value);
      if (!Number.isFinite(value) || value <= 0) {
        message.textContent = 'Enter an amount greater than zero.';
        message.className = 'add-status is-error';
        return;
      }
      if (date.value > today() || !/^\d{4}-\d{2}-\d{2}$/.test(date.value)) {
        message.textContent = 'Pick a date that is not in the future.';
        message.className = 'add-status is-error';
        return;
      }
      // A grouped row keeps its group id, and the typed amount is the GROUP's
      // total: a transfer keeps both legs equal (or it stops being a transfer),
      // a split takes the difference on its first leg.
      const others = row.entries.slice(1).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
      if (row.entries[0].splitId && value - others <= 0) {
        message.textContent = `The other legs already total ${fmt(others)} — the first leg would be zero or less.`;
        message.className = 'add-status is-error';
        return;
      }
      const isTransfer = Boolean(row.entries[0].transferId);
      const isSplit = Boolean(row.entries[0].splitId);
      for (const entry of row.entries) {
        entry.details = details.value.trim() || 'Entry';
        entry.category = category.value;
        entry.date = date.value;
        entry.note = note.value.trim();
        entry.method = method.value;
        entry.updatedAt = new Date().toISOString();
        if (isTransfer) entry.amount = value;
      }
      if (isSplit) row.entries[0].amount = Math.round((value - others) * 100) / 100;
      if (!isTransfer && !isSplit) row.entries[0].amount = value;
      const ok = save();
      toast(ok ? `Updated ${details.value.trim() || 'the entry'}.` : 'Could not save on this device.');
      dialog.close();
      refresh();
    };

    dialog.append(el('form', { class: 'history-dialog-card', onSubmit: (event: Event) => { event.preventDefault(); commit(); } },
      el('div', { class: 'add-card-head' }, el('span', { class: 'eyebrow' }, 'Edit entry')),
      el('label', { class: 'add-label' }, 'Description'), details,
      el('div', { class: 'add-row' },
        el('div', null, el('label', { class: 'add-label' }, 'Amount (€)'), amount),
        el('div', null, el('label', { class: 'add-label' }, 'Date'), date),
      ),
      el('div', { class: 'add-row' },
        el('div', null, el('label', { class: 'add-label' }, 'Category'), category),
        el('div', null, el('label', { class: 'add-label' }, 'Paid with'), method),
      ),
      el('label', { class: 'add-label' }, 'Note'), note,
      message,
      el('div', { class: 'add-actions' },
        el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    details.focus();
  };

  /* ── row actions ───────────────────────────────────────────────────────── */

  const duplicate = (row: Row): void => {
    const nowIso = new Date().toISOString();
    const transferId = row.entries[0].transferId ? uid() : undefined;
    const splitId = row.entries[0].splitId ? uid() : undefined;
    const copies = row.entries.map((entry) => ({
      ...entry,
      id: uid(),
      createdAt: nowIso,
      updatedAt: undefined,
      transferId,
      splitId,
    }));
    state.entries.push(...copies);
    const ok = save();
    toast(ok ? `Duplicated ${row.details}.` : 'Could not save on this device.');
    refresh();
  };

  const toggleExclude = (row: Row): void => {
    const next = !row.excluded;
    for (const entry of row.entries) entry.budgetExcluded = next;
    const ok = save();
    toast(ok ? (next ? `${row.details} excluded from the budget.` : `${row.details} counts toward the budget again.`) : 'Could not save on this device.');
    refresh();
  };

  const remove = (row: Row): void => {
    const ids = row.entries.map((entry) => entry.id);
    // `deleteEntries` writes the journal record itself, so the undo below is
    // the same restore a reload would offer: one path, not two.
    const step = deleteEntries(state, save, ids, `Delete ${row.details}`);
    toast(`Deleted ${row.details}.`, {
      label: 'Undo',
      run: () => {
        step.undo();
        save();
        toast(`Restored ${row.details}.`);
        refresh();
      },
    });
    refresh();
  };

  const drawList = (): void => {
    const rows = groupEntries(state.entries).filter(matches);
    list.replaceChildren();
    // Moving money between your own accounts is neither out nor in.
    const spent = rows.filter((row) => row.type === 'expense').reduce((sum, row) => sum + row.amount, 0);
    const earned = rows.filter((row) => row.type === 'credit').reduce((sum, row) => sum + row.amount, 0);
    summary.textContent = rows.length
      ? `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · ${fmt(spent)} out · ${fmt(earned)} in`
      : 'Nothing matches.';
    if (!rows.length) {
      list.append(el('div', { class: 'card history-empty' },
        el('p', { class: 'muted' }, month || query ? 'No entries match this filter.' : 'No entries yet — add the first one.'),
        el('a', { class: 'btn btn-primary', href: '#add' }, 'Add an entry'),
      ));
      return;
    }
    for (const row of rows) {
      const actions = el('div', { class: 'ledger-actions' },
        el('button', { type: 'button', class: 'btn btn-ghost ledger-action', onClick: () => openEditor(row) }, 'Edit'),
        el('button', { type: 'button', class: 'btn btn-ghost ledger-action', onClick: () => duplicate(row) }, 'Duplicate'),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost ledger-action',
          'aria-pressed': row.excluded ? 'true' : 'false',
          onClick: () => toggleExclude(row),
        }, row.excluded ? 'Include' : 'Exclude'),
        el('button', { type: 'button', class: 'btn btn-ghost ledger-action is-danger', onClick: () => remove(row) }, 'Delete'),
      );
      list.append(el('div', { class: 'ledger-row', dataset: { key: row.key } },
        el('span', { class: 'ledger-date muted' }, friendlyDate(row.date)),
        el('div', { class: 'ledger-what' },
          el('div', { class: 'ledger-detail' }, row.details),
          el('div', { class: 'ledger-meta muted' },
            `${categoryLabel(state.settings, row.category)} · ${row.methods.map((id) => methodShort(state.settings, id)).join(' + ')}`,
            row.entries.length > 1 ? el('span', { class: 'pill ledger-group-pill' }, row.entries[0].transferId ? 'Transfer' : 'Split') : null,
            row.excluded ? el('span', { class: 'pill ledger-group-pill' }, 'Off budget') : null,
          ),
        ),
        el('span', { class: `display-num ledger-amount ${row.type === 'credit' ? 'is-positive' : row.type === 'transfer' ? 'is-transfer' : 'is-negative'}` }, rowAmount(row)),
        actions,
      ));
    }
  };

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = search.value;
      writeUrl();
      drawList();
    }, 200);
  });

  root.append(
    el('div', { class: 'history-tools' },
      search,
      monthRow,
    ),
    summary,
    list,
  );
  drawMonths();
  drawList();

  // A reload loses the in-memory undo stack, so the journal is offered once on
  // arrival when it holds something this document no longer has.
  const journal = offeredJournal ? null : latestUndo(state);
  offeredJournal = true;
  if (journal) {
    toast(`You can undo “${journal.label || 'that change'}” from before your last reload.`, {
      label: 'Undo',
      run: () => {
        restoreUndoJournal(state, save, journal);
        toast(`Restored ${journal.label || 'that change'}.`);
        refresh();
      },
    });
  }

  return root;
}
