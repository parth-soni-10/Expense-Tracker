#!/usr/bin/env node
/**
 * Guards the accessibility of the app — and, just as much, the harness that is
 * the only thing able to SEE it.
 *
 * A Node script cannot read a rendered DOM, so the audit itself walks the real
 * app out of a11y-harness.html at http://localhost:PORT/a11y-harness.html. What
 * a Node script can do is stop that harness from quietly ceasing to look:
 *
 *   1. Every route the app has (seed.js's TABS) must be a surface the harness
 *      drives. Add a tab and the harness is a page that no longer covers the
 *      app it claims to cover — and it reports 0 problems for the part it
 *      skipped, which reads exactly like a pass.
 *   2. Every menu level app.js can drill into must be one too, and so must every
 *      modal the MENU opens. The harness names those openers in MODAL_OPENERS
 *      precisely so they can be asserted against app.js's own buildMenuLevel()
 *      rather than against a hand-kept prose list.
 *   3. The harness's verdict has to be the sum of all four defects it looks
 *      for. A summary that counted only unnamed controls would report "0
 *      problems" over a screen full of duplicate aria-labels — and aria-label is
 *      an ADDRESSED IDENTITY in this app (restoreFocusedField looks fields up by
 *      it), so two controls sharing one is a bug that reaches the wrong field.
 *   4. The harness stays dev-only: 404'd at the CDN and listed in .netlifyignore.
 *      It loads the whole app in an iframe and drives it; it is not a page to
 *      serve to a stranger.
 *   5. The one defect this guard can see statically is the one that actually
 *      shipped: an ICON-ONLY monthNav button with no aria-label. Its label is an
 *      svg span with aria-hidden, so the button reads as "button, dimmed" and
 *      nothing else. Every monthNav call whose visible label is an icon must
 *      carry the fourth argument, and the helper must be what writes it.
 *   6. The audit runs in a state a user can actually be in. A first run puts the
 *      setup overlay over the whole viewport, so the harness has to walk it out
 *      before it drives the menu — and it must never seed storage to do it,
 *      because it is served from the app's own origin and would overwrite the
 *      ledger it promises not to touch.
 *   7. The harness stays named in README.md and CLAUDE.md — an audit nobody
 *      knows about is one nobody runs, and the page is worthless if the next
 *      person to touch app.js never learns it exists.
 *
 * Run standalone:
 *
 *   node scripts/check-a11y.mjs
 *
 * Also wired as a predeploy build step in netlify.toml.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const problems = [];
const fail = (msg) => problems.push(msg);

// ---- the harness has to exist at all
const HARNESS = 'a11y-harness.html';
if (!existsSync(join(root, HARNESS))) {
  console.error(`${HARNESS} is gone — the only accessibility audit this project has, gone with it.`);
  process.exit(1);
}
const harness = read(HARNESS);
const app = read('app.js');
const seed = read('seed.js');
const toml = read('netlify.toml');

// ---- 1./2. what the harness drives, against what the app has
const stepsBlock = harness.match(/const STEPS = \[([\s\S]*?)\n\];/);
if (!stepsBlock) {
  fail(`${HARNESS}: could not find the STEPS array — this guard reads its surfaces from there.`);
}
const surfaces = stepsBlock ? [...stepsBlock[1].matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]) : [];

// Routes: seed.js is the app's own list of tabs, so the two cannot drift.
const tabsBlock = seed.match(/export const TABS = \[([^\]]*)\]/);
if (!tabsBlock) fail('seed.js no longer exports a TABS array — the harness cannot be checked against it.');
const tabs = tabsBlock ? [...tabsBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
for (const tab of tabs) {
  // '#history' or a surface that starts from it ('#add · split across methods').
  if (!surfaces.some(name => name === `#${tab}` || name.startsWith(`#${tab} `))) {
    fail(`${HARNESS} drives no surface for the #${tab} route — add a step, or the audit silently skips a whole tab and reports 0 problems for it.`);
  }
}

// Menu levels: read out of app.js, not out of the harness's prose.
const drills = new Set([...app.matchAll(/menuDrill\('([^']+)'\)/g)].map(m => m[1]));
// The step has to be a `menu · …` one: a modal that happens to mention the same
// word ("modal · privacy PIN") is a different surface from the level it was
// opened from, so a substring match against every step name would let a renamed
// menu step be "covered" by the modal below it.
const menuSteps = surfaces.filter(name => name.startsWith('menu · '));
for (const id of drills) {
  if (!menuSteps.some(name => name.toLowerCase().includes(id.toLowerCase()))) {
    fail(`app.js drifts the menu into "${id}" and ${HARNESS} has no menu step for it — a menu level nobody audits.`);
  }
}

// Modals the menu opens. MODAL_OPENERS in the harness is the declaration; the
// guard is what makes it true of the code beside it.
const menuBlock = app.match(/function buildMenuLevel\(id\) \{([\s\S]*?)\n\}\n/);
if (!menuBlock) fail('app.js no longer has buildMenuLevel() — the harness\'s MODAL_OPENERS list cannot be checked against anything.');
const openers = new Set(menuBlock ? [...menuBlock[1].matchAll(/\b((?:open|show|start)[A-Z][\w$]*)\s*\(/g)].map(m => m[1]) : []);
// Not audited, and each for a reason this file states rather than assumes:
//   openRestorePicker  — the OS file dialog, which a page cannot see or dismiss;
//   startAppTour       — driver.js popovers live on <body>, outside every scope
//                        a11y-harness.html reads;
//   showProfilePicker  — the menu row and the header chip that open it exist only
//                        when the device holds more than one profile, so a step
//                        for it would report "skipped" on every ordinary run.
const UNAUDITABLE = new Set(['openRestorePicker', 'startAppTour', 'showProfilePicker']);
const declared = new Set([...harness.matchAll(/const MODAL_OPENERS = \[([\s\S]*?)\];/g)]
  .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])));
if (!declared.size) fail(`${HARNESS}: no MODAL_OPENERS list — this guard reads which menu modals are audited from it.`);
for (const name of openers) {
  if (UNAUDITABLE.has(name)) continue;
  if (!declared.has(name)) {
    fail(`app.js's menu opens ${name}(), which ${HARNESS} neither audits (add it to MODAL_OPENERS and give it a step) nor exempts.`);
  }
}
for (const name of declared) {
  if (!openers.has(name)) {
    fail(`${HARNESS} claims to audit ${name}(), which app.js's menu no longer opens — a stale claim reads as coverage.`);
  }
}

// ---- 3. the verdict is the sum of all four defects
const KEYS = ['unnamed', 'dupes', 'unlabelledFields', 'noAlt'];
const sum = KEYS.map(k => `r.${k}.length`).join(' + ');
if (!harness.includes(sum)) {
  fail(`${HARNESS}: "problems" is no longer ${KEYS.join(' + ')} — a run that stops counting one of them reports a clean screen it never looked at.`);
}
for (const key of KEYS) {
  // Present on the per-surface result, in both the initialiser and the row.
  if (!new RegExp(`\\b${key}\\s*:`).test(harness)) fail(`${HARNESS} no longer reports ${key} per surface.`);
}
if (!/window\.__a11yReport\s*=/.test(harness) || !/window\.__a11yProgress\s*=/.test(harness)) {
  fail(`${HARNESS} must publish __a11yReport (the verdict) and __a11yProgress (where a stalled run got to).`);
}

// ---- 4. a dev-only page stays dev-only
const redirect = toml.match(/from = "\/a11y-harness\.html"([\s\S]{0,200})/);
if (!redirect || !/status = 404/.test(redirect[1]) || !/force = true/.test(redirect[1])) {
  fail('netlify.toml no longer 404s /a11y-harness.html (needs status = 404 AND force = true) — the page that loads and drives the whole app would ship to the live site.');
}
if (!/^a11y-harness\.html\s*$/m.test(read('.netlifyignore'))) {
  fail('.netlifyignore does not list a11y-harness.html — the dev page would be uploaded with the site.');
}

// ---- 5. the icon-only control that shipped unnamed
/** The argument list of the call whose '(' is at `open`, as raw source text. */
function callArgs(source, open) {
  const args = [];
  let depth = 0;
  let current = '';
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { args.push(current); return args; }
    }
    if (ch === ',' && depth === 1) { args.push(current); current = ''; continue; }
    if (depth >= 1) current += ch;
  }
  return null;
}
let calls = 0;
for (const m of app.matchAll(/\bmonthNav\(/g)) {
  const args = callArgs(app, m.index + m[0].length - 1);
  if (!args) {
    fail('could not read a monthNav() call in app.js — this guard parses its arguments to check the label.');
    continue;
  }
  calls += 1;
  if (!args.length || args[0].includes('iconSpan(')) {
    // An icon label is invisible to a screen reader; the name has to come from
    // the fourth argument.
    if (!args[3] || !/'[^']+'/.test(args[3])) {
      fail(`a monthNav() call with an icon label passes no aria-label (call #${calls}) — the chevrons shipped reading as "button, dimmed".`);
    }
  }
}
if (!calls) fail('app.js has no monthNav() call left — this guard is checking nothing.');
if (!/setAttribute\('aria-label', ariaLabel\)/.test(app)) {
  fail('monthNav() no longer writes the aria-label it is given — every nameless chevron would come back at once.');
}

