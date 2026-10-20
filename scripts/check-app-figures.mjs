#!/usr/bin/env node
/**
 * The served shell's vendored layer: byte-identical copies, in a load order that
 * works, with nothing in them that `style-src 'self'` would refuse.
 *
 * Why this exists. The dashboard's three figures are not new code: they are the
 * shipping app's `hairline/kernel.js`, `hairline/mount.js` and one file per
 * figure, copied into `app/hairline/` because the ported shell is served from a
 * different root and cannot reach `../hairline/`. A copy with no check is a fork
 * waiting to happen: the two shells would draw different tides from the same
 * numbers, and the only symptom would be a picture that looks slightly wrong. So
 * every copy is pinned by sha256 and the vendored set is pinned by name, in both
 * directions — a file added to `hairline/` that the shell does *not* carry fails
 * here, which is the half a plain "do these two match" check misses.
 *
 * The other rules are the ones a copy cannot inherit:
 *
 *   1. **Order.** `mount.js` defines the registry the figures call on load, so a
 *      figure loaded before it throws and registers nothing — silently, at the
 *      top level of a classic script. The order is therefore checked, and so is
 *      `defer`: without it the figures run before the document exists.
 *   2. **The policy.** The figures may draw, but not style: `HL.inject()` is the
 *      kernel's only path to a `<style>` element and no figure calls it. A figure
 *      that started to would work on an open page and be refused on this one.
 *   3. **The shell cache.** A script the page loads but the worker does not warm
 *      is a blank card offline, and `check-sw-shell` cannot see it — it reads the
 *      root worker, not this one. Every script and stylesheet this document loads
 *      is therefore required to be in `app/sw.js`'s SHELL.
 *   4. **The hosts.** The dashboard must still create the three ids, and the typed
 *      bridge must still mount the same figure names the shipping wrapper mounts;
 *      a rename in one place is a card that stays empty with no error.
 *
 * Run standalone:  node scripts/check-app-figures.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const sha = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');

const fails = [];

/* ── 1. the copies ─────────────────────────────────────────────────────────── */

/** source → the copy the served shell loads. */
const COPIES = [
  ['hairline/kernel.js', 'app/hairline/kernel.js'],
  ['hairline/mount.js', 'app/hairline/mount.js'],
  ['hairline/balance-tide.js', 'app/hairline/balance-tide.js'],
  ['hairline/envelope-garden.js', 'app/hairline/envelope-garden.js'],
  ['hairline/receipt-constellation.js', 'app/hairline/receipt-constellation.js'],
  ['../design-system/ui-kit/ui.js', 'app/ui.js'],
  ['../design-system/ui-kit/ui.css', 'app/ui.css'],
];

for (const [source, copy] of COPIES) {
  if (!existsSync(join(root, copy))) {
    fails.push(`${copy} is missing — the served shell loads it by name.`);
    continue;
  }
  if (sha(source) !== sha(copy)) {
    fails.push(`${copy} has drifted from ${source}. Re-copy it; do not edit the copy.`);
  }
}

// The other direction: every figure file the shipping app has must be carried,
// or the port silently draws two figures where the shipping app draws three.
const shipped = readdirSync(join(root, 'hairline')).filter((f) => f.endsWith('.js')).sort();
const carried = readdirSync(join(root, 'app/hairline')).filter((f) => f.endsWith('.js')).sort();
// `figures.js` is the one file deliberately not carried: it caches a handle per
// figure name for the life of the page, which breaks on this shell's re-renders.
const expected = shipped.filter((f) => f !== 'figures.js');
for (const file of expected) {
  if (!carried.includes(file)) fails.push(`app/hairline/${file} is not carried — ${expected.length} figure file(s) are expected.`);
}
for (const file of carried) {
  if (!expected.includes(file)) fails.push(`app/hairline/${file} is not in hairline/ — a vendored copy must have a source.`);
}

/* ── 2. the load order in the document ─────────────────────────────────────── */

const html = read('app/index.html');
// Comments are prose about the document, not the document: this guard says
// "<style>" and "style=" out loud when it explains what it forbids.
const markup = html.replace(/<!--[\s\S]*?-->/g, '');
const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1] ?? null;
const scripted = tags.map((tag) => ({ src: attr(tag, 'src'), deferred: /\bdefer\b/.test(tag), module: attr(tag, 'type') === 'module' }));

const ORDER = ['hairline/kernel.js', 'hairline/mount.js', 'hairline/balance-tide.js',
  'hairline/envelope-garden.js', 'hairline/receipt-constellation.js'];
const positions = ORDER.map((src) => scripted.findIndex((tag) => tag.src === src));
for (const [index, src] of ORDER.entries()) {
  if (positions[index] < 0) {
    fails.push(`app/index.html does not load ${src}.`);
    continue;
  }
  const tag = scripted[positions[index]];
  if (!tag.deferred) fails.push(`${src} is not deferred — it would run before the document has a card to draw in.`);
  if (index > 0 && positions[index - 1] >= 0 && positions[index] < positions[index - 1]) {
    fails.push(`${src} loads before ${ORDER[index - 1]} — the mount defines the registry the figures call.`);
  }
}
const bundle = scripted.findIndex((tag) => tag.src === 'dist/main.js');
if (bundle < 0) fails.push('app/index.html does not load dist/main.js — the shell would not boot.');
for (const [index, src] of ORDER.entries()) {
  if (positions[index] >= 0 && bundle >= 0 && positions[index] > bundle) {
    fails.push(`${src} loads after the bundle — the first render would have no figure registered.`);
  }
}
const kit = scripted.findIndex((tag) => tag.src === 'ui.js');
if (kit < 0) fails.push('app/index.html does not load ui.js — nothing would write data-component on the dashboard.');
else {
  if (!scripted[kit].module) fails.push('ui.js is not a module script — it is an ES module and would throw as classic.');
  if (kit < bundle) fails.push('ui.js loads before dist/main.js — the shipping app mounts the kit last, and the order is the contract.');
}

