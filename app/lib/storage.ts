/* ============================================================
   Storage layer — localStorage CRUD + JSON export/import
   Strict validation: NaN amounts and empty dates are filtered.
   UUID fallback for older browsers / file:// previews.

   Every key here is namespaced per profile by profiles.js, so one
   profile's document can never be read or overwritten by another.
   ============================================================ */
import { SEED_SETTINGS, TABS, RECURRING_FREQUENCIES } from './seed.ts';
import { getPrivacyPin, setPrivacyPin } from './settings.ts';
import { nsKey } from './profiles.ts';
// The one CSV field rule in the app. tesco.js writes and reads the workbook
// with the same one, so a note that is guarded here is guarded there too.
import { csvDocument, csvRows, csvDate, csvUnquote, isRealDate, CSV_BOM } from './csv.ts';
import type { BackupResult, CentsState, Entry } from './types.ts';

const KEY = () => nsKey('state');
// Where an UNREADABLE stored document is parked instead of being lost. Kept
// per profile: a corrupt document belongs to the profile that wrote it, and
// one profile's boot must never overwrite the copy another needs.
const QUARANTINE_KEY = () => nsKey('quarantine');
// A one-shot message the UI shows after boot (see takeStorageNotice).
let storageNotice = null;

/** Consume the pending storage notice, if any. */
export function takeStorageNotice() {
  const notice = storageNotice;
  storageNotice = null;
  return notice;
}

/** The raw bytes of a document that could not be parsed, if one was kept. */
export function unreadableBackup() {
  try { return localStorage.getItem(QUARANTINE_KEY()); } catch { return null; }
}

// The first run after the profiles upgrade moves the legacy global keys into
// the "personal" profile (profiles.js). The legacy document is authoritative:
// it is what every device has been reading and syncing since profiles were
// last absent, so it deliberately overwrites any older cents:p/personal/* copy.

export const uid = () =>
  (globalThis.crypto?.randomUUID?.())
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);

const BASE_CATEGORIES = ['gro', 'travel', 'misc', 'rent', 'GC'];
const CATEGORIES_OK = new Set(BASE_CATEGORIES);
// Built-in payment methods. They are structural: the Balances screen keys a
// row, a checkpoint series and the account math to 'AIB'/'Revolut'/'RS', the
// gift-card totals to 'TG'/'LG'/'AG', and the budget filters to 'RS'. None of
// them can be REMOVED — but a user who does not use one can hide it from the
// pickers (settings.methodHidden), and it keeps validating and keeps naming the
// history that used it. See updateAllowedMethods().
const BASE_METHODS = ['AIB','Revolut','RS','TG','LG','AG','Cash'];
const METHODS_OK   = new Set(BASE_METHODS);
const TYPES_OK      = new Set(['expense', 'credit', 'transfer', 'note']);
// Recurring transfers need two linked legs and are not represented by the
// recurring editor. Keeping only single-leg recurring financial entries avoids
// creating orphaned transfer records.
const FINANCIAL_TYPES = new Set(['expense', 'credit']);
// Keep enough immutable versions to cover long-lived reconciliation history
// without allowing an accidental edit loop to grow local state forever.
export const MAX_MUTATION_HISTORY = 1000;

/** Let validateEntry accept custom-category ids that the user added at runtime. */
export function updateAllowedCategories(ids) {
  CATEGORIES_OK.clear();
  for (const id of BASE_CATEGORIES) CATEGORIES_OK.add(id);
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && id) CATEGORIES_OK.add(id);
  }
}

/** Let validateEntry accept custom-method ids the user added at runtime, and —
 *  this is the load-bearing half — keep accepting the ones they removed from
 *  the pickers. validateEntry DROPS an entry whose method is unknown, so a
 *  removal that took the id out of here would delete that entry's whole history
 *  on the next load. Removing a method is a tombstone (settings.methodHidden),
 *  never a removal from this set. */
export function updateAllowedMethods(ids) {
  METHODS_OK.clear();
  for (const id of BASE_METHODS) METHODS_OK.add(id);
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && id) METHODS_OK.add(id);
  }
}

