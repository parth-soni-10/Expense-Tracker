#!/usr/bin/env node
/**
 * Guards the "no roster photo ever enters this app, so none can be stored"
 * promise, now that the photo pipeline is gone.
 *
 * History, because the shape of this guard is a decision and not a leftover: the
 * roster OCR used to read a photographed sheet, and this lint walked the three
 * files that could hold its pixels (the reader, the prep worker, the shared pixel
 * layer) for a persistence call or a missing release step. Commit `97fb40f`
 * removed the whole pipeline — engine pool, tesseract, camera modal, file input,
 * prep workers, `ocr-pixels.js`, `ocr-harness.html`, `vendor/tesseract/` — and kept
 * the pure text side (`parseRosterWords`, `columnAnchors`, `resolveColumnDates`,
 * `rosterColumnBounds`, pinned in `scripts/test-tesco.mjs`). A lint that still
 * named those files would fail on their absence and, worse, would pass a
 * re-introduced camera: it only ever looked at the reader.
 *
 * So the guard inverts. It is two pins:
 *
 *   1. The pipeline stays deleted. The files that held the photo are tombstones:
 *      if one comes back, the decision above was undone and this fails.
 *   2. No shipped file can capture or hold an image at all. The scan is the
 *      whole shipped surface, not a list of files, because the way a pipeline
 *      returns is a new module beside the old one. `file.text()`, the workbook
 *      reader and the CSV import are untouched by this: what is forbidden is
 *      pixels (canvas read/write, encoded copies, blobs, off-main-thread pixel
 *      surfaces) and capture (camera, file-input capture), not reading text.
 *
 * `tesco.js`'s no-storage rule survives the removal and is the one non-image pin
 * here: the module takes storage as function arguments (`foldGet`/`foldSet` reach
 * it through the screen's `ctx`) and writes none itself. That is how the fold
 * preference is kept out of device storage, so the rule is kept — and it is
 * exactly the rule that failed the first time someone reached for `localStorage`
 * inside it.
 *
 * This is a lint, not a proof. The runtime side of the promise is structural now:
 * there is no capture path to leave a photo in memory.
 *
 * The inspection is exported (`inspectShippedCode`, `checkTombstones`) and the
 * lists are exported with it, because a guard nobody can point at a fixture is a
 * guard that can be blinded by a typo in its walk and still print OK. The
 * permanent self-test is `scripts/test-image-hygiene.mjs`: it plants a clean tree,
 * each forbidden call, each tombstone, the one allowed object URL and a comment
 * that merely names a forbidden call, then asserts this module's verdict on each.
 *
 * Run standalone:  node scripts/check-image-hygiene.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

// Files and directories that held the photo, and must not exist again.
export const TOMBSTONES = [
  'ocr-prep-worker.js',
  'ocr-pixels.js',
  'ocr-harness.html',
  'vendor/tesseract',
];

// Calls that would mean an image can be captured or its pixels held. Each is a
// separate way the promise dies, so each says why.
export const IMAGE = [
  ['getUserMedia', 'a live camera'],
  ['capture=', 'the camera attribute on a file input'],
  ['toDataURL', 'an encoded copy of a canvas (or of the photo on it)'],
  ['createObjectURL', 'a URL that can be fetched and cached'],
  ['FileReader', 'an alternate read path for a picked file'],
  ['drawImage', 'a photo drawn into a canvas'],
  ['getImageData', 'a canvas read back as pixels'],
  ['putImageData', 'pixels written into a canvas'],
  ['convertToBlob', 'an encoded image blob'],
  ['OffscreenCanvas', 'a pixel surface off the main thread'],
  ['ImageData', 'a pixel buffer'],
  ['new Worker(', 'a worker holding the pixels'],
  ['tesseract', 'the OCR engine'],
];

// The one image-adjacent call the app legitimately makes: `downloadText` builds a
// text download from memory (CSV, JSON). There are no image bytes in it, so it is
// allowed by exact shape and only in that file — a second `createObjectURL` there,
// or any in another file, is a fetched copy of something and fails below.
export const ALLOWED_OBJECT_URL = {
  file: 'storage.js',
  shape: 'URL.createObjectURL(new Blob([text], { type: mime }))',
};

// A module that must not write device storage, and why — see the header. `fetch(`
// is here for the same reason the reader's file list once carried it: the module
// is given what it needs, it does not go and get it.
export const NO_STORAGE = {
  file: 'tesco.js',
  forbidden: [
    ['localStorage', 'device storage — take it as a function argument (foldGet/foldSet) instead'],
    ['sessionStorage', 'device storage — take it as a function argument instead'],
    ['indexedDB', 'device storage — take it as a function argument instead'],
    ['fetch(', 'a network call — the screen is handed what it needs by app.js'],
  ],
};

// The shipped surface. Everything the browser can load is scanned; the
// directories below are either not shipped (scripts/, .pages-dist/ build output,
// docs) or not ours to change (vendor/, node_modules/).
export const SRC_EXTENSIONS = ['.js', '.mjs', '.html'];
export const SKIP_DIRECTORIES = new Set([
  '.git', '.github', 'node_modules', 'scripts', 'vendor', '.pages-dist', '.wrangler', 'docs', 'tests',
]);

/** Every shipped source file under `directory`, in a stable order. */
export function shippedFiles(directory, skipDirectories = SKIP_DIRECTORIES) {
  const found = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (!skipDirectories.has(entry)) found.push(...shippedFiles(path, skipDirectories));
      continue;
    }
    if (SRC_EXTENSIONS.some(extension => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

/** Tombstones that are present again, as failure messages. */
export function checkTombstones(treeRoot = root) {
  return TOMBSTONES
    .filter(tombstone => existsSync(join(treeRoot, tombstone)))
    .map(tombstone => `${tombstone} is back — the roster-photo pipeline was removed on purpose (97fb40f); this app reads no images.`);
}

/**
 * Scan a tree for capture or pixel calls and for the one module that may not
 * touch storage. `treeRoot` is a directory whose shipped files are the surface,
 * which is what lets the self-test point this at a fixture instead of the repo.
 */
export function inspectShippedCode(treeRoot = root) {
  const messages = [];
  const files = shippedFiles(treeRoot);
  for (const path of files) {
    const name = relative(treeRoot, path).replace(/\\/g, '/');
    const raw = readFileSync(path, 'utf8');
    // Drop whole-line // comments so prose explaining *why* there is no image path
    // cannot read as a violation (tesco.js still explains what it no longer does).
    // Deliberately line-anchored: a block-comment strip is not safe here (a `/*`
    // sequence elsewhere in the source can swallow real code), and the cost of
    // missing a wrapped comment is a clear false positive, not a blind guard.
    let src = raw.replace(/^[ \t]*\/\/.*$/gm, '');
    if (name === ALLOWED_OBJECT_URL.file) {
      const allowed = src.split(ALLOWED_OBJECT_URL.shape).length - 1;
      const objectUrls = src.split('createObjectURL').length - 1;
      if (allowed !== objectUrls) {
        messages.push(`${name} builds an object URL that is not the text download \`${ALLOWED_OBJECT_URL.shape}\` (${objectUrls} call(s), ${allowed} of them that shape) — a URL made from anything else can outlive the file it came from.`);
      }
      src = src.split(ALLOWED_OBJECT_URL.shape).join('');
    }
    for (const [needle, why] of IMAGE) {
      if (src.includes(needle)) {
        messages.push(`${name} must not use ${needle} (${why}). No photo enters this app; keep it that way.`);
      }
    }
    if (name === NO_STORAGE.file) {
      for (const [needle, why] of NO_STORAGE.forbidden) {
        if (src.includes(needle)) messages.push(`${name} must not use ${needle} (${why}).`);
      }
    }
  }
  return { messages, scanned: files.length };
}

function main() {
  const failures = [...checkTombstones(root), ...inspectShippedCode(root).messages];
  if (failures.length) {
    for (const failure of failures) console.error(`check-image-hygiene: ${failure}`);
    process.exit(1);
  }
  console.log(`check-image-hygiene: OK — no capture or pixel path exists in the shipped code, and the OCR pipeline stays deleted (${TOMBSTONES.join(', ')}). ${NO_STORAGE.file} writes no device storage.`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
