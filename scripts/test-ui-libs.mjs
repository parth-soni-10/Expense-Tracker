#!/usr/bin/env node
/**
 * Vendored-UI harness — the three libraries wired in beside the app's own code.
 *
 * app.js cannot be imported anywhere (it touches the DOM the moment it is
 * evaluated) and this repo has no test framework, so the one piece of pure logic
 * among the integrations is handled the way test-motion handles paintFigure: the
 * search slice is lifted straight out of app.js's own text. The rest is checked
 * where it lives, in the source text, because it is wiring rather than arithmetic
 * and the alternative is a browser.
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
 *   · every vendor path referenced by the app exists on disk and is not empty — a
 *     typo'd path is a widget that silently degrades to nothing;
 *   · the focus trap's two load-order rules and its two Escape rules (see below).
 *
 * Run: node scripts/test-ui-libs.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const appSrc = readFileSync(new URL('app.js', root), 'utf8');
const tescoSrc = readFileSync(new URL('tesco.js', root), 'utf8');

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
  searchCode + '\nreturn { searchEntries, rankEntries, localSearch, fuzzyMatch, ensureSearchLib, bumpSearchIndex, peekSearchIndex: () => ({ version: fuseVersion, cache: fuseCache }) };'
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

// The index is built once per DATA VERSION, not once per keystroke: every
// mutation clears the balance caches (which bumps the version here), while
// typing changes no data and reuses the index it already has. Two failure modes
// this pins — rebuilding the whole index per keystroke (the felt lag), and
// NEVER rebuilding (a new entry that no query can find because the version guard
// never fires).
const idx = withFuse.peekSearchIndex;
const firstFuse = idx().cache.fuse;
ok('the first ranked query builds one index', !!firstFuse && idx().cache.version === idx().version, true);
withFuse.searchEntries(entries, 'coffee', {});
withFuse.searchEntries(entries, 'train', {});
ok('and the next queries reuse it rather than rebuild it',
  withFuse.peekSearchIndex().cache.fuse === firstFuse, true);
ok('before a bump the index still answers for the entries as they were',
  ids(withFuse.searchEntries(entries, 'bakery', {})), []);
const beforeBump = idx().version;
withFuse.bumpSearchIndex();
const dropped = withFuse.peekSearchIndex();
ok('a data change bumps the version and drops the cached index',
  [dropped.cache.fuse === null, dropped.version === beforeBump + 1], [true, true]);
entries.push({ id: 'e', date: '2026-09-25', amount: 3.5, type: 'expense', details: 'Bakery', note: '', category: 'food', method: 'cash' });
ok('and the next query rebuilds against the entries as they are now',
  ids(withFuse.searchEntries(entries, 'bakery', {})), ['e']);

// ============================================================
// 2. The wiring: paths, order and the focus trap
// ============================================================
// Every vendor path the app can ask for exists, and is a real file rather than an
// empty one. A path spelled wrong is a widget that silently degrades, which is
// exactly the failure this catches.
const vendorPaths = [...new Set([
  ...[...appSrc.matchAll(/'(vendor\/[^']+)'/g)].map(m => m[1]),
  ...[...tescoSrc.matchAll(/'(vendor\/[^']+)'/g)].map(m => m[1]),
])].sort();
ok('the app references the vendor files this harness expects', vendorPaths.length >= 10, true);
ok('every vendor path exists and is not empty',
  vendorPaths.filter(p => {
    try { return statSync(fileURLToPath(new URL(p, root))).size > 0; } catch { return false; }
  }), vendorPaths);

// The guided tour is gone, and the absence is pinned rather than trusted: it was a
// walkthrough for a stranger's first run, which an app with one user does not need,
// so app.js carries no tour wiring, no tour module is imported, and no driver.js
// asset is named. This is where that coverage lived (the steps, the popover hook,
// the advance bound) — a pin that names the thing it lost is how the removal stays
// a decision instead of an accident. The two structural halves are pinned elsewhere
// anyway: a re-imported tour module fails check-boot-payload's boot ledger, and a
// re-named driver path fails the "every vendor path exists" assertion above.
// Both are substring tests rather than word tests on purpose: a re-addition is as
// likely to arrive as `tourSteps` or `loadVendor('driver')` as it is as the word on
// its own, and app.js holds no occurrence of either string today — so the pin is as
// strict as the removal was, and a mutation that appends one identifier fails it.
// It does mean a comment in app.js cannot mention the tour either: that note belongs
// here, in the harness that lost the coverage, rather than in the app's own text.
ok('the walkthrough is not wired into the app', /tour/i.test(appSrc), false);
ok('and no driver.js asset is named anywhere in it', /driver/i.test(appSrc), false);

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
// Counted as the CALL, not as the name: prose that mentions the function (the
// back-gesture block cites it as the pattern to follow) is not an installation,
// and a raw name count made this assertion fail on a comment.
ok('and it is installed once, at boot',
  (appSrc.match(/^\s*wireModalFocusTrap\(\);/gm) || []).length, 1);
ok('Escape stays the modals\' own business (isTopModal)',
  /escapeDeactivates: false/.test(appSrc), true);
ok('the trap is built with focus-trap\'s own factory',
  /focusTrap\.createFocusTrap\(top, \{/.test(appSrc), true);
// Tabbing inside a modal must not be able to reach the page behind it, and the two
// modal systems (app.js's and tesco.js's) both produce `.modal-bg` — the class is
// the observer's handle, so a module that swapped it for a class of its own would
// silently escape the trap. The count is a floor, not a census: the OCR removal
// took tesco.js's camera modal with it, leaving the shift editor, and a screen that
// grows another sheet should not fail this.
ok('both modules produce the same modal element for the observer to see',
  (appSrc.match(/class: 'modal-bg'/g) || []).length >= 15
  && (tescoSrc.match(/class: 'modal-bg'/g) || []).length >= 1, true);
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
console.log(`test-ui-libs: OK — ${total} assertions passed (the search ranks through the vendored Fuse, and every vendor path resolves)`);