function validateEntry(e: any): Entry | null {
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
  const base: Entry = {
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
  // Delegated, not re-implemented: the entry validator, the checkpoint list,
  // the recurring bills and the Tesco tables all ask this one question, and
  // csv.js owns the answer because it is the same question its own reader asks
  // of a cell that arrived in a file. Two copies of it is one copy that a
  // rollover (2026-02-31) can pass and the other reject, silently.
  return isRealDate(date);
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

/** User-added payment methods. Mirrors normalizeCustomCategories: an id that
 *  cannot collide with a built-in (compared case-insensitively, because the
 *  built-ins are mixed-case and the add flow slugs to lowercase) and a label
 *  carried as typed. */
function normalizeCustomMethods(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(BASE_METHODS.map(id => id.toLowerCase()));
  return raw.reduce((out, method) => {
    if (!method || typeof method !== 'object') return out;
    const id = typeof method.id === 'string' ? method.id.trim() : '';
    const label = typeof method.label === 'string' ? method.label.trim() : '';
    if (!id || !label || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(id)) return out;
    if (seen.has(id.toLowerCase())) return out;
    seen.add(id.toLowerCase());
    out.push({ id, label: label.slice(0, 80) });
    return out;
  }, []);
}

/** `{ [methodId]: true|false }` — whether each method is out of the pickers.
 *  A flag rather than a removal, for the two reasons in updateAllowedMethods()
 *  and sync-merge.js: an entry that already used the method has to keep
 *  validating, and a method deleted from customMethods alone would resurrect
 *  from the cloud copy, which unions that list by id.
 *
 *  `false` is a VALUE, not an absent key, and that is load-bearing. The merge is
 *  a per-key last-write-wins spread, and a spread can add or overwrite a key but
 *  never delete one — so "shown again" written as a deletion could never beat the
 *  other device's `true`, and a Restore would be re-asserted by every sync for as
 *  long as a second device held the flag. Written as an explicit false, the
 *  fresher side simply overwrites it, in both directions. It also means a stale
 *  false key is harmless (false is the default state), where a stale true one
 *  would hide a method the user brought back. Keys outside the allowed set are
 *  junk and are dropped. */
function normalizeMethodHidden(raw, knownIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean' || !knownIds.has(id)) continue;
    out[id] = value;
  }
  return out;
}

/** What the ledger has already been told about Tesco pay, per pay date:
 *  `{ [payDate]: { id, amount } }` — the line this app wrote for that pay date
 *  and the figure it wrote it at. The rule that reads it is
 *  tescoPayLedgerWrites in tesco-pay.js.
 *
 *  A date listed here is never written again, and that is what makes DELETING
 *  the line stick: without the record, the next recording of that week would
 *  write the entry back and the money would keep returning. It also carries the
 *  id, so a line the user has since edited by hand is recognisable as theirs.
 *
 *  `by: 'fill'` is carried through for a line the USER filled rather than one
 *  the recorder wrote (the three Fill paths in app.js). It is the only value
 *  that means anything: an absent tag reads as the recorder's own, which is
 *  what every mark written before the tag existed already is, so a document
 *  from an older app is not reclassified by the load.
 *
 *  Anything malformed is dropped rather than repaired. An unreadable record
 *  would let a deleted line come back, and a wrong amount would let the app
 *  follow a figure it never wrote. */
function normalizeTescoPayLedger(raw: any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, { id: string; amount: number; by?: 'fill' }> = {};
  for (const [date, value] of Object.entries(raw as Record<string, any>)) {
    if (!isValidCheckpointDate(date)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const id = typeof value.id === 'string' && value.id && value.id.length <= 200 ? value.id : null;
    const amount = Number(value.amount);
    if (!id) continue;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) continue;
    if (Math.round(amount * 100) / 100 !== amount) continue;
    out[date] = value.by === 'fill' ? { id, amount, by: 'fill' } : { id, amount };
  }
  // Bounded like the pay tables it shadows, oldest dates first: a date this old
  // is one Tesco Pay still holds a week for, so the record would never be read.
  const dates = Object.keys(out).sort();
  if (dates.length > TESCO_PAY_LEDGER_MAX) {
    for (const date of dates.slice(0, dates.length - TESCO_PAY_LEDGER_MAX)) delete out[date];
  }
  return out;
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
      || !RECURRING_FREQUENCIES.includes(item.frequency)) return out;
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

// The empty document, and the ONE shape a document has.
//
// It is validated rather than written out by hand, and that is the whole point:
// this is what loadState() hands the app on a fresh install (no stored key,
// blocked storage, unreadable bytes) and what validateState() answers for
// anything that is not a document — so a literal here was a SECOND shape, eight
// settings keys short of the one the validator produces (customCategories,
// customMethods, methodHidden, recurring, coins, tescoRates, tescoWeekNos,
// tescoPayLedger — none of them in SEED_SETTINGS). Every reader guards with
// `|| []`/`|| {}`, so nothing broke; what it cost was a first session running on
// a document its own validator would have rewritten, and a stored shape that
// changed by itself on the second load — validateState was not idempotent
// (measured: 8 settings keys, then 16). Validating the literal closes the class
// at the source instead of at every reader: there is one shape, and this is it.
// The literal carries entries/tesco/schemaVersion so it takes the normal path —
// never the junk-input branch, which leads back here.
function defaultState() {
  return validateState({
    entries: [],
    settings: {
      ...SEED_SETTINGS,
      balanceCheckpoints: Object.fromEntries(BALANCE_METHOD_IDS.map(id => [id, []])),
    },
    tesco: emptyTesco(),
    schemaVersion: 2,
  });
}

// ---------- Tesco Pay (shifts + payslips) ----------
function emptyTesco() {
  return { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] };
}
const TESCO_TIME_RE = /^\d{1,2}:\d{2}$/;
const TESCO_MAX_SHIFTS = 2000;
const TESCO_MAX_PAYSLIPS = 500;
// Pay dates the ledger has been told about (settings.tescoPayLedger). A decade
// of weekly pays is ~520; anything older than the pay tables it shadows could
// never be consulted anyway.
const TESCO_PAY_LEDGER_MAX = 520;
// At least as large as the biggest tab, because "Delete all weeks" tombstones
// every row of both tables in one go — a smaller cap would trim away part of
// that burst on the next load and let the wiped weeks return from the cloud.
const TESCO_MAX_TOMBSTONES = TESCO_MAX_SHIFTS + TESCO_MAX_PAYSLIPS;

function tescoMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < -100000 || n > 100000) return 0;
  return Math.round(n * 100) / 100;
}

/** A row's own hours or pay, when the file stated one — undefined when it did
 *  not or the figure is unusable, so the engine falls back to deriving it. */
function tescoStated(v, max) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.round(n * 100) / 100;
}

// Normalize the Tesco Pay block. Unknown/corrupt shapes fall back to empty
// collections, never throw — this data rides in the same state document as
// entries and must tolerate hand-edited or legacy cloud files.
function normalizeTesco(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = emptyTesco();
  const seen = new Set();
  if (Array.isArray(src.shifts)) {
    for (const s of src.shifts) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      const id = typeof s.id === 'string' && s.id && s.id.length <= 200 ? s.id : uid();
      if (seen.has(id)) continue;
      // A date that does not exist is not a date: `Date.parse` rolls 2026-02-31
      // over to 2026-03-03 and answers a finite timestamp for it, so the shape
      // alone is not the check (see isRealDate in csv.js).
      if (!isValidCheckpointDate(String(s.date || ''))) continue;
      const start = TESCO_TIME_RE.test(String(s.start || '')) ? s.start : '';
      const end = TESCO_TIME_RE.test(String(s.end || '')) ? s.end : '';
      // A shift needs clock times OR its own hours. The sheet books a full week
      // off with hours and no times at all, and requiring both dropped that row
      // — and the week's bank pay with it.
      const hours = tescoStated(s.hours, 168);
      if (!start && hours === undefined) continue;
      const gross = tescoStated(s.gross, 100000);
      const bankPay = tescoStated(s.bankPay, 100000);
      seen.add(id);
      out.shifts.push({
        id,
        date: s.date,
        start,
        end,
        // The row's own hours, pay and net, where the file stated them: see
        // shiftPay and buildPayWeeks.
        ...(hours === undefined ? {} : { hours }),
        ...(gross === undefined ? {} : { gross }),
        ...(bankPay === undefined ? {} : { bankPay }),
        note: typeof s.note === 'string' ? s.note.slice(0, 120) : '',
        special: !!s.special,
        createdAt: typeof s.createdAt === 'string' ? s.createdAt : undefined,
      });
      if (out.shifts.length >= TESCO_MAX_SHIFTS) break;
    }
  }
  const seenSlip = new Set();
  if (Array.isArray(src.payslips)) {
    for (const p of src.payslips) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      const id = typeof p.id === 'string' && p.id && p.id.length <= 200 ? p.id : uid();
      if (seenSlip.has(id)) continue;
      if (!isValidCheckpointDate(String(p.weekStart || ''))) continue;
      seenSlip.add(id);
      // The week number the row itself carries. A week's own record is per row,
      // not per week: the sheet's tax table numbers two rows in one Sun→Sat week
      // differently when it had two pay runs.
      const weekNo = Math.trunc(Number(p.weekNo));
      out.payslips.push({
        id,
        weekStart: p.weekStart,
        ...(weekNo >= 1 && weekNo <= 53 ? { weekNo } : {}),
        paye: tescoMoney(p.paye),
        usc: tescoMoney(p.usc),
        prsi: tescoMoney(p.prsi),
        futureFund: tescoMoney(p.futureFund),
        // The net that reached the bank, when the payslip records it (the
        // sheet's Final Bank Pay column). Absent — never 0 — when blank, so a
        // week with no figure keeps falling back to gross − tax.
        bankPay: p.bankPay == null || p.bankPay === '' || !Number.isFinite(Number(p.bankPay)) ? undefined : tescoMoney(p.bankPay),
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : undefined,
      });
      if (out.payslips.length >= TESCO_MAX_PAYSLIPS) break;
    }
  }
  // Trim from the FRONT when it comes to it: ids are appended as rows are
  // deleted, so the tail holds the newest ones, and those are the deletions a
  // device that has not merged since still has to be told about.
  const tombs = (ids) => {
    const set = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === 'string' && id && id.length <= 200) set.add(id);
    }
    return [...set].slice(-TESCO_MAX_TOMBSTONES);
  };
  out.deletedShiftIds = tombs(src.deletedShiftIds);
  out.deletedPayslipIds = tombs(src.deletedPayslipIds);
  return out;
}

/** Which tabs a profile may open. Canonical order, unknown ids dropped, and
 *  the dashboard is always present — it is the landing page, so a document
 *  that hid it (or a typo'd list that removed everything) would strand the
 *  user on a blank screen with no navigation. */
function normalizeEnabledTabs(raw) {
  if (!Array.isArray(raw)) return [...TABS];
  const kept = TABS.filter(id => id === 'dashboard' || raw.includes(id));
  return kept;
}

