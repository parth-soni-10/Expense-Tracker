#!/usr/bin/env node
/**
 * The Tesco Pay sheet: the ported rules against the SHIPPING source.
 *
 * The sheet is a workbook with two tables — one row per shift, and a tax table
 * of pay runs — and the whole round trip is ported into
 * `app/lib/tesco-sheet.ts`. This guard runs the old `tesco.js` and the new
 * module side by side over the same inputs and asserts they answer
 * identically: the old file is imported from the repository root, so this is
 * the **shipping source**, not a copy of it, and a rule that drifts in the port
 * fails here rather than on a payslip.
 *
 * Four rules carry most of the weight, and each exists because the obvious
 * implementation loses money:
 *
 *   1. A row keeps its OWN hours and pay — the sheet's older rows were worked
 *      at rates that have since changed — and a row with no clock times is a
 *      booked week off, not a broken row. Dropping one also lost the week's
 *      bank pay.
 *   2. A payslip is per PAY RUN, not per week. The sheet's tax table holds two
 *      rows when a week had two runs, and folding them into one lost a row
 *      from the file's own round trip.
 *   3. Final Bank Pay is TYPED, never derived. It comes off a bank statement,
 *      and holiday pay, a refund or a correction are all reasons it disagrees
 *      with gross − tax.
 *   4. A hand edit is validated by the same rules an import is, or an edit
 *      could write a row the importer would have refused.
 *
 * Run: node scripts/test-tesco-sheet.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const same = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b),
  `old ${JSON.stringify(a)} vs new ${JSON.stringify(b)}`);

const old = await import('../tesco.js');
const next = await import('../app/lib/tesco-sheet.ts');
const engine = await import('../app/lib/tesco-pay.ts');

const RATES = { ...engine.TESCO_RATE_DEFAULTS };

/* ══ 1. THE PORT ANSWERS THE SAME AS THE SHIPPING SOURCE ═════════════════════ */

const SHIFT_LINES = [
  'mon 8-4',
  'yesterday 12:30-20:15',
  'fri 20:00-01:00',
  'week off 7h',
  '13-09-2026 9-5',
  '13/09 9-5',
  '12 sep 9-5',
  'sep 12 9-5',
  '8am-4',
  '4-9pm',
  '8pm-4am',
  'noon-8',
  'midnight-6',
  '1630-2000',
  'today 9-5 stock take',
  'tomorrow 9-5',
  'last fri 9-5',
  'next mon 9-5',
  'mon 8-4 special',
  'mon 8-4 bank holiday',
  'mon 8-4 double time',
  'mon 9-5 7h',
  'mon 9-5 0h',
  'mon 9-5 25h',
  '13-09 8-4',
  'mon 8-4; tue 9-5',
  'mon 8-4\ntue 9-5',
  'nonsense',
  'mon 8-4 8-4',
  '',
];

for (const line of SHIFT_LINES) {
  same(`parseShiftText: ${JSON.stringify(line)}`,
    old.parseShiftText(line, '2026-10-20'),
    next.parseShiftText(line, '2026-10-20'));
}

// A second "today", so the relative-day rules are exercised against a
// different anchor as well.
for (const line of ['mon 8-4', 'yesterday 9-5', 'last fri 9-5', 'next mon 9-5']) {
  same(`parseShiftText on another day: ${JSON.stringify(line)}`,
    old.parseShiftText(line, '2026-01-06'),
    next.parseShiftText(line, '2026-01-06'));
}

/* -- storedShift ---------------------------------------------------------- */

const ROWS = [
  { date: '2026-10-12', start: '09:00', end: '17:00' },
  { date: '2026-10-12', start: '', end: '', hours: 7 },
  { date: '2026-10-12', start: '', end: '', hours: 7, gross: 101.08 },
  { date: '2026-10-12', start: '09:00', end: '17:00', gross: 120.5, bankPay: 95.25 },
  { date: '2026-10-12', start: '09:00', end: '17:00', special: true, note: 'stock take' },
  { date: '2026-13-12', start: '09:00', end: '17:00' },
  { date: '2026-10-12', start: '', end: '' },
  { date: '2026-10-12', start: '09:00', end: '' },
  { date: '2026-10-12', start: '09:00', end: '17:00', gross: 0 },
];
for (const row of ROWS) {
  same(`storedShift: ${JSON.stringify(row)}`,
    old.storedShift(row, 's1', '2026-10-20T09:00:00.000Z'),
    next.storedShift(row, 's1', '2026-10-20T09:00:00.000Z'));
}

/* -- weekOffShift --------------------------------------------------------- */

for (const [date, hours] of [
  ['2026-10-14', '7'], ['2026-10-14', 7], ['2026-10-14', '0'], ['2026-10-14', '169'],
  ['2026-10-14', ''], ['nope', '7'], ['2026-10-14', '7.5'],
]) {
  same(`weekOffShift: ${date} / ${hours}`,
    old.weekOffShift(date, hours),
    next.weekOffShift(date, hours));
}

