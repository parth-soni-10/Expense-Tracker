/* The payment-method manager: the methods the user owns.
 *
 * Ported from `openMethodManager()` in the shipping app's app.js, and kept to
 * the same three rules, because the obvious implementation eats the ledger:
 *
 *   1. A method out of the pickers STAYS a valid id. `validateEntry` drops an
 *      entry whose method the storage layer does not know, so a removal that
 *      really removed the id would delete that entry's history at the next
 *      load — a deletion that never appears as one. The removal is a tombstone
 *      (`settings.methodHidden`), never a removal from `customMethods`, and
 *      never a removal from the allowed set.
 *   2. `false` is a value, not an absent key. The settings merge is a per-key
 *      spread, which can overwrite a key but never delete one — so a restore
 *      written as a deletion would lose to the other device's `true` on every
 *      sync, and the method would come back hidden on its own, forever.
 *   3. A picker showing an existing record keeps that record's method visible
 *      even when it is hidden, or editing the record would silently move it to
 *      another account.
 *
 * The rules themselves live in `app/lib/methods.ts` so they can be tested in
 * Node; this file is the surface, and it changes nothing the rules do not
 * already say. The usage count is what lets the manager say what a removal
 * actually touches: the records keep the method, only the pickers lose it.
 */
import { el } from '../dom.ts';
import { rehomeToast, toast } from '../toast.ts';
import { trackAction } from '../actions.ts';
import { addCustomMethod, everyMethod, methodUsage, setMethodHidden } from '../../lib/methods.ts';
import { updateAllowedMethods } from '../../lib/storage.ts';
import type { ScreenContext } from './context.ts';

function usageText(count: number): string {
  if (count === 0) return 'not used yet';
  return `used by ${count} record${count === 1 ? '' : 's'}`;
}

export function openMethodManager(ctx: ScreenContext): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'method-manager' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card method-manager' });

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

  const list = el('div', { class: 'method-list' });
  const addError = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });
  const nameInput = el('input', {
    type: 'text',
    class: 'add-input',
    placeholder: 'e.g. Credit Union, Apple Pay',
    'aria-label': 'New method name',
    autocomplete: 'off',
    maxlength: '40',
  }) as HTMLInputElement;

  const draw = (): void => {
    list.replaceChildren();
    const usage = methodUsage(ctx.state);
    const catalogue = everyMethod(ctx.state.settings);
    const shown = catalogue.filter((method) => !method.hidden);
    const hidden = catalogue.filter((method) => method.hidden);

    const rowFor = (method: (typeof catalogue)[number]): HTMLElement => {
      const count = usage.get(method.id) || 0;
      const verb = method.hidden ? 'Restore' : (method.builtin ? 'Hide' : 'Delete');
      return el('div', { class: `method-row${method.hidden ? ' is-hidden' : ''}` },
        el('div', { class: 'method-row-text' },
          el('div', { class: 'method-row-label' }, method.label),
          el('div', { class: 'method-row-meta muted' },
            `${method.builtin ? 'Built-in' : 'Your own'} · ${usageText(count)}`),
        ),
        el('button', {
          type: 'button',
          class: 'btn-link method-row-action',
          'aria-label': `${verb} ${method.label}`,
          onClick: () => {
            const before = { ...(ctx.state.settings.methodHidden || {}) };
            const result = setMethodHidden(ctx.state.settings, method.id, !method.hidden);
            if (result.ok === false) {
              toast(result.error);
              return;
            }
            // A method out of the pickers is still a VALID id, so the allowed
            // set does not change — but a stale id in it is the one way the
            // storage layer could accept something it should not.
            const resync = (): void => {
              updateAllowedMethods(everyMethod(ctx.state.settings).map((m) => m.id));
              ctx.save();
            };
            resync();
            const step = trackAction(ctx.save, {
              label: method.hidden ? `Restored method "${method.label}"` : `Removed method "${method.label}"`,
              undo: () => {
                ctx.state.settings.methodHidden = before;
                resync();
              },
            });
            toast(method.hidden
              ? `Restored "${method.label}".`
              : (count === 0
                ? `Deleted "${method.label}".`
                : `Removed "${method.label}" from the pickers — ${count} record${count === 1 ? '' : 's'} still name it.`),
            { label: 'Undo', run: () => { step.undo(); draw(); } });
            draw();
          },
        }, verb),
      );
    };

    for (const method of shown) list.append(rowFor(method));
    if (hidden.length) {
      list.append(el('div', { class: 'eyebrow method-group' }, 'Removed from the pickers'));
      for (const method of hidden) list.append(rowFor(method));
    }
    if (!catalogue.length) list.append(el('p', { class: 'muted' }, 'No payment methods yet.'));
  };

  const add = (): void => {
    const result = addCustomMethod(ctx.state.settings, nameInput.value);
    if (result.ok === false) {
      addError.textContent = result.error;
      nameInput.focus();
      return;
    }
    addError.textContent = '';
    updateAllowedMethods(everyMethod(ctx.state.settings).map((m) => m.id));
    ctx.save();
    nameInput.value = '';
    toast(`Added method "${result.method.label}".`);
    draw();
  };

  nameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });

  card.append(
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Payment methods'),
      el('button', {
        type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close payment methods',
        onClick: close,
      }, 'Close'),
    ),
    el('p', { class: 'muted method-lead' },
      'A method you remove leaves the pickers, not your history: the records that name it keep naming it.'),
    list,
    el('div', { class: 'add-row method-add' },
      nameInput,
      el('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Add method'),
    ),
    addError,
  );

  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
  draw();
}
