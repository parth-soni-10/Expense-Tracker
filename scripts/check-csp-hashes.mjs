#!/usr/bin/env node
/**
 * Keeps the Content-Security-Policy's inline-script hashes in step with
 * index.html.
 *
 * index.html boots from five inline scripts (theme init, chrome sync, SW
 * register, boot-fail diagnostic, splash removal) and netlify.toml pins each
 * one by SHA-256. Edit any of them without re-hashing and the browser silently
 * refuses to run it: the app still loads, but boot behaviour goes missing —
 * and it looks fine locally, because a static dev server sends no CSP at all.
 *
 * Run: node scripts/check-csp-hashes.mjs
 * Also wired into the Netlify build command (netlify.toml), where a mismatch
 * should stop the deploy rather than ship a half-dead boot.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');

const cspMatch = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(toml);
if (!cspMatch) {
  console.error('check-csp-hashes: no Content-Security-Policy found in netlify.toml.');
  process.exit(1);
}
const declared = new Set([...cspMatch[1].matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map(m => m[1]));

// Executable inline scripts only. A data block (type="application/ld+json")
// is never executed, so CSP neither needs nor applies a hash to it.
const executable = /^(module|text\/javascript|application\/javascript|)$/;
const actual = new Map(); // hash → a snippet to identify it in the message
for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || '';
  if (/\ssrc\s*=/i.test(attrs)) continue;
  const type = (/type\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] || '').trim().toLowerCase();
  if (!executable.test(type)) continue;
  const hash = createHash('sha256').update(m[2], 'utf8').digest('base64');
  if (!actual.has(hash)) {
    const snippet = m[2].trim().replace(/\s+/g, ' ').slice(0, 48);
    actual.set(hash, `sha256-${hash} (starts "${snippet}…")`);
  }
}

const missing = [...actual.keys()].filter(h => !declared.has(h));   // would be BLOCKED
const stale = [...declared].filter(h => !actual.has(h));            // dead allowance

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(`check-csp-hashes: ${missing.length} inline script hash(es) missing from the CSP — the browser will refuse to run them:`);
    for (const h of missing) console.error('  MISSING ' + actual.get(h));
  }
  if (stale.length) {
    console.error(`check-csp-hashes: ${stale.length} CSP hash(es) match no inline script (stale after an edit):`);
    for (const h of stale) console.error('  STALE   sha256-' + h);
  }
  process.exit(1);
}
console.log(`check-csp-hashes: OK — all ${actual.size} inline scripts are hashed in the CSP.`);
