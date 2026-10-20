#!/usr/bin/env node
/**
 * The PORTED shell's accessibility harness.
 *
 * The shipping app has its own harness and its own guard
 * (`scripts/check-a11y.mjs`), and that one is still right: the old app keeps
 * serving until the cutover. This guard is the same contract for the app that
 * will take over — `app/a11y-harness.html`, driving `app/`.
 *
 * The contract:
 *
 *   1. The harness EXISTS. It is the only accessibility audit the ported app
 *      has, and it is a page that loads the real app in a visible frame and
 *      drives it through every route and every surface that OPENS.
 *   2. It drives EVERY route. The app's own route list is the source of truth,
 *      so the two cannot drift — a route nobody audits reports 0 problems and
 *      reads as a pass.
 *   3. It audits every sheet the app can open. The list in the harness is the
 *      declaration; this guard is what makes it true of the code beside it, and
 *      a stale claim reads as coverage.
 *   4. Its verdict is the SUM of all four defect classes — an unnamed control,
 *      a duplicated aria-label, an unlabelled field, an image without alt. A
 *      run that stops counting one of them reports a clean screen it never
 *      looked at.
 *   5. It stays a DEV-ONLY page. The list IS the control: the assets
 *      directory uploads what `.assetsignore` does not exclude, so a harness
 *      that is not excluded is a page that loads and drives the whole app,
 *      served to anyone who guessed its name.
 *
 * Run: node scripts/check-a11y-app.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const problems = [];
const fail = (msg) => problems.push(msg);

const HARNESS = 'app/a11y-harness.html';
if (!existsSync(join(root, HARNESS))) {
  console.error(`${HARNESS} is gone — the only accessibility audit the ported app has, gone with it.`);
  process.exit(1);
}
const harness = read(HARNESS);
// The harness's script is an EXTERNAL file, because the shell's policy is
// `script-src 'self'; style-src 'self'` with no hashes and no 'unsafe-inline'
// — an inline script in the harness would simply be refused. So the lists live
// in the JS beside it, and this guard reads them from there.
const harnessJs = read('app/a11y-harness.js');
const ignore = read('app/.assetsignore');
const router = read('app/src/router.ts');

/* ---- 1. it drives every route -------------------------------------------- */

