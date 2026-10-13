# vendor/ — vendored third-party libraries

All files here are minified UMD/browser builds, vendored locally so the app
works fully offline and with no build step or CDN dependency. Every
integration in `app.js` degrades gracefully — if a file is missing, the app
falls back to native behaviour.

| File                    | Library          | Version   | License | Source                                                    |
| ----------------------- | ---------------- | --------- | ------- | --------------------------------------------------------- |
| `sweetalert2.min.js`    | SweetAlert2      | 11.x      | MIT     | https://github.com/sweetalert2/sweetalert2                |
| `popper.min.js`         | @popperjs/core   | 2.11.8    | MIT     | https://github.com/floating-ui/floating-ui                |
| `tippy-bundle.umd.min.js` | tippy.js (bundle, needs Popper global) | 6.x | MIT | https://github.com/atomiks/tippyjs |
| `Sortable.min.js`       | SortableJS       | 1.15.2    | MIT     | https://github.com/SortableJS/Sortable                    |
| `flatpickr.min.js`      | flatpickr        | 4.6.13    | MIT     | https://github.com/flatpickr/flatpickr                    |
| `flatpickr.min.css`     | flatpickr styles | 4.6.13    | MIT     | https://github.com/flatpickr/flatpickr                    |
| `fuse.min.js`           | Fuse.js (fuzzy search) | 6.6.2 | Apache-2.0 | https://github.com/krisk/Fuse                |
| `tabbable.umd.min.js`   | tabbable         | 6.5.0     | MIT     | https://github.com/focus-trap/tabbable                    |
| `focus-trap.umd.min.js` | focus-trap       | 8.2.2     | MIT     | https://github.com/focus-trap/focus-trap                  |
| `xlsx.mini.min.js`      | SheetJS (workbook import) | 0.18.5 | Apache-2.0 | https://git.sheetjs.com/sheetjs/sheetjs           |

### `tesseract/` — roster OCR (Tesco Pay tab)

| File                                | What it is                              | License    |
| ----------------------------------- | --------------------------------------- | ---------- |
| `tesseract.min.js`                  | tesseract.js 5.1.1 browser build        | Apache-2.0 |
| `worker.min.js`                     | recognition worker                      | Apache-2.0 |
| `tesseract-core-simd-lstm.wasm.js`  | LSTM core glue, SIMD                    | Apache-2.0 |
| `tesseract-core-simd-lstm.wasm`     | its WebAssembly binary (~2.9 MB)        | Apache-2.0 |
| `tesseract-core-lstm.wasm.js`       | LSTM core glue, non-SIMD (old iOS)      | Apache-2.0 |
| `tesseract-core-lstm.wasm`          | its WebAssembly binary                  | Apache-2.0 |
| `eng.traineddata.gz`                | English model, 4.0.0_best_int (~3 MB)   | Apache-2.0 |

Vendored rather than CDN-loaded so the OCR stays same-origin (the CSP allows
no third-party scripts) and works offline once used. Nothing here is on the
boot path: `tesco.js` injects `tesseract.min.js` on the first roster scan,
and the core/WASM/model are fetched by the worker at that point. The service
worker's runtime cache picks them up, so later scans (and offline scans) skip
the download. Sources: npm `tesseract.js@5.1.1`, `tesseract.js-core@5.1.1`,
`@tesseract.js-data/eng@1.0.0` (`4.0.0_best_int`).

**The core ships as glue + `.wasm`, not the `-single-file` build.**
tesseract.js-core publishes both; the `*.wasm.js` files used here are the
*glue* from the split build, which fetches its sibling `.wasm` binary as a
normal same-origin request. The other published variant inlines that binary
as a base64 `data:` URL the core loads, and a strict `connect-src` blocks it —
it still scanned, but only by falling back, logging a CSP error per scan.

That split build only resolves its `.wasm` sibling when the worker has a real
base URL, so `tesco.js` passes `workerBlobURL: false`. tesseract.js otherwise
wraps the worker in a blob URL, and a relative URL cannot be resolved against
`blob:` (`Failed to parse URL from tesseract-core-….wasm`). Both settings are
load-bearing: change one and the scan stops finding its core.

`_headers` also pins `Content-Type: application/wasm` for `*.wasm`, which
the streaming compiler requires — a mislabelled response is rejected outright.

## Load strategy (kept deliberately light)

`index.html` loads **only `sweetalert2.min.js`** eagerly (confirm dialogs are
used by every destructive action). Everything else — flatpickr (+ its CSS),
tippy + Popper, SortableJS, Fuse, tabbable + focus-trap and SheetJS — is
**fetched lazily on first use** by `loadVendor()` in `app.js`, so the initial
page load downloads ~200KB less JavaScript. `vendor/*` files still ship with the
site; they're just requested on demand (e.g. the first time a date field is
opened, the heatmap renders, a category chip list is shown, a search field is
typed in, a modal opens for the first time, or a workbook is imported).

canvas-confetti and anime.js were vendored here for a month-end confetti burst
and the Insights donut's draw-in. Both were removed (and both files deleted) in
the slop pass: neither was information, and each bought a repaint on a screen the
reader was trying to read.

`xlsx.mini.min.js` is the **mini** build on purpose: it reads `.xlsx`/`.xlsm`
and skips the writers, the codepage tables and the legacy `.xls` (BIFF) reader,
which is ~600KB of bundle the roster import never touches. That is why the
import accept list offers no `.xls`.

## Load order matters

When lazy-loading, `popper.min.js` MUST load before `tippy-bundle.umd.min.js`:
tippy's UMD bundle reads `window.Popper` at load time and throws if it's
missing. `loadVendor()` in `app.js` resolves Popper first, then tippy.

The same rule applies to `tabbable.umd.min.js` before `focus-trap.umd.min.js`:
focus-trap's UMD build does **not** bundle tabbable — it calls it as a global
(`t(a, e.tabbable)`), so a focus trap created without tabbable on the page
throws and the modal is left untrapped. `loadVendor('tabbable')` is awaited
before `loadVendor('focus-trap')` in `syncModalFocusTrap()`.

## Versions that matter

Fuse.js is pinned at **6.6.2**, the last release that publishes a UMD browser
build (`dist/fuse.min.js`). 7.x ships `.mjs`/`.cjs` only, which a no-build,
`script-src 'self'` app cannot load from a `<script>` tag — so a "bump Fuse"
edit is not a version bump, it is a rewrite of the loader.

## Updating

Download the same file paths from jsDelivr/unpkg (the URLs in the git
history of this folder), or re-fetch from the project repos above. Keep the
filenames identical — `app.js` references them by name.
