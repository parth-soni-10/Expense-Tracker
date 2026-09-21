/* ============================================================
   Storage layer — localStorage CRUD + JSON export/import
   Strict validation: NaN amounts and empty dates are filtered.
   UUID fallback for older browsers / file:// previews.
   ============================================================ */
import { SEED_SETTINGS } from './seed.js';
import { getPrivacyPin, setPrivacyPin } from './settings.js';

const KEY = () => 'expense-tracker:v1';

// One-time reverse migration for the removed multi-profile feature: while
// profiles existed, data lived under cents:p/<id>/<base>. On first load
// without profiles, the primary profile's data (the largest state — the main
// user) is copied back to the original global keys. Any other profiles'
// keys are left in place as device-local copies.
(function migrateProfilesBack() {
  try {
    if (localStorage.getItem('cents:profiles-migrated')) return;
    const states = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('cents:p/') && k.endsWith('/state')) states.push(k);
    }
    if (states.length > 0) {
      const LEGACY = {
        state: 'expense-tracker:v1', privacy: 'cents:privacySettings', bio: 'cents:biometric',
        sync: 'cents:syncSettings', undo: 'cents-undo-journal', alerts: 'cents-dismissed-alerts',
        reminder: 'cents:reminder',
      };
      let primary = states[0], bestSize = -1;
      for (const k of states) {
        const size = (localStorage.getItem(k) || '').length;
        if (size > bestSize) { bestSize = size; primary = k; }
      }
      const id = primary.split('/')[2];
      for (const base of Object.keys(LEGACY)) {
        const v = localStorage.getItem(`cents:p/${id}/${base}`);
        if (v != null) localStorage.setItem(LEGACY[base], v);
      }
    }
    localStorage.setItem('cents:profiles-migrated', '1');
  } catch { /* storage unavailable; namespaced keys remain as fallback */ }
})();

export const uid = () =>
  (globalThis.crypto?.randomUUID?.())
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);

const BASE_CATEGORIES = ['gro', 'travel', 'misc', 'rent', 'GC'];
const CATEGORIES_OK = new Set(BASE_CATEGORIES);
const METHODS_OK    = new Set(['AIB','Revolut','RS','TG','LG','AG','Cash']);
const TYPES_OK      = new Set(['expense', 'credit', 'transfer', 'note']);
// Recurring transfers need two linked legs and are not represented by the
// recurring editor. Keeping only single-leg recurring financial entries avoids
// creating orphaned transfer records.
const FINANCIAL_TYPES = new Set(['expense', 'credit']);
// Keep enough immutable versions to cover long-lived reconciliation history
// without allowing an accidental edit loop to grow local state forever.
const MAX_MUTATION_HISTORY = 1000;

/** Let validateEntry accept custom-category ids that the user added at runtime. */
export function updateAllowedCategories(ids) {
  CATEGORIES_OK.clear();
  for (const id of BASE_CATEGORIES) CATEGORIES_OK.add(id);
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && id) CATEGORIES_OK.add(id);
  }
}

function validateEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const amt = Number(e.amount);
  if (!Number.isFinite(amt) || amt < 0 || amt > 1_000_000) return null;
  if (typeof e.date !== 'string' || !isValidCheckpointDate(e.date)) return null;
  if (!TYPES_OK.has(e.type)) return null;
  if (!CATEGORIES_OK.has(e.category)) return null;
  if (e.type === 'note' && amt !== 0) return null;
  // Never silently round imported money: locally stored financial amounts are
  // normalized to cents, so values with extra precision are malformed input.
  if (Math.round(amt * 100) / 100 !== amt) return null;
  // method: must match the configured list (forward-compat kept by editing seed.js)
  if (!METHODS_OK.has(e.method)) return null;
  // Base fields + pass through any extra keys (e.g. transferId) so
  // cloud sync and import don't silently strip metadata added by newer clients.
  const id = typeof e.id === 'string' && e.id ? e.id : uid();
  const details = typeof e.details === 'string' ? e.details : '';
  const note = typeof e.note === 'string' ? e.note : '';
  if (id.length > 200 || details.length > 5000 || note.length > 10000) return null;
  const base = {
    id,
    date: e.date,
    type: e.type,
    category: e.category,
    details,
    amount: +amt.toFixed(2),
    method: e.method,
    note,
  };
  if (typeof e.createdAt === 'string' && e.createdAt.length <= 100
    && Number.isFinite(Date.parse(e.createdAt)) && Date.parse(e.createdAt) <= Date.now()) {
    base.createdAt = new Date(e.createdAt).toISOString();
  } else {
    // Legacy entries had no timestamp. Use the start of their date as a stable
    // ordering marker, so checkpoint logic treats them consistently as entries
    // that existed before any same-day reconciliation rather than silently
    // treating each load differently.
    base.createdAt = `${e.date}T00:00:00.000Z`;
  }
  const updatedAt = normalizeTimestamp(e.updatedAt);
  const createdTime = Date.parse(base.createdAt);
  const updatedTime = updatedAt ? Date.parse(updatedAt) : NaN;
  // Mutation timestamps are only meaningful when they are bounded, no earlier
  // than creation, and not from the future. Ignore malformed imported values
  // rather than allowing them to move reconciled balances unexpectedly.
  if (updatedAt && Number.isFinite(createdTime) && Number.isFinite(updatedTime)
    && updatedTime >= createdTime && updatedTime <= Date.now()) {
    base.updatedAt = updatedAt;
  }
  if (e.type === 'note' && typeof e.audioData === 'string'
    && /^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(e.audioData)
    && e.audioData.length <= 2_000_000) {
    base.audioData = e.audioData;
    if (typeof e.audioType === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(e.audioType)) base.audioType = e.audioType;
  }
  const history = Array.isArray(e.mutationHistory) ? e.mutationHistory : [];
  let historyValid = history.length <= MAX_MUTATION_HISTORY;
  let previousMutationTime = 0;
  const normalizedHistory = historyValid ? history.map(point => {
    const at = normalizeTimestamp(point?.at);
    const createdAt = normalizeTimestamp(point?.createdAt);
    const amount = Number(point?.amount);
    const date = typeof point?.date === 'string' && isValidCheckpointDate(point.date) ? point.date : null;
    const type = TYPES_OK.has(point?.type) ? point.type : null;
    const category = CATEGORIES_OK.has(point?.category) ? point.category : null;
    const method = METHODS_OK.has(point?.method) ? point.method : null;
    const mutationTime = at ? Date.parse(at) : NaN;
    const pointCreatedTime = createdAt ? Date.parse(createdAt) : NaN;
    const valid = !!point && typeof point === 'object' && !Array.isArray(point)
      && !!at && !!createdAt && !!date && !!type && !!category && !!method
      && Number.isFinite(amount) && Number.isFinite(pointCreatedTime) && Number.isFinite(mutationTime)
      && pointCreatedTime === createdTime
      && pointCreatedTime <= mutationTime
      && mutationTime <= Date.now()
      && mutationTime > previousMutationTime
      && !(type === 'note' && amount !== 0)
      && amount >= 0 && amount <= 1_000_000
      && Math.round(amount * 100) / 100 === amount;
    if (!valid) historyValid = false;
    previousMutationTime = mutationTime;
    return valid ? { at, createdAt, date, type, category, amount, method } : null;
  }).filter(Boolean) : [];
  // An invalid history point maps to null above; it must never reach the
  // array. Reading .at off a trailing null would throw, and loadState's catch
  // would then reset the ENTIRE stored state to defaults - one malformed
  // point (import, older client, sync merge) silently wiping the user's data.
  const latestHistoryTime = normalizedHistory.length
    ? Date.parse(normalizedHistory[normalizedHistory.length - 1].at)
    : NaN;
  const currentUpdatedTime = base.updatedAt ? Date.parse(base.updatedAt) : NaN;
  const historyMatchesCurrent = historyValid && normalizedHistory.length > 0
    && Number.isFinite(currentUpdatedTime) && currentUpdatedTime === latestHistoryTime
    && currentUpdatedTime >= createdTime;
  if (historyMatchesCurrent) {
    base.mutationHistory = normalizedHistory;
  } else {
    // A missing, partial, unordered, or detached history is unsafe: keeping
    // updatedAt without its corresponding previous versions could apply a
    // balance delta with no historical value to subtract. Keep the current
    // entry, but discard all unusable mutation metadata.
    delete base.updatedAt;
  }
  // Preserve transfer metadata if present
  if (typeof e.transferId === 'string' && e.transferId.length <= 200) base.transferId = e.transferId;
  if (typeof e.budgetExcluded === 'boolean') base.budgetExcluded = e.budgetExcluded;
  // Split-payment group marker - several single-method legs rendered as one row.
  if (typeof e.splitId === 'string' && e.splitId.length <= 200) base.splitId = e.splitId;
  return base;
}