// ---- 6. the audit has to run in a state a user can actually be in
// A first run puts the setup overlay over the whole viewport, and nothing in the
// menu is reachable behind it. A run that drives the menu anyway audits an
// unreachable screen — and that is not hypothetical: it is how a fresh device
// reported "New PIN x2", the overlay's own PIN fields counted as duplicates of
// the menu's. So the harness must walk the overlay out (through the app's own
// skip control, never by writing storage) before it audits.
if (!/querySelector\('\.onboarding-bg'\)/.test(harness)) {
  fail(`${HARNESS} does not deal with the first-run setup overlay — a run on a fresh device would audit screens no user can reach.`);
}
// Assert the CALL SITES, not the strings: a function that is defined and never
// called is the exact dead-code pattern this repo has already shipped once, and
// a rule that only greps for a name is satisfied by an unused definition. Both
// entry points matter — the first load happens outside resetFrame(), and every
// step after it reloads — so one call site is not enough to be sure.
const dismissCalls = (harness.match(/await\s+dismissOnboarding\s*\(\)/g) || []).length;
if (dismissCalls < 2) {
  fail(`${HARNESS}: the onboarding overlay is dismissed ${dismissCalls} time(s) — it must be walked out on the first load AND on every per-step reload, or the steps past the first audit behind it.`);
}
if (!/onboarding:\s*onboardingNote/.test(harness)) {
  fail(`${HARNESS} must carry what it did about onboarding into __a11yReport, so a run that audited behind the overlay cannot look clean.`);
}
// Two surfaces can only open when the device already holds data, so they are the
// two steps that legitimately skip on a fresh ledger — and a skip has to SAY why.
// The guard names them because which surfaces depend on data is a fact about the
// app, not about the harness's shape; what it insists on is the declaration, so a
// skipped surface can never be read as a clean one.
const DATA_DEPENDENT = ['#history · bulk bar (selection on)', '#tesco · edit sheet'];
for (const name of DATA_DEPENDENT) {
  const at = harness.indexOf(`name: '${name}'`);
  if (at < 0) {
    fail(`${HARNESS} no longer drives "${name}" — this guard names it because it is a surface that needs data on the device.`);
  } else if (!/needs:/.test(harness.slice(at, at + 220))) {
    fail(`${HARNESS}: "${name}" can skip without saying why — give the step a needs: reason, or a skip reads as coverage.`);
  }
}
if (!/needs:\s*step\.needs/.test(harness)) {
  fail(`${HARNESS} must carry a step's needs: reason into its result, or the reason never reaches __a11yReport.`);
}
// The note describes the RUN, not the last frame — the overlay is gone by step
// two, so a note that is simply reassigned reports "no setup overlay" for a run
// whose first step had one. And an overlay that would not close must not read as
// clean: the surfaces behind it were never reachable.
// The CALL SITES again, not the name: matching /noteOnboarding\(/ is satisfied by
// the function's own definition, which is exactly how a rule like this goes quiet.
const foldCalls = (harness.match(/noteOnboarding\(await dismissOnboarding\(\)\)/g) || []).length;
if (foldCalls < 2) {
  fail(`${HARNESS}: the overlay outcome is folded into a run-level note ${foldCalls} time(s) — both entry points must fold it, or a later reload overwrites the note.`);
}
if (!/onboardingStuck/.test(harness) || !/\bconst broken = [^;]*onboardingStuck/.test(harness)) {
  fail(`${HARNESS}: an overlay that would not close must make the run non-clean, or an audit of unreachable screens reports as a pass.`);
}
// And it must never write the ledger: this page is served from the app's own
// origin, so it shares the app's localStorage. Seeding a document here would
// overwrite the very ledger the harness promises not to change.
if (/localStorage\s*\.\s*(setItem|removeItem|clear)\s*\(/.test(harness)) {
  fail(`${HARNESS} writes to localStorage — it shares the app's origin, so that overwrites the user's real ledger. Dismiss the overlay through the app's controls instead.`);
}

// ---- 7. and the harness has to stay documented, or nobody runs it
const readme = read('README.md');
const claude = read('CLAUDE.md');
for (const [name, text] of [['README.md', readme], ['CLAUDE.md', claude]]) {
  if (!text.includes('a11y-harness.html')) fail(`${name} does not mention a11y-harness.html — an audit nobody knows about is one nobody runs.`);
}

if (problems.length) {
  console.error(`check-a11y: ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-a11y: OK — ${surfaces.length} audited surface(s) cover all ${tabs.length} route(s), `
  + `${drills.size} menu level(s) and ${declared.size} menu modal(s); every icon-only nav control is named; the harness is dev-only.`);
