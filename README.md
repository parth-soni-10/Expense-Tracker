# cents. — personal expense tracker

A minimal, aesthetic single-page expense tracker. No build step, no framework — just `index.html`, a handful of ES modules, and hand-written CSS. All your data lives in the browser's `localStorage` and, once cloud sync is enabled, in a single JSON file inside a **private GitHub repo you control** — copied there automatically by a tiny Netlify Function.

## How it works

The app is a classic SPA: `app.js` owns the UI and routing, `storage.js` owns the data, and the two talk through a small, validated state object. Every change flows one way:

```
you act → state updated in memory → persisted to localStorage → (optionally) pushed to your GitHub file
```

- **State is one JSON document.** All entries, settings, balances, and bookkeeping live in a single validated state object (schema-versioned). Nothing is stored piecemeal.
- **`localStorage` is the source of truth.** The app reads it on boot and writes on every change. Cloud sync is a *copy* of that document, not a database.
- **Strict validation.** Every load runs the stored JSON through a validator — unknown fields are dropped, missing fields get defaults, bad entries are filtered. A hand-edited or older cloud file can never crash the app.
- **Everything is undoable.** Most destructive actions capture an undo snapshot, and the few that need to survive a reload (delete, reset, some edits) are written to a small journal so you can undo even after closing the tab.

## Stack

- Plain `index.html` + small ES modules — **no build step**
- Vanilla JS (no framework), hand-written CSS in `styles.css`
- `localStorage` for primary storage
- Optional **GitHub sync** via a Netlify Function (Node, ~140 lines)
- Self-hosted fonts in `fonts/` (Space Grotesk + IBM Plex Mono, latin subset) - no third-party requests; system fonts are the fallback while woff2 loads

## Files

```
.
├── index.html                shell, fonts, loads app.js
├── styles.css                monochrome + emerald palette + components
├── app.js                    hash router, screens, modals, undo, PIN & biometric lock
├── sync-merge.js             pure cloud-reconciliation merge logic (union + LWW)
├── sync.js                   client-side GitHub-sync primitives
├── settings.js               sync configuration in localStorage
├── storage.js                localStorage CRUD, strict validation, JSON I/O
├── seed.js                   structural defaults (categories, methods, settings)
├── fonts/                    self-hosted Space Grotesk + IBM Plex Mono woff2
├── netlify.toml              static hosting + SPA fallback
└── netlify/
    └── functions/
        └── sync.mjs          the GitHub proxy (one PUT/GET endpoint, app-password gated)
```

## The data model

Everything hangs off one state object:

- **`entries`** — the transactions. Each entry records `date`, `type` (expense / credit), `category`, `details`, `amount`, `method`, plus `createdAt` / `updatedAt` timestamps used for conflict resolution.
- **`settings`** — monthly budget, currency, custom categories, recurring rules, balance checkpoints (bank & gift-card balances by date), and a coin/cash drawer breakdown.
- **`schemaVersion`** — lets the app migrate old saved data forward instead of breaking.

## Screens & features

- **Dashboard** (`#dashboard`, default) — current month hero: income, spending, net; budget bar; category breakdown; recent entries with inline budget editing; a live sync-status indicator.
- **Add — "Magic entry"** (`#add`) — instead of a form-first flow, you type a plain-language description ("lidl groceries 4.47 revolut") and the app parses it: amount, date, category, payment method, and description are auto-detected and cleaned up before the entry is saved. You can review and tweak any field before committing.
- **History** (`#history`) — month picker + category filters, a calendar/heatmap overview, and clickable rows that open the edit modal.
- **Insights** (`#insights`) — 90-day analytics: averages, top method, category bars, payment mix, and a spending heatmap.
- **Balances** (`#balances`) — reconciliation editor for banks (AIB, Revolut, Revolut Savings) and gift cards (Tesco, Lidl, Aldi). Record an end-of-day actual balance for a date and the app shows the delta vs. the book balance; a **+Load** button tops up any account or card with a dated credit entry. Transaction records are never modified — checkpoints are stored separately.
- **Security lock** — every device boots locked. The site-wide default PIN is `100901` until you set a personal PIN in **Privacy & security** settings. On **mobile browsers**, the lock screen also offers **fingerprint / Face ID** unlock via the Web Authentication API — the credential is stored per-device and the OS does the verification, so it never leaves the device. Desktop and the PIN path are unchanged.
- **Recurring transactions** — weekly/monthly rules with a `nextDate` that advances as occurrences are logged or skipped (skips are undoable).
- **Cash drawer** — a coin breakdown (counts × denominations) that computes the total cash on hand.
- **Extras** — dark mode, JSON export/import, and a full device reset.

## Sync & merging

Cloud sync keeps your single JSON document in a private GitHub repo through the Netlify Function. The browser talks only to your function; the GitHub token lives only in the function's environment. The sync client is a straightforward loop:

- **Push** — after you stop typing (~1.5s), the app pushes your local state to the cloud file.
- **Pull** — the app merges the cloud state into local on boot, when you switch back to the tab, and on a 30s background poll, so two open devices converge within about half a minute.
- **Merge, never replace** — the merge logic in `sync-merge.js` reconciles the two states rather than overwriting one with the other:
  - **Entries** are unioned by id; the newest version of a conflicting entry wins.
  - **Deletions** become tombstones, so a deleted entry can't resurrect from another device's older copy (undo still restores it).
  - **Settings** scalars (budget, currency) come from the newer side; custom categories, recurring rules, and balance checkpoints are unioned.
  - **Resets** are treated as a deliberate "start over" — the newer reset wins.
- **Conflicts** — if the cloud file changed since the last read (GitHub returns a 409 on the guarded write), the app automatically pulls, merges, and pushes the merged result. No data is lost, and you never have to resolve conflicts by hand.
- Disconnecting sync wipes the app password and endpoint from that device only; the cloud file stays until you delete it from GitHub.

## Privacy

- Without sync: 100% local — `localStorage` keyed `expense-tracker:v1`. Nothing is ever sent anywhere.
- With sync: a copy lives in your private GitHub repo, written through the function using an app password you choose. The app password is stored in the browser (same risk profile as saving any password in a browser) and the GitHub token never leaves the Netlify Function's environment.

## Running it locally

The app uses ES modules, so `index.html` can't be opened via `file://`. From the project root:

```bash
./serve.sh        # bash / Git Bash / macOS / Linux   (port 8080)
serve.bat         # Windows native cmd                (port 8080)
python -m http.server 8080
```

Then open `http://localhost:8080`. Everything works locally except cloud sync, which needs the deployed Netlify Function.

## Editing the data shape

- **Categories?** `CATEGORIES` in `seed.js` *and* `CATEGORIES_OK` in `storage.js`
- **Methods?** `METHODS` in `seed.js` *and* `METHODS_OK` in `storage.js`
- **Default budget?** `SEED_SETTINGS.monthlyBudget` in `seed.js`
- **Reset everything on this device?** Use the "Reset" link in the footer, or in DevTools: `__cents.state = resetToBlank(); __cents.render();`

## License

Personal project — do whatever you like with it.