export const BALANCE_METHOD_IDS = ['AIB', 'Revolut', 'RS', 'TG', 'LG', 'AG'];
const MAX_BALANCE = 1_000_000;
const CHECKPOINT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizePastTimestamp(value) {
  const normalized = normalizeTimestamp(value);
  return normalized && Date.parse(normalized) <= Date.now() ? normalized : null;
}

export function isValidCheckpointDate(date) {
  if (!CHECKPOINT_DATE_RE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day;
}

function normalizeBalanceCheckpoints(rawSettings) {
  const raw = rawSettings.balanceCheckpoints && typeof rawSettings.balanceCheckpoints === 'object'
    ? rawSettings.balanceCheckpoints
    : {};
  const legacyAccounts = rawSettings.accountOpenings && typeof rawSettings.accountOpenings === 'object'
    ? rawSettings.accountOpenings
    : {};
  const legacyGiftCards = rawSettings.giftCardOpenings && typeof rawSettings.giftCardOpenings === 'object'
    ? rawSettings.giftCardOpenings
    : {};
  const legacyOpening = Number.isFinite(+rawSettings.openingBalance) ? +rawSettings.openingBalance : null;
  const out = {};
  for (const id of BALANCE_METHOD_IDS) {
    const checkpoints = Array.isArray(raw[id])
      ? raw[id].filter(point => point && isValidCheckpointDate(point.date)
          && Number.isFinite(+point.balance) && Math.abs(+point.balance) <= MAX_BALANCE)
          .map(point => ({
            date: point.date,
            balance: Math.round(+point.balance * 100) / 100,
            ...(() => {
              const at = normalizePastTimestamp(point.at);
              return at ? { at } : {};
            })(),
          }))
      : [];
    // Keep one deterministic checkpoint per date so imported/synced state
    // cannot produce ambiguous historical balances.
    const byDate = new Map();
    for (const point of checkpoints) byDate.set(point.date, point);
    const normalized = [...byDate.values()];
    const accountLegacy = Object.prototype.hasOwnProperty.call(legacyAccounts, id) ? +legacyAccounts[id] : NaN;
    const giftCardLegacy = Object.prototype.hasOwnProperty.call(legacyGiftCards, id) ? +legacyGiftCards[id] : NaN;
    const legacy = Number.isFinite(accountLegacy)
      ? accountLegacy
      : Number.isFinite(giftCardLegacy)
        ? giftCardLegacy
        : id === 'AIB' ? legacyOpening : NaN;
    // Existing opening balances represented a baseline before all tracked
    // entries. Preserve that meaning even when newer dated checkpoints exist.
    if (Number.isFinite(legacy) && Math.abs(legacy) <= MAX_BALANCE && !normalized.some(point => point.date === '1970-01-01')) {
      normalized.push({ date: '1970-01-01', balance: Math.round(legacy * 100) / 100 });
    }
    out[id] = normalized.sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

function normalizeCustomCategories(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(BASE_CATEGORIES);
  return raw.reduce((out, category) => {
    if (!category || typeof category !== 'object') return out;
    const id = typeof category.id === 'string' ? category.id.trim() : '';
    const label = typeof category.label === 'string' ? category.label.trim() : '';
    if (!id || !label || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(id) || seen.has(id)) return out;
    seen.add(id);
    out.push({ id, label: label.slice(0, 80) });
    return out;
  }, []);
}

function normalizeTransferGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.transferId) continue;
    if (!groups.has(entry.transferId)) groups.set(entry.transferId, []);
    groups.get(entry.transferId).push(entry);
  }
  const validTransferIds = new Set();
  for (const [transferId, group] of groups) {
    const debit = group.find(entry => entry.type === 'expense');
    const credit = group.find(entry => entry.type === 'credit');
    if (group.length === 2 && debit && credit
      && debit.amount === credit.amount
      && debit.date === credit.date
      && debit.method !== credit.method) {
      validTransferIds.add(transferId);
    }
  }
  return entries.map(entry => {
    if (entry.transferId && validTransferIds.has(entry.transferId)) return entry;
    // Preserve malformed imported legs as ordinary visible transactions rather
    // than letting an orphaned/standalone transfer silently evade spending
    // totals or distort balance semantics.
    const { transferId, ...ordinary } = entry;
    return entry.type === 'transfer' ? { ...ordinary, type: 'expense' } : ordinary;
  });
}

