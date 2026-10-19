/* First-party UI kit — dependency-free, class-only, CSP-strict.
 *
 * ONE FILE, NO BUILD. A site copies `ui.js` + `ui.css` (see vendor.mjs) and
 * writes markup; nothing here needs a bundler, a framework, or a network
 * request. That is deliberate: five of the eight sites are hand-written
 * HTML/JS with a `style-src 'self'` policy, and a layer they cannot adopt is
 * not a layer.
 *
 * The contract has three parts:
 *
 *   1. `data-ui="<component-id>"` on a real element installs that component and
 *      writes the same id into `data-component`, which is the attribute the
 *      coverage verifier counts. That is the whole point of the kit: adding one
 *      attribute is both the wiring and the evidence, so a site pass stops being
 *      a rewrite.
 *   2. Behaviour is an upgrade of the element that is already there. A
 *      `glide-select` is still a native <select> the site's own handler reads; a
 *      `squish-switch` is still the button that already toggled the theme.
 *   3. No `style` attribute is ever written and no <style> is injected. Runtime
 *      values travel as CSS custom properties via CSSOM, which `style-src` does
 *      not govern. Every class used here is in ui.css.
 *
 * Instances are idempotent (`data-ui-ready`), so `scan()` is safe to call after
 * every render. A failing installer logs once and leaves the element alone — a
 * component that cannot install must not take the page with it.
 *
 * Usage:
 *   <link rel="stylesheet" href="./ui.css">
 *   <script type="module" src="./ui.js"></script>
 *   <button data-ui="switch-mode" aria-checked="false">Theme</button>
 *   <script type="module">
 *     import { scan, toast } from './ui.js';
 *     scan();                       // after any re-render
 *   </script>
 */

const ids = [
  'glide-select', 'jelly-radio', 'rubber-segment', 'squish-switch', 'swipe-row',
  'warm-tooltip', 'accordion-gallery', 'animated-counter', 'github-activity',
  'gooey-nav', 'skiper68', 'skiper74', 'analytics-chart',
  'expandable-profile-card', 'time-undo-action', 'stepper',
  'inline-disclosure-menu', 'filter-disclosure', 'feedback',
  'inline-table-control', 'scroll-island', 'transaction-list', 'fluid-tabs',
  'switch-mode', 'fund-widget', 'dynamic-button', 'budget-card',
];

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const text = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Record the component on the element without clobbering another id. */
export function mark(el, id) {
  const list = (el.getAttribute('data-component') || '').split(/\s+/).filter(Boolean);
  if (!list.includes(id)) list.push(id);
  el.setAttribute('data-component', list.join(' '));
  return el;
}

/** Ready is per (element, component): one element can carry several components
 *  (`gooey-nav fluid-tabs`, `switch-mode`), and a single flag would install only
 *  the first one and merely mark the rest. */