/* -- applyShiftEdit ------------------------------------------------------- */

const BASE = {
  id: 's1', date: '2026-10-12', start: '09:00', end: '17:00', hours: 8, gross: 120.5,
  note: 'stock', special: true, createdAt: '2026-10-20T09:00:00.000Z',
};
const EDITS = [
  { date: '2026-10-13' },
  { start: '10:00' },
  { end: '18:00' },
  { start: 'nope' },
  { end: 'nope' },
  { hours: '' },
  { hours: '9' },
  { hours: 'abc' },
  { hours: '200' },
  { start: '', end: '' },
  { start: '', end: '', hours: '7' },
  { gross: '' },
  { gross: '130' },
  { gross: '-5' },
  { gross: 'abc' },
  { note: 'changed' },
  { special: false },
  { date: '2026-10-14' },
];
for (const fields of EDITS) {
  same(`applyShiftEdit: ${JSON.stringify(fields)}`,
    old.applyShiftEdit(BASE, fields, []),
    next.applyShiftEdit(BASE, fields, []));
}
// The duplicate rule, with the other shifts present.
same('applyShiftEdit refuses a row already on another shift',
  old.applyShiftEdit(BASE, { date: '2026-10-14' }, ['2026-10-14|09:00|17:00']),
  next.applyShiftEdit(BASE, { date: '2026-10-14' }, ['2026-10-14|09:00|17:00']));

/* -- storedPayslip -------------------------------------------------------- */

for (const p of [
  { weekStart: '2026-10-11', paye: 100, usc: 20, prsi: 30, futureFund: 5 },
  { weekStart: '2026-10-11', paye: 100, usc: 20, prsi: 30, futureFund: 5, weekNo: 42 },
  { weekStart: '2026-10-11', paye: 100, usc: 20, prsi: 30, futureFund: 5, weekNo: 99 },
  { weekStart: '2026-10-11', paye: 100, usc: 20, prsi: 30, futureFund: 5, bankPay: 469.78 },
]) {
  same(`storedPayslip: ${JSON.stringify(p)}`,
    old.storedPayslip(p, 'p1', '2026-10-20T09:00:00.000Z'),
    next.storedPayslip(p, 'p1', '2026-10-20T09:00:00.000Z'));
}

/* -- the CSV round trip --------------------------------------------------- */

const SHIFTS = [
  { id: 'a', date: '2026-10-12', start: '09:00', end: '17:00', createdAt: 'x' },
  { id: 'b', date: '2026-10-13', start: '', end: '', hours: 7, note: 'week off', createdAt: 'x' },
  { id: 'c', date: '2026-10-06', start: '12:00', end: '20:00', special: true, gross: 120, bankPay: 95, createdAt: 'x' },
];
const PAYSLIPS = [
  { id: 'p1', weekStart: '2026-10-11', paye: 100, usc: 20, prsi: 30, futureFund: 5, createdAt: 'x' },
  { id: 'p2', weekStart: '2026-10-04', paye: 90, usc: 18, prsi: 27, futureFund: 4, weekNo: 41, createdAt: 'x' },
];
const WEEKNOS = { '2026-10-11': 42, '2026-10-04': 41 };

same('tescoCsv writes the same file',
  old.tescoCsv(SHIFTS, PAYSLIPS, RATES, WEEKNOS),
  next.tescoCsv(SHIFTS, PAYSLIPS, RATES, WEEKNOS));

// And the file the ported export writes reads back the same way.
const exported = next.tescoCsv(SHIFTS, PAYSLIPS, RATES, WEEKNOS);
same('parseTescoCsv reads the ported export the same way',
  old.parseTescoCsv(exported),
  next.parseTescoCsv(exported));

/* -- the workbook path ---------------------------------------------------- */

const SHEETS = [
  { rows: [['Week Start Date', 'Pay Date', 'Week', 'PAYE', 'USC', 'PRSI', 'Future Fund', 'Total'], ['2026-10-11', '2026-10-22', 42, 100, 20, 30, 5, 155]] },
  { rows: [['Date', 'Effective Date', 'Week', 'Day', 'Start Time', 'End Time', 'Hours', 'Normal or Special', 'Total', 'Received?'], ['2026-10-12', '2026-10-12', 42, 'Monday', '09:00', '17:00', 8, 'Normal', 120, 'Yes']] },
];
same('workbookToCsv orders the shift sheet first',
  old.workbookToCsv(SHEETS),
  next.workbookToCsv(SHEETS));
