#!/usr/bin/env node
/**
 * Unused CSS selector detector for styles.css.
 * Extracts class names from selectors (skipping @keyframes bodies) and reports
 * any class that appears nowhere in index.html or app.js markup strings.
 * Manual-review list, not an auto-deleter: some classes are toggled via
 * string concatenation or third-party widgets.
 *
 * Usage: node scripts/find-dead-css.mjs
 */
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const otherJs = ['settings.js', 'storage.js', 'sync.js', 'sync-merge.js', 'seed.js', 'sw.js']
  .map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');

// Remove @keyframes blocks (their inner selectors are animation steps, not DOM classes)
const cssNoKeyframes = css.replace(/@keyframes\s+[\w-]+\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');

// Class tokens from selectors only (strip declarations to avoid .class in comments/false hits is fine to keep simple)
const selectorClasses = new Set();
for (const m of cssNoKeyframes.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) selectorClasses.add(m[1]);

const haystack = js + '\n' + html + '\n' + otherJs;

const dead = [];
for (const cls of [...selectorClasses].sort()) {
  // Search for the class used as a class token in markup strings or query selectors
  const re = new RegExp(`['"\`\\s.]${cls}['"\`\\s,{.:)\\[]`, 'g');
  if (!re.test(haystack)) dead.push(cls);
}

console.log(`CSS classes defined in styles.css but not found in app.js/index.html/other JS:`);
console.log(dead.length ? dead.map(c => '  .' + c).join('\n') : '  (none)');
console.log(`\nTotal classes checked: ${selectorClasses.size}`);
