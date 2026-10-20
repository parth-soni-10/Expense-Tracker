#!/usr/bin/env node
/**
 * Runs the whole guard suite, in order, stopping at the first failure.
 *
 * Why it exists: the guards are only as good as the thing that runs them. On
 * Netlify the list lived in netlify.toml's build command, and Netlify parses
 * its config BEFORE it runs that command — so a config mistake failed the deploy
 * with every guard unreported (the `[[functions]]` array form did exactly that
 * for seven commits and froze production). The suite therefore has to be
 * runnable somewhere the failure is visible first: here, before a push, and in
 * CI (.github/workflows/guards.yml).
 *
 * This array IS the list now. Nothing else enumerates the guards: the build step
 * is gone with Netlify's build command, so there is no second copy to drift, and
 * scripts/check-worker-config.mjs fails the suite if a guard file on disk is
 * missing from here or a name here has no file. Adding a guard is one line here
 * plus its entry in README.md (also checked).
 *
 * Run: node scripts/run-guards.mjs      (Node 22+ — see the note below)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Order matters only for the first guard: check-worker-config explains why the
// others might report nothing at all, so it goes first.
//
// The runtime note is not decoration. Several guards import this repo's plain
// .js modules (seed.js, tesco.js) and this repo has no package.json, so Node
// decides ESM-vs-CommonJS by syntax detection — on by default from 22.7/20.19,
// and on Node 18 it parses them as CommonJS and dies with "Cannot use import
// statement outside a module". CI pins the same version.
const GUARDS = [
  'check-worker-config.mjs',   // the config every other guard reads
  'check-sw-shell.mjs',        // every sw.js SHELL entry exists on disk
  'test-image-hygiene.mjs',    // the image guard still catches what it was written to catch
  'check-image-hygiene.mjs',   // no image can enter the app: the OCR pipeline stays deleted
  'check-csp-hashes.mjs',      // every inline boot script is hashed in the CSP
  'check-freshness.mjs',       // a deploy always reaches the device
  'check-icon-refs.mjs',       // every icon name app.js looks up exists
  'check-boot-payload.mjs',    // the boot path stays the shell and the arithmetic
  'check-app-shell.mjs',       // an installed copy behaves like an app
  'check-a11y.mjs',            // the accessibility harness still audits everything
  'check-mobile-layout.mjs',   // a figure cannot leave the box it is drawn in
  'check-css-tokens.mjs',      // the stylesheets' tokens stay in step
  'test-integrity.mjs',        // storage/merge cannot lose or corrupt data
  'test-parity-money.mjs',     // quick entry, cents-only precision and split/transfer pairs, run against app.js itself
  'test-load-existing.mjs',    // a document written by the old app loads in the port
  'test-metrics.mjs',          // the ported ledger arithmetic agrees with the frozen document
  'check-pin-screens.mjs',     // the browser leg that loads it behind the PIN stays honest (it needs Playwright, so it runs by hand)
  'test-profiles.mjs',         // profiles stay isolated
  'test-tesco.mjs',            // the pay/tax engine still matches the workbook
  'test-sync.mjs',             // the sync contract still round-trips the state
  'test-cloud.mjs',            // the document store migrates, mirrors, conflicts
  'test-failure-throttle.mjs', // the failed-auth damper sees the caller on this host
  'test-motion.mjs',           // a headline figure only counts when it changed
  'test-ui-libs.mjs',          // the vendored UI libraries still behave
];

const root = fileURLToPath(new URL('../', import.meta.url));
console.log(`run-guards: ${GUARDS.length} guard(s)\n`);

for (const [index, guard] of GUARDS.entries()) {
  // stdio inherited so a failing guard's own output is what the reader sees —
  // it already says which file, which line and why.
  const result = spawnSync(process.execPath, [`scripts/${guard}`], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nrun-guards: FAILED at ${index + 1}/${GUARDS.length} (${guard}, exit ${result.status ?? 1})`
      + ` — the ${GUARDS.length - index - 1} guard(s) after it did not run.`);
    process.exit(result.status || 1);
  }
}
console.log(`\nrun-guards: all ${GUARDS.length} guard(s) passed.`);