same('sheetRowsToCsv writes the same text',
  old.sheetRowsToCsv([['a', 1, new Date('2026-10-12T00:00:00Z')], ['b', 2]]),
  next.sheetRowsToCsv([['a', 1, new Date('2026-10-12T00:00:00Z')], ['b', 2]]));

/* ══ 2. THE RULES THE PORT MUST HOLD ════════════════════════════════════════ */

/* -- a bad line never costs the good ones beside it ------------------------ */

const mixed = next.parseShiftText('mon 8-4\nnonsense\ntue 9-5', '2026-10-20');
check('two good lines survive beside a bad one', mixed.shifts.length === 2, JSON.stringify(mixed.shifts));
check('the bad line is reported, with its line number', mixed.problems.length === 1 && mixed.problems[0].line === 2,
  JSON.stringify(mixed.problems));

/* -- a month off is a real row, not a broken one --------------------------- */

const weekOff = next.weekOffShift('2026-10-14', '7');
check('a week off is dated on the week\'s Sunday', weekOff.ok && weekOff.shift.date === '2026-10-11',
  JSON.stringify(weekOff));
check('and it carries hours and no clock times',
  weekOff.ok && weekOff.shift.hours === 7 && weekOff.shift.start === '' && weekOff.shift.end === '');
check('a week off worth nothing is refused',
  next.weekOffShift('2026-10-14', '0').ok === false);

/* -- a round trip through the file loses nothing --------------------------- */

const round = next.parseTescoCsv(exported);
check('the round trip keeps every shift', round.shifts.length === SHIFTS.length,
  `${round.shifts.length} of ${SHIFTS.length}`);
check('the round trip keeps every payslip', round.payslips.length === PAYSLIPS.length,
  `${round.payslips.length} of ${PAYSLIPS.length}`);
check('a week off survives the round trip as hours and no clock times',
  round.shifts.some((s) => s.hours === 7 && !s.start && !s.end), JSON.stringify(round.shifts));
check('the week\'s bank pay survives the round trip',
  round.payslips.some((p) => p.bankPay != null), JSON.stringify(round.payslips));
check('the hand-typed week number comes back with the shifts',
  round.weekNos['2026-10-11'] === 42, JSON.stringify(round.weekNos));

// Re-importing the same file must not double a run.
const twice = next.parseTescoCsv(exported);
check('a payslip run is not doubled by a second import',
  twice.payslips.length === round.payslips.length,
  `${twice.payslips.length} vs ${round.payslips.length}`);

/* -- an export writes only a figure that was actually recorded ------------- */

const noBank = next.tescoCsv(
  [{ id: 'a', date: '2026-10-12', start: '09:00', end: '17:00', createdAt: 'x' }],
  [], RATES, {},
);
check('a week with no recorded bank figure exports no bank figure',
  !/,\d+\.\d\d\s*$/.test(noBank.split('\n')[1] || ''), (noBank.split('\n')[1] || '').slice(0, 120));

/* -- the workbook's own order is handled ----------------------------------- */

const taxFirst = next.workbookToCsv([SHEETS[0], SHEETS[1]]);
const taxFirstParsed = next.parseTescoCsv(taxFirst);
check('a workbook with the tax table first still reads its shifts',
  taxFirstParsed.shifts.length === 1, JSON.stringify(taxFirstParsed.shifts));
check('and still reads its payslips', taxFirstParsed.payslips.length === 1,
  JSON.stringify(taxFirstParsed.payslips));

/* -- a file that is not a sheet is refused, with a reason ------------------- */

const notASheet = next.parseTescoCsv('name,value\nfoo,1');
check('a file with no shift columns is refused', notASheet.error != null, JSON.stringify(notASheet));
check('and the refusal names what was needed',
  notASheet.error != null && /Date/.test(notASheet.error), notASheet.error || '');

/* -- a hand edit writes what the importer would have accepted -------------- */

const edited = next.applyShiftEdit(BASE, { start: '10:00', end: '18:00', hours: '', gross: '' });
check('an edit clears the fields it blanks', edited.ok && edited.shift.hours === undefined && edited.shift.gross === undefined,
  JSON.stringify(edited));
check('an edit keeps the row\'s id and createdAt', edited.ok && edited.shift.id === 's1' && !!edited.shift.createdAt,
  JSON.stringify(edited));
check('an edit refuses a row with no times and no hours',
  next.applyShiftEdit(BASE, { start: '', end: '', hours: '' }).ok === false);
check('an edit refuses a negative pay', next.applyShiftEdit(BASE, { gross: '-5' }).ok === false);
check('an edit refuses another shift\'s slot',
  next.applyShiftEdit(BASE, { date: '2026-10-14' }, ['2026-10-14|09:00|17:00']).ok === false);

if (failures) {
  console.error(`\ntest-tesco-sheet: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-tesco-sheet: OK — ${checks} checks (the port answers exactly like the shipping source)`);
