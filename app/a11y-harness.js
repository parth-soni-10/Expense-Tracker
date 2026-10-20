/* ---------------------------------------------------------------- checks */
const NAME_SELECTORS = 'button, a[href], [role="button"], input[type="submit"], input[type="button"], input[type="reset"]';

/** The accessible name, as far as it can be computed without a browser API. */
function nameOf(doc, el) {
  const labelledBy = el.getAttribute('aria-labelledby');
  const fromLabelledBy = labelledBy
    ? labelledBy.split(/\s+/).map(id => doc.getElementById(id)?.textContent || '').join(' ')
    : '';
  const candidates = [
    el.getAttribute('aria-label'),
    fromLabelledBy,
    el.getAttribute('title'),
    (el.textContent || '').trim(),
    el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt'),
    el.querySelector('svg title')?.textContent,
  ];
  return (candidates.find(c => c && String(c).trim()) || '').trim();
}

/** Everything the user can see at once: the screen, plus any open sheet.
 *
 *  The ported shell's sheets are real `<dialog>` elements, so an open one is
 *  `dialog[open]` — and the LOCK lives in the gate, which is a plain div, so
 *  it is a scope in its own right. A sheet left behind would be a second
 *  scope counted against an unrelated row, so the reset reloads the frame
 *  rather than trying to close whatever the last step left open. */
function scopes(doc) {
  return [doc.getElementById('app'), doc.getElementById('gate'), ...doc.querySelectorAll('dialog[open], .modal-bg, .menu-backdrop, .swal2-container')]
    .filter(node => node && node.isConnected);
}

