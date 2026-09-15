#!/usr/bin/env node
/**
 * Verifies every URL in sw.js's SHELL list exists on disk, so a renamed or
 * typo'd path can never silently 404 in the service worker's warm (offline
 * shell) list. Run standalone:
 *
 *   node scripts/check-sw-shell.mjs
 *
 * Also wired as a predeploy build step in netlify.toml, so a broken shell
 * list fails the deploy instead of shipping.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8');

const match = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!match) {
  console.error('check-sw-shell: could not find the SHELL array in sw.js');
  process.exit(1);
}

const urls = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
if (urls.length === 0) {
  console.error('check-sw-shell: SHELL array is empty');
  process.exit(1);
}

const missing = urls.filter((url) => {
  // "/" maps to index.html; every other path is taken literally.
  const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
  return !existsSync(join(root, rel));
});

if (missing.length) {
  console.error('check-sw-shell: SHELL entries missing on disk:');
  for (const url of missing) console.error(`  - ${url}`);
  process.exit(1);
}

console.log(`check-sw-shell: OK — all ${urls.length} SHELL entries exist.`);
