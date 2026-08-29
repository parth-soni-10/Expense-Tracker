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

## Getting started

1. **Open the app** — run it locally (below) or open your deployed version.
2. **Unlock** — the default PIN is `100901`. Change it in **☰ → Privacy & security**.
3. **Set a budget** — the monthly budget box is right on the dashboard.
4. **Log something** — hit **Add** and type something like `coffee 3.50`.

## Privacy & optional sync

- **By default, everything stays on your device.** Your data lives in your browser's local storage; nothing is sent anywhere.
- **Optional cloud sync** — want the same data on your phone and laptop? Sync keeps a copy in a **private GitHub repo that only you control**. Your login token never touches the browser. Set it up in **☰ → Cloud sync**.

## Run it locally

Browsers block the file when opened by double-click, so run a tiny local server instead. From this folder:

```
./serve.sh
```

or any simple static server, e.g. `python -m http.server 8080` — then open the address it prints.

## Built with

Hand-written **HTML / CSS / JavaScript** (no framework), a **service worker** so the app works offline after you first visit, and **Netlify** for hosting.