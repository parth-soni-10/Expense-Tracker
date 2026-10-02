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

const { validateState, loadState, saveState, parseBackup, foreignWriteNeeded, readStateText, unreadableBackup, entriesCsv, ENTRIES_CSV_HEADER, MAX_BACKUP_BYTES, MAX_BACKUP_ENTRIES } = await import('../storage.js');
const { csvCell, csvUnquote, csvDocument, CSV_BOM } = await import('../csv.js');
const { getPrivacyPin } = await import('../settings.js');
const { mergeStates } = await import('../sync-merge.js');
const { paidHours, shiftPay, simulateTax, tescoCsv, parseTescoCsv } = await import('../tesco.js');
const { readFileSync } = await import('node:fs');

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
const { nsKey, getActiveProfileId } = await import('../profiles.js');
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
  ['state', 'sync', 'privacy', 'bio', 'undo', 'alerts', 'reminder', 'quarantine']
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
// "Export CSV" writes every entry as one row a spreadsheet can read. Nothing
// reads the file back, so what has to hold is narrower than the JSON round trip
// and just as sharp: the columns are the ones the reader expects, a label is
// worded the way the screen words it, a number stays a number, and a field that
// would be read as a formula is defused rather than executed on open.
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

// ---------------------------------------------------------------- report
if (failures.length) {
  console.error(`test-integrity: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`test-integrity: OK - ${pass} assertions passed`);
