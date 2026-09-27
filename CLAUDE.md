# Project Instructions — cents. (Expense Tracker)

Local-first, single-page expense tracker. No build step, no framework — plain ES modules, hand-written CSS, hash routing. Deployable to Netlify (static files + 3 serverless functions).

## Tech Stack
- **Vanilla JS (ES modules)** — `app.js` (~7k lines) is the whole UI; supporting modules are `storage.js` (state persistence), `settings.js` (device settings), `sync.js` (cloud sync client), `sync-merge.js` (cloud/local merge), `seed.js` (structural defaults).
- **State**: one validated JSON document in `localStorage` (`expense-tracker:v1`), schema-versioned (`schemaVersion: 2`).
- **Cloud sync**: Netlify Functions (`netlify/functions/sync.mjs`) proxy a single JSON file in a private GitHub repo; `setup-token.mjs` mints single-use setup links; `lib/` holds shared auth/token/store helpers.
- **Vendors** (in `vendor/`, lazy-loaded): SweetAlert2, flatpickr, Sortable, tippy/popper, anime, confetti.
- **No test framework.** Verification = `node --check` on every file + ad-hoc node scripts + live preview.

## Code Style
- Files: lowercase `kebab-case.js` / `*.mjs` for Netlify functions.
- DOM is built with the `$` helper (`app.js`) — it renders children as **text nodes** by default, so strings never need manual escaping. Prefer `$` over string `innerHTML`; all `innerHTML` assignments must stay constant/clear-only.
- State mutations funnel through `saveState`; destructive actions also write the **undo journal** (`saveUndoJournal` in `storage.js`) so toasts can offer Undo.

## Testing
- Syntax: `node --check` (copy `.js` → `.mjs` first for ESM syntax).
- Manual: `./serve.sh [port]`, then open `http://localhost:PORT/`. Default PIN to unlock is `100901` (no personal PIN set).
- Cloud sync + setup links only work with a deployed Netlify function or `netlify dev`.

## Build & Run
- Dev server: `./serve.sh 8080` (picks python3 → python → npx serve).
- Deploy: push to the repo; Netlify serves `publish = "."` with no build step.
- No lint, no bundler, no package.json.
- Tesco Pay workbook → the app's own import format: `python convert-tesco-csv.py "Tesco Pay.xlsx"` (standard library only, no pip installs; reads the Data *and* Summary sheets, normalises dates/times, writes the two-table CSV).

## Project Structure
```
app.js            UI + boot (hash routes: #dashboard #add #history #balances #tesco #insights)
storage.js        load/save/validate state, undo journal, exportJSON
settings.js       sync settings, privacy PIN (PBKDF2), biometric credentials
sync.js           cloud sync client (pull/push/test/token issue+exchange)
sync-merge.js     mergeStates() — union of local + cloud state
seed.js           category/method/settings defaults (edit here for forward-compat)
index.html        boot scripts (theme, SW, diagnostics) — 5 inline scripts, CSP-hashed
styles.css        design system (CSS variables: --ink, --line, --radius, emerald accent)
sw.js             service worker (network-first, same-origin cache only, cache 'cents-v22')
netlify.toml      headers incl. CSP with script hashes; function routes
ocr-harness.html  dev-only roster-photo harness (draws + photographs rosters, runs the real reader) — 404'd
scripts/fixtures/  real-engine word fixtures for the Node guards (e.g. roster-words.json)
netlify/functions/  sync.mjs (GitHub proxy), setup-token.mjs, lib/{auth,tokens,store}.mjs
vendor/ fonts/ icons/ screenshots/   static assets
serve.sh          local static server
```

