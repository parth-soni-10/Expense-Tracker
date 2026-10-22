#!/usr/bin/env node
/**
 * Guards the browser leg that Gate C cannot run in CI.
 *
 * `scripts/pin-screens.browser.mjs` loads the frozen document into the rendered
 * app behind the test PIN and asserts the screens agree with it. It needs a
 * browser, so it is deliberately NOT in `scripts/run-guards.mjs`: this suite is
 * dependency-free by design, and making every push install Playwright to run one
 * leg is the trade the repo has refused everywhere else. The same problem
 * `check-a11y.mjs` solves for `a11y-harness.html` applies here — a browser check
 * nobody runs is one that silently rots — so this guard statically pins the
 * parts of the leg that must not drift:
 *
 *   1. It exists, and it still loads the frozen fixture rather than a fresh or
 *      synthetic document. A leg that seeds an empty ledger passes every
 *      assertion and proves nothing.
 *   2. It writes the document under the real key and unlocks with the built-in
 *      test PIN, in a **fresh** context (`newContext()` + an empty-storage
 *      assertion before the fixture goes in). A leg that inherits storage could
 *      be reading a developer's device.
 *   3. The clock stays pinned inside the fixture's month. The fixture is frozen
 *      in October 2026; without `page.clock.setFixedTime` the dashboard is keyed
 *      on the wall clock and the leg would go blank the month afterwards — a
 *      failure that looks like a product bug.
 *   4. The page is served under the production CSP read from `_headers`, and the
 *      leg never points at the deployed origin.
 *   5. Playwright is resolved from `$CENTS_PLAYWRIGHT`, this repo, or the shared
 *      tooling project, and its absence fails loudly instead of skipping.
 *   6. The suite does not list the leg (the dependency rule above), the README
 *      and CLAUDE.md name it (so it is discoverable), and `.assetsignore` keeps
 *      `scripts/` off the deploy.
 *   7. The fixture itself carries no PIN, credential, profile or cloud data —
 *      the leg runs on a synthetic ledger, never a copied one.
 *
 * Run: node scripts/check-pin-screens.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = rel => readFileSync(join(root, rel), 'utf8');

const problems = [];
const fail = message => problems.push(message);

const LEG = 'scripts/pin-screens.browser.mjs';
const FIXTURE = 'scripts/fixtures/expense-tracker-v1.schema2.json';
if (!existsSync(join(root, LEG))) {
  fail(`${LEG} is gone — the only browser proof that the rendered app agrees with the frozen document, gone with it.`);
} else {
  const leg = read(LEG);
  const require = (needle, why) => {
    if (!leg.includes(needle)) fail(`${LEG} no longer contains ${JSON.stringify(needle)} — ${why}`);
  };

  // 1./2. the document, the key, the PIN the leg seeds, the fresh context.
  require('fixtures/expense-tracker-v1.schema2.json', 'the leg must load the frozen fixture, not a document of its own.');
  require('cents:p/personal/state', 'the document is written under the key the app actually reads.');
  // The app ships no credential, so the leg has to make one. What matters is
  // that it makes it the way the app does — its own PIN, stored as PBKDF2 under
  // the device-only key — or the lock it exercises is not the lock users meet.
  require('cents:p/personal/privacy', 'the seeded PIN must live under the device-only key the app reads, not in the document.');
  require('pbkdf2Sync(', 'the seeded credential must be derived with the KDF the app verifies.');
  require('randomUUID()', 'the salt must be per-run, exactly as the Privacy lock screen writes it.');
  require("kdf: 'pbkdf2'", 'a seeded credential without its kdf marker would be verified as the legacy unsalted shape.');
  const iterations = /const PBKDF2_ITERATIONS = ([\d_]+);/.exec(leg)?.[1]?.replace(/_/g, '');
  const appIterations = /const PBKDF2_ITERATIONS = ([\d_]+);/.exec(read('app.js'))?.[1]?.replace(/_/g, '');
  if (!iterations) fail(`${LEG} no longer pins PBKDF2_ITERATIONS — the seeded hash would silently stop matching the app's KDF.`);
  else if (iterations !== appIterations) fail(`${LEG} seeds PBKDF2 at ${iterations} iterations but app.js hashes at ${appIterations} — the seeded PIN could never unlock.`);
  if (leg.includes('100901')) fail(`${LEG} still knows the old built-in PIN — the app has no default credential to fall back on.`);
  require('browser.newContext(', 'a fresh context is the whole point: no device, no profile, no PIN of a real user.');
  require('a fresh context starts with empty storage', 'the empty-storage assertion is what proves the context is fresh.');
  require('cents:profiles', 'the leg must assert the profile registry it leaves behind.');

  // 3. the frozen clock.
  require('page.clock.setFixedTime(', 'the dashboard is keyed on the wall clock; the fixture is frozen in one month, so the leg must pin it.');

  // 4. production CSP, loopback only.
  require("readFileSync(join(root, '_headers')", 'the CSP must come from the file the deploy reads, not a copy.');
  require('Content-Security-Policy', 'serving without the production policy would let a CSP-only defect pass.');
  if (/cents-app\.pages\.dev/.test(leg)) fail(`${LEG} names the deployed origin — the leg must run against this checkout only.`);

  // 5. Playwright resolution fails loudly.
  require('CENTS_PLAYWRIGHT', 'the documented override is what makes the leg runnable without adding a dependency here.');
  require('../design-system', 'the shared tooling install is where Playwright comes from in this workspace.');
  require('Could not load Playwright', 'a missing browser must fail the run, never skip it.');
}

// 6. discoverable, not uploaded, and still outside the dependency-free suite.
for (const doc of ['README.md', 'CLAUDE.md']) {
  if (!read(doc).includes('pin-screens.browser.mjs')) {
    fail(`${doc} does not name scripts/pin-screens.browser.mjs — a browser leg nobody knows about is one nobody runs.`);
  }
}
const ignore = read('.assetsignore');
if (!/^scripts\/$/m.test(ignore)) {
  fail('.assetsignore no longer excludes scripts/ — the guard suite and this leg would be uploaded and served.');
}
const runGuards = read('scripts/run-guards.mjs');
if (/pin-screens\.browser\.mjs/.test(runGuards.replace(/\/\/[^\n]*/g, ''))) {
  fail('scripts/run-guards.mjs now lists the browser leg. That is only correct if Playwright became a dependency of this repo and CI installs a browser for it; until then the suite is dependency-free by design and this leg runs by hand.');
}

