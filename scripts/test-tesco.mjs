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
import { readFileSync } from 'node:fs';
import {
  scanSlotForProfile,
  paidHours, parseHM, fmtHM, shiftPay, simulateTax, r2,
  weekStartOf, payDateOf, buildPayWeeks, monthSummary, lifetimeTotals,
  payslipTotal, parseTimeCell, parseRosterWords, isSunday, nameMatches, ocrStripRanges, ocrInkBands, ocrPickBand, ocrFlatField,
  TESCO_RATE_DEFAULTS,
  tescoCsv, parseTescoCsv, TESCO_CSV_HEADER, TESCO_CSV_PAYSLIP_HEADER, isoWeekNumber, weekNumberOf, payslipWeekNumberOf,
  parseShiftText, shiftPreviewLine,
  storedShift, storedPayslip, applyShiftEdit,
  rosterColumnBounds, parseCellTokens,
  pageSkew, dedupeWords, columnAnchors, resolveColumnDates, ocrEstimateTilt, ocrAutoContrast,
} from '../tesco.js';
import { validateState } from '../storage.js';

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

// A correction run inside one week: the sheet's tax table holds two rows for
// the week of 6 Dec 2025 (€0.70 and €0.56) and the app stores two payslips, so
// the week's tax is both of them — keeping only the later one under-reported
// that week against the sheet's own total (€1,004.10 vs €1,004.80).
const twoRuns = [
  { id: 'x', weekStart: '2026-09-20', paye: 1, usc: 0, prsi: 0, futureFund: 0 },
  { id: 'y', weekStart: '2026-09-23', paye: 2, usc: 0, prsi: 0, futureFund: 0 },
];
const runWeek = buildPayWeeks(weekShifts, twoRuns).find(w => w.weekStart === '2026-09-20');
ok('two pay runs in one week both count', runWeek.paid, 3);
ok('and both are kept for the tab to show', runWeek.payslips.length, 2);
ok('the week received nets both runs off the gross', lifetimeTotals(weekShifts, twoRuns).received, r2(550.53 - 3));

// The sheet's Final Bank Pay (its tax table's net, typed from a statement): it
// is the money that actually landed, so it wins over gross − tax. That is how
// holiday pay, a refund or a correction is counted — and how a paid week with
// no shifts at all stops reading as €0 received.
const banked = { ...payslips[0], bankPay: 600 };
ok('an entered net replaces gross − tax', lifetimeTotals(withSlips, [banked]).received, 600);
ok('a paid week with no shifts receives its net', lifetimeTotals(withSlips, [{ ...payslips[2], bankPay: 316.99 }]).received, 316.99);
ok('its month counts it too', monthSummary(withSlips, [{ ...payslips[2], bankPay: 316.99 }], null, 2026, 7).received, 316.99);
ok('an absent net still falls back to gross − tax', lifetimeTotals(withSlips, [payslips[0]]).received, 478.42);
ok('two runs with a net each add up',
  lifetimeTotals(weekShifts, [{ ...twoRuns[0], bankPay: 300 }, { ...twoRuns[1], bankPay: 200 }]).received, 500);

// A custom hourly rate must reach the week and lifetime totals, not only the
// per-shift rows: a user on €15/h had one card print €157.50 + €112.50 beside
// the shifts while ITS OWN week total still read €259.92, computed at the
// built-in defaults, and the dashboard summary disagreed with both.
const customRates = { ...TESCO_RATE_DEFAULTS, normal: 15 };
const customGross = r2(weekShifts.reduce((sum, s) => sum + shiftPay(s, customRates).gross, 0));
const customWeeks = buildPayWeeks(weekShifts, [], customRates);
ok("a week's gross uses the custom rate", customWeeks[0].gross, customGross);
ok('and is not the default-rate figure', customWeeks[0].gross === 550.53, false);
ok('lifetime anticipated uses the custom rate', lifetimeTotals(weekShifts, [], customRates).anticipated, customGross);
ok('received nets the payslip off the custom-rate gross',
  lifetimeTotals(withSlips, [payslips[0]], customRates).received, r2(customGross - payslipTotal(payslips[0])));
const sepCustom = monthSummary(weekShifts, [payslips[0]], customRates, 2026, 8);
ok("a month's anticipated uses the custom rate", sepCustom.anticipated, customGross);
ok("and its received nets the payslip off that same gross", sepCustom.received, r2(customGross - payslipTotal(payslips[0])));
ok('the CSV export carries the custom-rate gross',
  tescoCsv(weekShifts, [], customRates, new Map()).includes(customGross.toFixed(2)), true);

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

// ---------- payslips: the week number and pay date the card prints ----------
// The payslips card names the week each row belongs to — a display, since the
// week card owns the value — and the day the money lands, so a row can be
// matched against the paper payslip and against a bank statement.
ok('a payslip takes the number of the week it falls in',
  payslipWeekNumberOf({ id: 'p', weekStart: '2026-09-20' }, {}), isoWeekNumber('2026-09-20'));
ok('and follows a number typed on the week card',
  payslipWeekNumberOf({ id: 'p', weekStart: '2026-09-20' }, { '2026-09-20': 30 }), 30);
// The sheet's tax table carries its own Week column, so a number that arrived
// with the row — imported, or typed on a second pay run inside the same Sun →
// Sat week — is the row's own and outranks the week's derived number.
ok('a number the row itself carries wins over the week card',
  payslipWeekNumberOf({ id: 'p', weekStart: '2026-09-20', weekNo: 41 }, { '2026-09-20': 30 }), 41);
ok('a second pay run in one week still shows that week’s number',
  payslipWeekNumberOf({ id: 'q', weekStart: '2026-09-19', weekNo: 41 }, {}), 41);
ok('and snaps to the week when the row carries no number',
  payslipWeekNumberOf({ id: 'q', weekStart: '2026-09-19' }, {}), isoWeekNumber('2026-09-13'));
