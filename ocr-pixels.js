/**
 * The pixel layer the reader and its prep worker share.
 *
 * These are the transforms that turn a photo into what the engine is handed: the
 * global contrast stretch, the local Sauvola threshold, the box walk underneath it
 * and the entry point that runs them over an ImageData. They know nothing about
 * rosters — no columns, no dates, no cells — and they touch no DOM at module
 * scope, which is what lets the consumers be so different:
 *
 *   tesco.js            the reader: ocrLocalMarks and ocrIllumination use the box
 *                       walk, its cell pass paints its own per-mode views on a
 *                       context, and the guards in scripts/test-tesco.mjs
 *                       pin ocrAutoContrast and ocrSauvola against buffers.
 *   ocr-prep-worker.js  a worker of its own, which thresholds and encodes one
 *                       read's pixels (the bytes the reader read back from the
 *                       canvas it drew) so that neither happens on the app's
 *                       thread. It needs ocrStretchData — an ImageData, the one
 *                       shape a worker can be handed without a canvas.
 *
 * (There used to be a second, context-shaped entry point here — ocrStretchCanvas,
 * getImageData/putImageData wrapped around ocrStretchData. Nothing calls it any
 * more: the cell pass grew its own per-mode views and the strip/page reads go
 * through the prep worker's ImageData, so it was removed rather than kept as an
 * export only a doc comment could justify.)
 *
 * Split out of tesco.js when the prep moved off the main thread: the alternative
 * was a second copy of the threshold in the worker, and a threshold with two
 * copies is a threshold that can disagree with itself — the pinned version and the
 * one actually reading the photo.
 */

/**
 * Stretch a photo's own blacks and whites out to the full range, in place.
 *
 * A sheet photographed in shadow, or under a lamp that does not reach the far
 * corner, arrives with its text at 90 grey and its paper at 170: perfectly
 * legible to a person, and half the contrast the engine's binariser looks for —
 * which is how a whole roster comes back with words too faint to keep. The
 * percentiles ignore the few pixels a glare spot owns, and a photo that already
 * spans the range (lo near 0, hi near the top) is left exactly as it is, so a
 * good photo is read by the same engine it was read by before this existed.
 */
export function ocrAutoContrast(d, sample = 4) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * Math.max(1, sample)) { hist[d[i]]++; n++; }
  if (!n) return;
  // Most of a sheet of paper is paper: when the median pixel is already white the
  // photo is exposed, and stretching it would only amplify the JPEG's ringing
  // around every stroke — which is exactly what a thin-stroke page (a monospace
  // roster, small print) has to survive. The stretch is for the photo whose paper
  // is grey: shot in shadow, or lit from one side.
  let acc = 0, median = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.5) { median = v; break; } }
  if (median >= 235) return;
  let lo = 0, hi = 255;
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.004) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.004) { hi = v; break; } }
  if (hi - lo < 60 || hi - lo > 245) return;
  const span = hi - lo;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, Math.round(((d[i] - lo) / span) * 255)));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}

/**
 * The page as ink and paper, thresholded LOCALLY rather than globally.
 *
 * Everything above this point treats the photo's light as one number: a single
 * linear stretch of the whole frame (ocrAutoContrast). That is the right answer
 * for a sheet photographed in flat shade, and the wrong one for the sheet that
 * is really photographed — a lamp at one end, a window at the other, a phone's
 * own shadow across the bottom third. There the paper is at 200 grey in the light
 * and 120 in the shade, so no single threshold separates ink from paper anywhere
 * except in the band it was tuned for: the light end binarises to a solid black
 * slab and the dark end to blank white. A page read that way loses a whole
 * column of shifts.
 *
 * The engine's own binariser is the same global Otsu — tesseract's maintainers
 * describe it as "custom global Otsu without normalization" of "rather bad
 * quality", and it is what every segmentation and layout decision is made from,
 * even though recognition itself runs on the grey image. So the useful move is
 * the one this function makes: do the local threshold here, where the roster's
 * own geometry is known, and hand the engine a page that is already clean.
 *
 * Sauvola's rule, computed from two box means (see the sliding windows below):
 *
 *     T = m * (1 + k * (s / R - 1))
 *
 * A pixel is ink when it is darker than the mean `m` of the window it sits in,
 * by a margin that grows with the window's own standard deviation `s`. On bare
 * paper s is ~0, so T = m(1-k) and only a real mark survives; in a band of text s
 * is large, so T rises toward m and faint strokes in that band are still caught.
 * That is what makes it follow a lighting gradient — m moves with the light, and
 * the decision moves with it.
 *
 * `k = 0.24` and `R = 128` are the values Sauvola's own paper recommends and the
 * ones the document-binarisation literature converges on for photographed text.
 * Pure over a grey buffer (0 = black), so the threshold the reader uses can be
 * pinned without a camera. Returns 0 for ink and 255 for paper.
 */
