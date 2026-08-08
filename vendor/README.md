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
| `confetti.browser.min.js` | canvas-confetti | 1.9.3    | ISC     | https://github.com/catdad/canvas-confetti                 |
| `anime.min.js`          | anime.js         | 3.2.2     | MIT     | https://github.com/juliangarnier/anime                    |
| `flatpickr.min.js`      | flatpickr        | 4.6.13    | MIT     | https://github.com/flatpickr/flatpickr                    |
| `flatpickr.min.css`     | flatpickr styles | 4.6.13    | MIT     | https://github.com/flatpickr/flatpickr                    |

## Load strategy (kept deliberately light)

`index.html` loads **only `sweetalert2.min.js`** eagerly (confirm dialogs are
used by every destructive action). Everything else — flatpickr (+ its CSS),
tippy + Popper, SortableJS, canvas-confetti and anime.js — is **fetched
lazily on first use** by `loadVendor()` in `app.js`, so the initial page load
downloads ~200KB less JavaScript. `vendor/*` files still ship with the site;
they're just requested on demand (e.g. the first time a date field is opened,
the heatmap renders, a category chip list is shown, confetti fires, or the
insights donut animates).

## Load order matters

When lazy-loading, `popper.min.js` MUST load before `tippy-bundle.umd.min.js`:
tippy's UMD bundle reads `window.Popper` at load time and throws if it's
missing. `loadVendor()` in `app.js` resolves Popper first, then tippy.

## Updating

Download the same file paths from jsDelivr/unpkg (the URLs in the git
history of this folder), or re-fetch from the project repos above. Keep the
filenames identical — `app.js` references them by name.
