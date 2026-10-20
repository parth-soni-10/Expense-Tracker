/* The one toast: a status line with at most one action.
 *
 * The shipping app pairs every destructive change with an undo offer, and the
 * reload-safe journal means the offer is genuine even if the reply comes after
 * a refresh. Class-only and in the top layer of the document, so a screen
 * re-render cannot take the offer away with it.
 */
import { el } from './dom.ts';

let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface ToastAction {
  label: string;
  run: () => void;
}

/** Where the toast lives.
 *
 *  A modal sheet is in the browser's TOP LAYER, and the top layer always
 *  paints above the normal flow — so a toast in the body sits UNDER an open
 *  sheet, and a `z-index` cannot reach it. A toast offering an Undo that the
 *  user cannot click is a promise the app does not keep. So the toast is
 *  hosted by the topmost open sheet when there is one, and by the body
 *  otherwise. */
function toastHost(): HTMLElement {
  const open = Array.from(document.querySelectorAll('dialog[open]'));
  return open.length ? (open[open.length - 1] as HTMLElement) : document.body;
}

/** Move the toast back to the body when the sheet that hosted it closes. The
 *  offer outlives the sheet: dismissing a sheet should not take the undo with
 *  it. */
export function rehomeToast(): void {
  if (!current) return;
  const parent = current.parentElement;
  if (parent && parent !== document.body && parent.tagName === 'DIALOG') {
    document.body.append(current);
  }
}

export function toast(message: string, action?: ToastAction, ms = 6000): void {
  dismissToast();
  const line = el('span', { class: 'app-toast-message' }, message);
  const card = el('div', { class: 'app-toast', role: 'status', 'aria-live': 'polite' }, line);
  if (action) {
    card.append(el('button', {
      type: 'button',
      class: 'btn btn-ghost app-toast-action',
      onClick: () => {
        dismissToast();
        action.run();
      },
    }, action.label));
  }
  card.append(el('button', {
    type: 'button',
    class: 'app-toast-close',
    'aria-label': 'Dismiss',
    onClick: () => dismissToast(),
  }, '×'));
  toastHost().append(card);
  current = card;
  timer = setTimeout(dismissToast, ms);
}

export function dismissToast(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (current) {
    current.remove();
    current = null;
  }
}
