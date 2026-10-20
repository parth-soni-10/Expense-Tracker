#!/usr/bin/env node
/**
 * Guards wrangler.toml and functions/_router.js — the two files that decide what a request
 * can reach, and the one class of mistake that leaves no trace anywhere else.
 *
 * Ported from check-netlify-config.mjs, which guarded netlify.toml for exactly
 * this reason: the config is read by the platform before any code runs, so a
 * mistake in it is neither a failing test nor a runtime error — it is a deploy
 * that looks green and an app that is quietly missing an endpoint, a header or a
 * store. The originals are worth keeping in mind:
 *
 *   * the `[[functions]]` array form sat in netlify.toml for seven commits, and
 *     every deploy after it died while Netlify parsed the file, with no gate
 *     able to report anything (which is why run-guards.mjs exists).
 *   * `[headers]` in place of `[[headers]]` was accepted silently and collapsed
 *     every rule into one.
 *   * `command` landing inside `[build.environment]` was accepted and ran no
 *     build at all.
 *
 * What is checked here, each one a way a Cloudflare deploy goes wrong in
 * silence:
 *
 * There is one config now. `wrangler.toml` IS the deployment: `wrangler pages
 * deploy` run from this directory reads it for the project name, the output
 * directory, the KV binding and the vars, and Pages compiles `functions/` beside
 * it — so a Workers-only key in this file is not a stray build setting, it is a
 * second host waiting to be deployed, and the guard fails on it.
 *
 *   1. The deployment's identity: name, a Pages output directory, and a pinned
 *      compatibility date (a date in the future is rejected at deploy time).
 *   2. `nodejs_compat` — the functions use node:crypto's createHash and
 *      timingSafeEqual, and the process.env object the binding loop writes
 *      into. Without the flag those are not there, and the failure is a 500 on
 *      sync, setup links and the profiles admin at runtime.
 *      The setup-token path deliberately does NOT come through here: it is
 *      WebCrypto (lib/tokens.mjs), because node:crypto's CIPHER half is the one
 *      piece of the polyfill that arrived late enough to still be a throwing
 *      mock in a deployed bundle. That is what made every Copy tap in Cloud
 *      sync answer "Unexpected server error" on 16 Oct 2026 while sync, auth
 *      and the profiles admin — none of which encrypt — kept working, and it is
 *      why assertion 2b below pins the token module to crypto.subtle.
 *   3. It is a Pages config and nothing else: no cron triggers, no workers_dev
 *      or preview URLs, no routes, no assets block, and no `main` entry point —
 *      every one of those is Workers-only, and any of them in this file is a
 *      deploy command away from publishing a second copy of this app to a
 *      hostname nobody links to, against the one production KV.
 *   4. Every function route reaches the function. Pages compiles `functions/`
 *      into the deployment, and the catch-all entry hands every request to
 *      `functions/_router.js` — so what has to hold is the other half: the
 *      router hands anything that is not a route to `env.ASSETS.fetch`, since a
 *      request it neither answers nor forwards is a request nothing answers. The two spellings of every endpoint are checked
 *      here too, and the unknown-path-is-a-404 decision now rests on
 *      tools/deploy-pages.mjs generating the upload's 404.html.
 *   5. The KV binding, in the config the deploy reads: the durable store. Without
 *      it lib/store.mjs answers `durable: false`, and lib/cloud.mjs then treats
 *      the GITHUB MIRROR as the commit point for someone's expenses instead of a
 *      spare copy.
 *   6. No secret in either `[vars]` block. Both files are committed; secrets are
 *      set on the Pages project. A password or token pasted into [vars] would be
 *      published to anyone who can read the repo AND served as a plain string
 *      binding — so the declared variable names are held to an allowlist of
 *      non-secret coordinates, and their values are shape-checked.
 *   7. The daily reminder stays removed: its files, its routes and the service
 *      worker's push machinery must not come back (see the block below).
 *   8. Routing completeness: every route in functions/_router.js maps to a file that
 *      exists, every function file IS routed, and the route the browser defaults
 *      to is served.
 *   9. Guard wiring: every guard on disk is in scripts/run-guards.mjs's list, and
 *      every name in that list exists — in both directions, because either half
 *      alone leaves a guard that never runs and a deploy that stays green.
 *  10. CI runs the same suite under the same runtime.
 *  11. Every env var the functions read is documented in README.md, and so is
 *      every guard the suite runs — the README is the install guide for a
 *      hand-configured deployment, and a variable that exists only in code
 *      surfaces as a runtime failure nobody can act on.
 *  12. netlify.toml does not come back. Cloudflare ignores it completely, so a
 *      resurrected one is worse than none: the file the guards read would stop
 *      being the file that is served.
 *
 * Run: node scripts/check-worker-config.mjs
 * First guard in scripts/run-guards.mjs — cheapest, and the only one whose
 * failure explains why the others might have reported nothing.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const toml = read('wrangler.toml');
const stageScript = read('tools/deploy-pages.mjs');
const router = read('functions/_router.js');
const functionsDir = new URL('netlify/functions/', root);
const scriptsDir = new URL('scripts/', root);

// The Node the suite itself needs (ESM-by-syntax-detection for this repo's plain
// .js modules), and the floor CI must run one of its legs on: README.md says so,
// and app/package.json's `engines` is where the shell gets it from.
const MIN_NODE = 22;

// Variables that are configuration, not credentials: they name a private repo
// whose contents only a token can read. Everything else the functions need — the
// root secret, the app password, the PAT — is a secret.
const VAR_ALLOWLIST = new Set(['REPO_OWNER', 'REPO_NAME', 'REPO_BRANCH', 'REPO_FILE']);

const problems = [];
const add = (line, message) => problems.push(`wrangler.toml:${line}: ${message}`);
const fail = (message) => problems.push(message);

/** Drop a trailing comment, ignoring `#` inside a quoted string. */
function stripComment(line) {
  let out = '';
  let quote = null;
  for (const ch of line) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '#') break;
    else out += ch;
  }
  return out;
}

