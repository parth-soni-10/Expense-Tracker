/* Import a bank's own CSV: pick the file, check the mapping, see what it will
 * write, then commit.
 *
 * The parsing, the guess and the row rules are lib/bank-import.ts's — a file
 * shape is mapped once, and that module's `parseBankCsv` / `suggestBankMapping`
 * / `buildBankEntries` were already pure and already checked by hand. What this
 * file owns is only the surface: a dialog that lets the guess be corrected
 * before anything is written, because a wrong mapping is an import that files
 * every row as the wrong account and looks like a success.
 *
 * Class-only markup: the shipped module built this screen with inline styles,
 * which `style-src 'self'` refuses. The layout it carried is in
 * `styles/screens.css` under `.bank-*`.
 */
import { el, clear } from '../dom.ts';
import { toast } from '../toast.ts';
import { fmt, friendlyDate } from '../format.ts';
import type { CentsState } from '../../lib/types.ts';
import { uid } from '../../lib/storage.ts';
import {
  BANK_REFUSAL,
  bankImportSummary,
  buildBankEntries,
  parseBankCsv,
  suggestBankMapping,
} from '../../lib/bank-import.ts';
import { applyRestore, planRestore } from '../data-report.ts';
import { everyMethod } from '../metrics.ts';
import type { ScreenContext } from './context.ts';

/** The same keyword rules the shipping app files an imported row under — one
 *  copy, in app.js there and here, because a second copy is a second answer to
 *  "what is a Tesco shop". */
function categoryFromDescription(description: string): string {
  const value = String(description || '').toLowerCase();
  if (/gift.?card|voucher/i.test(value)) return 'GC';
  if (/grocer|tesco|lidl|aldi|supervalu|dunnes|spar|centra|m&s|marks|supermarket|shop|market/i.test(value)) return 'gro';
  if (/bus|train|luas|dart|leap|taxi|uber|petrol|diesel|fuel|parking|toll|flight|ferry/i.test(value)) return 'travel';
  if (/rent|lease|mortgage|deposit|landlord/i.test(value)) return 'rent';
  return 'misc';
}

