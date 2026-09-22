# cents.

A calm, private expense tracker that runs right in your browser. No app store, no account, no sign-up — just type what you spent and see exactly where your money went.

![cents. dashboard](screenshots/dashboard-desktop.png)

## In plain English

**cents.** keeps everything on your device. By default nothing is uploaded anywhere — only if you *choose* to turn on sync does a copy leave your browser. It helps you set a monthly budget, see what's safe to spend today, track the balances on your accounts and gift cards, and never miss a recurring bill.

## What you can do

- **Log expenses just by typing** — e.g. `lidl groceries 4.47 revolut`. The app works out the amount, category, and payment method for you.
- **Keep a budget** — set a monthly target and see your spend, what's left, and a "safe to spend today" number at a glance.
- **Track balances** — bank accounts (AIB, Revolut) and gift cards (Tesco, Lidl, Aldi), reconciled against your real statements.
- **Never miss a bill** — rent, subscriptions, and paydays as recurring reminders, with one-tap marking done.
- **Undo anything** — every action can be undone, even after a reload.
- **Stay private** — the app opens locked (default PIN `100901`); on your phone you can unlock with fingerprint or Face ID instead.
- **Tesco Pay tab** — log your shifts (or photograph the roster and let it read them), and the app works out paid hours, Sunday pay, weekly gross, an Irish PAYE/USC/PRSI/pension estimate, and tracks the tax on each payslip. The home screen shows this month's hours, anticipated pay and received pay at a glance. **Export CSV** writes the whole table out in the workbook's own columns — the shifts, then the tax table below them — and **Import CSV** reads one back (dates, times, the special flag, notes, payslip tax and week numbers; hours, pay and the estimate are recalculated). Each week's number is the sheet's own count and can be edited on the week card.
- **Daily reminder** — a nudge to upload your transactions at a time you choose (default 20:00). While the app is open it's a notification; on **mobile** (installed PWA or phone browser) with **Cloud sync on** you can also enable **push**, which reaches you even when cents. is fully closed.

## Getting started

1. **Open the app** — run it locally (below) or open your deployed version.
2. **Unlock** — the default PIN is `100901`. Change it in **☰ → Privacy & security**.
3. **Set a budget** — the monthly budget box is right on the dashboard.
4. **Log something** — hit **Add** and type something like `coffee 3.50`.

## Privacy & optional sync

- **By default, everything stays on your device.** Your data lives in your browser's local storage; nothing is sent anywhere.
- **Optional cloud sync** — want the same data on your phone and laptop? Sync keeps a copy in a **private GitHub repo that only you control**. Your login token never touches the browser. Set it up in **☰ → Cloud sync**.

## Self-hosting notes (Netlify)

The optional sync and push features need a few environment variables in Netlify (Site configuration → Environment variables):

| Variable | What it's for |
|---|---|
| `APP_PASSWORD` | The password you type under **☰ → Cloud sync** (at least 8 characters). It gates sync *and* the push subscription store. |
| `GITHUB_TOKEN` | Fine-grained GitHub token with **contents: read and write**, for the data repo only. It never leaves the function. |
| `REPO_OWNER` | Owner of the data repo — your GitHub username or org. |
| `REPO_NAME` | The **private** repo the synced copy lives in. |
| `REPO_BRANCH` | Optional — branch the data file lives on. Default `main`. |
| `REPO_FILE` | Optional — path of the data file in that repo. Default `data.json`. |
| `VAPID_PUBLIC_KEY` | Web Push keys for the closed-app daily reminder. Both are required before the app will offer push — generate them once with `node scripts/generate-vapid-keys.mjs`. |
| `VAPID_PRIVATE_KEY` | Keep it secret; it never ships in the page. |
| `VAPID_SUBJECT` | Optional — contact string for the push service, e.g. `mailto:you@example.com`. |

The build also pins `NODE_VERSION = "22"` in `netlify.toml` — the guard scripts import the app's browser modules as ES modules, and Node 18 would parse them as CommonJS and fail the deploy.

Push subscriptions live in Netlify Blobs; the scheduled function that dispatches reminders runs every 15 minutes and fires each device at its chosen local time.

## Run it locally

Browsers block the file when opened by double-click, so run a tiny local server instead. From this folder:

```
./serve.sh
```

or any simple static server, e.g. `python -m http.server 8080` — then open the address it prints.

## Checks

Nine pure-Node guardrails run in the Netlify build command and **block the deploy when one fails**. `run-guards.mjs` runs all nine in build order — that single command is also what CI calls:

```
node scripts/run-guards.mjs            # all nine, in build order
node scripts/check-netlify-config.mjs  # netlify.toml's shape, its scheduled functions, the CI wiring, the env-var docs below
node scripts/check-sw-shell.mjs        # every offline-shell entry exists on disk
node scripts/check-image-hygiene.mjs   # the roster photo can never be persisted
node scripts/check-csp-hashes.mjs      # every inline boot script is hashed in the CSP
node scripts/check-freshness.mjs       # every app asset revalidates; no 404 rule can hit an app file
node scripts/test-integrity.mjs        # storage/merge cannot lose, corrupt or resurrect data
node scripts/test-tesco.mjs            # the pay/tax engine still matches the workbook's figures
node scripts/test-sync.mjs             # the sync contract still round-trips all state
node scripts/test-reminder-push.mjs    # the push payload still matches the RFC 8291 vector
```

`.github/workflows/guards.yml` runs the same suite on every push, on the same Node version the deploy uses. That matters for one specific reason: Netlify parses `netlify.toml` *before* it runs the build command, so a broken config can never be reported by a predeploy guard — the only signal is a failed deploy. CI is the earliest place it can be caught.

If you edit one of the inline scripts in `index.html`, re-hash it in the CSP in `netlify.toml`: `check-csp-hashes` prints the exact hash to paste, and the browser would otherwise refuse to run that script in production only (no CSP is sent locally).

## Built with

Hand-written **HTML / CSS / JavaScript** (no framework), a **service worker** so the app works offline after you first visit, and **Netlify** for hosting.