const unquote = v => String(v).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
/** `[assets]` → `assets`; `[[kv_namespaces]]` → `kv_namespaces`. */
const tablePath = s => s.split('.').map(p => p.trim().replace(/^"(.*)"$/, '$1')).join('.');

// ---- a small reader for the TOML shapes this file uses ---------------------
const tables = new Map();       // path → line of its declaration
const arrays = new Map();       // path → line (array-of-tables blocks repeat)
const keys = [];                // { path, key, value, line, items }
const kvBlocks = [];            // one entry per [[kv_namespaces]] block
let current = null;

for (const [i, raw] of toml.split('\n').entries()) {
  const line = stripComment(raw).trim();
  if (!line) continue;
  const lineNo = i + 1;

  let m = /^\[\[(.+)\]\]$/.exec(line);
  if (m) {
    const path = tablePath(m[1]);
    if (tables.has(path)) add(lineNo, `[[${path}]] follows [${path}] — pick one form.`);
    arrays.set(path, lineNo);
    current = path;
    if (path === 'kv_namespaces') kvBlocks.push({ line: lineNo });
    continue;
  }
  m = /^\[(.+)\]$/.exec(line);
  if (m) {
    const path = tablePath(m[1]);
    if (tables.has(path) || arrays.has(path)) {
      add(lineNo, `[${path}] is declared twice — TOML forbids redefining a table.`);
    }
    tables.set(path, lineNo);
    current = path;
    continue;
  }
  m = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
  if (m) {
    const value = m[2].trim();
    const items = /^\[([\s\S]*)\]$/.exec(value)?.[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(unquote);
    keys.push({ path: current, key: m[1], value: unquote(value), items, line: lineNo });
  }
}

const topLevel = key => keys.find(k => k.path === null && k.key === key);

/**
 * The same key/value shapes, flattened to one entry per line.
 *
 * A second reader rather than a second pass of the one above: that one rewrites
 * module-level maps as it goes, which is fine for the checks below and a trap for
 * a pass that only wants each entry's table path (the `[vars]` and
 * `[[kv_namespaces]]` blocks, which are read as a set rather than by name).
 */
function readEntries(text) {
  const entries = [];
  let table = null;
  for (const [i, raw] of text.split('\n').entries()) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    let m = /^\[\[(.+)\]\]$/.exec(line) || /^\[(.+)\]$/.exec(line);
    if (m) {
      table = tablePath(m[1]);
      continue;
    }
    m = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (m) entries.push({ path: table, key: m[1], value: unquote(m[2].trim()), line: i + 1 });
  }
  return entries;
}

const deployEntries = readEntries(toml);
const deployKv = deployEntries.filter(e => e.path === 'kv_namespaces');
const deployAdd = (line, message) => problems.push(`wrangler.toml:${line}: ${message}`);
const deployTop = key => deployEntries.find(e => e.path === null && e.key === key);

