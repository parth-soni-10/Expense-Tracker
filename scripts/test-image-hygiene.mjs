#!/usr/bin/env node
/**
 * The image guard's own test — the thing that keeps `check-image-hygiene`
 * honest.
 *
 * Why it exists: a source-scanning guard fails in two directions and only one of
 * them is loud. A re-introduced camera makes it fail, which is the point. But a
 * typo in its walk, an over-broad skip list, a renamed constant or a needle
 * quietly dropped from the list makes it pass everything — and a guard that
 * passes everything looks exactly like a codebase with no images in it. Nothing in
 * the suite could tell those apart, because the only input the guard ever read was
 * the repo it was written against.
 *
 * So this plants small fixture trees and asserts the guard's verdict on each: a
 * clean tree, every forbidden call, a tombstone, a subdirectory the walk must
 * reach, a skip directory it must ignore, the one allowed object URL, a
 * same-shaped call with image bytes, and a comment that merely names a forbidden
 * call. It also pins the needle lists themselves, so deleting a rule fails here
 * rather than silently widening what is allowed, and it runs the real CLI against
 * the real repo so a broken entry check cannot make the guard a no-op.
 *
 * The fixtures are built in the OS temp directory and removed after each case;
 * this test never writes into the repository.
 *
 * Run: node scripts/test-image-hygiene.mjs
 * Also a step in scripts/run-guards.mjs, before the guard it tests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_OBJECT_URL,
  IMAGE,
  NO_STORAGE,
  TOMBSTONES,
  checkTombstones,
  inspectShippedCode,
} from './check-image-hygiene.mjs';

const guardPath = fileURLToPath(new URL('./check-image-hygiene.mjs', import.meta.url));

let pass = 0;
const fails = [];
function ok(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n     got ${g}\n    want ${w}`);
}

/** Write a fixture tree from `{ 'relative/path': contents }` and hand back its root. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'image-hygiene-'));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

/** Run the guard against a fixture tree and clean up. */
function verdict(files) {
  const root = tree(files);
  try {
    return {
      tombstones: checkTombstones(root).length,
      messages: inspectShippedCode(root).messages,
      scanned: inspectShippedCode(root).scanned,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The failure messages a fixture produces, with the file/needle it names. */
const said = files => verdict(files).messages;

// ============================================================
// 1. A clean tree is silent — otherwise every case below proves nothing
// ============================================================
{
  const clean = verdict({
    'index.html': '<script type="module" src="/app.js"></script>\n',
    'app.js': 'export const entries = [];\nexport const money = n => `€${n.toFixed(2)}`;\n',
    'tesco.js': 'export function parseShiftText(text) { return { text }; }\n',
    'storage.js': 'export function downloadText(filename, text, mime = \'text/plain\') {\n'
      + `  const url = ${ALLOWED_OBJECT_URL.shape};\n`
      + '  return url;\n}\n',
    'hairline/figure.js': 'export function draw(readout) { return readout; }\n',
  });
  ok('a clean tree produces no failures', [clean.tombstones, clean.messages], [0, []]);
  ok('and the walk reaches subdirectories', clean.scanned >= 5, true);
}

// ============================================================
// 2. Each forbidden call is caught, and named with the file that made it
// ============================================================
const CASES = [
  ['camera.js', 'export const go = () => navigator.mediaDevices.getUserMedia({ video: true });\n', 'getUserMedia'],
  ['camera-input.js', 'export const input = `<input type="file" accept="image/*" capture="environment">`;\n', 'capture='],
  ['encode.js', 'export const png = canvas.toDataURL(\'image/png\');\n', 'toDataURL'],
  ['blob.js', 'export const url = URL.createObjectURL(file);\n', 'createObjectURL'],
  ['read.js', 'export const reader = new FileReader();\n', 'FileReader'],
  ['draw.js', 'context.drawImage(photo, 0, 0);\n', 'drawImage'],
  ['pixels.js', 'const data = context.getImageData(0, 0, w, h);\n', 'getImageData'],
  ['write.js', 'context.putImageData(image, 0, 0);\n', 'putImageData'],
  ['encode-offscreen.js', 'const blob = await canvas.convertToBlob({ type: \'image/png\' });\n', 'convertToBlob'],
  ['surface.js', 'const surface = new OffscreenCanvas(10, 10);\n', 'OffscreenCanvas'],
  ['buffer.js', 'const image = new ImageData(width, height);\n', 'ImageData'],
  ['worker.js', 'const worker = new Worker(\'/ocr-prep-worker.js\', { type: \'module\' });\n', 'new Worker('],
  ['engine.js', 'import Tesseract from \'tesseract.js\';\n', 'tesseract'],
];
// `some`, not `length === 1`: `ImageData` is a substring of `getImageData` and
// `putImageData`, so one canvas read is legitimately two violations.
for (const [file, source, needle] of CASES) {
  const messages = said({ 'app.js': 'export const ok = true;\n', [file]: source });
  ok(`a forbidden call in ${file} fails on ${needle}`,
    messages.some(message => message.startsWith(`${file} must not use ${needle}`)), true);
}

// A forbidden call is caught wherever the walk reaches, not only at the root.
{
  const messages = said({ 'hairline/figure.js': 'const px = ctx.getImageData(0, 0, 1, 1);\n' });
  ok('the scan follows the tree into a shipped subdirectory',
    messages.some(message => message.startsWith('hairline/figure.js must not use getImageData')), true);
}

// ...and not into a directory that is not shipped, or not ours to change.
for (const directory of ['vendor', 'node_modules', 'scripts', 'docs', 'tests', '.pages-dist']) {
  const messages = said({ [`${directory}/lib.js`]: 'navigator.mediaDevices.getUserMedia({ video: true });\n' });
  ok(`${directory}/ is not scanned (it is not part of the shipped app)`, messages, []);
}

// Non-source files are not scanned at all — a `.json` fixture naming the engine is
// a record, not a call site.
{
  const messages = said({ 'fixtures/roster-words.json': '{ "source": "tesseract.js reading a roster" }\n' });
  ok('a non-source file is not scanned', messages, []);
}

// ============================================================
// 3. A comment that merely names a forbidden call is not a violation
// ============================================================
{
  const messages = said({
    'tesco.js': '// No FileReader: file.text() is the whole read.\n// tesseract and the camera modal were removed in 97fb40f.\n'
      + 'export const read = file => file.text();\n',
    'app.js': '  // getUserMedia is gone; there is no canvas anywhere.\nexport const ok = true;\n',
  });
  ok('line comments naming a forbidden call are stripped before the scan', messages, []);
}

// ============================================================
// 4. Tombstones: each removed file fails the guard if it comes back
// ============================================================
for (const tombstone of TOMBSTONES) {
  const root = tree({ 'app.js': 'export const ok = true;\n', [tombstone]: '// restored\n' });
  try {
    const found = checkTombstones(root);
    ok(`a returned ${tombstone} fails the guard`,
      found.length === 1 && found[0].includes('removed on purpose'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
ok('the tombstone list still names the four removed surfaces', TOMBSTONES,
  ['ocr-prep-worker.js', 'ocr-pixels.js', 'ocr-harness.html', 'vendor/tesseract']);

// ============================================================
// 5. The one allowed object URL — allowed by shape, in one file, once
// ============================================================
{
  const allowed = said({ 'storage.js': `export const download = (text, mime) => ${ALLOWED_OBJECT_URL.shape};\n` });
  ok('the text download in storage.js is allowed', allowed, []);

  const imageBlob = said({ 'storage.js': 'export const download = url => URL.createObjectURL(new Blob([data], { type: \'image/png\' }));\n' });
  ok('a same-shaped object URL over image bytes fails',
    imageBlob.some(message => message.includes('is not the text download')), true);
  // Both rules fire: the shape is wrong, and what is left is a bare object URL.
  ok('and the leftover call is caught by the general rule too',
    imageBlob.some(message => message.includes('must not use createObjectURL')), true);

  const second = said({ 'storage.js': `export const a = ${ALLOWED_OBJECT_URL.shape};\nexport const b = URL.createObjectURL(other);\n` });
  ok('a second object URL beside the allowed one fails',
    second.some(message => message.includes('(2 call(s), 1 of them that shape)')), true);

  const elsewhere = said({ 'app.js': 'const url = URL.createObjectURL(file);\n' });
  ok('the allowance is scoped to storage.js, not to the call',
    elsewhere.length === 1 && elsewhere[0].startsWith('app.js must not use createObjectURL'), true);
}

// ============================================================
// 6. tesco.js may not write device storage, and no other module is held to that
// ============================================================
for (const [needle] of NO_STORAGE.forbidden) {
  const messages = said({ 'tesco.js': `${needle}something;\n` });
  ok(`tesco.js writing ${needle} fails`,
    messages.length === 1 && messages[0] === `tesco.js must not use ${needle} (${NO_STORAGE.forbidden.find(([n]) => n === needle)[1]}).`, true);
}
{
  const messages = said({ 'app.js': 'localStorage.setItem(\'k\', \'v\');\n' });
  ok('app.js is not held to tesco.js\'s storage rule (it owns storage)', messages, []);
}

// ============================================================
// 7. The rules themselves: a dropped needle fails here, not silently
// ============================================================
const NEEDLES = IMAGE.map(([needle]) => needle);
ok('the scan still forbids every capture/pixel call it was written for', NEEDLES,
  ['getUserMedia', 'capture=', 'toDataURL', 'createObjectURL', 'FileReader', 'drawImage',
    'getImageData', 'putImageData', 'convertToBlob', 'OffscreenCanvas', 'ImageData',
    'new Worker(', 'tesseract']);
ok('every needle carries a reason', IMAGE.every(([, why]) => typeof why === 'string' && why.length > 8), true);
ok('the storage rule still covers all four writes',
  NO_STORAGE.forbidden.map(([needle]) => needle), ['localStorage', 'sessionStorage', 'indexedDB', 'fetch(']);

// ============================================================
// 8. The real CLI still runs the real repo — an entry check that silently stops
//    matching would make the guard a no-op that prints nothing and exits 0
// ============================================================
{
  const run = spawnSync(process.execPath, [guardPath], { encoding: 'utf8' });
  ok('the guard exits 0 against this repo', run.status, 0);
  ok('and says so', /check-image-hygiene: OK/.test(run.stdout), true);
}

// ============================================================
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-image-hygiene: ${fails.length} FAILED, ${pass} passed\n`);
  for (const failure of fails) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`test-image-hygiene: OK — ${total} assertions (the scan, its skip list, every tombstone and the one allowed object URL all behave)`);