export function validateState(s: unknown): CentsState {
  if (!s || !Array.isArray((s as CentsState).entries)) return defaultState();
  const src = s as CentsState;
  const out: CentsState = { ...src };
  const lastLocalChangeAt = normalizePastTimestamp(src.lastLocalChangeAt);
  const localResetAt = normalizePastTimestamp(src.localResetAt);
  if (lastLocalChangeAt) out.lastLocalChangeAt = lastLocalChangeAt;
  else delete out.lastLocalChangeAt;
  if (localResetAt) out.localResetAt = localResetAt;
  else delete out.localResetAt;
  const rawSettings: any = src.settings && typeof src.settings === 'object' && !Array.isArray(src.settings) ? src.settings : {};
  const customCategories = normalizeCustomCategories(rawSettings.customCategories);
  updateAllowedCategories(customCategories.map(category => category.id));
  // Both method lists are resolved before any entry is validated: METHODS_OK is
  // what validateEntry checks membership against, so it has to carry the
  // user's own methods (and every hidden one) by the time the map below runs.
  const customMethods = normalizeCustomMethods(rawSettings.customMethods);
  updateAllowedMethods(customMethods.map(method => method.id));
  const methodHidden = normalizeMethodHidden(rawSettings.methodHidden, METHODS_OK);
  const usedIds = new Set();
  out.entries = normalizeTransferGroups(src.entries.map(entry => {
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
    customMethods,
    methodHidden,
    recurring: normalizeRecurring(safeSettings.recurring, customCategories.map(category => category.id)),
    coins: normalizeCoins(safeSettings.coins),
    tescoVouchers: normalizeVoucherAmount(safeSettings.tescoVouchers),
    categoryBudgets: normalizeCategoryBudgets(rawSettings.categoryBudgets, CATEGORIES_OK),
    tescoRates: normalizeTescoRates(safeSettings.tescoRates),
    tescoWeekNos: normalizeWeekNos(safeSettings.tescoWeekNos),
    tescoPayLedger: normalizeTescoPayLedger(safeSettings.tescoPayLedger),
    enabledTabs: normalizeEnabledTabs(safeSettings.enabledTabs),
  };
  // `tourSeen` was the walkthrough's flag. The tour is gone, so the key is shed
  // rather than carried as a dead setting that would sync between devices forever
  // (the spread above copies unknown keys through, so this delete is the only
  // thing that removes one an older build wrote).
  delete out.settings.tourSeen;
  out.tesco = normalizeTesco(src.tesco);
  out.schemaVersion = 2;
  return out;
}

// Editable pay rules for the Tesco tab — scalars only, bounded.
function normalizeTescoRates(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  const defs = {
    normal: [1, 100], specialMultiplier: [1, 4], pensionPct: [0, 20],
    payeCredit: [0, 500], payeCutoff: [10, 5000], payeRateLow: [0, 60],
    payeRateHigh: [0, 90], prsiRate: [0, 20],
  };
  for (const [key, [min, max]] of Object.entries(defs)) {
    const v = num(src[key], min, max);
    if (v != null) out[key] = v;
  }
  return out;
}

// The user's own week numbering, per pay week: {"2026-09-20": 30}. The sheet
// hand-types this column (it counts 1..52/53 from the week its pay year starts
// in — for the current sheet, the first Sunday of March — and restarts at 1),
// so a stored number is the only way to match it exactly. Bounded like every
// other settings map: date-shaped keys, small integers.
function normalizeWeekNos(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(src)) {
    if (n >= 400) break;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const no = Math.trunc(Number(value));
    if (!Number.isFinite(no) || no < 1 || no > 53) continue;
    out[key] = no;
    n++;
  }
  return out;
}

export function loadState(): CentsState {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY());
  } catch {
    // Storage blocked entirely (private browsing): there is nothing to read,
    // and no write is possible either - start blank without pretending to have
    // lost something.
    return defaultState();
  }
  if (!raw) return defaultState();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable document (truncated write, quota-clipped value, hand-edited
    // storage). Park the exact bytes under a quarantine key BEFORE returning a
    // blank slate: the next save overwrites the original key, so without this
    // copy a year of entries would be gone with nothing to recover from.
    try {
      localStorage.setItem(QUARANTINE_KEY(), raw);
      storageNotice = `Stored data could not be read. A copy has been kept on this device (${QUARANTINE_KEY()}).`;
    } catch {
      storageNotice = 'Stored data could not be read.';
    }
    console.error('cents: stored document is not valid JSON - its bytes were kept under', QUARANTINE_KEY());
    return defaultState();
  }

  try {
    const validated = validateState(parsed);
    // Self-heal: when validation changes the stored data (e.g. duplicate
    // recurring entries collapsed, legacy fields normalized) write the clean
    // copy back immediately, so the next reload reads tidy storage too.
    if (JSON.stringify(validated) !== raw) saveState(validated);
    return validated;
  } catch {
    // A bug in validation must never take the app down, and must not touch the
    // stored bytes either - the next load gets a fresh attempt at them.
    return defaultState();
  }
}