// ---- 1. identity -----------------------------------------------------------
if (!topLevel('name')) fail('wrangler.toml declares no top-level `name` — the deploy has no project to publish to.');
const outDir = deployTop('pages_build_output_dir');
if (!outDir) {
  fail('wrangler.toml declares no `pages_build_output_dir` — `wrangler pages deploy` from this directory would publish nothing, and the Pages build would look for an output directory it was never told.');
} else if (outDir.value !== '.pages-dist') {
  add(outDir.line, `pages_build_output_dir = "${outDir.value}" — the upload is the staging directory tools/deploy-pages.mjs writes (".pages-dist"), so anything else points at a directory nothing produces, or at the repository itself, which would publish every development file it carries.`);
}

// The staged output and the function sources both sit inside the assets
// directory, so both have to be in the filter that stages the upload. A missing
// rule is not a broken build: it is the router's source, or the staged copy of
// the whole site, served as a file — which is the one mistake nothing else here
// can see.
const ignoredPaths = read('.assetsignore')
  .split('\n')
  .map((line) => line.replace(/#.*$/, '').trim());
for (const required of ['functions/', '.pages-dist/']) {
  if (!ignoredPaths.includes(required)) {
    fail(`.assetsignore does not list ${required} — the assets directory is the repository root, so without that rule the upload carries it and Pages serves it as a file.`);
  }
}
if (topLevel('main')) {
  add(topLevel('main').line, 'declares `main` — that is a Worker entry point. This site is one Pages project whose function is `functions/[[path]].js`, so a `main` here is a Worker waiting to be deployed beside it.');
}

const compatDate = topLevel('compatibility_date');
if (!compatDate) {
  fail('wrangler.toml declares no `compatibility_date` — the runtime would follow the Worker\'s original date instead of the one this port was verified against.');
} else if (!/^\d{4}-\d{2}-\d{2}$/.test(compatDate.value)) {
  add(compatDate.line, `compatibility_date = "${compatDate.value}" is not YYYY-MM-DD.`);
} else if (Date.parse(compatDate.value) > Date.now()) {
  add(compatDate.line, `compatibility_date = "${compatDate.value}" is in the future — Cloudflare refuses a date later than today.`);
}

// ---- 2. the Node compatibility the functions need --------------------------
const flags = topLevel('compatibility_flags')?.items || [];
if (!flags.includes('nodejs_compat')) {
  fail('compatibility_flags does not include "nodejs_compat" — the functions use node:crypto\'s createHash/timingSafeEqual and process.env, so sync, setup links and the profiles admin would 500 at runtime.');
}

// ---- 2b. the token path encrypts with WebCrypto, not node:crypto -----------
// A mocked cipher is the one failure this config cannot show and no runtime test
// can catch: workerd implemented createCipheriv/createDecipheriv on 12 Mar 2025
// and Wrangler only stopped substituting its unenv mock on 22 Mar 2025 (4.4.0),
// so a bundle built against anything older throws
// `[unenv] crypto.createCipheriv is not implemented yet!` at the moment a link
// is MINTED — not at import, not at boot, and nowhere any of the other guards
// look. That is the class of failure behind every Copy tap on this deployment
// answering "Unexpected server error" on 16 Oct 2026 while sync, auth and the
// profiles admin kept working: those three import node:crypto too, but only
// createHash, timingSafeEqual and randomBytes, which the older polyfill always
// had — measured, not assumed: a wrong password on the token route answers 401
// `Bad app password`, so the throw was inside the mint, after the compare.
// It is pinned here rather than reproduced because a current wrangler no longer
// mocks the cipher, and the older-runtime replay that was tried failed for an
// unrelated reason (no `process` global). WebCrypto has no such history —
// crypto.subtle and crypto.getRandomValues are native in every runtime this app
// targets, and no bundler preset can substitute a mock for them. Buffer is
// called out beside the cipher for the same reason: Node's base64url codec is
// on that mint path, is just as node-only, and the fix removed it too.
const tokenModule = read('netlify/functions/lib/tokens.mjs');
// Comments are stripped because this file's header explains the bug BY NAME,
// which is the whole reason the assertions below can be about code alone.
const tokenCode = tokenModule
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\n]*$/gm, '');
if (/from\s+'node:crypto'|require\('node:crypto'\)/.test(tokenCode)) {
  fail('netlify/functions/lib/tokens.mjs imports node:crypto — its ciphers are the newest part of the polyfill and were mocked on this deployment, so every setup link 500ed. Use crypto.subtle (WebCrypto).');
}
if (/\bcreateCipheriv\b|\bcreateDecipheriv\b|\bgetAuthTag\b|\bBuffer\b/.test(tokenCode)) {
  fail('netlify/functions/lib/tokens.mjs reaches for a node:crypto cipher or Buffer — the token path must encrypt with WebCrypto (crypto.subtle.encrypt/decrypt and crypto.getRandomValues), which no runtime call can turn into "not implemented".');
}
if (!/crypto\.subtle\.encrypt/.test(tokenCode) || !/crypto\.subtle\.decrypt/.test(tokenCode)
  || !/crypto\.subtle\.importKey/.test(tokenCode) || !/crypto\.getRandomValues/.test(tokenCode)) {
  fail('netlify/functions/lib/tokens.mjs no longer encrypts with crypto.subtle.encrypt/decrypt + importKey, or no longer draws its nonce from crypto.getRandomValues — setup links are AES-256-GCM tokens and both halves are load-bearing (a reused or weak nonce breaks GCM outright).');
}

