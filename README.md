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
- **Tesco Pay tab** — log your shifts, or point the camera at the roster and let it read them (**Scan from camera** on the Add-shift card, or **Use camera** beside *Choose roster photo*: one shot, or a **live read** that keeps taking frames until your shifts are found). The photo is decoded to a canvas, read and dropped — nothing is written to storage, cache or state — and the app works out paid hours, Sunday pay, weekly gross, an Irish PAYE/USC/PRSI/pension estimate, and tracks the tax on each payslip. The home screen shows this month's hours, anticipated pay and received pay at a glance. **Export CSV** writes the whole table out in the workbook's own columns — the shifts, then the tax table below them — and **Import CSV** reads one back (dates, times, the special flag, notes, payslip tax and week numbers; hours, pay and the estimate are recalculated). Each week's number is the sheet's own count and can be edited on the week card.
- **Daily reminder** — a nudge to upload your transactions at a time you choose (default 20:00). While the app is open it's a notification; on **mobile** (installed PWA or phone browser) with **Cloud sync on** you can also enable **push**, which reaches you even when cents. is fully closed.

## Getting started

1. **Open the app** — run it locally (below) or open your deployed version.
2. **Unlock** — the default PIN is `100901`. Change it in **☰ → Privacy & security**.
3. **Set a budget** — the monthly budget box is right on the dashboard.
4. **Log something** — hit **Add** and type something like `coffee 3.50`.

## Privacy & optional sync

- **By default, everything stays on your device.** Your data lives in your browser's local storage; nothing is sent anywhere.
- **Optional cloud sync** — want the same data on your phone and laptop? Sync holds the account's document in **Netlify Blobs** and mirrors it into a **private GitHub repo that only you control** — a readable backup, and the way back if the site's stored data is ever lost. Your login token never touches the browser. Set it up in **☰ → Cloud sync**.

### Profiles — sharing cents. with friends

cents. is built to be shared: you keep one deployed site, and everyone who uses it gets their **own account inside it** — their own entries, balances, budget, PIN and daily reminder — signed in on **their own phone**, in their own browser, with their own password. Nobody sees anyone else's spending, and switching accounts never mixes them up.

