#!/usr/bin/env node
/**
 * Verifies the stylesheet is a closed system: every custom property that is
 * read is somewhere defined, every `@keyframes` is animated by something, and
 * the file's braces balance.
 *
 * Why each of the three is a guard rather than a style rule:
 *
 *   1. **An undefined `var()` fails silently and completely.** There is no
 *      error, no console line and no fallback: `background: var(--surface)`
 *      where `--surface` does not exist computes to the property's initial
 *      value, so the surface renders transparent. This file shipped exactly
 *      that on `.split-leg` for months, and it is the failure mode a rename
 *      leaves behind — the token's consumers are plain strings, and a find and
 *      replace that misses one leaves a declaration that simply stops working.
 *      A use WITH a fallback (`var(--mx, 50%)`) is exempt: that is a value the
 *      code is deliberately allowed to supply at runtime.
 *
 *   2. **A `@keyframes` nothing animates is dead CSS that reads as live.** The
 *      primary button's `btnShine` survived its own rule being overridden, so
 *      the file still described a shine sweep that had not painted since the
 *      ledger skin. Dead motion is the hardest kind to spot by reading, because
 *      the keyframes look like a feature and the thing that would run them is
 *      somewhere else. Both directions are checked: a keyframe with no consumer,
 *      and an `animation:` naming a keyframe that does not exist (which is a
 *      silently dead animation).
 *
 *   3. **Braces balance.** A scripted edit that cuts a block by markers can take
 *      one closing brace too many, and CSS recovers by swallowing every rule
 *      after it as part of the previous declaration block — the app renders
 *      unstyled and the diff looks small. Counting is one line and catches it
 *      before a browser has to.
 *
 * Run standalone:  node scripts/check-css-tokens.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const problems = [];
const fails = [];

/** Every module that can carry an inline style or a class-list lookup. */
const SOURCES = [
  'styles.css', 'index.html', 'app.js', 'insights.js', 'tesco.js',
  'app/lib/tesco-pay.ts', 'app/lib/storage.ts', 'app/lib/settings.ts',
  'app/lib/profiles.ts', 'app/lib/sync.ts', 'app/lib/sync-merge.ts',
].filter(existsSync);

const css = read('styles.css');

/* ── 1. custom properties ──────────────────────────────────────────────────── */

const defined = new Set();
const usedNoFallback = new Map();
for (const file of SOURCES) {
  const text = read(file);
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  // A use, plus whether it carries a fallback before the closing paren.
  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
    if (m[2]) continue;
    if (!usedNoFallback.has(m[1])) usedNoFallback.set(m[1], new Set());
    usedNoFallback.get(m[1]).add(file);
  }
}

const undefinedTokens = [...usedNoFallback.entries()]
  .filter(([name]) => !defined.has(name))
  .map(([name, files]) => `${name} (used in ${[...files].join(', ')})`);
if (undefinedTokens.length) {
  problems.push(`read but never defined — the declaration silently falls back to the property's initial value:\n    ${undefinedTokens.join('\n    ')}`);
}
fails.push(['every custom property the app reads is defined somewhere', undefinedTokens, []]);

/* A token defined in :root that nothing reads is the other half of a rename.
   Only the two theme blocks are checked — a definition inside a rule is local
   and may legitimately be set for one consumer. */
const tokenBlocks = [...css.matchAll(/:root\s*\{([\s\S]*?)\}|\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/g)]
  .map((m) => m[1] || m[2]);
const declaredInThemes = new Set();
for (const block of tokenBlocks) {
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declaredInThemes.add(m[1]);
}
const unreadTokens = [...declaredInThemes].filter((name) => !usedNoFallback.has(name) && !new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(css));
if (unreadTokens.length) {
  problems.push(`declared in a theme block and never read:\n    ${unreadTokens.join(', ')}`);
}
fails.push(['no theme token is left defined but unread', unreadTokens, []]);

/* ── 2. keyframes, both directions ─────────────────────────────────────────── */

const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const keyframes = new Set([...rules.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const animated = new Set();
for (const m of rules.matchAll(/(?:^|[;{\s])(?:animation|animation-name)\s*:\s*([^;}]+)/g)) {
  for (const part of m[1].split(',')) {
    for (const word of part.trim().split(/\s+/)) {
      if (/^[\w-]+$/.test(word) && !/^\d/.test(word) && !['none', 'infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'both', 'forwards', 'backwards', 'alternate', 'normal', 'reverse', 'paused', 'running'].includes(word)) {
        animated.add(word);
      }
    }
  }
}
// Names that are keyframes but only ever appear in a JS-built inline style are
// still consumers; scan the modules too.
const allText = SOURCES.map(read).join('\n');
const animatedNames = [...animated].filter((n) => keyframes.has(n) || new RegExp(`animation:\\s*${n}\\b`).test(allText));
const orphanKeyframes = [...keyframes].filter((n) => !new RegExp(`(^|[;{\\s])animation(-name)?\\s*:[^;}]*\\b${n}\\b`, 'm').test(rules) && !new RegExp(`animation(-name)?\\s*:[^;"'\`]*\\b${n}\\b`).test(allText));
if (orphanKeyframes.length) {
  problems.push(`@keyframes nothing animates — dead motion that reads as a feature:\n    ${orphanKeyframes.join(', ')}`);
}
fails.push(['every @keyframes is animated by something', orphanKeyframes, []]);

const missingKeyframes = [...animatedNames].filter((n) => !keyframes.has(n) && !new RegExp(`@keyframes\\s+${n}\\b`).test(allText));
if (missingKeyframes.length) {
  problems.push(`animation names with no @keyframes anywhere — a silently dead animation:\n    ${missingKeyframes.join(', ')}`);
}
fails.push(['every animation name has its @keyframes', missingKeyframes, []]);

/* ── 3. braces ─────────────────────────────────────────────────────────────── */

const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
if (open !== close) {
  problems.push(`styles.css braces do not balance (${open} open, ${close} close) — everything after the unclosed rule is parsed as its declaration value`);
}
fails.push(['styles.css braces balance', open === close ? [] : ['unbalanced'], []]);

/* ── report ────────────────────────────────────────────────────────────────── */

let pass = 0;
console.log('check-css-tokens: stylesheet closure\n');
for (const [label, got, want] of fails) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else console.error(`  FAIL  ${label}`);
}
if (problems.length) {
  console.error(`\ncheck-css-tokens: ${problems.length} problem(s)\n  ${problems.join('\n  ')}\n`);
  process.exitCode = 1;
} else {
  console.log(`check-css-tokens: OK — ${pass} assertions passed (${defined.size} custom properties read and defined, ${keyframes.size} keyframes all in use, braces balanced)`);
}