// ---- 3. it is a Pages config, not a Worker one ------------------------------
// Every Workers-only key below is one `wrangler deploy` away from publishing this
// app to a second hostname against the one production KV — and the export would
// be silent, because the Pages deployment keeps working either way, so nothing a
// reader looks at would look wrong. `main`, `routes` and an `[assets]` block are
// the three that would do it without any deliberate command at all: each one
// makes this file deployable as a Worker as it stands.
const WORKERS_ONLY = [
  ['triggers', 'cron triggers'],
  ['workers_dev', 'the workers.dev hostname'],
  ['preview_urls', 'versioned Preview URLs'],
  ['routes', 'a Workers route'],
  ['assets', 'a static-assets block'],
];
for (const [table, what] of WORKERS_ONLY) {
  const line = tables.get(table) ?? arrays.get(table) ?? topLevel(table)?.line ?? null;
  if (line) {
    add(line, `declares ${what} (${table}) — this is the Pages project's config, so a Workers-only key here is a second deployment waiting to be published. The runtime variables this site needs are in [vars]; the bindings are the [[…]] blocks.`);
  }
}

const routesBlock = /const ROUTES = \{([\s\S]*?)\n\};/.exec(router)?.[1] || '';
// Every route is a quoted path mapped to an imported handler. The pattern
// matches ANY path rather than one prefix on purpose: the Worker serves two
// spellings of each endpoint (/api/*, and the /.netlify/functions/* name every
// device set up before the rename still has saved), and a pattern that only
// recognised one of them would stop checking the other — which is exactly what
// a half-emptied route table looks like from here: no error, just fewer routes.
const routes = [...routesBlock.matchAll(/'([\w./-]+)'\s*:\s*(\w+)/g)]
  .map(m => ({ path: m[1], local: m[2] }));
if (!routes.length) fail('functions/_router.js declares no ROUTES — every function path the app calls would 404.');

// Both spellings of every endpoint, paired to the same handler. This table is a
// contract with two kinds of client — a fresh install (the endpoint settings.js
// defaults to) and a device holding the pre-rename name — and neither half may
// go missing quietly: the app's own default would 404, or a device that never
// re-saved its settings could only be repaired by hand. The function tests call
// the handlers directly, so nothing else in the suite would notice either way.
const API_PREFIX = '/api/';
const LEGACY_PREFIX = '/.netlify/functions/';
const twinOf = (routePath, from, to) => routes.find(r => r.path === to + routePath.slice(from.length));
for (const route of routes.filter(r => r.path.startsWith(API_PREFIX))) {
  const twin = twinOf(route.path, API_PREFIX, LEGACY_PREFIX);
  if (!twin) {
    fail('functions/_router.js serves ' + route.path + ' but not ' + LEGACY_PREFIX + route.path.slice(API_PREFIX.length)
      + ' — dropping the pre-rename spelling strands every device that has that name saved: its request falls through to the assets layer and 404s, and the app cannot repair it from the UI.');
  } else if (twin.local !== route.local) {
    fail('functions/_router.js sends ' + route.path + ' to ' + route.local + ' and ' + twin.path + ' to ' + twin.local
      + ' — the two spellings of one endpoint must be the same function, or which handler answers depends on the name a device happens to have stored.');
  }
}
for (const route of routes.filter(r => r.path.startsWith(LEGACY_PREFIX))) {
  if (!twinOf(route.path, LEGACY_PREFIX, API_PREFIX)) {
    fail('functions/_router.js serves ' + route.path + ' with no ' + API_PREFIX + route.path.slice(LEGACY_PREFIX.length)
      + ' twin — the /api/ spelling is the endpoint a fresh install defaults to, so it would have no route at all.');
  }
}

