#!/usr/bin/env node
/**
 * Guards the "the roster photo is never stored" promise in tesco.js.
 *
 * This is a lint, not a proof: it fails the deploy if the OCR code grows a
 * persistence call or loses one of the release steps, so a future edit cannot
 * quietly start keeping the user's photo. The runtime side of the promise
 * (no image ever leaves memory) is covered by construction in ocrRosterRow()
 * and ocrStripWords() — decode to a canvas, read the strip, release the bitmap,
 * zero the canvas, terminate the worker.
 *
 * Run standalone:  node scripts/check-image-hygiene.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../tesco.js', import.meta.url), 'utf8');
// Drop whole-line // comments so prose explaining *why* the photo is never
// fetched cannot read as a violation. Deliberately line-anchored: a block
// comment strip is not safe here (a `/*` sequence elsewhere in the source can
// swallow real code), and the cost of missing a wrapped comment is a clear
// false positive, not a blind guard.
const src = raw.replace(/^[ \t]*\/\/.*$/gm, '');

// Calls that would mean the picked image (or its pixels) can outlive the scan.
const forbidden = [
  ['toDataURL', 'canvas data URL (an encoded copy of the image)'],
  ['localStorage', 'browser storage'],
  ['sessionStorage', 'browser storage'],
  ['indexedDB', 'browser storage'],
  ['createObjectURL', 'a URL that can be fetched and cached'],
  ['FileReader', 'an alternate read path that bypasses the canvas'],
  ['fetch(', 'a network request for the picked file'],
];

// Steps that must exist, each doing part of the cleanup.
const required = [
  ['bitmap.close()', 'release the decoded bitmap'],
  ['canvas.width = 0', 'zero the working canvas'],
  ['disposeOcrWorker()', 'destroy the OCR worker that held the pixels'],
  ["input.value = ''", 'clear the file input so it retains no reference'],
];

let failed = 0;
for (const [needle, why] of forbidden) {
  if (src.includes(needle)) {
    console.error(`check-image-hygiene: tesco.js must not use ${needle} (${why}).`);
    failed++;
  }
}
for (const [needle, why] of required) {
  if (!src.includes(needle)) {
    console.error(`check-image-hygiene: tesco.js is missing ${needle} — needs to ${why}.`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('check-image-hygiene: OK — the roster photo is never persisted, no storage or network path exists.');
