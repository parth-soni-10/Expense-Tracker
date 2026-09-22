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

const { validateState, loadState, saveState } = await import('../storage.js');
const { mergeStates } = await import('../sync-merge.js');
const { paidHours, shiftPay, simulateTax, tescoCsv, parseTescoCsv } = await import('../tesco.js');

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
localStorage = new MemoryStorage({ 'expense-tracker:v1': corruptBytes });
const corruptLoad = noThrow('loadState(corrupt)', () => loadState());
check('corrupt load still returns a usable state', looksLikeState(corruptLoad));
const backupKey = [...localStorage.map.keys()].find(k => k !== 'expense-tracker:v1');
check('corrupt payload preserved for recovery', !!backupKey, `keys: ${[...localStorage.map.keys()].join(', ')}`);
check('preserved copy is byte-identical to what was stored', !backupKey || localStorage.getItem(backupKey) === corruptBytes);

// ------------------------------------- 4. a failed write must be reported
localStorage = new MemoryStorage();
saveState({ entries: [], settings: {} });
check('saveState reports success on a healthy write', saveState({ entries: [], settings: {} }) !== false);
localStorage = new MemoryStorage({}, { failWrites: true });
const failedWrite = noThrow('saveState(quota exceeded)', () => saveState({ entries: [], settings: {} }));
check('saveState reports failure when storage rejects the write', failedWrite === false, `returned ${String(failedWrite)}`);

// ------------------------------------- 5. legacy profile keys cannot clobber
// The reverse migration runs once, at import time, so observing it needs its
// own module instance (Node keys modules by URL, query string included).
const liveEntry = { id: 'live', date: '2026-09-20', type: 'expense', method: 'AIB', category: 'gro', amount: 1, details: '', note: '', createdAt: '2026-09-20T10:00:00.000Z' };
const liveState = JSON.stringify({ entries: [liveEntry], settings: { monthlyBudget: 1100 } });
const staleProfile = JSON.stringify({ entries: [], settings: { monthlyBudget: 999 } });
localStorage = new MemoryStorage({ 'expense-tracker:v1': liveState, 'cents:p/p9/state': staleProfile });
const migrating = await import('../storage.js?migration-check');
const afterMigration = noThrow('loadState(with stale profile keys)', () => migrating.loadState());
check('live entries survive a stale profile copy', !!afterMigration && afterMigration.entries.some(e => e.id === 'live'),
  'the profile-scoped copy replaced the live document');
check('live budget survives a stale profile copy', (afterMigration?.settings?.monthlyBudget) === 1100,
  `budget became ${afterMigration?.settings?.monthlyBudget}`);
// Stray profile-scoped keys must be inert: they belong to a removed feature and
// are never a source of truth for the live document.
localStorage = new MemoryStorage({ 'cents:p/p9/state': staleProfile });
const ignoring = await import('../storage.js?ignores-profiles');
const ignored = noThrow('loadState(profile keys only)', () => ignoring.loadState());
check('stray profile keys do not become the live state', looksLikeState(ignored) && ignored.entries.length === 0,
  `entries: ${ignored?.entries?.length}`);
check('stray profile keys are left untouched', localStorage.getItem('cents:p/p9/state') === staleProfile);

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

// ---------------------------------------------------------------- report
if (failures.length) {
  console.error(`test-integrity: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`test-integrity: OK - ${pass} assertions passed`);
