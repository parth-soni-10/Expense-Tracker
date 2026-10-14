#!/usr/bin/env node
/**
 * Guards wrangler.toml and functions/_router.js — the two files that decide what a request
 * can reach, and the one class of mistake that leaves no trace anywhere else.
 *
 * Ported from check-netlify-config.mjs, which guarded netlify.toml for exactly
 * this reason: the config is read by the platform before any code runs, so a
 * mistake in it is neither a failing test nor a runtime error — it is a deploy
 * that looks green and an app that is quietly missing an endpoint, a header, a
 * store or the daily reminder. The originals are worth keeping in mind:
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
 *   2. `nodejs_compat` — the functions use node:crypto (createECDH for the VAPID
 *      pair, createSign, createCipheriv), Buffer, and the process.env object the
 *      binding loop writes into. Without the flag those are not there, and the
 *      failure is a 500 on push and sync at runtime.
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
 *   7. The reminder job's single home: the job is written once in
 *      lib/reminder-run.mjs, the HTTP trigger runs THAT rather than a copy of
 *      it, and the run's look-back window is wide enough that a late run still
 *      catches its target (see the block below).
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
// .js modules). CI must pin at least this, and README.md says so.
const MIN_NODE = 22;

// Variables that are configuration, not credentials: they name a private repo
// whose contents only a token can read. Everything else the functions need — the
// root secret, the app password, the VAPID pair, the PAT — is a secret.
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

const get = (path, key) => keys.find(k => k.path === path && k.key === key);
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
  fail('compatibility_flags does not include "nodejs_compat" — the functions use node:crypto (the VAPID pair, the payload encryption, the recovery tokens), Buffer and process.env, so push and sync would 500 at runtime.');
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
// secret, the app passwords, the VAPID pair, the GitHub token) are set on the
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

// ---- 6. the reminder job's single home --------------------------------------
// The job is reached over HTTP by the app's own call (reminders-tick.mjs), so
// what has to stay true is that it is written once and that a run landing late
// still catches its target: one copy of the loop, one answer to "was this device
// already sent to today".
const runSrc = read('netlify/functions/lib/reminder-run.mjs');
const tickSrc = read('netlify/functions/reminders-tick.mjs');
if (!/runReminderTick/.test(tickSrc)) {
  fail('reminders-tick.mjs does not run lib/reminder-run.mjs — it is the ONLY entry point to the reminder job, so no reminder would ever be sent at all.');
}
const windowMinutes = Number(/const WINDOW_MINUTES = (\d+)/.exec(runSrc)?.[1]);
if (!Number.isFinite(windowMinutes) || windowMinutes < 1) {
  fail(`lib/reminder-run.mjs's WINDOW_MINUTES reads ${windowMinutes} — the run's look-back window must be at least a minute wide, or a run that lands a few seconds late finds nothing due and skips the day's reminder.`);
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
const settingsSrc = read('settings.js');
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

// ---- 9. CI runs the same suite, on the same runtime -------------------------
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
  const node = /node-version:\s*['"]?(\d+)/.exec(yml)?.[1];
  if (!node) fail(`.github/workflows/guards.yml pins no node-version — the suite needs Node ${MIN_NODE}+ for ESM-by-syntax-detection on this repo's plain .js modules.`);
  else if (Number(node) < MIN_NODE) {
    fail(`.github/workflows/guards.yml pins node-version ${node}; the suite needs ${MIN_NODE}+ or it dies parsing seed.js and tesco.js as CommonJS.`);
  }
}

// ---- 10. the README is the install guide ------------------------------------
const readme = read('README.md');
const undocumentedEnv = [...readEnv].filter(name => !readme.includes(name));
if (undocumentedEnv.length) {
  fail(`README.md documents no such variable: ${undocumentedEnv.join(', ')} — the functions read it, so a hand-configured deployment fails at runtime instead.`);
}
const unlistedGuards = declared.filter(name => !readme.includes(name));
if (unlistedGuards.length) {
  fail(`README.md never lists ${unlistedGuards.join(', ')} — the suite runs them, so the reader cannot know they exist or run them by hand.`);
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
