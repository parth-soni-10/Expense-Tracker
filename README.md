# cents. — personal expense tracker

A minimal, aesthetic single-page expense tracker. Pure static site, hosted on Netlify. All data lives in your browser's `localStorage` — and, once you turn it on, in a single JSON file in a **private GitHub repo** you control, copied there automatically by a tiny Netlify Function.

## Stack

- Plain `index.html` + a few small ES modules — **no build step**
- Vanilla JS (no framework)
- Hand-written CSS in `styles.css` — no utility framework
- `localStorage` for primary storage
- Optional **GitHub sync** via a Netlify Function (Node, ~140 lines)
- Google Fonts at first load (Instrument Serif + Inter) — falls back to system fonts if blocked

## Files

```
.
├── index.html                shell, fonts, loads app.js
├── styles.css                editorial palette + components
├── app.js                    hash router, 5 screens, modals (edit, import, sync)
├── sync-merge.js             pure cloud-reconciliation merge logic (union + LWW)
├── sync.js                   client-side GitHub-sync primitives
├── settings.js               sync configuration in localStorage
├── storage.js                localStorage CRUD, strict validation, JSON I/O
├── seed.js                   structural defaults (categories, methods, settings)
├── netlify.toml              static + SPA fallback
├── README.md
└── netlify/
    └── functions/
        └── sync.mjs          the GitHub proxy (one PUT/GET endpoint, app-password gated)
```

## Screens

- `#dashboard` (default) — current month hero, budget bar, category breakdown, recent entries, inline budget editor, sync status indicator
- `#add` — minimal form: type, amount, date, method, category, description, note
- `#history` — month picker + category filters + clickable rows (opens edit modal)
- `#insights` — 90-day analytics: averages, top method, category bars, payment mix
- **Sync** modal — connect to GitHub, see status, manual Pull/Push, Disconnect

## Local preview

The app uses ES modules (`<script type="module">`), so opening `index.html` directly via `file://` won't work — browsers block module loads from local files.

Use one of these commands from the project root (the folder containing `index.html`):

```bash
./serve.sh                  # bash / Git Bash / macOS / Linux          (port 8080)
serve.bat                   # Windows native cmd                       (port 8080)
python -m http.server 8080  # if you'd rather run it yourself
npx --yes serve -l 8080 .    # if you'd rather run it yourself (Node)
```

Then open `http://localhost:8080`. **Sync won't work here** — it needs the Netlify Function. Everything else (Add, Edit, History, Insights, Import/Export, Reset) works fully offline.

`localStorage` is scoped per-origin, so data created at `localhost:8080` won't follow you to your Netlify URL — Export → JSON and Import to move it.

## Deploy to Netlify

Two ways, no build step:

**A — drag-and-drop** (zero git):

1. Zip this project root (the folder containing `netlify.toml`).
2. Netlify dashboard → "Add new site" → "Deploy manually" → drop the zip.
3. Done. URL works in ~30 seconds.

**B — connect to git** (auto-deploy on push):

1. Push the project root to a GitHub repo.
2. Netlify → "Add new site" → "Import from Git".
3. Build command: *(leave empty)*. Publish directory: `.` *(the repo root, where `netlify.toml` lives)*.
4. Every `git push` redeploys.

The included `netlify.toml` makes `/*` routes fall back to `index.html`, so direct links like `…/#history?month=2026-07` and page refreshes work.

---

## GitHub sync — turn your data multi-device

A tiny serverless function (`netlify/functions/sync.mjs`) reads and writes **one JSON file** in a private GitHub repo you own — no third-party service, no database. The GitHub PAT lives **only in Netlify's environment**, never in the bundle. The browser talks only to your function.

### One-time setup

#### 1. Create a private repo just for the data

Pick a name like `cents-data`. Initialise it empty (no README, no `.gitignore`). The repo URL will look like `github.com/<yourname>/cents-data`.

#### 2. Create a fine-grained Personal Access Token

`github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token`

- Token name: `cents-netlify-fn`
- Resource owner: yourself
- Repository access: **Only select repositories → cents-data**
- Permissions: **Contents: Read and write** (everything else: no access)
- Expiration: whatever you like (rotate yearly)

