/* The Cents app shell: boot, the privacy gate, the router and the service
 * worker notice.
 *
 * This is the first slice of the served `app/` shell (docs/CATCHUP_PLAN.md batch
 * 21). It owns everything that must exist before a screen can: the document's
 * loaded state, the profile gate, the PIN lock, the hash route contract and the
 * update prompt. Screens mount into `#screen` in the slices that follow, so the
 * shell deliberately renders no ledger content of its own.
 *
 * Class-only: the served app runs under `script-src 'self'; style-src 'self'`,
 * so nothing here writes a style attribute, an inline script or a runtime
 * <style> element.
 */
import { loadState, saveState, takeStorageNotice } from '../lib/storage.ts';
import { TABS } from '../lib/seed.ts';
import { getActiveProfileId, hasSessionChoice, listProfiles, setActiveProfileId } from '../lib/profiles.ts';
import { readRoute, subscribe, routeHash, type Route, type RouteId } from './router.ts';
import { showPinLock, showProfilePicker } from './lock.ts';
import { byId, clear, el } from './dom.ts';
import { currentTheme, onThemeChange, toggleTheme } from './theme.ts';
import { renderAdd } from './screens/add.ts';
import { openDataSheet } from './screens/data.ts';
import { openSettings } from './screens/settings.ts';
import { renderBalances } from './screens/balances.ts';
import { renderDashboard } from './screens/dashboard.ts';
import { renderHistory } from './screens/history.ts';
import { renderInsights } from './screens/insights.ts';
import { renderTesco } from './screens/tesco.ts';

declare global {
  interface Window {
    __cents?: { route: () => Route; shell: string };
  }
}

const LABELS: Record<RouteId, string> = {
  dashboard: 'Dashboard',
  add: 'Add',
  history: 'History',
  balances: 'Balances',
  tesco: 'Tesco Pay',
  insights: 'Insights',
};

const state = loadState();
const app = byId('app');
const screen = byId('screen');
const nav = byId('app-nav');

/** Tabs this profile may open. A document written before the setting existed
 *  simply shows every tab, and the dashboard is never hidden. */
function enabledTabs(): string[] {
  const raw = (state as any)?.settings?.enabledTabs;
  if (!Array.isArray(raw) || !raw.length) return [...TABS];
  return TABS.filter((id) => id === 'dashboard' || raw.includes(id));
}

function buildNav(active: RouteId): void {
  if (!nav) return;
  clear(nav);
  for (const id of enabledTabs()) {
    nav.append(el('a', {
      class: `app-tab${id === active ? ' is-current' : ''}`,
      href: routeHash(id as RouteId),
      'aria-current': id === active ? 'page' : null,
    }, LABELS[id as RouteId]));
  }
  // Data is not a route: it is the place you go to move your data, and the
  // shipping app has always kept it out of the tabs (docs/URL_CONTRACT.md has
  // no `#data`). It sits after them, so the nav still reads as the app.
  nav.append(el('button', {
    type: 'button',
    class: 'app-tab app-data-trigger',
    'aria-haspopup': 'dialog',
    onClick: () => openDataSheet({
      state,
      params: new URLSearchParams(),
      save: () => saveState(state),
      refresh: () => render(readRoute(), { moveFocus: false }),
    }),
  }, 'Data'));
  // Settings is the same shape: a place you go to change the device, not a
  // place the app lives. The appearance toggle, the payment methods, the
  // recurring schedules and the PIN all live behind it.
  nav.append(el('button', {
    type: 'button',
    class: 'app-tab app-settings-trigger',
    'aria-haspopup': 'dialog',
    onClick: () => openSettings({
      state,
      params: new URLSearchParams(),
      save: () => saveState(state),
      refresh: () => render(readRoute(), { moveFocus: false }),
    }),
  }, 'Settings'));
}

function render(route: Route, { moveFocus = true } = {}): void {
  if (!screen) return;
  buildNav(route.id);
  clear(screen);
  const heading = el('h1', { class: 'app-title', tabindex: '-1' }, LABELS[route.id]);
  screen.append(heading);

  const notice = takeStorageNotice();
  if (notice) screen.append(el('p', { class: 'app-notice', role: 'status' }, notice));

  const params = route.params.toString();
  if (params) screen.append(el('p', { class: 'app-params muted' }, `${LABELS[route.id]} · ${params}`));

  // Screens land one slice at a time (docs/CATCHUP_PLAN.md batch 21). Every
  // screen gets the same four things — the document, the route's query, the one
  // save path, and a redraw — so no screen owns storage or navigation.
  const context = {
    state,
    params: route.params,
    save: () => saveState(state),
    refresh: () => render(readRoute(), { moveFocus: false }),
  };
  switch (route.id) {
    case 'dashboard':
      screen.append(renderDashboard({ state, save: context.save, refresh: context.refresh }));
      break;
    case 'add':
      screen.append(renderAdd(context));
      break;
    case 'history':
      screen.append(renderHistory(context));
      break;
    case 'balances':
      screen.append(renderBalances(context));
      break;
    case 'insights':
      screen.append(renderInsights(context));
      break;
    case 'tesco':
      screen.append(renderTesco(context));
      break;
    default:
      // Every route in the contract renders now; this stays so a route added to
      // the union without a case says so instead of blanking the screen.
      screen.append(el('p', { class: 'app-notice' }, `${LABELS[route.id]} is not ported yet.`));
  }

  if (moveFocus) {
    queueMicrotask(() => heading.focus({ preventScroll: true }));
  }
}

