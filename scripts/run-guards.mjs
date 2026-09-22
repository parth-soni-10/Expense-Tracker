#!/usr/bin/env node
/**
 * Runs exactly the guard suite netlify.toml declares.
 *
 * Why it exists: Netlify parses netlify.toml BEFORE it runs the build command,
 * so a config mistake fails the deploy with every guard unreported and the
 * build command never reached (the array form of `[[functions]]` did exactly
 * that for seven commits and froze production). A guard that lives inside the
 * build cannot report its own config, so the same suite has to be runnable
 * somewhere the failure is visible first: here, locally before a push, and in
 * CI (.github/workflows/guards.yml).
 *
 * The command is read out of netlify.toml rather than repeated, so the deploy
 * and this can never drift: add a guard there and this runs it too.
 *
 * Run: node scripts/run-guards.mjs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const toml = readFileSync(new URL('netlify.toml', root), 'utf8');
const command = /^\s*command\s*=\s*"([^"]+)"/m.exec(toml)?.[1];

if (!command) {
  console.error('run-guards: netlify.toml declares no [build] command — nothing to run.');
  process.exit(1);
}

console.log(`run-guards: ${command.split(' && ').length} guard(s) declared in netlify.toml\n`);
try {
  execSync(command, { stdio: 'inherit', cwd: fileURLToPath(root) });
} catch (err) {
  console.error(`\nrun-guards: FAILED (exit ${err.status ?? 1}) — everything after the failing guard was skipped.`);
  process.exit(err.status || 1);
}