ok('an out-of-range number the row carries is ignored',
  payslipWeekNumberOf({ id: 'p', weekStart: '2026-09-20', weekNo: 54 }, { '2026-09-20': 30 }), 30);
ok('a payslip with no usable date prints no number rather than a guess',
  payslipWeekNumberOf({ id: 'p' }, {}), null);

// The pay date is the week's Sunday + 11 days, and the weekday is the point of
// the formula: the money lands on a Thursday. The user's own example — the week
// of 13 Sep 2026 paying on 24 Sep 2026 — is pinned first, then a whole year of
// pay weeks, so the Thursday claim can't be a coincidence of one date.
ok('the week starting Sun 13 Sep 2026 pays on Thu 24 Sep 2026', payDateOf('2026-09-13'), '2026-09-24');
const sundays = [];
for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2026, 11, 31); d += 86400000) {
  const ws = weekStartOf(new Date(d).toISOString().slice(0, 10));
  if (sundays[sundays.length - 1] !== ws) sundays.push(ws);
}
ok('a whole year of pay weeks, every one paying on the Thursday',
  [...new Set(sundays.map(iso => new Date(`${payDateOf(iso)}T00:00:00Z`).getUTCDay()))], [4]);
ok('and each exactly 11 days after its week start',
  [...new Set(sundays.map(iso => (Date.parse(`${payDateOf(iso)}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400000))], [11]);

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
// Final Bank Pay is typed from a bank statement, so a week that recorded no
// net exports a blank cell — the engine still derives received as gross − tax
// (asserted above), but a derived figure written here would come back on the
// next import looking like one the bank confirmed.
ok('Final Bank Pay stays blank while no net was recorded', cells(sunRow)[14], '');
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
const rowTotal = row => (Number(row[3]) + Number(row[4]) + Number(row[5]) + Number(row[6])).toFixed(2);
ok('a tax row carries the week start, pay date, week, four figures and total', taxRows,
  ['2026-09-20', '2026-10-01', String(isoWeekNumber('2026-09-20')), '33.18', '7.55', '23.12', '8.26', '72.11']);
ok('a tax row totals its own four figures', taxRows[7], rowTotal(taxRows));
const bankRow = tescoCsv(weekShifts, [banked], null).trim().split('\r\n').slice(-1)[0].split(',');
ok('a net that landed leaves the tax row’s own figures alone', bankRow[7], rowTotal(bankRow));
ok('and the week row stays blank beside it', cells(lines.findIndex(l => l.startsWith('2026-09-20')))[14], '');
ok('the stored net reaches the shift table’s Final Bank Pay',
  tescoCsv(weekShifts, [banked], null).trim().split('\r\n').find(l => l.startsWith('2026-09-20')).split(',')[14], '600.00');
ok('an entered net round-trips', parseTescoCsv(tescoCsv(weekShifts, [banked], null)).payslips[0].bankPay, 600);
ok('a week with no recorded net round-trips as no net', parseTescoCsv(csv).payslips[0].bankPay, undefined);
ok('a second pay run keeps its own date in the file',
  tescoCsv(weekShifts, [payslips[1]], null).includes('2026-09-12,'), true);
// A payslip keeps the date the sheet typed for its row (the 12 Sep refund is
// its own row in the sheet's tax table) rather than the Sunday the engine
// groups it by — the file has to be able to write back what the sheet says.
ok('every payslip survives the round trip', parseTescoCsv(withTax).payslips, [
  { weekStart: '2026-08-23', paye: 10, usc: 0, prsi: 0, futureFund: 0, weekNo: isoWeekNumber('2026-08-23') },
  { weekStart: '2026-09-12', paye: -56.08, usc: 0, prsi: 0, futureFund: 0, weekNo: isoWeekNumber('2026-09-06') },
  // No net was recorded for this week, so none comes back: an absent one stays
  // unknown rather than being filled in with gross − tax.
  { weekStart: '2026-09-20', paye: 33.18, usc: 7.55, prsi: 23.12, futureFund: 8.26, weekNo: isoWeekNumber('2026-09-20') },
]);
ok('tax rows are never read as shifts', parseTescoCsv(withTax).shifts.length, weekShifts.length);
// A row keeps its own date, and the engine is what snaps it to the week's
// Sunday when it groups — so a Wednesday pay run still lands in its week.
const wednesday = parseTescoCsv('Week Start Date,Pay Date,PAYE,USC,PRSI,Future Fund\r\n2026-09-23,2026-10-04,5,1,2,3').payslips;
ok('a payslip keeps its own date', wednesday, [{ weekStart: '2026-09-23', paye: 5, usc: 1, prsi: 2, futureFund: 3 }]);
ok('and the engine snaps it onto the week', buildPayWeeks([], wednesday, null)[0].weekStart, weekStartOf('2026-09-23'));
ok('a tax table alone still imports', parseTescoCsv('Week Start Date,Pay Date,PAYE,USC,PRSI,Future Fund\r\n2026-09-20,2026-10-01,33.18,7.55,23.12,8.26').shifts.length, 0);
// The sheet holds two pay runs inside one week (USC on the Sunday and the
// Friday). Each keeps its own row and its own typed date — folding them into
// one dropped a row from the file — and buildPayWeeks adds them up for the
// week (asserted above as 'two pay runs in one week both count').
ok('two pay runs in one week keep their own rows',
  parseTescoCsv('Week Start Date,Pay Date,PAYE,USC,PRSI,Future Fund\r\n2025-12-07,2025-12-18,0,0.70,0,0\r\n2025-12-12,2025-12-23,0,0.56,0,0').payslips,
  [{ weekStart: '2025-12-07', paye: 0, usc: 0.7, prsi: 0, futureFund: 0 },
   { weekStart: '2025-12-12', paye: 0, usc: 0.56, prsi: 0, futureFund: 0 }]);

// ---------- import: a row keeps its own hours, pay and week ----------
// The sheet's older rows were worked at rates that have since changed (14.02
// against today's 14.44) and its older blocks break a shift differently, so a
// row's own figures beat both the clock-derived hours and the rate card.
const legacy = parseTescoCsv('Date,Start Time,End Time,Hours,Normal or Special,Total,Description\r\n'
  + '2025-12-23,07:00,15:00,6.00,Normal,84.12,Break doesnt count\r\n').shifts;
ok('a row imports its own hours and pay', legacy, [
  { date: '2025-12-23', start: '07:00', end: '15:00', hours: 6, gross: 84.12, special: false, note: 'Break doesnt count' },
]);
const own = shiftPay(legacy[0], null);
ok('and is paid what the row said, not today\u2019s rate', [own.hours, own.gross, own.rate], [6, 84.12, 14.02]);
const card = shiftPay({ date: '2025-12-23', start: '07:00', end: '15:00' }, null);
ok('while a row with no stated pay uses the rate card', [card.hours, card.gross], [7, 101.08]);
ok('a bank holiday row counts as special',
  shiftPay(parseTescoCsv('Date,Start Time,End Time,Hours,Normal or Special,Total\r\n2026-08-03,07:00,15:00,7.00,BH,202.16\r\n').shifts[0], null).special, true);

// The stored shape, shared by the CSV import and the tab's add path.
ok('a week off with no clock times is stored, not dropped',
  storedShift({ date: '2026-06-28', start: null, end: null, hours: 20, gross: 288.8, note: 'Full Week off pay', special: false }, 'x', 'T'),
  { id: 'x', date: '2026-06-28', start: '', end: '', hours: 20, gross: 288.8, note: 'Full Week off pay', special: false, createdAt: 'T' });
ok('a row with neither times nor hours is refused', storedShift({ date: '2026-06-28', start: null, end: null }, 'x', 'T'), null);
ok('so is a row with no usable date', storedShift({ date: 'nope', start: '07:00', end: '15:00' }, 'x', 'T'), null);
ok('a payslip row keeps its own date and week number',
  storedPayslip({ weekStart: '2025-12-12', paye: 0, usc: 0.56, prsi: 0, futureFund: 0, weekNo: 43 }, 'y', 'T'),
  { id: 'y', weekStart: '2025-12-12', paye: 0, usc: 0.56, prsi: 0, futureFund: 0, weekNo: 43, createdAt: 'T' });

// And the save/load boundary keeps all of it: a reload must not silently drop
// the row's own figures or the no-times row.
const saved = validateState({ entries: [], tesco: {
  shifts: [storedShift(legacy[0], 'a', 'T'), storedShift({ date: '2026-06-28', start: null, end: null, hours: 20, gross: 288.8, bankPay: 316.99, note: 'Full Week off pay' }, 'b', 'T')],
  payslips: [storedPayslip({ weekStart: '2025-12-12', paye: 0, usc: 0.56, weekNo: 43 }, 'y', 'T')],
} }).tesco;
ok('storage keeps a row\u2019s own hours, pay, net and week number',
  [saved.shifts.length, saved.shifts[0].hours, saved.shifts[0].gross, saved.shifts[1].hours, saved.shifts[1].bankPay, saved.payslips[0].weekNo],
  [2, 6, 84.12, 20, 316.99, 43]);

// A week's net is normally edited on its payslip, and the sheet types it on the
// week's shift row. A week with no payslip of its own must still record it
// rather than dropping the figure, and a payslip that does record one wins.
const rowNet = [{ id: 'a', date: '2025-12-22', start: '09:00', end: '17:30', bankPay: 360.40 }];
ok('a net on a shift row counts when no payslip records one', buildPayWeeks(rowNet, [], null)[0].bankPaid, 360.4);
ok('and a payslip\u2019s own net wins over the row\u2019s',
  buildPayWeeks(rowNet, [{ id: 'p', weekStart: '2025-12-21', paye: 0, usc: 0, prsi: 0, futureFund: 0, bankPay: 400 }], null)[0].bankPaid, 400);

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

// ---------- cell-level reads: the ink profile decides which line a cell is on ----------
// The strip pass only has to find the header and the typed name; the shifts are
// read cell by cell, and each cell's line is chosen from the ink profile of its
// own column — never from a word box (see ocrOwnerCells).
const ink = ocrInkBands([0, 5, 5, 5, 5, 5, 5, 5, 0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 0]);
ok('one run of ink per line of text', ink.map(b => [b.y0, b.y1]), [[1, 8], [12, 18]]);
ok('a mark too small to be a glyph is not a line', ocrInkBands([9, 0, 0, 0, 0, 0]).length, 0);
ok('a cell takes the line nearest its row', ocrPickBand(ink, 14, 4).cy, 15);
ok('a cell never jumps to the row above or below', ocrPickBand(ink, 0, 3), null);

// ---------- the grid: one day per column, by bounds rather than by proximity ----
// A roster is a grid, so a word belongs to the column whose bounds hold its
// centre. Word-to-word proximity is what lost a real roster: the sheet's column
// rules come back as "|" and "=" tokens parked exactly on the cell boundary and
// the name column ends a word-gap left of the first day, so a gap merge welded
// them into "07:00-15:00 = OFF" and "Parth Sharma 07:00-15:00" — neither a shift
// nor a name — and dropped the days on both sides of every rule.
const bounds = rosterColumnBounds([{ cx: 100 }, { cx: 200 }, { cx: 300 }]);
ok('each column runs halfway to its neighbour',
  bounds.map(b => b.map(Math.round)), [[50, 150], [150, 250], [250, 350]]);
ok('the end columns are extrapolated by half a pitch',
  rosterColumnBounds([{ cx: 100 }, { cx: 200 }]).map(b => b.map(Math.round)), [[50, 150], [150, 250]]);
// A lone column has no neighbour to measure a pitch against, so its bounds stay
// at its own centre rather than inventing a width for it.
ok('one column on its own keeps its centre inside degenerate bounds',
  (() => { const [x0, x1] = rosterColumnBounds([{ cx: 100 }])[0]; return x0 <= 100 && x1 >= 100 && x1 - x0 <= 2; })(), true);
ok('no columns, no bounds', rosterColumnBounds([]), []);

// ---------- one cell's words, however the engine mangled them ----------
const toks = (...spec) => spec.map(([text, x0, x1, confidence = 90]) => ({ text, x0, x1, confidence }));
const cellOf = (tokens, gap = 12) => {
  const p = parseCellTokens(tokens, gap);
  return p ? `${fmtHM(p.startMin)}-${fmtHM(p.endMin)}` : null;
};
ok('a cell that came back whole', cellOf(toks(['07:00-15:00', 10, 160])), '07:00-15:00');
ok('a range the engine split into pieces is put back together',
  cellOf(toks(['07:00', 10, 60], ['-', 62, 74], ['15:00', 76, 130])), '07:00-15:00');
// The rule line the engine reads as a character, parked on the cell boundary.
ok('a rule fragment riding along in the cell is not the cell',
  cellOf(toks(['07:00-15:00', 10, 160], ['=', 166, 172])), '07:00-15:00');
ok('and a rest word beside a shift does not hide it',
  cellOf(toks(['|', 4, 8], ['12:00-20:00', 12, 170])), '12:00-20:00');
// Two overlapping strips both cover the row, so the same cell arrives twice, on
// top of itself. Concatenating the two reads made "07:00-15:0007:00-15:00".
ok('a cell read twice by overlapping strips is one shift',
  cellOf(toks(['07:00-15:00', 10, 160, 91], ['07:00-15:00', 11, 161, 62])), '07:00-15:00');
ok('the more confident of the two reads is the one kept',
  parseCellTokens(toks(['08:00-16:00', 10, 160, 40], ['09:00-17:00', 11, 161, 95])).raw, '09:00-17:00');
ok('one range among noise is still the cell’s shift',
  cellOf(toks(['07:00-15:00 stock', 10, 260])), '07:00-15:00');
// Two days in one column means the grid is wrong, and neither reading can be
// trusted to be this day's — so neither is guessed at.
ok('two ranges in one cell are refused, not guessed between',
  cellOf(toks(['07:00-15:00', 10, 160], ['09:00-17:00', 200, 350])), null);
ok('a rest word is not a shift', cellOf(toks(['OFF', 10, 60])), null);
ok('an empty cell is not a shift', cellOf([]), null);
ok('a cell of pure punctuation is not a shift', cellOf(toks(['|', 10, 20], ['=', 40, 50])), null);

// ---------- a real engine read of a real page ----------
// The words below are tesseract.js 5.1.1's own output for a roster page (see the
// fixture's `note`): a clean render, so everything in this list is the engine's
// or the grid's doing — the rules as "|"/"=" on the boundaries, the middle rows
// read twice by two overlapping strips, a cell read as " 10:00-16:00" with 8%
// confidence. Pinning the parse against it is what keeps the read that a real
// photo needs from being "tidied" back into losing days.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/roster-words.json', import.meta.url), 'utf8'));
const fixtureWords = fixture.words.map(([text, x0, y0, x1, y1, confidence]) => ({ text, x0, y0, x1, y1, confidence }));
const read = parseRosterWords(fixtureWords, new Date(Date.UTC(2026, 8, 25)), { name: 'Parth' });
const mine = read.rows.find(r => r.matches);
ok('the whole page of staff rows is read', read.rows.length, 7);
ok('the row the typed name matched is the one flagged', mine ? mine.name : null, 'Parth Sharma');
ok('its shifts land on the days their columns sit under',
  mine ? mine.cells.map(c => c.date) : null, Object.keys(fixture.expected.cells));
ok('with the times the page states',
  mine ? mine.cells.map(c => `${fmtHM(c.startMin)}-${fmtHM(c.endMin)}`) : null,
  Object.values(fixture.expected.cells).map(([a, b]) => `${fmtHM(a)}-${fmtHM(b)}`));
ok('the days off are left off, not guessed at', mine ? mine.cells.length : -1, 4);
ok('a day is never read onto two columns at once',
  mine ? new Set(mine.cells.map(c => c.date)).size === mine.cells.length : false, true);
ok('every row keeps its own name',
  read.rows.map(r => r.name).includes('Sean Murphy'), true);

// ---------- the flat-field view of a cell ----------
// A photo's glare is a brightness gradient across the sheet, and a cell read
// against a threshold fitted to the whole crop loses the glyphs on its bright
// side. Flat-fielding compares each pixel with the paper around it instead, so
// a stroke is dark on both sides of the gradient.
{
  const w = 96, h = 24;
  // The paper is brightest at the left edge and falls away to the right, the way
  // a phone's reflection does across a sheet.
  const paper = (x) => 210 - Math.round((x / (w - 1)) * 90);
  const cell = (stroke) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = stroke && y > 3 && y < h - 4 && (x === 20 || x === 70) ? paper(x) - 50 : paper(x);
        px[i] = px[i + 1] = px[i + 2] = v;
        px[i + 3] = 255;
      }
    }
    ocrFlatField(px, w, h);
    return px;
  };
  const written = cell(true);
  const at = (px, x, y) => px[(y * w + x) * 4];
  ok('a stroke stays dark on the bright side of the glare', at(written, 20, 12) < at(written, 20, 1) - 80, true);
  ok('a stroke stays dark on the dark side of the glare', at(written, 70, 12) < at(written, 70, 1) - 80, true);
  ok('paper stays light wherever the glare falls', at(written, 20, 1) > 180 && at(written, 70, 1) > 180, true);
  const blank = cell(false);
  let darkest = 255;
  for (let i = 0; i < blank.length; i += 4) darkest = Math.min(darkest, blank[i]);
  ok('a cell with no writing in it is not turned into ink', darkest > 150, true);
}

// ---------- cell-pass reads own the row they belong to ----------
const readCells = [{ date: '2026-09-20', weekday: 0, startMin: 0, endMin: 300, raw: 'x', confidence: 92, dupe: false }];
const withCells = (cells, cellsComplete) => parseRosterWords(tilted, new Date(Date.UTC(2026, 8, 22)), { name: 'parth', cells, cellsComplete });
ok('a cell-pass read wins the day it read',
  withCells(readCells, true).rows.find(r => r.matches).cells.map(c => c.date), ['2026-09-20', '2026-09-23']);
ok('and that day carries the cell pass’s figure',
  withCells(readCells, true).rows.find(r => r.matches).cells.map(c => fmtHM(c.endMin)), ['05:00', '22:00']);
// The merge is per day, so a day the pass could not read keeps what the strip
// pass already had. Replacing the row wholesale meant one failed crop deleted a
// shift that had been read correctly — on the day that mattered.
ok('a day the cell pass could not read keeps the strip read',
  withCells(readCells, true).rows.find(r => r.matches).cells.map(c => c.date).includes('2026-09-23'), true);
ok('so covering the whole grid or only part of it reads the same',
  JSON.stringify(withCells(readCells, true).rows) === JSON.stringify(withCells(readCells, false).rows), true);
ok('a row too garbled to parse still gets its cells',
  parseRosterWords([{ text: 'Parth', x0: 10, y0: 210, x1: 98, y1: 240, confidence: 93 }], new Date(), { name: 'parth', cells: readCells, cellsComplete: true })
    .rows.map(r => [r.name, r.matches, r.cells.length]), [['parth', true, 1]]);

// ---------- the roster read is owned by the profile that took it ----------
// A scan of someone's sheet holds their name and their shift times. The slot
// holding it is module-level, so a profile switch must not carry it across; the
// same rule as app.js's staleResponse() for cloud answers.
const slot = (profileId) => ({ profileId, parsed: { rows: [{ name: 'parth' }] } });
ok('a scan taken by this profile is restored',
  scanSlotForProfile(slot('sam'), 'sam')?.parsed.rows.length, 1);
ok('a scan taken by another profile is dropped',
  scanSlotForProfile(slot('personal'), 'sam'), null);
ok('a scan with no owner (an older build) is dropped rather than shown',
  scanSlotForProfile({ parsed: { rows: [{ name: 'parth' }] } }, 'sam'), null);
ok('an empty slot stays empty', scanSlotForProfile(null, 'sam'), null);

// ---------- quick entry: a shift typed as a sentence ----------
// The grammar the Tesco tab's magic entry promises. Today is pinned to Thursday
// 24 Sep 2026 — the Thursday a payslip lands on — so every weekday relative to
// it is checkable by hand: the Monday before it is the 21st, the Friday 18th.
const QUICK_DAY = '2026-09-24';
const quick = text => parseShiftText(text, QUICK_DAY);
const oneQuick = text => quick(text).shifts[0];

ok('mon 8-4 → the Monday before, 08:00-16:00',
  oneQuick('mon 8-4'), { date: '2026-09-21', start: '08:00', end: '16:00', special: false, note: '' });
ok('yesterday takes the day before the pinned today',
  oneQuick('yesterday 12:30-20:15'), { date: '2026-09-23', start: '12:30', end: '20:15', special: false, note: '' });
ok('sat 9-5 keeps the words after it as the note',
  oneQuick('sat 9-5 stock take'), { date: '2026-09-19', start: '09:00', end: '17:00', special: false, note: 'stock take' });
ok('sun 10-4 lands on the Sunday (the engine makes it special itself)',
  oneQuick('sun 10-4').date, '2026-09-20');
ok('an end earlier than the start is an overnight shift, not a broken one',
  [oneQuick('fri 20:00-01:00').date, oneQuick('fri 20:00-01:00').start, oneQuick('fri 20:00-01:00').end],
  ['2026-09-18', '20:00', '01:00']);
ok('no date at all means today',
  [oneQuick('8-4').date, oneQuick('8-4').start, oneQuick('8-4').end], ['2026-09-24', '08:00', '16:00']);
ok('4-9pm teaches the start which half of the day it is',
  [oneQuick('4-9pm').start, oneQuick('4-9pm').end], ['16:00', '21:00']);
ok('8am-4 teaches the end instead',
  [oneQuick('8am-4').start, oneQuick('8am-4').end], ['08:00', '16:00']);
ok('both halves stated are honoured (8pm-4am stays overnight)',
  [oneQuick('8pm-4am').start, oneQuick('8pm-4am').end], ['20:00', '04:00']);
ok('0800-1630 is a 24-hour clock',
  [oneQuick('mon 0800-1630').start, oneQuick('mon 0800-1630').end], ['08:00', '16:30']);
ok('8.30-16.30 is a clock too',
  [oneQuick('mon 8.30-16.30').start, oneQuick('mon 8.30-16.30').end], ['08:30', '16:30']);
ok('13/09 8-4 → the September the 13th, signed off special',
  [oneQuick('13/09 8-4 special').date, oneQuick('13/09 8-4 special').special, oneQuick('13/09 8-4 special').note],
  ['2026-09-13', true, '']);
ok('a spelled month, day first', oneQuick('13 Sep 2026 9-5').date, '2026-09-13');
ok('a spelled month, month first', oneQuick('Sep 13 9-5').date, '2026-09-13');
ok('a full date with its year', oneQuick('13/09/2026 9-5').date, '2026-09-13');
ok('an ISO date', oneQuick('2026-09-13 8-4').date, '2026-09-13');
ok('last friday is the one already gone', oneQuick('last fri 9-5').date, '2026-09-18');
ok('next monday is the one coming', oneQuick('next mon 8-4').date, '2026-09-28');
ok('a bank holiday marks itself', oneQuick('bh sun 10-4').special, true);
ok('hours without times book a week off',
  [oneQuick('week off 7h').hours, oneQuick('week off 7h').start, oneQuick('week off 7h').end, oneQuick('week off 7h').note],
  [7, '', '', 'week off']);
ok('hours work on a named day too', [oneQuick('mon 7h').date, oneQuick('mon 7h').hours], ['2026-09-21', 7]);
ok('one line per shift; a semicolon separates too',
  quick('mon 8-4; tue 9-5').shifts.map(s => s.date), ['2026-09-21', '2026-09-22']);
ok('a bad line never costs the good ones beside it',
  [quick('mon 8-4\nbrunch\ntue 9-5').shifts.length, quick('mon 8-4\nbrunch\ntue 9-5').problems.length], [2, 1]);
ok('nothing typed is not an error',
  [quick('   ').shifts.length, quick('').problems.length], [0, 0]);
ok('times are required', /no times/.test(quick('brunch').problems[0].error), true);
ok('times and hours together are refused', /both times and hours/.test(quick('mon 8-4 7h').problems[0].error), true);
ok('an impossible clock is refused', quick('mon 25:00-26:00').problems.length, 1);
ok('two ranges on one line are refused, not guessed between',
  /two sets of times/.test(quick('mon 8-4 tue 9-5').problems[0].error), true);
ok('a date that does not exist is named back',
  /"32\/13" is not a date/.test(quick('32/13 8-4').problems[0].error), true);
// The parser's output is only useful if the app's own validator accepts it.
const quickStored = storedShift(oneQuick('mon 8-4 stock take'), 'q1', '2026-09-24T10:00:00.000Z');
ok('what it parses is what the app stores',
  [quickStored.date, quickStored.start, quickStored.end, quickStored.note, quickStored.special],
  ['2026-09-21', '08:00', '16:00', 'stock take', false]);
ok('and a week-off row survives storage with its hours',
  storedShift(oneQuick('week off 7h'), 'q2', '2026-09-24T10:00:00.000Z').hours, 7);
ok('what it parses pays what the week card will show (7h × €14.44)',
  shiftPay(oneQuick('mon 8-4'), null).gross, 101.08);

// The preview is the only thing standing between a mis-read line and the pay
// record, so what it promises is pinned too. € here is app.js's fmt, which the
// card passes in: two decimals, a real minus sign for a negative.
const money = n => `${n < 0 ? '−' : ''}€${Math.abs(n).toFixed(2)}`;
const previewOf = text => shiftPreviewLine(oneQuick(text), shiftPay(oneQuick(text), null), money);
ok('a clock-times line reads back as the week card will price it',
  previewOf('mon 8-4 stock take'),
  'Mon 21 Sep · 08:00–16:00 · 7h · normal €14.44/h → €101.08 · stock take');
ok('an overnight line is marked as running into the next day',
  previewOf('fri 20:00-01:00'), 'Fri 18 Sep · 20:00–01:00 +1 · 5h · normal €14.44/h → €72.20');
ok('a Sunday is previewed at the Sunday rate',
  previewOf('13/09 9-5 special'), 'Sun 13 Sep · 09:00–17:00 · 7h · special €21.66/h → €151.62');
// The regression this helper exists for: a stated-hours row priced fine and so
// took the clock-times branch, printing "Thu 24 Sep · – +1 · 7h".
ok('a booked week off states its hours instead of an empty range',
  previewOf('week off 7h'),
  'Thu 24 Sep · 7h stated, no clock times · normal €14.44/h → €101.08 · week off');
ok('a line with no date previews the day it will be stored on',
  previewOf('8-4').startsWith('Thu 24 Sep · 08:00–16:00 ·'), true);
ok('and no note leaves no trailing separator',
  previewOf('mon 8-4').endsWith('→ €101.08'), true);

// ---------- editing a stored shift ----------
// A hand edit is validated by the importer's own rules (storedShift), so the two
// paths cannot drift: every rejection below is a row the CSV import would also
// have refused to write.
const editBase = storedShift({ date: '2026-09-17', start: '07:00', end: '15:00' }, 'e1', '2026-09-01T00:00:00.000Z');
const edited = (fields, others = []) => applyShiftEdit(editBase, fields, others);
const editOf = (fields, others = []) => { const r = edited(fields, others); return r.ok ? r.shift : null; };

ok('an edit rewrites the fields it is given',
  (() => { const r = edited({ date: '2026-09-19', start: '09:00', end: '17:30', note: 'stock take', special: true });
    return [r.ok, r.shift.date, r.shift.start, r.shift.end, r.shift.note, r.shift.special]; })(),
  [true, '2026-09-19', '09:00', '17:30', 'stock take', true]);
// The id is what sync unions on: a new one here would leave the old row alive on
// the other device and bring it back on the next merge.
ok('and keeps the row’s own id and creation date',
  (() => { const r = edited({ note: 'x' }); return [r.shift.id, r.shift.createdAt]; })(),
  ['e1', '2026-09-01T00:00:00.000Z']);
ok('fields left alone keep their stored values',
  (() => { const s = editOf({ note: 'x' }); return [s.date, s.start, s.end]; })(),
  ['2026-09-17', '07:00', '15:00']);

ok('a date the importer would refuse is refused here',
  (() => { const r = edited({ date: '17/09/2026' }); return [r.ok, r.field, r.error]; })(),
  [false, 'date', 'Enter the date as YYYY-MM-DD.']);
ok('a time that will not parse is named by its own field',
  (() => { const r = edited({ start: '7am' }); return [r.ok, r.field]; })(), [false, 'start']);
ok('an end past midnight is not a clock time',
  (() => { const r = edited({ end: '25:00' }); return [r.ok, r.field]; })(), [false, 'end']);
ok('hours that are not a number are refused',
  (() => { const r = edited({ hours: 'lots' }); return [r.ok, r.field]; })(), [false, 'hours']);
// With the times gone a row needs stated hours — the week-off state — and the
// field to fix is the one that is missing, not the one that was cleared.
ok('a row with neither times nor hours is refused at the field that is blank',
  (() => { const r = edited({ start: '', end: '' }); return [r.ok, r.field]; })(), [false, 'start']);
ok('and a half-filled range points at the other end',
  (() => { const r = edited({ end: '' }); return [r.ok, r.field]; })(), [false, 'end']);

// A booked week off: hours and no clock times, exactly as the sheet stores it.
ok('a week off survives the edit with its hours',
  (() => { const s = editOf({ start: '', end: '', hours: '7' }); return [s.start, s.end, s.hours]; })(),
  ['', '', 7]);
// Blanking hours has to REMOVE the key: an inherited one keeps out-ranking the
// clock times in shiftPay, so fixing the times would leave the pay untouched.
ok('blanking hours hands pricing back to the clock times',
  (() => { const s = editOf({ hours: '' }); return ['hours' in s, shiftPay(s, null).hours]; })(),
  [false, 7]);
ok('while an imported row keeps the hours the sheet paid it for',
  applyShiftEdit({ ...editBase, hours: 6 }, { note: 'x' }, []).shift.hours, 6);

// The row's own pay outranks hours × rate, so it is editable: blanking it is how
// a corrected shift stops paying the old amount.
ok('a stated pay is kept and rounded like the importer rounds it',
  editOf({ gross: '99.999' }).gross, 100);
ok('blanking it goes back to hours × rate',
  (() => { const s = editOf({ gross: '' }); return ['gross' in s, shiftPay(s, null).gross]; })(),
  [false, 101.08]);
ok('a pay that is not a number is refused at its own field',
  (() => { const r = edited({ gross: 'abc' }); return [r.ok, r.field]; })(), [false, 'gross']);

// The key freshShifts dedupes on: an edit must not be a back door into the
// duplicate state an import refuses to create.
ok('editing a row onto another row’s day and times is refused',
  (() => { const r = edited({ start: '08:00', end: '16:00' }, ['2026-09-17|08:00|16:00']); return [r.ok, r.field]; })(),
  [false, 'date']);
ok('but the same times on another day are not', edited({ date: '2026-09-18' }).ok, true);

ok('a note is trimmed and capped like an imported one',
  (() => { const s = editOf({ note: '   stock take   ' }); return [s.note, editOf({ note: 'x'.repeat(200) }).note.length]; })(),
  ['stock take', 120]);
// Sunday is special by rule, so ticking the box is not what makes it pay as one
// — and the edit must not write a flag that contradicts a stored one.
ok('a Sunday pays special without the flag being written',
  (() => { const s = editOf({ date: '2026-09-20' }); return [s.special, shiftPay(s, null).special, shiftPay(s, null).gross]; })(),
  [false, true, 151.62]);

// ---------- the sheet's own geometry ----------
// The tilt of the page, taken from the words: a line written at 2.5° has to come
// back as 2.5°, because that number is what the photo is rotated back by.
const lineOf = (slope, n = 14, gap = 120) => Array.from({ length: n }, (_, i) => ({
  text: 'x' + i, x0: i * gap, x1: i * gap + 60, y0: 400 + slope * i * gap, y1: 430 + slope * i * gap,
}));
near('pageSkew reads a level line as level', pageSkew(lineOf(0), 30), 0, 0.004);
near('pageSkew reads a 1° line', pageSkew(lineOf(Math.tan(1 * Math.PI / 180)), 30), 0.01746, 0.004);
near('pageSkew reads a 3° line', pageSkew(lineOf(Math.tan(3 * Math.PI / 180)), 30), 0.05241, 0.004);
// A row that is torn in two (one strip read half of it) must not drag the page:
// the median over every pair cannot be moved by a minority on another line.
ok('one word on the wrong line does not move the page',
  Math.abs(pageSkew([...lineOf(0.05), { text: 'junk', x0: 1600, x1: 1700, y0: 120, y1: 150 }], 30) - 0.05) < 0.02, true);

// The same word twice: the two overlapping strips both read the row it sits on.
const dupes = dedupeWords([
  { text: '07:00-15:00', x0: 100, x1: 240, y0: 500, y1: 530, confidence: 70 },
  { text: '07:00-15:00', x0: 104, x1: 243, y0: 502, y1: 532, confidence: 92 },
  { text: '07:00-15:00', x0: 100, x1: 240, y0: 740, y1: 770, confidence: 90 },
]);
ok('a double read collapses to one word', dupes.length, 2);
ok('and the copy kept is the confident one', dupes[0].confidence, 92);
ok('the same text on the next row is a different word', dupes[1].y0, 740);
ok('punctuation is not merged across a row either',
  dedupeWords([{ text: '|', x0: 10, x1: 12, y0: 100, y1: 140 }, { text: '|', x0: 500, x1: 502, y0: 100, y1: 140 }]).length, 2);

// The header: which columns a page describes, and which of its numbers are
// furniture. A title's date range must never become a day of the week.
const headerRow = (phrases, cy) => ({ cy, phrases: phrases.map(ph => (typeof ph === 'string' ? { text: ph, x0: 0, x1: 40, confidence: 90 } : { confidence: 90, ...ph })) });
const dayNames = ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'].map((t, i) => ({ text: t, x0: 400 + i * 180, x1: 460 + i * 180 }));
const dateTokens = ['22-Sep', '23-Sep', '24-Sep', '25-Sep', '26-Sep', '27-Sep', '28-Sep'].map((t, i) => ({ text: t, x0: 400 + i * 180, x1: 500 + i * 180 }));
const titleRow = headerRow([
  { text: 'Week', x0: 60, x1: 100 }, { text: '39', x0: 110, x1: 130 },
  { text: '22/09/2026', x0: 300, x1: 450 }, { text: '28/09/2026', x0: 490, x1: 640 },
  { text: 'Store', x0: 680, x1: 730 }, { text: '3021', x0: 740, x1: 790 },
], 240);
const today = new Date(Date.UTC(2026, 8, 25));
const fullHeader = [titleRow, headerRow(dayNames, 360), headerRow(dateTokens, 420)];
const grid = columnAnchors(fullHeader, today, 90);
ok('a title date range does not become a column', grid.cols.length, 7);
ok('so the first column keeps its own day', grid.cols[0].cx, 430);
ok('and its own date', grid.cols[0].date.toISOString().slice(0, 10), '2026-09-22');
ok('the week start is left to the date row', grid.weekStart, null);
// The date row lost (small print, glare): the title's range still says which week.
const lostDates = columnAnchors([titleRow, headerRow(dayNames, 360)], today, 90);
ok('without a date row the title carries the week', lostDates.weekStart.toISOString().slice(0, 10), '2026-09-22');
ok('and no title date is read as a column', lostDates.cols.length, 7);
// A misread date token and the column's own day name cannot both be right.
const skewed = resolveColumnDates([
  { cx: 100, date: new Date(Date.UTC(2026, 8, 22)), weekday: 2 },
  { cx: 200, date: new Date(Date.UTC(2026, 8, 27)), weekday: 3 },
  { cx: 300, weekday: 4 },
], today);
ok('a date that fights its day name is dropped', skewed.map(c => c.date.toISOString().slice(0, 10)), ['2026-09-22', '2026-09-23', '2026-09-24']);
// The day-name-only case is what put a whole week a day late: today IS in the
// week being read, so the grid belongs to the week containing today.
const namesOnly = resolveColumnDates([
  { cx: 100, weekday: 2 }, { cx: 200, weekday: 3 }, { cx: 300, weekday: 4 },
  { cx: 400, weekday: 5 }, { cx: 500, weekday: 6 }, { cx: 600, weekday: 0 }, { cx: 700, weekday: 1 },
], today);
ok('day names alone land in the week containing today', namesOnly.map(c => c.date.toISOString().slice(0, 10)),
  ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
// Today is a fortnight before the sheet: the nearest week is the NEXT one, not
// the one that has already gone.
const before = new Date(Date.UTC(2026, 8, 13));
ok('a sheet for a week not yet started reads forwards',
  resolveColumnDates([{ cx: 100, weekday: 2 }, { cx: 200, weekday: 3 }], before).map(c => c.date.toISOString().slice(0, 10)),
  ['2026-09-15', '2026-09-16']);
// …and one whose days are already behind us stays in the week it belongs to
// rather than jumping a week ahead: today is Thursday, the sheet's Tue/Wed are
// two days gone, and next week's would be five days away.
ok('a sheet for the week just gone reads backwards',
  resolveColumnDates([{ cx: 100, weekday: 2 }, { cx: 200, weekday: 3 }], new Date(Date.UTC(2026, 8, 24))).map(c => c.date.toISOString().slice(0, 10)),
  ['2026-09-22', '2026-09-23']);
ok('a title range anchors the series when no date row survived',
  resolveColumnDates([{ cx: 100 }, { cx: 200 }, { cx: 300 }], today, new Date(Date.UTC(2026, 8, 22))).map(c => c.date.toISOString().slice(0, 10)),
  ['2026-09-22', '2026-09-23', '2026-09-24']);

// The photo's own levelling: ink on a level page stacks into one row of the
// projection, and the angle that stacks it best is the angle to undo.
function stripedPage(w, h, deg) {
  const grey = new Uint8Array(w * h).fill(255);
  const t = deg * Math.PI / 180, sin = Math.sin(t), cos = Math.cos(t);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - h / 2;
      const sy = -dx * sin + dy * cos + h / 2;      // the row on the sheet this pixel shows
      const sx = dx * cos + dy * sin + w / 2;
      if (sx < w * 0.08 || sx > w * 0.92) continue;
      const band = (sy - 40) % 48;
      if (sy > 40 && band >= 0 && band < 14) grey[y * w + x] = 20;
    }
  }
  return grey;
}
for (const deg of [0, 1, -2.5, 4]) {
  const w = 320, h = 460;
  near(`ocrEstimateTilt finds a ${deg}° page`, ocrEstimateTilt(stripedPage(w, h, deg), w, h) * 180 / Math.PI, deg, 0.3);
}
// A photo that is already exposed is left alone: stretching it would only
// amplify the JPEG's ringing around every thin stroke.
const white = new Uint8Array(4 * 400).fill(250);
for (let i = 0; i < 40; i++) { white[i * 4] = white[i * 4 + 1] = white[i * 4 + 2] = 20; }
const whiteCopy = Uint8Array.from(white);
ocrAutoContrast(white);
ok('a white-paper photo is not stretched', [...white.slice(0, 40)], [...whiteCopy.slice(0, 40)]);
// A sheet shot in shadow: its paper is grey, and the stretch is what gives the
// engine the contrast its binariser needs.
const shadowed = new Uint8Array(4 * 400).fill(170);
for (let i = 0; i < 40; i++) { shadowed[i * 4] = shadowed[i * 4 + 1] = shadowed[i * 4 + 2] = 90; }
ocrAutoContrast(shadowed);
ok('a shadowed photo is stretched to full range',
  [shadowed[200 * 4], shadowed[10 * 4]], [255, 0]);

// ---------- report ----------
if (fails.length) {
  console.error(`test-tesco: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f.replace(/^/, '').replace(/\n     /g, '\n     '));
  process.exit(1);
}
console.log(`test-tesco: OK — ${pass} assertions passed (engine matches the workbook's cached values)`);