Copy the token — you'll paste it into Netlify next.

#### 3. Set Netlify environment variables

In your Netlify site: **Site settings → Environment variables → Add a variable**. Add these six:

| Variable       | Value                                             |
| -------------- | ------------------------------------------------- |
| `GITHUB_TOKEN` | the fine-grained PAT from step 2                  |
| `REPO_OWNER`   | your GitHub username (or org)                     |
| `REPO_NAME`    | `cents-data`                                      |
| `REPO_BRANCH`  | `main`                                            |
| `REPO_FILE`    | `data.json`                                       |
| `APP_PASSWORD` | a string you'll remember — e.g. `pickles-99`      |

Trigger a redeploy so the function picks up the env vars (Deploys → Trigger deploy → Deploy site).

#### 4. Connect the app

Open your deployed site → click **Sync** in the header → paste your `APP_PASSWORD` → **Save & test**.

On the first save, the cloud file is created automatically. From then on every change auto-pushes about 1.5s after you stop typing.

### How it works day-to-day

| What you do        | What happens                                        |
| ------------------ | --------------------------------------------------- |
| Add / edit / delete an entry | Saves locally + auto-pushes to GitHub       |
| Open the app on another device | Boot-merges cloud into local, shows toast  |
| Leave the app open on two devices | A 30s background poll keeps both in sync  |
| Switch back to a tab | A pull runs immediately, so another device's edits appear right away |
| Click **Pull**     | Merges cloud into local (never replaces)            |
| Click **Push**     | Pushes local state, merging first if needed         |

The button text "synced 2m ago" in the header shows the freshness of the last sync.

### Conflict handling — automatic, no data loss

The function sends `sha` on every PUT. If the cloud file changed since your last read, GitHub returns 409. Instead of deadlocking, the app **pulls the cloud state, merges it with your local state, and pushes the merged result back** — all automatically. Merging never discards data:

- **Entries** — unioned by id; for the same entry the newest version wins.
- **Deletions** — recorded as tombstones, so a deleted entry never resurrects from another device's older copy (undo still restores it).
- **Settings** — scalar values (budget, currency) come from the newer side; custom categories, recurring rules, and balance checkpoints are unioned.
- **Resets** — treated as a deliberate "start over"; the newer reset wins on every device.

You no longer have to think about conflicts — both devices converge automatically within ~30s.

### Security caveats (be honest)

- The `APP_PASSWORD` you pick is stored in your browser's `localStorage` and sent on every call. Anyone with DevTools on your device can read it. **This is the same risk as saving any other password in a browser** — keep your device trusted.
- The GitHub PAT **only ever exists inside the Netlify Function's environment**. It's never bundled, never logged, never returned to the browser.
- The PAT is scoped to one repo with read+write only. Revoke it any time from `github.com → Settings → Developer settings → Personal access tokens`.
- The data is private-to-you if your GitHub repo is private. Default Netlify deploys are public URLs — change site visibility in Netlify if you want it gated behind a password.

### Disconnecting

Sync modal → **Disconnect** wipes the app password + endpoint from this device. The cloud file stays; delete it manually from GitHub if you want it gone everywhere.

### Testing the function locally

```bash
npm i -g netlify-cli   # once
netlify dev            # in this folder
```

`netlify dev` runs the function at `http://localhost:8888/.netlify/functions/sync` and proxies your static site on the same port. Open the URL it prints and you can test Sync end-to-end without deploying.

---

## Editing the data shape

- **Categories?** `CATEGORIES` in `seed.js` *and* `CATEGORIES_OK` in `storage.js`
- **Methods?**    `METHODS` in `seed.js` *and* `METHODS_OK` in `storage.js`
- **Default budget?** `SEED_SETTINGS.monthlyBudget` in `seed.js`
- **Reset everything on this device?** Use the "Reset" link in the footer, or in DevTools: `__cents.state = resetToBlank(); __cents.render();`

## Privacy

- Without sync: 100% local — `localStorage` keyed `expense-tracker:v1`.
- With sync: a copy lives in your private GitHub repo. No third party ever touches it.

## License

Personal project — do whatever you like with it.
