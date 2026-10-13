#!/usr/bin/env node
/**
 * Guards wrangler.toml and worker.js — the two files that decide what a request
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
 *   1. The Worker's identity: name, an entry point that exists, a pinned
 *      compatibility date (a date in the future is rejected at deploy time).
 *   2. `nodejs_compat` — the functions use node:crypto (createECDH for the VAPID
 *      pair, createSign, createCipheriv), Buffer, and the process.env object the
 *      binding loop writes into. Without the flag those are not there, and the
 *      failure is a 500 on push and sync at runtime.
 *   3. The assets config: the site is the repo root, and `run_worker_first` must
 *      cover every route worker.js declares. Miss that and the Worker is never
 *      invoked for the API paths at all — the assets layer answers 404 for a
 *      prefix those files are not under — while the static site keeps working,
 *      which is exactly the kind of half-broken deploy nobody notices locally.
 *   4. The KV binding: the durable store. Without it lib/store.mjs answers
 *      `durable: false`, and lib/cloud.mjs then treats the GITHUB MIRROR as the
 *      commit point for someone's expenses instead of a spare copy.
 *   5. No secret in `[vars]`. wrangler.toml is committed; secrets are set with
 *      `wrangler secret put`. A password or token pasted into [vars] would be
 *      published to anyone who can read the repo AND served as a plain string
 *      binding — so the declared variable names are held to an allowlist of
 *      non-secret coordinates, and their values are shape-checked.
 *   6. The reminder pairing, which is spread across two files and cannot be seen
 *      from either one (see the block below).
 *   7. Routing completeness: every route in worker.js maps to a file that
 *      exists, every function file is either routed or is the cron's entry
 *      point by name, the route the browser defaults to is served, and the cron
 *      entry point is deliberately NOT URL-reachable.
 *   8. Guard wiring: every guard on disk is in scripts/run-guards.mjs's list, and
 *      every name in that list exists — in both directions, because either half
 *      alone leaves a guard that never runs and a deploy that stays green.
 *   9. CI runs the same suite under the same runtime.
 *  10. Every env var the functions read is documented in README.md, and so is
 *      every guard the suite runs — the README is the install guide for a
 *      hand-configured deployment, and a variable that exists only in code
 *      surfaces as a runtime failure nobody can act on.
 *  11. netlify.toml does not come back. Cloudflare ignores it completely, so a
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
const worker = read('worker.js');
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

// ---- 1. identity -----------------------------------------------------------
if (!topLevel('name')) fail('wrangler.toml declares no top-level `name` — the Worker has no hostname to deploy to.');
if (!topLevel('main')) fail('wrangler.toml declares no `main` — there is nothing to deploy.');
else if (!existsSync(new URL(topLevel('main').value, root))) {
  add(topLevel('main').line, `main = "${topLevel('main').value}" does not exist — the deploy dies with nothing served.`);
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

// ---- 3. assets and the prefix that routes to this Worker -------------------
const assets = { dir: get('assets', 'directory'), binding: get('assets', 'binding'), first: get('assets', 'run_worker_first') };
if (!assets.dir) fail('[assets] declares no `directory` — half the app would not be served.');
else if (assets.dir.value !== '.') {
  add(assets.dir.line, `[assets] directory = "${assets.dir.value}" — the site is the repository root, the same directory that was published before; a different one serves a different app.`);
}
if (!assets.binding) fail('[assets] declares no `binding` — worker.js fetches it as env.ASSETS.');

const routesBlock = /const ROUTES = \{([\s\S]*?)\n\};/.exec(worker)?.[1] || '';
const routes = [...routesBlock.matchAll(/'(\/\.netlify\/functions\/[a-z-]+)'\s*:\s*(\w+)/g)]
  .map(m => ({ path: m[1], local: m[2] }));
if (!routes.length) fail('worker.js declares no ROUTES — every function path the app calls would 404.');

if (!assets.first) {
  fail('[assets] declares no `run_worker_first` — without it asset requests win over the Worker on every path, so the function routes would be answered by the assets layer.');
} else {
  // Every declared route must be behind the Worker, not merely some of them.
  const first = assets.first.items || [];
  for (const route of routes) {
    const covered = first.some(pattern => pattern.endsWith('*')
      ? route.path.startsWith(pattern.slice(0, -1))
      : pattern === route.path);
    if (!covered) {
      add(assets.first.line, `run_worker_first does not cover ${route.path} — the assets layer would answer it (404, since no such file exists) while the static site kept working, so nothing would look broken locally.`);
    }
  }
}

// ---- 3b. the HTML-handling decisions ----------------------------------------
// One is a default this app depends on, the other is a default it must NOT
// change, and both failures are invisible in the repo and silent in production.
//
//   An unknown path must be a 404. An SPA-style not-found handler returns
//   index.html with a 200 for ANY missing path, including a mistyped asset — the
//   blank page the app's hash routing was chosen to avoid needing.
//   `html_handling = "none"` must not come back. It looks tidier than the
//   default (it serves /index.html as the file it is instead of answering with a
//   307 to "/"), and it was deployed here before it was measured: it also drops
//   the "/" → index.html mapping, so the app answered 404 at its own address.
//   The default's redirect is harmless: /index.html is a cache.addAll SHELL
//   entry, and a redirect is followed and stored under the same key.
const notFound = get('assets', 'not_found_handling');
if (notFound?.value !== 'none') {
  add(notFound?.line ?? assets.dir?.line ?? 1,
    'not_found_handling must be "none": an SPA fallback answers every unknown path with index.html and a 200, including an asset the app mistyped — the blank page this app\'s hash routing exists to avoid.');
}
const htmlHandling = get('assets', 'html_handling');
if (htmlHandling?.value === 'none') {
  add(htmlHandling.line,
    'html_handling = "none" also removes the "/" → index.html mapping, so the app answers 404 at its own address (measured on the deployed Worker: empty body). Leave it at the default — the 307 to "/" for /index.html is harmless, since a cache.addAll SHELL entry follows a redirect.');
}

// ---- 4. the durable store ---------------------------------------------------
if (!kvBlocks.length) {
  fail('wrangler.toml binds no KV namespace — with no durable store lib/store.mjs answers `durable: false`, and lib/cloud.mjs then commits profiles to the GitHub mirror instead of the primary (and to memory when there is no mirror).');
}
for (const block of kvBlocks) {
  if (!keys.some(k => k.path === 'kv_namespaces' && k.key === 'binding' && k.line > block.line)) break;
}
for (const [index, block] of kvBlocks.entries()) {
  // Keys in an array-of-tables block belong to that block; take the ones before
  // the next block starts.
  const end = kvBlocks[index + 1]?.line ?? Infinity;
  const fields = keys.filter(k => k.path === 'kv_namespaces' && k.line > block.line && k.line < end);
  const binding = fields.find(k => k.key === 'binding');
  const id = fields.find(k => k.key === 'id');
  if (!binding) add(block.line, '[[kv_namespaces]] has no `binding` — the Worker cannot reach it.');
  if (!id || !/^[0-9a-f]{32}$/.test(id.value || '')) {
    add(block.line, '[[kv_namespaces]] has no 32-hex `id` — a deploy would create or refuse a namespace rather than use the one the data is in.');
  }
}

// ---- 5. no secret in a committed file --------------------------------------
const varsBlock = keys.filter(k => k.path === 'vars');
for (const entry of varsBlock) {
  if (!VAR_ALLOWLIST.has(entry.key)) {
    add(entry.line, `[vars] declares ${entry.key}. Only ${[...VAR_ALLOWLIST].join(', ')} belong here — wrangler.toml is committed and a variable is a plain string binding, so a password or key pasted here is published AND served. Use \`wrangler secret put ${entry.key}\`.`);
  }
  if (/^(ghp_|github_pat_|gho_|glpat-)/.test(entry.value) || /^[0-9a-f]{40}$/.test(entry.value)) {
    add(entry.line, `[vars] ${entry.key} looks like a credential — this file is committed. Use \`wrangler secret put ${entry.key}\`.`);
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
    add(entry.line, `[vars] declares ${entry.key}, but no function reads it — a setting that does nothing still reads like a configured one.`);
  }
}

// ---- 6. the reminder pairing ------------------------------------------------
// The daily reminder's on-time promise is a PAIR spread across two files: the
// cron must tick every minute (a coarser tick delivers the reminder up to a
// period late — the 15-minute tick was a reminder up to a quarter-hour after the
// hour the user chose), and the sender's look-back window must be WIDER than
// that tick (a window equal to the period is the old 15/15 pairing, in which ONE
// run landing late fell outside every window and skipped the day's reminder
// entirely). Neither file can see the other, which is what this pins.
const crons = get('triggers', 'crons');
if (!crons) {
  fail('wrangler.toml declares no [triggers] crons — nothing would ever wake the reminder sender, and the app would look fine until a reminder silently did not arrive.');
} else {
  const list = crons.items || [];
  if (list.length !== 1 || list[0] !== '* * * * *') {
    add(crons.line, `crons = [${list.map(c => `"${c}"`).join(', ')}] — it must be exactly ["* * * * *"], one per-minute tick.`);
  }
  const runSrc = read('netlify/functions/lib/reminder-run.mjs');
  const senderSrc = read('netlify/functions/reminders-send.mjs');
  const tickSrc = read('netlify/functions/reminders-tick.mjs');
  const windowMinutes = Number(/const WINDOW_MINUTES = (\d+)/.exec(runSrc)?.[1]);
  const period = list[0] === '* * * * *' ? 1 : null;
  if (period === 1 && (!Number.isFinite(windowMinutes) || windowMinutes <= period)) {
    add(crons.line, `lib/reminder-run.mjs's WINDOW_MINUTES reads ${windowMinutes} — with a one-minute tick the look-back window must be wider than the tick, or one late run skips the day's reminder.`);
  }
  // Both the window and the job itself live in the shared run: the cron and the
  // URL trigger are two entry points to it, and a second copy of the loop would
  // be a second answer to "was this device already sent to today" — one that
  // fires at its own hour and marks a day the other half never delivered.
  if (!/runReminderTick/.test(senderSrc) || !/runReminderTick/.test(tickSrc)) {
    fail('the reminder job is not shared: reminders-send.mjs and reminders-tick.mjs must both run lib/reminder-run.mjs, or the cron and the trigger can each believe the other delivered the day.');
  }
}

// ---- 7. routing completeness ------------------------------------------------
const imports = new Map();
for (const m of worker.matchAll(/^import\s+(\w+)\s+from\s+'([^']+)';$/gm)) imports.set(m[1], m[2]);

for (const route of routes) {
  const file = imports.get(route.local);
  if (!file) {
    fail(`worker.js routes ${route.path} to ${route.local}, which it does not import — the route would throw on the first request.`);
  } else if (!existsSync(new URL(file, root))) {
    fail(`worker.js imports ${file} for ${route.path}, which does not exist.`);
  }
}

// The endpoint the browser defaults to (settings.js) has to be one of them: it
// is the path every other endpoint is derived from at runtime.
const defaultEndpoint = /endpoint:\s*'([^']+)'/.exec(read('settings.js'))?.[1];
if (!defaultEndpoint) {
  fail("settings.js declares no default `endpoint` — this guard cannot tell which route the app calls, and neither can a reader.");
} else if (!routes.some(r => r.path === defaultEndpoint)) {
  fail(`settings.js defaults to ${defaultEndpoint}, which worker.js does not route — the app's Sync screen would 404 on every request.`);
}

// Every function is either routed or is the cron's entry point, named here so a
// new endpoint cannot ship unreachable.
const CRON_ONLY = new Set(['reminders-send.mjs']);
const routedFiles = new Set([...routes].map(r => imports.get(r.local)).filter(Boolean));
const functionFiles = readdirSync(functionsDir).filter(f => /\.mjs$/.test(f));
for (const file of functionFiles) {
  const rel = `./netlify/functions/${file}`;
  if (!routedFiles.has(rel) && !CRON_ONLY.has(file)) {
    fail(`netlify/functions/${file} is not routed by worker.js — it would be bundled, deployed and unreachable, and nothing else would say so.`);
  }
}

// The cron entry point must NOT be reachable by URL, and the cron must actually
// call it: that is the invariant the split exists for (a scheduled function
// cannot be invoked by URL, so the URL-invocable tick is a separate file).
for (const file of CRON_ONLY) {
  const rel = `./netlify/functions/${file}`;
  if (routedFiles.has(rel)) {
    fail(`worker.js routes netlify/functions/${file}, which is the cron's entry point — it must stay URL-unreachable, or a caller could deliver the day's reminders out of band and both halves could fire.`);
  }
  const local = [...imports.entries()].find(([, path]) => path === rel)?.[0];
  if (!local) fail(`worker.js does not import netlify/functions/${file} — nothing would run on the cron tick.`);
  else if (!new RegExp(`async scheduled\\([\\s\\S]{0,400}?\\b${local}\\(`).test(worker)) {
    fail(`worker.js imports ${file} as ${local} but its scheduled() handler never calls it — the cron would fire, find nothing to do, and report success.`);
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
console.log(`check-worker-config: OK — ${routes.length} route(s) behind the Worker, `
  + `${kvBlocks.length} KV binding(s), ${varsBlock.length} documented variable(s), `
  + `${declared.length} guard(s) wired, ${readEnv.size} env var(s) documented.`);
