#!/usr/bin/env node
/**
 * Verifies what the app pays for before it can paint, and that everything it
 * defers actually exists.
 *
 * The boot path used to include Tesco Pay in full — the screen, the roster-photo
 * reader, the pixel pipeline and the workbook importer — because app.js imported
 * tesco.js for the six arithmetic helpers the dashboard's Tesco line needs. That
 * is 240 KB of a 770 KB boot parsed on the lock screen for a session that may
 * never open the tab. The engine now lives in tesco-pay.js (arithmetic only) and
 * tesco.js is fetched on the first visit to #tesco.
 *
 * Nothing enforces that by itself, so this does: it walks the STATIC import graph
 * from index.html's module entry, pins the exact set of modules in it, pins the
 * byte ceiling, and checks that every dynamic import() — the lazy screens, the
 * vendor loaders, the OCR worker's module — names a file that is really on disk.
 * A lazy path that 404s is a screen that never loads, and a heavy module that
 * creeps back onto the boot path is invisible in review; both fail here.
 *
 * Run standalone:
 *
 *   node scripts/check-boot-payload.mjs
 *
 * Also wired as a predeploy build step in netlify.toml.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// What the app is allowed to pull before its first paint, by name. Adding a
// module here is a deliberate act: it is parsed on every boot, on the lock
// screen, for every user. Anything heavy belongs behind a dynamic import.
const BOOT_MODULES = [
  '/app.js',
  '/storage.js',
  '/csv.js',
  '/seed.js',
  '/settings.js',
  '/sync.js',
  '/sync-merge.js',
  '/profiles.js',
  '/reminders.js',
  '/tesco-pay.js',
];
// Modules that must NOT be in the boot closure: the ones the lazy paths own.
const DEFERRED_MODULES = ['/tesco.js', '/ocr-pixels.js', '/ocr-prep-worker.js'];

// Decoded JS parsed before the first paint, with headroom for growth (~4 %).
// Measured today: 669 KB — app.js 528 KB (the back-gesture wiring, the
// share-target reader and the Tesco pay tracker's pay-date join, all of which
// must be installed at boot — a sheet can open before any screen is built) +
// storage/sync/profiles/reminders and the small ones + tesco-pay.js 25 KB +
// csv.js 3 KB. The number to watch is not the ceiling, it
// is the shape: this should stay "the shell and arithmetic", with every screen
// and every library behind import() — and ~4 % is the whole of the allowance, so
// a new eager import (240 KB for tesco.js) still fails loudly.
const BOOT_JS_BUDGET = 690 * 1024;

/** Every static dependency of a module's own text: `import … from 'x'`,
 *  `import 'x'` and `export … from 'x'` (a re-export loads the module just as
 *  surely as an import does). */