// Pages compiles functions/ into the deployment, and the catch-all entry hands
// every request to this router, so the coverage question the Workers assets layer
// asked is settled structurally. What still has to hold is the other half of that
// contract: a path this router does not route must be handed to the assets layer
// rather than answered here.
if (!/env\.ASSETS\.fetch\(request\)/.test(router)) {
  fail('functions/_router.js never calls env.ASSETS.fetch(request) — every request that reaches the function would be answered by it (with nothing) instead of by the assets layer.');
}

// ---- 3b. an unknown path is still a 404 -------------------------------------
// The decision the Workers assets layer carried (not_found_handling = "none")
// has no Pages equivalent: without a 404.html in the upload, Pages answers 200
// with index.html for every unmatched path — including an asset the app mistyped,
// which is the blank page this app's hash routing exists to avoid. The staging
// script writes that file when the assets have none, so the property is pinned to
// the script that stages the upload rather than to a config key that no longer
// exists.
if (!/404\.html/.test(stageScript)) {
  fail('tools/deploy-pages.mjs no longer writes a 404.html — without one in the upload, Pages answers 200 with index.html for every unknown path, which is what not_found_handling = "none" prevented on the Workers side.');
}
// And the keys themselves must not come back: reading one in a config that Pages
// ignores would look like a live decision while changing nothing.
for (const entry of keys) {
  if (entry.key === 'not_found_handling' || entry.key === 'html_handling') {
    fail(`wrangler.toml declares ${entry.key} — Pages has no such setting, so it would read as a live decision while changing nothing. The 404 comes from the staged 404.html checked above.`);
  }
}

// ---- 4. the durable store, in the config the deploy reads --------------------
// The binding travels with the deployment, so it lives in the one config a
// deploy reads — the same file the pages_build_output_dir above comes from.
const deployBinding = deployKv.find(k => k.key === 'binding');
const deployId = deployKv.find(k => k.key === 'id');
if (!deployBinding) {
  fail('wrangler.toml binds no KV namespace — with no durable store lib/store.mjs answers `durable: false`, and lib/cloud.mjs then commits profiles to the GitHub mirror instead of the primary (and to memory when there is no mirror).');
} else if (deployBinding.value !== 'CENTS_KV') {
  deployAdd(deployBinding.line, `binding = "${deployBinding.value}" — functions/_router.js hands lib/store.mjs the namespace as env.CENTS_KV, so a different binding name attaches a namespace nothing can reach.`);
}
if (!deployId || !/^[0-9a-f]{32}$/.test(deployId.value || '')) {
  deployAdd(deployId?.line ?? deployBinding?.line ?? 1, '[[kv_namespaces]] has no 32-hex `id` — the deploy would attach a namespace other than the one the data is in.');
}

// ---- 5. no secret in a committed file --------------------------------------
// The config is committed, so it is held to the rule: Cents' secrets (the root
// secret, the app passwords, the GitHub token) are set on the
// Pages project out of band and appear in no file here.
const varsBlock = [
  ...keys.filter(k => k.path === 'vars').map(k => ({ ...k, file: 'wrangler.toml', problem: add })),
];
for (const entry of varsBlock) {
  if (!VAR_ALLOWLIST.has(entry.key)) {
    entry.problem(entry.line, `${entry.file}'s [vars] declares ${entry.key}. Only ${[...VAR_ALLOWLIST].join(', ')} belong here — the file is committed and a variable is a plain string binding, so a password or key pasted here is published AND served. Set it on the Pages project instead.`);
  }
  if (/^(ghp_|github_pat_|gho_|glpat-)/.test(entry.value) || /^[0-9a-f]{40}$/.test(entry.value)) {
    entry.problem(entry.line, `${entry.file}'s [vars] ${entry.key} looks like a credential — this repository is public to anyone who can read it. Set it on the Pages project instead.`);
  }
}
// The other direction: a declared variable the code never reads is dead config
// that reads like a working setting.
const functionSources = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.m?js$/.test(entry.name)) functionSources.push(readFileSync(full, 'utf8'));
  }
})(fileURLToPath(functionsDir));
const readEnv = new Set();
for (const source of functionSources) {
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) readEnv.add(m[1]);
}
for (const entry of varsBlock) {
  if (!readEnv.has(entry.key)) {
    entry.problem(entry.line, `${entry.file}'s [vars] declares ${entry.key}, but no function reads it — a setting that does nothing still reads like a configured one.`);
  }
}

