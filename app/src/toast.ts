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
  document.body.append(card);
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