/* ── 3. the policy this document is served under ───────────────────────────── */

const headers = read('app/_headers');
const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
for (const [directive, reason] of [
  ["script-src 'self'", 'the document carries no inline script'],
  ["style-src 'self'", 'the document carries no inline style'],
]) {
  if (!csp.includes(directive)) fails.push(`app/_headers does not send \`${directive}\` — ${reason}.`);
}
if (/unsafe-inline|unsafe-eval/.test(csp)) {
  fails.push('app/_headers allows unsafe-inline or unsafe-eval — the strict policy is the point of this shell.');
}

// An inline <script> or <style>, or a style attribute, in the document itself.
if (/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(markup)) {
  fails.push("app/index.html carries an inline <script> — script-src 'self' would refuse it.");
}
if (/<style\b/i.test(markup)) fails.push("app/index.html carries a <style> element — style-src 'self' would refuse it.");
if (/style\s*=\s*"/.test(markup)) fails.push("app/index.html carries a style attribute — style-src 'self' would refuse it.");

/* ── 4. nothing in the figures styles anything ─────────────────────────────── */

for (const file of ['app/hairline/mount.js', 'app/hairline/balance-tide.js',
  'app/hairline/envelope-garden.js', 'app/hairline/receipt-constellation.js']) {
  if (!existsSync(join(root, file))) continue;
  // The comments in these files discuss inject() and style by name; only code
  // counts.
  const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\binject\s*\(/.test(text)) {
    fails.push(`${file} calls inject() — that writes a <style> element, which style-src 'self' refuses.`);
  }
  if (/setAttribute\(\s*['"]style['"]/.test(text) || /\bstyle\s*:/.test(text)) {
    fails.push(`${file} writes a style attribute — the rules belong in styles.css.`);
  }
}
if (/\binject\s*\(/.test(read('app/src/figures.ts'))) {
  fails.push('app/src/figures.ts calls inject() — the palette is in styles.css.');
}

/* ── 5. the offline shell warms every file this document loads ─────────────── */

const shell = /const SHELL = \[([\s\S]*?)\]/.exec(read('app/sw.js'))?.[1] ?? '';
const warmed = [...shell.matchAll(/'([^']+)'/g)].map((m) => m[1]);
// The shell is scripts and stylesheets; an icon that is missing offline is a
// placeholder tile, but a script that is missing is a blank card.
const loaded = [...html.matchAll(/<(?:script|link)\b([^>]*)>/g)]
  .map((m) => attr(m[1], 'src') || attr(m[1], 'href'))
  .filter((url) => url && /\.(?:js|css)$/.test(url) && !/^[a-z]+:/i.test(url))
  .map((url) => (url.startsWith('./') ? url.slice(2) : url))
  .map((url) => (url.startsWith('/') ? url : `/${url}`));
const missingFromShell = [...new Set(loaded)].filter((url) => !warmed.includes(url));
if (missingFromShell.length) {
  fails.push(`app/sw.js SHELL does not warm ${missingFromShell.join(', ')} — offline those cards stay empty.`);
}

/* ── 6. the hosts, and the names the bridge mounts ─────────────────────────── */

const FIGURES = [
  { id: 'cents-balance-tide', name: 'balance-tide', key: 'balances' },
  { id: 'cents-envelope-garden', name: 'envelope-garden', key: 'envelopes' },
  { id: 'cents-receipt-constellation', name: 'receipt-constellation', key: 'receipts' },
];
const dashboard = read('app/src/screens/dashboard.ts');
const bridge = read('app/src/figures.ts');
const shippedWrapper = read('hairline/figures.js');
for (const figure of FIGURES) {
  if (!dashboard.includes(`'${figure.id}'`)) {
    fails.push(`app/src/screens/dashboard.ts no longer creates the ${figure.id} host — its figure has nowhere to mount.`);
  }
  if (!new RegExp(`id:\\s*'${figure.id}',\\s*name:\\s*'${figure.name}'`).test(bridge)) {
    fails.push(`app/src/figures.ts does not mount ${figure.name} into ${figure.id} — the card would stay empty.`);
  }
  if (!new RegExp(`host:\\s*'${figure.id}',\\s*name:\\s*'${figure.name}'`).test(shippedWrapper)) {
    fails.push(`hairline/figures.js no longer mounts ${figure.name} into ${figure.id} — the two shells have diverged.`);
  }
}

// The kit's three dashboard hosts, and the bar the budget card reads.
for (const [needle, why] of [
  ["setAttribute('data-ui', 'animated-counter')", 'the pulse figures would stop counting'],
  ["'data-ui': 'warm-tooltip'", 'the budget field would lose its tip'],
  ["'data-ui': 'budget-card'", 'the budget card would stop being a component'],
  ["'data-ui-bar'", 'the kit would find no bar to describe'],
]) {
  if (!dashboard.includes(needle)) fails.push(`app/src/screens/dashboard.ts no longer sets ${needle} — ${why}.`);
}

/* ── report ───────────────────────────────────────────────────────────────── */

if (fails.length) {
  for (const fail of fails) console.error(`FAIL ${fail}`);
  console.error(`\ncheck-app-figures: ${fails.length} failure(s)`);
  process.exit(1);
}
console.log(`check-app-figures: OK — ${COPIES.length} vendored copies match their source, the five figure scripts load in order under the strict policy, the shell warms them offline, and the dashboard still draws all three`);
