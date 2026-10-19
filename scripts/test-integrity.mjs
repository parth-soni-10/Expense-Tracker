#!/usr/bin/env node
/**
 * Integrity harness: the workflows that can destroy the user's ledger.
 *
 * The app's whole value is one JSON document in localStorage plus a cloud
 * copy of it. Anything that throws on load, silently replaces unreadable
 * data with a blank slate, fails to write while reporting success, or drops
 * an entry during a merge takes the whole workflow with it. This suite feeds
 * those paths hostile input and asserts they behave.
 *
 * Runs in Node with a localStorage stub installed BEFORE the modules are
 * imported, because storage.js touches it at import time.
 */

class MemoryStorage {
  constructor(seed = {}, { failWrites = false, failReads = false } = {}) {
    this.map = new Map(Object.entries(seed));
    this.failWrites = failWrites;
    this.failReads = failReads;
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) {
    if (this.failReads) throw new DOMException('blocked', 'SecurityError');
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

// The live document lives under the ACTIVE PROFILE's namespace
// (profiles.js), which resolves to "personal" on a device with no registry.
const LIVE_KEY = 'cents:p/personal/state';

const { validateState, loadState, saveState, parseBackup, parseEntriesCsv, CSV_REFUSAL, foreignWriteNeeded, readStateText, unreadableBackup, entriesCsv, ENTRIES_CSV_HEADER, MAX_BACKUP_BYTES, MAX_BACKUP_ENTRIES, isValidCheckpointDate } = await import('../app/lib/storage.ts');
const { csvCell, csvUnquote, csvDocument, csvRows, csvDate, isRealDate, CSV_BOM } = await import('../app/lib/csv.ts');
const { getPrivacyPin, getSyncSettings, isDefaultSyncEndpoint, DEFAULT_SYNC_ENDPOINT, isValidEndpoint } = await import('../app/lib/settings.ts');
const { mergeStates } = await import('../app/lib/sync-merge.ts');
const { paidHours, shiftPay, simulateTax, tescoCsv, parseTescoCsv } = await import('../tesco.js');
const { readFileSync, existsSync } = await import('node:fs');

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) pass += 1;
  else failures.push(name + (detail ? ` - ${detail}` : ''));
};
const noThrow = (name, fn) => {
  try { const v = fn(); pass += 1; return v; }
  catch (e) { failures.push(`${name} threw: ${e && e.message}`); return undefined; }
};

// ---------------------------------------------------------------- shapes
const looksLikeState = (s) =>
  !!s && typeof s === 'object' && Array.isArray(s.entries)
  && !!s.settings && typeof s.settings === 'object' && !Array.isArray(s.settings);

const validEntry = (e) =>
  !!e && typeof e === 'object' && typeof e.id === 'string' && e.id.length > 0
  && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.type === 'string'
  && typeof e.method === 'string' && typeof e.category === 'string'
  && Number.isFinite(e.amount) && e.amount >= 0
  && typeof e.details === 'string' && typeof e.note === 'string';

// ------------------------------------------------- 1. hostile state shapes
const hostileStates = [
  ['null', null], ['undefined', undefined], ['number', 42], ['string', 'nope'],
  ['empty array', []], ['empty object', {}], ['entries null', { entries: null }],
  ['entries object', { entries: {} }],
  ['entries of junk', { entries: [null, undefined, 42, 'x', [], {}, NaN] }],
  ['settings null', { entries: [], settings: null }],
  ['settings array', { entries: [], settings: [] }],
  ['settings string', { entries: [], settings: 'x' }],
  ['settings proto', { entries: [], settings: JSON.parse('{"__proto__":{"polluted":true}}') }],
  ['entries proto', { entries: [JSON.parse('{"id":"a","__proto__":{"polluted":true}}')] }],
  ['deep junk settings', { entries: [], settings: { recurring: 'nope', coins: 5, customCategories: [null, 1], categoryBudgets: [], balanceCheckpoints: 'x' } }],
];
for (const [label, input] of hostileStates) {
  const out = noThrow(`validateState(${label})`, () => validateState(input));
  check(`validateState(${label}) returns a state`, looksLikeState(out));
  if (looksLikeState(out)) {
    check(`validateState(${label}) entries all valid`, out.entries.every(validEntry),
      `${out.entries.filter(e => !validEntry(e)).length} invalid survived`);
  }
}
check('no prototype pollution', ({}).polluted === undefined);

// ------------------------------------------- 2. hostile entry-level fields
const hostileEntries = [
  { id: '', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: '', note: '' },
  { id: 'dup', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: '', note: '' },
  { id: 'dup', date: '2026-09-21', type: 'expense', method: 'AIB', category: 'gro', amount: 9, details: '', note: '' },
  { id: 'nan', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: NaN, details: '', note: '' },
  { id: 'inf', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: Infinity, details: '', note: '' },
  { id: 'neg', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: -5, details: '', note: '' },
  { id: 'huge', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 1e12, details: '', note: '' },
  { id: 'stringAmount', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: '5.50', details: '', note: '' },
  { id: 'badDate', date: '2026-13-45', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: '', note: '' },
  { id: 'emptyDate', date: '', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: '', note: '' },
  { id: 'badType', date: '2026-09-20', type: 'wat', method: 'AIB', category: 'gro', amount: 5, details: '', note: '' },
  { id: 'badMethod', date: '2026-09-20', type: 'expense', method: 'Bank', category: 'gro', amount: 5, details: '', note: '' },
  { id: 'badCategory', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'nope', amount: 5, details: '', note: '' },
  { id: 'objDetails', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: { a: 1 }, note: [] },
  { id: 'longDetails', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: 'x'.repeat(200000), note: 'y'.repeat(200000) },
  { id: 'badHistory', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: '', note: '', mutationHistory: 'nope' },
  { id: 'badAudio', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 5, details: '', note: '', audioData: 'javascript:alert(1)', audioType: 'text/html' },
];
const hostileOut = noThrow('validateState(hostile entries)', () => validateState({ entries: hostileEntries, settings: {} }));
check('hostile entries yield a valid state', looksLikeState(hostileOut));
if (looksLikeState(hostileOut)) {
  check('hostile entries all sanitised', hostileOut.entries.every(validEntry),
    JSON.stringify(hostileOut.entries.filter(e => !validEntry(e)).map(e => e.id)));
  check('duplicate ids collapsed', hostileOut.entries.filter(e => e.id === 'dup').length <= 1);
  check('id-less entry dropped', !hostileOut.entries.some(e => e.id === ''));
  check('non-finite amounts dropped', !hostileOut.entries.some(e => ['nan', 'inf'].includes(e.id)));
  check('bad dates dropped', !hostileOut.entries.some(e => ['badDate', 'emptyDate'].includes(e.id)));
  check('unknown type/method/category dropped', !hostileOut.entries.some(e => ['badType', 'badMethod', 'badCategory'].includes(e.id)));
  check('oversized text bounded', hostileOut.entries.every(e => e.details.length <= 5000 && e.note.length <= 10000));
  check('audio payload rejected', !hostileOut.entries.some(e => e.audioData != null));
}

// --------------------------------- 2b. one shape, and days that exist
// Two classes the fit-all audit found, both of them a rule with two answers.
//
// (a) `validateState` was not idempotent, because the DEFAULT document was a
// hand-written literal eight settings keys short of what the validator itself
// produces (customCategories, customMethods, methodHidden, recurring, coins,
// tescoRates, tescoWeekNos, tescoPayLedger — none of them in SEED_SETTINGS).
// Every reader guards with `|| []`/`|| {}`, so nothing broke: a fresh install
// simply ran its first session on a document its own validator would have
// rewritten, and the stored shape changed by itself on the second load. The pin
// below is the property, not the literal: whatever the junk-input path answers
// has the SAME settings shape as a validated document.
//
// (b) A date of the right shape but not a real day passed every check the app
// had. `Date.parse('2026-02-31')` answers a finite timestamp for March 3 — JS
// rolls the day over — so "the shape looks right" and "it parses" were both the
// wrong question; `isRealDate` in csv.js asks the round trip (read the day back
// out, compare it to what was written) and csvDate/isValidCheckpointDate/dateOk
// all delegate to it, because a rule with three implementations is a rule that
// can disagree with itself, silently.
check('a day that does not exist is not a date, in every form one arrives in',
  csvDate('2026-02-31') === null && csvDate('2026-04-31') === null
  && csvDate('2026-13-01') === null && csvDate('2026-00-10') === null
  && csvDate('31/02/2026') === null && csvDate('2026-02-31T10:00:00Z') === null,
  [csvDate('2026-02-31'), csvDate('31/02/2026')].join(' / '));
check('a real day still reads, leap years included, and a serial is a day count',
  csvDate('2026-10-01') === '2026-10-01' && csvDate('2026-1-1') === '2026-01-01'
  && csvDate('29/02/2024') === '2024-02-29' && csvDate('2024-02-29') === '2024-02-29'
  && csvDate('2026-02-29') === null && csvDate(45000) === '2023-03-15');
check('and the document validator asks the same one question',
  isValidCheckpointDate('2026-02-31') === false && isValidCheckpointDate('2024-02-29') === true
  && isValidCheckpointDate('2026-02-28') === true && isValidCheckpointDate('2026-2-8') === false);
check('a shift or payslip row dated the 31st of February is dropped, never rolled to March', (() => {
  const v = validateState({ entries: [], settings: {}, tesco: {
    shifts: [
      { id: 'rolled', date: '2026-02-31', hours: 8, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'real', date: '2026-03-03', hours: 8, createdAt: '2026-10-01T00:00:00.000Z' },
    ],
    payslips: [{ id: 'rolled', weekStart: '2026-02-31', paye: 1, createdAt: '2026-10-01T00:00:00.000Z' }],
  } });
  return v.tesco.shifts.length === 1 && v.tesco.shifts[0].id === 'real' && v.tesco.payslips.length === 0;
})(), 'a rollover would have kept both shifts');
check('the default document is a VALIDATED document — one shape, not two', (() => {
  const keys = (doc) => Object.keys(doc.settings).sort().join(',');
  const fresh = validateState(null);            // the junk-input answer loadState() hands a new device
  const full = validateState({ entries: [], settings: {} });
  return keys(fresh) === keys(full)
    && Array.isArray(fresh.settings.customCategories) && Array.isArray(fresh.settings.customMethods)
    && Array.isArray(fresh.settings.recurring) && fresh.settings.coins && typeof fresh.settings.coins === 'object'
    && !!fresh.settings.methodHidden && !!fresh.settings.tescoRates
    && !!fresh.settings.tescoWeekNos && !!fresh.settings.tescoPayLedger;
})(), Object.keys(validateState(null).settings).join(','));
check('validateState is idempotent — validating twice is validating once', (() => {
  const once = validateState({ entries: hostileEntries, settings: {} });
  const twice = validateState(once);
  const d1 = validateState(null);
  return JSON.stringify(twice) === JSON.stringify(once) && JSON.stringify(validateState(d1)) === JSON.stringify(d1);
})());
check('and the fresh document survives its own round trip byte-for-byte', (() => {
  localStorage = new MemoryStorage();
  const fresh = loadState();
  saveState(fresh);
  return JSON.stringify(loadState()) === JSON.stringify(fresh);
})());
check('the CSV reader answers no rows for no text rather than throwing',
  Array.isArray(csvRows(null)) && csvRows(null).length === 0 && csvRows(undefined).length === 0 && csvRows('').length === 0);
check('the export survives a labels argument that is not a table, like a hostile state',
  noThrow('entriesCsv(state, null)', () => entriesCsv({ entries: [null, 42, { date: '2026-09-20' }] }, null)) !== undefined);
check('an apostrophe the user typed is escaped, not eaten by the formula guard',
  csvCell("'=x") === "''=x" && csvUnquote(csvCell("'=x")) === "'=x"
  && csvUnquote(csvCell("'hello")) === "'hello" && csvUnquote(csvCell('=SUM(A1)')) === '=SUM(A1)'
  && csvUnquote("'12.40") === "'12.40",
  `${csvCell("'=x")} → ${csvUnquote(csvCell("'=x"))}`);
check('and the apostrophe guard still leaves a negative amount a number',
  csvCell(-56.08) === '-56.08' && csvUnquote(csvCell(-56.08)) === '-56.08' && isRealDate('2026-02-31') === false);

// ------------------------------------- 3. unreadable storage is not erased
const corruptBytes = '{"entries":[{"id":"keep-me"';
localStorage = new MemoryStorage({ [LIVE_KEY]: corruptBytes });
const corruptLoad = noThrow('loadState(corrupt)', () => loadState());
check('corrupt load still returns a usable state', looksLikeState(corruptLoad));
const backupKey = [...localStorage.map.keys()].find(k => k !== LIVE_KEY);
check('corrupt payload preserved for recovery', !!backupKey, `keys: ${[...localStorage.map.keys()].join(', ')}`);
check('preserved copy is byte-identical to what was stored', !backupKey || localStorage.getItem(backupKey) === corruptBytes);

// ------------------------------------- 4. a failed write must be reported
localStorage = new MemoryStorage();
saveState({ entries: [], settings: {} });
check('saveState reports success on a healthy write', saveState({ entries: [], settings: {} }) !== false);
localStorage = new MemoryStorage({}, { failWrites: true });
const failedWrite = noThrow('saveState(quota exceeded)', () => saveState({ entries: [], settings: {} }));
check('saveState reports failure when storage rejects the write', failedWrite === false, `returned ${String(failedWrite)}`);