function normalizeRecurring(raw, customCategoryIds) {
  if (!Array.isArray(raw)) return [];
  const allowedCategories = new Set([...BASE_CATEGORIES, ...customCategoryIds]);
  // Collapse content-identical entries: the recurring editor gives every
  // save a fresh id, so the same charge created twice (double-tap, or on two
  // synced devices) would otherwise survive as permanent duplicates. Two
  // entries are "the same charge" when every editor field matches.
  const seen = new Set();
  return raw.reduce((out, item) => {
    if (!item || typeof item !== 'object') return out;
    const amount = Number(item.amount);
    const day = Number(item.dayOfMonth);
    if (typeof item.id !== 'string' || !item.id || !FINANCIAL_TYPES.has(item.type)
      || !METHODS_OK.has(item.method) || !allowedCategories.has(item.category)
      || !isValidCheckpointDate(item.nextDate) || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000
      || !['weekly', 'monthly'].includes(item.frequency)) return out;
    const details = typeof item.details === 'string' ? item.details.trim().slice(0, 240) : '';
    const fingerprint = [item.type, details.toLowerCase(), +amount.toFixed(2), item.method, item.category, item.frequency, Number.isInteger(day) ? Math.min(31, Math.max(1, day)) : 1].join('|');
    if (seen.has(fingerprint)) return out;
    seen.add(fingerprint);
    out.push({
      id: item.id,
      type: item.type,
      details,
      amount: +amount.toFixed(2),
      method: item.method,
      category: item.category,
      frequency: item.frequency,
      dayOfMonth: Number.isInteger(day) ? Math.min(31, Math.max(1, day)) : 1,
      nextDate: item.nextDate,
      note: typeof item.note === 'string' ? item.note.slice(0, 500) : '',
    });
    return out;
  }, []);
}

function normalizeCoins(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = new Set(['50', '20', '10', '5', '2', '1', '0.5', '0.2', '0.1', '0.05']);
  return Object.fromEntries(Object.entries(raw)
    .filter(([key, value]) => allowed.has(key) && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1_000_000)
    .map(([key, value]) => [key, Number(value)]));
}

/** Tesco paper vouchers: the euro amount on hand, 0..1M with 2dp. */
function normalizeVoucherAmount(raw) {
  const n = Math.round(Number(raw) * 100) / 100;
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : 0;
}

/** Per-category budget targets: {categoryId: amount}. Unknown category ids
 *  (deleted custom categories) are dropped; amounts are clamped like the
 *  monthly budget. */
function normalizeCategoryBudgets(raw, validIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = new Set(validIds);
  return Object.fromEntries(Object.entries(raw)
    .filter(([key, value]) => allowed.has(key) && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1_000_000)
    .map(([key, value]) => [key, Math.round(Number(value) * 100) / 100]));
}

function defaultState() {
  return {
    entries: [],
    settings: {
      ...SEED_SETTINGS,
      balanceCheckpoints: Object.fromEntries(BALANCE_METHOD_IDS.map(id => [id, []])),
    },
    schemaVersion: 2,
  };
}

