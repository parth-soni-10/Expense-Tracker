/* Balances: what each tracked account holds, and how to reconcile it.
 *
 * A checkpoint records the real balance on a date without rewriting a single
 * transaction — which is why it is the only safe way to correct the ledger.
 * The row states the current end-of-day figure, the book figure it disagrees
 * with, and the difference, so "why is this number what it is" is answerable
 * before a second reconciliation is saved.
 *
 * Removing a checkpoint is undoable and journalled (the reload-safe record holds
 * the point itself), so a mis-tap on an old reconciliation is recoverable.
 */
import type { CentsState } from '../../lib/types.ts';
import { accountStatus, removeCheckpoint, saveCheckpoint } from '../checkpoints.ts';
import { trackAction } from '../actions.ts';
import { el } from '../dom.ts';
import { fmt, parseAmount, today } from '../format.ts';
import {
  BALANCE_METHOD_IDS,
  GIFT_CARD_IDS,
  balanceAtForEntries,
  bookBalanceAt,
  cashBalance,
  checkpointsFor,
  computeGiftCardBalance,
  methodLabel,
} from '../metrics.ts';
import { toast } from '../toast.ts';
import type { ScreenContext } from './context.ts';

export function renderBalances({ state, save, refresh }: ScreenContext): HTMLElement {
  const root = el('div', { class: 'page-section balances-section' });
  const settings = state.settings || {};
  const label = (id: string): string => methodLabel(settings, id);
  const summary = el('p', { class: 'balances-summary muted', role: 'status', 'aria-live': 'polite' });

  const total = BALANCE_METHOD_IDS.reduce((sum, id) => sum + balanceAtForEntries(
    state.entries, id, today(), checkpointsFor(settings),
  ), 0);

  const draw = (): void => {
    summary.textContent = `${fmt(total)} across ${BALANCE_METHOD_IDS.length} tracked balances · cash ${fmt(cashBalance(settings, state.entries))}`;
  };

  /** One account row with its editor folded away until asked for. */
  const accountRow = (methodId: string): HTMLElement => {
    const checkpoints = checkpointsFor(settings);
    const name = label(methodId);
    const balance = balanceAtForEntries(state.entries, methodId, today(), checkpoints);
    const status = accountStatus(state, methodId);
    const percent = Math.round((percentOfTotal(balance, total)) * 100);

    const dateInput = el('input', {
      type: 'date', class: 'checkpoint-input', value: today(), max: today(),
      'aria-label': `${name} balance date`,
    }) as HTMLInputElement;
    const amountInput = el('input', {
      type: 'text', inputmode: 'decimal', class: 'checkpoint-input',
      value: balance.toFixed(2),
      'aria-label': `${name} actual balance`,
    }) as HTMLInputElement;
    const message = el('span', { class: 'checkpoint-message muted', role: 'status' });

    const editor = el('div', { class: 'checkpoint-editor', hidden: true },
      el('label', { class: 'add-label' }, 'Actual balance on'),
      el('div', { class: 'checkpoint-editor-row' }, dateInput, amountInput),
      message,
      el('div', { class: 'add-actions' },
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          onClick: () => {
            const value = parseAmount(amountInput.value);
            if (!Number.isFinite(value)) {
              message.textContent = 'Enter a number, for example 1200.50.';
              message.className = 'checkpoint-message is-error';
              return;
            }
            if (!saveCheckpoint(state, methodId, dateInput.value || today(), value)) {
              message.textContent = 'Pick a date that is not in the future.';
              message.className = 'checkpoint-message is-error';
              return;
            }
            const ok = save();
            toast(ok ? `${name} reconciled to ${fmt(value)}.` : 'Could not save on this device.');
            refresh();
          },
        }, 'Save balance'),
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { editor.hidden = true; } }, 'Cancel'),
      ),
      el('p', { class: 'checkpoint-hint muted' }, status.hint),
    );

    const latest = (() => {
      const points = (checkpoints[methodId] || []).filter((point) => point.date !== '1970-01-01');
      return points.at(-1) || null;
    })();
    const book = latest ? bookBalanceAt(state.entries, methodId, latest.date, checkpoints) : null;
    const difference = latest && book !== null ? latest.balance - book : null;

    const row = el('div', { class: 'checkpoint-row' },
      el('div', { class: 'checkpoint-what' },
        el('div', { class: 'checkpoint-name' }, name),
        el('div', { class: 'checkpoint-meta muted' },
          status.label,
          latest ? ` · last saved ${latest.date}` : '',
          latest && difference !== null && Math.abs(difference) >= 0.01
            ? ` · book ${fmt(book || 0)} (${difference > 0 ? '+' : ''}${fmt(difference)})`
            : '',
        ),
      ),
      el('div', { class: 'checkpoint-figures' },
        el('div', { class: `display-num checkpoint-amount ${balance >= 0 ? 'is-positive' : 'is-negative'}` }, fmt(balance)),
        el('div', { class: 'checkpoint-share muted' }, `${percent}% of tracked`),
      ),
      el('div', { class: 'checkpoint-actions' },
        el('button', {
          type: 'button',
          class: 'btn btn-ghost checkpoint-action',
          'aria-expanded': 'false',
          onClick: (event: Event) => {
            editor.hidden = !editor.hidden;
            (event.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!editor.hidden));
            if (!editor.hidden) amountInput.focus();
          },
        }, 'Reconcile'),
        latest ? el('button', {
          type: 'button',
          class: 'btn btn-ghost checkpoint-action is-danger',
          onClick: () => {
            const removed = removeCheckpoint(state, methodId, latest.date);
            if (!removed) return;
            trackAction(save, {
              label: `Remove ${name} balance for ${latest.date}`,
              undo: () => {
                const points = ((state.settings as any).balanceCheckpoints || {})[methodId] || [];
                (state.settings as any).balanceCheckpoints[methodId] = [...points, removed].sort((a: any, b: any) => a.date.localeCompare(b.date));
              },
              checkpoints: [{ methodId, point: removed }],
            });
            toast(`Removed the ${latest.date} balance for ${name}.`, {
              label: 'Undo',
              run: () => {
                const points = ((state.settings as any).balanceCheckpoints || {})[methodId] || [];
                (state.settings as any).balanceCheckpoints[methodId] = [...points, removed].sort((a: any, b: any) => a.date.localeCompare(b.date));
                save();
                refresh();
              },
            });
            refresh();
          },
        }, 'Undo save') : null,
      ),
      editor,
    );
    return row;
  };

  const percentOfTotal = (value: number, totalValue: number): number => {
    if (!totalValue) return 0;
    return Math.max(0, Math.min(1, value / totalValue));
  };

  const accounts = el('div', { class: 'card balances-card' },
    el('div', { class: 'row between balances-head' },
      el('div', null,
        el('div', { class: 'eyebrow' }, 'Accounts'),
        el('div', { class: 'muted balances-sub' }, 'End-of-day balances; transaction history stays unchanged.'),
      ),
    ),
    el('div', { class: 'balance-list' }, ...BALANCE_METHOD_IDS.map(accountRow)),
  );

  const giftRows = GIFT_CARD_IDS.map((id) => {
    const used = state.entries.some((entry) => entry.method === id)
      || (((settings as any).balanceCheckpoints || {})[id] || []).length > 0;
    if (!used) return null;
    const totals = computeGiftCardBalance(settings, state.entries, id);
    return el('div', { class: 'checkpoint-row checkpoint-row-gift' },
      el('div', { class: 'checkpoint-what' },
        el('div', { class: 'checkpoint-name' }, label(id)),
        el('div', { class: 'checkpoint-meta muted' },
          `loads ${fmt(totals.loaded)} · spending ${fmt(totals.spent)}`),
      ),
      el('div', { class: 'checkpoint-figures' },
        el('div', { class: `display-num checkpoint-amount ${totals.balance >= 0 ? 'is-positive' : 'is-negative'}` }, fmt(totals.balance)),
      ),
    );
  }).filter(Boolean) as HTMLElement[];

  root.append(summary, accounts);
  if (giftRows.length) {
    root.append(el('div', { class: 'card balances-card' },
      el('div', { class: 'row between balances-head' },
        el('div', null,
          el('div', { class: 'eyebrow' }, 'Gift cards'),
          el('div', { class: 'muted balances-sub' }, 'Loads are what went on the card; spending is what came off it.'),
        ),
      ),
      el('div', { class: 'balance-list' }, ...giftRows),
    ));
  }
  draw();
  return root;
}
