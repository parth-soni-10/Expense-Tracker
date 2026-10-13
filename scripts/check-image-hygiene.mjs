#!/usr/bin/env node
/**
 * Guards the "the roster photo is never stored" promise, across every file that
 * can hold the photo's pixels.
 *
 * This is a lint, not a proof: it fails the deploy if the OCR code grows a
 * persistence call or loses one of the release steps, so a future edit cannot
 * quietly start keeping the user's photo. The runtime side of the promise (no
 * image ever leaves memory) is covered by construction in ocrRosterRow() and the
 * reader's read path — decode to a bitmap, draw the read's region and read it
 * back, hand those pixels to a prep worker, release the bitmap, zero the canvas,
 * terminate the workers.
 *
 * The file list is the point: the photo used to live in exactly one file, and when
 * preparation moved off the main thread (ocr-prep-worker.js) two more files started
 * holding pixels — the worker that thresholds and encodes them, and the pixel layer
 * both of them share (ocr-pixels.js). A guard that only read tesco.js would have
 * gone on passing while the worker grew a cache of its own.
 *
 * Run standalone:  node scripts/check-image-hygiene.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { readFileSync } from 'node:fs';

// Calls that would mean the picked image (or its pixels) can outlive the scan.
const FORBIDDEN = [
  ['toDataURL', 'canvas data URL (an encoded copy of the image)'],
  ['localStorage', 'browser storage'],
  ['sessionStorage', 'browser storage'],
  ['indexedDB', 'browser storage'],
  ['createObjectURL', 'a URL that can be fetched and cached'],
  ['FileReader', 'an alternate read path that bypasses the canvas'],
  ['fetch(', 'a network request for the picked file'],
];

// Steps that must exist, and calls that must not, each doing part of the promise.
// They differ per file: the reader owns the decode, the preview canvas, the file
// input and the whole pool teardown; the prep worker is handed a read's pixels and
// must only threshold and encode them.
//
// The worker's own forbidden list is the invariant that cost a scenario: it must
// not draw the photo and read it back. A worker's `drawImage` does not resample a
// source rectangle the way the reader's does — ±1 grey level on 0.6 % of a 12 MP
// strip, and up to three levels on a pre-cut image — which is enough to move the
// cell crops and flip a marginal read (`blurry`). So the draw and the readback
// stay on the reader's thread, where the engine is handed the image it has always
// been handed, and a `getImageData` here would mean they had moved back.
const FILES = [
  {
    file: '../tesco.js',
    required: [
      ['bitmap.close()', 'release the decoded bitmap'],
      ['canvas.width = 0', 'zero the working canvas'],
      ['disposeOcrWorker()', 'destroy the workers that held the pixels'],
      ["input.value = ''", 'clear the file input so it retains no reference'],
    ],
  },
  {
    file: '../ocr-prep-worker.js',
    required: [
      ['putImageData', 'write the pixels it was handed into a surface of its own'],
      ['convertToBlob', 'encode them for the engine'],
    ],
    forbidden: [['getImageData', 'read a canvas back in the worker — the draw belongs on the reader\u2019s thread, where the image is the one the engine has always been handed']],
  },
  { file: '../ocr-pixels.js', required: [] },
];

let failed = 0;
for (const { file, required, forbidden = [] } of FILES) {
  const raw = readFileSync(new URL(file, import.meta.url), 'utf8');
  // Drop whole-line // comments so prose explaining *why* the photo is never
  // fetched cannot read as a violation. Deliberately line-anchored: a block
  // comment strip is not safe here (a `/*` sequence elsewhere in the source can
  // swallow real code), and the cost of missing a wrapped comment is a clear
  // false positive, not a blind guard.
  const src = raw.replace(/^[ \t]*\/\/.*$/gm, '');
  const name = file.replace(/^\.\.\//, '');
  for (const [needle, why] of [...FORBIDDEN, ...forbidden]) {
    if (src.includes(needle)) {
      console.error(`check-image-hygiene: ${name} must not use ${needle} (${why}).`);
      failed++;
    }
  }
  for (const [needle, why] of required) {
    if (!src.includes(needle)) {
      console.error(`check-image-hygiene: ${name} is missing ${needle} — needs to ${why}.`);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log(`check-image-hygiene: OK — the roster photo is never persisted (${FILES.map(f => f.file.replace(/^\.\.\//, '')).join(', ')}), no storage or network path exists.`);