function staticDeps(source) {
  const out = new Set();
  for (const m of source.matchAll(/(?:^|\n)[ \t]*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of source.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
}

/** Specifiers handed to import() — the deferred half of the graph. */
function dynamicDeps(source) {
  const out = new Set();
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out];
}

const fails = [];
const fail = (msg) => fails.push(msg);
const read = (rel) => readFileSync(join(root, rel.replace(/^\//, '')), 'utf8');

// ---- the entry: index.html's module script
const html = read('/index.html');
const entry = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^'"]+)["']/);
if (!entry) {
  fail('index.html no longer has a type="module" script to start from');
}
const entryPath = entry ? '/' + entry[1].replace(/^\/+/, '') : null;

// ---- walk the graph from the entry
const deferred = new Map();   // path -> bytes (reached only through import())
const dynamicSpecs = new Set();
const bytesOf = (p) => statSync(join(root, p.replace(/^\//, ''))).size;
const exists = (p) => existsSync(join(root, p.replace(/^\//, '')));
const resolveFrom = (from, spec) =>
  '/' + resolve(dirname(from.replace(/^\//, '')), spec).replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', '');

// Walk 1 — the BOOT closure: the entry, then static imports only, transitively.
const boot = new Map();
const bootQueue = entryPath ? [entryPath] : [];
while (bootQueue.length) {
  const rel = bootQueue.shift();
  if (boot.has(rel)) continue;
  if (!exists(rel)) {
    fail(`boot module ${rel} is imported but does not exist on disk`);
    continue;
  }
  const source = read(rel);
  boot.set(rel, bytesOf(rel));
  for (const spec of staticDeps(source)) {
    if (!spec.startsWith('.')) continue;   // bare specifiers: none, by design (no bundler)
    bootQueue.push(resolveFrom(rel, spec));
  }
  for (const spec of dynamicDeps(source)) dynamicSpecs.add(spec);
}

// Walk 2 — the DEFERRED closure: every import() target, then ITS static imports
// transitively. Those files are fetched on the first visit to that screen, so an
// offline visit needs them in the shell as much as the screen itself does.
const deferredQueue = [];
for (const spec of dynamicSpecs) {
  if (!spec.startsWith('.')) continue;
  for (const from of boot.keys()) {
    const candidate = resolveFrom(from, spec);
    if (exists(candidate)) { deferredQueue.push(candidate); break; }
  }
}
while (deferredQueue.length) {
  const rel = deferredQueue.shift();
  // A module in the boot closure is a bug the boot assertion below reports; it
  // is not a deferred module, and walking it again would double-count its bytes.
  if (deferred.has(rel) || boot.has(rel) || !exists(rel)) continue;
  const source = read(rel);
  deferred.set(rel, bytesOf(rel));
  for (const spec of staticDeps(source)) {
    if (spec.startsWith('.')) deferredQueue.push(resolveFrom(rel, spec));
  }
  for (const spec of dynamicDeps(source)) dynamicSpecs.add(spec);
}

// ---- what is on the boot path, exactly
const bootList = [...boot.keys()].sort();
const unexpected = bootList.filter(p => !BOOT_MODULES.includes(p));
const absent = BOOT_MODULES.filter(p => !bootList.includes(p));
if (unexpected.length) {
  fail(`on the boot path but not allowed there: ${unexpected.join(', ')}\n`
    + '     A new static import is parsed on every boot. If it is a screen or a\n'
    + '     library, fetch it with import() where it is used and add nothing here.');
}
if (absent.length) fail(`expected on the boot path but not reached: ${absent.join(', ')}`);
for (const mod of DEFERRED_MODULES) {
  if (boot.has(mod)) fail(`${mod} is back on the boot path — it must be reached only through import()`);
}

// ---- the byte ceiling
const bootBytes = [...boot.values()].reduce((a, b) => a + b, 0);
const deferredBytes = [...deferred.values()].reduce((a, b) => a + b, 0);
if (bootBytes > BOOT_JS_BUDGET) {
  fail(`the boot path is ${Math.round(bootBytes / 1024)} KB, over the ${Math.round(BOOT_JS_BUDGET / 1024)} KB budget`);
}

// ---- a lazy path must resolve: a 404 here is a screen that never loads
for (const spec of dynamicSpecs) {
  if (!spec.startsWith('.')) continue;
  const found = [...boot.keys(), ...deferred.keys()].some(p => p.endsWith(spec.replace('./', '/')));
  if (!found) fail(`import('${spec}') does not resolve to a file on disk`);
}
// The Tesco module must still be reached lazily — the split's whole point.
if (![...dynamicSpecs].some(s => s.endsWith('./tesco.js'))) {
  fail("nothing imports './tesco.js' dynamically; the screen would never load");
}
if (!boot.has('/tesco-pay.js')) fail('/tesco-pay.js is not on the boot path; the dashboard figure would lose its engine');

// ---- offline: everything the boot path parses must be in the SW's shell
const sw = read('/sw.js');
const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!shellMatch) {
  fail('could not find the SHELL array in sw.js');
} else {
  const shell = new Set([...shellMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
  for (const mod of [...boot.keys(), ...deferred.keys()]) {
    if (!shell.has(mod)) fail(`${mod} is loaded by the app but not listed in sw.js's SHELL, so a cold offline open loses it`);
  }
}

if (fails.length) {
  console.error(`check-boot-payload: ${fails.length} problem(s)`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}

console.log(`check-boot-payload: OK — ${bootList.length} boot module(s), ${Math.round(bootBytes / 1024)} KB parsed before first paint`
  + ` (budget ${Math.round(BOOT_JS_BUDGET / 1024)} KB); ${deferred.size} deferred module(s), ${Math.round(deferredBytes / 1024)} KB reached only through import()`);
