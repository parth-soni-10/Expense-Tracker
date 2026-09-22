#!/usr/bin/env node
/**
 * Tesco Pay engine harness.
 *
 * The engine is a port of the Tesco Pay.xlsx model the user built by hand, so
 * these assertions are pinned to the values the spreadsheet itself cached:
 * a week whose gross is €550.525 shows PAYE €33.18 / USC €7.55 / PRSI €23.12 /
 * pension €8.26, and a 07:00–15:00 shift is 7h = €101.08. If a future edit
 * drifts the math, this fails the deploy instead of silently mis-paying.
 *
 * Run: node scripts/test-tesco.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import {
  paidHours, parseHM, fmtHM, shiftPay, simulateTax, r2,
  weekStartOf, payDateOf, buildPayWeeks, monthSummary, lifetimeTotals,
  payslipTotal, parseTimeCell, parseRosterWords, isSunday, nameMatches, ocrStripRanges,
  tescoCsv, parseTescoCsv, TESCO_CSV_HEADER, TESCO_CSV_PAYSLIP_HEADER, isoWeekNumber, weekNumberOf,
} from '../tesco.js';

let pass = 0;
const fails = [];
function ok(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n     got ${g}\n    want ${w}`);
}
const near = (label, got, want, eps = 0.005) =>
  Math.abs(got - want) <= eps ? pass++ : fails.push(`${label}\n     got ${got}\n    want ${want}`);

// ---------- hours: the spreadsheet's break ladder ----------
// 07:00–15:00 starts before noon and runs ≥7h → −1h.
ok('07:00–15:00 = 7h (pre-noon, −60m)', paidHours(parseHM('7:00'), parseHM('15:00')), 7);
// 12:00–22:00 starts at noon, so the >7h rung applies → −45m.
ok('12:00–22:00 = 9.25h (>7h, −45m)', paidHours(parseHM('12:00'), parseHM('22:00')), 9.25);
// A 7h shift starting at noon falls to the >6h rung (−30m), not the −60m rung.
ok('12:00–19:00 = 6.5h (>6h, −30m)', paidHours(parseHM('12:00'), parseHM('19:00')), 6.5);
ok('13:00–18:30 = 5.25h (5.5h raw, >5h rung −15m)', paidHours(parseHM('13:00'), parseHM('18:30')), 5.25);
ok('13:00–17:00 = 4h (no break)', paidHours(parseHM('13:00'), parseHM('17:00')), 4);
// Overnight: 20:00 → 01:00 next day.
ok('20:00–01:00 = 5h overnight', paidHours(parseHM('20:00'), parseHM('01:00')), 5);

// ---------- pay ----------
const s = { date: '2026-09-17', start: '07:00', end: '15:00' }; // a Thursday
ok('Thu 7h normal gross = €101.08', shiftPay(s, null).gross, 101.08);
ok('Thu 7h is not special', shiftPay(s, null).special, false);
ok('Sunday 7h gross = €151.62 (×1.5)', shiftPay({ ...s, date: '2026-09-20' }, null).gross, 151.62);
ok('Sunday detected', isSunday('2026-09-20'), true);
ok('Sunday special auto-applies', shiftPay({ ...s, date: '2026-09-20' }, null).special, true);
ok('manual special flag pays ×1.5 on a weekday', shiftPay({ ...s, special: true }, null).gross, 151.62);

// ---------- tax: the cached cells from the workbook ----------
const t = simulateTax(550.525, null);
ok('PAYE on €550.525 = 33.18 (Excel half-up, not 33.17)', t.paye, 33.18);
ok('USC on €550.525 = 7.55', t.usc, 7.55);
ok('PRSI on €550.525 = 23.12 (credit fully tapered out)', t.prsi, 23.12);
ok('pension 1.5% = 8.26', t.pension, 8.26);
ok('total tax = 63.85', t.tax, 63.85);
ok('net = 478.42', t.net, 478.42);
// The pension is subtracted at its raw 1.5% (O17 = L−M−N), so a gross whose
// pension lands on a half-cent rounds the net up instead of down: €287.00
// (13.25h on a Sunday) has a raw pension of €4.305 → net €268.37, not €268.36.
ok('net subtracts the raw pension (€287 → 268.37)', simulateTax(287, null).net, 268.37);
ok('…while the pension itself still displays rounded', simulateTax(287, null).pension, 4.31);
// The €76.93 credit swallows all PAYE below the cutoff.
ok('PAYE floored at 0 under the credit', simulateTax(300, null).paye, 0);
// PRSI credit tapers across €352.01–424.
ok('PRSI credit gone above €424', simulateTax(500, null).prsi, r2(500 * 0.042));
near('PRSI tapers inside the €352–424 band', simulateTax(400, null).prsi, r2(400 * 0.042 - (12 - (400 - 352.01) / 6)));
ok('USC bands: 0.5% up to €231', simulateTax(200, null).usc, 1);
ok('no negative tax on a zero week', simulateTax(0, null), { paye: 0, usc: 0, prsi: 0, pension: 0, tax: 0, net: 0 });

// ---------- pay weeks: the workbook's own week, row for row ----------
// Sheet row 17 is the Sunday 20 Sep 2026 block: L17 = SUM(J13:J17) = €550.525
// across Sun 20 → Sat 26, with M17 = €63.85 tax, N17 = €8.257875 pension and
// O17 = €478.417 net. Those five shifts are rebuilt here from their times
// (12:00–20:00 → 7.25h, 12:00–19:00 → 6.5h, 07:00–15:00 → 7h), so the engine
// has to reproduce the sheet's cached week to the cent.
const weekShifts = [
  { id: 'a', date: '2026-09-20', start: '12:00', end: '20:00' }, // Sun, 7.25h, special
  { id: 'b', date: '2026-09-21', start: '12:00', end: '19:00' }, // Mon, 6.5h
  { id: 'c', date: '2026-09-23', start: '12:00', end: '19:00' }, // Wed, 6.5h
  { id: 'd', date: '2026-09-25', start: '12:00', end: '20:00' }, // Fri, 7.25h
  { id: 'e', date: '2026-09-26', start: '07:00', end: '15:00' }, // Sat, 7h
];
ok('a Sunday starts the pay week', weekStartOf('2026-09-20'), '2026-09-20');
ok('the Saturday before it closes the previous week', weekStartOf('2026-09-19'), '2026-09-13');
ok('Sunday→Saturday is one week', weekStartOf('2026-09-26'), '2026-09-20');
ok('the payslip lands 11 days later (Thursday)', payDateOf('2026-09-20'), '2026-10-01');

const weeks = buildPayWeeks(weekShifts, []);
ok('one pay week', weeks.length, 1);
ok('week hours = 34.5', weeks[0].hours, 34.5);
ok('week gross = €550.53 (sheet L17)', weeks[0].gross, 550.53);
const wk = simulateTax(weeks[0].gross, null);
ok('week tax = €63.85 (sheet M17)', wk.tax, 63.85);
ok('week pension = €8.26 (sheet N17)', wk.pension, 8.26);
ok('week net = €478.42 (sheet O17)', wk.net, 478.42);

// Payslips join their week, and refunds (negative PAYE) net out — the €56.08
// refund is the sheet's own row (week 40's PAYE reversed in week 41).
// "Received" is the sheet's Calculated Income (O = gross − tax − pension), so
// it is the net the payslip leaves behind, not the tax it withheld.
const refundShifts = [{ id: 'f', date: '2026-09-09', start: '07:00', end: '15:00' }]; // Wed, 7h, €101.08
const payslips = [
  { id: 'p', weekStart: '2026-09-20', paye: 33.18, usc: 7.55, prsi: 23.12, futureFund: 8.26 },
  { id: 'q', weekStart: '2026-09-12', paye: -56.08, usc: 0, prsi: 0, futureFund: 0 },
  { id: 'r', weekStart: '2026-08-23', paye: 10, usc: 0, prsi: 0, futureFund: 0 }, // no shifts beside it
];
const withSlips = [...weekShifts, ...refundShifts];
ok('payslip total = 72.11 (sheet R17)', payslipTotal(payslips[0]), 72.11);
ok('a refund payslip is negative', payslipTotal(payslips[1]), -56.08);
ok('payslip attaches to its week', buildPayWeeks(withSlips, payslips).find(w => w.weekStart === '2026-09-20').payslip.id, 'p');
ok('a payslip week with no shifts still lists', buildPayWeeks(withSlips, payslips).length, 3);
ok('received = 550.53 − 72.11 = €478.42 net (sheet O17)', lifetimeTotals(withSlips, [payslips[0]]).received, 478.42);
ok('a refund week receives 101.08 + 56.08 = €157.16', lifetimeTotals(withSlips, [payslips[1]]).received, 157.16);
ok('a payslip with no shifts beside it adds nothing', lifetimeTotals(withSlips, [payslips[2]]).received, 0);
ok('lifetime received = €635.58', lifetimeTotals(withSlips, payslips).received, 635.58);
ok('lifetime hours = 41.5', lifetimeTotals(withSlips, payslips).hours, 41.5);

// September 2026: the six shifts above all fall in it, and the August payslip
// week drops out of the month's received.
const sep = monthSummary(withSlips, payslips, null, 2026, 8);
ok('September hours = 41.5', sep.hours, 41.5);
ok('September anticipated = €651.61', sep.anticipated, 651.61);
ok('September received = €635.58 (August week excluded)', sep.received, 635.58);

// ---------- week numbers: the sheet's own column ----------
// The sheet hand-types it (1..52/53 from where its pay year starts, restarting
// at 1), so a stored number is authoritative and carries one per week either
// side of it.
ok('with nothing stored the ISO week stands in', weekNumberOf('2026-09-20', {}), isoWeekNumber('2026-09-20'));
ok('a stored number wins', weekNumberOf('2026-09-20', { '2026-09-20': 30 }), 30);
ok('it carries forward one per week', weekNumberOf('2026-09-27', { '2026-09-20': 30 }), 31);
ok('and back one per week', weekNumberOf('2026-09-13', { '2026-09-20': 30 }), 29);
ok('both sides of a year reset are kept', [
  weekNumberOf('2026-02-22', { '2026-02-22': 53, '2026-03-01': 1 }),
  weekNumberOf('2026-03-01', { '2026-02-22': 53, '2026-03-01': 1 }),
], [53, 1]);
ok('counting back past a reset falls back to ISO, not to nought',
  weekNumberOf('2026-02-22', { '2026-09-20': 30 }), isoWeekNumber('2026-02-22'));
ok('a corrupt stored value is ignored', weekNumberOf('2026-09-20', { '2026-09-20': 'x' }), isoWeekNumber('2026-09-20'));

// ---------- CSV: the workbook's columns, out and back ----------
// The reference document's Data sheet, header and all. The weekly figures ride
// the week's first row (the Sunday, since a pay week runs Sun → Sat), which is
// where the sheet puts them too.
const csv = tescoCsv(weekShifts, [payslips[0]], null);
// The shift table alone — the tax table rides below it, asserted further down.
const lines = csv.trim().split('\r\n').slice(0, weekShifts.length + 1);
ok('CSV header is the sheet’s own, column for column', lines[0].split(','), [...TESCO_CSV_HEADER]);
ok('one row per shift', lines.length, weekShifts.length + 1);
const cells = r => lines[r].split(',');
ok('newest first, as the sheet reads', cells(1)[0], '2026-09-26');
ok('a Saturday reads its weekday name and pay', cells(1).slice(3, 9), ['Saturday', '07:00', '15:00', '7.00', 'Normal', '101.08']);
const sunRow = lines.findIndex(l => l.startsWith('2026-09-20'));
ok('the Sunday closes its week (newest first)', sunRow, 5);
ok('the Sunday is hour-and-a-half paid', cells(sunRow).slice(6, 9), ['7.25', 'Special', '157.04']);
ok('the Sunday carries the week: gross/tax/pension/net', cells(sunRow).slice(10, 14), ['550.53', '63.85', '8.26', '478.42']);
ok('Received? marks the week whose payslip exists', cells(sunRow)[9], 'Yes');
ok('Final Bank Pay is what the payslip left (550.53 − 72.11)', cells(sunRow)[14], '478.42');
ok('a mid-week row carries no weekly figures', cells(1).slice(10, 15), ['', '', '', '', '']);
ok('the week column is the app’s ISO week', cells(sunRow)[2], String(isoWeekNumber('2026-09-20')));
ok('a pay week shares one week number, as the sheet groups it',
  [...new Set(lines.slice(1).map(l => l.split(',')[2]))], [String(isoWeekNumber('2026-09-20'))]);
// With the sheet's own numbering stored, that is what the column carries.
const sheetNumbered = tescoCsv(weekShifts, [], null, { '2026-09-20': 30 });
ok('the sheet’s week number replaces the ISO one in the file',
  [...new Set(sheetNumbered.trim().split('\r\n').slice(1).map(l => l.split(',')[2]))], ['30']);
ok('and it reads back with the rows', parseTescoCsv(sheetNumbered).weekNos, { '2026-09-20': 30 });
ok('a file with no week column leaves the map empty', parseTescoCsv('Date,Start Time,End Time\r\n2026-09-20,12:00,20:00').weekNos, {});
ok('rows are CRLF-terminated for Excel', csv.endsWith('\r\n'), true);

// The tax table, as the sheet keeps it in its own block: one row per payslip
// week, oldest first, with the pay date derived from the week.
const withTax = tescoCsv(weekShifts, payslips, null);
ok('a tax table follows the shift table', withTax.includes(`\r\n\r\n${TESCO_CSV_PAYSLIP_HEADER.join(',')}`), true);
const taxRows = tescoCsv(weekShifts, [payslips[0]], null).trim().split('\r\n').slice(-1)[0].split(',');
ok('a tax row carries the week, pay date and the four figures', taxRows, ['2026-09-20', '2026-10-01', '33.18', '7.55', '23.12', '8.26']);
// A payslip is exported against its pay week's Sunday, which is how the app
// already reads it (the 12 Sep refund belongs to the week starting the 6th).
ok('every payslip survives the round trip', parseTescoCsv(withTax).payslips, [
  { weekStart: '2026-08-23', paye: 10, usc: 0, prsi: 0, futureFund: 0 },
  { weekStart: '2026-09-06', paye: -56.08, usc: 0, prsi: 0, futureFund: 0 },
  { weekStart: '2026-09-20', paye: 33.18, usc: 7.55, prsi: 23.12, futureFund: 8.26 },
]);
ok('tax rows are never read as shifts', parseTescoCsv(withTax).shifts.length, weekShifts.length);
ok('a payslip week snaps to its Sunday', parseTescoCsv('Week Start Date,Pay Date,PAYE,USC,PRSI,Future Fund\r\n2026-09-23,2026-10-04,5,1,2,3').payslips,
  [{ weekStart: '2026-09-20', paye: 5, usc: 1, prsi: 2, futureFund: 3 }]);
ok('a tax table alone still imports', parseTescoCsv('Week Start Date,Pay Date,PAYE,USC,PRSI,Future Fund\r\n2026-09-20,2026-10-01,33.18,7.55,23.12,8.26').shifts.length, 0);
// The sheet holds two pay runs inside one week (USC on the Sunday and the
// Friday) — the same week's tax, so they add up into one payslip.
ok('two pay runs in one week add into one payslip',
  parseTescoCsv('Week Start Date,Pay Date,PAYE,USC,PRSI,Future Fund\r\n2025-12-07,2025-12-18,0,0.70,0,0\r\n2025-12-12,2025-12-23,0,0.56,0,0').payslips,
  [{ weekStart: '2025-12-07', paye: 0, usc: 1.26, prsi: 0, futureFund: 0 }]);

const back = parseTescoCsv(csv);
ok('the export reads back clean', [back.shifts.length, back.skipped, back.error], [5, 0, null]);
// The file is newest-first; compare as sets so the file's order is not the point.
const fingerprint = list => list.map(s => `${s.date} ${s.start}-${s.end} ${s.special}`).sort();
ok('every shift survives the round trip', fingerprint(back.shifts), fingerprint(weekShifts.map(s => ({ ...s, special: isSunday(s.date) }))));
// A note with a comma and quotes has to survive both directions.
const noted = [{ id: 'n', date: '2026-08-31', start: '12:00', end: '19:00', note: 'Bank Holiday, “extra”' }];
ok('a quoted note round-trips', parseTescoCsv(tescoCsv(noted, [], null)).shifts[0].note, 'Bank Holiday, “extra”');

// A note a spreadsheet would run as a formula leaves as text: notes can be
// typed, imported from a file someone else made, or arrive in a synced cloud
// copy, so the export must not hand Excel something to execute.
const formulaNotes = [
  { id: 'f1', date: '2026-08-31', start: '09:00', end: '17:00', note: '=HYPERLINK("http://evil.example","x")' },
  { id: 'f2', date: '2026-09-01', start: '09:00', end: '17:00', note: '+SUM(A1:A9)' },
  { id: 'f3', date: '2026-09-02', start: '09:00', end: '17:00', note: '-30 min unpaid' },
  { id: 'f4', date: '2026-09-03', start: '09:00', end: '17:00', note: '  @break' },
];
const formulaCsv = tescoCsv(formulaNotes, [], null);
ok('a formula-shaped note leaves as text, not as a live formula',
  ["'=HYPERLINK", "'+SUM(A1:A9)", "'-30 min unpaid", "'  @break"].every(frag => formulaCsv.includes(frag)), true);
// …and the guards are not one-way corruption: an ordinary note, and one that
// merely starts with a minus, come back exactly as they were typed.
const plainNotes = [
  { id: 'p1', date: '2026-08-31', start: '09:00', end: '17:00', note: '-30 min unpaid' },
  { id: 'p2', date: '2026-09-01', start: '09:00', end: '17:00', note: 'Overtime +4 from 6pm' },
];
ok('the apostrophe guard round-trips to the note that was typed',
  parseTescoCsv(tescoCsv(plainNotes, [], null)).shifts.map(s => s.note).sort(),
  ['-30 min unpaid', 'Overtime +4 from 6pm'].sort());
// Lossless in both directions, leading whitespace included.
ok('and the formula-shaped ones do too',
  parseTescoCsv(formulaCsv).shifts.map(s => s.note).sort(),
  ['=HYPERLINK("http://evil.example","x")', '+SUM(A1:A9)', '-30 min unpaid', '  @break'].sort());

// What Excel's own "Save as CSV" of the sheet looks like: a leading empty column
// A, a day-first date, seconds on the times, the sheet's header text — plus a
// row using an Excel serial date and a bare day fraction for the times.
const excelCsv = [
  'Data,,',
  ',Date,Effective Date,Week,Day,Start Time,End Time,Hours,Normal or Special,Total,Received?,Gross Income,Potential Tax,Pension,Calculated Income,Final Bank Pay,Description',
  ',20/09/2026,20/09/2026,30,Sunday,12:00:00,20:00:00,7.25,Special,157.03,Yes,550.52,63.85,8.26,478.42,,new 15 minute break ',
  ',46285,46285,30,Sunday,0.5,0.83333333333333337,7.25,Special,157.03,,,,,,serial date and day fraction',
  ',,,30,Monday,,,,,,,,,,,no times at all',
].join('\r\n');
const excel = parseTescoCsv(excelCsv);
ok('Excel’s export imports despite its title row and empty column A', [excel.shifts.length, excel.skipped, excel.error], [2, 1, null]);
ok('day-first dates and HH:MM:SS times read', `${excel.shifts[0].date} ${excel.shifts[0].start}-${excel.shifts[0].end}`, '2026-09-20 12:00-20:00');
ok('an Excel serial date and day-fraction times read too', `${excel.shifts[1].date} ${excel.shifts[1].start}-${excel.shifts[1].end}`, '2026-09-20 12:00-20:00');
ok('the special flag comes across', excel.shifts.map(s => s.special), [true, true]);
ok('notes are trimmed', excel.shifts[0].note, 'new 15 minute break');
ok('a file with no times column is rejected with a reason', parseTescoCsv('Name,Amount\r\nCoffee,3.50').error, 'That file needs Date, Start Time and End Time columns.');
ok('an empty file is rejected too', !!parseTescoCsv('').error, true);

// ---------- OCR text parsing (pure — no engine needed) ----------
ok('14-22 parses', parseTimeCell('14-22'), { startMin: 840, endMin: 1320 });
ok('trailing period tolerated', parseTimeCell('7-15.'), { startMin: 420, endMin: 900 });
ok('letter-for-digit noise fixed (I5-2O → 15-20)', parseTimeCell('I5-2O'), { startMin: 900, endMin: 1200 });
ok('off is skipped', parseTimeCell('off'), null);
ok('blank is skipped', parseTimeCell(''), null);
ok('prose is skipped', parseTimeCell('training'), null);
// A 5:30 reading with a 12:30 start is an afternoon shift (17:30), not next-day.
ok('12:30-5:30 = 5h afternoon', parseTimeCell('12:30-5:30'), { startMin: 750, endMin: 1050 });
// 20-01 has no sane PM reading (+12h = 33h), so it rolls past midnight.
ok('20-01 rolls past midnight', parseTimeCell('20-01'), { startMin: 1200, endMin: 1500 });

// No date row read at all: the seven days are laid out across the span the
// time cells occupy, from the week's first day, and rows stay separate.
const bandWords = [
  { text: 'Parth', x0: 6, y0: 40, x1: 90, y1: 70, confidence: 90 },
  { text: '7-15', x0: 10, y0: 90, x1: 70, y1: 120, confidence: 90 },
  { text: '12-22', x0: 300, y0: 90, x1: 380, y1: 120, confidence: 90 },
  { text: 'off', x0: 590, y0: 90, x1: 640, y1: 120, confidence: 90 },
  { text: '7-15', x0: 880, y0: 90, x1: 950, y1: 120, confidence: 90 },
];
const parsed = parseRosterWords(bandWords, new Date(Date.UTC(2026, 8, 22)), { fallback: { weekStart: '2026-09-19' } });
ok('headerless photo still yields one row', parsed.rows.length, 1);
ok('that row has no name beside it', parsed.rows[0].name, '(unnamed row)');
const row = parsed.rows[0];
ok('headerless read keeps only the three real cells (off skipped)', row.cells.length, 3);
ok('cells carry a date', row.cells.every(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date)), true);
ok('cells carry times', row.cells.map(c => `${fmtHM(c.startMin)}-${fmtHM(c.endMin)}`), ['07:00-15:00', '12:00-22:00', '07:00-15:00']);
ok('cells land on the first, third and seventh days', row.cells.map(c => c.date), ['2026-09-19', '2026-09-21', '2026-09-25']);
ok('total hours = 23.25', r2(row.cells.reduce((n, c) => n + paidHours(c.startMin, c.endMin), 0)), 23.25);
ok('low-confidence noise is dropped', parseRosterWords([{ text: 'xyz', x0: 1, y0: 1, x1: 2, y1: 2, confidence: 10 }], new Date(), { fallback: { weekStart: '2026-09-19' } }).rows.length, 0);

// ---------- name matching (what replaces "drag a band over your row") ----------
ok('exact name matches', nameMatches('Parth', 'Parth'), true);
ok('case and spacing are folded', nameMatches('  PARTH  ', 'parth'), true);
ok('digit-for-letter noise (Par1h) still matches', nameMatches('Par1h', 'Parth'), true);
ok('letter-for-letter noise (Partb) still matches', nameMatches('Partb', 'Parth'), true);
ok('a full name on the sheet matches the first name', nameMatches('Parth Sharma', 'Parth'), true);
ok('a surname-only read still matches a full typed name', nameMatches('Sharma', 'Parth Sharma'), true);
ok('a different name does not match', nameMatches('Padraig', 'Parth'), false);
ok('a two-letter token is not a match', nameMatches('Pa', 'Parth'), false);
ok('an empty name never matches', nameMatches('Parth', ''), false);

// The strips the photo is read in: half-height, overlapping by half, covering
// the whole sheet — so no row is cut by a boundary and none is skipped.
const strips = ocrStripRanges();
ok('three strips', strips.length, 3);
ok('the first starts at the top', strips[0][0], 0);
ok('the last ends at the bottom', strips[strips.length - 1][1], 1);
ok('each strips is half the height', strips.every(([a, b]) => r2(b - a) <= 0.5), true);
ok('they overlap by half', [r2(strips[1][0]), r2(strips[2][0])], [0.25, 0.5]);

// A tilted photo, as the strips arrive stitched together: the header drifted a
// pixel per column and each row sits a little lower than the last, so rows have
// to be grouped by proximity rather than by a fixed line. The typed name is
// what picks the row out of the sheet.
const col = i => 220 + i * 160;
const HEADER = [['Sun', '20-Sep'], ['Mon', '21-Sep'], ['Tue', '22-Sep'], ['Wed', '23-Sep'], ['Thu', '24-Sep'], ['Fri', '25-Sep'], ['Sat', '26-Sep']];
const tilted = [
  { text: 'Roster', x0: 20, y0: 26, x1: 120, y1: 56, confidence: 96 },
  ...HEADER.map(([day], i) => ({ text: day, x0: col(i) - 34, y0: 100 + i, x1: col(i) + 34, y1: 130 + i, confidence: 92 })),
  // the date row sits below the day names, drifting a pixel per column
  ...HEADER.map(([, date], i) => ({ text: date, x0: col(i) - 40, y0: 136 + i, x1: col(i) + 40, y1: 166 + i, confidence: 88 })),
  { text: 'Parth', x0: 10, y0: 210, x1: 98, y1: 240, confidence: 93 },
  { text: '7-15', x0: col(0) - 32, y0: 212, x1: col(0) + 32, y1: 242, confidence: 90 },
  { text: '12-22', x0: col(3) - 32, y0: 214, x1: col(3) + 32, y1: 244, confidence: 88 },
  { text: 'Padraig', x0: 8, y0: 272, x1: 104, y1: 302, confidence: 90 },
  { text: '9-17', x0: col(1) - 30, y0: 274, x1: col(1) + 30, y1: 304, confidence: 90 },
];
const sheet = parseRosterWords(tilted, new Date(Date.UTC(2026, 8, 22)), { name: 'parth' });
ok('both staff rows are read', sheet.rows.map(r => r.name), ['Parth', 'Padraig']);
ok('the typed name flags its own row', sheet.rows.map(r => r.matches), [true, false]);
ok('the matched row is first, so the editor opens on it', sheet.rows.findIndex(r => r.matches), 0);
ok('its cells land on the days their columns sit under', sheet.rows[0].cells.map(c => c.date), ['2026-09-20', '2026-09-23']);
ok('its cells carry the times from the photo', sheet.rows[0].cells.map(c => `${fmtHM(c.startMin)}-${fmtHM(c.endMin)}`), ['07:00-15:00', '12:00-22:00']);
ok('its cells total 16.25h', r2(sheet.rows[0].cells.reduce((n, c) => n + paidHours(c.startMin, c.endMin), 0)), 16.25);
ok('the other row lands on its own day', sheet.rows[1].cells.map(c => c.date), ['2026-09-21']);
ok('an unmatched name flags nothing', parseRosterWords(tilted, new Date(Date.UTC(2026, 8, 22)), { name: 'Nobody' }).rows.every(r => !r.matches), true);

// ---------- report ----------
if (fails.length) {
  console.error(`test-tesco: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f.replace(/^/, '').replace(/\n     /g, '\n     '));
  process.exit(1);
}
console.log(`test-tesco: OK — ${pass} assertions passed (engine matches the workbook's cached values)`);
