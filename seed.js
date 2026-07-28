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
  { id: 'Revolut', label: 'Revolut' },
  { id: 'RS',      label: 'RS · Revolut Savings' },
  { id: 'TG',      label: 'TG · Tesco' },
  { id: 'LG',      label: 'LG · Lidl' },
  { id: 'AG',      label: 'AG · Aldi' },
];

export const SEED_SETTINGS = {
  monthlyBudget: 1100,
  currency: '€',
};