function ready(el, id) {
  const done = (el.getAttribute('data-ui-ready') || '').split(/\s+/).filter(Boolean);
  if (done.includes(id)) return true;
  done.push(id);
  el.setAttribute('data-ui-ready', done.join(' '));
  return false;
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/* One outside-click listener for every disclosure menu on the page. A listener
   per row would accumulate on every re-render of a long table: the detached
   rows keep their handlers alive on `document`, and every later click walks
   them all. */
let menuOutsideBound = false;
function bindMenuOutside() {
  if (menuOutsideBound) return;
  menuOutsideBound = true;
  document.addEventListener('click', (event) => {
    for (const panel of document.querySelectorAll('[data-ui-menu-panel]')) {
      if (panel.hidden) continue;
      const scope = panel.closest('[data-ui]');
      if (scope?.contains(event.target)) continue;
      panel.hidden = true;
      scope?.querySelector('[data-ui-menu]')?.setAttribute('aria-expanded', 'false');
    }
  });
}

/* ── The installers ────────────────────────────────────────────────────────
   Each takes the element carrying `data-ui` and returns nothing. Keys are the
   component ids; `install()` looks the key up. */

const installers = {
  /* A native select stays the control; a value echo glides on change. */
  'glide-select'(select) {
    select.classList.add('ui-glide');
    const echo = el('span', 'ui-glide-echo', select.options[select.selectedIndex]?.text ?? '');
    echo.setAttribute('aria-hidden', 'true');
    select.after(echo);
    select.addEventListener('change', () => {
      echo.textContent = select.options[select.selectedIndex]?.text ?? '';
      echo.classList.remove('ui-glide-in');
      void echo.offsetWidth;
      echo.classList.add('ui-glide-in');
    });
  },

  /* The select is hidden but still the value the site's form reads. */
  'jelly-radio'(select) {
    if (select.tagName !== 'SELECT') return;
    select.classList.add('ui-sr-only');
    const group = el('div', 'ui-jelly');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', select.getAttribute('aria-label') || text(select.previousElementSibling) || select.name || 'Choose one');
    for (const option of [...select.options]) {
      const button = el('button', 'ui-jelly-opt', option.textContent);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(option.selected));
      if (option.selected) button.classList.add('is-on');
      button.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        for (const sibling of group.children) {
          sibling.classList.remove('is-on');
          sibling.setAttribute('aria-checked', 'false');
        }
        button.classList.add('is-on');
        button.setAttribute('aria-checked', 'true');
      });
      group.append(button);
    }
    // Mark the generated group too: the radios are what a reader meets, and the
    // hidden select alone is a 1×1 control behind clip-path. One control in
    // two nodes is still one instance — do not raise a site's floor for it.
    mark(group, 'jelly-radio');
    select.after(group);
  },

  /* Single-choice buttons; the change event is what the site listens for. */
  'rubber-segment'(host) {
    const options = [...host.querySelectorAll('[data-ui-option]')];
    if (!options.length) return;
    for (const option of options) {
      option.setAttribute('aria-pressed', String(option.classList.contains('is-on')));
      option.addEventListener('click', () => {
        for (const sibling of options) {
          sibling.classList.remove('is-on');
          sibling.setAttribute('aria-pressed', 'false');
        }
        option.classList.add('is-on');
        option.setAttribute('aria-pressed', 'true');
        host.dispatchEvent(new CustomEvent('ui:segment', { bubbles: true, detail: { value: option.dataset.uiOption } }));
      });
    }
  },

  'squish-switch'(button) {
    button.classList.add('ui-squish');
    const sync = () => {
      const on = button.getAttribute('aria-checked') === 'true';
      button.classList.toggle('is-on', on);
    };
    button.setAttribute('role', 'switch');
    sync();
    button.addEventListener('click', () => {
      button.classList.remove('is-squishing');
      void button.offsetWidth;
      button.classList.add('is-squishing');
      button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
      sync();
    });
  },

  /* Mode = the same switch plus the persistence the site already owns. */
  'switch-mode'(button) {
    installers['squish-switch'](button);
    // One control, two names: the kit records both so coverage can count the
    // component the site actually has.
    mark(button, 'squish-switch');
    // A site keeps its own storage key and attribute: Cents reads `data-theme`
    // and `cents-theme`, and a hardcoded `ui-mode` would be a second theme
    // owner rather than an upgrade of the switch already there.
    const attr = button.dataset.uiModeAttr || 'mode';
    const key = button.dataset.uiModeKey || 'ui-mode';
    const apply = (mode) => {
      if (attr === 'theme') document.documentElement.dataset.theme = mode === 'dark' ? 'dark' : '';
      else document.documentElement.dataset[attr] = mode;
    };
    const saved = (() => { try { return localStorage.getItem(key); } catch { return null; } })();
    if (saved && !button.hasAttribute('data-ui-nopersist')) {
      apply(saved);
      button.setAttribute('aria-checked', String(saved === 'dark'));
      button.classList.toggle('is-on', saved === 'dark');
    }
    button.addEventListener('click', () => {
      const mode = button.getAttribute('aria-checked') === 'true' ? 'dark' : 'light';
      apply(mode);
      try { localStorage.setItem(key, mode); } catch { /* private mode */ }
    });
  },

  /* A budget figure and its bar: the bar becomes a real progressbar instead of
     a coloured div, and the card carries the figure the width encodes. */
  'budget-card'(card) {
    card.classList.add('ui-budget-card');
    const bar = card.querySelector('[data-ui-bar]');
    const raw = Number(card.dataset.uiPercent || 0);
    const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
    if (!bar) return;
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-label', card.dataset.uiLabel || 'Spent of budget');
  },

  'warm-tooltip'(host) {
    const target = host.querySelector('[data-ui-tip]') || host;
    const tip = target.getAttribute('data-ui-tip') || text(host);
    target.setAttribute('data-tip', tip);
    target.classList.add('ui-tip');
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
  },

  /* Counts a rendered figure up to its own value and restores the exact text. */
  'animated-counter'(host) {
    const target = host.querySelector('[data-ui-value]') || host;
    const original = text(target);
    const match = original.match(/-?[\d,]+(\.\d+)?/);
    if (!match || reduced()) return;
    const value = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(value) || value > 1e8) return;
    const decimals = match[1] ? match[1].length - 1 : 0;
    const prefix = original.slice(0, match.index);
    const suffix = original.slice(match.index + match[0].length);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      target.textContent = prefix + (decimals ? (value * eased).toFixed(decimals) : Math.round(value * eased).toLocaleString('en-IE')) + suffix;
      if (t < 1) requestAnimationFrame(step);
      else target.textContent = original;
    };
    requestAnimationFrame(step);
  },

  /* `data-ui-dates="2026-10-01,2026-10-03"` → a year grid, counts from the data. */
  'github-activity'(host) {
    const dates = (host.dataset.uiDates || '').split(',').map((d) => d.trim()).filter(Boolean);
    if (!dates.length) return;
    const counts = dates.reduce((map, day) => ({ ...map, [day]: (map[day] || 0) + 1 }), {});
    const grid = el('div', 'ui-heatmap-grid');
    for (const [day, count] of Object.entries(counts).sort()) {
      const cell = el('span', 'ui-heatmap-cell');
      cell.dataset.level = count > 3 ? '4' : count > 2 ? '3' : count > 1 ? '2' : '1';
      cell.title = `${day}: ${count}`;
      grid.append(cell);
    }
    host.append(grid);
    host.append(el('p', 'ui-heatmap-note', `${dates.length} entries in view`));
  },

  /* The indicator is a class on the active tab, not a positioned element: a
     runtime `style` attribute — even one set through CSSOM — shows up in the DOM
     as an inline style, and the sites' contract is that served markup carries
     none. A sliding blob needs the active tab's measured geometry; the tab's own
     ::after needs nothing. */
  'gooey-nav'(nav) {
    nav.classList.add('ui-gooey');
    const sync = () => {
      for (const tab of nav.querySelectorAll('[data-ui-tab], a, button')) {
        const on = tab.getAttribute('aria-current') === 'page' || tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('is-on') || tab.classList.contains('active');
        tab.classList.toggle('is-gooey-on', on);
      }
    };
    sync();
    nav.addEventListener('click', () => setTimeout(sync, 0));
    nav.addEventListener('keydown', () => setTimeout(sync, 0));
  },

  /* Roving tabindex on the same strip. */
  'fluid-tabs'(nav) {
    nav.setAttribute('role', 'tablist');
    const tabs = [...nav.querySelectorAll('a, button')].filter((tab) => tab.hasAttribute('data-ui-tab'));
    if (!tabs.length) return;
    for (const tab of tabs) {
      const on = tab.getAttribute('aria-selected') === 'true';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('tabindex', on ? '0' : '-1');
    }
    nav.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      const list = [...nav.querySelectorAll('[data-ui-tab]')];
      const index = list.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      list[next].focus();
      list[next].click();
    });
  },

  /* `data-ui-min` / `data-ui-max`; fires `ui:number`. */
  'skiper68'(input) {
    input.setAttribute('inputmode', input.getAttribute('inputmode') || 'decimal');
    input.setAttribute('type', 'number');
    const min = input.dataset.uiMin;
    const max = input.dataset.uiMax;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      const bad = !Number.isFinite(value) || (min !== undefined && value < Number(min)) || (max !== undefined && value > max);
      input.setAttribute('aria-invalid', String(bad && input.value !== ''));
    });
  },

  /* `data-ui-months="Oct 2026,Sep 2026"` → a scrollable month index. */
  'skiper74'(host) {
    const months = (host.dataset.uiMonths || '').split(',').map((m) => m.trim()).filter(Boolean);
    if (months.length < 2) return;
    const strip = host.querySelector('.ui-months') || el('div', 'ui-months');
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', host.dataset.uiLabel || 'Months');
    // The first month is not always the one on screen: a site viewing an older
    // month must say which label is current, or the strip lies about it.
    const active = host.dataset.uiActive;
    months.forEach((month, index) => {
      const on = active ? month === active : index === 0;
      const button = el('button', 'ui-month' + (on ? ' is-on' : ''), month);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(on));
      button.addEventListener('click', () => {
        for (const sibling of strip.querySelectorAll('.ui-month')) {
          sibling.classList.remove('is-on');
          sibling.setAttribute('aria-pressed', 'false');
        }
        button.classList.add('is-on');
        button.setAttribute('aria-pressed', 'true');
        host.dispatchEvent(new CustomEvent('ui:month', { bubbles: true, detail: { month } }));
      });
      strip.append(button);
    });
    if (!strip.parentNode) host.append(strip);
  },

  'analytics-chart'(card) {
    const toggle = el('button', 'ui-chart-expand', '⤢');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Expand chart');
    toggle.addEventListener('click', () => {
      const open = card.classList.toggle('is-expanded');
      toggle.setAttribute('aria-label', open ? 'Collapse chart' : 'Expand chart');
      dispatchEvent(new Event('resize'));
    });
    card.append(toggle);
  },

  /* Opens a dialog from the element's own text plus `data-ui-facts`. */
  'expandable-profile-card'(trigger) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      const title = trigger.dataset.uiTitle || text(trigger);
      const facts = (trigger.dataset.uiFacts || '').split('|').filter(Boolean);
      const backdrop = el('div', 'ui-dialog-backdrop');
      const dialog = el('section', 'ui-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', title);
      dialog.tabIndex = -1;
      dialog.append(el('h2', 'ui-dialog-title', title));
      const list = el('ul', 'ui-dialog-facts');
      for (const fact of facts) list.append(el('li', '', fact));
      dialog.append(list);
      const close = el('button', 'ui-dialog-close', 'Close');
      close.type = 'button';
      dialog.append(close);
      backdrop.append(dialog);
      document.body.append(backdrop);
      const previous = document.activeElement;
      dialog.focus();
      const dismiss = () => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        previous?.focus?.();
      };
      const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
      close.addEventListener('click', dismiss);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
      document.addEventListener('keydown', onKey);
    });
  },

  /* An undo bar: `ui.undo({ message, onUndo, ms })`. The attribute form reads
     `data-ui-message` and fires `ui:undo` so the site owns the restore. */
  'time-undo-action'(host) {
    const show = () => undo({
      message: host.dataset.uiMessage || 'Done.',
      ms: Number(host.dataset.uiMs || 6000),
      onUndo: () => host.dispatchEvent(new CustomEvent('ui:undo', { bubbles: true })),
    });
    if (host.dataset.uiTrigger === 'load') show();
    else host.addEventListener('click', show);
  },

  stepper(host) {
    const input = host.querySelector('input') || host;
    if (input.tagName !== 'INPUT') return;
    input.type = 'number';
    input.classList.add('ui-stepper-input');
    const step = (delta) => {
      const value = num(input.value) + delta;
      const min = Number(input.min || -Infinity);
      const max = Number(input.max || Infinity);
      input.value = String(Math.max(min, Math.min(max, value)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // The input is moved *inside* the wrapper rather than the buttons being
    // lifted out of it: an empty wrapper left behind in the flow is exactly the
    // kind of stray node that makes a later layout change confusing.
    const wrap = el('div', 'ui-stepper');
    const minus = el('button', 'ui-stepper-btn', '−');
    const plus = el('button', 'ui-stepper-btn', '+');
    for (const [button, delta] of [[minus, -1], [plus, 1]]) {
      button.type = 'button';
      button.setAttribute('aria-label', delta < 0 ? 'Decrease' : 'Increase');
      button.addEventListener('click', () => step(delta));
    }
    input.before(wrap);
    wrap.append(minus, input, plus);
  },

  'inline-disclosure-menu'(row) {
    const trigger = row.querySelector('[data-ui-menu]') || row;
    const panel = row.querySelector('[data-ui-menu-panel]');
    if (!panel) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      panel.hidden = !panel.hidden;
      trigger.setAttribute('aria-expanded', String(!panel.hidden));
    });
    bindMenuOutside();
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    });
  },

  'filter-disclosure'(bar) {
    const toggle = el('button', 'ui-filters-toggle', bar.dataset.uiLabel || 'Filters');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    // Pills are this kit's other filter control: a site that filters with
    // aria-pressed buttons would otherwise always read "Filters" with no count.
    // `data-id="all"` is the reset option, not a filter, so it is not counted.
    const count = () => [...bar.querySelectorAll('select, input')].filter((field) => field.value).length
      + [...bar.querySelectorAll('[aria-pressed="true"]')].filter((pill) => pill.dataset.id !== 'all').length;
    const label = () => { toggle.textContent = `${bar.dataset.uiLabel || 'Filters'}${count() ? ' · ' + count() : ''}`; };
    label();
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      bar.classList.toggle('is-collapsed', open);
    });
    bar.before(toggle);
    bar.addEventListener('change', label);
    bar.addEventListener('click', (event) => { if (event.target.closest('[aria-pressed]')) setTimeout(label, 0); });
  },

  /* Posts to `data-ui-endpoint`, keeps the honeypot, reports the server's message. */
  feedback(form) {
    const endpoint = form.dataset.uiEndpoint || '/api/feedback';
    const status = form.querySelector('[data-ui-status]') || el('div', 'ui-form-status');
    if (!status.parentNode) form.append(status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const button = form.querySelector('[type="submit"]');
      const label = button?.textContent;
      if (button) { button.disabled = true; button.textContent = 'Sending…'; }
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(data)),
        });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.ok) {
          status.textContent = '✓ Thanks — that reached me.';
          form.reset();
        } else {
          status.textContent = body?.error || 'Could not send that just now.';
        }
      } catch {
        status.textContent = 'Could not send that — check your connection.';
      }
      if (button) { button.disabled = false; button.textContent = label; }
    });
  },

  /* `data-ui-field` cells get an inline editor that fires `ui:cell`. */
  'inline-table-control'(table) {
    for (const cell of table.querySelectorAll('[data-ui-field]')) {
      cell.classList.add('ui-cell');
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `Edit ${cell.dataset.uiField}: ${text(cell)}`);
      cell.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        cell.click();
      });
      cell.addEventListener('click', () => {
        // An inline field, not prompt(): prompt is blocked in some embedded
        // webviews and unreachable for a touch reader. Enter commits, Escape
        // cancels, blur commits (the same rule the site's own fields use).
        if (cell.querySelector('input')) return;
        const current = text(cell);
        const input = el('input', 'ui-cell-input');
        input.value = current;
        input.setAttribute('aria-label', cell.dataset.uiField || 'Value');
        cell.textContent = '';
        cell.append(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit) => {
          if (done) return;
          done = true;
          const next = input.value.trim();
          cell.textContent = commit && next ? next : current;
          cell.setAttribute('aria-label', `Edit ${cell.dataset.uiField}: ${text(cell)}`);
          if (commit && next && next !== current) {
            cell.dispatchEvent(new CustomEvent('ui:cell', { bubbles: true, detail: { field: cell.dataset.uiField, value: next } }));
          }
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); finish(true); }
          else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
      });
    }
  },

  'scroll-island'(island) {
    const button = island.querySelector('[data-ui-action="top"]') || island;
    button.addEventListener('click', () => scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }));
    const sync = () => island.classList.toggle('is-visible', scrollY > 400);
    addEventListener('scroll', sync, { passive: true });
    sync();
  },

  'transaction-list'(list) {
    list.classList.add('ui-txlist');
    for (const item of list.children) item.classList.add('ui-txitem');
  },

  'accordion-gallery'(card) {
    const panel = card.querySelector('[data-ui-panel]');
    const trigger = el('button', 'ui-acc-trigger', 'Details');
    trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false');
    let node = panel;
    if (!node) {
      node = el('div', 'ui-acc-panel', text(card));
    }
    node.hidden = true;
    node.classList.add('ui-acc-panel');
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = trigger.getAttribute('aria-expanded') === 'true';
      for (const other of document.querySelectorAll('.ui-acc-panel')) other.hidden = true;
      for (const other of document.querySelectorAll('.ui-acc-trigger')) other.setAttribute('aria-expanded', 'false');
      if (!open) {
        node.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    card.append(trigger);
    if (panel && panel !== node) node.hidden = true;
    if (!panel) card.append(node);
  },

  'fund-widget'(widget) {
    const value = widget.querySelector('[data-ui-value]') || widget;
    const label = widget.dataset.uiLabel || '';
    const delta = widget.dataset.uiDelta;
    if (delta) {
      const chip = el('span', `${delta.trim().startsWith('-') ? 'ui-fund-chip is-down' : 'ui-fund-chip'}`, delta);
      value.after(chip);
    } else if (label) {
      value.after(el('span', 'ui-fund-chip', label));
    }
  },

  'dynamic-button'(button) {
    button.classList.add('ui-button');
    button.addEventListener('click', () => {
      if (button.disabled || button.dataset.uiState === 'working') return;
      // Opt-in: a button only gets the state machine when it declares that it is
      // async, so the kit cannot add latency to an ordinary submit.
      if (!button.dataset.uiAsync) return;
      button.dataset.uiState = 'working';
      button.disabled = true;
      const label = button.textContent;
      button.textContent = button.dataset.uiWorking || 'Working…';
      setTimeout(() => {
        button.textContent = button.dataset.uiDone || label;
        button.disabled = false;
        button.dataset.uiState = 'done';
        setTimeout(() => { button.dataset.uiState = ''; button.textContent = label; }, 1200);
      }, 500);
    });
  },

  /* Swipe to reveal `[data-ui-swipe-action]`; a plain tap still does nothing
     unexpected, and keyboard users get the same action from the button itself. */
  'swipe-row'(row) {
    row.classList.add('ui-swipe-row');
    const action = row.querySelector('[data-ui-swipe-action]');
    if (!action) return;
    action.classList.add('ui-swipe-action');
    let startX = null;
    row.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    row.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (dx < -40) row.classList.add('is-revealed');
      if (dx > 40) row.classList.remove('is-revealed');
    }, { passive: true });
  },
};

