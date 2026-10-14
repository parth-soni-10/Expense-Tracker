#!/usr/bin/env node
/**
 * Guards the "a deploy always reaches the device" property — the failure this
 * project has already hit twice: a redeploy masked by a cached copy, and a
 * phone that kept showing an old build.
 *
 * Five parts, each one a thing that can regress silently:
 *
 *   1. Every app asset revalidates. Each app-loaded file and the root path "/"
 *      must be matched by a `_headers` rule that sets a revalidating
 *      Cache-Control. A path with no such rule inherits the platform default
 *      instead, and a long default there would serve the previous deploy for as
 *      long as the browser keeps it. That is invisible in the repo and invisible
 *      locally, where no such header is ever sent.
 *   2. sw.js stays network-first. The worker must answer with fetch(...) using
 *      cache: 'no-store', and use Cache Storage only as the offline fallback.
 *      A cache-first handler hands an online user the previous deploy — the
 *      failure the worker's own comment says it exists to avoid.
 *   3. The registration never accepts a stale worker script: /sw.js must be
 *      registered with updateViaCache 'none'. Otherwise the browser may serve
 *      its own cached copy of the script for up to 24 hours, holding back a
 *      new worker — and with it the new cache namespace and the shell warm —
 *      for a day after a deploy.
 *   4. No ignore rule can take the app down. The deploy's shape is now the
 *      INVERSE of the old one: the assets directory is the repository root and
 *      `.assetsignore` decides what is uploaded at all, so a too-broad rule does
 *      not merely expose a file, it deletes one from the deploy. A rule that
 *      matches an app asset, or anything sw.js's SHELL list loads offline, is
 *      therefore a broken app at the edge and nowhere else. (This replaces the
 *      old part 4, which watched the same failure through Netlify's 404 rules:
 *      back then a greedy `from = "/*"` 404'd the app; now a greedy ignore rule
 *      removes it.)
 *   5. Everything that ships is classified. Part 1 asks whether an app asset
 *      revalidates; this asks whether a file that is NOT an app asset is meant
 *      to be downloadable at all. Nothing did — README imagery sat on the live
 *      site with no guard reporting it — and the next artefact to land in the
 *      repo (an exported CSV, a pulled cloud copy, another screenshot) would
 *      have shipped the same way, silently. On this host the answer is
 *      `.assetsignore`: a non-app file must be listed there, or it is uploaded.
 *
 * Run: node scripts/check-freshness.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, relative, sep } from 'node:path';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const headersFile = read('_headers');
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
// `_headers` blocks: a path at column 0, then its indented `Name: value` lines,
// then optional `#` comments (which the file uses between header lines).
// Cloudflare's `*` in a path spans slashes — verified against a deployed site,
// where a `/*.png` rule answers for /icons/icon-192.png — so the glob below is
// the same one netlify.toml's `for =` patterns used.
const rules = [];
for (const block of headersFile.split(/^(?=[^\s#])/m).slice(1)) {
  const lines = block.split('\n');
  const pattern = lines[0].trim();
  if (!pattern || pattern.startsWith('#')) continue;
  let cacheControl = '';
  for (const line of lines.slice(1)) {
    const m = /^[ \t]+([A-Za-z-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m && m[1].toLowerCase() === 'cache-control') cacheControl = m[2];
  }
  rules.push({ pattern, cacheControl });
}
if (!rules.length) fail('_headers declares no rules — every asset would be served with the platform default cache policy.');

const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (pattern, path) =>
  pattern === path || new RegExp(`^${pattern.split('*').map(escapeRx).join('.*')}$`).test(path);
const revalidates = cc => /no-cache|no-store|max-age=0/i.test(cc);

// What actually ships: the assets directory is the repository root, so a file is
// public unless `.assetsignore` says otherwise — and unlike the old 404 rules,
// saying otherwise now means the file is not uploaded at all.
const APP_EXT = new Set(['.js', '.css', '.html', '.json', '.png', '.woff2', '.wasm', '.gz']);
// Directories whose files the app never loads: README imagery, the guard
// scripts, the function sources. Not uploading them is `.assetsignore`'s doing
// like everything else, and part 5 requires each to be listed there — but none
// of them is an app asset for part 1 to demand a cache rule for.
const NON_APP_DIRS = new Set(['screenshots', 'scripts', 'netlify', 'testing', 'node_modules']);

// `.assetsignore` is read with gitignore semantics — which is what Cloudflare
// documents for it — narrowed to the shapes this file uses: comments, blank
// lines, a trailing `/` for a directory, a leading `/` (or any `/`) meaning the
// pattern is rooted at the repo, and a bare name matching at any depth.
const ignoreRules = read('.assetsignore').split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(pattern => {
    const dirOnly = pattern.endsWith('/');
    const body = (dirOnly ? pattern.slice(0, -1) : pattern).replace(/^\//, '');
    const rx = new RegExp(`^${body.split('*').map(escapeRx).join('[^/]*')}$`);
    const rooted = pattern.startsWith('/') || body.includes('/');
    return {
      pattern,
      test: path => {
        const parts = path.split('/');
        if (dirOnly) {
          // A directory rule matches a file under it, at any depth for a bare
          // name (`node_modules/`) and from the root when it carries a slash.
          return rooted
            ? path === body || path.startsWith(`${body}/`)
            : parts.some(part => rx.test(part));
        }
        if (rooted) return rx.test(path) || path.startsWith(`${body}/`);
        return parts.some(part => rx.test(part));
      },
    };
  });
const ignoredByAssets = path => ignoreRules.find(rule => rule.test(path))?.pattern || null;

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
    if (ignoredByAssets(rel)) continue;
    const path = `/${rel}`;
    ships.add(path);
    if (APP_EXT.has(extname(name)) && !NON_APP_DIRS.has(rel.split('/')[0])) assets.add(path);
  }
})(rootDir);

for (const path of assets) {
  const matching = rules.filter(r => matches(r.pattern, path));
  if (!matching.some(r => revalidates(r.cacheControl))) {
    fail(`${path} ships but no _headers rule that matches it sets a revalidating ` +
      `Cache-Control — it would inherit the platform default ` +
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

// ---- 4. an ignore rule can never take an app file off the deploy ----------
// The app's own manifest of what it loads offline, which is the strongest
// statement in the repo about which files must be reachable.
const shellEntries = [...(/const SHELL = \[([\s\S]*?)\];/.exec(swCode)?.[1] || '')
  .matchAll(/'([^']+)'/g)].map(m => m[1]);
for (const path of assets) {
  const rule = ignoredByAssets(path.replace(/^\//, ''));
  if (rule) {
    fail(`.assetsignore rule "${rule}" matches the app asset ${path} — it would not be uploaded, so the ` +
      'app would lose a file it loads, at the edge and nowhere else.');
  }
}
for (const entry of shellEntries) {
  const rule = ignoredByAssets(entry.replace(/^\//, ''));
  if (rule) {
    fail(`${entry} is in sw.js's SHELL list but .assetsignore rule "${rule}" excludes it — the deploy would ` +
      'ship an app that cannot warm its own offline cache, and nothing else would say why.');
  }
}

// ---- 5. everything that ships is classified -------------------------------
// Part 1 asks whether an app asset revalidates. This asks the other half: is a
// file that is not an app asset meant to be downloadable at all? Nothing was,
// and the ignore list is hand-written — so README imagery sat on the live site
// with no guard reporting it. Docs belong here too: they carry the install steps
// and every secret name.
//
// ONE exemption, and it is the file whose whole purpose is to be fetched:
// robots.txt tells a crawler to keep out of an app nothing here is public, and it
// can only do that if the crawler can read it. It is not an app asset (`.txt` is
// not in APP_EXT, so part 1's revalidation rule does not claim it either) and it
// is not documentation, which is exactly why it needs naming here rather than
// being waved through by a pattern.
const servedOnPurpose = new Set(['/robots.txt']);
const unclassified = [...ships].filter(path => !assets.has(path) && !servedOnPurpose.has(path));
if (unclassified.length) {
  fail(`${unclassified.join(', ')} would be downloadable from the live site: the assets directory is the ` +
    'whole repository, so a file that is not part of the app belongs in .assetsignore.');
}

if (problems.length) {
  console.error(`check-freshness: ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-freshness: OK — ${assets.size} published app asset(s), each revalidating; `
  + `${ignoreRules.length} ignore rule(s), none of them matching an app file; `
  + `all ${ships.size} published file(s) classified; `
  + 'the worker is network-first and its script is never served from cache.');