// ---- 6. the daily reminder stays removed ------------------------------------
// The feature was removed rather than re-scheduled, and a half-restored copy is
// worse than one that never existed: the app would offer a reminder sheet for a
// job nothing runs, and the service worker would hold a push handler waiting for
// a payload no deployment can send. So the removal is pinned from this side too —
// the files, the routes and the worker's reminder machinery all have to stay
// absent, in the same spirit as §11 and for the same reason.
const REMOVED_WITH_THE_REMINDER = [
  'reminders.js',
  'netlify/functions/reminders-push.mjs',
  'netlify/functions/reminders-tick.mjs',
  'netlify/functions/lib/reminder-run.mjs',
  'netlify/functions/lib/webpush.mjs',
  'scripts/test-reminder-push.mjs',
];
for (const gone of REMOVED_WITH_THE_REMINDER) {
  if (existsSync(new URL(gone, root))) {
    fail(`${gone} is back. The daily reminder was removed outright (its scheduler, its Web Push sender and the trigger behind it), so a resurrected file is a second, unreachable copy of a feature the app no longer offers.`);
  }
}
if (/reminders-(push|tick)/.test(router)) {
  fail('functions/_router.js routes a reminder endpoint again — nothing in the app calls one, so the route would answer a request that no longer exists.');
}
const swSrc = read('sw.js');
if (/addEventListener\('(push|periodicsync)'/.test(swSrc)) {
  fail("sw.js registers a 'push' or 'periodicsync' listener again — no server sends a payload now, and a wake with no schedule behind it can only raise a notification the app has no setting for.");
}

// ---- 7. routing completeness ------------------------------------------------
const imports = new Map();
for (const m of router.matchAll(/^import\s+(\w+)\s+from\s+'([^']+)';$/gm)) imports.set(m[1], m[2]);

// Resolved against the router's own directory, because that is what its
// relative imports are relative to — the file moved from the repository root
// into functions/ when the Workers config went away, and a check that kept
// resolving from the root would call every one of those imports missing.
const routerDir = new URL('functions/', root);
for (const route of routes) {
  const file = imports.get(route.local);
  if (!file) {
    fail(`functions/_router.js routes ${route.path} to ${route.local}, which it does not import — the route would throw on the first request.`);
  } else if (!existsSync(new URL(file, routerDir))) {
    fail(`functions/_router.js imports ${file} for ${route.path}, which does not exist.`);
  }
}

// The endpoint the browser defaults to (settings.js) has to be one of them: it
// is the path every other endpoint is derived from at runtime.
// Read from the exported constant, because that is where the name lives now —
// and require the defaults object to USE it, so the exported name and the value
// a device actually gets cannot drift apart. A hardcoded literal in the object
// would leave the constant decorative: shown in the Sync screen, ignored by
// every request.
const settingsSrc = read('app/lib/settings.ts');
const defaultEndpoint = /export const DEFAULT_SYNC_ENDPOINT = '([^']+)'/.exec(settingsSrc)?.[1];
if (!defaultEndpoint) {
  fail('settings.js declares no DEFAULT_SYNC_ENDPOINT — this guard cannot tell which route the app calls, and neither can a reader.');
} else if (!/endpoint: DEFAULT_SYNC_ENDPOINT,/.test(settingsSrc)) {
  fail('settings.js declares DEFAULT_SYNC_ENDPOINT but its SYNC_DEFAULTS do not use it, so the name this guard checks is not the endpoint a device gets.');
} else if (!routes.some(r => r.path === defaultEndpoint)) {
  fail(`settings.js defaults to ${defaultEndpoint}, which functions/_router.js does not route — the app's Sync screen would 404 on every request.`);
}

// Every function file is routed: one that is neither routed nor imported is
// compiled, deployed and answers nothing.
const routedFiles = new Set([...routes].map(r => imports.get(r.local)).filter(Boolean));
const functionFiles = readdirSync(functionsDir).filter(f => /\.mjs$/.test(f));
for (const file of functionFiles) {
  const rel = `../netlify/functions/${file}`;
  if (!routedFiles.has(rel)) {
    fail(`netlify/functions/${file} is not routed by functions/_router.js — it would be compiled, deployed and unreachable, and nothing else would say so.`);
  }
}

