/* ============================================================
   Structural defaults — categories, payment methods, settings.
   Entries start empty; populate via the app or import a JSON file.
   ============================================================ */

export const CATEGORIES = [
  { id: 'gro',     label: 'Groceries' },
  { id: 'travel',  label: 'Travel' },
  { id: 'misc',    label: 'Misc' },
  { id: 'rent',    label: 'Rent' },
  { id: 'GC',      label: 'Gift cards' },
];

export const METHODS = [
  { id: 'AIB',     label: 'AIB bank' },
  { id: 'Revolut', label: 'Revolut Main' },
  { id: 'RS',      label: 'Revolut Savings' },
  { id: 'TG',      label: 'TG · Tesco' },
  { id: 'LG',      label: 'LG · Lidl' },
  { id: 'AG',      label: 'AG · Aldi' },
  { id: 'Cash',    label: 'Cash on hand' },
];

/* The app's tabs, in canonical order. One source of truth: app.js routes the
   screen with it and storage.js validates settings.enabledTabs against it. */
// The cadences a recurring schedule may declare. One list for the device's
// validator (storage.js) and for the cloud's (netlify/functions/sync.mjs): a
// schedule the app offers to create must never be one the server refuses on
// the way back down, and a list that exists twice is a list that drifts.
export const RECURRING_FREQUENCIES = ['daily', 'weekly', 'fortnightly', 'monthly', 'yearly'];

export const TABS = ['dashboard', 'add', 'history', 'balances', 'tesco', 'insights'];

// Which tabs an admin can hide from a user. The dashboard is deliberately not
// in this list: it is the landing page and the app's only hub, so hiding it
// would leave nowhere to land and no way back for the person it was hidden
// from (the Admin panel itself lives in the menu, not in a tab).
export const HIDEABLE_TABS = ['add', 'history', 'balances', 'tesco', 'insights'];

export const SEED_SETTINGS = {
  monthlyBudget: 1100,
  currency: '€',
  // Tabs this profile may open. Admin-controlled (see the Admin panel); a
  // document written before this existed simply shows every tab.
  enabledTabs: [...TABS],
  // Euro amount of Tesco paper vouchers on hand - never part of any balance.
  tescoVouchers: 0,
  // Cash-on-hand ledger: `cashBase` is the starting cash balance and cash
  // entries (method 'Cash') move it each save. `coins` holds the physical
  // denomination breakdown; `coinsManual` is false once a cash entry has auto-
  // redistributed the breakdown to the fewest-coin combination of the balance.
  cashBase: 0,
  coinsManual: true,
  // Per-category monthly targets, keyed by category id. Optional: a category
  // without a target is simply not constrained. Spending over a target turns
  // the category's bar and callout red.
  categoryBudgets: {},
  // Historical balance checkpoints. Each account is keyed to an array of
  // { date, balance } records, where balance is the end-of-day actual balance.
  balanceCheckpoints: {},
};
