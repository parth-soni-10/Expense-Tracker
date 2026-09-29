#!/usr/bin/env node
/**
 * Guards the "a deploy always reaches the device" property — the failure this
 * project has already hit twice: a redeploy masked by a cached copy, and a
 * phone that kept showing an old build.
 *
 * Five parts, each one a thing that can regress silently:
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
 *   5. Everything that ships is classified. Part 1 asks whether an app asset
 *      revalidates; this asks whether a file that is NOT an app asset is meant
 *      to be downloadable at all. Nothing did — README imagery sat on the live
 *      site with no guard reporting it — and the next artefact to land in the
 *      repo (an exported CSV, a pulled cloud copy, another screenshot) would
 *      have shipped the same way, silently.
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

// What actually ships: `publish = "."` publishes the checkout, so a file is
// public unless something says otherwise. Two things can say so, and both are
// read here rather than restated, so this cannot drift from the deploy:
// .netlifyignore keeps a file off the CDN entirely, a [[redirects]] 404 rule
// refuses it at the CDN.
const APP_EXT = new Set(['.js', '.css', '.html', '.json', '.png', '.woff2', '.wasm', '.gz']);
// Directories whose files the app never loads: README imagery, the guard
// scripts, the function sources. Publishing them is `publish = "."`'s doing
// like everything else, and part 5 requires each to be 404'd — but none of them
// is an app asset for part 1 to demand a cache rule for.
const NON_APP_DIRS = new Set(['screenshots', 'scripts', 'netlify', 'testing', 'node_modules']);
// Netlify never serves its own config file, so it needs no rule of its own.
const NEVER_PUBLISHED = new Set(['netlify.toml']);
const ignoreRules = read('.netlifyignore').split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(pattern => {
    // The two shapes the ignore file uses: a bare name or glob matches at any
    // depth (`*.log`), a pattern carrying a slash is rooted at the repo
    // (`node_modules/`). Gitignore semantics, narrowed to what is used here.
    const dirOnly = pattern.endsWith('/');
    const body = dirOnly ? pattern.slice(0, -1) : pattern;
    const rx = new RegExp(`^${body.split('*').map(escapeRx).join('[^/]*')}$`);
    return path => (dirOnly
      ? path === body || path.startsWith(`${body}/`)
      : (body.includes('/') ? rx.test(path) : path.split('/').some(part => rx.test(part))));
  });
const ignoredByNetlify = path => ignoreRules.some(rule => rule(path));

const assets = new Set(['/']); // app-loaded files, asserted by part 1
const ships = new Set();       // everything the deploy can serve, asserted by part 5
const rootDir = fileURLToPath(root);
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    // Dotfiles and dot-directories (.git, .github, .gitignore, .env, .DS_Store)
    // are never served by the CDN, so they need no rule of their own; the live
    // site 404s them — with ONE exception, because the blanket claim above was
    // simply wrong about it. /.well-known/ is a standard, publicly served path:
    // Digital Asset Links for an installable app package lives there and
    // nowhere else. So it is walked like any other directory, and a file in it
    // is held to the same standard as the rest of the deploy — which is what
    // stops the one file whose absence fails *silently* (an unverified app
    // opens in a browser tab with a URL bar, instead of as the installed app)
    // from being served with the wrong content type or a week-long cache.
    if (name.startsWith('.') && name !== '.well-known') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    const rel = relative(rootDir, full).split(sep).join('/');
    if (NEVER_PUBLISHED.has(rel) || ignoredByNetlify(rel)) continue;
    const path = `/${rel}`;
    ships.add(path);
    if (APP_EXT.has(extname(name)) && !NON_APP_DIRS.has(rel.split('/')[0])) assets.add(path);
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

// ---- 2b. the build baseline outlives the worker ---------------------------
// "A redeploy reaches the device" rests on the worker diffing the document it
// just fetched against the one it saw last. That baseline lived in a Map in the
// worker's own scope, and a service worker is torn down after about thirty
// seconds idle — so after a phone had been in a pocket for a few days the
// worker that saw the previous build was gone, the next check looked like a
// first sighting, and the branch that records one reports nothing on purpose.
// The one case the mechanism exists for (a PWA that has not navigated since the
// deploy) therefore kept showing the old build until it was killed by hand. The
// baseline is in Cache Storage now, which is the part a refactor would quietly
// undo — so it is pinned here, where a source read can say so.
if (/^\s*const buildSeen\s*=/m.test(swCode)) {
  fail('sw.js holds the build baseline in a worker-scope variable again: a worker is torn down '
    + 'after ~30s idle, so the first check after every restart looks like a first sighting and a '
    + 'PWA that has not navigated since a redeploy is never told about it. Keep it in Cache Storage.');
}
if (!/const BUILD_CACHE = '[^']+'/.test(swCode) || !/const BUILD_KEY = '[^']+'/.test(swCode)) {
  fail('sw.js names no BUILD_CACHE/BUILD_KEY — the build baseline needs a key of its own to be '
    + 'readable after the worker that wrote it is gone.');
}
// Both halves, named separately: a baseline that is written but never read back
// compares against nothing and reports nothing, which looks exactly like the
// mechanism working (no crash, no notification).
if (!/caches\.open\(BUILD_CACHE\)\)\.match\(BUILD_KEY\)/.test(swCode)) {
  fail('sw.js never reads the build baseline back out of Cache Storage — a baseline that is only '
    + 'written compares against nothing, and the device is told about no deploy at all.');
}
if (!/caches\.open\(BUILD_CACHE\)\)\.put\(new Request\(BUILD_KEY\)/.test(swCode)) {
  fail('sw.js never records the build it just served, so every check would look like a redeploy.');
}
// A version bump must delete the shell cache and must NOT delete the baseline:
// the baseline's whole job is to survive the deploy that changed the shell.
if (!/k !== CACHE && k !== BUILD_CACHE/.test(swCode)) {
  fail('sw.js\'s activate sweeps every cache but CACHE, which deletes the build baseline on the '
    + 'one deploy where it is needed — the deploy that changed the shell.');
}
// Both entry points — a navigation, and a tab asking on refocus — have to go
// through the one comparison, or one of them silently skips the baseline. Each
// is asserted by its own shape rather than by counting calls, since a call that
// no longer guards anything is the failure mode.
if (!/if \(await noteBuild\(text\)\) await tellClients\(/.test(swCode)) {
  fail('sw.js\'s navigation path no longer compares the served document against the baseline — a '
    + 'background tab that has not navigated never learns about a redeploy.');
}
if (!/if \(!\(await noteBuild\(text\)\)\) return;/.test(swCode)) {
  fail('sw.js\'s refocus path no longer checks whether the build actually changed — it would either '
    + 'reload every tab on every check or tell nobody, and a PWA is the case this exists for.');
}
// The clone has to be taken in the same tick as the response: the page consumes
// it the moment the promise settles, and a clone taken after that throws.
if (!/maybeBroadcastBuildChange\(e\.request, res\.clone\(\)\)/.test(swCode)) {
  fail('sw.js diffs the build off the live response instead of a clone taken before the page can '
    + 'consume it — the clone throws ("body already used") and the redeploy notification is lost.');
}
if (!/async function tellClients\(url\)/.test(swCode) || !/type: 'centsNewBuild'/.test(swCode)) {
  fail('sw.js no longer tells the open tabs about a changed build.');
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
// A [[redirects]] `from` is a DIFFERENT engine from a [[headers]] `for`: an
// asterisk is valid only as a trailing splat ("It's not possible to use an
// asterisk as a wildcard in the middle of a path"), so `from = "/*.md"`
// matches nothing at all. `matches` above models the headers glob and cannot
// see that — which is how a `/*.md` rule shipped, passed this file, and left
// README.md, CLAUDE.md and vendor/README.md downloadable with a 200.
const redirectMatches = (pattern, path) =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

for (const r of notFoundRules) {
  if (r.pattern.includes('*') && !r.pattern.endsWith('*')) {
    fail(`netlify.toml 404s "${r.pattern}", which Netlify can never match: a redirect path takes an asterisk ` +
      'only as a trailing splat, so a mid-path one makes the rule a silent no-op. Write one rule per path.');
  }
  for (const path of assets) {
    if (matches(r.pattern, path)) {
      fail(`netlify.toml 404s "${r.pattern}", which matches the app asset ${path} — with force it wins over the real file, so the app would break in production only.`);
    }
  }
}

// ---- 5. everything that ships is classified -------------------------------
// Part 1 asks whether an app asset revalidates. This asks the other half: is a
// file that is not an app asset meant to be downloadable at all? Nothing did,
// and the rules are hand-written — so README imagery sat on the live site with
// no guard reporting it. Docs belong here too: they carry the install steps and
// every env var name.
const unclassified = [...ships].filter(path => !assets.has(path)
  && !notFoundRules.some(r => r.status === 404 && redirectMatches(r.pattern, path)));
if (unclassified.length) {
  fail(`${unclassified.join(', ')} would be downloadable from the live site: \`publish = "."\` serves the whole ` +
    'repo, no [[redirects]] rule 404s it, and .netlifyignore does not keep it off the CDN. Add one 404 rule per ' +
    'path (a glob cannot match Netlify), or list it in .netlifyignore if it must never ship.');
}
// The other direction, now that .netlifyignore is part of this guard's
// arithmetic: an ignore rule that matches something the app itself loads does
// not protect anything — it deletes an asset from the deploy floor. The
// worker's SHELL list is the app's own manifest of those files, so that is what
// the ignore rules are checked against.
const shellEntries = [...(/const SHELL = \[([\s\S]*?)\];/.exec(swCode)?.[1] || '')
  .matchAll(/'([^']+)'/g)].map(m => m[1]);
const ignoredAssets = shellEntries.filter(p => ignoredByNetlify(p.replace(/^\//, '')));
if (ignoredAssets.length) {
  fail(`${ignoredAssets.join(', ')} is in sw.js's SHELL list but .netlifyignore excludes it — the deploy would ship an ` +
    'app that cannot warm its own offline cache, and nothing else would say why.');
}

if (problems.length) {
  console.error(`check-freshness: ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-freshness: OK — ${assets.size} published app asset(s), each revalidating; ` +
  `${notFoundRules.length} non-app path(s) 404'd, none of them an app file; ` +
  `all ${ships.size} published file(s) classified; ` +
  'the worker is network-first and its script is never served from cache.');
