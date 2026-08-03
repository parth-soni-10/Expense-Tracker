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

## Load order matters

`index.html` loads these as classic `<script defer>` tags **before** the
`app.js` module. `popper.min.js` MUST come before `tippy-bundle.umd.min.js`:
tippy's UMD bundle reads `window.Popper` at load time and throws if it's
missing.

## Updating

Download the same file paths from jsDelivr/unpkg (the URLs in the git
history of this folder), or re-fetch from the project repos above. Keep the
filenames identical — `index.html` references them by name.