const routesBlock = router.match(/export const ROUTES = \[([^\]]*)\]/);
if (!routesBlock) fail('app/src/router.ts no longer exports a ROUTES array — the harness cannot be checked against it.');
const routes = routesBlock ? [...routesBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const stepsBlock = harnessJs.match(/const STEPS = \[([\s\S]*?)\n\];/);
if (!stepsBlock) fail(`${HARNESS}: could not find the STEPS array — this guard reads its surfaces from there.`);
const surfaces = stepsBlock ? [...stepsBlock[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]) : [];

for (const route of routes) {
  if (!surfaces.some((name) => name === `#${route}` || name.startsWith(`#${route} `))) {
    fail(`${HARNESS} drives no surface for the #${route} route — add a step, or the audit silently skips a whole route and reports 0 problems for it.`);
  }
}

/* ---- 2. it audits every sheet the app can open --------------------------- */

/** The exported openers across the screens and the lock. */
function openersIn(file) {
  const source = read(file);
  return [...source.matchAll(/export\s+(?:async\s+)?function\s+(open[A-Z]\w*|show[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
}
const screenDir = join(root, 'app', 'src', 'screens');
const screenFiles = readdirSync(screenDir).filter((f) => f.endsWith('.ts')).map((f) => `app/src/screens/${f}`);
const openers = new Set([...screenFiles.flatMap(openersIn), ...openersIn('app/src/lock.ts')]);

// Not audited, and each for a reason this file states rather than assumes:
//   openAvatarPicker — it is reached only from the admin panel, and only for
//                      a profile that is not the owner, so a step for it would
//                      report "skipped" on an ordinary device. A skip has to
//                      mean "this device could not reach it".
//   openRenameDialog / openDeleteDialog — the admin panel's per-profile
//                      dialogs, which need a second profile to exist at all.
//   openInviteDialog — it asks the server for a token, so it cannot open
//                      without a configured deployment.
//   showProfilePicker — it is the "Who's tracking?" gate, which only appears
//                      when the device holds more than one profile, so a step
//                      for it would report "skipped" on an ordinary device.
const UNAUDITABLE = new Set(['openAvatarPicker', 'openRenameDialog', 'openDeleteDialog', 'openInviteDialog', 'showProfilePicker']);
const declared = new Set([...harnessJs.matchAll(/const MODAL_OPENERS = \[([\s\S]*?)\];/g)]
  .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
if (!declared.size) fail(`${HARNESS}: no MODAL_OPENERS list — this guard reads which sheets are audited from it.`);
for (const name of openers) {
  if (UNAUDITABLE.has(name)) continue;
  if (!declared.has(name)) {
    fail(`the app can open ${name}(), which ${HARNESS} neither audits (add it to MODAL_OPENERS and give it a step) nor exempts.`);
  }
}
for (const name of declared) {
  if (!openers.has(name)) {
    fail(`${HARNESS} claims to audit ${name}(), which the app no longer opens — a stale claim reads as coverage.`);
  }
}

/* ---- 3. the verdict is the sum of all four defects ----------------------- */

const KEYS = ['unnamed', 'dupes', 'unlabelledFields', 'noAlt'];
const sum = KEYS.map((k) => `r.${k}.length`).join(' + ');
if (!harnessJs.includes(sum)) {
  fail(`${HARNESS}: "problems" is no longer ${KEYS.join(' + ')} — a run that stops counting one of them reports a clean screen it never looked at.`);
}
for (const key of KEYS) {
  if (!new RegExp(`\\b${key}\\s*:`).test(harnessJs)) fail(`${HARNESS} no longer reports ${key} per surface.`);
}
if (!/window\.__a11yReport\s*=/.test(harnessJs) || !/window\.__a11yProgress\s*=/.test(harnessJs)) {
  fail(`${HARNESS} must publish __a11yReport (the verdict) and __a11yProgress (where a stalled run got to).`);
}

/* ---- 4. the state a run audits has to be reachable ----------------------- */

/* The ported shell's equivalent of the shipping app's first-run overlay is
 * the LOCK: with a PIN set the app paints nothing until it is unlocked, so a
 * run that unlocked everything and then drove the app would never see the
 * lock at all — and the lock is the one surface that protects the ledger. The
 * harness must therefore audit it WITH the lock up, which means a step that
 * opts out of the unlock. */
if (!/keepLocked/.test(harnessJs)) {
  fail(`${HARNESS} has no step that audits the lock screen — the lock is the surface that protects the ledger, and a run that unlocks first would never see it.`);
}
const keepLockedSteps = (harnessJs.match(/keepLocked:\s*true/g) || []).length;
if (!keepLockedSteps) fail(`${HARNESS}: no step opts out of the unlock — the lock would never be audited.`);

/* ---- 5. it stays a dev-only page ----------------------------------------- */

if (!/^a11y-harness\.html\s*$/m.test(ignore)) {
  fail('app/.assetsignore does not list a11y-harness.html — the dev page would be uploaded with the app, so the page that loads and drives the whole app would be served to anyone who guessed its name.');
}
// And the app must not load it: a harness in the app's own document would be
// a frame inside the frame it drives.
const index = read('app/index.html');
if (/a11y-harness/.test(index)) fail('app/index.html loads the harness — it must be opened by hand, not by the app.');

/* ---- 6. it must not seed the ledger -------------------------------------- */

// The harness is served from the app's own origin, so it shares the app's
// localStorage. Seeding the ledger here would overwrite a real one.
if (/localStorage\.setItem\(\s*['"]cents:/.test(harnessJs)) {
  fail(`${HARNESS} writes to the app's storage — it is served from the app's own origin, so a seeded document would overwrite the user's own ledger.`);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(`\ncheck-a11y-app: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check-a11y-app: OK — ${surfaces.length} surfaces, ${declared.size} sheets, every route driven`);