export function ocrSauvola(grey, w, h, opts = {}) {
  if (!grey || !w || !h || grey.length < w * h) return new Uint8Array(0);
  const k = opts.k == null ? 0.24 : opts.k;
  const R = opts.R == null ? 128 : opts.R;
  // The window has to be wider than a stroke (or the mean sits ON the glyph and
  // the glyph is split into its own edges) and narrower than a column of text
  // (or the mean becomes the page's and this is a global threshold again). A
  // third of the shorter side is the band that holds for a roster cell; the long
  // page passes in an explicit radius sized from the glyphs instead.
  const r = Math.max(4, Math.min(96, Math.round(
    opts.radius == null ? Math.min(w, h) / 3 : opts.radius)));
  const out = new Uint8Array(w * h);
  ocrBoxWalk(grey, w, h, r, (x, y, m, sd) => {
    out[y * w + x] = grey[y * w + x] > m * (1 + k * (sd / R - 1)) ? 255 : 0;
  });
  return out;
}

/**
 * The window's mean and standard deviation at every pixel, in one pass and in
 * O(width) memory.
 *
 * The window is a square box, so its statistics separate exactly into a
 * horizontal pass over a vertical sum — two sliding sums, one column-resident
 * (`colA`/`colB`) and one walking the row. The obvious alternative, an integral
 * image, is also O(1) per pixel but costs a Float64 accumulator per pixel per
 * statistic: at the 12 MP working budget that is ~200 MB of RAM on a phone for a
 * threshold, against ~8 KB here.
 *
 * Paper runs off every edge of a photo, so the window is REPLICATED at the
 * margins rather than truncated. A truncated window has a smaller n and a smaller
 * s, so every local rule that scales with s — Sauvola's especially — goes
 * conservative exactly at the edge of the sheet, which is where a roster prints
 * its first and last day columns.
 */
export function ocrBoxWalk(grey, w, h, r, visit) {
  const colA = new Float32Array(w), colB = new Float32Array(w);
  const span = 2 * r + 1;
  const n = span * span;
  const rowAt = y => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  const colAt = x => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  for (let dy = -r; dy <= r; dy++) {
    const base = rowAt(dy) * w;
    for (let x = 0; x < w; x++) { const v = grey[base + x]; colA[x] += v; colB[x] += v * v; }
  }
  for (let y = 0; y < h; y++) {
    if (y > 0) {
      const add = rowAt(y + r) * w, del = rowAt(y - r - 1) * w;
      for (let x = 0; x < w; x++) {
        const a = grey[add + x], b = grey[del + x];
        colA[x] += a - b; colB[x] += a * a - b * b;
      }
    }
    let sa = 0, sb = 0;
    for (let dx = -r; dx <= r; dx++) { const i = colAt(dx); sa += colA[i]; sb += colB[i]; }
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        const ai = colAt(x + r), di = colAt(x - r - 1);
        sa += colA[ai] - colA[di]; sb += colB[ai] - colB[di];
      }
      const m = sa / n;
      visit(x, y, m, Math.sqrt(Math.max(0, sb / n - m * m)));
    }
  }
}

/**
 * The two transforms, on pixels the caller already holds.
 *
 * `img` is an ImageData — or anything shaped like one (`data`, `width`, `height`)
 * — and is mutated in place: 'stretch' applies the global contrast stretch, 'ink'
 * the local Sauvola threshold, anything the threshold cannot do falls back to the
 * stretch. Returns the view actually used, so a read can say what it was given.
 *
 * This is the shape the prep worker has its pixels in: it is handed the bytes the
 * reader read back from the canvas it drew, and this is all that is left to do to
 * them. It is also the shape the guards can pin — a plain buffer, no canvas
 * involved (see scripts/test-tesco.mjs) — which is why the canvas-shaped entry
 * point below is a wrapper around it rather than the other way round.
 */
export function ocrStretchData(img, view = 'stretch', radius = 0) {
  const d = img && img.data;
  if (!d || !d.length) return 'stretch';
  if (view === 'stretch') { ocrAutoContrast(d); return 'stretch'; }
  const w = img.width, h = img.height;
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) grey[i] = d[i * 4];
  const bin = ocrSauvola(grey, w, h, radius ? { radius } : {});
  if (!bin.length) { ocrAutoContrast(d); return 'stretch'; }
  for (let i = 0; i < grey.length; i++) {
    const v = bin[i];
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return 'ink';
}