/** The four defects, over one surface. Pure DOM reading — nothing is clicked. */
function audit(doc) {
  const unnamed = [];
  const labelled = new Map();
  const unlabelledFields = [];
  const noAlt = [];
  for (const scope of scopes(doc)) {
    for (const el of scope.querySelectorAll(NAME_SELECTORS)) {
      if (!nameOf(doc, el)) unnamed.push(describe(el));
    }
    for (const el of scope.querySelectorAll('[aria-label]')) {
      const key = el.getAttribute('aria-label');
      labelled.set(key, (labelled.get(key) || 0) + 1);
    }
    for (const el of scope.querySelectorAll('input, select, textarea')) {
      if (el.type === 'hidden') continue;
      const id = el.id;
      const has = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label')
        || (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`));
      if (!has) unlabelledFields.push(describe(el));
    }
    for (const img of scope.querySelectorAll('img')) if (!img.hasAttribute('alt')) noAlt.push(describe(img));
  }
  const dupes = [...labelled.entries()].filter(([, n]) => n > 1).map(([key, n]) => `${key} x${n}`);
  return { unnamed, dupes, unlabelledFields, noAlt, scopes: scopes(doc).length };
}

function describe(el) {
  const cls = (el.getAttribute('class') || '').trim();
  const html = el.outerHTML.replace(/\s+/g, ' ').slice(0, 160);
  return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).join('.') : ''} — ${html}`;
}

/* --------------------------------------------------------------- driving */
/* The frame hosts the PORTED shell. It is served from the app's own origin, so
 * it shares the app's localStorage — which is why nothing here seeds the
 * ledger: seeding it would overwrite a real one. */
const frame = document.createElement('iframe');
frame.src = '/index.html?v=a11y-harness';
frame.width = '1100';
frame.height = '900';
frame.style.cssText = 'border:0;';
document.getElementById('frame-host').appendChild(frame);

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => frame.contentWindow;
const doc = () => frame.contentDocument;

/** Wait for a condition the app owns, or give up so a report can still print. */
async function until(fn, { timeout = 8000, every = 120 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch { /* the frame is mid-navigation */ }
    await wait(every);
  }
  return false;
}

const byText = (text, selector = 'button, .menu-row, a') => {
  const needle = String(text).toLowerCase();
  return [...doc().querySelectorAll(selector)]
    .find(el => el.isConnected && el.textContent.trim().toLowerCase().includes(needle));
};

/** Click something that OPENS a surface. Never used inside an open modal. */
async function openByText(text, selector) {
  const el = byText(text, selector);
  if (!el) return false;
  el.click();
  await wait(420);
  return true;
}

async function closeEverything() {
  for (let i = 0; i < 6; i++) {
    const close = doc().querySelector('dialog[open] button[aria-label^="Close"], .menu-close, .modal-bg button[aria-label^="Close"], [aria-label="Close menu"]');
    if (close && close.isConnected) { close.click(); await wait(240); continue; }
    if (doc().querySelector('dialog[open], .modal-bg, .menu-backdrop')) {
      const KeyEvent = win().KeyboardEvent;
      doc().dispatchEvent(new KeyEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(240);
      continue;
    }
    break;
  }
}

/* Not every surface closes on Escape or has a labelled close button, and one
   left open makes the NEXT step's scope wrong (its modal would be counted
   against an unrelated surface). So a fresh start is the honest reset: reload
   the frame, wait for it to boot and unlock again. */
let reloads = 0;
let unlockNote = 'not unlocked yet';
let onboardingNote = 'no setup overlay';
async function resetFrame(keepLocked = false) {
  frame.src = `/index.html?v=a11y-${++reloads}`;
  // Wait for the navigation to COMMIT before trusting anything in the frame:
  // the outgoing document keeps `__centsBooted` until it is replaced, so a slow
  // commit lets the boot wait below pass against the document being torn down —
  // and the unlock would then run against the wrong document.
  const token = `?v=a11y-${reloads}`;
  if (!await until(() => { try { return win().location.search === token; } catch { return false; } }, { timeout: 8000 })) return false;
  if (!await until(() => win().__centsBooted, { timeout: 15000 })) return false;
  // A step that audits the LOCK must not have it taken away first.
  if (!keepLocked) unlockNote = await unlock();
  noteOnboarding(await dismissOnboarding());
  return until(() => doc().querySelector('#app > *') || doc().querySelector('#gate input[aria-label="PIN"]'), { timeout: 8000 });
}

/* A first run puts the setup overlay over everything — position:fixed, the whole
   viewport, pointer-events:auto, z-index 10001 — and it stays until it is
   finished. Nothing in the menu is reachable behind it, so a run that drives the
   menu anyway is auditing a state a real user cannot be in: the overlay's own PIN
   fields then count as duplicates of the menu's, which is how a fresh device used
   to report two "problems" that no user could ever see.

   It is walked out the way a user walks it out — the overlay's own skip control
   advances a step and, on the last one, finishes — so the audit runs against the
   app as a returning user has it.

   Deliberately NON-DESTRUCTIVE: this page is served from the app's own origin, so
   it shares the app's localStorage, and seeding the ledger here would overwrite a
   real one. It only clicks controls the app owns. */
async function dismissOnboarding() {
  if (!doc().querySelector('.onboarding-bg')) return 'absent';
  for (let i = 0; i < 5 && doc().querySelector('.onboarding-bg'); i++) {
    const skip = doc().querySelector('.onboarding-bg .btn-link');
    if (!skip) break;
    skip.click();
    await wait(340);
  }
  return doc().querySelector('.onboarding-bg') ? 'stuck' : 'dismissed';
}

/* The note describes the RUN, not the last frame: it is folded in per step and
   accumulates, because the setup overlay is gone by step two and a note that got
   overwritten would report "no setup overlay" for a run whose first step had one.
   A stuck overlay is the one outcome that must never read as clean. */
let onboardingSeen = false;
let onboardingStuck = false;
function noteOnboarding(status) {
  if (status === 'dismissed') onboardingSeen = true;
  if (status === 'stuck') { onboardingStuck = true; onboardingSeen = true; }
  onboardingNote = onboardingStuck
    ? 'COULD NOT DISMISS THE SETUP OVERLAY (a step has no skip control) — the surfaces were audited behind it'
    : onboardingSeen ? 'setup overlay dismissed' : 'no setup overlay';
}

/* The menu trigger carries no text, so it is addressed by class: a text search
   for '' would match the first control on the page. */
async function openMenuRoot() {
  const trigger = doc().querySelector('.menu-trigger');
  if (!trigger) return false;
  trigger.click();
  await wait(420);
  return true;
}

async function go(route) {
  const hash = '#' + route;
  if (win().location.hash === hash) return true;
  win().location.hash = hash;
  await wait(700);
  return true;
}

/* The modal openers the PORTED shell has. scripts/check-a11y.mjs reads this
 * list and asserts it against the exported openers in app/src/screens/*.ts: a
 * new sheet has to be added here AND given a step below, so a surface cannot
 * ship unaudited.
 *
 * One opener is deliberately not here, and the guard knows why:
 *   · openAvatarPicker — it is reached only from the admin panel, and only for
 *     a profile that is not the owner, so a step for it would report "skipped"
 *     on an ordinary device. A skip has to mean "this device could not reach
 *     it", not "this device never has it". */
const MODAL_OPENERS = [
  'openDataSheet', 'openBankStatement', 'openSettings', 'openMethodManager',
  'openRecurringManager', 'openAdminPanel', 'openYearInReview', 'openShiftEditor',
  'showPinLock',
];

/** Click the NTH thing that says `text`. Two sheets in the Settings sheet are
 *  both called "Manage", and picking the first of them twice would audit one
 *  surface twice and never the other. */
const byTextNth = (text, selector, nth) => {
  const needle = String(text).toLowerCase();
  return [...doc().querySelectorAll(selector)]
    .filter(el => el.isConnected && el.textContent.trim().toLowerCase().includes(needle))[nth];
};

/** Click a control by its accessible label, exactly. Two buttons in one view can
 *  say the same thing and mean different things - and a screen reader hears no
 *  difference, so a label is a name and not decoration. */
const byLabel = (label, selector = 'button') => {
  const needle = String(label).trim().toLowerCase();
  return [...doc().querySelectorAll(selector)]
    .find(el => el.isConnected && (el.getAttribute('aria-label') || '').trim().toLowerCase() === needle);
};

async function openByLabel(label, selector) {
  const el = byLabel(label, selector);
  if (!el) return false;
  el.click();
  await wait(420);
  return true;
}

async function openNthByText(text, selector, nth) {
  const el = byTextNth(text, selector, nth);
  if (!el) return false;
  el.click();
  await wait(420);
  return true;
}

/* The surfaces: every route, then every place a screen opens something. */
const STEPS = [
  { name: '#dashboard', open: () => go('dashboard') },
  { name: '#add', open: () => go('add') },
  { name: '#add · the structured form', open: () => go('add?more=1') },
  { name: '#history', open: () => go('history') },
  { name: '#balances', open: () => go('balances') },
  { name: '#tesco', open: () => go('tesco') },
  { name: '#insights', open: () => go('insights') },
  { name: 'the lock screen', keepLocked: true, open: async () => {
      // The gate is up because this step is NOT unlocked. The lock is a modal
      // surface like any other, and it is the one that protects the ledger.
      return !!doc().querySelector('#gate input[aria-label="PIN"]');
    } },
  { name: 'sheet · the data sheet', open: async () => openByText('Data', '.app-tab') },
  { name: 'sheet · the bank statement importer', open: async () => {
      if (!(await openByText('Data', '.app-tab'))) return false;
      if (!(await openByText('Import bank statement', '.data-action'))) return false;
      // The dialog opens before it asks for a file, so a run never has to drive
      // the OS picker to audit the mapper's own screen.
      return until(() => doc().querySelector('dialog.bank-dialog'), { timeout: 4000 });
    } },
  { name: 'sheet · the settings sheet', open: async () => openByText('Settings', '.app-tab') },
  { name: 'sheet · the payment-method manager', open: async () => {
      if (!(await openByText('Settings', '.app-tab'))) return false;
      return openByLabel("Manage payment methods", "button");
    } },
  { name: 'sheet · the recurring manager', open: async () => {
      if (!(await openByText('Settings', '.app-tab'))) return false;
      return openByLabel("Manage recurring bills", "button");
    } },
  { name: 'sheet · the admin panel', needs: 'the owner profile active on this device', open: async () => {
      if (!(await openByText('Settings', '.app-tab'))) return false;
      return openByText('Manage people', '.btn');
    } },
  { name: 'sheet · the year in review', open: async () => {
      if (!(await go('insights'))) return false;
      return openByText("Year in review", "button");
    } },
  { name: 'sheet · the shift editor', needs: 'a stored shift to edit', open: async () => {
      if (!(await go('tesco'))) return false;
      const pencil = await until(() => doc().querySelector('#screen button[aria-label^="Edit shift"]'), { timeout: 6000 });
      if (!pencil) return false;
      doc().querySelector('#screen button[aria-label^="Edit shift"]').click();
      await wait(420);
      return true;
    } },
];

// Every surface gets a freshly loaded app. It is slower than closing whatever the
// last step left open, and it is the only version that cannot lie: a modal left
// behind is a second scope counted against an unrelated row (and "Escape closes
// it" is not true of every modal).

/* ------------------------------------------------------------------ run */
const summary = document.getElementById('summary');
const tbody = document.querySelector('#report tbody');
const results = [];

function row(index, step, result, opened, failure = null) {
  const tr = document.createElement('tr');
  const bad = !opened ? 'skipped' : (result.unnamed.length || result.dupes.length || result.unlabelledFields.length || result.noAlt.length) ? 'bad' : 'ok';
  tr.className = bad;
  tr.innerHTML = `<td>${index}</td><td>${step.name}</td>`
    + `<td class="n">${opened ? result.unnamed.length : '—'}</td>`
    + `<td class="n">${opened ? result.dupes.length : '—'}</td>`
    + `<td class="n">${opened ? result.unlabelledFields.length : '—'}</td>`
    + `<td class="n">${opened ? result.noAlt.length : '—'}</td>`
    + `<td>${opened ? `yes (${result.scopes} scope${result.scopes === 1 ? '' : 's'})` : (failure ? `threw: ${escapeHtml(failure)}` : `skipped — needs ${escapeHtml(step.needs || 'a reason (declare one)')}`)}</td>`;
  tbody.appendChild(tr);
  const findings = [
    ['unnamed controls', result.unnamed],
    ['duplicate aria-labels', result.dupes],
    ['unlabelled fields', result.unlabelledFields],
    ['images without alt', result.noAlt],
  ].filter(([, list]) => list.length);
  if (findings.length) {
    const det = document.createElement('tr');
    det.className = bad;
    det.innerHTML = `<td></td><td colspan="6"><details open><summary>${findings.reduce((n, [, l]) => n + l.length, 0)} finding(s)</summary>`
      + findings.map(([label, list]) => `<div><strong>${label}</strong><pre>${list.map(l => escapeHtml(l)).join('\n')}</pre></div>`).join('')
      + '</details></td>';
    tbody.appendChild(det);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

async function unlock() {
  // The ported shell's lock is a form in the gate: one field, one button.
  const type = () => {
    const lock = doc().querySelector('#gate input[aria-label="PIN"]');
    if (!lock) return false;
    lock.value = '100901';
    const InputEvent = win().Event;
    lock.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  };
  if (!type()) return 'no lock screen';
  const first = await until(() => !doc().querySelector('#gate input[aria-label="PIN"]'), { timeout: 4000 });
  if (first) return 'unlocked with the default PIN';
  // One retry before the note blames the device: a dispatch can race a
  // just-committed document (or a slow verify can outlast the wait above), and
  // a lost race must not report "a custom PIN is set".
  if (type()) await until(() => !doc().querySelector('#gate input[aria-label="PIN"]'), { timeout: 6000 });
  return doc().querySelector('#gate input[aria-label="PIN"]')
    ? 'COULD NOT UNLOCK (a custom PIN is set on this device)'
    : 'unlocked with the default PIN';
}

(async function run() {
  // Boot is `__centsBooted`, NOT "the mount has children": with a PIN set the app
  // deliberately paints nothing at all until it is unlocked (the lock overlay
  // mounts on <body>), so waiting for content first would wait forever.
  const booted = await until(() => win().__centsBooted, { timeout: 15000 });
  if (!booted) {
    summary.className = 'bad';
    summary.textContent = 'the app never booted in the frame — is it being served? (open this page from the served app, not from disk)';
    return;
  }
  unlockNote = await unlock();
  noteOnboarding(await dismissOnboarding());
  const painted = await until(() => doc().querySelector('#app > *'), { timeout: 8000 });
  if (!painted) {
    summary.className = 'bad';
    summary.textContent = `the app booted but never painted — ${unlockNote}`;
    return;
  }
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    let opened = false;
    let failure = null;
    // One surface can never take the run down: a harness that stops halfway
    // reports on half the app and looks like a pass on the part it reached.
    // Progress is exposed (and the very slow steps are visible) so a run that
    // stalls can be diagnosed from the console instead of by guesswork.
    window.__a11yProgress = { i, step: step.name, phase: 'open' };
    try {
      opened = (await resetFrame(!!step.keepLocked)) && await step.open();
      window.__a11yProgress.phase = 'settle';
      await wait(300);
    } catch (err) {
      opened = false;
      failure = String((err && err.message) || err);
    }
    window.__a11yProgress.phase = 'audit';
    let result = { unnamed: [], dupes: [], unlabelledFields: [], noAlt: [], scopes: 0 };
    try {
      if (opened) result = audit(doc());
    } catch (err) {
      failure = String((err && err.message) || err);
      opened = false;
    }
    results.push({ step: step.name, opened, failure, needs: step.needs || null, ...result });
    row(i + 1, step, result, opened, failure);
  }
  await closeEverything();
  const problems = results.filter(r => r.opened)
    .reduce((n, r) => n + r.unnamed.length + r.dupes.length + r.unlabelledFields.length + r.noAlt.length, 0);
  const checked = results.filter(r => r.opened).length;
  const skipped = results.length - checked;
  const failures = results.filter(r => r.failure);
  const broken = !checked || failures.length || onboardingStuck;
  summary.className = (problems || broken) ? 'bad' : 'ok';
  // A skip has to say WHY it was skipped — an unexplained one reads as coverage.
  const skipReasons = [...new Set(results.filter(r => !r.opened).map(r => r.needs || r.failure || 'no reason declared'))];
  summary.textContent = `${problems} problem(s) across ${checked} surface(s)`
    + (skipped ? `, ${skipped} skipped (${skipReasons.join('; ')})` : '')
    + (failures.length ? `, ${failures.length} step(s) threw: ${failures.map(f => `${f.step} (${f.failure})`).join('; ')}` : '')
    + ` · ${unlockNote} · ${onboardingNote}`;
  window.__a11yReport = { problems, checked, skipped, failures, unlock: unlockNote, onboarding: onboardingNote, results };
  document.title = (problems || broken) ? `a11y: ${problems} problem(s)` : `a11y: clean (${checked} surfaces)`;
})().catch(err => {
  const box = document.getElementById('summary');
  box.className = 'bad';
  box.textContent = `the harness itself threw: ${(err && err.stack) || err}`;
  window.__a11yReport = { error: String((err && err.message) || err), checked: 0, skipped: 0, problems: -1, results: [] };
});