export function saveState(state: CentsState): boolean {
  try {
    localStorage.setItem(KEY(), JSON.stringify(state));
    return true;
  } catch (e) {
    // The caller must be able to tell the user: a silent failure here means the
    // entry they just added is not on disk and a reload loses it.
    console.warn('Failed to save state:', e);
    return false;
  }
}

/** Read a specific profile's document as this device holds it. */
export function readStateText() {
  try { return localStorage.getItem(KEY()); } catch { return null; }
}

/** Read a specific profile's document as this device holds it.
 *  The Admin panel is the only place one profile reads another's. */
export function loadStateFor(profileId: string | null): CentsState {
  try { return validateState(JSON.parse(localStorage.getItem(nsKey('state', profileId)) || 'null')); }
  catch { return defaultState(); }
}

/** Apply a settings patch to another profile's document, leaving the rest of
 *  it untouched. Bumps the change stamp so the patched profile (on any device)
 *  keeps the new value through the next merge. Returns false if the write
 *  failed, so the caller can say so instead of pretending it worked. */
export function patchProfileSettings(profileId, patch) {
  const next = loadStateFor(profileId);
  next.settings = { ...next.settings, ...patch };
  next.lastLocalChangeAt = new Date().toISOString();
  try {
    localStorage.setItem(nsKey('state', profileId), JSON.stringify(next));
    return true;
  } catch (e) {
    console.warn('Failed to update another profile\u2019s settings:', e);
    return false;
  }
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

// A file the user asked for, written from memory — no server round trip. Both
// exports go through here so the object URL and the anchor are cleared the same
// way (revoking the URL is what frees the blob).
export function downloadText(filename, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// ---------- restoring a backup ----------
// Export has always existed; reading a file back was the missing half, which
// made "Export data" a one-way door (the notice on a full quota tells the user
// to export a backup, and nothing could ever open it). These two are pure —
// text in, verdict out, no DOM and no storage — so the rules are testable.

/** A file bigger than this is refused before it is parsed: the whole document
 *  is held as one string and JSON.parse'd on the UI thread, so an absurd file
 *  would freeze the tab instead of failing. An export of 100k entries is
 *  roughly 30 MB. */
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
/** Entries a single restore may adopt. Far above any real ledger (the app's own
 *  tombstone ceiling is 4000) and far below "parse until the tab dies". */
export const MAX_BACKUP_ENTRIES = 100000;

/**
 * Read the text of a file the user picked as a backup and say what it is.
 *
 * Never throws and never writes: it answers `{ ok: true, state, kept, dropped }`
 * or `{ ok: false, reason, detail }` so the caller can tell the user what was
 * wrong with the file instead of showing a generic failure.
 *
 * Two things are deliberately stripped before validation:
 *   · `settings.pinHash` — legacy PIN material must never arrive from a file.
 *     validateState MIGRATES a legacy hash into device storage when the device
 *     has no PIN, so a hostile (or just stale) file would otherwise get to set
 *     this device's lock. The app's own export deletes the key, so a genuine
 *     backup is unaffected;
 *   · `localResetAt` — a whole-document tombstone means "everything before this
 *     is void" and is compared across devices by the sync path. A restored copy
 *     of an old reset stamp would re-assert a reset that later data superseded.
 */
export function parseBackup(text: unknown): BackupResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, reason: 'too-large' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  // The smallest thing every export has and no other document does. A file with
  // no `entries` array is not a backup this app wrote, so it is refused rather
  // than merged in as an empty (or catastrophic) document.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.entries)) {
    return { ok: false, reason: 'not-a-backup' };
  }
  if (parsed.entries.length > MAX_BACKUP_ENTRIES) return { ok: false, reason: 'too-large' };
  const raw = JSON.parse(JSON.stringify(parsed));
  if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
    delete raw.settings.pinHash;
  } else if (raw.settings !== undefined) {
    // A settings value that is not an object (array, string, null) is not the
    // shape validateState expects; drop it so the seed settings apply and the
    // restore cannot fail on a field it was never asked to read.
    delete raw.settings;
  }
  delete raw.localResetAt;
  const state = validateState(raw);
  // How much of the file survived validation. A file whose entries were all
  // junk validates to an empty document, and a merge of nothing would look like
  // a successful restore of nothing at all.
  const kept = state.entries.length;
  const dropped = raw.entries.length - kept;
  return { ok: true, state, kept, dropped };
}

/** Does `merged` hold anything the document it was merged from (`incoming`)
 *  does not? Used by the second-tab guard: two tabs of this app are two
 *  in-memory copies of one document, and each write replaces the whole file, so
 *  the tab that writes second silently erases the other's new entry. The tab
 *  that receives the write merges both copies and must write the union back —
 *  but only when it actually HAS something the writer missed, or the two tabs
 *  would write at each other forever. */