// 7. the fixture stays synthetic.
if (!existsSync(join(root, FIXTURE))) {
  fail(`${FIXTURE} is missing — the leg has nothing to load.`);
} else {
  let fixture = null;
  try {
    fixture = JSON.parse(read(FIXTURE));
  } catch (error) {
    fail(`${FIXTURE} is not valid JSON — ${error.message}`);
  }
  if (fixture) {
    if (!Array.isArray(fixture.entries) || !fixture.entries.length) fail(`${FIXTURE} has no entries — the leg would assert an empty ledger.`);
    if (fixture.schemaVersion !== 2) fail(`${FIXTURE} is schemaVersion ${JSON.stringify(fixture.schemaVersion)}, not the 2 the shipping app writes.`);
    for (const forbidden of ['pinHash', 'credential', 'salt', 'profiles', 'syncToken']) {
      if (JSON.stringify(fixture).includes(forbidden)) {
        fail(`${FIXTURE} contains ${forbidden} — the fixture must be a synthetic ledger with no PIN, credential, profile or cloud data.`);
      }
    }
  }
}

// 8. The model behind the lock: no shipped credential, and no lock without one.
//    This is the half that regrows silently — a fallback hash is two lines and
//    looks helpful — so it is pinned in the app's own source, and in every page
//    that drives it (the harness used to type the default).
const appSrc = read('app.js');
for (const [file, why] of [['app.js', 'the app'], ['a11y-harness.html', 'the a11y harness'], ['index.html', 'the document']]) {
  if (/100901/.test(read(file))) fail(`${file} still contains the old built-in PIN 100901 — ${why} must get its credential from the device, not from the source.`);
}
if (/Keep the default PIN|Still the default PIN|Reset to default PIN|default no longer unlocks/.test(appSrc)) {
  fail('app.js still carries default-PIN copy — there is no default to keep, name or reset to.');
}
if (!/function getPinCredential\(\) \{[\s\S]*?\n  return null;\n\}/.test(appSrc)) {
  fail('getPinCredential() has no null branch — a device with no PIN would be handed a credential it does not have.');
}
if (!/function hasPinLock\(\) \{\n  if \(pinLockCache === null\) pinLockCache = !!getPinCredential\(\);\n  return pinLockCache;\n\}/.test(appSrc)) {
  fail('hasPinLock() no longer answers the device credential — nothing else may decide whether the app is locked.');
}
if (!/if \(hasPinLock\(\)\) \{ showPinLock\(\); return; \}\n  completeUnlock\(\);/.test(appSrc)) {
  fail('the boot gate lost its no-PIN branch — with no credential the session must open, or sync and the undo offer wait behind a lock nobody can answer.');
}
if (!appSrc.includes("'Skip — no lock'")) {
  fail('setup no longer offers a PIN-less start — skipping used to keep a default that no longer exists.');
}
if (/if \(!pinUnlocked \|\| !hasPinLock\(\)\) return;/.test(appSrc) === false) {
  fail('resetIdleLock no longer checks for a PIN — a no-PIN session would arm a lock timer that can never show a lock screen.');
}

if (problems.length) {
  console.error(`check-pin-screens: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log('check-pin-screens: OK — the frozen fixture, the fresh context, the frozen clock and the CSP are still what the leg runs, and it stays a hand-run browser leg.');