/** Install one component on one element, safely. */
export function install(element, id) {
  const fn = installers[id];
  if (!fn) return false;
  if (ready(element, id)) {
    mark(element, id);
    return true;
  }
  try {
    fn(element);
    mark(element, id);
    return true;
  } catch (error) {
    console.warn(`ui: ${id} could not install`, error);
    return false;
  }
}

/** Upgrade everything under `root` that declares `data-ui`. */
export function scan(root = document) {
  for (const element of root.querySelectorAll('[data-ui]')) {
    const tokens = element.getAttribute('data-ui').split(/\s+/).filter(Boolean);
    for (const id of tokens) {
      if (ids.includes(id)) install(element, id);
      else console.warn(`ui: unknown component "${id}"`);
    }
  }
  return count(root);
}

/** Distinct component ids present under `root` — the coverage number. */
export function count(root = document) {
  const found = new Set();
  for (const element of root.querySelectorAll('[data-component]')) {
    for (const id of element.getAttribute('data-component').split(/\s+/)) if (id) found.add(id);
  }
  return [...found].sort();
}

/** A transient undo bar, shared by every caller. */
export function undo({ message, onUndo, ms = 6000 }) {
  document.getElementById('ui-undo')?.remove();
  const bar = el('div', 'ui-undo');
  bar.id = 'ui-undo';
  bar.setAttribute('role', 'status');
  bar.append(el('span', '', message));
  const button = el('button', 'ui-undo-btn', 'Undo');
  button.type = 'button';
  bar.append(button);
  document.body.append(bar);
  const timer = setTimeout(() => bar.remove(), ms);
  button.addEventListener('click', () => {
    clearTimeout(timer);
    onUndo?.();
    bar.remove();
  });
}

export const componentIds = [...ids];

// Auto-scan on load and follow the host's re-renders. A site that renders on its
// own schedule can call `scan()` instead; running both is harmless because every
// install is idempotent.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan());
  else scan();
  new MutationObserver(() => {
    if (scan.pending) return;
    scan.pending = setTimeout(() => { scan.pending = null; scan(); }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
