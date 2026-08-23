/* ============================================================
   sync-merge.js — pure cloud-reconciliation merge logic.

   Deliberately has zero dependencies (no DOM, no localStorage) so
   it can be unit-tested in Node and reasoned about in isolation.

   Model:
     * Entries   — union by id; for a shared id the version with the
                   later mutation time wins (updatedAt > last
                   mutationHistory.at > createdAt).
     * Settings  — scalar values (monthlyBudget, currency, coins)
                   come from the side with the later lastLocalChangeAt;
                   additive collections (customCategories, recurring,
                   balanceCheckpoints) are unioned.
     * Deletions — tombstones in settings.deletedEntryIds. Any entry
                   whose id is tombstoned on EITHER side is dropped.
                   Unknown settings keys pass through both validators
                   (server: validIncomingSettings; client: validateState),
                   so tombstones travel with the cloud file untouched.
     * Resets    — localResetAt is a whole-document tombstone handled
                   by the caller (whoever reset more recently wins).
   ============================================================ */

/** Latest mutation time of an entry as a number (0 when unknown). */
function entryVersion(entry) {
  if (!entry) return 0;
  const updated = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN;
  if (Number.isFinite(updated)) return updated;
  const history = Array.isArray(entry.mutationHistory) && entry.mutationHistory.length
    ? Date.parse(entry.mutationHistory[entry.mutationHistory.length - 1].at)
    : NaN;
  if (Number.isFinite(history)) return history;
  const created = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
  return Number.isFinite(created) ? created : 0;
}

function maxIso(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

function unionIds(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

/** Union entries by id; per-id LWW by version; tombstoned ids are dropped. */
function mergeEntries(localEntries, cloudEntries, deletedIds) {
  const byId = new Map();
  for (const entry of localEntries || []) byId.set(entry.id, entry);
  for (const entry of cloudEntries || []) {
    const existing = byId.get(entry.id);
    if (!existing || entryVersion(entry) > entryVersion(existing)) byId.set(entry.id, entry);
  }
  const out = [];
  for (const entry of byId.values()) {
    if (deletedIds.has(entry.id)) continue;
    out.push(entry);
  }
  return out;
}

/** Union id-keyed lists (customCategories); `newer` wins a clash. */
function unionById(older = [], newer = []) {
  const map = new Map();
  for (const item of older) if (item && item.id) map.set(item.id, item);
  for (const item of newer) if (item && item.id) map.set(item.id, item);
  return [...map.values()];
}

/** Content fingerprint for a recurring entry - two entries with every editor
 *  field equal are the same charge even when their ids differ (each save gets
 *  a fresh id, so id-union alone lets duplicates survive sync forever). */
function recurringFingerprint(item) {
  if (!item || typeof item !== 'object') return '';
  const day = Number.isInteger(Number(item.dayOfMonth)) ? Math.min(31, Math.max(1, Number(item.dayOfMonth))) : 1;
  const amount = Number.isFinite(Number(item.amount)) ? Number(item.amount).toFixed(2) : '';
  return [item.type, String(item.details || '').trim().toLowerCase(), amount, item.method, item.category, item.frequency, day].join('|');
}

/** Recurring merge: union by id (newer side wins a clash), then collapse
 *  content-identical duplicates so the same charge added on two devices (or
 *  twice on one) never appears twice. The surviving entry keeps whichever id
 *  the union picked; the client-side validateState re-checks on adoption. */
function mergeRecurring(older = [], newer = []) {
  const map = new Map();
  for (const item of older || []) if (item && item.id) map.set(item.id, item);
  for (const item of newer || []) if (item && item.id) map.set(item.id, item);
  const out = [];
  const seen = new Set();
  for (const item of map.values()) {
    const fingerprint = recurringFingerprint(item);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(item);
  }
  return out;
}

/** coins: {denomination: count} — additive per-denomination counts, so union
 *  across devices keeping the max count per denomination (never a wholesale
 *  replace, which would silently drop the other device's coins). */
function mergeCoins(a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const [key, count] of Object.entries(b || {})) {
    out[key] = Math.max(Number(out[key]) || 0, Number(count) || 0);
  }
  return out;
}

/** balanceCheckpoints: {methodId: [{date, at, balance}]} — keep the point
 *  with the later `at` for the same date, union across methods. */
function mergeCheckpoints(a = {}, b = {}) {
  const methods = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const method of methods) {
    const byDate = new Map();
    for (const point of (a[method] || [])) {
      if (point && point.date) byDate.set(point.date, point);
    }
    for (const point of (b[method] || [])) {
      if (!point || !point.date) continue;
      const existing = byDate.get(point.date);
      if (!existing || Date.parse(point.at || '') > Date.parse(existing.at || '')) byDate.set(point.date, point);
    }
    out[method] = [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  }
  return out;
}

/** Merge settings. Scalars from the newer side; collections unioned. */
function mergeSettings(localSettings = {}, cloudSettings = {}, cloudFresher) {
  const older = cloudFresher ? localSettings : cloudSettings;
  const newer = cloudFresher ? cloudSettings : localSettings;
  const deletedEntryIds = unionIds(localSettings.deletedEntryIds, cloudSettings.deletedEntryIds);
  return {
    ...newer,
    customCategories: unionById(older.customCategories, newer.customCategories),
    recurring: mergeRecurring(older.recurring, newer.recurring),
    balanceCheckpoints: mergeCheckpoints(localSettings.balanceCheckpoints, cloudSettings.balanceCheckpoints),
    coins: mergeCoins(localSettings.coins, cloudSettings.coins),
    // tescoVouchers: an amount like coins - keep the max so one device's
    // voucher value is never silently dropped by the other's older copy.
    tescoVouchers: Math.max(Number(localSettings.tescoVouchers) || 0, Number(cloudSettings.tescoVouchers) || 0),
    // categoryBudgets: per-key LWW — a target set on either side survives, and
    // the fresher side wins a clash for the same category.
    categoryBudgets: { ...(older.categoryBudgets || {}), ...(newer.categoryBudgets || {}) },
    deletedEntryIds,
  };
}

/** Merge two full state documents into one raw state object (unvalidated —
 *  callers run it through validateState() before adopting). */
export function mergeStates(local, cloud) {
  const localTime = Date.parse(local.lastLocalChangeAt || '');
  const cloudTime = Date.parse(cloud.lastLocalChangeAt || '');
  const cloudFresher = Number.isFinite(cloudTime) && (!Number.isFinite(localTime) || cloudTime > localTime);
  const deletedIds = new Set(unionIds(local.settings?.deletedEntryIds, cloud.settings?.deletedEntryIds));
  const merged = {
    ...local,
    entries: mergeEntries(local.entries, cloud.entries, deletedIds),
    settings: mergeSettings(local.settings || {}, cloud.settings || {}, cloudFresher),
    lastLocalChangeAt: maxIso(local.lastLocalChangeAt, cloud.lastLocalChangeAt),
    localResetAt: maxIso(local.localResetAt, cloud.localResetAt),
    schemaVersion: 2,
  };
  return merged;
}
