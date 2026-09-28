#!/usr/bin/env node
/**
 * Vendored-UI harness — the four libraries wired in beside the app's own code.
 *
 * app.js cannot be imported anywhere (it touches the DOM the moment it is
 * evaluated) and this repo has no test framework, so the two pieces of pure logic
 * among the new integrations are handled the way test-motion handles paintFigure:
 * the search slice is lifted straight out of app.js's own text, and tour.js — which
 * is a real module and can be imported as one — is imported for real. The rest is
 * checked where it lives, in the source text, because it is wiring rather than
 * arithmetic and the alternative is a browser.
 *
 * What it pins, and why each one matters:
 *   · Fuse.js ranks a query the way the search field promises — a typo ("cofee",
 *     "sainsburys") still finds the entry, and the category, the account and the
 *     amount are searchable, not just the description. The ranker is the VENDORED
 *     library (require()d out of vendor/fuse.min.js), not a stand-in, so a
 *     vendored build that behaves differently fails here;
 *   · with no library the field is still live — the local matcher answers, and the
 *     filters compose with either;
 *   · a search is a ranking (the closest match first) while an empty field leaves
 *     the month's own newest-first order untouched;
 *   · the tour's steps cover the tabs the user actually has, in nav order, with the
 *     welcome and the menu around them — and every anchor is a FUNCTION, because
 *     app.js replaces #app wholesale on every navigation (a captured node would be
 *     detached a second later);
 *   · a tour that cannot load says so ('unavailable') instead of opening an empty
 *     overlay, and a second tour while one is running is refused;
 *   · every vendor path referenced by the app exists on disk and is not empty — a
 *     typo'd path is a widget that silently degrades to nothing;
 *   · the focus trap's two load-order rules and its two Escape rules (see below).
 *
 * Run: node scripts/test-ui-libs.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tourSteps, startTour, ADVANCE_BUDGET } from '../tour.js';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const appSrc = readFileSync(new URL('app.js', root), 'utf8');
const tescoSrc = readFileSync(new URL('tesco.js', root), 'utf8');
const tourSrc = readFileSync(new URL('tour.js', root), 'utf8');

let pass = 0;
const fails = [];
function ok(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n     got ${g}\n    want ${w}`);
}

// ============================================================
// 1. The search: app.js's own slice, against the vendored Fuse
// ============================================================
const from = appSrc.indexOf('function fuzzyMatch(text, query) {');
const to = appSrc.indexOf('function findPotentialDuplicate(entry) {');
if (from < 0 || to < 0 || to <= from) {
  console.error('test-ui-libs: the search slice is no longer where this harness looks for it in app.js.');
  process.exit(1);
}
const searchCode = appSrc.slice(from, to);
if (!/function searchEntries/.test(searchCode) || !/function rankEntries/.test(searchCode) || searchCode.length > 6000) {
  console.error(`test-ui-libs: lifted an implausible search slice (${searchCode.length} chars) — check the markers in app.js.`);
  process.exit(1);
}

const CATEGORY_LABELS = { food: 'Groceries', travel: 'Travel', bills: 'Bills' };
const METHOD_LABELS = { card: 'Card', cash: 'Cash', revolut: 'Revolut' };
const buildSearch = (Fuse) => new Function(
  'Fuse', 'loadVendor', 'categoryLabel', 'methodShort', 'fmt',
  searchCode + '\nreturn { searchEntries, rankEntries, localSearch, fuzzyMatch, ensureSearchLib };'
)(
  Fuse,
  (name, assets) => { buildSearch.loaded.push([name, assets]); return Promise.resolve(); },
  (id) => CATEGORY_LABELS[id] || String(id || ''),
  (id) => METHOD_LABELS[id] || String(id || ''),
  (n) => `€${Number(n).toFixed(2)}`,
);
buildSearch.loaded = [];

const entries = [
  { id: 'a', date: '2026-09-24', amount: 12.4, type: 'expense', details: 'Sainsbury’s run', note: 'weekly shop', category: 'food', method: 'card' },
  { id: 'b', date: '2026-09-23', amount: 4.2, type: 'expense', details: 'Coffee', note: '', category: 'food', method: 'cash' },
  { id: 'c', date: '2026-09-22', amount: 61.5, type: 'expense', details: 'Train ticket', note: 'Dublin', category: 'travel', method: 'card' },
  { id: 'd', date: '2026-09-21', amount: 89.99, type: 'expense', details: 'Electricity', note: '', category: 'bills', method: 'revolut' },
];
const none = buildSearch(undefined);
const withFuse = buildSearch(FuseExport());

function FuseExport() {
  const mod = require('../vendor/fuse.min.js');
  return mod && mod.default ? mod.default : mod;
}
ok('the vendored Fuse.js is require-able and is a constructor', typeof FuseExport(), 'function');

const ids = list => list.map(e => e.id);

// The fallback: the local subsequence matcher, and the filters it composes with.
ok('with no library the field still answers', ids(none.searchEntries(entries, 'coffee', {})), ['b']);
ok('and matches by subsequence, not by field', ids(none.searchEntries(entries, 'cofee', {})), ['b']);
// The floor reads the SAME fields the ranker does — the description, the note, the
// category, the account and the amount as printed — so searching for an account or
// an amount works before the library lands. What it cannot do is forgive: it is a
// subsequence matcher, so a wrong letter is a miss ("electricety") and a short query
// over-matches (every letter of "elec" appears somewhere in three different rows).
// Those two lines are exactly what the library buys, and they are pinned below.
ok('without the library the same fields still answer',
  [ids(none.searchEntries(entries, 'revolut', {})), ids(none.searchEntries(entries, '12.40', {}))], [['d'], ['a']]);
ok('but a wrong letter is a miss, and a short query over-matches',
  [ids(none.searchEntries(entries, 'electricety', {})), ids(none.searchEntries(entries, 'elec', {}))],
  [[], ['a', 'c', 'd']]);
ok('an empty query returns the entries untouched', ids(none.searchEntries(entries, '', {})), ['a', 'b', 'c', 'd']);
ok('filters apply without a query', ids(none.searchEntries(entries, '', { category: 'food' })), ['a', 'b']);
ok('and with one', ids(none.searchEntries(entries, 'sainsbury', { method: 'card' })), ['a']);
ok('a filter that matches nothing yields nothing', ids(none.searchEntries(entries, 'coffee', { category: 'travel' })), []);

// The real library. A typo, a transposition, a field other than the description,
// and the amount as it is printed.
ok('a typo still finds the entry', ids(withFuse.searchEntries(entries, 'cofee', {})), ['b']);
ok('a missing letter still finds it', ids(withFuse.searchEntries(entries, 'sainsburys', {})), ['a']);
ok('and so does a wrong one', ids(withFuse.searchEntries(entries, 'electricty', {})), ['d']);
ok('the account a row was paid from is searchable', ids(withFuse.searchEntries(entries, 'revolut', {})), ['d']);
ok('the category it shows under is searchable', ids(withFuse.searchEntries(entries, 'travel', {})), ['c']);
ok('the note is searchable', ids(withFuse.searchEntries(entries, 'weekly shop', {})), ['a']);
// The amount is matched by the ranker and stays precise: at threshold 0.4 this query
// also returned the €61.50 row, which is why the setting is 0.3 (see app.js).
ok('the amount as printed finds that row and only it',
  [ids(withFuse.searchEntries(entries, '12.40', {})), ids(withFuse.searchEntries(entries, '89.99', {}))], [['a'], ['d']]);
ok('a partial word still finds it', ids(withFuse.searchEntries(entries, 'elec', {})), ['d']);
ok('a query that matches nothing yields nothing', ids(withFuse.searchEntries(entries, 'zzzzz', {})), []);
ok('the filters still compose with the ranker',
  ids(withFuse.searchEntries(entries, 'coffee', { method: 'card' })), []);
ok('and a query plus a matching filter keeps the match',
  ids(withFuse.searchEntries(entries, 'coffee', { method: 'cash' })), ['b']);
// A ranking, not a calendar: the closest match comes first, whatever its date.
const ranked = withFuse.searchEntries(entries, 'sainsbury', {});
ok('the ranker decides the order of a search', ids(ranked), ['a']);
ok('an exact description outranks a same-word note', ids(withFuse.searchEntries(entries, 'dublin', {})), ['c']);
ok('and an empty query is not ranked at all',
  ids(withFuse.searchEntries(entries, '', {})), ids(entries));

// The lazy fetch: started by a query rather than by a page load, and asked for by
// name only (loadVendor itself is the cache, so a second ask costs nothing).
buildSearch.loaded.length = 0;
withFuse.searchEntries(entries, 'coffee', {});
ok('a search with the library in place fetches nothing', buildSearch.loaded.length, 0);
none.searchEntries(entries, 'coffee', {});
ok('without it, a query fetches the ranker', buildSearch.loaded, [['fuse', { js: 'vendor/fuse.min.js' }]]);
ok('and an empty field never does', (() => { buildSearch.loaded.length = 0; none.searchEntries(entries, '', {}); return buildSearch.loaded.length; })(), 0);

// ============================================================
// 2. The tour: the real module, driven by a fake driver.js
// ============================================================
const ROUTES = ['dashboard', 'add', 'history', 'balances', 'tesco', 'insights'];
const steps = tourSteps(ROUTES);
ok('a welcome, one step per tab, and the menu', steps.length, ROUTES.length + 2);
ok('the welcome has no element (it is centred)', 'element' in steps[0], false);
ok('every tab step anchors lazily, as a function',
  steps.slice(1, -1).map(s => typeof s.element), ROUTES.map(() => 'function'));
ok('the last step anchors on the menu trigger', typeof steps[steps.length - 1].element, 'function');
ok('every step carries a title and a description',
  steps.every(s => typeof s.popover.title === 'string' && s.popover.title.length > 0
    && typeof s.popover.description === 'string' && s.popover.description.length > 20), true);
// The hook lives on the POPOVER, not on the step — driver.js 1.8 reads
// `step.popover.onNextClick` and falls back to the instance config, so a hook on the
// step itself is silently ignored and the click then runs driver's own advance: the
// popovers walk forward while the screen never leaves the tab the tour was opened
// from. That is what the first live run did, with the wiring exactly as it looks
// below when written one level up.
ok('the steps that move the tour carry a popover hook',
  steps.slice(0, -1).every(s => typeof s.popover.onNextClick === 'function'), true);
ok('and never a step-level one, which driver would ignore',
  steps.every(s => !('onNextClick' in s)), true);
ok('the menu step has neither (it is the last one)',
  ['onNextClick' in steps[steps.length - 1], 'onNextClick' in steps[steps.length - 1].popover], [false, false]);
ok('every step carries its words on the popover, hook and all',
  steps.every(s => s.popover.side !== undefined), true);

// An unknown route is skipped rather than staged with an empty popover, and a tour
// of one tab (or none) is not a tour.
ok('a route with no copy is skipped', tourSteps(['dashboard', 'nonsense', 'history']).length, 4);
ok('the order is the nav order it was handed', tourSteps(['tesco', 'dashboard']).length, 4);

// startTour against a fake library, with a fake loader: the wiring (not the DOM).
const stubGlobals = () => {
  const created = [];
  const frames = [];          // the frame callbacks a step's advance is waiting on
  created.frames = frames;
  globalThis.MutationObserver = class { observe() { this.observing = true; } disconnect() { this.observing = false; } };
  globalThis.document = { getElementById: () => null, body: {} };
  // A Location that behaves like one: goTo() assigns a bare route and the browser
  // is what puts the '#' in front of it.
  let hash = '#history';
  globalThis.location = { get hash() { return hash; }, set hash(v) { hash = String(v).startsWith('#') ? String(v) : `#${v}`; } };
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.driver = {
    js: {
      driver: (config) => {
        const instance = {
          config,
          driven: false,
          moveNextCount: 0,
          drive() { this.driven = true; },
          moveNext() { this.moveNextCount++; },
          refresh() {},
          destroy() { config.onDestroyed && config.onDestroyed(); },
        };
        created.push(instance);
        return instance;
      },
    },
  };
  return created;
};
const loaderCalls = [];
const fakeLoad = (name, assets) => { loaderCalls.push([name, assets]); return Promise.resolve(); };

let created = stubGlobals();
let endedWith = null;
let res = await startTour({ routes: ROUTES, loadVendor: fakeLoad, onEnd: (why) => { endedWith = why; } });
ok('a tour starts and drives the first step', [res, created.length, created[0].driven], ['started', 1, true]);
ok('it asks for the vendored driver.js and its stylesheet', loaderCalls,
  [['driver', { js: 'vendor/driver.js.iife.js', css: 'vendor/driver.css' }]]);
const cfg = created[0].config;
ok('the configuration the vendored factory is handed',
  [cfg.steps.length, cfg.allowClose, cfg.showProgress, cfg.nextBtnText, cfg.prevBtnText, cfg.doneBtnText, cfg.progressText, typeof cfg.overlayColor],
  [ROUTES.length + 2, true, true, 'Next', 'Back', 'Done', '{{current}} of {{total}}', 'string']);
ok('the tour is destroyable (its steps end it)', typeof cfg.onDestroyed, 'function');

// A step's Next has two jobs, and driver.js hands a hook the whole click: the hook it
// overrides IS driver's advance, so a hook that only navigates walks the popovers
// nowhere and one that only advances describes a screen the user is not looking at.
// Both halves are driven here, against the module's own steps.
const hook = steps[1].popover.onNextClick;
const settle = (from) => { globalThis.location.hash = from; created.frames.length = 0; created[0].moveNextCount = 0; };
globalThis.location.hash = '#history';       // where the tour was opened from
created.frames.length = 0;
created[0].moveNextCount = 0;
ok('a tab step hands its popover the hook driver will call', typeof hook, 'function');
if (typeof hook === 'function') hook();
ok('and does not advance before the frame it is waiting for', created[0].moveNextCount, 0);
for (const frame of created.frames.splice(0)) frame();
ok('the advance lands when that frame does', created[0].moveNextCount, 1);
// The frame is not guaranteed to arrive, so the wait is bounded — and a frame that
// does arrive wins, because the timeout is cleared and the move happens once.
created[0].moveNextCount = 0;
if (typeof hook === 'function') hook();
await new Promise(r => setTimeout(r, ADVANCE_BUDGET + 120));
ok('a step still advances when no frame ever comes', created[0].moveNextCount, 1);
ok('the bound is what makes that true', typeof ADVANCE_BUDGET === 'number' && ADVANCE_BUDGET > 0, true);

// Where a step's Next takes the screen: the NEXT popover's tab, because that popover
// is the one that opens under it. Taking the step's own tab lands one screen behind —
// the Insights popover over the Tesco tab, which is what shipped before this.
const dest = (from, i) => { settle(from); if (typeof hook === 'function') steps[i].popover.onNextClick(); return globalThis.location.hash; };
ok('a step’s Next shows the tab the next popover is about', dest('#history', 1), '#add');
ok('the welcome hands over to the first tab', dest('#history', 0), '#dashboard');
ok('and a mid-tour step follows the same rule', dest('#dashboard', 4), '#tesco');
// The last tab step has nowhere to go: the menu step it hands over to is anchored in
// the header, which is on every screen.
ok('the last tab step navigates nowhere', dest('#dashboard', steps.length - 2), '#dashboard');
for (const frame of created.frames.splice(0)) frame();   // drain, so nothing runs later

// A second tour while one is running is refused, and the end of the first frees it.
const second = await startTour({ routes: ROUTES, loadVendor: fakeLoad });
ok('one tour at a time', second, 'busy');
ok('and the refused one reports nothing (it never ran)', endedWith, null);
created[0].destroy();
ok('the first tour reports how it ended', endedWith, 'closed');
created = stubGlobals();
ok('and after it, a new one starts', await startTour({ routes: ROUTES, loadVendor: fakeLoad }), 'started');
created[0].destroy();

// Nothing to tour, and a library that cannot be fetched.
ok('a single tab is not a tour', await startTour({ routes: ['dashboard'], loadVendor: fakeLoad }), 'too-few-tabs');
ok('no routes at all is not a tour either', await startTour({ routes: [], loadVendor: fakeLoad }), 'too-few-tabs');
const failedLoad = () => Promise.reject(new Error('offline'));
let why = null;
ok('a library that cannot be fetched says so',
  await startTour({ routes: ROUTES, loadVendor: failedLoad, onEnd: (r) => { why = r; } }), 'unavailable');
ok('and reports it to the caller', why, 'unavailable');
// A loader that resolves but never defines the factory is the same failure.
delete globalThis.driver;
ok('a library that loads but defines nothing says so',
  await startTour({ routes: ROUTES, loadVendor: fakeLoad }), 'unavailable');

// ============================================================
// 3. The wiring: paths, order and the focus trap
// ============================================================
// Every vendor path the app can ask for exists, and is a real file rather than an
// empty one. A path spelled wrong is a widget that silently degrades, which is
// exactly the failure this catches.
const vendorPaths = [...new Set([
  ...[...appSrc.matchAll(/'(vendor\/[^']+)'/g)].map(m => m[1]),
  ...[...tescoSrc.matchAll(/'(vendor\/[^']+)'/g)].map(m => m[1]),
  ...[...tourSrc.matchAll(/'(vendor\/[^']+)'/g)].map(m => m[1]),
])].sort();
ok('the app references the vendor files this harness expects', vendorPaths.length >= 10, true);
ok('every vendor path exists and is not empty',
  vendorPaths.filter(p => {
    try { return statSync(fileURLToPath(new URL(p, root))).size > 0; } catch { return false; }
  }), vendorPaths);

// The focus trap: tabbable must be fetched BEFORE focus-trap (its UMD reads
// window.tabbable as it loads — the same trap popper → tippy has), the trap must be
// driven by the DOM rather than by each of the twenty call sites, and it must not
// take Escape away from the modals that already handle it.
const tabbableAt = appSrc.indexOf("loadVendor('tabbable'");
const focusTrapAt = appSrc.indexOf("loadVendor('focus-trap'");
ok('focus-trap is fetched (and tabbable before it)',
  [tabbableAt > 0, focusTrapAt > 0, tabbableAt < focusTrapAt], [true, true, true]);
ok('the trap follows the DOM: an observer on .modal-bg',
  /new MutationObserver\(queue\)\.observe\(document\.body, \{ childList: true \}\)/.test(appSrc)
  && /querySelectorAll\('\.modal-bg'\)/.test(appSrc), true);
ok('and it is installed once, at boot',
  (appSrc.match(/wireModalFocusTrap\(\)/g) || []).length, 2);   // the declaration's caller and boot
ok('Escape stays the modals\' own business (isTopModal)',
  /escapeDeactivates: false/.test(appSrc), true);
ok('the trap is built with focus-trap\'s own factory',
  /focusTrap\.createFocusTrap\(top, \{/.test(appSrc), true);
// Tabbing inside a modal must not be able to reach the page behind it, and the two
// modal systems (app.js's and tesco.js's) both produce `.modal-bg`.
ok('both modules produce the same modal element for the observer to see',
  (appSrc.match(/class: 'modal-bg'/g) || []).length >= 15
  && (tescoSrc.match(/class: 'modal-bg'/g) || []).length >= 2, true);
ok('and tesco.js appends them through app.js\'s own stackModal',
  /stackModal\(bg\)/.test(tescoSrc), true);
// The workbook import reaches SheetJS through the one lazy loader, with the path
// this harness checked above, and it is not on the boot path.
ok('the workbook reader uses the app\'s lazy loader',
  /loadVendor\('xlsx', \{ js: 'vendor\/xlsx\.mini\.min\.js' \}\)/.test(tescoSrc), true);
ok('the CSV path does not touch SheetJS at all',
  /workbook = \/\\\.\(xlsx\|xlsm\)\$\/i\.test\(file\.name\)/.test(tescoSrc), true);

// ============================================================
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-ui-libs: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-ui-libs: OK — ${total} assertions passed (the search ranks through the vendored Fuse, the tour stages itself lazily on the nav, and every vendor path resolves)`);
