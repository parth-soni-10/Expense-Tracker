/* The appearance setting: light by default, dark when the device has chosen it.
 *
 * Two rules, and they are the whole contract:
 *
 *   1. `cents-theme` is the ONLY key. It holds `dark` or `light`, and light is
 *      the absence of a choice as much as a choice — a document that has never
 *      been touched reads as light, so a first visit paints light.
 *   2. `data-theme` is the ONLY attribute, and it is written `dark` or not at
 *      all. The stylesheet's `:root` is the light palette and
 *      `[data-theme="dark"]` overrides it, so the attribute is only written
 *      for a device that has chosen dark.
 *
 * The key lives in `app/lib/settings.ts` with the other device settings (the
 * sync settings, the PIN, the biometric), because `lib/` owns storage and
 * `src/` owns the DOM. The choice is per device, not per profile: it is not
 * part of the document, so it is not synced and not part of any profile's data.
 *
 * `app/theme-init.js` reads the same key before the stylesheets and the bundle
 * run, so a device that has chosen dark never flashes light on the way in.
 * That script only READS: this module is the only thing in the shell that
 * writes the key, which is what keeps "one click flips once" true — a second
 * handler on the same button would flip it back.
 */
import { getTheme, setTheme } from '../lib/settings.ts';

export type Theme = 'light' | 'dark';

/** Anything that shows the theme has to be able to redraw when it changes.
 *  The header toggle and the Settings sheet are two views of one fact, and a
 *  toggle that left the other one showing the old answer would be a lie. */
const listeners = new Set<() => void>();

export function onThemeChange(listener: () => void): void {
  listeners.add(listener);
}

export function currentTheme(): Theme {
  return getTheme();
}

/** Write the theme: the key, the attribute, and the browser chrome. */
export function applyTheme(theme: Theme): void {
  const target: Theme = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  if (target === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  setTheme(target);
  syncChrome(target);
  for (const listener of listeners) {
    try { listener(); } catch { /* one bad view must not stop the others */ }
  }
}

/** Flip the theme and answer with the one now in effect. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** The browser chrome follows the theme: the scheme and the theme colour. */
function syncChrome(theme: Theme): void {
  const dark = theme === 'dark';
  const scheme = document.querySelector('meta[name="color-scheme"]');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (scheme) scheme.setAttribute('content', dark ? 'dark' : 'light');
  if (themeMeta) themeMeta.setAttribute('content', dark ? '#101210' : '#F5F5F2');
}