export function validateState(s) {
  if (!s || !Array.isArray(s.entries)) return defaultState();
  const out = { ...s };
  const lastLocalChangeAt = normalizePastTimestamp(s.lastLocalChangeAt);
  const localResetAt = normalizePastTimestamp(s.localResetAt);
  if (lastLocalChangeAt) out.lastLocalChangeAt = lastLocalChangeAt;
  else delete out.lastLocalChangeAt;
  if (localResetAt) out.localResetAt = localResetAt;
  else delete out.localResetAt;
  const rawSettings = s.settings && typeof s.settings === 'object' && !Array.isArray(s.settings) ? s.settings : {};
  const customCategories = normalizeCustomCategories(rawSettings.customCategories);
  updateAllowedCategories(customCategories.map(category => category.id));
  const usedIds = new Set();
  out.entries = normalizeTransferGroups(s.entries.map(entry => {
    const clean = validateEntry(entry);
    if (!clean || usedIds.has(clean.id)) return null;
    usedIds.add(clean.id);
    return clean;
  }).filter(Boolean));
  // Migrate legacy in-state PINs for local, imported, and cloud-loaded copies
  // before removing them from the synced/exported state. If device storage is
  // unavailable (e.g. private browsing), keep the legacy hash so the PIN is
  // not silently lost.
  let pinFailed = false;
  if (typeof rawSettings.pinHash === 'string' && /^[a-f0-9]{64}$/i.test(rawSettings.pinHash) && !getPrivacyPin().hash) {
    if (!setPrivacyPin(rawSettings.pinHash.toLowerCase(), null)) {
      pinFailed = true;
      console.warn('PIN migration failed: device-only storage was unavailable or the migrated credential could not be verified; the legacy PIN hash was retained locally.');
    }
  }
  // Never carry legacy PIN material into the validated/synced/exported state
  // once it has been successfully migrated to device-only storage.
  const {
    pinHash: _legacyPinHash,
    accountOpenings: legacyAccountOpenings,
    giftCardOpenings: legacyGiftCardOpenings,
    openingBalance: legacyOpeningValue,
    ...safeSettings
  } = rawSettings;
  const legacySettings = {
    ...safeSettings,
    accountOpenings: legacyAccountOpenings,
    giftCardOpenings: legacyGiftCardOpenings,
    openingBalance: legacyOpeningValue,
  };
  // If PIN migration to device storage failed (private browsing, storage full),
  // preserve the legacy hash in state so the lock is not silently removed.
  if (pinFailed) {
    safeSettings.pinHash = _legacyPinHash;
  }
  out.settings = {
    ...SEED_SETTINGS,
    ...safeSettings,
    // All legacy opening fields are represented by dated checkpoints now.
    balanceCheckpoints: normalizeBalanceCheckpoints(legacySettings),
    monthlyBudget: Number.isFinite(+safeSettings.monthlyBudget) && +safeSettings.monthlyBudget >= 0
      ? Math.min(+safeSettings.monthlyBudget, 1_000_000)
      : SEED_SETTINGS.monthlyBudget,
    currency: typeof safeSettings.currency === 'string' && safeSettings.currency.trim().length >= 1
      ? safeSettings.currency.trim().slice(0, 8)
      : SEED_SETTINGS.currency,
    customCategories,
    recurring: normalizeRecurring(safeSettings.recurring, customCategories.map(category => category.id)),
    coins: normalizeCoins(safeSettings.coins),
    tescoVouchers: normalizeVoucherAmount(safeSettings.tescoVouchers),
    categoryBudgets: normalizeCategoryBudgets(rawSettings.categoryBudgets, CATEGORIES_OK),
  };
  out.schemaVersion = 2;
  return out;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY());
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const validated = validateState(parsed);
    // Self-heal: when validation changes the stored data (e.g. duplicate
    // recurring entries collapsed, legacy fields normalized) write the clean
    // copy back immediately, so the next reload reads tidy storage too.
    if (JSON.stringify(validated) !== raw) saveState(validated);
    return validated;
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  try { localStorage.setItem(KEY(), JSON.stringify(state)); }
  catch (e) { console.warn('Failed to save state:', e); }
}

export function resetToBlank() {
  // Create the deletion tombstone before the first write. This prevents a
  // reload/crash between clearing the data and recording the reset from
  // resurrecting an older cloud copy.
  const resetAt = new Date().toISOString();
  const fresh = {
    ...defaultState(),
    lastLocalChangeAt: resetAt,
    localResetAt: resetAt,
  };
  saveState(fresh);
  return fresh;
}

export function exportJSON(state) {
  // PIN fallback material is intentionally local-only. Never place it in a
  // downloadable export, even if device storage was unavailable during legacy
  // PIN migration.
  const safeState = JSON.parse(JSON.stringify(state || {}));
  if (safeState.settings && typeof safeState.settings === 'object') delete safeState.settings.pinHash;
  const blob = new Blob([JSON.stringify(safeState, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  a.download = `expenses-${localDate}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// ---------- persistent undo journal ----------
// A single-slot undo record that survives a reload. The in-memory `_lastAction`
// (app.js) is a closure and cannot be serialised, so destructive actions also
// write a small journal — the removed entries — to storage. On boot, app.js
// offers to restore them. The journal is intentionally kept out of the synced
// state: it is a per-device safety net, never part of the cloud payload.
const UNDO_KEY = () => 'cents-undo-journal';
export function saveUndoJournal(journal) {
  try { localStorage.setItem(UNDO_KEY(), JSON.stringify(journal)); }
  catch (e) { console.warn('Failed to save undo journal:', e); }
}
export function loadUndoJournal() {
  try {
    const raw = localStorage.getItem(UNDO_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (!Array.isArray(parsed.entries) && !Array.isArray(parsed.checkpoints))) return null;
    return parsed;
  } catch { return null; }
}
export function clearUndoJournal() {
  try { localStorage.removeItem(UNDO_KEY()); } catch { /* noop */ }
}

