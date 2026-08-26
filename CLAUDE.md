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

## Project Structure
```
app.js            UI + boot (hash routes: #dashboard #add #history #balances #insights)
storage.js        load/save/validate state, undo journal, exportJSON
settings.js       sync settings, privacy PIN (PBKDF2), biometric credentials
sync.js           cloud sync client (pull/push/test/token issue+exchange)
sync-merge.js     mergeStates() — union of local + cloud state
seed.js           category/method/settings defaults (edit here for forward-compat)
index.html        boot scripts (theme, SW, diagnostics) — 5 inline scripts, CSP-hashed
styles.css        design system (CSS variables: --ink, --line, --radius, emerald accent)
sw.js             service worker (network-first, same-origin cache only, cache 'cents-v3')
netlify.toml      headers incl. CSP with script hashes; function routes
netlify/functions/  sync.mjs (GitHub proxy), setup-token.mjs, lib/{auth,tokens,store}.mjs
vendor/ fonts/ icons/ screenshots/   static assets
serve.sh          local static server
```

## Conventions
- Commits: concise imperative summaries ("Fix …", "Add …", "Exclude … from …"), no conventional-commit prefixes, pushed straight to `main`.
- Amounts are euros as numbers validated to 2dp (`Math.round(a*100)/100 === a`); never silently round imported money.
- Budget calculations exclude load/withdraw balance adjustments and Revolut Savings (`RS`) transactions — check existing filters before touching budget math.
- Setup links carry encrypted tokens; the endpoint whitelist + post-unlock confirm dialog are security invariants — never bypass them.

## Security Invariants (do not regress)
- CSP in `netlify.toml` pins SHA-256 hashes of the 5 inline scripts in `index.html` — **editing any inline script requires re-hashing or the app won't boot** (browser console reports the correct hashes).
- `lib/tokens.mjs` = AES-256-GCM setup tokens, single-use via `lib/store.mjs` (Blobs, in-memory fallback). Password must never appear in URLs.
- Both functions: constant-time password compare (`lib/auth.mjs`), per-IP failure throttle, `APP_PASSWORD` ≥ 8 chars.
- `sw.js` caches same-origin GETs only — never cache sync-endpoint responses.
- No `eval`, no `innerHTML` with interpolated user data, no `dangerouslySetInnerHTML` equivalents.
