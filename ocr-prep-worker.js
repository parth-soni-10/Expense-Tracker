/**
 * The reader's preparation of one read, on a thread of its own.
 *
 * Every reading of a roster photo needs the same thing done to its pixels before
 * the engine sees them: the region the read looks at is drawn at the resolution
 * the engine reads, binarised — a global contrast stretch for a sheet lit evenly,
 * Sauvola's local threshold for one lit from the side — and encoded as a PNG,
 * which is what tesseract.js hands its own worker. On a 12 MP strip that is a
 * draw (~30 ms), a readback, a threshold (~490 ms) and a PNG encode (~1.7 s on the
 * reader's thread), and the reader's thread was busy through 316–684 ms of it
 * (measured interleaved with the version below, on one machine, with a
 * MessageChannel ping loop — the only honest way here, since a hidden tab throttles
 * `setTimeout` heartbeats and reports stalls that are not there).
 *
 * That time is time the app cannot use for anything else: while a strip was being
 * encoded the reader could not start the next reading, collect the one that
 * finished, or repaint the progress bar. It was the one part of a scan that could
 * not overlap the engine. So the threshold and the encode come here, and the
 * reader's thread keeps only the two steps that need the photo — the draw, and the
 * readback that turns it into bytes worth sending (see prepEncode in tesco.js) —
 * 151–292 ms of longest stall instead, with the prep itself 1.4–1.8 s → 0.4–0.6 s
 * (a worker's `convertToBlob` is the faster encoder of the two: 0.5–0.6 s against
 * 1.7 s for the same image on a canvas).
 *
 * **What arrives here is the pixels, not the photo.** The reader draws the region
 * and reads it back exactly as it did when this all happened on its thread — the
 * same `drawImage`, the same source rectangle, the same canvas — and transfers
 * that buffer. Handing the worker a cropped bitmap to draw itself instead is much
 * cheaper (5 ms of reader thread, the whole prep on the worker) and was measured
 * to move 1,716 pixels of a 12 MP strip by up to three grey levels: `drawImage`
 * resamples a source rectangle and a pre-cut image differently. Three grey levels
 * on 0.01 % of the pixels sounds like nothing, and it flipped the harness's
 * `blurry` scenario through the cell pass, which cuts its crops from the word
 * boxes that image produces. A reader pinned by 39 marginal scenarios is not the
 * place to accept "almost the same pixels", so the draw stays where the pixels are
 * known: the engine is handed the image it was always handed, byte for byte.
 *
 * `type: 'module'`, because the threshold lives in ocr-pixels.js and this must be
 * the same copy the reader itself uses — the reader's cell pass calls it on a
 * context, this calls it on an ImageData, and a threshold with two implementations
 * is a threshold that can disagree with itself.
 *
 * Nothing is stored, nothing is written anywhere, and the buffer is consumed once:
 * the reader gives up ownership of it in the transfer, and the working canvas here
 * is this worker's own — never the reader's preview, and never the reader's
 * canvas. The reader terminates every prep worker when a scan ends
 * (disposeOcrWorker in tesco.js), so a photo's pixels cannot outlive the scan that
 * picked it.
 */
import { ocrStretchData } from './ocr-pixels.js';

// One job at a time on this worker, in the order the jobs arrived. The surface
// below is reused between jobs, so two overlapping jobs would write over each
// other's pixels — and a job is a `convertToBlob` long, which is exactly long
// enough for that. The reader's own pool hands each job a free worker instead of
// queueing on a busy one, so nothing waits here that could have gone elsewhere.
let surface = null;
let queue = Promise.resolve();

self.onmessage = (event) => {
  const job = event.data || {};
  queue = queue.then(() => run(job)).catch(() => {
    // run() answers every job itself; this only keeps one failed job from
    // stopping the ones behind it.
  });
};

async function run(job) {
  const { id, type, data } = job;
  try {
    if (type !== 'binarise') throw new Error(`Unknown prep job "${type}".`);
    const { w, h, view = 'stretch', radius = 0 } = job;
    if (!data || !(w > 0) || !(h > 0)) throw new Error('A prep job needs a read\'s pixels and the size they are in.');
    // The threshold runs on the pixels as they were read back, and the canvas is
    // only how they get encoded: written once, never read, so the view this
    // returns is the one claim about them worth sending home.
    const img = new ImageData(new Uint8ClampedArray(data), w, h);
    const used = ocrStretchData(img, view, radius);
    if (!surface) surface = new OffscreenCanvas(w, h);
    else { surface.width = w; surface.height = h; }
    const c = surface.getContext('2d', { willReadFrequently: true });
    c.putImageData(img, 0, 0);
    const blob = await surface.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, ok: true, blob, w, h, view: used });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
}