export function openBankStatement(ctx: ScreenContext): void {
  const { state, save, refresh } = ctx;
  const dialog = el('dialog', { class: 'data-dialog bank-dialog', 'aria-label': 'Import bank statement' }) as HTMLDialogElement;
  const body = el('div');
  const message = el('p', { class: 'data-message', role: 'status', 'aria-live': 'polite' });
  let parsed: { columns: string[]; rows: string[][] } | null = null;
  let mapping: Record<string, number> | null = null;
  let account = (everyMethod(state.settings || {})[0] || { id: 'AIB' }).id;
  let fileName = '';

  const close = () => {
    dialog.close();
    dialog.remove();
  };

  dialog.append(el('div', { class: 'data-card' },
    el('div', { class: 'data-head' },
      el('h2', { class: 'data-title serif' }, 'Import bank statement'),
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Close'),
    ),
    message,
    body,
  ));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);

  const subtitle = (text: string) => el('p', { class: 'data-lead muted' }, text);

  const select = (label: string, value: number, onPick: (index: number) => void, noneLabel: string) => {
    const field = el('select', { class: 'data-select', 'aria-label': label });
    field.append(el('option', { value: '-1' }, noneLabel));
    (parsed?.columns || []).forEach((name, index) => field.append(el('option', { value: String(index) }, name)));
    field.value = String(value);
    field.addEventListener('change', () => { onPick(Number(field.value)); drawMapping(); });
    return el('label', { class: 'data-field' },
      el('span', { class: 'data-field-label' }, label),
      field,
    );
  };

  const build = () => {
    if (!parsed || !mapping || mapping.date < 0) return null;
    if (mapping.amount < 0 && mapping.debit < 0 && mapping.credit < 0) return null;
    return buildBankEntries({
      rows: parsed.rows,
      mapping,
      method: account,
      guessCategory: categoryFromDescription,
      decorate: (entry: any) => ({ ...entry, id: uid(), createdAt: new Date().toISOString() }),
      existing: state.entries,
    });
  };

  function drawPreview(host: HTMLElement): void {
    clear(host);
    const result = build();
    if (!result) {
      host.append(el('p', { class: 'data-message' },
        BANK_REFUSAL[mapping && mapping.date < 0 ? 'no-date' : 'no-amount']));
      return;
    }
    const summary = bankImportSummary(result);
    host.append(el('p', { class: 'data-preview-head' },
      result.entries.length
        ? `${result.entries.length} transaction${result.entries.length === 1 ? '' : 's'} ready`
        : 'Nothing to import with this mapping',
    ));
    if (summary) host.append(el('p', { class: 'data-message muted' }, summary));
    for (const entry of result.entries.slice(0, 5)) {
      host.append(el('div', { class: 'bank-row' },
        el('span', { class: 'bank-date muted' }, friendlyDate(entry.date)),
        el('span', { class: 'bank-detail' }, entry.details),
        el('span', { class: `bank-amount display-num ${entry.type === 'credit' ? 'is-positive' : 'is-negative'}` },
          `${entry.type === 'credit' ? '+' : '-'}${fmt(entry.amount)}`),
      ));
    }
    host.append(el('div', { class: 'add-actions' },
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        'aria-disabled': result.entries.length ? null : 'true',
        onClick: () => { if (result.entries.length) commit(result.entries); },
      }, `Import ${result.entries.length || ''}`.trim()),
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: drawPick }, 'Choose another file'),
    ));
  }

  function commit(entries: any[]): void {
    const plan = planRestore(state, { entries } as Partial<CentsState>);
    if (!plan.changed) {
      message.textContent = 'Nothing to import: those transactions are already in your ledger.';
      return;
    }
    const before = JSON.parse(JSON.stringify(state)) as CentsState;
    applyRestore(state, plan, null);
    if (!save()) {
      for (const key of Object.keys(before) as (keyof CentsState)[]) (state as any)[key] = before[key];
      message.textContent = 'Could not save on this device. Nothing was imported.';
      return;
    }
    close();
    refresh();
    toast(`Imported ${entries.length} transaction${entries.length === 1 ? '' : 's'}.`, {
      label: 'Undo',
      run: () => {
        for (const key of Object.keys(before) as (keyof CentsState)[]) (state as any)[key] = before[key];
        save();
        refresh();
        toast('Import undone.');
      },
    }, 8000);
  }

  function drawMapping(): void {
    if (!parsed || !mapping) return;
    const pair = mapping.debit >= 0 || mapping.credit >= 0;
    const preview = el('div', { class: 'bank-preview' });
    const retype = (toPair: boolean) => {
      const guess = suggestBankMapping(parsed!.columns, parsed!.rows);
      if (toPair) {
        mapping!.debit = guess.debit;
        mapping!.credit = guess.credit;
        mapping!.amount = -1;
      } else {
        mapping!.amount = guess.amount;
        mapping!.debit = -1;
        mapping!.credit = -1;
      }
      drawMapping();
    };
    const mode = (label: string, active: boolean, run: () => void) => el('button', {
      type: 'button',
      class: 'pill',
      'aria-pressed': active ? 'true' : 'false',
      onClick: run,
    }, label);
    const accountField = el('select', { class: 'data-select', 'aria-label': 'Account these transactions belong to' });
    for (const method of everyMethod(state.settings || {})) accountField.append(el('option', { value: method.id }, method.label || method.id));
    accountField.value = account;
    accountField.addEventListener('change', () => { account = accountField.value; drawMapping(); });

    const fields = el('div', { class: 'bank-fields' },
      select('Date column', mapping.date, (index) => { mapping!.date = index; }, '— choose —'),
      select('Description column', mapping.description, (index) => { mapping!.description = index; }, '— none —'),
      pair
        ? el('div', { class: 'bank-pair' },
          select('Debit column', mapping.debit, (index) => { mapping!.debit = index; }, '— none —'),
          select('Credit column', mapping.credit, (index) => { mapping!.credit = index; }, '— none —'),
        )
        : select('Amount column', mapping.amount, (index) => { mapping!.amount = index; }, '— choose —'),
      el('label', { class: 'data-field' }, el('span', { class: 'data-field-label' }, 'Account'), accountField),
    );

    clear(body);
    body.append(
      subtitle(`${fileName} · nothing is written until you press Import.`),
      el('div', { class: 'bank-modes' },
        el('span', { class: 'eyebrow' }, 'Amounts'),
        mode('One signed column', !pair, () => retype(false)),
        mode('Debit and credit', pair, () => retype(true)),
      ),
      fields,
      preview,
    );
    drawPreview(preview);
  }

  async function loadFile(file: File): Promise<void> {
    if (file.size > 32 * 1024 * 1024) {
      message.textContent = BANK_REFUSAL['too-large'];
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      message.textContent = BANK_REFUSAL.unreadable;
      return;
    }
    const verdict = parseBankCsv(text);
    if (!verdict.ok) {
      message.textContent = BANK_REFUSAL[verdict.reason] || BANK_REFUSAL.unreadable;
      return;
    }
    parsed = { columns: verdict.columns, rows: verdict.rows };
    fileName = file.name || 'that file';
    mapping = suggestBankMapping(parsed.columns, parsed.rows);
    message.textContent = '';
    drawMapping();
  }

  function drawPick(): void {
    message.textContent = '';
    clear(body);
    const input = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'data-file', 'aria-label': 'Choose a bank statement CSV' });
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) void loadFile(file);
    });
    body.append(
      el('p', { class: 'data-lead muted' }, 'Export a CSV from your bank (AIB, Revolut, anything with a date, a description and an amount), then choose it here. You will see which column means what before anything is added.'),
      el('div', { class: 'add-actions' },
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          onClick: () => { document.body.append(input); input.click(); },
        }, 'Choose CSV file'),
      ),
    );
  }

  drawPick();
  dialog.showModal();
}