function reveal(): void {
  // The lock is a fixed, full-document overlay: unlocking has to remove it, not
  // just stop listening to it. Without this the gate stayed painted over the
  // app and a correct dashboard was invisible underneath.
  const gate = byId('gate');
  if (gate) {
    clear(gate);
    gate.hidden = true;
  }
  if (app) app.hidden = false;
  render(readRoute());
}

/* ── the gate: profile choice first, then the lock ────────────────────────── */

function showGate(): void {
  const profiles = listProfiles();
  if (profiles.length > 1 && !hasSessionChoice()) {
    showProfilePicker({
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      activeId: getActiveProfileId(),
      onPick: (id) => {
        // Always write the choice: that is what records this session's answer and
        // stops the picker from being the gate on the next boot. A different
        // profile is a different document and a different PIN, so the simplest
        // correct load is a reload; the session choice sends it to the lock.
        if (!setActiveProfileId(id)) return;
        location.reload();
      },
    });
    return;
  }
  showPinLock({ state, onUnlock: reveal });
}

/* ── the theme toggle ──────────────────────────────────────────────────────── */

/** The header's light/dark control.
 *
 *  One handler, one flip. The vendored kit's own `switch-mode` is NOT mounted
 *  on this button: two handlers on one control would each read the theme and
 *  flip it back, and the button would do nothing. The key is written by
 *  `app/lib/settings.ts` and read by `app/theme-init.js` before first paint,
 *  so a device that has chosen dark never flashes light on the way in. */
function buildThemeToggle(): void {
  const header = document.querySelector('.app-header');
  if (!header || header.querySelector('.app-theme-toggle')) return;
  const button = el('button', {
    type: 'button',
    class: 'app-theme-toggle',
  });
  const paint = (): void => {
    const dark = currentTheme() === 'dark';
    button.textContent = dark ? 'Light' : 'Dark';
    button.setAttribute('aria-label', dark ? 'Use the light theme' : 'Use the dark theme');
    button.setAttribute('aria-pressed', dark ? 'true' : 'false');
  };
  button.addEventListener('click', () => { toggleTheme(); });
  onThemeChange(paint);
  paint();
  header.append(button);
}

/* ── the update prompt ────────────────────────────────────────────────────── */

let updateBarShown = false;

function showUpdateBar(): void {
  if (updateBarShown) return;
  updateBarShown = true;
  const bar = el('div', { class: 'update-bar', role: 'status' },
    el('span', { class: 'update-text' }, 'A newer version is ready.'),
    el('button', {
      class: 'btn btn-primary update-btn',
      type: 'button',
      onClick: () => location.reload(),
    }, 'Reload'),
  );
  document.body.append(bar);
}

function bootServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // A first install is silent: only a page that was already controlled can be
  // told an update exists, which is the shipping app's rule.
  const controlledAtLoad = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'centsNewBuild' && controlledAtLoad) showUpdateBar();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((registration) => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && controlledAtLoad) showUpdateBar();
      });
    });
    // A long-lived installed copy may never navigate again, so ask the worker to
    // re-read the document when the tab comes back into view.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'centsCheckUpdate' });
      }
    });
  }).catch(() => {});
}

/* ── boot ─────────────────────────────────────────────────────────────────── */

function boot(): void {
  window.__cents = { route: readRoute, shell: '2026-10-20' };
  buildNav(readRoute().id);
  buildThemeToggle();
  subscribe((route) => render(route));
  bootServiceWorker();

  const skip = byId<HTMLButtonElement>('skip-to-main');
  skip?.addEventListener('click', () => {
    screen?.focus({ preventScroll: true });
    screen?.scrollIntoView({ block: 'start' });
  });

  showGate();
  // boot-watch.js (loaded before this module) paints the failure panel unless
  // this flag appears, so a module that never parses still says something.
  (window as any).__centsBooted = true;
  byId('boot-fail')?.setAttribute('hidden', '');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