**☰ → Switch profile** (or the chip in the header, or the “Who's tracking?” screen) moves between accounts. A switch happens in place — the page does not reload — and it always lands on a prompt: pick the person, then that person's PIN, so nobody is ever asked for a PIN before an identity. The account you were using keeps its own copy in the browser's storage, untouched.

Every profile also gets a **picture**: pick one from **☰ → Profile picture** (or **Change picture** on the “Who's tracking?” screen) — eighteen icons, or keep the initial. It is drawn as an inline icon on a colour derived from the profile, so there are no image files to download and the colour stays put when the picture changes. Like the name, the picture lives on the device and does not sync — the admin can set it for anyone from the Admin panel.

Each account keeps its own document in the cloud — private, in Netlify Blobs, mirrored to `data-<name>.json` — and needs **its own Netlify variable** (`Sam` → `APP_PASSWORD_SAM`); an account with no variable still works, but locally only — it is never handed the default password, which is what keeps accounts from reading each other. The Admin panel names the exact variable to create.

A **setup link** (**☰ → Cloud sync → Create link**) carries the account with it: send it to your friend and, opened on their phone, it offers to add that account with the same name and password instead of asking them to retype either. That is how someone gets their own copy on their own device.

A profile's own space is device-local and never syncs itself. Deleting one removes that account's data on that device — a copy already in the cloud is left alone.

### Admin panel — you, the owner

The **owner** account (`Personal`, the one whose password is `APP_PASSWORD`) is the admin: it is the only account that can create, rename or delete the others. Two ways in, both after you unlock: the **Admin** pill in the header, and **☰ → Admin** — the first row of the menu, tinted so it stands out (`People & tab access`). Everyone else's menu says *Switch profile* there instead, and has no header button. Everyone else sees the picker, which for them is only a way to switch. The owner account cannot be deleted — it holds the site password and the base cloud file, so removing it would leave nobody able to open the panel.

**Invite** is how someone gets their account onto their own phone. Tapping it mints a **single-use, 30-day link** for that account — it carries their own password (which you never have to know or type: it lives in Netlify as `APP_PASSWORD_<NAME>`) and the tabs you currently allow them, so the account arrives already configured. Send it to them directly: while it is unspent, whoever holds it can read and write that account's data. Opening it on their phone adds the account, switches to it and starts syncing their own copy — your device keeps only the account itself, never their entries.

Each person's card also has a **Picture** button, so you can give everyone a face without passing a phone around.

Under each person the panel shows a row of **tab chips**: switch one off and they no longer see the tab — not in the nav, not in the menu, and not by typing the URL (a hidden route lands back on the dashboard, so a bookmark is not a way around it). The entry points on the dashboard go with it: hide *Add* and **New entry** disappears, hide *Balances* and the top-up and **Manage** links do, hide *Tesco* and the pay widget and payday tracker do.

Two things worth knowing:

- **A hidden tab is a UI policy, not a lock.** Anyone holding a phone reads everything on it. Hiding a tab keeps the app tidy for the person using it; it does not keep a determined one out of anything.
- **The dashboard always stays visible.** It is the landing page and the only screen that reaches the others, so it is deliberately not in the toggles.

The setting is stored in *that person's own document*, which means it travels to every device they sign in on the next time that account syncs — so a restriction set here sticks after they switch phones. Switching a tab off also writes it straight into that account's cloud file (through `profiles-admin`, authorised by your own password), so it lands without waiting for them to open the app; only that one setting is written, never their entries. If the account has not synced yet there is no document to carry it, and the app says so — send a fresh invite, which carries the tabs with it.

## Self-hosting notes (Netlify)

The optional sync and push features need a few environment variables in Netlify (Site configuration → Environment variables):

| Variable | What it's for |
|---|---|
| `APP_PASSWORD` | The password you type under **☰ → Cloud sync** (at least 8 characters). It gates sync *and* the push subscription store, for the default **Personal** profile. |
| `APP_PASSWORD_<NAME>` | Optional — one per person you share with (**☰ → Admin → Add profile**). `Sam` becomes `APP_PASSWORD_SAM`; the app names the exact variable in the Admin panel. An account with no variable stays local: it is never granted the default password, so the accounts stay isolated from each other. |
| `GITHUB_TOKEN` | Fine-grained GitHub token with **contents: read and write**, for the data repo only. It never leaves the function. |
| `REPO_OWNER` | Owner of the data repo — your GitHub username or org. |
| `REPO_NAME` | The **private** repo each account's copy is mirrored into. |
| `REPO_BRANCH` | Optional — branch the data file lives on. Default `main`. |
| `REPO_FILE` | Optional — path of the mirrored data file in that repo. Default `data.json`. |
| `VAPID_PUBLIC_KEY` | Web Push keys for the closed-app daily reminder. Both are required before the app will offer push — generate them once with `node scripts/generate-vapid-keys.mjs`. |
| `VAPID_PRIVATE_KEY` | Keep it secret; it never ships in the page. |
| `VAPID_SUBJECT` | Optional — contact string for the push service, e.g. `mailto:you@example.com`. |

The build also pins `NODE_VERSION = "22"` in `netlify.toml` — the guard scripts import the app's browser modules as ES modules, and Node 18 would parse them as CommonJS and fail the deploy.

Each account's synced document lives in Netlify Blobs, with the GitHub file written alongside it as a mirror on every save. The first read of an account that is not there yet is served *from* the mirror and then seeds Blobs, so an existing site upgrades without losing anything; after that the mirror is only ever written. Push subscriptions live in Blobs too.

## Run it locally

Browsers block the file when opened by double-click, so run a tiny local server instead. From this folder:

```
./serve.sh
```

or any simple static server, e.g. `python -m http.server 8080` — then open the address it prints.

## Checks

Twelve pure-Node guardrails run in the Netlify build command and **block the deploy when one fails**. `run-guards.mjs` runs all twelve in build order — that single command is also what CI calls:

```
node scripts/run-guards.mjs            # all twelve, in build order
node scripts/check-netlify-config.mjs  # netlify.toml's shape, its scheduled functions, the CI wiring, the env-var docs below
node scripts/check-sw-shell.mjs        # every offline-shell entry exists on disk
node scripts/check-image-hygiene.mjs   # the roster photo can never be persisted
node scripts/check-csp-hashes.mjs      # every inline boot script is hashed in the CSP
node scripts/check-freshness.mjs       # every app asset revalidates; no 404 rule can hit an app file
node scripts/check-icon-refs.mjs       # every icon lookup resolves (a miss renders an empty element, silently)
node scripts/test-integrity.mjs        # storage/merge cannot lose, corrupt or resurrect data
node scripts/test-profiles.mjs         # profiles stay isolated, and their cloud credentials never fall back
node scripts/test-tesco.mjs            # the pay/tax engine still matches the workbook's figures
node scripts/test-sync.mjs             # the sync contract still round-trips all state
node scripts/test-cloud.mjs            # Blobs is the primary, GitHub the mirror, and the version token decides conflicts
node scripts/test-reminder-push.mjs    # the push payload still matches the RFC 8291 vector
```

`.github/workflows/guards.yml` runs the same suite on every push, on the same Node version the deploy uses. That matters for one specific reason: Netlify parses `netlify.toml` *before* it runs the build command, so a broken config can never be reported by a predeploy guard — the only signal is a failed deploy. CI is the earliest place it can be caught.

If you edit one of the inline scripts in `index.html`, re-hash it in the CSP in `netlify.toml`: `check-csp-hashes` prints the exact hash to paste, and the browser would otherwise refuse to run that script in production only (no CSP is sent locally).

## Built with

Hand-written **HTML / CSS / JavaScript** (no framework), a **service worker** so the app works offline after you first visit, and **Netlify** for hosting.