export function foreignWriteNeeded(merged, incoming) {
  const version = (record) => {
    const at = Date.parse(record?.updatedAt || '');
    if (Number.isFinite(at)) return at;
    const history = Array.isArray(record?.mutationHistory) ? record.mutationHistory : [];
    const last = history.length ? Date.parse(history[history.length - 1]?.at || '') : NaN;
    if (Number.isFinite(last)) return last;
    const created = Date.parse(record?.createdAt || '');
    return Number.isFinite(created) ? created : 0;
  };
  const listHasMore = (mine = [], theirs = []) => {
    const seen = new Map();
    for (const item of Array.isArray(theirs) ? theirs : []) if (item && item.id) seen.set(item.id, version(item));
    for (const item of Array.isArray(mine) ? mine : []) {
      if (!item || !item.id) continue;
      const previous = seen.get(item.id);
      if (previous === undefined || version(item) > previous) return true;
    }
    return false;
  };
  const mine = merged && typeof merged === 'object' ? merged : {};
  const theirs = incoming && typeof incoming === 'object' ? incoming : {};
  if (listHasMore(mine.entries, theirs.entries)) return true;
  if (listHasMore(mine.tesco?.shifts, theirs.tesco?.shifts)) return true;
  if (listHasMore(mine.tesco?.payslips, theirs.tesco?.payslips)) return true;
  // A deletion is content too: the tombstone that removes an entry has to reach
  // the other tab, or its next write puts the deleted entry back.
  const tomb = (doc, key) => new Set(Array.isArray(doc?.settings?.[key]) ? doc.settings[key] : []);
  const theirsEntries = tomb(theirs, 'deletedEntryIds');
  for (const id of tomb(mine, 'deletedEntryIds')) if (!theirsEntries.has(id)) return true;
  const theirsShifts = new Set(Array.isArray(theirs.tesco?.deletedShiftIds) ? theirs.tesco.deletedShiftIds : []);
  for (const id of new Set(Array.isArray(mine.tesco?.deletedShiftIds) ? mine.tesco.deletedShiftIds : [])) if (!theirsShifts.has(id)) return true;
  const theirsSlips = new Set(Array.isArray(theirs.tesco?.deletedPayslipIds) ? theirs.tesco.deletedPayslipIds : []);
  for (const id of new Set(Array.isArray(mine.tesco?.deletedPayslipIds) ? mine.tesco.deletedPayslipIds : [])) if (!theirsSlips.has(id)) return true;
  // Balance checkpoints are keyed by date inside a per-method map, so they get
  // the same treatment one level down: a point (or a whole method) the writer
  // did not have is content worth writing.
  const minePoints = mine.settings?.balanceCheckpoints || {};
  const theirsPoints = theirs.settings?.balanceCheckpoints || {};
  for (const method of Object.keys(minePoints)) {
    const had = new Set((Array.isArray(theirsPoints[method]) ? theirsPoints[method] : []).map(point => point?.date));
    for (const point of Array.isArray(minePoints[method]) ? minePoints[method] : []) {
      if (point && point.date && !had.has(point.date)) return true;
    }
  }
  return false;
}

/** The local calendar date, as both exports' file names carry it. Local rather
 *  than UTC: the file is named after the day the person made it, not the day it
 *  was in Greenwich. */
function exportStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function exportJSON(state) {
  // PIN fallback material is intentionally local-only. Never place it in a
  // downloadable export, even if device storage was unavailable during legacy
  // PIN migration.
  const safeState = JSON.parse(JSON.stringify(state || {}));
  if (safeState.settings && typeof safeState.settings === 'object') delete safeState.settings.pinHash;
  downloadText(`expenses-${exportStamp()}.json`, JSON.stringify(safeState, null, 2), 'application/json');
}

// ---------- the ledger as a table ----------
// The JSON export is the document itself — it is what Restore from backup reads
// back. This is the same ledger for a person: one row per entry, the readable
// label instead of the stored id, in a file any spreadsheet opens — and read
// back by parseEntriesCsv() below, which matches columns BY NAME, so a column
// may be added (or reordered in a spreadsheet) without breaking a round trip.
//
// The label resolvers are handed in rather than looked up here: app.js owns
// categoryLabel/methodLabel and the custom-category table behind them, and a
// second copy of those rules in this file would be a second answer to "what is
// category 'gro' called" — one free to drift from the one on screen.
export const ENTRIES_CSV_HEADER = Object.freeze(['Date', 'Type', 'Category', 'Details', 'Amount', 'Method', 'Note']);