// ------------------------------------- 5. one profile cannot read another
// Namespacing is the whole isolation story, so assert it here rather than in
// prose: another profile's document is never the active one's, and an unknown
// profile's keys are left exactly where they are.
const { nsKey, getActiveProfileId } = await import('../app/lib/profiles.ts');
const liveEntry = { id: 'live', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 1, details: '', note: '', createdAt: '2026-09-20T10:00:00.000Z' };
const liveState = JSON.stringify({ entries: [liveEntry], settings: { monthlyBudget: 1100 } });
const otherProfile = JSON.stringify({ entries: [], settings: { monthlyBudget: 999 } });
check('the active profile namespaces the live document', nsKey('state') === LIVE_KEY, nsKey('state'));
check('another profile gets its own document key', nsKey('state', 'sam') === 'cents:p/sam/state', nsKey('state', 'sam'));
localStorage = new MemoryStorage({ [LIVE_KEY]: liveState, 'cents:p/sam/state': otherProfile });
check('a second profile is not the active one', getActiveProfileId() === 'personal', getActiveProfileId());
const activeLoad = noThrow('loadState(with a second profile present)', () => loadState());
check('a second profile never replaces the active document',
  (activeLoad?.settings?.monthlyBudget) === 1100, `budget became ${activeLoad?.settings?.monthlyBudget}`);
check('the second profile is left untouched', localStorage.getItem('cents:p/sam/state') === otherProfile);
check('every namespaced base is distinct per profile',
  ['state', 'sync', 'privacy', 'bio', 'undo', 'alerts', 'quarantine']
    .every(base => nsKey(base, 'sam') !== nsKey(base, 'personal') && nsKey(base, 'sam').startsWith('cents:p/sam/')));

// ------------------------------------------------- 6. merge never loses data
const entry = (id, amount, updatedAt) => ({
  id, date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro',
  amount, details: id, note: '', createdAt: '2026-09-20T10:00:00.000Z', updatedAt,
});
const stateOf = (entries, settings = {}, extra = {}) => ({
  entries, settings: { deletedEntryIds: [], ...settings }, lastLocalChangeAt: '2026-09-20T12:00:00.000Z', ...extra,
});

const hostileMerges = [
  ['null/null', null, null], ['undefined/undefined', undefined, undefined],
  ['empty/empty', {}, {}], ['state/empty', stateOf([entry('a', 5)]), {}],
  ['empty/state', {}, stateOf([entry('b', 7)])],
  ['junk entries', stateOf([null, undefined, 'x']), stateOf([null, 42])],
  ['missing settings', { entries: [entry('c', 1)] }, { entries: [entry('d', 2)] }],
  ['null tesco', stateOf([entry('e', 1)], {}, { tesco: null }), stateOf([entry('f', 1)], {}, { tesco: 'x' })],
  ['hostile tesco', stateOf([entry('g', 1)], {}, { tesco: { shifts: [null, 'x', {}], payslips: 'no', deletedShiftIds: [null, 5] } }), stateOf([entry('h', 1)], {}, { tesco: { shifts: [{ id: 's1' }] } })],
];
for (const [label, a, b] of hostileMerges) {
  const out = noThrow(`mergeStates(${label})`, () => mergeStates(a, b));
  if (out !== undefined) check(`mergeStates(${label}) returns an object`, !!out && typeof out === 'object');
}

// Union: neither side's entries may vanish.
const left = stateOf([entry('l1', 10, '2026-09-20T11:00:00.000Z'), entry('shared', 20, '2026-09-20T09:00:00.000Z')]);
const right = stateOf([entry('r1', 30, '2026-09-20T11:30:00.000Z'), entry('shared', 99, '2026-09-20T11:45:00.000Z')], {}, { lastLocalChangeAt: '2026-09-20T13:00:00.000Z' });
const merged = noThrow('mergeStates(union)', () => mergeStates(left, right));
const ids = new Set((merged?.entries || []).map(e => e.id));
check('merge keeps both sides entries', ids.has('l1') && ids.has('r1'), `got ${[...ids].join(',')}`);
check('merge takes the newer version of a shared id', (merged?.entries || []).find(e => e.id === 'shared')?.amount === 99);
check('merge is idempotent', JSON.stringify(mergeStates(merged, left).entries?.map(e => e.id).sort()) === JSON.stringify(merged.entries.map(e => e.id).sort()));

// Tombstones: a deletion on either side wins.
const deleted = stateOf([], { deletedEntryIds: ['gone'] });
const stillThere = stateOf([entry('gone', 5)]);
check('merge honours a tombstone from either side', !(mergeStates(stillThere, deleted).entries || []).some(e => e.id === 'gone'));
check('merge honours a tombstone when the local side deleted', !(mergeStates(deleted, stillThere).entries || []).some(e => e.id === 'gone'));
check('tombstones union', (mergeStates(deleted, stateOf([], { deletedEntryIds: ['other'] })).settings.deletedEntryIds || []).length === 2);

// Settings collections: additive ones must not lose the other side's items.
const cats = (id, label) => ({ id, label });
const m1 = stateOf([], { customCategories: [cats('a', 'A')], recurring: [{ id: 'rec1', type: 'expense', details: 'Rent', amount: 500, method: 'AIB', category: 'rent', frequency: 'monthly', dayOfMonth: 1, nextDate: '2026-10-01' }] });
const m2 = stateOf([], { customCategories: [cats('b', 'B')] });
const merged2 = mergeStates(m1, m2);
check('custom categories union', (merged2.settings.customCategories || []).length === 2);
check('recurring survives a merge', (merged2.settings.recurring || []).some(r => r.id === 'rec1'));
const coinsA = stateOf([], { coins: { '1': 5 } });
const coinsB = stateOf([], { coins: { '2': 3 } });
const coinsMerged = mergeStates(coinsA, coinsB).settings.coins || {};
check('coins merge per denomination', Number(coinsMerged['1']) === 5 && Number(coinsMerged['2']) === 3);

// Tesco collections merge by id and honour tombstones.
const tA = stateOf([], {}, { tesco: { shifts: [{ id: 't1', date: '2026-09-20', start: '12:00', end: '20:00' }], payslips: [], deletedShiftIds: [] } });
const tB = stateOf([], {}, { tesco: { shifts: [{ id: 't2', date: '2026-09-21', start: '09:00', end: '17:00' }], payslips: [], deletedShiftIds: [] } });
check('tesco shifts union across devices', (mergeStates(tA, tB).tesco.shifts || []).length === 2);
const tDel = stateOf([], {}, { tesco: { shifts: [], payslips: [], deletedShiftIds: ['t1'] } });
check('tesco shift tombstone honoured', !(mergeStates(tA, tDel).tesco.shifts || []).some(s => s.id === 't1'));
check('tesco payslip tombstone honoured',
  !(mergeStates(stateOf([], {}, { tesco: { shifts: [], payslips: [{ id: 'p1', weekStart: '2026-09-20' }] } }),
    stateOf([], {}, { tesco: { shifts: [], payslips: [], deletedPayslipIds: ['p1'] } })).tesco.payslips || []).some(p => p.id === 'p1'));
// A tombstone has to survive validation or the delete never reaches the merge.
const tombstoneKept = validateState({ entries: [], settings: {}, tesco: { shifts: [], payslips: [], deletedShiftIds: ['t9'], deletedPayslipIds: ['p9'] } });
check('shift tombstones survive validation', (tombstoneKept.tesco.deletedShiftIds || []).includes('t9'),
  JSON.stringify(tombstoneKept.tesco.deletedShiftIds));