// ---- 8. every guard is wired, and every wired name exists -------------------
const runGuards = read('scripts/run-guards.mjs');
// Comments stripped first, for the same reason the CI check below strips them:
// each entry carries a trailing `// …` note and those notes are prose — one
// contains an apostrophe, which is enough to make a quote-matching regex read a
// sentence as a filename. A check that prose can satisfy is not a check.
const declared = [...(/const GUARDS = \[([\s\S]*?)\n\];/.exec(runGuards)?.[1] || '')
  .replace(/\/\/[^\n]*/g, '')
  .matchAll(/'([^']+)'/g)].map(m => m[1]);
if (!declared.length) fail('scripts/run-guards.mjs declares no guard list — nothing would run the suite at all.');
const guardFiles = readdirSync(scriptsDir).filter(f => /^(check|test)-[\w.-]+\.mjs$/.test(f));
for (const guard of guardFiles) {
  if (!declared.includes(guard)) {
    fail(`scripts/${guard} exists but scripts/run-guards.mjs never runs it — it would guard nothing, silently.`);
  }
}
for (const name of declared) {
  if (!existsSync(new URL(`scripts/${name}`, root))) {
    fail(`scripts/run-guards.mjs runs scripts/${name}, which does not exist — the whole suite would stop at it.`);
  }
}