export function entriesCsv(state: CentsState, labels: any = {}, ordered: any = null): string {
  // `labels` is held to the same rule as `state` below: a caller that has no
  // custom-category table passes nothing, and a caller that passes something
  // that is not a table gets the fallback resolvers (print the stored id)
  // rather than a TypeError half way through the document.
  const L = labels && typeof labels === 'object' ? labels : {};
  const category = typeof L.category === 'function' ? L.category : (id) => id;
  const method = typeof L.method === 'function' ? L.method : (id) => id;
  // `ordered` is the caller's already-sorted view (the History screen's own
  // export, which can be oldest-first or a search ranking): a list the caller
  // chose the order of is taken as given, and everything else gets the file's
  // own contract below. The filter applies either way — a row that is not an
  // object has no fields to print.
  const source = Array.isArray(ordered)
    ? ordered
    : (Array.isArray(state?.entries) ? state.entries : []);
  const entries = source
    // A row that is not an object has no fields to print, and a validated
    // document cannot hold one — but this is also reachable from a hostile
    // merge, and a pure function that can throw half way through is worse than
    // one that skips a row it cannot read.
    .filter(e => e && typeof e === 'object')
    .slice();
  if (!Array.isArray(ordered)) {
    entries.sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
  const rows = [ENTRIES_CSV_HEADER];
  for (const e of entries) {
    rows.push([
      e.date,
      e.type,
      category(e.category),
      e.details,
      // Two decimals and nothing else: "12.40" has to stay a cell a spreadsheet
      // can total. (csvCell() leaves a plain number alone precisely so that the
      // apostrophe which defuses "=SUM(A1)" cannot turn -56.08 into text.)
      Number.isFinite(Number(e.amount)) ? Number(e.amount).toFixed(2) : '',
      method(e.method),
      e.note,
    ]);
  }
  return csvDocument(rows);
}

/** entriesCsv() as a file. The BOM is for the reader, not for us: Excel on
 *  Windows opens a BOM-less UTF-8 file in the machine's own ANSI code page, so a
 *  note carrying a euro sign or an accent arrives as mojibake. Nothing in this
 *  app reads the file back, so the byte costs no round trip. */
export function exportEntriesCsv(state: CentsState, labels: any = {}, opts: any = {}) {
  // A view export is named for what it is: a file called `expenses-…` that
  // holds only the filtered rows reads as a truncated full export.
  const entries = Array.isArray(opts.entries) ? opts.entries : null;
  const name = entries ? `history-${exportStamp()}` : `expenses-${exportStamp()}`;
  downloadText(`${name}.csv`, CSV_BOM + entriesCsv(state, labels, entries), 'text/csv;charset=utf-8');
}

/** Why a CSV was refused, in the words a user can act on (the app prints the
 *  one matching this reason, the way BACKUP_REFUSAL words parseBackup). */
export const CSV_REFUSAL = {
  empty: 'That file is empty.',
  'too-large': 'That file is far too large to be a CSV export.',
  'no-header': 'That file has no header row this app wrote - it does not look like a cents. CSV export.',
};

/** The other direction of entriesCsv(): read a CSV this app exported back into
 *  entries. Never throws, and answers with parseBackup's shape —
 *  { ok: false, reason } or { ok: true, entries, kept, dropped, duplicates } —
 *  because it is the same promise: a file the user picked must either merge or
 *  explain itself, never half-apply or throw at them.
 *
 *  The header is matched BY NAME (case- and whitespace-insensitive) rather than
 *  by position: the file goes out through a spreadsheet, and a spreadsheet
 *  reorders, renames and re-saves columns without asking. Date, Type, Category,
 *  Amount and Method are required — they are what validateEntry needs to accept
 *  a row; Details and Note are optional and default to empty.
 *
 *  `resolve` maps a LABEL back to the stored id — the mirror of the label
 *  resolvers entriesCsv() is handed (app.js owns categoryLabel/methodLabel and
 *  the custom tables behind them, so the rules live there, once). A cell that
 *  matches no label is kept as written, so a hand-edited file that already
 *  carries ids round trips too.
 *
 *  `existing` is this device's entries: a row identical to one already in the
 *  ledger is counted as a duplicate and NOT re-added, so importing the same
 *  file twice does not double the ledger (export writes no ids, so identity
 *  can only be by content — and the match is multiset, so a day with two
 *  identical coffees imports both when neither is here and neither twice when
 *  both are).
 *
 *  What the CSV does not carry — ids, the transfer/split pairing and the
 *  budget-excluded flag — comes back without them: legs import as independent
 *  rows (and validateState's normalizeTransferGroups turns a lone transfer row
 *  into an ordinary expense, which is what an unpaired leg has to be). */
export function parseEntriesCsv(text: unknown, resolve: any = {}, existing: Entry[] = []) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, reason: 'too-large' };
  // The export puts a BOM in front of the file for Excel's benefit. It never
  // reaches a comparison: csvRows keeps it as an ordinary character, and `norm`
  // below TRIMS every header cell — U+FEFF is whitespace to String.trim — so
  // the first header reads as "date" rather than "\uFEFFDate" (an explicit
  // replace would be the same rule written twice).
  const rows = csvRows(text);
  const norm = value => String(value == null ? '' : value).trim().toLowerCase();
  const REQUIRED = ['date', 'type', 'category', 'amount', 'method'];
  let cols: Record<string, number> | null = null;
  let body: string[][] = [];
  for (let i = 0; i < rows.length; i++) {
    const map: Record<string, number> = {};
    rows[i].forEach((cell, idx) => {
      const name = norm(cell);
      if (name && map[name] === undefined) map[name] = idx;
    });
    if (REQUIRED.every(name => map[name] !== undefined)) { cols = map; body = rows.slice(i + 1); break; }
  }
  // No recognisable header anywhere in the file: this is not our export (and a
  // positional guess at an arbitrary CSV is how an import silently mis-files
  // every column of somebody else's data).
  if (!cols) return { ok: false, reason: 'no-header' };
  if (body.length > MAX_BACKUP_ENTRIES) return { ok: false, reason: 'too-large' };
  const categoryId = typeof resolve.category === 'function' ? resolve.category : null;
  const methodId = typeof resolve.method === 'function' ? resolve.method : null;
  const cell = (row: string[], name: string) => (cols![name] === undefined ? '' : String(row[cols![name]] == null ? '' : row[cols![name]]));
  const asId = (raw, lookup) => {
    const value = csvUnquote(String(raw).trim());
    const found = lookup ? lookup(value) : null;
    return found || value;
  };
  const raw: any[] = [];
  for (const row of body) {
    // csvDate answers ISO or null — a cell that holds no date at all (or a
    // serial outside Excel's epoch) fails validateEntry below and is counted
    // as dropped rather than guessed at.
    const amountCell = csvUnquote(cell(row, 'amount').trim());
    raw.push({
      id: uid(),
      date: csvDate(cell(row, 'date')),
      type: csvUnquote(cell(row, 'type').trim()),
      category: asId(cell(row, 'category'), categoryId),
      details: csvUnquote(cell(row, 'details')),
      // '' must become NaN, not 0: Number('') is 0, and an empty amount cell
      // would otherwise import as a real zero-value entry.
      amount: amountCell === '' ? NaN : Number(amountCell),
      method: asId(cell(row, 'method'), methodId),
      note: csvUnquote(cell(row, 'note')),
    });
  }
  const tuple = e => [e.date, e.type, e.category, e.details,
    Number.isFinite(Number(e.amount)) ? Number(e.amount).toFixed(2) : '',
    e.method, e.note].join('\u0001');
  const have = new Map();
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (!entry || typeof entry !== 'object') continue;
    const key = tuple(entry);
    have.set(key, (have.get(key) || 0) + 1);
  }
  const kept = [];
  let dropped = 0;
  let duplicates = 0;
  for (const row of raw) {
    const clean = validateEntry(row);
    if (!clean) { dropped += 1; continue; }
    const key = tuple(clean);
    const already = have.get(key) || 0;
    if (already > 0) { have.set(key, already - 1); duplicates += 1; continue; }
    kept.push(clean);
  }
  return { ok: true, entries: kept, kept: kept.length, dropped, duplicates };
}