check('payslip tombstones survive validation', (tombstoneKept.tesco.deletedPayslipIds || []).includes('p9'));
// "Delete all weeks" tombstones every row of both tables in one burst, appended
// at the tail of the list. Validation trims that list to a cap, so the cap must
// be at least as large as the biggest possible tab (2000 shifts + 500 payslips),
// and the trim must drop the OLDEST ids: a device that has not merged since has
// to be told about the newest deletions, and discarding those resurrects the
// weeks the user just wiped on the next sync.
const manyIds = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`);
const wiped = validateState({ entries: [], settings: {}, tesco: { shifts: [], payslips: [], deletedShiftIds: manyIds(2000, 's'), deletedPayslipIds: manyIds(500, 'p') } });
check('a clear of the largest possible tab keeps every tombstone',
  (wiped.tesco.deletedShiftIds || []).length === 2000 && (wiped.tesco.deletedPayslipIds || []).length === 500,
  `${(wiped.tesco.deletedShiftIds || []).length} shifts / ${(wiped.tesco.deletedPayslipIds || []).length} payslips kept`);
const overflow = validateState({ entries: [], settings: {}, tesco: { shifts: [], payslips: [], deletedShiftIds: manyIds(3000, 's'), deletedPayslipIds: [] } });
const keptIds = overflow.tesco.deletedShiftIds || [];
check('over the cap the newest tombstones are the ones kept',
  keptIds.length === 2500 && keptIds[keptIds.length - 1] === 's02999' && !keptIds.includes('s00000'),
  `${keptIds.length} kept, newest ${keptIds[keptIds.length - 1]}`);

// ------------------------------------- 6b. admin-controlled tab visibility
// enabledTabs is a policy, not a collection: unioning it would let any device
// still listing a tab re-grant it after the admin hid it, and the dashboard can
// never be removed (it is the landing page and the only hub).
check('a document with no list shows every tab',
  validateState({ entries: [], settings: {} }).settings.enabledTabs.length === 6);
check('the dashboard survives a list that omits it',
  validateState({ entries: [], settings: { enabledTabs: ['add'] } }).settings.enabledTabs.join() === 'dashboard,add',
  JSON.stringify(validateState({ entries: [], settings: { enabledTabs: ['add'] } }).settings.enabledTabs));
check('unknown tab ids are dropped and the order is canonical',
  validateState({ entries: [], settings: { enabledTabs: ['insights', 'nope', 'dashboard', 'add'] } }).settings.enabledTabs.join() === 'dashboard,add,insights');
check('a hostile enabledTabs value cannot empty the nav',
  validateState({ entries: [], settings: { enabledTabs: 'all' } }).settings.enabledTabs.length === 6);

const restricted = stateOf([], { enabledTabs: ['dashboard', 'add'] }, { lastLocalChangeAt: '2026-09-20T14:00:00.000Z' });
const unrestricted = stateOf([], { enabledTabs: ['dashboard', 'add', 'history', 'balances', 'tesco', 'insights'] }, { lastLocalChangeAt: '2026-09-20T10:00:00.000Z' });
check('a tab restriction wins the merge from the fresher side',
  (mergeStates(unrestricted, restricted).settings.enabledTabs || []).join() === 'dashboard,add',
  JSON.stringify(mergeStates(unrestricted, restricted).settings.enabledTabs));
check('and is not undone when the older side is the local one',
  (mergeStates(restricted, unrestricted).settings.enabledTabs || []).join() === 'dashboard,add');
// A device that has not seen this feature writes no list at all; that must not
// read as "everything visible" and re-open the tab the admin closed.
const preFeature = stateOf([], {}, { lastLocalChangeAt: '2026-09-20T16:00:00.000Z' });
check('a document without the list cannot re-open a hidden tab',
  (mergeStates(restricted, preFeature).settings.enabledTabs || []).join() === 'dashboard,add',
  JSON.stringify(mergeStates(restricted, preFeature).settings.enabledTabs));

// ------------------------------------------------- 7. Tesco engine and CSV
const rates = { normal: 14.44, specialMultiplier: 1.5, pensionPct: 1.5, payeCredit: 76.93, payeCutoff: 846.15, payeRateLow: 20, payeRateHigh: 40, prsiRate: 4.2 };
check('paidHours clamps nonsense to zero', paidHours(600, 300) >= 0 && Number.isFinite(paidHours(600, 300)));
check('paidHours handles an overnight shift', noThrow('paidHours(overnight)', () => paidHours(1380, 420)) !== undefined);
check('shiftPay survives a missing date', noThrow('shiftPay(no date)', () => shiftPay({ date: '', start: '12:00', end: '20:00' }, rates)) !== undefined);
check('simulateTax(0) is finite', Number.isFinite(simulateTax(0, rates).tax));
check('simulateTax(1e9) is finite', Number.isFinite(simulateTax(1e9, rates).tax));
check('simulateTax(NaN) is finite', Number.isFinite(simulateTax(NaN, rates).tax));

const hostileCsv = [
  ['empty', ''],
  ['header only', 'Date,Start Time,End Time'],
  ['unclosed quote', 'Date,Start Time,End Time\n2026-09-20,12:00,20:00\n"oops'],
  ['junk rows', 'Date,Start Time,End Time\nnope,yes,maybe\n,,'],
  ['huge field', 'Date,Start Time,End Time,Description\n2026-09-20,12:00,20:00,' + 'x'.repeat(50000)],
  ['html in note', 'Date,Start Time,End Time,Description\n2026-09-20,12:00,20:00,<img src=x onerror=alert(1)>'],
  ['formula note', 'Date,Start Time,End Time,Description\n2026-09-20,12:00,20:00,=cmd|calc'],
];
for (const [label, csv] of hostileCsv) {
  const out = noThrow(`parseTescoCsv(${label})`, () => parseTescoCsv(csv));
  if (out !== undefined) {
    check(`parseTescoCsv(${label}) returns a result`, !!out && typeof out === 'object' && (out.shifts === undefined || Array.isArray(out.shifts)));
    // The parser returns shift INPUTS (date/start/end/special/note); ids are
    // assigned by the import handler, so the contract here is the date shape.
    if (Array.isArray(out.shifts)) check(`parseTescoCsv(${label}) yields valid shifts`, out.shifts.every(s => s && typeof s === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && typeof s.start === 'string' && typeof s.end === 'string'));
  }
}
const roundTrip = noThrow('tescoCsv round trip', () => {
  const shifts = [{ id: 'x1', date: '2026-09-20', start: '12:00', end: '20:00', note: 'notes, "quoted",\nnewline' }];
  return parseTescoCsv(tescoCsv(shifts, [], rates, new Map())).shifts;
});
check('CSV round trip keeps the awkward note verbatim', roundTrip && roundTrip[0] && roundTrip[0].note === 'notes, "quoted",\nnewline',
  roundTrip && roundTrip[0] ? JSON.stringify(roundTrip[0].note) : 'no shift parsed');

// ------------------------------- 8. the other half of a backup: reading it back
// "Export data" was a one-way door until parseBackup existed: the notice a full
// quota raises tells the user to export a backup, and nothing could open one.
// A restore is a merge, so the rules that matter are (a) what a file has to look
// like to be read at all and (b) that reading it can never quietly set the lock
// or resurrect a reset.
const backupEntry = (id, amount) => ({
  id, date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro',
  amount, details: id, note: '', createdAt: '2026-09-20T10:00:00.000Z',
});
// Every refusal is pinned by its REASON, not just by "it said no": the caller
// words each one for the user, and a file refused as unreadable when it was
// really unsupported sends them looking for the wrong problem.
const refused = [
  ['empty', '', 'empty'],
  ['blank', '   \n ', 'empty'],
  ['not json', 'not json at all', 'unreadable'],
  ['truncated', '{"entries":[{"id":"a"', 'unreadable'],
  ['an array', '[]', 'not-a-backup'],
  ['a number', '42', 'not-a-backup'],
  ['no entries list', JSON.stringify({ settings: { monthlyBudget: 500 } }), 'not-a-backup'],
  ['entries not a list', JSON.stringify({ entries: {} }), 'not-a-backup'],
  ['oversized', 'x'.repeat(MAX_BACKUP_BYTES + 1), 'too-large'],
];
for (const [label, text, reason] of refused) {
  const verdict = noThrow(`parseBackup(${label})`, () => parseBackup(text));
  check(`parseBackup refuses ${label}`, verdict && verdict.ok === false,
    verdict ? JSON.stringify(verdict).slice(0, 80) : 'undefined');
  check(`  and says why (${label})`, verdict && verdict.reason === reason,
    verdict ? String(verdict.reason) : 'undefined');
}
const WORDED = ['empty', 'too-large', 'unreadable', 'not-a-backup'];
check('every refusal reason is one the UI can word',
  refused.every(([, , reason]) => WORDED.includes(reason)));
// The size cap has to be checked BEFORE the parse, so a file that is too big is
// refused for being too big rather than reported as unreadable JSON. Both caps
// are pinned by their reason: the byte cap, and the entry cap (which can only be
// reached by a document that PARSES, so it is the cap doing the refusing).
check('an oversized file is refused for its size, not its content',
  parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1)).reason === 'too-large',
  parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1)).reason);
check('a document that parses but is absurd is still refused',
  parseBackup(JSON.stringify({ entries: new Array(MAX_BACKUP_ENTRIES + 1).fill(null), settings: {} })).reason === 'too-large',
  parseBackup(JSON.stringify({ entries: new Array(MAX_BACKUP_ENTRIES + 1).fill(null), settings: {} })).reason);

const realBackup = stateOf([backupEntry('b1', 5), backupEntry('b2', 7)], { monthlyBudget: 900 });
const readBack = noThrow('parseBackup(a real export)', () => parseBackup(JSON.stringify(realBackup, null, 2)));
check('a real export is read back whole', readBack && readBack.ok === true && readBack.kept === 2 && readBack.dropped === 0,
  JSON.stringify({ ok: readBack && readBack.ok, kept: readBack && readBack.kept, dropped: readBack && readBack.dropped }));
check('and its settings come with it', readBack?.state?.settings?.monthlyBudget === 900);
const partial = parseBackup(JSON.stringify({ entries: [backupEntry('b1', 5), { id: 'junk' }, null], settings: {} }));
check('a half-readable backup reports what it could not take',
  partial.ok === true && partial.kept === 1 && partial.dropped === 2,
  JSON.stringify({ kept: partial.kept, dropped: partial.dropped }));

// The two things a file may never bring with it. `pinHash` is the serious one:
// validateState MIGRATES a legacy hash into device storage when the device has
// no PIN, so a hostile file would otherwise get to set this device's lock — and
// the app's own export deletes the key, so stripping it costs a real backup
// nothing. `localResetAt` is a whole-document tombstone that later data
// supersedes; a restored copy of one would re-assert a reset it lost to.
const hadPin = !!(getPrivacyPin() && getPrivacyPin().hash);
const hostileFile = parseBackup(JSON.stringify({
  entries: [backupEntry('b1', 5)],
  settings: { pinHash: 'a'.repeat(64) },
  localResetAt: '2026-09-19T00:00:00.000Z',
}));
check('a file cannot smuggle in PIN material', hostileFile.ok === true && hostileFile.state.settings.pinHash === undefined,
  String(hostileFile?.state?.settings?.pinHash));
check('and installing one never sets the device PIN', hadPin || !(getPrivacyPin() && getPrivacyPin().hash),
  'the file set a device PIN');
check('a file cannot re-assert an old reset', hostileFile.state.localResetAt === undefined, String(hostileFile.state.localResetAt));

// ------------------------------- 9. two tabs are two copies of one document
// Nothing tells a tab that another tab wrote, and every save replaces the whole
// file, so the tab that writes second erases the other's new entry. The guard
// merges the two documents and writes the union back — and foreignWriteNeeded()
// is what stops the pair writing at each other forever: after one round trip
// neither side holds anything the other lacks, so nobody writes again.
const tabA = stateOf([entry('a1', 5, '2026-09-20T11:00:00.000Z')]);
const tabB = stateOf([entry('b1', 9, '2026-09-20T11:30:00.000Z')]);
const aneMerge = mergeStates(tabA, tabB);
check('the union keeps both tabs\u2019 entries', aneMerge.entries.length === 2,
  JSON.stringify(aneMerge.entries.map(e => e.id)));
check('the tab holding something the writer missed writes it back',
  foreignWriteNeeded(aneMerge, tabB) === true);
check('and the writer, once caught up, does not write again',
  foreignWriteNeeded(mergeStates(tabB, aneMerge), aneMerge) === false);
check('a newer version of a shared entry is worth writing',
  foreignWriteNeeded(mergeStates(tabA, { ...tabA, entries: [entry('a1', 5, '2026-09-20T12:00:00.000Z')] }), tabA) === true);
check('a deletion is content too',
  foreignWriteNeeded(stateOf([], { deletedEntryIds: ['a1'] }), stateOf([], { deletedEntryIds: [] })) === true);
check('a Tesco row the writer did not have is content',
  foreignWriteNeeded({ ...tabB, tesco: { shifts: [{ id: 's1', date: '2026-09-20' }], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] } }, tabB) === true);
check('so is a balance checkpoint',
  foreignWriteNeeded(
    stateOf([], { balanceCheckpoints: { AIB: [{ date: '2026-09-20', balance: 10 }] } }),
    stateOf([], { balanceCheckpoints: { AIB: [] } }),
  ) === true);
check('an identical document is not worth a write', foreignWriteNeeded(tabB, tabB) === false);
check('a hostile incoming value cannot throw the guard',
  noThrow('foreignWriteNeeded(junk)', () => foreignWriteNeeded({ entries: 'x', settings: null, tesco: 5 }, null)) !== undefined);

// ------------------------------- 10. the quarantined copy is reachable again
// loadState parks a document it could not parse instead of dropping it; until
// now nothing could reach it, and the notice named a storage key at a user who
// has no way to open one. Both halves of the recovery are pinned here: bytes
// that parse are offered as a merge, bytes that do not are offered as a
// download (because they are the only copy of that ledger).
const brokenText = '{"entries":[{"id":"keep-me"';
localStorage = new MemoryStorage({ [LIVE_KEY]: brokenText });
noThrow('loadState(corrupt, again)', () => loadState());
check('the unreadable copy can be read back off the device', unreadableBackup() === brokenText,
  String(unreadableBackup()).slice(0, 40));
check('and it is offered as a download, not a merge', parseBackup(unreadableBackup()).ok === false);
// The second-tab guard re-reads the document through this, so it has to be the
// ACTIVE profile's live key and never the quarantined copy sitting beside it.
const liveText = JSON.stringify(stateOf([backupEntry('live1', 1)]));
localStorage = new MemoryStorage({ [LIVE_KEY]: liveText, 'cents:p/personal/quarantine': brokenText });
check('the guard reads the live document, not the quarantined copy beside it',
  readStateText() === liveText, String(readStateText()).slice(0, 40));
const salvageable = JSON.stringify({ entries: [backupEntry('s1', 3), { id: '' }], settings: {} });
localStorage = new MemoryStorage({ [LIVE_KEY]: salvageable });
noThrow('loadState(salvageable)', () => loadState());
const salvage = parseBackup(unreadableBackup() || salvageable);
check('a copy that still parses is offered as a merge', salvage.ok === true && salvage.kept === 1,
  JSON.stringify({ ok: salvage.ok, kept: salvage.kept }));

// ------------------------------------------- 11. the ledger as a spreadsheet
// "Export CSV" writes every entry as one row a spreadsheet can read, and — as of
// the importer — section 14 reads that file back. What has to hold on the way
// out: the columns are the ones the reader expects, a label is worded the way
// the screen words it, a number stays a number, and a field that would be read
// as a formula is defused rather than executed on open.
const csvLabels = { category: (id) => ({ gro: 'Groceries', misc: 'Misc' }[id] || id), method: (id) => ({ AIB: 'AIB bank', RS: 'Revolut Savings' }[id] || id) };
const csvRow = (id, extra = {}) => ({
  id, date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro',
  amount: 12.4, details: id, note: '', createdAt: '2026-09-20T10:00:00.000Z', ...extra,
});
const csvOf = (entries) => entriesCsv(stateOf(entries), csvLabels);
const csvLines = (entries) => csvOf(entries).replace(/\r\n$/, '').split('\r\n');

check('the header is the columns the export promises',
  csvOf([]) === `${ENTRIES_CSV_HEADER.join(',')}\r\n`, JSON.stringify(csvOf([])));
check('one entry is one row, in column order',
  csvLines([csvRow('a')])[1] === '2026-09-20,expense,Groceries,a,12.40,AIB bank,', csvLines([csvRow('a')])[1]);
check('the label resolver is what names the category and the method',
  csvOf([csvRow('a')]).includes('Groceries') && csvOf([csvRow('a')]).includes('AIB bank'));
// No resolvers is what a caller outside app.js hands over (a guard, a script);
// the stored ids are a worse label but never a throw or a blank column.
check('without resolvers the ids stand in rather than nothing',
  entriesCsv(stateOf([csvRow('a')])).includes(',gro,') === true,
  JSON.stringify(entriesCsv(stateOf([csvRow('a')]))));
check('an amount is two decimals and never quoted',
  csvLines([csvRow('a', { amount: 5 })])[1].includes(',5.00,'), csvLines([csvRow('a', { amount: 5 })])[1]);
// The apostrophe guard must not reach a number: it would turn a tax refund into
// text that no spreadsheet and no database load would read as a value.
check('a negative amount stays a number', csvCell(-56.08) === '-56.08', csvCell(-56.08));
// The view export hands entriesCsv an ALREADY-ORDERED list — the History
// screen's own order, which is oldest-first when the toggle is flipped and a
// ranking when a query is typed — and that order must survive. The file's
// newest-first sort is the FULL export's contract, not a law imposed on a
// caller's view.
{
  const older = csvRow('older', { date: '2026-09-01' });
  const newer = csvRow('newer', { date: '2026-09-30' });
  const viewLines = entriesCsv(stateOf([newer, older]), csvLabels, [older, newer])
    .replace(/\r\n$/, '').split('\r\n');
  check('a caller-supplied order is taken as given',
    viewLines[1].startsWith('2026-09-01,') && viewLines[2].startsWith('2026-09-30,'),
    JSON.stringify(viewLines.slice(1)));
  const fullLines = csvLines([newer, older]);
  check('the full export keeps its newest-first contract',
    fullLines[1].startsWith('2026-09-30,'), JSON.stringify(fullLines.slice(1)));
}
check('a comma in a note is quoted, not split into two columns',
  csvCell('bread, milk and eggs') === '"bread, milk and eggs"', csvCell('bread, milk and eggs'));
check('a newline in a note stays inside one field',
  csvCell('line one\nline two') === '"line one\nline two"', csvCell('line one\nline two'));
check('a doubled quote survives', csvCell('he said "hi"') === '"he said ""hi"""', csvCell('he said "hi"'));
// The reason csv.js exists: a field a spreadsheet would EXECUTE. Notes arrive
// typed, from another app's file, and in a synced cloud copy.
const evilCell = csvCell('=HYPERLINK("http://x","click")');
check('a formula-looking field is defused with an apostrophe',
  // Quoted (it holds commas and quotes) and then apostrophe-guarded: no cell a
  // spreadsheet would run is left standing.
  evilCell.startsWith('"\'=') && evilCell.endsWith(')"'), evilCell);
check('so is a leading +, - or @ after whitespace',
  csvCell('@break') === "'@break" && csvCell('  +1') === "'  +1", `${csvCell('@break')} / ${csvCell('  +1')}`);
check('the guard is reversible, so nothing is lost on the way back',
  csvUnquote(csvCell('@break')) === '@break' && csvUnquote(csvCell('=SUM(A1)')) === '=SUM(A1)');
check('and it does not touch a name that merely contains an apostrophe',
  csvUnquote("O'Brien") === "O'Brien", csvUnquote("O'Brien"));
check('the rows end with CRLF and a trailing newline, the way every tool writes them',
  csvOf([csvRow('a')]).endsWith('\r\n') && csvDocument([['a'], ['b']]) === 'a\r\nb\r\n', JSON.stringify(csvDocument([['a'], ['b']])));
check('newest first, and two on one day break the tie by when they were written',
  csvLines([
    csvRow('older', { date: '2026-09-19' }),
    csvRow('first', { date: '2026-09-20', createdAt: '2026-09-20T09:00:00.000Z' }),
    csvRow('second', { date: '2026-09-20', createdAt: '2026-09-20T11:00:00.000Z' }),
  ]).slice(1).map(line => line.split(',')[3]).join('|') === 'second|first|older',
  csvLines([
    csvRow('older', { date: '2026-09-19' }),
    csvRow('first', { date: '2026-09-20', createdAt: '2026-09-20T09:00:00.000Z' }),
    csvRow('second', { date: '2026-09-20', createdAt: '2026-09-20T11:00:00.000Z' }),
  ]).map(line => line.split(',')[3]).join('|'));
check('a note that reads as a formula reaches the file defused',
  csvOf([csvRow('a', { note: '=cmd|calc' })]).includes("'=cmd|calc"), csvOf([csvRow('a', { note: '=cmd|calc' })]));
// The pure text carries no BOM — the byte is added at the file boundary, so what
// the tests compare is what csvDocument() produced.
check('the text itself has no byte-order mark', entriesCsv(stateOf([])).charCodeAt(0) !== 0xFEFF && CSV_BOM === '\uFEFF');
check('a document with no entries is still a file with a header', csvLines([]).length === 1);
check('a hostile document cannot throw the export',
  noThrow('entriesCsv(junk)', () => entriesCsv({ entries: [null, 42, 'x', { date: '2026-09-20' }] })) !== undefined);

// ------------------------------------- 12. a payment method the user owns
// The methods an entry may carry are the built-ins plus the user's own
// (settings.customMethods). Removing one from the pickers is a TOMBSTONE
// (settings.methodHidden), never a deletion, and two of these four rules are
// ledger-destroying paths if they break:
//   * validateEntry DROPS an entry whose method it does not know, so a removal
//     that took the id out of the allowed set would delete that entry's history
//     at the next load — a deletion that never appears as one;
//   * an entry being EDITED must keep offering the method it was recorded with,
//     because the form resets its value to the first option that is offered, so
//     a removed method would silently move the money on Save.
// The first is asserted through storage.js here; the second only exists in
// app.js, which cannot be imported in Node (it touches the DOM on evaluation),
// so it is pinned against the source text — the same technique
// scripts/test-motion.mjs uses for paintFigure.
const ownMethod = (id) => ({ entries: [{ id: `m-${id}`, date: '2026-09-20', type: 'expense', category: 'gro', details: 'x', amount: 1, method: id, note: '', createdAt: '2026-09-20T10:00:00.000Z' }] });
const methodState = (raw) => validateState(raw);

const added = methodState({ ...ownMethod('boi'), settings: { customMethods: [{ id: 'boi', label: 'Bank of Ireland' }] } });
check('a method the user added round-trips, and its entry with it',
  added.settings.customMethods.length === 1 && added.entries.length === 1,
  `${JSON.stringify(added.settings.customMethods)} / ${added.entries.length} entry`);

const removed = methodState({
  entries: [...ownMethod('boi').entries, ...ownMethod('LG').entries, ...ownMethod('Cash').entries],
  settings: { customMethods: [{ id: 'boi', label: 'Bank of Ireland' }], methodHidden: { boi: true, LG: true, Cash: true, nope: true, AIB: false, RS: 'yes', TG: 1 } },
});
check('an entry whose method was removed from the pickers is KEPT, not dropped',
  removed.entries.length === 3, `${removed.entries.length} of 3 kept`);
check('a method storage.js has never heard of is still refused',
  methodState(ownMethod('Nonsense')).entries.length === 0);
check('the flag map keeps a known id with a boolean, and drops everything else',
  JSON.stringify(Object.entries(removed.settings.methodHidden).sort())
    === JSON.stringify([['AIB', false], ['Cash', true], ['LG', true], ['boi', true]]),
  JSON.stringify(removed.settings.methodHidden));
check('a method storage.js never heard of cannot be flagged at all',
  removed.settings.methodHidden.nope === undefined);
// The false is a value, not an absence, and it has to survive validation — it is
// the whole reason a restore can beat the other device's true in a merge.
check('a restored (false) flag survives the load rather than being pruned away',
  removed.settings.methodHidden.AIB === false, JSON.stringify(removed.settings.methodHidden.AIB));
check('an id that collides with a built-in is not a second method',
  methodState({ entries: [], settings: { customMethods: [{ id: 'Cash', label: 'cash' }, { id: 'CASH', label: 'cash two' }] } }).settings.customMethods.length === 0,
  JSON.stringify(methodState({ entries: [], settings: { customMethods: [{ id: 'Cash', label: 'cash' }, { id: 'CASH', label: 'cash two' }] } }).settings.customMethods));
check('junk in either list cannot throw the load',
  noThrow('customMethods junk', () => methodState({ entries: [], settings: { customMethods: 'nope', methodHidden: 42 } })) !== undefined);

// A merge unions the catalogue (a method added on either device survives) and
// takes the tombstone per key from the fresher side — which is what lets a
// removal travel from one device and a RESTORE travel back. Note what is not
// unioned: the catalogue, because a removal cannot be expressed by deleting
// from a list that a union would refill.
const newer = { lastLocalChangeAt: '2026-09-21T12:00:00.000Z' };
const older = { lastLocalChangeAt: '2026-09-20T12:00:00.000Z' };
const catalogue = (settings, when) => stateOf([], settings, when);
const unioned = mergeStates(
  catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: { a: true } }, older),
  catalogue({ customMethods: [{ id: 'b', label: 'B' }] }, newer),
).settings;
check('the method catalogue unions across devices',
  (unioned.customMethods || []).map(m => m.id).join(',') === 'a,b', JSON.stringify(unioned.customMethods));
check('a removal on the older device survives a merge', unioned.methodHidden?.a === true, JSON.stringify(unioned.methodHidden));
// The reason a restore is written as false rather than as a deleted key: a
// spread can overwrite a key but never remove one, so an absence would lose to
// the other side's true here and the method would come back hidden on its own.
const restored = mergeStates(
  catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: { a: true } }, older),
  catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: { a: false } }, newer),
).settings;
check('and a restore on the fresher device beats the other side\u2019s removal',
  restored.methodHidden?.a === false, JSON.stringify(restored.methodHidden));
const restoredOlder = mergeStates(
  catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: {} }, older),
  catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: { a: false } }, newer),
).settings;
check('a restore stands even when the other side never touched the method',
  restoredOlder.methodHidden?.a === false, JSON.stringify(restoredOlder.methodHidden));
check('and a removal simply overrides it the other way',
  mergeStates(
    catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: { a: false } }, older),
    catalogue({ customMethods: [{ id: 'a', label: 'A' }], methodHidden: { a: true } }, newer),
  ).settings.methodHidden?.a === true);

// The wiring in app.js that keeps the rules above true in the UI.
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
// The Insights screen split into its own deferred module in the boot split (~39
// KB of chart drawing, parsed when the tab is first opened), so the pins about
// THAT screen read its text instead: left on app.js they would pass against
// code they no longer describe.
const insightsSource = readFileSync(new URL('../insights.js', import.meta.url), 'utf8');
check('no picker is built from the seed list (the user\u2019s own methods would vanish)',
  !/\bMETHODS\.map\s*\(/.test(appSource),
  (appSource.match(/\bMETHODS\.map\s*\(/g) || []).join(', '));
check('a method label resolves through the document, not a seed-only lookup',
  /function methodLabel\(id\)\s*{\s*return methodById\(id\)\?/.test(appSource));
check('the shared entry form keeps the current method for an entry being EDITED',
  /const ids = initial \? methodPickerIds\(data\.method/.test(appSource));
// Named sites rather than a count: validateState() already re-allows a
// document's own methods, so these two calls are belt-and-braces — but they are
// the readable statement of the rule, and the count of "how many calls exist"
// would be satisfied by any one of them surviving. The boot pair keeps the app
// consistent with the document it just loaded; adoptState is the import /
// restore / cloud path, and it must not leave the previous document's list in
// place while the new one's entries are validated on the way in.
const syncsMethodsWithin = (marker, span = 1200) => {
  const at = appSource.indexOf(marker);
  return at >= 0 && /updateAllowedMethods\(/.test(appSource.slice(at, at + span));
};
check('the boot set stays in sync with the document that was loaded',
  syncsMethodsWithin('// Keep storage.js validation sets in sync'));
check('adopting a document (import, restore, cloud) re-allows its own methods',
  syncsMethodsWithin('function adoptState('));
check('and adding one through the manager does too, before it is saved',
  /state\.settings\.customMethods\.push\(\{ id, label: raw \}\);\s*[\s\S]{0,700}?updateAllowedMethods\(/.test(appSource));
check('the manager is reachable from the menu',
  /label: 'Payment methods'[^}]*openMethodManager\(\)/.test(appSource));

// ------------------- 13. what the ledger has already been told about Tesco pay
// settings.tescoPayLedger is `{ [payDate]: { id, amount } }` — the Balances line
// this app wrote for a pay date, and the figure it wrote it at
// (tescoPayLedgerWrites in tesco-pay.js is the rule that reads it). It carries
// three behaviours, and each is a bug if the load or the merge loses it: a
// corrected week follows the line this app wrote, a line the user edited by hand
// does not, and a line the user DELETED is never written back.
const ledgerState = (record) => validateState(stateOf([], { tescoPayLedger: record })).settings.tescoPayLedger;
const wired = ledgerState({ '2026-10-01': { id: 'w1', amount: 469.78 } });
check('a written line round-trips with its entry id and amount',
  wired['2026-10-01']?.id === 'w1' && wired['2026-10-01'].amount === 469.78,
  JSON.stringify(wired));
// `by: 'fill'` is the tag that says a line is the USER's own fill rather than
// one the recorder wrote: it is what stops a hand-filled Thursday deleted in
// History from being written back at the next Tesco commit, and what keeps the
// "Remove automatic Tesco pay lines" repair from counting it. Losing it on a
// load turns a fill into a recorder line, which is a delete that comes back and
// a repair that eats the user's own income.
const fillTagged = ledgerState({ '2026-10-02': { id: 'f1', amount: 450, by: 'fill' } });
check('a fill mark keeps its tag through a load',
  fillTagged['2026-10-02']?.by === 'fill' && fillTagged['2026-10-02']?.amount === 450,
  JSON.stringify(fillTagged));
const untagged = ledgerState({ '2026-10-03': { id: 'a1', amount: 450 } });
check('a mark with no tag is still the recorder\'s own',
  !('by' in (untagged['2026-10-03'] || {})), JSON.stringify(untagged));
const oddTag = ledgerState({ '2026-10-04': { id: 'b1', amount: 450, by: 'fill me' } });
check('an unrecognised tag is not read as a fill',
  !('by' in (oddTag['2026-10-04'] || {})), JSON.stringify(oddTag));
const junkLedger = ledgerState({
  '2026-10-01': { id: 'w1', amount: 469.78 },
  'not-a-date': { id: 'w2', amount: 10 },
  '2026-10-02': { id: '', amount: 10 },
  '2026-10-03': { id: 'w3' },
  '2026-10-04': { id: 'w4', amount: 0 },
  '2026-10-05': { id: 'w5', amount: 12.345 },
  '2026-10-06': { id: 'w6', amount: -5 },
  '2026-10-07': 'nope',
  '2026-10-08': { id: 'x'.repeat(201), amount: 10 },
});
check('a malformed line is dropped rather than repaired',
  JSON.stringify(junkLedger) === JSON.stringify({ '2026-10-01': { id: 'w1', amount: 469.78 } }),
  JSON.stringify(junkLedger));
check('and junk in the whole setting cannot throw the load',
  noThrow('tescoPayLedger junk', () => ledgerState(42)) !== undefined
  && JSON.stringify(ledgerState('x')) === '{}');
// A date key that survives is what makes a deleted line stay deleted, so the two
// sides of a merge must not be able to lose one another: a date only ONE device
// has survives, and a shared date takes the fresher side's pair whole.
const ledgerMerge = (localRecord, cloudRecord, localFresher) => mergeStates(
  catalogue({ tescoPayLedger: localRecord }, localFresher ? newer : older),
  catalogue({ tescoPayLedger: cloudRecord }, localFresher ? older : newer),
).settings.tescoPayLedger;
const bothSides = ledgerMerge({ '2026-10-01': { id: 'a1', amount: 450 } }, { '2026-10-08': { id: 'b1', amount: 460 } }, true);
check('a line written only on one device survives the merge',
  bothSides['2026-10-01']?.id === 'a1' && bothSides['2026-10-08']?.id === 'b1',
  JSON.stringify(bothSides));
check('and a date both sides wrote takes the fresher pair as one value',
  JSON.stringify(ledgerMerge({ '2026-10-01': { id: 'a1', amount: 450 } }, { '2026-10-01': { id: 'b1', amount: 469.78 } }, true)['2026-10-01'])
    === JSON.stringify({ id: 'a1', amount: 450 }),
  JSON.stringify(ledgerMerge({ '2026-10-01': { id: 'a1', amount: 450 } }, { '2026-10-01': { id: 'b1', amount: 469.78 } }, false)['2026-10-01']));
// The tag rides the same whole-value rule: a fill recognised on one device
// stays a fill after a merge, and a fresher mark from the other device replaces
// the pair — tag and all — rather than blending the two sides' opinions.
check('a fill tag travels with the pair it belongs to',
  ledgerMerge({ '2026-10-05': { id: 'a1', amount: 450, by: 'fill' } },
    { '2026-10-06': { id: 'b1', amount: 460 } }, true)['2026-10-05']?.by === 'fill',
  JSON.stringify(ledgerMerge({ '2026-10-05': { id: 'a1', amount: 450, by: 'fill' } },
    { '2026-10-06': { id: 'b1', amount: 460 } }, true)));
check('and a fresher recorder mark replaces the whole value, tag included',
  !('by' in (ledgerMerge({ '2026-10-07': { id: 'a1', amount: 450, by: 'fill' } },
    { '2026-10-07': { id: 'b1', amount: 469.78 } }, false)['2026-10-07'] || {})),
  JSON.stringify(ledgerMerge({ '2026-10-07': { id: 'a1', amount: 450, by: 'fill' } },
    { '2026-10-07': { id: 'b1', amount: 469.78 } }, false)));

// The record is the reason a delete sticks, so it must not be the thing that
// grows without bound: the pay tables it shadows hold 500 weeks, and anything
// older than the cap could never be read again anyway.
const manyDates = {};
for (let i = 0; i < 530; i++) {
  const d = new Date(Date.UTC(2020, 0, 2));
  d.setUTCDate(d.getUTCDate() + i * 7);
  manyDates[d.toISOString().slice(0, 10)] = { id: `id${i}`, amount: 100 };
}
check('the record is bounded, keeping the newest pay dates',
  (() => { const kept = ledgerState(manyDates); const dates = Object.keys(kept).sort(); return [dates.length, dates.includes('2020-01-02'), dates.includes(dates[dates.length - 1])]; })(),
  [520, false, true]);

// ------------------------- 14. the spreadsheet, read back
// The export's counterpart, and the same promise section 8 makes for JSON:
// parseEntriesCsv() never throws, refuses with a reason the UI can word, and
// reports how much survived — plus one promise the CSV uniquely needs, because
// the file carries NO IDS: importing the same export twice must not double the
// ledger, so a row identical to one already here is counted and skipped rather
// than added again (multiset, so two identical coffees import both when neither
// is here and neither twice when both are).
// check() takes a CONDITION (a bare got/want pair would be truthy and never
// fail), so the comparisons below go through `same`.
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const csvImportLabels = {
  category: label => ({ Groceries: 'gro', Misc: 'misc' }[label] || null),
  method: label => ({ 'AIB bank': 'AIB', 'Revolut Savings': 'RS' }[label] || null),
};
const csvExportFile = entriesCsv(stateOf([
  csvRow('a', { note: 'bread, milk' }),
  csvRow('b', { type: 'credit', category: 'misc', method: 'RS', amount: 50, note: '=cmd|calc' }),
]), csvLabels);
const csvLedger = stateOf([
  csvRow('a', { note: 'bread, milk' }),
  csvRow('b', { type: 'credit', category: 'misc', method: 'RS', amount: 50, note: '=cmd|calc' }),
]).entries;
const imported = noThrow('parseEntriesCsv(a real export)', () => parseEntriesCsv(csvExportFile, csvImportLabels, []));
check('a real export reads back whole',
  imported?.ok === true && imported.kept === 2 && imported.dropped === 0 && imported.duplicates === 0,
  JSON.stringify(imported && { kept: imported.kept, dropped: imported.dropped, duplicates: imported.duplicates }));
const byDetails = Object.fromEntries((imported?.entries || []).map(e => [e.details, e]));
check('the label a screen showed comes back as the id it was exported from',
  same([byDetails.a?.category, byDetails.a?.method, byDetails.b?.category, byDetails.b?.method],
    ['gro', 'AIB', 'misc', 'RS']));
check('a note with a comma and a note that reads as a formula come back verbatim',
  same([byDetails.a?.note, byDetails.b?.note], ['bread, milk', '=cmd|calc']));
check('and so do the date, the type and the amount at its own precision',
  same([byDetails.a?.date, byDetails.a?.type, byDetails.a?.amount, byDetails.b?.amount],
    ['2026-09-20', 'expense', 12.4, 50]));
// The double-import footgun: export writes no ids, so identity can only be by
// content — and without this the second import of one file would be a second
// copy of the whole ledger.
const secondImport = parseEntriesCsv(csvExportFile, csvImportLabels, csvLedger);
check('importing the same file against the same ledger adds nothing',
  same([secondImport.kept, secondImport.dropped, secondImport.duplicates], [0, 0, 2]));
const twinsFile = entriesCsv(stateOf([
  csvRow('t1', { details: 'same coffee' }),
  csvRow('t2', { details: 'same coffee' }),
]), csvLabels);
const oneHere = stateOf([csvRow('t0', { details: 'same coffee' })]).entries;
const twinsVsOne = parseEntriesCsv(twinsFile, csvImportLabels, oneHere);
check('with one copy of an identical row here, the other copy still imports',
  same([twinsVsOne.kept, twinsVsOne.duplicates], [1, 1]));
check('with neither here, both copies import', parseEntriesCsv(twinsFile, csvImportLabels, []).kept === 2);
const twinsVsBoth = parseEntriesCsv(twinsFile, csvImportLabels, oneHere.concat(oneHere));
check('with both here, neither imports again',
  same([twinsVsBoth.kept, twinsVsBoth.duplicates], [0, 2]));
// Every refusal pinned by its REASON — the caller words each one for the user,
// and a file refused as "no header" when it was really too big sends them
// looking for the wrong problem.
const csvRefused = [
  ['empty', '', 'empty'],
  ['blank', ' \n \t', 'empty'],
  ['no header', 'foo,bar\r\n1,2\r\n', 'no-header'],
  ["someone else's csv", 'name,email\r\nSam,sam@x\r\n', 'no-header'],
  ['oversized', 'x'.repeat(MAX_BACKUP_BYTES + 1), 'too-large'],
];
for (const [label, text, reason] of csvRefused) {
  const verdict = noThrow(`parseEntriesCsv(${label})`, () => parseEntriesCsv(text, csvImportLabels, []));
  check(`parseEntriesCsv refuses ${label}`, verdict?.ok === false, JSON.stringify(verdict).slice(0, 80));
  check(`  and says why (${label})`, verdict?.reason === reason, String(verdict?.reason));
}
check('every refusal reason is one the UI can word',
  csvRefused.every(([, , reason]) => reason in CSV_REFUSAL), JSON.stringify(Object.keys(CSV_REFUSAL)));
check('the row cap is refused for its size, not its content',
  parseEntriesCsv(`${ENTRIES_CSV_HEADER.join(',')}\r\n${'2026-09-05,expense,gro,x,12.40,AIB,\r\n'.repeat(MAX_BACKUP_ENTRIES + 1)}`, csvImportLabels, []).reason === 'too-large');
// The header is matched BY NAME: the file goes out through a spreadsheet, and a
// spreadsheet reorders, renames and re-saves columns without asking.
const reorderedFile = [
  [' Note', ' Amount ', 'DATE', 'method', 'Category', 'type', 'Details'].join(','),
  ['hi', '33.00', '2026-09-05', 'AIB bank', 'Groceries', 'expense', 'lunch'].join(','),
].join('\r\n');
check('the header is matched by name, so a spreadsheet may reorder columns',
  parseEntriesCsv(reorderedFile, csvImportLabels, []).kept === 1);
check('and case and padding around a column name do not matter',
  (() => {
    const lines = reorderedFile.split('\r\n');
    lines[0] = ' note , AMOUNT ,date,METHOD,category,TYPE,Details';
    return parseEntriesCsv(lines.join('\r\n'), csvImportLabels, []).kept === 1;
  })());
check('the byte-order mark Excel writes is stripped before the header is read',
  // The BOM lands on the FIRST column — Date here, a required one — so this
  // only passes while the header cells are trimmed.
  parseEntriesCsv(CSV_BOM + csvExportFile, csvImportLabels, []).kept === 2);
check('a file missing a column the ledger needs is refused, not guessed at',
  parseEntriesCsv('Date,Type,Details,Amount\r\n2026-09-05,expense,lunch,12.40\r\n', csvImportLabels, []).reason === 'no-header');
const shortHeader = parseEntriesCsv('Date,Type,Category,Amount,Method\r\n2026-09-05,expense,Groceries,12.40,AIB bank\r\n', csvImportLabels, []);
check('Details and Note are optional and default to empty',
  shortHeader.kept === 1 && shortHeader.entries[0].details === '' && shortHeader.entries[0].note === '',
  JSON.stringify(shortHeader.entries[0]));
// Row rules: the same ones validateEntry applies to anything entering the
// ledger, so a row that would be a bad ENTRY is dropped rather than repaired.
const rulesFile = [
  ENTRIES_CSV_HEADER.join(','),
  'not-a-date,expense,gro,bad date,12.40,AIB,',              // no date at all
  '46270,expense,gro,serial date,12.40,AIB,',                // Excel serial
  '05/09/2026,expense,gro,day first,12.40,AIB,',             // a sheet's locale
  '2026-09-06,expense,gro,too precise,12.405,AIB,',          // never silently round
  '2026-09-07,expense,gro,no amount,,AIB,',                  // '' must not become 0
  '2026-09-08,expense,gro,with a symbol,€12.40,AIB,',        // no silent stripping
  '2026-09-09,refund,gro,unknown type,12.40,AIB,',           // not a type
  '2026-09-10,expense,not-a-category,x,12.40,AIB,',          // no such label or id
  '2026-09-11,expense,gro,x,12.40,not-a-method,',            // no such label or id
].join('\r\n');
const rulesVerdict = noThrow('parseEntriesCsv(row rules)', () => parseEntriesCsv(rulesFile, csvImportLabels, []));
check('the two rows that satisfy every rule are read, the rest are dropped',
  same([rulesVerdict?.kept, rulesVerdict?.dropped], [2, 7]),
  JSON.stringify({ kept: rulesVerdict?.kept, dropped: rulesVerdict?.dropped }));
check('an Excel serial and a day-first date both come back as the day they are',
  same((rulesVerdict?.entries || []).map(e => `${e.details}:${e.date}`).sort(),
    ['day first:2026-09-05', 'serial date:2026-09-05']));
// A transfer exports as a row with no pairing column. It must come back as
// VISIBLE money rather than a phantom pair: the leg parses as itself, and
// validateState (which every merged document passes through) turns an unpaired
// transfer into an ordinary expense — never a credit that inflates income.
const transferFile = `${ENTRIES_CSV_HEADER.join(',')}\r\n2026-09-12,transfer,gro,moved,10.00,AIB,\r\n`;
const transferRow = parseEntriesCsv(transferFile, csvImportLabels, []);
check('a transfer row reads back as the transfer it was',
  transferRow.kept === 1 && transferRow.entries[0].type === 'transfer');
check('and an unpaired leg validates as visible spending, not a phantom pair',
  validateState({ entries: transferRow.entries }).entries[0]?.type === 'expense');
check('a hostile file cannot throw the import',
  noThrow('parseEntriesCsv(junk)', () => parseEntriesCsv('"unclosed\r\n\u0000\u0001,\uFEFF,,,"', csvImportLabels, [null, 42, 'x'])) !== undefined);

// The wiring in app.js: a Node guard cannot open a picker or a dialog, so the
// import path is pinned as source text — the way section 12 pins the method
// rules — and the CSV half of the screening fixes rides along here too.
check('the menu offers the export an importer',
  /label: 'Import CSV'[^}]*openCsvPicker\(\)/.test(appSource));
check('the picker is a file input whose value is cleared, so the same file may be picked twice',
  /accept: '\.csv,text\/csv,text\/plain'/.test(appSource) && /csvInput\.value = ''/.test(appSource));
check('the file is size-capped before it is read',
  /function importCsvFromFile[\s\S]{0,200}file\.size > MAX_BACKUP_BYTES/.test(appSource));
check('rows are deduped against THIS device\u2019s ledger',
  /parseEntriesCsv\(text, \{ category: csvCategoryId, method: csvMethodId \}, state\.entries\)/.test(appSource));
check('labels resolve through the document\u2019s own tables, not a seed copy',
  /function csvCategoryId\(label\)[\s\S]{0,300}allCategories\(\)/.test(appSource)
  && /function csvMethodId\(label\)[\s\S]{0,300}everyMethod\(\)/.test(appSource));
check('the merge goes through the same whole-document undo a restore uses',
  /await applyRestore\(\{ entries: verdict\.entries \}, source\)/.test(appSource));
check('the confirm asks before anything is written',
  /swalConfirm\(\{\s*title: 'Import this CSV\?'/.test(appSource) && /if \(!ok\) return;\s*await applyRestore/.test(appSource));

// ---- the screening's other app.js fixes, pinned where they live
const fnBody = (marker, span = 2000) => {
  const at = appSource.indexOf(marker);
  return at < 0 ? '' : appSource.slice(at, at + span);
};
// persist(): the first write of a tick is synchronous (the contract saveState
// makes and section 4 pins), and same-tick repeats coalesce into ONE trailing
// microtask write of the final document instead of re-stringifying per step.
check('the first write of a tick lands synchronously and later ones coalesce',
  /writeNow\(\);\s*if \(persistFlushQueued\) \{ persistDirtyAgain = true; \}\s*else \{\s*persistFlushQueued = true;\s*queueMicrotask\(/.test(appSource));
check('the coalesced write flushes in the same tick, before any event or paint',
  /queueMicrotask\(\(\) => \{\s*persistFlushQueued = false;\s*if \(persistDirtyAgain\) \{ persistDirtyAgain = false; writeNow\(\); \}/.test(appSource));
check('and a persist still schedules the cloud push', /scheduleSyncPush\(\)/.test(fnBody('function persist()')));
// The search reads the WHOLE ledger when a query is typed (a month-scoped
// index could not find last month's entry), while browsing keeps the frame —
// the month, or a custom range once both ends are set (frameEntries).
check('a search query reads the whole ledger, not just the visible frame',
  /const searchScope = searchQuery \? state\.entries : frameEntries;/.test(appSource));
// The index is keyed to "the data changed": every mutation clears the balance
// caches, which is what bumps the search index beside them.
check('a data change invalidates the search index',
  /bumpSearchIndex\(\)/.test(fnBody('function clearBalanceCaches(', 400)));
// One duplicate question, asked once, no matter which button added the row:
// exactly two mentions of the checker (its definition and commitAdded's gate),
// and the confirm runs BEFORE the caller's toast and navigation (onDone), so a
// cancelled duplicate writes nothing and navigates nowhere.
check('one duplicate check, in commitAdded — the form does not ask a second time',
  (appSource.match(/findPotentialDuplicate\(/g) || []).length === 2,
  String((appSource.match(/findPotentialDuplicate\(/g) || []).length));
check('the gate sends the whole batch through one confirm',
  /const hit = entries\.map\(e => \[e, findPotentialDuplicate\(e\)\]\)\.find\(\(\[, dup\]\) => dup\);\s*if \(hit\) openDuplicateConfirm\(hit\[0\], hit\[1\], commit\);\s*else commit\(\);/.test(appSource));
check('and the caller\u2019s toast and navigation wait for the commit',
  /if \(onDone\) onDone\(\);/.test(fnBody('const commitAdded = (entries, label, onDone)', 3000)));
// ---------------------- 15. the Lidl receipt pull: REMOVED, and the absence is
// the pin that matters. It was the app's other automatic writer: a local relay
// (`python lidl-spike.py serve`) held the Lidl Plus session on the machine and
// handed the page normalized receipts, one `expense` on the `LG` gift card per
// ticket. Removing it has to be complete — the module, the relay it read, the
// Data-menu row, the pull that ran on every open, the `sw.js` SHELL entry, and
// the ignore rules that existed only for the spike's output folder. A
// half-restored copy is worse than one that never existed: a row that opens a
// module nobody ships is a feature that reports itself as working, and a boot
// hook that pulls receipts no screen mentions is that same failure with no UI at
// all. So the checks below read the sources rather than trusting the prose, and
// they name the module, the row and the hook instead of the word — `lidl` is
// still a legitimate token in app.js's gift-card keyword tables, which is a
// payment method and not this feature.
check('no Lidl receipt pull survives in app.js', (() => {
  const code = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  return !/lidl\.js|Pull Lidl receipts|pullLidl|autoPullLidl|LIDL_RELAY|relayReachable|cents:lidl-imported/.test(code);
})());
check('and neither the module nor the relay it read is in the repo',
  !existsSync(new URL('../lidl.js', import.meta.url))
  && !existsSync(new URL('../lidl-spike.py', import.meta.url)));
check('the service worker no longer precaches a module that does not exist',
  !/lidl/i.test(readFileSync(new URL('../sw.js', import.meta.url), 'utf8')));
check('and the ignore files keep nothing alive for it',
  !/lidl/i.test(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'))
  && !/lidl/i.test(readFileSync(new URL('../.assetsignore', import.meta.url), 'utf8')));

// ----------------- 16. balance checkpoints: the Reconcile editor's rules
// The Tesco gift-card balance feature was REMOVED outright. It went through
// three shapes - an on-open fetch, then tescogiftcard.py's relay, then a row
// that opened Tesco's page - and all three were wrong: the card ledger is
// Blackhawk Network's stored-value platform, an iframe on ANOTHER origin
// behind a reCAPTCHA, while tescogiftcards.com/api/v1 is the SHOP rather than
// the ledger (its checkout endpoint answered "not found" for a real card,
// and /api/v1/balance returned 400 "Invalid Captcha response" before reading
// it). So the absence is the pin that matters: nothing may check a balance
// automatically. What is left is the editor a human records a figure in.
check('no automated gift-card balance check survives anywhere in app.js',
  !/giftcard\.js|tesco-giftcard|autoCheckGiftCard|checkGiftCard|applyTescoFigure|BALANCE_PAGE|openBalancePage/.test(appSource));
check('the removed module is no longer imported or listed as a shell asset',
  !/import\('\.\/giftcard\.js'\)/.test(appSource)
  && !/\/giftcard\.js/.test(readFileSync(new URL('../sw.js', import.meta.url), 'utf8')));
check('the checkpoint keeps the Reconcile buttons\u2019 own rules',
  /function saveBalanceCheckpoint[\s\S]{0,300}!BALANCE_METHOD_IDS\.includes\(methodId\) \|\| !isValidCheckpointDate\(date\) \|\| date > today\(\)/.test(appSource));
check('the Reconcile editor snapshots BEFORE writing, so Undo restores all',
  /const prevPoints = \(getBalanceCheckpoints\(\)\[methodId\] \|\| \[\]\)\.map\(p => \(\{ \.\.\.p \}\)\);\s*if \(!saveBalanceCheckpoint\(methodId, date\.value, next\)\)/.test(appSource));
check('that write is one undoable step for its own method',
  /trackAction\(\(\) => \{\s*state\.settings\.balanceCheckpoints\[methodId\] = prevPoints;[\s\S]{0,220}`\$\{label\} reconciliation`\);/.test(appSource));

// ------------------------------ 17. the bank statement import (a second writer)
// bank-import.js imports clean in Node — its top level is pure for exactly
// this — so the rules below are behavioural rather than source-text, with the
// wiring half pinned as source at the end like section 16's. It is the app's
// one remaining writer of entries the user did not type (the Lidl pull that
// held that place is gone, section 15), and it has no ids of its own:
// everything it can get wrong is about money, dates, or writing the same file
// twice.
const { parseBankCsv, suggestBankMapping, buildBankEntries, bankAmount, bankDate, BANK_REFUSAL, bankImportSummary } = await import('../bank-import.js');

check('every refusal is a sentence a user can act on, not a code',
  Object.values(BANK_REFUSAL).every(v => typeof v === 'string' && /[a-z]/.test(v))
  && Object.keys(BANK_REFUSAL).includes('no-date'));
check('an empty file is refused, never parsed into an empty import',
  parseBankCsv('').reason === 'empty' && parseBankCsv('   \n').reason === 'empty');
check('a header-only file has no rows under it', parseBankCsv('Date,Description,Amount').reason === 'no-rows');
check('a headered file keeps its column names', (() => {
  const v = parseBankCsv('Date, Description, Amount (eur)\n02/10/2026,"Tesco, Dun Drury",-12.40\n');
  return v.ok && v.columns.length === 3 && v.columns[1] === 'Description' && v.rows.length === 1
    && v.rows[0][1] === 'Tesco, Dun Drury';   // a comma inside quotes is not a delimiter
})());
check('a file with no header at all is data, not a lost first row', (() => {
  const v = parseBankCsv('02/10/2026,Coffee,-3.20\n03/10/2026,Bus,-1.70\n');
  return v.ok && v.rows.length === 2 && v.columns[0] === 'Column 1';
})());
check('semicolon- and tab-separated exports are read too',
  parseBankCsv('Date;Description;Amount\n02/10/2026;Coffee;-3.20').rows.length === 1
  && parseBankCsv('Date\tDescription\tAmount\n02/10/2026\tCoffee\t-3.20').rows.length === 1);

check('an amount reads its sign from wherever the bank put it',
  bankAmount('-12.40') === -12.4 && bankAmount('12.40') === 12.4
  && bankAmount('€1,234.56') === 1234.56 && bankAmount('(12.40)') === -12.4
  && bankAmount('12.40 DR') === -12.4 && bankAmount('1 234,56') === 1234.56
  && bankAmount('closing balance') === null && bankAmount('') === null);
check('a date is day-first for an Irish bank, and never guessed',
  bankDate('02/10/2026') === '2026-10-02' && bankDate('2 Oct 2026') === '2026-10-02'
  && bankDate('Oct 2, 2026') === '2026-10-02' && bankDate('2026-10-02') === '2026-10-02'
  && bankDate('not a date') === null);

const bankCols = ['Date', 'Description', 'Amount (eur)'];
const bankRows = [
  ['02/10/2026', 'Tesco', '-12.40'],
  ['03/10/2026', 'Salary', '2400.00'],
];
const guessed = suggestBankMapping(bankCols, bankRows);
check('the mapper guesses by header word', guessed.date === 0 && guessed.description === 1 && guessed.amount === 2);
check('a running balance is never guessed to be the amount',
  suggestBankMapping(['Date', 'Description', 'Balance'], bankRows).amount === -1);
check('with no header at all the mapper falls back to the cells', (() => {
  const m = suggestBankMapping(['Column 1', 'Column 2', 'Column 3'], bankRows);
  return m.date === 0 && m.description === 1 && m.amount === 2;
})());
// Total on both arguments: a print the app did not write is the one input whose
// shape cannot be assumed, and "nothing looks like that field" is a state the
// mapping screen already renders (every field blank, the user picks). A throw
// here is the screen that never draws.
check('the mapper answers "nothing looks like that field" for a list it cannot read',
  JSON.stringify(suggestBankMapping(null, null)) === JSON.stringify({ date: -1, description: -1, amount: -1, debit: -1, credit: -1 })
  && JSON.stringify(suggestBankMapping([], [])) === JSON.stringify({ date: -1, description: -1, amount: -1, debit: -1, credit: -1 }),
  JSON.stringify(suggestBankMapping(null, null)));
check('and a junk row inside a real column list is read as no cells, not a crash',
  noThrow('suggestBankMapping(junk rows)', () => suggestBankMapping(['Date', 'Description', 'Amount'], [null, 42, 'x', {}, ['02/10/2026', 'Tesco', '-12.40']])) !== undefined);

const bankBuild = (rows, over = {}) => buildBankEntries({
  rows,
  mapping: over.mapping || guessed,
  method: over.method || 'AIB',
  guessCategory: over.guessCategory || (() => 'misc'),
  existing: over.existing || [],
});
const built = bankBuild(bankRows);
check('a signed column becomes one expense and one income', (() => {
  const [expense, credit] = built.entries;
  return built.entries.length === 2 && expense.type === 'expense' && expense.amount === 12.4
    && credit.type === 'credit' && credit.amount === 2400
    && expense.method === 'AIB' && expense.category === 'misc';
})());
check('rows are written oldest first, so a rerun reads the same',
  built.entries[0].date < built.entries[1].date);
check('rule: an amount that is not exact money is dropped, never rounded', (() => {
  const o = bankBuild([['02/10/2026', 'Odd', '12.405']]);
  return o.entries.length === 0 && o.badAmount === 1;
})());
check('rule: zero is not a transaction, and a row with no date is not either', (() => {
  const o = bankBuild([['02/10/2026', 'Nothing', '0.00'], ['', 'No date', '-5.00']]);
  return o.entries.length === 0 && o.empty === 1 && o.noDate === 1;
})());
check('rule: importing the same statement twice adds nothing', (() => {
  const first = bankBuild(bankRows);
  const second = bankBuild(bankRows, { existing: first.entries });
  return first.entries.length === 2 && second.entries.length === 0 && second.duplicates === 2;
})());
check('rule: two genuinely identical rows in ONE file both land', (() => {
  const o = bankBuild([['02/10/2026', 'Coffee', '-3.20'], ['02/10/2026', 'Coffee', '-3.20']]);
  return o.entries.length === 2 && o.duplicates === 0;
})());
check('the same row on a different account is not a duplicate', (() => {
  const first = bankBuild(bankRows);
  const second = bankBuild(bankRows, { method: 'Revolut', existing: first.entries });
  return second.entries.length === 2;
})());
check('a debit/credit pair reads the same money the same way', (() => {
  const o = buildBankEntries({
    rows: [['02/10/2026', 'Rent', '1200.00', ''], ['03/10/2026', 'Refund', '', '45.00']],
    mapping: { date: 0, description: 1, amount: -1, debit: 2, credit: 3 },
    method: 'AIB',
  });
  return o.entries.length === 2 && o.entries[0].type === 'expense' && o.entries[0].amount === 1200
    && o.entries[1].type === 'credit' && o.entries[1].amount === 45;
})());
check('the category is handed in — a second keyword table would be free to drift',
  bankBuild([['02/10/2026', 'Tesco shop', '-12.40']], { guessCategory: () => 'gro' }).entries[0].category === 'gro'
  && !/grocer|supermarket|petrol|landlord/i.test(readFileSync(new URL('../bank-import.js', import.meta.url), 'utf8')));
check('the skip reasons add up to a sentence',
  bankImportSummary(bankBuild([['02/10/2026', 'Coffee', '-3.20']])) === ''
  && /2 rows skipped/.test(bankImportSummary(bankBuild([['', 'x', '-3.20'], ['02/10/2026', 'Zero', '0.00']]))));

// app.js's half — pinned as source, because app.js touches the DOM on evaluation.
check('the menu reaches the mapper by name, so the harness can audit it',
  /label: 'Import bank statement'[\s\S]{0,240}openBankImport\(\)/.test(appSource));
check('the mapper is deferred — the boot path never parses a screen',
  !/from '\.\/bank-import\.js'/.test(appSource)
  && (appSource.match(/import\('\.\/bank-import\.js'\)/g) || []).length === 1);
check('it writes through the ONE duplicate gate, with the ledger\u2019s own hand on the id',
  /guessCategory: categoryFromDescription,/.test(appSource)
  && /uid, nowIso, commitAdded, render,/.test(appSource)
  && /existingEntries: \(\) => state\.entries/.test(appSource));
check('it is warm offline and on the shell list',
  /\/bank-import\.js/.test(readFileSync(new URL('../sw.js', import.meta.url), 'utf8')));
check('the category table exists exactly once, in app.js',
  (appSource.match(/function categoryFromDescription\(/g) || []).length === 1
  && /function parseReceiptLine\([\s\S]{0,600}categoryFromDescription\(desc\)/.test(appSource));

// ------------------- 18. what a fresh install is told (the end-user pass)
// Every rule here is about the FIRST screen a new user meets, and about a
// destructive or confusing thing the old UI did that is now gone. They are
// source pins because app.js cannot be imported in Node; the ones with a
// number behind them say which number.
check('a fresh ledger gets a way in, never an alarm',
  /if \(!state\.entries\.length\) return getStartedCard\(\);/.test(appSource)
  && /'Getting started'/.test(appSource) && /'Add your first entry'/.test(appSource));
check('the empty-state steps are the three that start the app',
  /'Set your main balance'/.test(appSource) && /'Add a recurring bill'/.test(appSource));
check('an untouched account says what to do, not that it is unreconciled',
  /state\.entries\.length \? 'Not reconciled' : 'Set a balance'/.test(appSource));
check('the footer no longer destroys the ledger in two taps',
  !/footer-action danger/.test(appSource) && !/Confirm reset/.test(appSource)
  && /class: 'footer-action', onClick: \(\) => \{\s*const startY/.test(appSource));
check('the menu reset still confirms, and now leaves an undo behind it',
  /label: 'Reset all data'[\s\S]{0,1200}swalConfirm\(/.test(appSource)
  && /label: 'Reset all data'[\s\S]{0,1600}journalEntries/.test(appSource)
  && /label: 'Reset all data'[\s\S]{0,2000}trackAction\(/.test(appSource));
check('the default PIN is told to the person who kept it',
  /skipEl\.textContent = `Keep the default PIN \(\$\{DEFAULT_PIN_PLAIN\}\)`/.test(appSource)
  && /Still the default PIN: \$\{DEFAULT_PIN_PLAIN\}/.test(appSource)
  && /getPinCredential\(\)\.isDefault/.test(appSource));
check('a restored backup brings its cash figure with it',
  /adoptBackupCash\(backupState\)/.test(appSource)
  && /function adoptBackupCash\(/.test(appSource)
  && /if \(cashBalance\(\) !== 0\) return false;/.test(appSource));
check('month-to-date is compared with the same days of the month before it',
  /proratedPrevious/.test(appSource)
  && /previous \* \(elapsed \/ daysInMonth\(previousKey\)\)/.test(appSource)
  && /last month to date/.test(appSource));
check('a projection needs a week of entries and leaves fixed bills out of its run-rate',
  /const PROJECTION_MIN_DAYS = 7;/.test(appSource)
  && /const PROJECTION_MIN_ENTRIES = 3;/.test(appSource)
  && /isFixedCostEntry\(e, keys\)/.test(appSource)
  && /forecast\.projected === null/.test(appSource));
check('a recurring entry carries the schedule\u2019s own tuple, which is what marks it',
  /function recurringEntryKey\(x\)/.test(appSource) && /function isFixedCostEntry\(/.test(appSource));
check('a payday is not an anomaly',
  /outlierPool = financialEntries\.filter\(e => isSpendingEntry\(e\) && !isFixedCostEntry\(e, recKeys\)\)/.test(appSource));
check('the Tesco card only counts Tesco pay, and shows nothing when there is none',
  /function tescoThursdayIncome\(/.test(appSource)
  && /payTracker\.shown && tabVisible\('tesco'\)/.test(appSource)
  && /recordedIds\.has\(e\.id\) \|\| namesTesco\(e\)/.test(appSource));
check('the Insights default range and its own preset are one range',
  /const defaultFrom = offsetDateKey\(today\(\), -89\);/.test(insightsSource)
  && /\{ label: 'Last 90 days', from: offsetDateKey\(today\(\), -89\)/.test(insightsSource));
check('the entry count says what it counts',
  /statCard\('Spending entries'/.test(insightsSource));
check('All time is a range you can pick', /\{ label: 'All time'/.test(insightsSource));
check('an untouched voucher tally is not a headline figure',
  /if \(amount <= 0\) return null;/.test(appSource));
check('the budget toggle moved off the row and into the edit sheet',
  !/Exclude budget'/.test(appSource)
  && /Exclude from budget calculations'/.test(appSource)
  && /Exclude this payment from budget calculations'/.test(appSource)
  && /\.\.\.\(data\.budgetExcluded \? \{ budgetExcluded: true \} : \{\}\)/.test(appSource));
check('the row\u2019s one action is named for what it does',
  /'aria-label': \(isGroup \? `Edit or delete split \$\{rowLabel\}` : `Edit or delete \$\{rowLabel\}`\)[\s\S]{0,80}'Edit'/.test(appSource));
check('a pattern in the ledger is offered once, and can be refused',
  /function recurringSuggestion\(\)/.test(appSource)
  && /setAlertDismissed\(dismissedKey, true\)/.test(appSource)
  && /'Add to recurring'/.test(appSource));
check('the #add screen folds the structured form instead of stacking it',
  /'More options'/.test(appSource)
  && /aria-controls': 'add-structured'/.test(appSource)
  && /quickCard\.dataset\.routeInitialFocus = 'true'/.test(appSource));
// History is a frame you can pick — the type row (the filter searchEntries
// always had and the screen never asked for), an arbitrary date range, and an
// order toggle — each living in the hash so a link carries it and the back
// gesture undoes it, plus the view's own Export and Print.
check('History filters by type, counted against the visible frame',
  /TYPE_PILLS = \[\['all', 'All'\]/.test(appSource)
  && /type: activeType/.test(appSource)
  && /params\.get\('type'\)/.test(appSource)
  && /for \(const e of frameEntries\) if \(typeCounts\[e\.type\]/.test(appSource));
check('a date range needs both ends, ordered on read AND write',
  /!dateKeyOk\(rangeFrom\) \|\| !dateKeyOk\(rangeTo\)/.test(appSource)
  && /const lo = from <= to \? from : to;/.test(appSource)
  && /params\.delete\('from'\)/.test(appSource)
  && /if \(activeDay && !inRange\)/.test(appSource));
check('the order toggle sorts the frame and stands aside for a ranking',
  /const oldestFirst = \(a, b\)/.test(appSource)
  && /searchQuery \? \[\.\.\.filtered\] : \[\.\.\.filtered\]\.sort\(orderAsc \? oldestFirst : newestFirst\)/.test(appSource)
  && /if \(!searchQuery\) navRight\.appendChild\(monthNav\(orderAsc/.test(appSource));
check('Export view writes the visible rows, named as a view rather than the ledger',
  /\{ entries: visible \}/.test(appSource)
  && /const name = entries \? `history-/.test(readFileSync(new URL('../storage.js', import.meta.url), 'utf8')));
