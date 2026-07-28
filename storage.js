/* ============================================================
   Storage layer — localStorage CRUD + JSON export/import
   Strict validation: NaN amounts and empty dates are filtered.
   UUID fallback for older browsers / file:// previews.
   ============================================================ */
import { SEED_SETTINGS } from './seed.js';

const KEY = 'expense-tracker:v1';

export const uid = () =>
  (globalThis.crypto?.randomUUID?.())
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);

const CATEGORIES_OK = new Set(['gro','travel','misc','rent','GC']);
const METHODS_OK    = new Set(['AIB','Revolut','RS','TG','LG','AG']);
const TYPES_OK      = new Set(['expense','credit']);

function validateEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const amt = Number(e.amount);
  if (!Number.isFinite(amt) || amt < 0 || amt > 1_000_000) return null;
  if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return null;
  if (!TYPES_OK.has(e.type)) return null;
  if (!CATEGORIES_OK.has(e.category)) return null;
  // method: must match the configured list (forward-compat kept by editing seed.js)
  if (!METHODS_OK.has(e.method)) return null;
  // Base fields + pass through any extra keys (e.g. transferId, settled) so
  // cloud sync and import don't silently strip metadata added by newer clients.
  const base = {
    id: typeof e.id === 'string' && e.id ? e.id : uid(),
    date: e.date,
    type: e.type,
    category: e.category,
    details: typeof e.details === 'string' ? e.details : '',
    amount: +amt.toFixed(2),
    method: e.method,
    note: typeof e.note === 'string' ? e.note : '',
  };
  // Preserve transfer metadata if present
  if (typeof e.transferId === 'string') base.transferId = e.transferId;
  if (typeof e.settled === 'boolean') base.settled = e.settled;
  return base;
}

function defaultState() {
  return {
    entries: [],
    settings: { ...SEED_SETTINGS },
    schemaVersion: 1,
  };
}

export function validateState(s) {
  if (!s || !Array.isArray(s.entries)) return defaultState();
  const out = { ...s };
  out.entries = s.entries.map(validateEntry).filter(Boolean);
  out.settings = {
    ...SEED_SETTINGS,
    ...(s.settings && typeof s.settings === 'object' ? s.settings : {}),
    monthlyBudget: Number.isFinite(+s.settings?.monthlyBudget) ? +s.settings.monthlyBudget : SEED_SETTINGS.monthlyBudget,
  };
  out.schemaVersion = 1;
  return out;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return validateState(parsed);
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Failed to save state:', e); }
}

export function resetToBlank() {
  const fresh = defaultState();
  saveState(fresh);
  return fresh;
}

export function exportJSON(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `expenses-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

