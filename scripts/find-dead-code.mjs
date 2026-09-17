#!/usr/bin/env node
/**
 * Dead-code detector across all project modules.
 * 1. Non-exported function declarations that are never called anywhere.
 * 2. Top-level function declarations in app.js referenced only once (their own).
 * Reports candidates for manual review — string-dispatch or dynamic calls can
 * hide real uses, so verify before deleting.
 *
 * Usage: node scripts/find-dead-code.mjs
 */
import { readFileSync } from 'node:fs';

const files = ['app.js', 'settings.js', 'storage.js', 'sync-merge.js', 'sync.js', 'seed.js', 'index.html', 'sw.js'];
const sources = files.map(f => ({ name: f, text: readFileSync(new URL(`../${f}`, import.meta.url), 'utf8') }));
const all = sources.map(s => s.text).join('\n');

for (const { name: fileName, text } of sources) {
  if (!fileName.endsWith('.js')) continue;
  const lines = text.split('\n');
  const findings = [];
  const fnRe = /^(?:async )?function (\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fnRe);
    if (!m) continue;
    const name = m[1];
    const isExported = new RegExp(`export (?:async )?function ${name}\\b`).test(text);
    const totalRefs = (all.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
    const callSites = (all.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) || []).length;
    if (totalRefs <= 1 && callSites === 0) {
      findings.push(`  line ${i + 1}: ${isExported ? 'EXPORTED ' : ''}${name} — never called`);
    } else if (!isExported && callSites === 0 && totalRefs <= 2) {
      findings.push(`  line ${i + 1}: ${name} — referenced but never invoked (refs=${totalRefs})`);
    }
  }
  if (findings.length) console.log(`${fileName}:\n${findings.join('\n')}`);
}
console.log('\nDone.');