check('printing History hides the chrome and lifts content-visibility',
  /document\.body\.classList\.add\('printing-history'\)/.test(appSource)
  && /body\.printing-history \.app-header/.test(readFileSync(new URL('../styles.css', import.meta.url), 'utf8'))
  && /body\.printing-history \.history-row\s*\{[^}]*content-visibility:\s*visible/s
    .test(readFileSync(new URL('../styles.css', import.meta.url), 'utf8')));
// Every chart figure is also a way into the ledger behind it — the heat map
// was the only one that drilled — and a mark that navigates has to carry the
// three things this app requires of an interactive shape: a role, a keyboard
// path, and a name (a shape has no text to fall back on). The month chart's
// svg must NOT declare itself role="img": that makes every child
// presentational to a screen reader, which would hide exactly these targets.
check('the donut and its bars drill into the range they are drawn over',
  /donutChart\(catRows, drillCategory\)/.test(insightsSource)
  && /barWithSpark\(cat, val, maxCat, val === maxCat, drillCategory\)/.test(insightsSource)
  && /const drillCategory = \(cat\) => \{ location\.hash = `history\?from=\$\{fromDate\}&to=\$\{toDate\}&cat=\$\{cat\}`; \}/.test(insightsSource));
check('a drillable mark carries role, keyboard and a name',
  /role: 'button', tabindex: '0', 'aria-label': `View \$\{categoryLabel\(cat\)\} in history`/.test(insightsSource)
  && /role: 'button', tabindex: '0', 'aria-label': `View \$\{monthLabel\(m\.key\)\} in history`/.test(insightsSource)
  && /onKeydown: \(ev\) => \{ if \(ev\.key === 'Enter' \|\| ev\.key === ' '\)/.test(insightsSource));
check('the month chart does not declare its children presentational',
  !/role: 'img', 'aria-label': 'Monthly spending vs income/.test(appSource + insightsSource));
check('the savings rate is budget-aware income over the range, and never a fake 0%',
  /statCard\('Savings rate', savingsRate === null \? '-' :/.test(insightsSource)
  && /recent\.filter\(isBudgetIncomeEntry\)\.reduce/.test(insightsSource)
  && /rangeIncome > 0 \? Math\.round/.test(insightsSource));
check('Export stats writes the range through csvDocument, under its own name',
  /function exportInsightStats\(\)/.test(insightsSource)
  && /CSV_BOM \+ csvDocument\(rows\)/.test(insightsSource)
  && /`insights-\$\{fromDate\}_\$\{toDate\}\.csv`/.test(insightsSource));
// The boot split itself: the screen is reached only through import(), the route
// draws a placeholder until it lands (a screen that never loads is a tab that
// never opens), and the module reaches back for the shell through exports
// rather than a second copy of the label rules.
check('the Insights screen is fetched, never parsed at boot',
  /import\('\.\/insights\.js'\)/.test(appSource)
  && /export function screenInsights\(\)/.test(insightsSource)
  && /insights \? insights\.screenInsights\(\) : insightsLoadingCard\(\)/.test(appSource));
check('the module borrows the shell\u2019s names instead of re-deriving them',
  /import\s*\{[^}]*categoryLabel[^}]*\}\s*from\s*'\.\/app\.js';/.test(insightsSource)
  && /import\s*\{[^}]*wireFlatpickr[^}]*\}\s*from\s*'\.\/app\.js';/.test(insightsSource)
  && /^export \{\n  \$, state, /m.test(appSource)
  && /export \{[^}]*isSpendingEntry[^}]*isBudgetIncomeEntry[^}]*\}/m.test(appSource));

