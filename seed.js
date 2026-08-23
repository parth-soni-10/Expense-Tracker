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
];

export const SEED_SETTINGS = {
  monthlyBudget: 1100,
  currency: '€',
  // Euro amount of Tesco paper vouchers on hand - never part of any balance.
  tescoVouchers: 0,
  // Per-category monthly targets, keyed by category id. Optional: a category
  // without a target is simply not constrained. Spending over a target turns
  // the category's bar and callout red.
  categoryBudgets: {},
  // Historical balance checkpoints. Each account is keyed to an array of
  // { date, balance } records, where balance is the end-of-day actual balance.
  balanceCheckpoints: {},
};
