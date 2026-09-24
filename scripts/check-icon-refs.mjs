#!/usr/bin/env node
/**
 * Verifies every icon name app.js asks for actually exists in the map it reads.
 *
 * Why this is a guard rather than a style rule: `$` skips a non-string
 * `innerHTML` (it refuses to write the literal word "undefined" into an
 * element), so an icon name the map does not have renders as an EMPTY element
 * with no error at all. The admin shortcut in the header shipped as a blank
 * circle for exactly that reason — `MENU_ICONS.user` was undefined because the
 * person glyph lives in the larger `ICONS` map — and nothing but a screenshot
 * caught it. A missing glyph must fail the build instead.
 *
 * Two shapes are checked, because the lookup can be either:
 *   1. a member access — `MENU_ICONS.chevron`, `ICONS.user`
 *   2. a name handed to a helper — `menuRowEl({ icon: 'user' })`
 *
 * `ICONS` is declared as `{ ...MENU_ICONS, …extras }`, so its runtime set is
 * the union; this reads the spread rather than assuming it.
 *
 * Run standalone:  node scripts/check-icon-refs.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'app.js'), 'utf8');

/** Key names of an object literal declared as `const <name> = { … };`. */
function keysOf(name) {
  const start = app.indexOf(`const ${name} = {`);
  if (start === -1) return null;
  const body = app.slice(start, app.indexOf('\n};', start));
  return new Set([...body.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)].map((m) => m[1]));
}

const menuIcons = keysOf('MENU_ICONS');
const icons = keysOf('ICONS');
if (!menuIcons || !icons) {
  console.error('check-icon-refs: could not find MENU_ICONS / ICONS in app.js — this guard can no longer read the maps it checks.');
  process.exit(1);
}

const iconsSpreadsMenu = /const ICONS = \{\s*\n\s*\.\.\.MENU_ICONS/.test(app);
const iconsRuntime = iconsSpreadsMenu ? new Set([...icons, ...menuIcons]) : icons;

// The empty-state art is a separate, larger 40px set inside emptySVG().
const emptyStart = app.indexOf('function emptySVG');
const emptyBody = emptyStart === -1 ? '' : app.slice(emptyStart, app.indexOf('\n};', emptyStart));
const emptyIcons = new Set([...emptyBody.matchAll(/^\s{4}([a-zA-Z][\w]*):/gm)].map((m) => m[1]));

const problems = [];

// 1. member accesses — a miss here renders an element with nothing in it.
for (const [, map, key, offset] of app.matchAll(/(MENU_ICONS|ICONS)\.([a-zA-Z][\w]*)/g)) {
  const known = map === 'MENU_ICONS' ? menuIcons : iconsRuntime;
  const where = map === 'MENU_ICONS' ? 'MENU_ICONS' : iconsSpreadsMenu ? 'ICONS (which spreads MENU_ICONS)' : 'ICONS';
  if (!known.has(key)) {
    const line = app.slice(0, offset).split('\n').length;
    problems.push(`app.js:${line} reads ${map}.${key}, but ${where} has no "${key}" — it renders empty, with no error.`);
  }
}

// 2. names handed to the icon helpers.
for (const [full, name, offset] of app.matchAll(/icon: '([a-zA-Z][\w]*)'/g)) {
  if (!iconsRuntime.has(name) && !emptyIcons.has(name)) {
    const line = app.slice(0, offset).split('\n').length;
    problems.push(`app.js:${line} passes icon: '${name}', which appears in no icon map (${full.trim()}).`);
  }
}

if (problems.length) {
  console.error('check-icon-refs: icon references that would render empty:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const accesses = [...app.matchAll(/(MENU_ICONS|ICONS)\.[a-zA-Z][\w]*/g)].length;
const names = new Set([...app.matchAll(/icon: '([a-zA-Z][\w]*)'/g)].map((m) => m[1]));
console.log(`check-icon-refs: OK — ${accesses} direct lookup(s) and ${names.size} named icon(s) all resolve` +
  (iconsSpreadsMenu ? '' : ' (ICONS no longer spreads MENU_ICONS: only its own keys are accepted)') + '.');