// ---------- persistent undo journal ----------
// A single-slot undo record that survives a reload. The in-memory `_undoStack`
// (app.js) holds closures and cannot be serialised, so destructive actions also
// write their removed entries here — one record each, newest first. On boot,
// app.js offers the newest one that still has something to restore. The journal
// is intentionally kept out of the synced state: it is a per-device safety net,
// never part of the cloud payload.
const UNDO_KEY = () => nsKey('undo');
// The undo journal is a STACK of up to UNDO_STACK_MAX records, newest first:
// the FAB offering "the last action" only ever read the newest one, so an older
// record was being overwritten rather than outgrown. A single object — the
// pre-stack shape, still sitting in storage for a session that wrote it — reads
// as a one-record stack.
export const UNDO_STACK_MAX = 5;
function readUndoStack() {
  try {
    const raw = localStorage.getItem(UNDO_KEY());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const stack = Array.isArray(parsed) ? parsed
      : (parsed && (Array.isArray(parsed.entries) || Array.isArray(parsed.checkpoints)) ? [parsed] : []);
    return stack.filter(r => r && (Array.isArray(r.entries) || Array.isArray(r.checkpoints)));
  } catch { return []; }
}

export function saveUndoJournal(journal) {
  // Pushed onto that stack rather than replacing the one record. Newest first,
  // capped, one record per undoable action — each self-contained (the
  // entries/checkpoints THAT action needs), so undoing twice after a reload
  // re-adds two independent batches.
  try {
    const stack = readUndoStack();
    stack.unshift(journal);
    localStorage.setItem(UNDO_KEY(), JSON.stringify(stack.slice(0, UNDO_STACK_MAX)));
  } catch (e) { console.warn('Failed to save undo journal:', e); }
}
export function loadUndoJournal() {
  return readUndoStack()[0] || null;
}
/** Spend the newest record: the action it describes has been undone. */
export function popUndoJournal() {
  try {
    const stack = readUndoStack();
    if (!stack.length) return;
    localStorage.setItem(UNDO_KEY(), JSON.stringify(stack.slice(1)));
  } catch { /* noop */ }
}
/** Spend ONE record — the one a captured toast closure holds — without
 *  touching a newer action that may already be in front of it. Unmatched
 *  records fall back to the front, which is what the offer was made from. */
export function dropUndoJournal(record) {
  try {
    const stack = readUndoStack();
    if (!stack.length) return;
    const at = record && record.at;
    const idx = at ? stack.findIndex(r => r && r.at === at) : 0;
    const drop = idx < 0 ? 0 : idx;
    localStorage.setItem(UNDO_KEY(), JSON.stringify(stack.filter((_, i) => i !== drop)));
  } catch { /* noop */ }
}
export function clearUndoJournal() {
  try { localStorage.removeItem(UNDO_KEY()); } catch { /* noop */ }
}