// ---- 9. CI runs the same suite, on more than one runtime ---------------------
const workflow = new URL('.github/workflows/guards.yml', root);
if (!existsSync(workflow)) {
  fail('.github/workflows/guards.yml is gone — without it a config mistake is only discovered by a failed deploy, which is how seven commits went unshipped.');
} else {
  // Comments stripped first: this file explains in prose which script it runs,
  // and a check a comment can satisfy would pass with the run line gone.
  const yml = readFileSync(workflow, 'utf8').replace(/^[ \t]*#.*$/gm, '');
  const runs = [...yml.matchAll(/^\s*run:\s*(.+)$/gm)].map(m => m[1].trim());
  if (!runs.some(r => r.includes('scripts/run-guards.mjs'))) {
    fail('.github/workflows/guards.yml does not run scripts/run-guards.mjs — CI would check something other than what the guards declare'
      + (runs.length ? ` (it runs: ${runs.join('; ')})` : ' (no run step at all).'));
  }

  /* The runtime, and how many of them. A single pin makes "the guards pass" a
     claim about one Node: a guard that leans on module-resolution or type-
     stripping behaviour that moved between releases looks green until something
     runs it elsewhere. So the suite runs on at least two legs, one of which is
     MIN_NODE — the floor app/package.json's `engines` and the app-shell job
     build against, and the version this repo was developed on.

     Both the matrix and the setup-node step are read from the `guards` job
     alone. A matrix found anywhere in the file could be another job's, and the
     whole point is that THIS job runs the suite on both runtimes. */
  const guardsJob = yml.split(/^(?= {2}[\w-]+:[ \t]*$)/m).find((job) => /^ {2}guards:[ \t]*\r?\n/.test(job)) || '';
  const pinned = /node-version:\s*['"]?(\d+)/.exec(guardsJob)?.[1];
  const matrix = /node:\s*\[([^\]]*)\]/.exec(guardsJob)?.[1];
  const versions = matrix
    ? matrix.split(',').map(v => Number(v.trim().replace(/^['"]|['"]$/g, ''))).filter(Number.isFinite)
    : [];
  if (!versions.length) {
    fail(`.github/workflows/guards.yml runs the suite on ${pinned ? `one runtime (node-version ${pinned})` : 'no declared runtime'}`
      + ` — at least two legs are required, and ${MIN_NODE} must be one of them: one pin cannot tell a version-sensitive`
      + ' guard from a guard that is simply broken.');
  } else {
    if (versions.length < 2) {
      fail(`.github/workflows/guards.yml lists ${versions.length} runtime(s) (${versions.join(', ')}) — the matrix needs at least`
        + ' two, or a Node-version-sensitive guard has nothing to disagree with.');
    }
    const below = versions.filter(v => v < MIN_NODE);
    if (below.length) {
      fail(`.github/workflows/guards.yml runs the suite on Node ${below.join(', ')}; the floor is ${MIN_NODE}, and older Node`
        + ' parses seed.js and tesco.js as CommonJS and dies.');
    }
    if (!versions.includes(MIN_NODE)) {
      fail(`.github/workflows/guards.yml never runs the suite on Node ${MIN_NODE} — that is the version the app shell builds on`
        + ' (`engines`), so the floor itself would ship untested while a newer runtime goes green.');
    }
    /* The version has to reach setup-node, not merely be declared, and not
       merely appear somewhere in the job: an earlier draft of this check looked
       for `matrix.node` anywhere, which the step's NAME satisfied while
       `node-version:` had been hard-coded back to a single value. So the
       assertion is against the setup-node step's own `with:` block. */
    const setupStep = guardsJob.split(/\n\s*-\s*/).find((step) => /uses:\s*actions\/setup-node@/.test(step)) || '';
    if (!/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/.test(setupStep)) {
      fail('.github/workflows/guards.yml does not feed `${{ matrix.node }}` to setup-node — every leg would run whatever'
        + ' version the runner happens to have, while the job reads as if it were a matrix.');
    }
    if (!/fail-fast:\s*false/.test(guardsJob)) {
      fail('.github/workflows/guards.yml does not set `fail-fast: false` — one failing leg would cancel the other, and the'
        + ' pair exists to say whether a change is version-sensitive or broken everywhere.');
    }
  }
}

// ---- 9b. the manifest check runs where its subject changes ------------------
// The manifest is the design system's, but every floor in it is a claim about
// this repo, so the run that proves it has to start here and the job that
// performs it lives one repo away. Two things can quietly undo that: deleting
// this workflow (the check goes back to being a hand-run), or editing it so it
// stops calling the shared job (it then checks something else, or nothing, while
// still going green).
const components = new URL('.github/workflows/components.yml', root);
if (!existsSync(components)) {
  fail('.github/workflows/components.yml is gone. The design-system manifest floors are claims about this repo,'
    + ' and the only thing that re-proves them was this job; without it a card deleted from a screen is found by nobody.');
} else {
  // Comments stripped for the same reason as above: this file explains the
  // arrangement in prose, and prose must not be able to satisfy the check.
  const yml = readFileSync(components, 'utf8').replace(/^[ 	]*#.*$/gm, '');
  const reusable = /uses:\s*[\w.-]+\/design-system\/\.github\/workflows\/components\.yml@/.exec(yml);
  if (!reusable) {
    fail('.github/workflows/components.yml no longer calls the design-system reusable components workflow'
      + ' (`uses: <owner>/design-system/.github/workflows/components.yml@<ref>`). A local copy of the verifier would'
      + ' be a second design system, and a job that does something else is not this check.');
  }
  if (!/^\s*site:\s*cents\s*$/m.test(yml)) {
    fail('.github/workflows/components.yml does not pass `site: cents`, so the run would verify (or fail on) a slug that is not this app.');
  }
}

// ---- 10. every variable and guard is written down somewhere ------------------
// The README became a product page — what the app does, who it is for — and the
// install guide (variables, the guard suite) moved to CLAUDE.md, the doc a
// deployment is actually configured from. Both are read, so a name documented
// in either file counts, and a variable or guard documented in neither still
// fails: the check is that the information exists, not which cover it sits on.
const docs = read('README.md') + '\n' + read('CLAUDE.md');
const undocumentedEnv = [...readEnv].filter(name => !docs.includes(name));
if (undocumentedEnv.length) {
  fail(`neither README.md nor CLAUDE.md documents ${undocumentedEnv.join(', ')} — the functions read it, so a hand-configured deployment fails at runtime instead.`);
}
const unlistedGuards = declared.filter(name => !docs.includes(name));
if (unlistedGuards.length) {
  fail(`neither README.md nor CLAUDE.md lists ${unlistedGuards.join(', ')} — the suite runs them, so the reader cannot know they exist or run them by hand.`);
}

// ---- 11. the old config must not come back ----------------------------------
if (existsSync(new URL('netlify.toml', root))) {
  fail('netlify.toml is back. Cloudflare ignores it entirely, so a resurrected one is worse than none: the config the guards read would stop being the config that is served.');
}

if (problems.length) {
  console.error(`check-worker-config: ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-worker-config: OK — ${routes.length} route(s) behind the catch-all entry, `
  + `${deployKv.length} binding(s) in the Pages config, ${varsBlock.length} documented variable(s), `
  + `${declared.length} guard(s) wired, ${readEnv.size} env var(s) documented.`);