## Conventions
- Commits: concise imperative summaries ("Fix …", "Add …", "Exclude … from …"), no conventional-commit prefixes, pushed straight to `main`.
- Amounts are euros as numbers validated to 2dp (`Math.round(a*100)/100 === a`); never silently round imported money.
- Budget calculations exclude load/withdraw balance adjustments and Revolut Savings (`RS`) transactions — check existing filters before touching budget math.
- Setup links carry encrypted tokens; the endpoint whitelist + post-unlock confirm dialog are security invariants — never bypass them.
- Tesco Pay's quick entry (the **Magic entry** card) is a thin wrapper around two module-scope, harness-pinned functions in `tesco.js`: `parseShiftText` reads the line, `shiftPreviewLine` renders what will be stored. Add a case to `scripts/test-tesco.mjs` rather than checking the card by eye — a mis-read line is a mis-paid week.
- Editing a stored shift goes through the same pair of module-scope, harness-pinned pieces: `applyShiftEdit` owns the rules (the importer's own — a date, or clock times, or stated hours) and returns `{ ok, shift }` or `{ ok, field, error }`; `updateShift` in `screenTesco` commits its answer through `snapshot`/`commitTesco` so an edit is one undo step and re-sorts the row into the week its new date belongs to. The row keeps its `id` (sync unions by id) and its `createdAt`. Add rules to `applyShiftEdit` + `scripts/test-tesco.mjs`, not to the sheet.
- `aria-label` is an addressed identity, not a label: `restoreFocusedField` looks fields up by it, and the harness probes by it. Two controls on one screen sharing one is a bug — the edit sheet's fields are `Edit shift …` precisely because the Add-shift card already owns `Shift …`.
- The roster-photo reader (`tesco.js`) is harness-pinned too, and it is the piece most likely to be broken by a local change. Keep every step pure where it can be — the geometry helpers `dedupeWords`, `pageSkew`, `columnAnchors`, `resolveColumnDates`, `ocrEstimateTilt`, `ocrAutoContrast`, `ocrSauvola`, `ocrLocalMarks`, `ocrIllumination`, `ocrRulingLines`, `rosterColumnsFromRules`, `rosterReadQuality` take plain word lists / grey buffers and are covered by `scripts/test-tesco.mjs` ("the sheet's own geometry", "the page as ink and paper", "which reading of a photo to believe"); the pixel passes (`decodePhoto`, `levelPhoto`, `turnPhoto`, `ocrRosterRow`, `ocrPageWords`, `ocrOwnerCells`, `ocrPhotoRules`) are covered by `ocr-harness.html`.
- The reader assumes the page's geometry is the *sheet's*, not the pixels': a tilted photo is levelled once (`ocrEstimateTilt` → `levelPhoto`) before any row/cell work, a sideways photo is retried after `turnPhoto` ±90°, and the 50 % strip overlap's duplicate words are collapsed by `dedupeWords` before parsing. When a date token disagrees with its column's weekday name, the weekday name wins — the day names are what `resolveColumnDates` trusts, and the week containing today is the fallback, not "the next Tuesday". The levelling search reaches ±8.5°, the same bound `pageSkew` trusts from the words: an estimator that stops at 6° reports a 7° sheet as 6° and levels it 1° wrong, which is enough to crop every cell onto the row above.
- **The strips are the cheap reading, not the deciding one.** `ocrRosterRow` offers every reading of a photo to `rosterReadQuality`, which scores it on what it actually produced (columns, the typed name on a row, dated shifts on that row, dates distinct, and a header the week could be dated from) and the reader escalates — page, then locally-thresholded page, then the photo turned a quarter turn — until one comes back *complete*, keeping the best score otherwise. A read that **merely mentions the typed name no longer ends the scan**: a read can carry the name and still put the week's shifts on the wrong days (that is exactly what a photo lit from one side does). `read.tries` on the result records what each reading scored, and the harness prints it.
- **Two binarisations, and the photo picks.** `ocrStretchCanvas(c, w, h, view)` gives the engine either a global contrast stretch (`stretch` — keeps the grey the LSTM reads, and the anti-aliased edge of a stroke) or a local Sauvola threshold (`ink` — segmentation the engine's own global Otsu gets wrong; tesseract's maintainers call theirs "rather bad quality" and it is what every layout decision is made from). `ocrIllumination` measures the photo's own light (the spread of the *paper* level between tiles, so text does not count as unevenness) and the escalation picks the view from it. A photo the reader can read never pays for the second view.
- **Rules beat names for the column boundaries.** `ocrLocalMarks` (mean − C, not Sauvola — a hairline table rule is far too faint for a glyph threshold) → `ocrRulingLines` (long contiguous runs, never ink counts) → `rosterColumnsFromRules`, which returns a grid only when it has seven columns *and* every column the words found falls inside the span that claims it, so refining the grid can straighten a crop but never move it onto another day. The name column's right edge is a rule on every ruled roster, and that is the boundary `rosterNameColumnRight` needs to be right.
- **A day column the header did not give up goes back into its own gap** (`columnAnchors`): a column's date is derived from its *position* in the row, so filling at an edge renumbers every day after it. Read at an angle with the light falling off, the header loses one day from the middle and a left-edge fill turned Tuesday's shift into Wednesday's — a whole week paid a day late, the one misread nobody notices. Only when there is no gap does the fill go to the left edge, where a phantom day is numbered *before* the week and takes no shift the day names did not already date.
- The camera modal (`openRosterCameraNow` in `tesco.js`) owns a live `MediaStream`, and **releasing the device is a first-class action, not a side effect of closing**: `finish()` (Cancel, Escape, backdrop, Capture, a live read that found shifts) stops the tracks, and **Stop live read releases them on the spot** — the camera light must never outlive that click. `openStream()` is the single acquire/re-acquire path so the one toggle button can cycle `Start camera → Live read → Stop live read` and be re-armed after a stop. A control with no handler is invisible until you use it: the Cancel button shipped inert and trapped the camera on.
- Anything a rebuild must not throw away lives either in `settings` (durable — written through as it is typed, e.g. `tescoName` on the scan card) or in a module-scope slot beside `scanState` / `rosterAnchor` (session-scoped, e.g. the roster's first-column date). A value computed only at build time (`weekStartOf(todayIso())`) is silently reset by every render — and with it the meaning of what the user is about to save. Both of those were wrong once: the name was saved only when a read ran, so a re-render blanked it just before the read needed it, and the anchor snapped back to this week under a month-old sheet.
- `aria-label` uniqueness is worth checking at runtime, not by eye: collect `[aria-label]` across a route (and inside every `.modal-bg`) and report repeats. Two split-slice control sets and every shift row's delete button were caught that way — the delete labels now carry the shift's own date and times, like the pencil beside them.
- `render()` does not drop a modal: `stackModal()` appends to `document.body`, outside `#app`, so a modal and its listeners survive a re-render (the camera modal's `MutationObserver` is belt-and-braces for a future sweep, not the thing keeping the camera light off).
- A figure derived from a field rides that field's **label line** (`.tesco-numfield-label`, e.g. the Sunday rate card's `= €21.66/h`), never a trailing line under its input: a line only one cell had made that cell taller than the one beside it, so the rates grid's rows were spaced 30px then 10px and — sized to its contents — that one cell came out 30px wider than its five neighbours. The grid itself is CSS `grid` with `minmax(0, 1fr)` columns (2 / 3 from 640px / 6 from 950px, the width six columns need to hold the Sunday label's own 114px), not a wrapping flex row: wrapping broke it 4+2 on a tablet and 5+1 just below where all six fit. The hint is `nowrap` so it cannot wrap the label at 320px.
- `render()` rebuilds the whole screen, so never call it from a field's `onInput`: app.js restores focus by aria-label but not the caret, and a rebuilt `type=number` field has no selection API at all (`selectionStart` is null), so the next digit lands at the wrong offset. Update the field's own row in place, debounce the figures around it, and paint once the caret has left the card — see `refreshDerived` / `repaintAfterPayslipEdit` in `tesco.js`.

## Security Invariants (do not regress)
- CSP in `netlify.toml` pins SHA-256 hashes of the 5 inline scripts in `index.html` — **editing any inline script requires re-hashing or the app won't boot** (browser console reports the correct hashes).
- `lib/tokens.mjs` = AES-256-GCM setup tokens, single-use via `lib/store.mjs` (Blobs, in-memory fallback). Password must never appear in URLs.
- Both functions: constant-time password compare (`lib/auth.mjs`), per-IP failure throttle, `APP_PASSWORD` ≥ 8 chars.
- `sw.js` caches same-origin GETs only — never cache sync-endpoint responses.
- No `eval`, no `innerHTML` with interpolated user data, no `dangerouslySetInnerHTML` equivalents.

## Icons
- All icons are hand-rolled inline SVGs ("Lucide-style") in `ICONS` / `MENU_ICONS` in `app.js`; render them via `iconSVG(name)`, `iconSpan(name, cls)`, or `tabIconSVG(route)`.
- Both navs now show route icons: the desktop top nav (`renderHeader` → `.nav-link`, from this session) and the mobile bottom-tab bar (`tabIconSVG`). Route→icon map: dashboard=`home`, add=`plus`, history=`clock`, balances=`wallet`, insights=`chart`. When adding a nav item, give both surfaces an icon.
- Icon SVGs inherit `currentColor`; sizing lives in `styles.css` (`.icon svg` and `.nav-link-icon svg`).
