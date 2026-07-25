/* ============================================================
   Seed data — shaped like Expense.xlsx
   Categories: GC, gro, misc, rent, travel
   Methods:    AIB, Revolut, AG, LG, TG
   Types:      expense, credit
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
  { id: 'TG',      label: 'TG · Tesco' },
  { id: 'LG',      label: 'LG · Lidl' },
  { id: 'AG',      label: 'AG · Aldi' },
];

const iso = (y, m, d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

export const SEED_ENTRIES = [
  /* ===== APRIL ===== */
  { date: iso(2026,4,4),  type:'expense', category:'travel', details:'Leap Card top-up', amount:47.00, method:'AIB', note:'' },
  { date: iso(2026,4,5),  type:'expense', category:'gro',    details:'Tesco',            amount:38.42, method:'AIB', note:'' },
  { date: iso(2026,4,7),  type:'credit',  category:'GC',     details:'Top-up TG',        amount:50.00, method:'TG',  note:'topped up at till' },
  { date: iso(2026,4,8),  type:'expense', category:'gro',    details:'Tesco',            amount:18.75, method:'TG',  note:'' },
  { date: iso(2026,4,10), type:'expense', category:'rent',   details:'Rent',             amount:850.00,method:'AIB', note:'' },
  { date: iso(2026,4,12), type:'expense', category:'misc',   details:'Pharmacy',         amount:9.80,  method:'AIB', note:'' },
  { date: iso(2026,4,14), type:'expense', category:'misc',   details:'Coffee',           amount:4.20,  method:'Revolut', note:'' },
  { date: iso(2026,4,15), type:'expense', category:'gro',    details:'Aldi',             amount:24.10, method:'AG',  note:'' },
  { date: iso(2026,4,18), type:'expense', category:'travel', details:'Bus',              amount:5.50,  method:'AIB', note:'' },
  { date: iso(2026,4,19), type:'expense', category:'gro',    details:'Lidl',             amount:21.95, method:'LG',  note:'' },
  { date: iso(2026,4,21), type:'expense', category:'misc',   details:'Bookshop',         amount:14.20, method:'AIB', note:'' },
  { date: iso(2026,4,23), type:'expense', category:'gro',    details:'Tesco',            amount:33.50, method:'AIB', note:'' },
  { date: iso(2026,4,25), type:'expense', category:'travel', details:'Train',            amount:18.40, method:'AIB', note:'' },
  { date: iso(2026,4,27), type:'expense', category:'misc',   details:'Coffee',           amount:3.80,  method:'Revolut', note:'' },

  /* ===== MAY ===== */
  { date: iso(2026,5,1),  type:'expense', category:'rent',   details:'Rent',             amount:850.00,method:'AIB', note:'' },
  { date: iso(2026,5,3),  type:'expense', category:'gro',    details:'Tesco',            amount:0.02,  method:'TG',  note:'rounding test' },
  { date: iso(2026,5,5),  type:'expense', category:'travel', details:'Leap Card',        amount:47.00, method:'AIB', note:'' },
  { date: iso(2026,5,7),  type:'credit',  category:'GC',     details:'Top-up LG',        amount:50.00, method:'LG',  note:'' },
  { date: iso(2026,5,8),  type:'expense', category:'gro',    details:'Lidl',             amount:22.40, method:'LG',  note:'' },
  { date: iso(2026,5,10), type:'expense', category:'gro',    details:'Aldi',             amount:18.90, method:'AG',  note:'' },
  { date: iso(2026,5,12), type:'expense', category:'misc',   details:'Pharmacy',         amount:11.40, method:'AIB', note:'' },
  { date: iso(2026,5,14), type:'expense', category:'gro',    details:'Tesco',            amount:27.30, method:'AIB', note:'' },
  { date: iso(2026,5,17), type:'expense', category:'travel', details:'Bus',              amount:5.50,  method:'AIB', note:'' },
  { date: iso(2026,5,18), type:'expense', category:'misc',   details:'Coffee',           amount:4.20,  method:'Revolut', note:'' },
  { date: iso(2026,5,20), type:'expense', category:'gro',    details:'Tesco',            amount:31.80, method:'AIB', note:'' },
  { date: iso(2026,5,22), type:'expense', category:'misc',   details:'Cinema',           amount:13.50, method:'AIB', note:'' },
  { date: iso(2026,5,25), type:'expense', category:'travel', details:'Train',            amount:18.40, method:'AIB', note:'' },
  { date: iso(2026,5,28), type:'expense', category:'gro',    details:'Aldi',             amount:19.20, method:'AG',  note:'' },

  /* ===== JUNE ===== */
  { date: iso(2026,6,1),  type:'expense', category:'rent',   details:'Rent',             amount:850.00,method:'AIB', note:'' },
  { date: iso(2026,6,1),  type:'expense', category:'gro',    details:'Tesco',            amount:8.99,  method:'TG',  note:'' },
  { date: iso(2026,6,4),  type:'expense', category:'travel', details:'Leap Card',        amount:50.00, method:'AIB', note:'' },
  { date: iso(2026,6,6),  type:'credit',  category:'GC',     details:'Top-up TG',        amount:50.00, method:'TG',  note:'' },
  { date: iso(2026,6,9),  type:'expense', category:'gro',    details:'Tesco',            amount:24.50, method:'TG',  note:'' },
  { date: iso(2026,6,11), type:'expense', category:'gro',    details:'Aldi',             amount:22.10, method:'AG',  note:'' },
  { date: iso(2026,6,13), type:'expense', category:'misc',   details:'Coffee',           amount:4.20,  method:'Revolut', note:'' },
  { date: iso(2026,6,15), type:'expense', category:'travel', details:'Bus',              amount:5.50,  method:'AIB', note:'' },
  { date: iso(2026,6,18), type:'expense', category:'gro',    details:'Tesco',            amount:18.95, method:'AIB', note:'' },
  { date: iso(2026,6,20), type:'expense', category:'misc',   details:'Haircut',          amount:30.00, method:'AIB', note:'' },
  { date: iso(2026,6,22), type:'expense', category:'gro',    details:'Lidl',             amount:21.40, method:'LG',  note:'' },
  { date: iso(2026,6,24), type:'expense', category:'misc',   details:'Book',             amount:11.99, method:'AIB', note:'' },
  { date: iso(2026,6,26), type:'expense', category:'misc',   details:'Coffee',           amount:4.20,  method:'Revolut', note:'' },
  { date: iso(2026,6,27), type:'expense', category:'gro',    details:'Tesco',            amount:22.30, method:'AIB', note:'' },
  { date: iso(2026,6,28), type:'expense', category:'travel', details:'Bus',              amount:5.50,  method:'AIB', note:'' },
  { date: iso(2026,6,29), type:'credit',  category:'GC',     details:'Top-up TG',        amount:50.00, method:'TG',  note:'' },
  { date: iso(2026,6,30), type:'expense', category:'gro',    details:'Lidl',             amount:18.10, method:'LG',  note:'' },

  /* ===== JULY (in progress) ===== */
  { date: iso(2026,7,1),  type:'expense', category:'rent',   details:'Rent',             amount:850.00,method:'AIB', note:'' },
  { date: iso(2026,7,2),  type:'expense', category:'gro',    details:'Tesco',            amount:27.54, method:'AIB', note:'' },
  { date: iso(2026,7,3),  type:'expense', category:'travel', details:'Leap Card top-up', amount:47.00, method:'AIB', note:'' },
  { date: iso(2026,7,4),  type:'expense', category:'misc',   details:'Moher',            amount:14.55, method:'Revolut', note:'' },
];

export const SEED_SETTINGS = {
  monthlyBudget: 1100,
  currency: '€',
  seeded: true,
};
