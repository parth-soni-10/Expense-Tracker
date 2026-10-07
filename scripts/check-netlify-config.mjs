#!/usr/bin/env node
/**
 * Guards netlify.toml against the two ways it can hurt us: a shape Netlify
 * rejects before the build even starts, and a mistake it accepts silently so
 * the deploy looks green while a header rule, a guard or a whole reminder is
 * missing.
 *
 * Why this exists: the `[[functions]] name/schedule` array form sat in this
 * file since 9cd772e, and every deploy after it died while Netlify parsed the
 * config with
 *   "Configuration property functions must be an object"
 * with no gate reporting anything — Netlify reads its config BEFORE running
 * the build command, so a predeploy guard cannot see that failure. This
 * covers that class plus the silent ones:
 *
 *   1. Wrong TOML shape. `build`, `dev`, `functions` and `context` are tables;
 *      `headers`, `redirects` and `plugins` are arrays of tables. `[headers]`
 *      in particular is accepted, and silently collapses every rule into one.
 *   2. A table declared twice — TOML forbids redefining one, which is what a
 *      hand-merged config looks like.
 *   3. `schedule` on a function that does not exist: Netlify schedules
 *      nothing, so the reminder never fires and nothing says so.
 *   4. `build.command` or `build.publish` missing, or `command` landing inside
 *      `[build.environment]` — opening a sub-table ends the parent table, so
 *      the key silently lands in the wrong place and Netlify runs no build.
 *   5. A guard on disk that the build command never runs, or a build command
 *      naming a script that is gone. Both leave the deploy green with the
 *      guard unenforced.
 *   6. An env var a function reads that the README never documents. This site
 *      is configured by hand, so the README is the only install guide: a var
 *      that exists in code and nowhere else surfaces as a runtime failure
 *      nobody can act on. (The README named `GITHUB_REPO` while sync.mjs reads
 *      REPO_OWNER/REPO_NAME — sync could not be configured from the docs.)
 *   7. A guard the build runs that the README never lists — the reader never
 *      learns it exists, and so never runs it after changing what it guards.
 *   8. CI exists but does not run the same suite under the same runtime, or is
 *      missing entirely: it is the only place a config mistake is caught
 *      before it costs a deploy.
 *
 * Run: node scripts/check-netlify-config.mjs
 * Also the first step of the build command — cheapest, and the only gate whose
 * failure explains why the others might not have reported anything.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const toml = readFileSync(new URL('netlify.toml', root), 'utf8');
const functionsDir = new URL('netlify/functions/', root);
const scriptsDir = new URL('scripts/', root);

// Netlify's schema, for the keys this file uses. Getting one backwards is
// either a hard parse failure ([[functions]]) or a silent one ([headers]).
const TABLES = new Set(['build', 'dev', 'functions', 'context']);
const ARRAYS = new Set(['headers', 'redirects', 'plugins']);

const problems = [];
const add = (line, message) => problems.push(`netlify.toml:${line}: ${message}`);

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

const unquote = v => v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
// `[functions."reminders-send"]` → `functions.reminders-send`
const tablePath = s => s.split('.').map(p => p.trim().replace(/^"(.*)"$/, '$1')).join('.');

const tables = new Map();      // full path → line (first declaration)
const arrays = new Map();      // full path → line (arrays may legitimately repeat)
const keys = [];               // { path, key, value, line }
let current = null;
let arrayBlocks = 0;           // [[x]] blocks, counted per block not per path

for (const [i, raw] of toml.split('\n').entries()) {
  const line = stripComment(raw).trim();
  if (!line) continue;
  const lineNo = i + 1;

  let m = /^\[\[(.+)\]\]$/.exec(line);
  if (m) {
    const path = tablePath(m[1]);
    if (tables.has(path)) add(lineNo, `[[${path}]] follows [${path}] — pick one form.`);
    arrays.set(path, lineNo);
    arrayBlocks++;
    current = path;
    continue;
  }
  m = /^\[(.+)\]$/.exec(line);
  if (m) {
    const path = tablePath(m[1]);
    // Sub-tables of an array (`[headers.values]`) repeat once per block by
    // design; only real tables can be declared twice.
    if (!ARRAYS.has(path.split('.')[0]) && (tables.has(path) || arrays.has(path))) {
      add(lineNo, `[${path}] is declared twice — TOML forbids redefining a table.`);
    }
    tables.set(path, lineNo);
    current = path;
    continue;
  }
  m = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
  if (m) keys.push({ path: current, key: m[1], value: m[2], line: lineNo });
}

for (const [path, line] of arrays) {
  const head = path.split('.')[0];
  if (TABLES.has(head)) {
    add(line, `[[${path}]] — Netlify expects \`${head}\` to be an object, and rejects the array form before the build runs. ` +
      (head === 'functions' ? 'Write [functions."<name>"] with schedule = "..." inside it.' : ''));
  }
}
for (const path of tables.keys()) {
  const head = path.split('.')[0];
  if (ARRAYS.has(head) && path === head) {
    add(tables.get(path), `[${path}] is the extend form — Netlify wants [[${path}]], one block per rule; this silently keeps only one.`);
  }
}

const get = (path, key) => keys.find(k => k.path === path && k.key === key);
const command = get('build', 'command');
if (!get('build', 'publish')) add(1, '[build] has no `publish` — Netlify would deploy nothing.');
if (!command) add(1, '[build] has no `command` — Netlify runs no build, so every guard below is skipped in silence.');
for (const k of keys) {
  if (k.path === 'build.environment' && /^(command|publish)$/.test(k.key)) {
    add(k.line, `\`${k.key}\` landed inside [build.environment] (a sub-table opened above it ends [build]).`);
  }
}

const scheduled = keys.filter(k => k.key === 'schedule');
for (const k of scheduled) {
  const name = /^functions\.(.+)$/.exec(k.path || '')?.[1];
  if (!name) {
    add(k.line, '`schedule` is only valid on a function — [functions."<name>"] with schedule inside.');
    continue;
  }
  if (!['.mjs', '.js', '.mts', '.cts', '.ts'].some(ext => existsSync(new URL(name + ext, functionsDir)))) {
    add(k.line, `schedules "${name}", but netlify/functions/${name}{.mjs,.js,.ts} does not exist — ` +
      'Netlify would schedule nothing and the reminder would never fire.');
  }
  const cron = unquote(k.value);
  if (!/^@(hourly|daily|weekly|monthly|yearly)$/.test(cron) && !/^\S+ \S+ \S+ \S+ \S+$/.test(cron)) {
    add(k.line, `"${cron}" is not a cron Netlify accepts (five fields, or @hourly/@daily/@weekly/@monthly/@yearly).`);
  }
}

// The daily reminder's on-time promise is a PAIR spread across two files: the
// cron must tick every minute (a coarser tick delivers the reminder up to a
// period late — the 15-minute tick was a reminder up to a quarter-hour after
// the hour the user chose), and the sender's look-back window must be WIDER
// than that tick (a window equal to the period is the old 15/15 pairing, in
// which ONE run landing late fell outside every window and skipped the day's
// reminder entirely). Neither file can see the other, which is what this pins.
const reminderSchedule = get('functions.reminders-send', 'schedule');
if (reminderSchedule) {
  const cron = unquote(reminderSchedule.value);
  const first = /^(\S+)/.exec(cron)?.[1];
  const period = first === '*' ? 1 : /^\*\/\d+$/.test(first || '') ? Number(first.slice(2)) : /^\d+$/.test(first || '') ? 60 : null;
  const senderSrc = readFileSync(new URL('netlify/functions/reminders-send.mjs', root), 'utf8');
  const windowMinutes = Number(/const WINDOW_MINUTES = (\d+)/.exec(senderSrc)?.[1]);
  if (period !== 1) {
    add(reminderSchedule.line, `the daily-reminder cron is "${cron}" — it must tick every minute ("* * * * *"), or a reminder arrives up to a period late at the hour the user chose.`);
  } else if (!Number.isFinite(windowMinutes) || windowMinutes <= period) {
    add(reminderSchedule.line, `reminders-send.mjs's WINDOW_MINUTES reads ${windowMinutes} — with a one-minute cron the look-back window must be wider than the tick, or one late run skips the day's reminder.`);
  }
}

const guardFiles = readdirSync(scriptsDir).filter(f => /^(check|test)-[\w.-]+\.mjs$/.test(f));
if (command) {
  const cmd = unquote(command.value);
  for (const guard of guardFiles) {
    if (!cmd.includes(`scripts/${guard}`)) {
      problems.push(`scripts/${guard} exists but the build command never runs it — the deploy would stay green with that guard unenforced.`);
    }
  }
  for (const m of cmd.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) {
    if (!existsSync(new URL(m[1], root))) {
      problems.push(`the build command runs ${m[1]}, which does not exist — that build would die and block every deploy.`);
    }
  }
}

// CI is the only place a config mistake is caught BEFORE it costs a deploy
// (Netlify reads this file before running the build), so it has to run the same
// suite under the same runtime — otherwise it silently checks something else.
const workflow = new URL('.github/workflows/guards.yml', root);
if (!existsSync(workflow)) {
  problems.push('.github/workflows/guards.yml is gone — without it a config mistake is only discovered by a dead deploy, which is how seven commits went unshipped.');
} else {
  // Comments stripped first: this file explains in prose which script it runs,
  // and a check that a comment can satisfy would pass with the run line gone.
  const yml = readFileSync(workflow, 'utf8').replace(/^[ \t]*#.*$/gm, '');
  const runs = [...yml.matchAll(/^\s*run:\s*(.+)$/gm)].map(m => m[1].trim());
  if (!runs.some(r => r.includes('scripts/run-guards.mjs'))) {
    problems.push('.github/workflows/guards.yml does not run scripts/run-guards.mjs — CI would check something other than what the deploy runs' +
      (runs.length ? ` (it runs: ${runs.join('; ')})` : ' (no run step at all).' ));
  }
  const node = unquote(get('build.environment', 'NODE_VERSION')?.value || '');
  if (node && !new RegExp(`node-version:\\s*['"]?${node}\\b`).test(yml)) {
    problems.push(`.github/workflows/guards.yml must pin node-version ${node}, matching NODE_VERSION in this file — CI and the deploy would otherwise run different runtimes.`);
  }
}

// The README is this project's install guide: a Netlify site is configured by
// hand from it. So every env var a function reads must be named there, and so
// must every guard the deploy runs.
const readme = readFileSync(new URL('README.md', root), 'utf8');
const envVars = new Set();
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.m?js$/.test(entry.name)) {
      for (const m of readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) envVars.add(m[1]);
    }
  }
})(fileURLToPath(functionsDir));

const undocumentedEnv = [...envVars].filter(name => !readme.includes(name));
if (undocumentedEnv.length) {
  problems.push(`README.md documents no such variable: ${undocumentedEnv.join(', ')} — the functions read it, so a hand-configured site fails at runtime instead.`);
}

const documentedGuards = [...new Set([...unquote(command?.value || '').matchAll(/node\s+scripts\/([\w.-]+\.mjs)/g)].map(m => m[1]))];
const unlistedGuards = documentedGuards.filter(name => !readme.includes(name));
if (unlistedGuards.length) {
  problems.push(`README.md never lists ${unlistedGuards.join(', ')} — the deploy runs them, so the reader cannot know they exist or run them by hand.`);
}

if (problems.length) {
  console.error(`check-netlify-config: ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-netlify-config: OK — ${arrayBlocks} array-of-table block(s), ` +
  `${scheduled.length} scheduled function(s), ${guardFiles.length} guards wired, ` +
  `${envVars.size} env var(s) documented.`);
