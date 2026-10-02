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
                   additive collections (customCategories, customMethods,
                   recurring, balanceCheckpoints) are unioned, and
                   methodHidden is per-key last-write-wins.
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
  // Only real ids, and only from real arrays: a hostile or corrupt document
  // could carry a string where a list belongs, and spreading a string would
  // inject one "id" per character.
  const clean = (value) => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []);
  return [...new Set([...clean(a), ...clean(b)])];
}

/** Union entries by id; per-id LWW by version; tombstoned ids are dropped. */
function mergeEntries(localEntries, cloudEntries, deletedIds) {
  const byId = new Map();
  // Nullish rows are skipped rather than dereferenced: one junk element in
  // either document must not abort the merge (and with it, every sync).
  for (const entry of Array.isArray(localEntries) ? localEntries : []) {
    if (entry && entry.id) byId.set(entry.id, entry);
  }
  for (const entry of Array.isArray(cloudEntries) ? cloudEntries : []) {
    if (!entry || !entry.id) continue;
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
  for (const item of Array.isArray(older) ? older : []) if (item && item.id) map.set(item.id, item);
  for (const item of Array.isArray(newer) ? newer : []) if (item && item.id) map.set(item.id, item);
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
  for (const item of Array.isArray(older) ? older : []) if (item && item.id) map.set(item.id, item);
  for (const item of Array.isArray(newer) ? newer : []) if (item && item.id) map.set(item.id, item);
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
  const left = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  const right = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const out = { ...left };
  for (const [key, count] of Object.entries(right)) {
    out[key] = Math.max(Number(out[key]) || 0, Number(count) || 0);
  }
  return out;
}

/** balanceCheckpoints: {methodId: [{date, at, balance}]} — keep the point
 *  with the later `at` for the same date, union across methods. */
function mergeCheckpoints(a = {}, b = {}) {
  const left = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  const right = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const methods = new Set([...Object.keys(left), ...Object.keys(right)]);
  const out = {};
  for (const method of methods) {
    const byDate = new Map();
    for (const point of (Array.isArray(left[method]) ? left[method] : [])) {
      if (point && point.date) byDate.set(point.date, point);
    }
    for (const point of (Array.isArray(right[method]) ? right[method] : [])) {
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
    // customMethods is additive for the same reason customCategories is — a
    // method added on either device survives. Note what is NOT here: removing a
    // method must not delete it from this list, because the union would pull it
    // straight back from the other side. A removal is the methodHidden tombstone
    // below, and it travels either way because it is per-key LWW.
    customMethods: unionById(older.customMethods, newer.customMethods),
    // Per-key LWW, and the direction matters: the fresher side spread LAST, so
    // a key it dropped (a method restored to the pickers) beats the other
    // side's `true`, while a `true` the fresher side still holds beats the
    // other side's absence. Both removal and restore therefore sync.
    methodHidden: { ...(older.methodHidden || {}), ...(newer.methodHidden || {}) },
    recurring: mergeRecurring(older.recurring, newer.recurring),
    balanceCheckpoints: mergeCheckpoints(localSettings.balanceCheckpoints, cloudSettings.balanceCheckpoints),
    coins: mergeCoins(localSettings.coins, cloudSettings.coins),
    // tescoVouchers follows the normal last-write-wins scalar rule (via the
    // `...newer` spread). A max-union rule here would make spending vouchers
    // un-syncable: the lower value could never win a merge against a device
    // still holding the higher one, so a redeemed amount would resurrect.
    // categoryBudgets: per-key LWW — a target set on either side survives, and
    // the fresher side wins a clash for the same category.
    categoryBudgets: { ...(older.categoryBudgets || {}), ...(newer.categoryBudgets || {}) },
    // tescoWeekNos is per-week too: a week number typed on either device
    // survives, and the fresher side wins a clash for the same week.
    tescoWeekNos: { ...(older.tescoWeekNos || {}), ...(newer.tescoWeekNos || {}) },
    // tescoPayLedger is what the ledger has already been told about Tesco pay,
    // per pay date — the line this app wrote and the figure it wrote it at.
    // Per-key LWW, like methodHidden, and a date only ONE side has survives the
    // union: that is what keeps a line the other device deleted from being
    // written back by the merge. The id, the amount and the `by: 'fill'` tag
    // travel together as one value, so neither can be paired with the other
    // side's figure — and a fill recognised on one device stays a fill here.
    tescoPayLedger: { ...(older.tescoPayLedger || {}), ...(newer.tescoPayLedger || {}) },
    // enabledTabs is a POLICY, not a collection: unioning it would let any
    // device that still lists a tab re-grant it after the admin hid it. The
    // fresher side wins outright — with the fallback for a side that predates
    // the feature and so carries no list at all (that must not read as
    // "everything visible" and undo a restriction).
    enabledTabs: Array.isArray(newer.enabledTabs) ? newer.enabledTabs : older.enabledTabs,
    deletedEntryIds,
  };
}

/** Merge two full state documents into one raw state object (unvalidated —
 *  callers run it through validateState() before adopting). */
/** Union one id-keyed Tesco collection (shifts / payslips) with LWW per id,
 *  dropping tombstones. Mirrors mergeEntries, minus the entry-shape rules. */
function mergeTescoList(localList, cloudList, deleted) {
  const byId = new Map();
  for (const item of localList || []) if (item && item.id) byId.set(item.id, item);
  for (const item of cloudList || []) {
    if (!item || !item.id) continue;
    const existing = byId.get(item.id);
    if (!existing || entryVersion(item) > entryVersion(existing)) byId.set(item.id, item);
  }
  return [...byId.values()].filter(item => !deleted.has(item.id));
}

/** Tesco Pay: union shifts + payslips by id, union both tombstone lists.
 *  Rates live under settings.tescoRates and follow the scalar LWW rule. */
function mergeTesco(localTesco, cloudTesco) {
  const empty = { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] };
  const local = localTesco && typeof localTesco === 'object' ? localTesco : empty;
  const cloud = cloudTesco && typeof cloudTesco === 'object' ? cloudTesco : empty;
  const deletedShiftIds = unionIds(local.deletedShiftIds, cloud.deletedShiftIds);
  const deletedPayslipIds = unionIds(local.deletedPayslipIds, cloud.deletedPayslipIds);
  return {
    shifts: mergeTescoList(local.shifts, cloud.shifts, new Set(deletedShiftIds)),
    payslips: mergeTescoList(local.payslips, cloud.payslips, new Set(deletedPayslipIds)),
    deletedShiftIds,
    deletedPayslipIds,
  };
}

export function mergeStates(local, cloud) {
  // Tolerate a missing or non-object document on either side: a merge that
  // throws here takes every subsequent sync down with it, and the cloud copy
  // can legitimately be absent (first push) or unreadable.
  const mine = local && typeof local === 'object' && !Array.isArray(local) ? local : {};
  const theirs = cloud && typeof cloud === 'object' && !Array.isArray(cloud) ? cloud : {};
  const localTime = Date.parse(mine.lastLocalChangeAt || '');
  const cloudTime = Date.parse(theirs.lastLocalChangeAt || '');
  const cloudFresher = Number.isFinite(cloudTime) && (!Number.isFinite(localTime) || cloudTime > localTime);
  const deletedIds = new Set(unionIds(mine.settings?.deletedEntryIds, theirs.settings?.deletedEntryIds));
  const merged = {
    ...mine,
    entries: mergeEntries(mine.entries, theirs.entries, deletedIds),
    settings: mergeSettings(mine.settings || {}, theirs.settings || {}, cloudFresher),
    tesco: mergeTesco(mine.tesco, theirs.tesco),
    lastLocalChangeAt: maxIso(mine.lastLocalChangeAt, theirs.lastLocalChangeAt),
    localResetAt: maxIso(mine.localResetAt, theirs.localResetAt),
    schemaVersion: 2,
  };
  return merged;
}
