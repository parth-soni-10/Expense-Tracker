#!/usr/bin/env node
/**
 * Guards the "a deploy always reaches the device" property — the failure this
 * project has already hit twice: a redeploy masked by a cached copy, and a
 * phone that kept showing an old build.
 *
 * Three parts, each one a thing that can regress silently:
 *
 *   1. Every app asset revalidates. Each app-loaded file and the root path "/"
 *      must be matched by a [[headers]] rule that sets a revalidating
 *      Cache-Control. A path with no such rule inherits Netlify's platform
 *      default instead, and a long default there would serve the previous
 *      deploy for as long as the browser keeps it. That is invisible in the
 *      repo and invisible locally, where no such header is ever sent.
 *   2. sw.js stays network-first. The worker must answer with fetch(...) using
 *      cache: 'no-store', and use Cache Storage only as the offline fallback.
 *      A cache-first handler hands an online user the previous deploy — the
 *      failure the worker's own comment says it exists to avoid.
 *   3. The registration never accepts a stale worker script: /sw.js must be
 *      registered with updateViaCache 'none'. Otherwise the browser may serve
 *      its own cached copy of the script for up to 24 hours, holding back a
 *      new worker — and with it the new cache namespace and the shell warm —
 *      for a day after a deploy.
 *   4. No 404 rule can black-hole an app file. `publish = "."` serves the whole
 *      repo, so [[redirects]] 404 the non-app surface (guard scripts, function
 *      sources, docs). Those rules need force = true to win against the real
 *      file, which also means a too-broad pattern would break the app at the
 *      CDN and nowhere else.
 *
 * Run: node scripts/check-freshness.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, relative, sep } from 'node:path';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const toml = read('netlify.toml');
const sw = read('sw.js');
const html = read('index.html');

const problems = [];
const fail = msg => problems.push(msg);

// Line-anchored `//` comment strip, the same call check-image-hygiene makes:
// sw.js explains its own security and freshness reasoning in comments that
// quote the very code asserted below (`cache: 'no-store'`, `/.netlify/`), so a
// check against raw source can be satisfied by prose — a guard that would pass
// while the code it guards was deleted. Whole-line stripping is safe; a block
// comment strip is not (a `/*` sequence elsewhere can swallow real code), and
// the cost of missing an inline comment is a visible false positive.
const stripComments = src => src.replace(/^[ \t]*\/\/.*$/gm, '');
const swCode = stripComments(sw);
const htmlCode = stripComments(html);

// ---- 1. every app asset revalidates ---------------------------------------
// The [[headers]] blocks, each `for` pattern with the Cache-Control inside its
// [headers.values] table (absent on the catch-all rule, which is deliberate:
// a specific rule owns the value for the paths it covers).
const rules = toml
  .split(/^\[\[headers\]\]\s*$/m)
  .slice(1)
  .map(block => ({
    pattern: /^\s*for\s*=\s*"([^"]+)"/m.exec(block)?.[1] || '',
    cacheControl: /^\s*Cache-Control\s*=\s*"([^"]+)"/m.exec(block)?.[1] || '',
  }))
  .filter(r => r.pattern);

// Netlify's `for` patterns are globs and `*` spans slashes — the live site
// settles it: `/*.js` is what puts no-cache on /vendor/sweetalert2.min.js.
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (pattern, path) =>
  pattern === path || new RegExp(`^${pattern.split('*').map(escapeRx).join('.*')}$`).test(path);
const revalidates = cc => /no-cache|no-store|max-age=0/i.test(cc);

// What actually ships: `publish = "."`. Tooling and docs directories are not
// app assets; screenshots/ is README imagery, not something the app loads.
const APP_EXT = new Set(['.js', '.css', '.html', '.json', '.png', '.woff2', '.wasm', '.gz']);
const SKIP_DIRS = new Set(['node_modules', 'scripts', 'netlify', 'testing', 'screenshots']);
const assets = new Set(['/']);
const rootDir = fileURLToPath(root);
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full);
    } else if (APP_EXT.has(extname(name))) {
      assets.add('/' + relative(rootDir, full).split(sep).join('/'));
    }
  }
})(rootDir);

for (const path of assets) {
  const matching = rules.filter(r => matches(r.pattern, path));
  if (!matching.some(r => revalidates(r.cacheControl))) {
    fail(`${path} ships but no [[headers]] rule that matches it sets a revalidating ` +
      `Cache-Control — it would inherit Netlify's platform default ` +
      `(matched: ${matching.map(r => `"${r.pattern}" → ${r.cacheControl || 'no Cache-Control'}`).join(', ') || 'nothing'}).`);
  }
}

// ---- 2. the worker stays network-first ------------------------------------
if (!/const CACHE = '[^']+'/.test(swCode)) {
  fail("sw.js has no `const CACHE = '<name>'` — the offline cache namespace must be named so a deploy can bump it.");
}
// One check for the response strategy, because the two halves protect each
// other: fetching first keeps a redeploy from being masked by Cache Storage,
// and cache: 'no-store' keeps it from being masked by the browser's HTTP
// cache. Anchored to respondWith(... so it cannot be satisfied by the
// update-check fetch elsewhere in the file.
if (!/respondWith\(\s*fetch\([^;]*cache:\s*'no-store'/.test(swCode)) {
  fail("sw.js must answer requests with fetch(..., { cache: 'no-store' }) first — a cache-first handler serves the previous deploy to an online user, and without no-store the browser's own HTTP cache can answer instead.");
}
if (!/caches\.match\(\s*e\.request\s*\)/.test(swCode)) {
  fail('sw.js has no per-request Cache Storage fallback — the app would not boot offline at all.');
}
if (!/!url\.pathname\.startsWith\(\s*'\/\.netlify\/'\s*\)/.test(swCode)) {
  fail('sw.js must keep the /.netlify/ exclusion — without it the synced document is written to Cache Storage and replayed later as a stale cloud copy.');
}

// ---- 3. the worker script is never taken from cache -----------------------
if (!/serviceWorker\.register\(/.test(htmlCode)) {
  fail('index.html does not register a service worker.');
} else {
  const opts = /serviceWorker\.register\(\s*['"]\/sw\.js['"]\s*,\s*\{([^}]*)\}/.exec(htmlCode)?.[1];
  if (!opts) {
    fail("index.html registers /sw.js with no options — pass { updateViaCache: 'none' } so a new worker is never held back by the browser's cached script.");
  } else if (!/updateViaCache:\s*['"]none['"]/.test(opts)) {
    fail("the /sw.js registration must pass updateViaCache: 'none' — Chrome otherwise honours its own cached worker script for up to 24 hours, delaying a new worker (and its cache namespace and shell warm) by a day.");
  }
}

// ---- 4. a 404 rule can never black-hole an app file -----------------------
const notFoundRules = toml
  .split(/^\[\[redirects\]\]\s*$/m)
  .slice(1)
  .map(block => ({
    pattern: /^\s*from\s*=\s*"([^"]+)"/m.exec(block)?.[1] || '',
    status: Number(/^\s*status\s*=\s*(\d+)/m.exec(block)?.[1] || 200),
  }))
  .filter(r => r.pattern);

if (!notFoundRules.some(r => r.status === 404)) {
  fail('netlify.toml 404s no non-app path, but `publish = "."` serves the whole repo — the guard scripts, the function sources and the docs would all be downloadable from the live site.');
}
for (const r of notFoundRules) {
  for (const path of assets) {
    if (matches(r.pattern, path)) {
      fail(`netlify.toml 404s "${r.pattern}", which matches the app asset ${path} — with force it wins over the real file, so the app would break in production only.`);
    }
  }
}

if (problems.length) {
  console.error(`check-freshness: ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-freshness: OK — ${assets.size} published app asset(s), each revalidating; ` +
  `${notFoundRules.length} non-app path(s) 404'd, none of them an app file; ` +
  'the worker is network-first and its script is never served from cache.');
