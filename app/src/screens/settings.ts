/* Settings: the place the device's own choices live.
 *
 * The shipping app keeps these behind the ☰ menu — appearance, security,
 * payment methods, recurring, profiles and cloud sync. The served shell keeps
 * the same grouping and the same rules, because the rules are the app's, not
 * the menu's.
 *
 * What is here, and why each one is a decision rather than a preference:
 *
 *   · APPEARANCE — light is the default and `cents-theme` is the only key, so
 *     a device that has never chosen reads as light and the choice is per
 *     device rather than per profile.
 *   · PAYMENT METHODS — a method the user removes leaves the pickers, not
 *     their history (see `app/lib/methods.ts` for the three rules).
 *   · RECURRING — the bills and paydays on repeat, with one-tap completion
 *     (see `app/lib/recurring.ts` for the date rules).
 *   · SECURITY — the PIN, the biometric, and the idle lock. The PIN is hashed
 *     with PBKDF2 and a fresh salt, and the credential lives on the device
 *     rather than in the document, so it is never synced.
 *
 * Everything here is class-only: the served app runs under
 * `script-src 'self'; style-src 'self'`, so nothing writes a style attribute,
 * an inline script or a runtime <style> element.
 */
import { el } from '../dom.ts';
import { rehomeToast, toast } from '../toast.ts';
import { currentTheme, onThemeChange, toggleTheme } from '../theme.ts';
import { hasCustomPin, hashPin, registerBiometric, biometricSupported, biometricLabel } from '../lock.ts';
import { setPrivacyPin, clearPrivacyPin } from '../../lib/settings.ts';
import { openMethodManager } from './methods.ts';
import { openRecurringManager } from './recurring.ts';
import type { ScreenContext } from './context.ts';

/** A fresh salt, as a hex string. The PIN's salt is device-local and is
 *  regenerated whenever the PIN is set — a salt that never changes is a salt
 *  that protects nothing against a second guess at the same hash. */
function freshSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function row(label: string, note: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'settings-row' },
    el('div', { class: 'settings-row-text' },
      el('div', { class: 'settings-row-label' }, label),
      el('div', { class: 'settings-row-note muted' }, note),
    ),
    control,
  );
}

export function openSettings(ctx: ScreenContext): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'settings-sheet' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card settings-sheet' });

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

  /* ── appearance ─────────────────────────────────────────────────────────── */

  const themeButton = el('button', { type: 'button', class: 'btn btn-ghost' });
  const paintTheme = (): void => {
    const dark = currentTheme() === 'dark';
    themeButton.textContent = dark ? 'Use light' : 'Use dark';
    themeButton.setAttribute('aria-label', dark ? 'Use the light theme' : 'Use the dark theme');
  };
  // One handler, one flip. The vendored kit's own switch-mode is NOT mounted
  // on this button: two handlers on one control would each read the theme and
  // flip it back, and the button would do nothing. The header's own toggle is
  // a second VIEW of the same fact, so both repaint through one subscription.
  themeButton.addEventListener('click', () => { toggleTheme(); });
  onThemeChange(paintTheme);
  paintTheme();

  /* ── security ───────────────────────────────────────────────────────────── */

  const pinInput = el('input', {
    type: 'text', class: 'add-input', inputmode: 'numeric', autocomplete: 'off',
    'aria-label': 'New PIN', maxlength: '12',
  }) as HTMLInputElement;
  const pinStatus = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const setPin = async (): Promise<void> => {
    const value = pinInput.value.trim();
    if (!/^\d{4,12}$/.test(value)) {
      pinStatus.textContent = 'A PIN is four to twelve digits.';
      pinStatus.className = 'add-status is-error';
      return;
    }
    const salt = freshSalt();
    setPrivacyPin(await hashPin(value, salt), salt, 'pbkdf2');
    pinStatus.textContent = 'PIN changed. It applies the next time you lock.';
    pinStatus.className = 'add-status';
    pinInput.value = '';
    toast('PIN changed.');
  };

  const resetPin = (): void => {
    clearPrivacyPin();
    pinStatus.textContent = 'The PIN is back to the default.';
    pinStatus.className = 'add-status';
    toast('PIN reset to the default.');
  };

  const bioButton = el('button', { type: 'button', class: 'btn btn-ghost' });
  biometricSupported().then((supported) => {
    if (!supported) {
      bioButton.textContent = 'Not available';
      bioButton.setAttribute('disabled', '');
      return;
    }
    bioButton.textContent = `Use ${biometricLabel()}`;
    bioButton.addEventListener('click', async () => {
      const result = await registerBiometric();
      toast(result.ok ? `${biometricLabel()} registered.` : (result.reason || 'Could not register that.'));
    });
  });

  const securityCard = el('div', { class: 'card settings-card' },
    el('div', { class: 'eyebrow' }, 'Security'),
    row('PIN', hasCustomPin(ctx.state) ? 'A PIN of your own is set on this device.' : 'Still the default PIN.', el('div', { class: 'settings-actions' },
      pinInput,
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => { void setPin(); } }, 'Set PIN'),
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: resetPin }, 'Reset PIN'),
    )),
    pinStatus,
    row('Unlock with a fingerprint or Face ID', 'Stored on this device only, and never synced.', bioButton),
  );

  /* ── the sheet ──────────────────────────────────────────────────────────── */

  card.append(
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Settings'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close settings', onClick: close }, 'Close'),
    ),
    el('div', { class: 'card settings-card' },
      el('div', { class: 'eyebrow' }, 'Appearance'),
      row('Theme', 'Light is the default. The choice is remembered on this device.', themeButton),
    ),
    el('div', { class: 'card settings-card' },
      el('div', { class: 'eyebrow' }, 'Money'),
      row('Payment methods', 'Add one, or take one out of the pickers.', el('button', {
        type: 'button', class: 'btn btn-ghost',
        onClick: () => openMethodManager(ctx),
      }, 'Manage')),
      row('Recurring', 'The bills and paydays on repeat.', el('button', {
        type: 'button', class: 'btn btn-ghost',
        onClick: () => openRecurringManager(ctx),
      }, 'Manage')),
    ),
    securityCard,
  );

  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}