// ---- the recurrence engine, run rather than described ---------------------
// advanceRecurringDate/computeInitialNextDate are lifted straight out of
// app.js's text (app.js cannot be imported — it touches the DOM on evaluation)
// and run against real dates, because "the schedule advanced" is arithmetic,
// not wiring: a regex over this code would pass for a leap year it got wrong.
const engineAt = appSource.indexOf('function utcDateKey');
const engineEnd = appSource.indexOf('\n}\n', appSource.indexOf('function computeInitialNextDate'));
const engineCode = appSource.slice(engineAt, engineEnd + 2);
if (engineAt < 0 || engineEnd < 0 || !/function computeInitialNextDate/.test(engineCode) || engineCode.length > 5000) {
  console.error(`test-integrity: could not lift the recurrence engine (${engineCode.length} chars) — check the markers in app.js.`);
  process.exit(1);
}
// localDateKey lives far above the slice, so it is handed in.
const engine = new Function('localDateKey', `${engineCode}\nreturn { advanceRecurringDate, computeInitialNextDate };`)(
  (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
);
check('every cadence steps its own distance, from last date to next',
  engine.advanceRecurringDate('2026-10-01', 'daily', 1) === '2026-10-02'
  && engine.advanceRecurringDate('2026-10-01', 'weekly', 1) === '2026-10-08'
  && engine.advanceRecurringDate('2026-10-01', 'fortnightly', 1) === '2026-10-15'
  && engine.advanceRecurringDate('2026-10-01', 'monthly', 1) === '2026-11-01'
  && engine.advanceRecurringDate('2026-10-01', 'yearly', 1) === '2027-10-01');
check('a month-anchored schedule clamps to the month it lands in',
  engine.advanceRecurringDate('2026-01-31', 'monthly', 31) === '2026-02-28'
  && engine.advanceRecurringDate('2026-02-28', 'monthly', 31) === '2026-03-31'
  && engine.advanceRecurringDate('2028-02-29', 'yearly', 29) === '2029-02-28');
check('the first occurrence is never in the past, for any cadence',
  ['daily', 'weekly', 'fortnightly', 'monthly', 'yearly'].every((f) => {
    const k = engine.computeInitialNextDate(f, 1);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yearOut = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(k) && k >= yesterday && k <= yearOut;
  }));

// The editor, the device validator and the cloud validator are three places a
// cadence has to agree with the engine above.
check('the schedule editor offers every cadence the engine advances',
  (() => {
    const at = appSource.indexOf("freqSel = $('select'");
    const block = at < 0 ? '' : appSource.slice(at, appSource.indexOf('const dayLabel', at));
    return block.length > 0 && block.length < 2000
      && ['daily', 'weekly', 'fortnightly', 'monthly', 'yearly'].every(f => block.includes(`{ value: '${f}'`))
      && /const FREQUENCY_STEPS = \{ daily: 1, weekly: 7, fortnightly: 14 \}/.test(appSource);
  })());
check('the device and the cloud read the cadence list from seed.js, once',
  /export const RECURRING_FREQUENCIES = \['daily', 'weekly', 'fortnightly', 'monthly', 'yearly'\]/
    .test(readFileSync(new URL('../seed.js', import.meta.url), 'utf8'))
  && /RECURRING_FREQUENCIES\.includes\(item\.frequency\)/
    .test(readFileSync(new URL('../storage.js', import.meta.url), 'utf8'))
  && /RECURRING_FREQUENCIES\.includes\(recurring\.frequency\)/
    .test(readFileSync(new URL('../netlify/functions/sync.mjs', import.meta.url), 'utf8'))
  && /import \{ RECURRING_FREQUENCIES \} from '\.\.\/\.\.\/seed\.js';/
    .test(readFileSync(new URL('../netlify/functions/sync.mjs', import.meta.url), 'utf8')));
check('a stalled schedule cannot spin the tab',
  /advanceBudget\(rec\.frequency\)/.test(appSource)
  && /guard\+\+ < advanceBudget/.test(appSource)
  && /const advanceBudget = \(freq\) => \(freq === 'daily' \? 400 : 48\)/.test(appSource));

// Per-account projection: the schedule carries the method it lands on, so each
// balance row can say where the account ends up. The horizon walk must count
// every occurrence (the upcoming strip only wants six), and an account with
// nothing scheduled says nothing rather than €0.00.
check('a projection counts every occurrence in the horizon, not the strip\u2019s six',
  /function accountProjection\(methodId, horizonDays = 30\)/.test(appSource)
  && /upcomingOccurrences\(r, horizonDays, Infinity\)/.test(appSource)
  && /if \(!list\.length\) return null;/.test(appSource)
  && /if \(!count\) return null;/.test(appSource));
check('the Balances rows carry the projection and a title that explains it',
  /secondaryFor: \(id\) => accountProjectionText\(id\)/.test(appSource)
  && /secondaryHintFor: \(\) => 'Where this account lands in 30 days/.test(appSource)
  && /secondaryHint: hintFor\(id\)/.test(appSource)
  // The base is the balance AT THE HORIZON: an entry already recorded for a
  // future day is a fact about that date, and today's balance cannot see it.
  && /balanceAt\(methodId, offsetDateKey\(today\(\), horizonDays\)\)/.test(appSource));

// ---- the lock taking itself back -------------------------------------------
// Idle and the app switcher are one door with two ways to close it, and both
// live in app.js's text (a Node guard cannot idle for five minutes), so they are
// pinned as source — including the detail that makes the cover true rather than
// decorative: it is opaque (nothing here may re-sample the page behind it).
//
// The third way — hidden for HIDDEN_LOCK_MS (30s), locked on the way back — was
// removed on 16 Oct 2026 because it charged the PIN for every glance at another
// tab, and a tab switch is not an absence. The check below pins the REMOVAL as
// hard as it pins the behaviour: no HIDDEN_LOCK_MS anywhere, and no lockApp()
// anywhere in the visibilitychange handler, so a later "fix" cannot quietly
// reintroduce it while still satisfying a check that only asked for the cover.
check('the lock re-takes itself when the app is left alone',
  /const IDLE_LOCK_MS = 5 \* 60 \* 1000;/.test(appSource)
  && /idleTimer = setTimeout\(\(\) => \{[\s\S]{0,80}lockApp\(\);/.test(appSource)
  && /if \(!pinUnlocked\) return;\s*\n\s*idleTimer = setTimeout/.test(appSource));
const lockVisHandler = (appSource.match(/document\.addEventListener\('visibilitychange',[\s\S]*?\n\}\);/) || [''])[0]
  // Comments are stripped so the assertions below read CODE: a comment that
  // names lockApp() must not fail this, and a comment saying "no lock here"
  // while the code locks must not pass it.
  .replace(/\/\/[^\n]*/g, '');
check('a hidden window is covered, never locked — switching tabs must not ask for the PIN',
  // The declaration is gone, not merely unused, and nothing measures time-in-
  // background: hiddenAt/hiddenFor were the 30-second rule's whole apparatus.
  !/const HIDDEN_LOCK_MS/.test(appSource) && !/hiddenFor\s*=/.test(appSource)
  && lockVisHandler !== '' && !/lockApp\s*\(/.test(lockVisHandler)
  && /if \(document\.hidden\) \{\s*\n[\s\S]{0,60}showPrivacyCover\(\);/.test(lockVisHandler)
  && /hidePrivacyCover\(\);\s*\n\s*resetIdleLock\(\);/.test(lockVisHandler));
check('the app-switcher cover paints rather than samples what is behind it',
  /id: 'privacy-cover'/.test(appSource)
  && /background:var\(--bg, #101210\)[^']*pointer-events:none;'/
    .test(appSource)
  && /\$\('span', \{ style: 'font-family:"Space Grotesk",sans-serif;font-size:20px;/.test(appSource));
check('every unlock arms the idle clock — it cannot stay open by silence',
  (appSource.match(/resetIdleLock\(\);/g) || []).length >= 4
  && /function completeUnlock\(\) \{[\s\S]{0,200}resetIdleLock\(\);/.test(appSource));

// ---- the device PIN throttle ----------------------------------------------
// Sliding window, same shape as the server's; the check runs BEFORE the hash
// (answering is what a throttle withholds) and a correct PIN ends the run.
check('a guessing run on the device PIN runs into a sliding window',
  /const PIN_THROTTLE_WINDOW_MS = 5 \* 60 \* 1000;/.test(appSource)
  && /const PIN_THROTTLE_MAX = 15;/.test(appSource)
  && /while \(pinFailures\.length && pinFailures\[0\] < cutoff\) pinFailures\.shift\(\);/.test(appSource)
  && /return Math\.max\(1, Math\.ceil\(\(pinFailures\[0\] \+ PIN_THROTTLE_WINDOW_MS - now\) \/ 1000\)\);/.test(appSource));
check('the PIN gate asks the window before it hashes, and counts every miss',
  /const wait = pinThrottleRemaining\(\);[\s\S]{0,120}Too many attempts[\s\S]{0,200}if \(!\(await verifyPin\(value\)\)\) \{[\s\S]{0,40}pinFailure\(\);/.test(appSource)
  && /pinFailures\.length = 0;\s*\/\/ a correct PIN is the end of a guessing run/.test(appSource));

// ---- the undo stack --------------------------------------------------------
// One slot used to mean the FAB only ever offered the newest action and every
// new record overwrote the one before it. Both halves are pinned: the CAP (five
// in memory, five in storage, same order), and the retirement rule that makes
// popping safe — a toast's Undo can outlive the action it captured, and
// spending the journal's front then would retire a NEWER action's record.
const undoStorage = readFileSync(new URL('../storage.js', import.meta.url), 'utf8');
check('the undo journal is a stack of five, newest first, in both halves',
  /export const UNDO_STACK_MAX = 5;/.test(undoStorage)
  && /stack\.unshift\(journal\);[\s\S]{0,120}UNDO_STACK_MAX/.test(undoStorage)
  && /if \(_undoStack\.length > UNDO_STACK_MAX\) _undoStack\.length = UNDO_STACK_MAX;/.test(appSource)
  && /_undoStack\.unshift\(\{ undo: undoFn, label, serialisable \}\)/.test(appSource));
check('undoing retires one slot and only its own journal record',
  /function undoAction\(action\)/.test(appSource)
  && /const wasHead = _undoStack\[0\] === action;/.test(appSource)
  && /if \(action\.fromJournal\) dropUndoJournal\(action\.journal\);/.test(appSource)
  && /else if \(wasHead && action\.serialisable\) popUndoJournal\(\);/.test(appSource)
  && /export function dropUndoJournal\(record\)/.test(undoStorage));
check('a spent record is dropped rather than hiding the ones behind it',
  /if \(!missing\.entries\.length && !missing\.checkpoints\.length\) \{ popUndoJournal\(\); continue; \}/.test(appSource)
  && /while \(journal && \(journal\.entries\?\.length \|\| journal\.checkpoints\?\.length\)\)/.test(appSource));
check('the journal written before the stack still reads',
  /Array\.isArray\(parsed\) \? parsed\s*:\s*\(parsed && \(Array\.isArray\(parsed\.entries\)/.test(undoStorage));
check('a restore empties the journal of the document it replaced',
  /clearUndoJournal\(\);\s*\n\s*trackAction\(\(\) => \{ state = validateState\(before\)/.test(appSource));

// ---- a stored sync endpoint that cannot work is repaired, not obeyed ------
// Two shapes sit in people's storage and both fail in ways that look like
// something else: the pre-rename path (this app's own endpoint under the name
// of the host the project migrated off) reads as "still Netlify", and a
// `*.netlify.app` URL points at a site that no longer answers, so every sync
// reports a network failure over data that is actually intact in KV. The repair
// happens when the settings are READ (settings.js's migrateEndpoint), which is
// what these five assertions pin — including the case that must NOT move: a
// custom endpoint is a deliberate choice, not a stale value.
const syncKey = 'cents:p/personal/sync';
const endpointFor = (stored) => {
  localStorage = new MemoryStorage({ [syncKey]: JSON.stringify(stored) });
  return getSyncSettings().endpoint;
};

check('the default endpoint is the path the serving host owns, and it is a usable path',
  DEFAULT_SYNC_ENDPOINT === '/api/sync' && isValidEndpoint(DEFAULT_SYNC_ENDPOINT));
check('a device holding the pre-rename spelling is moved to the current default',
  endpointFor({ enabled: true, endpoint: '/.netlify/functions/sync', password: 'pw-here' }) === DEFAULT_SYNC_ENDPOINT);
check('a device still pointed at the retired Netlify host is moved to this site',
  endpointFor({ enabled: true, endpoint: 'https://cents-app.netlify.app/.netlify/functions/sync' }) === DEFAULT_SYNC_ENDPOINT
  && endpointFor({ enabled: true, endpoint: 'https://cents-app.netlify.app' }) === DEFAULT_SYNC_ENDPOINT);
check('a custom endpoint is left exactly as the user set it',
  endpointFor({ enabled: true, endpoint: 'https://sync.example.com/api/sync' }) === 'https://sync.example.com/api/sync'
  && endpointFor({ enabled: true, endpoint: '/.netlify/functions/some-other-function' }) === '/.netlify/functions/some-other-function');
check('the repair rewrites the endpoint only, and both spellings read as "this site"',
  (() => {
    localStorage = new MemoryStorage({ [syncKey]: JSON.stringify({ enabled: true, endpoint: '/.netlify/functions/sync', password: 'pw-here', lastSyncAt: '2026-01-02T03:04:05.000Z', repoLabel: 'me/cents-data \u00b7 data.json @ main' }) });
    const s = getSyncSettings();
    return s.endpoint === DEFAULT_SYNC_ENDPOINT && s.enabled === true && s.password === 'pw-here'
      && s.lastSyncAt === '2026-01-02T03:04:05.000Z' && s.repoLabel.startsWith('me/cents-data');
  })()
  && isDefaultSyncEndpoint(DEFAULT_SYNC_ENDPOINT) && isDefaultSyncEndpoint('/.netlify/functions/sync')
  && !isDefaultSyncEndpoint('https://sync.example.com/api/sync'));
localStorage = new MemoryStorage();

// ---------------------------------------------------------------- report
if (failures.length) {
  console.error(`test-integrity: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`test-integrity: OK - ${pass} assertions passed`);
