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
import { createRequire } from 'node:module';
import {
  scanSlotForProfile,
  paidHours, parseHM, fmtHM, shiftPay, simulateTax, r2,
  weekStartOf, payDateOf, dateOk, buildPayWeeks, monthSummary, lifetimeTotals,
  payslipTotal, parseTimeCell, parseRosterWords, isSunday, nameMatches, ocrStripRanges, ocrFlatField,
  TESCO_RATE_DEFAULTS,
  tescoCsv, parseTescoCsv, TESCO_CSV_HEADER, TESCO_CSV_PAYSLIP_HEADER, isoWeekNumber, weekNumberOf, payslipWeekNumberOf,
  parseShiftText, shiftPreviewLine,
  storedShift, storedPayslip, applyShiftEdit, weekOffShift, weekBankWrite, weekVsEstimate, receivedByPayDate, tescoPayLedgerWrites, tescoPayWriteWindow,
  TESCO_PAY_METHOD,
  rosterColumnBounds, parseCellTokens,
  sheetRowsToCsv, workbookToCsv,
  pageSkew, dedupeWords, columnAnchors, resolveColumnDates, parseDateToken, columnDatingAgreement,
  ocrEstimateTilt, ocrAutoContrast,
  ocrSauvola, ocrLocalMarks, ocrIllumination, ocrRulingLines, rosterColumnsFromRules, rosterReadQuality,
  createOcrPool, ocrPoolSize, OCR_POOL_MAX,
  ocrStripBox, ocrPageBox, ocrPrepSize, OCR_PREP_MAX, createOcrPrepWorker, ocrStretchData,
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
// The Sunday multiplier is a premium for WORKING Sunday, so it follows the clock
// times. A row with hours and no times is a booked week off (the sheet's own shape
// and the quick entry's), and the Week off card dates it on the week's Sunday so
// the week is unambiguous — which once paid a 7h week off at €151.62 instead of
// €101.08, silently. A row that carries the flag itself still pays the premium.
const weekOffRow = { date: '2026-09-20', start: '', end: '', hours: 7, note: 'week off' };
ok('a week off dated on a Sunday pays the normal rate, not the Sunday premium',
  [shiftPay(weekOffRow, null).special, shiftPay(weekOffRow, null).gross], [false, 101.08]);
ok('but a row that states special still pays ×1.5 with no clock times',
  (() => { const p = shiftPay({ ...weekOffRow, special: true }, null); return [p.special, p.gross]; })(),
  [true, 151.62]);

// ---------- tax: the cached cells from the workbook ----------
// The sheet's cached cells were computed at 4.2%, which is also this app's default
// (the rate card is where a user types 4.35%, in force from 1 Oct 2026) — so the
// PRSI rules pinned below the PAYE block are the only place the engine follows the
// statute rather than the sheet. See the €287 pin for where the two differ.
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
// This is where the engine and the sheet part company: the sheet charged PRSI on a
// €287 week, the statute exempts it (€352 or less), so the net is €12.05 higher
// than the sheet's cached cell. The rounding it was pinning is unchanged — 287 −
// 2.28 of USC − 4.305 of raw pension is 280.415, which comes to rest on 280.42.
ok('net subtracts the raw pension (€287 → 280.42, no PRSI below €352)', simulateTax(287, null).net, 280.42);
ok('…while the pension itself still displays rounded', simulateTax(287, null).pension, 4.31);
// The €76.93 credit swallows all PAYE below the cutoff.
ok('PAYE floored at 0 under the credit', simulateTax(300, null).paye, 0);
// ---------- PRSI: the low-earnings rules ----------
// The case that exposed this: a €300 week, about 20 hours at the card rate. It
// owes no PAYE (the weekly credit swallows it) and NO PRSI — an employee on €352 a
// week or less is exempt, not "charged with a credit" — so the whole bill is the
// USC on the first €231 plus 2% of the rest. The full-rate charge below the
// threshold made this week cost €15.14 instead of the €2.54 a payslip shows.
ok('a €300 week owes no PAYE', simulateTax(300, null).paye, 0);
ok('a €300 week owes no PRSI (exempt at €352 a week or less)', simulateTax(300, null).prsi, 0);
ok('a €300 week owes €2.54 of USC', simulateTax(300, null).usc, 2.54);
ok('so the whole week costs €2.54, not €15.14', simulateTax(300, null).tax, 2.54);
ok('exactly €352 a week is still exempt', simulateTax(352, null).prsi, 0);
// One cent over the threshold and PRSI is payable on the whole week, less the €12
// credit at its maximum — the cliff the statute has, not a taper this app invented.
ok('one cent over the threshold pays the rate less the full €12 credit', simulateTax(352.01, null).prsi, 2.78);
// Above €424 the credit is spent; the charge runs straight through.
ok('PRSI credit gone above €424', simulateTax(500, null).prsi, 21);
ok('the credit is spent by €424', [simulateTax(424, null).prsi, simulateTax(424.01, null).prsi], [17.81, 17.81]);
// €400: 4.2% is €16.80, less the credit €12 − €47.99/6 = €4.00 → €12.80.
near('PRSI tapers inside the €352–424 band', simulateTax(400, null).prsi, 12.8);
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
// The engine's date rule is csv.js's isRealDate, delegated rather than
// re-implemented (see `dateOk`). It used to be a shape check plus "does it
// parse", and Date.UTC ROLLS a day that does not exist over to the next month:
// a workbook cell typed 31/02/2026 arrived as a shift dated the 31st of
// February, grouped into the week of 3 March and drawn on a card as a day that
// is not on any calendar. Every door into a shift or a payslip asks this one.
ok('the 31st of February is not a day', dateOk('2026-02-31'), false);
ok('nor the 31st of April', dateOk('2026-04-31'), false);
ok('nor a month 13', dateOk('2026-13-01'), false);
ok('a real day is one', dateOk('2026-03-03'), true);
ok('and a leap day is one in a leap year', dateOk('2024-02-29'), true);
ok('but not in a common year', dateOk('2026-02-29'), false);

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
// "Today" is pinned for the stats assertions below. Which weeks the bank has paid
// yet decides a month's received figure (a week is only counted once its pay date
// has come round — see receivedTotal), and a harness that read the wall clock
// would change its mind about September the moment October began. Every call to
// monthSummary/lifetimeTotals here passes it explicitly.
const TODAY = '2026-10-05';
ok('payslip total = 72.11 (sheet R17)', payslipTotal(payslips[0]), 72.11);
ok('a refund payslip is negative', payslipTotal(payslips[1]), -56.08);
ok('payslip attaches to its week', buildPayWeeks(withSlips, payslips).find(w => w.weekStart === '2026-09-20').payslip.id, 'p');
ok('a payslip week with no shifts still lists', buildPayWeeks(withSlips, payslips).length, 3);
ok('received = 550.53 − 72.11 = €478.42 net (sheet O17)', lifetimeTotals(weekShifts, [payslips[0]], null, TODAY).received, 478.42);
ok('a refund week receives 101.08 + 56.08 = €157.16', lifetimeTotals(refundShifts, [payslips[1]], null, TODAY).received, 157.16);
// A payslip on its own says what was withheld, not what the gross it came out of
// was — so with no shift rows beside it there is nothing to net it against and it
// claims nothing. A NEGATIVE total is the exception: that is money handed back.
ok('a payslip with no shifts beside it claims nothing', lifetimeTotals([], [payslips[2]], null, TODAY).received, 0);
ok('but a refund with no shifts beside it is money in',
  lifetimeTotals([], [{ id: 'rr', weekStart: '2026-08-23', paye: -40, usc: 0, prsi: 0, futureFund: 0 }], null, TODAY).received, 40);
ok('lifetime received = €635.58', lifetimeTotals(withSlips, payslips, null, TODAY).received, 635.58);
ok('lifetime hours = 41.5', lifetimeTotals(withSlips, payslips, null, TODAY).hours, 41.5);

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
ok('the week received nets both runs off the gross', lifetimeTotals(weekShifts, twoRuns, null, TODAY).received, r2(550.53 - 3));

// The sheet's Final Bank Pay (its tax table's net, typed from a statement): it
// is the money that actually landed, so it wins over gross − tax. That is how
// holiday pay, a refund or a correction is counted — and how a paid week with
// no shifts at all stops reading as €0 received.
const banked = { ...payslips[0], bankPay: 600 };
ok('an entered net replaces gross − tax', lifetimeTotals(weekShifts, [banked], null, TODAY).received, 600);
ok('a paid week with no shifts receives its net', lifetimeTotals([], [{ ...payslips[2], bankPay: 316.99 }], null, TODAY).received, 316.99);
// It lands in the month it was PAID in (23 Aug + 11 days = 3 Sep), not in the
// month of its own week: the bank does not move money early for a calendar.
ok('a typed net is counted in the month it was paid',
  monthSummary(withSlips, [{ ...payslips[2], bankPay: 316.99 }], null, 2026, 8, TODAY).received, 416.04);
ok('and not in the month of the week it belongs to',
  monthSummary(withSlips, [{ ...payslips[2], bankPay: 316.99 }], null, 2026, 7, TODAY).received, 0);
ok('an absent net still falls back to gross − tax', lifetimeTotals(weekShifts, [payslips[0]], null, TODAY).received, 478.42);
ok('two runs with a net each add up',
  lifetimeTotals(weekShifts, [{ ...twoRuns[0], bankPay: 300 }, { ...twoRuns[1], bankPay: 200 }], null, TODAY).received, 500);

// A custom hourly rate must reach the week and lifetime totals, not only the
// per-shift rows: a user on €15/h had one card print €157.50 + €112.50 beside
// the shifts while ITS OWN week total still read €259.92, computed at the
// built-in defaults, and the dashboard summary disagreed with both.
const customRates = { ...TESCO_RATE_DEFAULTS, normal: 15 };
const customGross = r2(weekShifts.reduce((sum, s) => sum + shiftPay(s, customRates).gross, 0));
const customWeeks = buildPayWeeks(weekShifts, [], customRates);
ok("a week's gross uses the custom rate", customWeeks[0].gross, customGross);
ok('and is not the default-rate figure', customWeeks[0].gross === 550.53, false);
const customNet = simulateTax(customGross, customRates).net;
ok('the custom rate reaches the net a week is expected to land, not just its gross',
  lifetimeTotals(weekShifts, [], customRates, TODAY).anticipated, customNet);
ok('received nets the payslip off the custom-rate gross',
  lifetimeTotals(weekShifts, [payslips[0]], customRates, TODAY).received, r2(customGross - payslipTotal(payslips[0])));
const sepCustom = monthSummary(weekShifts, [payslips[0]], customRates, 2026, 8, TODAY);
ok("a month's anticipated uses the custom rate", sepCustom.anticipated, customNet);
// The sheet's block is the week of 20 Sep, which is paid on 1 October — so
// September has nothing of it to show and October takes all of it.
ok('a month receives a week only once its pay date has arrived', sepCustom.received, 0);
ok('and the next month takes it',
  monthSummary(weekShifts, [payslips[0]], customRates, 2026, 9, TODAY).received, r2(customGross - payslipTotal(payslips[0])));
ok('the CSV export carries the custom-rate gross',
  tescoCsv(weekShifts, [], customRates, new Map()).includes(customGross.toFixed(2)), true);

// September 2026: the six shifts above all fall in it, in two pay weeks — the
// week of 6 Sep (its Wednesday shift and the refund payslip) and the week of
// 20 Sep (the sheet's own block).
const sep = monthSummary(withSlips, payslips, null, 2026, 8, TODAY);
ok('September hours = 41.5', sep.hours, 41.5);
// Hours are the month's own shifts, by date. The expected figure is a NET and a
// net is a weekly thing (the PAYE credit, the USC bands and the PRSI threshold
// are all per week), so it is each week's gross simulated once and summed:
// €478.42 for the sheet's block + €99.05 for the 7h week.
// The two nets differ in kind, not just in size: the sheet's €550.53 week is above
// the PRSI threshold and pays 4.2%, while the 7h week's €101.08 is BELOW €352 and
// so pays no PRSI at all — the exemption pinned in the tax block above.
ok('September anticipated = €577.47 net', sep.anticipated, 577.47);
// Received follows the PAY DATE: the week of 20 Sep is paid on 1 Oct, so it is
// October's money, while the refund week (paid 17 Sep) is September's.
ok('September received = €157.16 (the refund week, paid 17 Sep)', sep.received, 157.16);
const oct = monthSummary(withSlips, payslips, null, 2026, 9, TODAY);
ok('October received = €478.42 (the week paid on 1 Oct)', oct.received, 478.42);
ok('and October anticipates nothing of its own', oct.anticipated, 0);

// ---------- what a month's figures mean ----------
// Received is money that reached the bank, so every week the bank has paid counts
// — a worked week with no payslip typed in is worth its simulated net (the figure
// the week card prints as "→ net €X"), not €0. Before this, three worked weeks in a
// month with one payslip between them added up to that one bank line while the
// card still called the result "received", which read as a total it wasn't.
ok('a worked week with no payslip is worth its estimate, not €0',
  lifetimeTotals(withSlips, [], null, TODAY).received, r2(478.42 + 99.05));
// …but only once its pay date has come round: the week of 20 Sep pays on 1 Oct.
ok('a week the bank has not paid yet is not money received',
  lifetimeTotals(withSlips, [], null, '2026-09-20').received, 99.05);
ok('a typed net counts before its pay date (the user watched it land)',
  lifetimeTotals(withSlips, [{ id: 'bx', weekStart: '2026-09-20', bankPay: 300 }], null, '2026-09-20').received, 399.05);
// The two edges of a month, which used to move the wrong way: the week starting
// Sun 30 Aug is PAID on 10 Sep, and the week starting Sun 27 Sep is not paid until
// 8 Oct. Reading the month off the week's start put both in the wrong one.
const edgeShifts = [
  { id: 'ea', date: '2026-08-31', start: '09:00', end: '17:00' }, // week of 30 Aug, paid 10 Sep
  { id: 'eb', date: '2026-09-28', start: '09:00', end: '17:00' }, // week of 27 Sep, paid 8 Oct
];
const edgeSep = monthSummary(edgeShifts, [], null, 2026, 8, TODAY);
ok('September receives the week paid on 10 Sep, whose Sunday was in August', edgeSep.received, 99.05);
ok("while the month's hours are still the shift's own day", edgeSep.hours, 7);
// The other edge, read once the 27 Sep week has actually been paid (8 Oct) —
// before that date the same week is still awaiting the bank, so it is not money
// received yet either (that is the clamp above, not a third rule).
ok('and the week of 27 Sep is October\u2019s money, not September\u2019s',
  [monthSummary(edgeShifts, [], null, 2026, 9, TODAY).received,
   monthSummary(edgeShifts, [], null, 2026, 9, '2026-10-10').received], [0, 99.05]);
// The two figures are on two bases on purpose, and both are nets: the estimate is
// simulated once per pay week, never per row, because the credit and the bands are
// weekly. Two €500 rows of one week pay €153.84 of PAYE between them, not €46.14.
const bigWeek = [
  { id: 'b1', date: '2026-09-21', start: '09:00', end: '17:00', gross: 500 },
  { id: 'b2', date: '2026-09-22', start: '09:00', end: '17:00', gross: 500 },
];
ok('a week is simulated once on the week, not once per row',
  lifetimeTotals(bigWeek, [], null, TODAY).anticipated, simulateTax(1000, null).net);
ok('…which is not the same as taxing each row on its own',
  lifetimeTotals(bigWeek, [], null, TODAY).anticipated === r2(2 * simulateTax(500, null).net), false);

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

// ---------- the workbook itself: the sheet's two tables, read by SheetJS ----------
// The importer is the VENDORED SheetJS and its input is a real workbook, so the
// fixture is not stubbed: scripts/fixtures/tesco-workbook.xlsx is a deflate zip
// holding a Summary sheet (the tax table) FIRST and a Data sheet (the shift table)
// second — the workbook's own shape, and the one that used to hide every shift
// behind the tax header. The rows below are what the mini build the browser loads
// hands back, serials and all.
const require = createRequire(import.meta.url);
const XLSXModule = require('../vendor/xlsx.mini.min.js');
const XLSX = XLSXModule.default || XLSXModule;
const workbook = XLSX.read(readFileSync(new URL('./fixtures/tesco-workbook.xlsx', import.meta.url)), { type: 'buffer' });
ok('the vendored build reads the workbook, sheets in their own order', workbook.SheetNames, ['Summary', 'Data']);
const asSheet = name => ({
  name,
  rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true }),
});
const workbookCsv = workbookToCsv([asSheet('Summary'), asSheet('Data')]);
// The shift table's header has to come before the tax table's in the document:
// parseTescoCsv stops the shift table at the tax header, so the reverse order
// reads as a file with no shifts at all in it.
ok('the shift sheet is written first however the workbook orders its sheets',
  workbookCsv.indexOf('End Time') < workbookCsv.indexOf('Week Start Date'), true);
const fromWorkbook = parseTescoCsv(workbookCsv);
ok('Excel\u2019s own date serials and time fractions read as the sheet\u2019s dates and times',
  fromWorkbook.shifts, [
    { date: '2026-09-06', start: '07:00', end: '15:00', hours: 7, gross: 151.62, bankPay: 400, special: true, note: 'Sunday shop' },
    { date: '2026-09-07', start: '09:00', end: '17:00', hours: 7, gross: 101.08, special: false, note: 'Lates, then close' },
    { date: '2026-09-08', start: null, end: null, hours: 7, gross: 101.08, special: false, note: 'week off' },
    { date: '2026-09-13', start: '07:00', end: '15:00', hours: 7, gross: 151.62, special: true, note: 'Next week' },
  ]);
ok('a week off booked with hours and no times survives the workbook',
  [fromWorkbook.shifts[2].hours, fromWorkbook.shifts[2].start], [7, null]);
ok('a blank row in the middle of a sheet is skipped, not fatal', fromWorkbook.skipped, 1);
ok('the tax table\u2019s row is the week\u2019s payslip, net and all', fromWorkbook.payslips,
  [{ weekStart: '2026-09-06', paye: 33.18, usc: 7.55, prsi: 23.12, futureFund: 8.26, weekNo: 36, bankPay: 400 }]);
ok('the sheet\u2019s own week numbers come across with the rows', fromWorkbook.weekNos,
  { '2026-09-06': 36, '2026-09-13': 37 });
// The cells themselves, at the boundary SheetJS hands them over at: a Date is
// written as its calendar day (a local-time date object lands on the day before
// in a negative-offset zone, which is why the reader asks for serials), a blank
// stays empty rather than becoming "null", and text a spreadsheet would run keeps
// the apostrophe guard the CSV export already has.
ok('a Date cell is written as its own calendar day',
  sheetRowsToCsv([[new Date(Date.UTC(2026, 8, 6))]]), '2026-09-06');
ok('a blank cell stays empty and a number stays a number', sheetRowsToCsv([['a', null, 1.5]]), 'a,,1.5');
ok('a formula-looking cell gets the apostrophe guard', sheetRowsToCsv([['=SUM(A1)']]), "'=SUM(A1)");
ok('one sheet is still a document', workbookToCsv([{ name: 'Data', rows: [['Date', 'Start Time', 'End Time'], ['2026-09-06', 0.5, 0.75]] }]),
  'Date,Start Time,End Time\n2026-09-06,0.5,0.75');
ok('no sheets at all is no document', workbookToCsv([]), '');
ok('and neither is a sheet with no rows', workbookToCsv([{ name: 'Data', rows: [] }]), '');
// Two of the three header names is not the shift sheet: a Summary sheet with a
// Date and a Start Time column would otherwise be written first and put the tax
// header above the shifts, which reads as a file with no shifts in it.
const decoy = { name: 'Summary', rows: [['Date', 'Start Time', 'Amount'], [46271, 0.29, 12]] };
const realData = { name: 'Data', rows: [['Week', 'Date', 'End Time', 'Start Time'], [36, 46271, 0.625, 0.29]] };
ok('the shift sheet is the sheet carrying all three header names',
  workbookToCsv([decoy, realData]).indexOf('Amount') > workbookToCsv([decoy, realData]).indexOf('End Time'), true);
ok('a sheet with no rows is dropped, not written as an empty section',
  workbookToCsv([{ name: 'Summary', rows: [['Week Start Date', 'PAYE'], ['2026-09-06', 5]] }, { name: 'Empty', rows: [] }]),
  'Week Start Date,PAYE\n2026-09-06,5');

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
// A colon and a full stop are the same two pixels on a photograph: JPEG ringing
// closes the gap between a colon's dots, and the engine hands back "07.00-15.00".
// That is a whole shift, and refusing it over the punctuation lost the day.
ok('a colon read as a dot is still a range', parseTimeCell('07.00-15.00'), { startMin: 420, endMin: 900 });
ok('a colon read as a comma is too', parseTimeCell('7,15-13,45'), { startMin: 435, endMin: 825 });
ok('a typographic minus is a range', parseTimeCell('12:30\u221220:00'), { startMin: 750, endMin: 1200 });
// The dot is a MINUTE separator, not a decimal point: a date is three numbers and
// a clock time is two, so none of these becomes a shift.
ok('a numeric date is not a time', parseTimeCell('22.09.2026'), null);
ok('and neither is a lone number', parseTimeCell('12.40'), null);
// The date grammar: a month written out, and a year printed beside it. The year
// matters at the turn of the year — the nearest-year guess is wrong for half the
// photos taken either side of it, and a printed year is the sheet saying so.
const dated = new Date(Date.UTC(2026, 8, 25));
ok('a date that names its month reads', parseDateToken('20 September 2026', dated).toISOString().slice(0, 10), '2026-09-20');
ok('a short month with a year reads', parseDateToken('22-Sep-2026', dated).toISOString().slice(0, 10), '2026-09-22');
ok('a printed year is obeyed even when the nearest one would differ',
  parseDateToken('29-Dec-2025', new Date(Date.UTC(2027, 0, 2))).toISOString().slice(0, 10), '2025-12-29');
ok('without a year the nearest one is still the guess', parseDateToken('29-Dec', dated).toISOString().slice(0, 10), '2026-12-29');
ok('all-numeric dates are unaffected by the month-name grammar', parseDateToken('22/09/2026', dated).toISOString().slice(0, 10), '2026-09-22');
ok('an impossible day is not a date', parseDateToken('32-Sep-2026', dated), null);
ok('and a time range is never a date', parseDateToken('07:00-15:00', dated), null);

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
ok('a cell whose colon came back as a dot is still the day\u2019s shift',
  cellOf(toks(['07.00-15.00', 10, 160])), '07:00-15:00');
ok('and one read with a hyphen and a full stop is recovered from its text',
  cellOf(toks(['| 12.00 - 20.00 |', 4, 200])), '12:00-20:00');
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
// The grammar the Tesco tab's quick entry promises. Today is pinned to Thursday
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

// ---------- the Week off card's row ----------
// The card asks for a day of the week and the hours of pay; weekOffShift answers
// with the row that gets stored. Its rules are the importer's — storedShift keeps a
// row that has hours and no times — and the date it lands on is the week's Sunday,
// because a pay week runs Sun → Sat (WEEK_START_DOW) and the Sunday is the date
// that says which week the row belongs to.
const weekOff = (date, hours) => weekOffShift(date, hours);
ok('a week off is dated on its week’s Sunday',
  (() => { const r = weekOff('2026-09-24', '7'); return [r.ok, r.shift.date]; })(), [true, '2026-09-20']);
ok('a date already on the Sunday stays put', weekOff('2026-09-20', '7').shift.date, '2026-09-20');
ok('and any day of that week lands on the same Sunday',
  [weekOff('2026-09-22', '7').shift.date, weekOff('2026-09-26', '7').shift.date], ['2026-09-20', '2026-09-20']);
// The row is the sheet's own week-off shape and what the quick entry writes for
// "week off 7h": hours, no clock times, the same note, no special flag.
ok('the row it writes is the quick entry’s own week-off row',
  (() => { const s = weekOff('2026-09-24', '7.5').shift; return [s.start, s.end, s.hours, s.note, s.special]; })(),
  ['', '', 7.5, 'week off', false]);
ok('so it prices at the card rate and reads back as the week card will show it',
  shiftPreviewLine(weekOff('2026-09-24', '7').shift, shiftPay(weekOff('2026-09-24', '7').shift, null), money),
  'Sun 20 Sep · 7h stated, no clock times · normal €14.44/h → €101.08 · week off');
// Hours are statedHours' bounds with 0 excluded (a week off worth nothing is a
// mistyped week off), and the field that is wrong is named — the shape
// applyShiftEdit answers in, so the card can point at it.
ok('0 hours is refused at its own field',
  (() => { const r = weekOff('2026-09-24', '0'); return [r.ok, r.field]; })(), [false, 'hours']);
ok('an empty hours box is refused', weekOff('2026-09-24', '').ok, false);
ok('a negative is refused', weekOff('2026-09-24', '-3').ok, false);
ok('the top of the ladder is 168h, and past it is refused',
  [weekOff('2026-09-24', '168').shift.hours, weekOff('2026-09-24', '169').ok], [168, false]);
ok('part of a week is kept as stated, to the half hour', weekOff('2026-09-24', 5.5).shift.hours, 5.5);
ok('a figure with more decimals is rounded the way every figure here is',
  weekOff('2026-09-24', '7.333').shift.hours, 7.33);
ok('a date the card cannot use is refused at the date field',
  (() => { const r = weekOff('', '7'); return [r.ok, r.field]; })(), [false, 'date']);
ok('and a date that is not a date likewise', weekOff('next tuesday', '7').ok, false);
// A week off has to survive the file it is exported to, or the row the card wrote
// comes back as a blank one: no clock times, its hours in the Hours column, and
// its note — which is what makes it a week off rather than a mistyped shift.
ok('a week off round-trips through the CSV with its hours and note',
  (() => {
    const file = tescoCsv([weekOff('2026-09-24', '7.5').shift], [], null);
    const s = storedShift(parseTescoCsv(file).shifts[0], 'w1', 'T');
    return [s.date, s.start, s.end, s.hours, s.note];
  })(),
  ['2026-09-20', '', '', 7.5, 'week off']);

// ---------- a week's final bank pay ----------
// Typed off a bank statement, so it is the one figure here no formula can derive.
// It belongs to the WEEK, and buildPayWeeks adds up every figure it finds on a
// week's records (a payslip's when any payslip has one, otherwise the rows') — so
// weekBankWrite puts it on the week's carrier row and on the week's own payslip
// and clears it from every other record of that week. A second copy would pay the
// week twice, which is the whole reason the rule is a function and not a setter.
const bankShifts = [
  { id: 'b1', date: '2026-09-20', start: '10:00', end: '17:00' }, // the week's carrier (its Sunday)
  { id: 'b2', date: '2026-09-21', start: '08:00', end: '16:00' },
  { id: 'b3', date: '2026-09-27', start: '08:00', end: '16:00' }, // the next week
];
const weekBankOf = (st, sl, ws) => {
  const w = buildPayWeeks(st, sl, null).find(x => x.weekStart === ws);
  return w ? w.bankPaid : null;
};
const bankTyped = weekBankWrite(bankShifts, [], 'b1', 505.4);
ok('a figure bankTyped on the week’s carrier row becomes the week’s received',
  [bankTyped.shifts[0].bankPay, weekBankOf(bankTyped.shifts, bankTyped.payslips, '2026-09-20')], [505.4, 505.4]);
ok('and touches neither its week-mates nor another week',
  ['bankPay' in bankTyped.shifts[1], 'bankPay' in bankTyped.shifts[2], weekBankOf(bankTyped.shifts, bankTyped.payslips, '2026-09-27')],
  [false, false, null]);
// A week can hold the figure on one of its payslips instead — the sheet's tax
// table has no column for it, so the importer carries it there — and a payslip's
// copy wins in buildPayWeeks. Typing on the row has to bring the payslip with it,
// or the figure just bankTyped would be ignored.
const weekShiftOff = [{ id: 'c1', date: '2026-09-17', start: '', end: '', hours: 7.5, note: 'week off' }];
const bankSlips = [{ id: 'p1', weekStart: '2026-09-13', paye: 0, usc: 0, prsi: 0, futureFund: 0, bankPay: 478.42 }];
const bankMoved = weekBankWrite(weekShiftOff, bankSlips, 'c1', 500);
ok('typing on the row updates the week’s payslip to match',
  [bankMoved.shifts[0].bankPay, bankMoved.payslips[0].bankPay, weekBankOf(bankMoved.shifts, bankMoved.payslips, '2026-09-13')],
  [500, 500, 500]);
// Two figures in one week would be added, so the week's figure is bankMoved rather
// than left lying on a row the card no longer shows a cell for.
const bankSpread = weekBankWrite(
  [{ id: 'd1', date: '2026-09-20', start: '10:00', end: '17:00' },
   { id: 'd2', date: '2026-09-21', start: '08:00', end: '16:00', bankPay: 100 }],
  [], 'd1', 300);
ok('a stale figure on another row of the week is cleared, not added',
  [bankSpread.shifts[0].bankPay, 'bankPay' in bankSpread.shifts[1], weekBankOf(bankSpread.shifts, bankSpread.payslips, '2026-09-20')],
  [300, false, 300]);
// A correction run inside one week is two payslips, and buildPayWeeks adds their
// nets up — so only the week's own keeps the figure.
const twoSlips = weekBankWrite(weekShiftOff,
  [{ id: 'q1', weekStart: '2026-09-13', paye: 0, usc: 0, prsi: 0, futureFund: 0, bankPay: 100 },
   { id: 'q2', weekStart: '2026-09-14', paye: 0, usc: 0, prsi: 0, futureFund: 0, bankPay: 200 }],
  'c1', 500);
ok('a second payslip in the week does not leave a second copy to be added',
  ['bankPay' in twoSlips.payslips[0], twoSlips.payslips[1].bankPay, weekBankOf(twoSlips.shifts, twoSlips.payslips, '2026-09-13')],
  [false, 500, 500]);
// Blank means "not paid yet / not known", which is a real state: the received
// line hides rather than claiming the bank paid nothing.
const bankBlanked = weekBankWrite(bankTyped.shifts, bankTyped.payslips, 'b1', '');
ok('blanking the box clears the week rather than paying it nothing',
  ['bankPay' in bankBlanked.shifts[0], weekBankOf(bankBlanked.shifts, bankBlanked.payslips, '2026-09-20')], [false, null]);
ok('and a figure that is not a number clears it too',
  'bankPay' in weekBankWrite(bankTyped.shifts, bankTyped.payslips, 'b1', 'abc').shifts[0], false);
ok('a clawback goes in as a negative', weekBankOf(weekBankWrite(bankShifts, [], 'b1', -42.5).shifts, [], '2026-09-20'), -42.5);
// Clicking into the box and straight back out is not an edit: the same records
// come back, which is what stops an undo step (and a toast) for nothing.
ok('an unchanged figure hands back the same records',
  (() => { const r = weekBankWrite(bankShifts, [], 'b1', ''); return [r.shifts.every((s, i) => s === bankShifts[i]), r.payslips.length]; })(),
  [true, 0]);
ok('a full precision figure already reading as the bankTyped one is left alone',
  (() => { const st = [{ id: 'e1', date: '2026-09-20', start: '10:00', end: '17:00', bankPay: 478.4200134277344 }];
    return weekBankWrite(st, [], 'e1', '478.42').shifts[0] === st[0]; })(), true);
ok('a row the tab no longer holds is a no-op',
  (() => { const r = weekBankWrite(bankShifts, [], 'gone', 5); return [r.shifts === bankShifts, r.payslips.length]; })(),
  [true, 0]);
// The CSV carries a week's figure on that same carrier row, so exporting and
// re-importing puts it back where it was bankTyped.
ok('the bankTyped figure exports on the carrier row and reads back on it',
  (() => {
    const file = tescoCsv(bankTyped.shifts, [], null);
    const backRow = parseTescoCsv(file).shifts.find(s => s.date === '2026-09-20');
    return [backRow.bankPay, parseTescoCsv(file).shifts.find(s => s.date === '2026-09-21').bankPay];
  })(),
  [505.4, undefined]);

// ---------- the week card's "vs est" chip ----------
// The chip reconciles the week's RECORDED money with the estimate printed above
// it, and the two have to be the same base. The reported week recorded a payslip
// total of €69.92 (PAYE+USC+PRSI+FF) and a bank figure of €469.78, against an
// estimate of PAYE €31.01 · USC €7.33 · PRSI €22.67 · FF €8.10 → net €470.59:
// measured against the net it is €469.78 − €470.59 = −0.81, money short of the
// estimate. Measuring the bank figure against the withholding total (or the
// payslip against the net) gives a number belonging to neither line — which is
// how this printed "+0.81 vs est" beside the wrong base for months.
ok('the estimate the chip measures against is the card’s own line',
  (() => { const s = simulateTax(539.7, null); return [s.paye, s.usc, s.prsi, s.pension, s.net]; })(),
  [31.01, 7.33, 22.67, 8.1, 470.59]);
const chipShifts = [{ id: 'v1', date: '2026-09-20', start: '09:00', end: '17:00', gross: 539.7, bankPay: 469.78 }];
const chipSlips = [{ id: 'v1p', weekStart: '2026-09-20', paye: 31.82, usc: 7.33, prsi: 22.67, futureFund: 8.1 }];
const chipWeek = buildPayWeeks(chipShifts, chipSlips, null)[0];
ok('the reported week: payslip total €69.92', chipWeek.paid, 69.92);
ok('the chip measures the RECEIVED net against the estimate’s net',
  weekVsEstimate(chipWeek, null), { against: 'net', delta: -0.81 });
// The old base, pinned so the difference is on the record rather than in a note:
// this is the +0.81 the card used to print, taken off the wrong comparison.
ok('the withholding against the estimate was the old, wrong base',
  r2(chipWeek.paid - (simulateTax(539.7, null).tax + simulateTax(539.7, null).pension)), 0.81);
// A week with a payslip and no bank figure has only its withholding to compare —
// and a payslip total is PAYE+USC+PRSI+FF, so that base is the estimate's tax plus
// its pension, never the net (which is a different figure entirely).
ok('with no bank figure the chip falls back to the withholding, and names it',
  weekVsEstimate(buildPayWeeks(chipShifts.map(({ bankPay, ...s }) => s), chipSlips, null)[0], null),
  { against: 'tax', delta: 0.81 });
// A payslip week with no shift rows has no gross to estimate from at all, so there
// is no chip: its tax alone says nothing about what it was taken out of.
ok('a payslip-only week has no gross to estimate from, so no chip',
  weekVsEstimate(buildPayWeeks([], chipSlips, null)[0], null), null);
// A net typed on a week with no payslip is money in the bank like any other, and
// the chip is the one figure on the line that can be checked against the estimate.
ok('a bank figure with no payslip still gets the net chip',
  weekVsEstimate(buildPayWeeks([{ id: 'v2', date: '2026-09-20', start: '09:00', end: '17:00', gross: 539.7, bankPay: 470.59 }], [], null)[0], null),
  { against: 'net', delta: 0 });
ok('a week that recorded nothing has no chip',
  weekVsEstimate(buildPayWeeks(chipShifts.map(({ bankPay, ...s }) => s), [], null)[0], null), null);

// ---------- what each pay date brought ----------
// The dashboard's Tesco pay tracker fills a Thursday's ledger entry from Tesco
// Pay, and the join is the pay date — a week's Sunday + 11, the Thursday the
// money lands (payDateOf) — so the entry and the tab's own “Received” for that
// week are one figure. Only a week with something RECORDED is offered, and the
// source rides along so the row can say which: `bank` is a typed Final Bank Pay
// (what the user watched land), `recorded` is the sheet's own Calculated Income
// (gross − the tax its payslips withheld). A week with nothing recorded yet is
// deliberately absent: its simulated net is an ESTIMATE, and an estimate written
// into the ledger as income is a wrong figure nobody sees arrive.
const payMap = receivedByPayDate(chipShifts, chipSlips, null, '2026-10-02');
ok('the key is the week’s Sunday + 11, and that date is a Thursday',
  [Object.keys(payMap), new Date('2026-10-01T00:00:00Z').getUTCDay()], [['2026-10-01'], 4]);
ok('a recorded bank figure is what that pay date brought',
  payMap['2026-10-01'], { amount: 469.78, source: 'bank' });
// 539.70 − 69.92 = 469.78: with no bank figure the week’s own arithmetic stands
// in, and 470.59 (the estimate) is NOT what the ledger would be offered.
ok('with no bank figure the week’s own arithmetic stands in, and is named as such',
  receivedByPayDate(chipShifts.map(({ bankPay, ...s }) => s), chipSlips, null, '2026-10-02')['2026-10-01'],
  { amount: 469.78, source: 'recorded' });
// The one deliberate divergence from the month card, pinned beside it below.
ok('a week with shifts only is left out rather than offered an estimate',
  receivedByPayDate(chipShifts.map(({ bankPay, ...s }) => s), [], null, '2026-10-02'), {});
ok('a week whose records add up to nothing to pay is left out too',
  receivedByPayDate([], chipSlips, null, '2026-10-02'), {});
// A refund week is money in — the case the engine’s own header names — so it is
// a figure like any other, at its own pay date.
ok('a payslip-only refund week is money in, at its pay date',
  receivedByPayDate([], [{ id: 'r1', weekStart: '2026-09-20', paye: -50, usc: 0, prsi: 0, futureFund: 0 }], null, '2026-10-02')['2026-10-01'],
  { amount: 50, source: 'recorded' });
// The ledger fill and the month card read the same week through the same rule:
// 469.78 is both what the tab says was received and what the tracker fills.
ok('and the month card’s Received for that week is the same figure',
  monthSummary(chipShifts, chipSlips, null, 2026, 9, '2026-10-01').received, 469.78);
ok('while a shift-only week the ledger is not offered is still counted by the month card',
  [monthSummary([{ id: 'n1', date: '2026-09-20', start: '09:00', end: '17:00', gross: 539.7 }], [], null, 2026, 9, '2026-10-01').received,
   receivedByPayDate([{ id: 'n1', date: '2026-09-20', start: '09:00', end: '17:00', gross: 539.7 }], [], null, '2026-10-02')],
  [470.59, {}]);
// A week is only RECEIVED once its pay date has come round - the rule
// receivedTotal has always applied, and without it here the ledger wrote a line
// dated in the future on any recording made in the first days of a month.
const futureShifts = [{ id: 'f1', date: '2026-09-28', start: '09:00', end: '17:00', gross: 539.7 }];
const futureSlips = [{ id: 'f2', weekStart: '2026-09-28', paye: 69.92, usc: 0, prsi: 0, futureFund: 0 }];
ok('a week paid on a Thursday that has not come round is not received yet',
  receivedByPayDate(futureShifts, futureSlips, null, '2026-10-02'), {});
ok('and it is received once that Thursday arrives',
  receivedByPayDate(futureShifts, futureSlips, null, '2026-10-09'),
  { '2026-10-08': { amount: 469.78, source: 'recorded' } });
ok('but a typed bank figure is money the user watched land, whatever the date',
  receivedByPayDate([{ ...futureShifts[0], bankPay: 469.78 }], [], null, '2026-10-02'),
  { '2026-10-08': { amount: 469.78, source: 'bank' } });
ok('with no date to measure against, only bank figures count as arrived',
  receivedByPayDate(futureShifts, futureSlips, null), {});

// ---------- the ledger lines a recording owes ----------
// The automatic half of the tracker above: a pay date with a recorded figure and
// nothing on it in the ledger gets its Balances line without anyone pressing
// Fill. settings.tescoPayLedger is the record of which line this app wrote, and
// it carries the whole weight of the three rules below — it is what lets a
// CORRECTED week follow without overwriting a line the user edited by hand, and
// what keeps a line the user DELETED from being written back on the next
// recording of that week.
const twoDates = { '2026-10-01': { amount: 469.78, source: 'bank' }, '2026-10-08': { amount: 450, source: 'recorded' } };
const payEntry = (id, date, amount) => ({ id, date, type: 'credit', category: 'misc', details: 'Tesco pay', amount, method: TESCO_PAY_METHOD, note: '' });
// The window these rules are read in: October, up to the 9th, so both pay dates
// below (the 1st and the 8th) have come round and each rule can be read on its
// own terms. The window's own edges are tested after them.
const lw = tescoPayWriteWindow('2026-10-09');
ok('a recorded pay date the ledger is silent on is a line to write, oldest first',
  tescoPayLedgerWrites(twoDates, [], {}, lw).create,
  [{ date: '2026-10-01', amount: 469.78, source: 'bank' }, { date: '2026-10-08', amount: 450, source: 'recorded' }]);
ok('a date the user already has income on is theirs, and nothing is written over it',
  tescoPayLedgerWrites(twoDates, [payEntry('e1', '2026-10-01', 500)], {}, lw).create,
  [{ date: '2026-10-08', amount: 450, source: 'recorded' }]);
// A transfer's credit leg is not income — app.js's isIncomeEntry says so, and the
// Balances tracker counts a date paid by the same rule — so it cannot stand in
// for the pay and must not stop the line.
ok('a transfer leg on the date does not count as the date being paid',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } },
    [{ ...payEntry('e1', '2026-10-01', 469.78), transferId: 't1' }], {}, lw).create,
  [{ date: '2026-10-01', amount: 469.78, source: 'bank' }]);
// Deleting the line has to stick. Without the record this is simply an unpaid
// date, and the next recording of that week would put back what the user removed.
ok('a line this app wrote whose entry is gone is never written again',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } }, [],
    { '2026-10-01': { id: 'w1', amount: 469.78 } }, lw),
  { create: [], update: [] });
// The recording HAS moved here (450 → 469.78), which is the case that would
// overwrite the user's figure if the line were followed by id alone.
ok('and neither is one the user has given their own figure',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } },
    [payEntry('w1', '2026-10-01', 400)], { '2026-10-01': { id: 'w1', amount: 450 } }, lw),
  { create: [], update: [] });
ok('a corrected recording follows the line this app wrote',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } },
    [payEntry('w1', '2026-10-01', 450)], { '2026-10-01': { id: 'w1', amount: 450 } }, lw).update,
  [{ date: '2026-10-01', id: 'w1', amount: 469.78, source: 'bank' }]);
ok('while a recording that has not moved leaves the line exactly as it is',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } },
    [payEntry('w1', '2026-10-01', 469.78)], { '2026-10-01': { id: 'w1', amount: 469.78 } }, lw),
  { create: [], update: [] });
// A week with nothing recorded is absent from receivedByPayDate, so the week
// card's estimate can never reach the ledger through this path either.
ok('an unrecorded week is never written', tescoPayLedgerWrites({}, [], {}), { create: [], update: [] });
let ledgerJunk = null;
try { ledgerJunk = tescoPayLedgerWrites(twoDates, 'nope', 42, lw).create.length; } catch { ledgerJunk = 'threw'; }
ok('junk in the ledger or the record cannot throw the rule', ledgerJunk, 2);
// Applying the plan is what the next pass reads — the entry it made and the mark
// it left — so running it twice must write once. This is the property the whole
// feature rests on: a recording that fires again (a settle after another
// keystroke, a commit after a shift edit) must not add a second line.
const secondPass = (() => {
  const plan = tescoPayLedgerWrites(twoDates, [], {}, lw);
  const entries = plan.create.map((w, i) => payEntry(`n${i}`, w.date, w.amount));
  const marks = Object.fromEntries(plan.create.map((w, i) => [w.date, { id: `n${i}`, amount: w.amount }]));
  return tescoPayLedgerWrites(twoDates, entries, marks, lw);
})();
ok('and the plan is idempotent: applied, the next pass writes nothing', secondPass, { create: [], update: [] });
// The window, which is the whole of the fix for the balance that went 4,000 →
// 15,000: one recording used to write every pay date the tables had ever held
// (25 lines / 9,377.75 in a single run). A create may only land on the current
// month's own days, up to today — the set the tracker card lists.
ok('the write window is this month, up to today', tescoPayWriteWindow('2026-10-09'),
  { from: '2026-10-01', to: '2026-10-09' });
ok('a pay date from an earlier month is history, and is not created',
  tescoPayLedgerWrites({ '2026-09-24': { amount: 469.78, source: 'recorded' } }, [], {}, lw),
  { create: [], update: [] });
ok('nor is one the month has not reached yet',
  tescoPayLedgerWrites({ '2026-10-15': { amount: 469.78, source: 'recorded' } }, [], {}, lw),
  { create: [], update: [] });
// No window, or one that will not parse: nothing may be created. This is the
// guard against the unbounded case returning — an absent bound must read as
// "create nothing", never as "create everything".
ok('without a window nothing is ever created',
  tescoPayLedgerWrites(twoDates, [], {}), { create: [], update: [] });
ok('and a window that will not parse creates nothing either',
  [tescoPayWriteWindow('October'), tescoPayWriteWindow(undefined), tescoPayWriteWindow(20261009),
   tescoPayLedgerWrites(twoDates, [], {}, tescoPayWriteWindow('October')).create.length],
  [null, null, null, 0]);
ok('a window whose ends are the wrong way round is not widened into one',
  tescoPayLedgerWrites(twoDates, [], {}, { from: '2026-10-09', to: '2026-10-01' }).create.length, 0);

// app.js's source is read once here, before the first pin that needs it, so a
// block can assert against it wherever it sits in this file.
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const reconStart = appSource.indexOf('function recordTescoPayToLedger()');
const reconNext = appSource.indexOf('\nfunction ', reconStart + 10);
const reconSrc = reconStart === -1 ? '' : appSource.slice(reconStart, reconNext === -1 ? appSource.length : reconNext);

// ---------- a line the USER filled is theirs, including after they delete it ----------
// The three rules above only ever saw the recorder's own marks, so a Thursday
// the user filled by hand and then deleted in History looked simply *unfilled*:
// inside the write window the next Tesco commit wrote the money straight back.
// A mark tagged `by: 'fill'` (app.js's withTescoFillMark) closes that, and it
// has to close BOTH halves — never recreated, and never moved either, because a
// figure they typed is their reading of what landed rather than this app's.
const fillMark = { '2026-10-01': { id: 'f1', amount: 500, by: 'fill' } };
ok('a hand-filled date is never written again after they delete it',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } }, [], fillMark, lw),
  { create: [], update: [] });
ok('and their own figure is not moved when that week\'s recording changes',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } },
    [payEntry('f1', '2026-10-01', 500)], fillMark, lw).update,
  []);
ok('while a recorder mark on the same date is still followed',
  tescoPayLedgerWrites({ '2026-10-01': { amount: 469.78, source: 'bank' } },
    [payEntry('w1', '2026-10-01', 450)], { '2026-10-01': { id: 'w1', amount: 450 } }, lw).update,
  [{ date: '2026-10-01', id: 'w1', amount: 469.78, source: 'bank' }]);
// The tag has exactly one writer, and it is not the recorder: four call sites
// (the per-row Fill, Auto-fill, and the amount modal's two branches) all go
// through one helper, so the recorder cannot accidentally claim a fill as its
// own — which is what would let the repair remove it later.
const fillTagCalls = (appSource.match(/= withTescoFillMark\(/g) || []).length;
ok('the per-row Fill, Auto-fill and both modal branches all mark the date',
  fillTagCalls, 4);
ok('and they all go through the one helper that writes the tag',
  /function withTescoFillMark\(marks, dateStr, id, amount\)/.test(appSource)
  && /\[dateStr\]: \{ id, amount, by: 'fill' \}/.test(appSource), true);
ok('the recorder never writes that tag itself',
  /nextMarks\[write\.date\] = \{ id: entry\.id, amount: write\.amount \};/.test(reconSrc)
  && !/by: 'fill'/.test(reconSrc), true);
// The undo that goes with each fill has to take the record back too, or an
// undone fill would leave a mark pointing at an entry that no longer exists —
// which reads as "the user deleted this" and silences the recorder on a date
// nobody asked it to leave alone.
ok('every fill\'s undo restores the record with the entries',
  (appSource.match(/state\.settings\.tescoPayLedger = wasMarks;/g) || []).length,
  5);
// And the repair must not count a fill as its own: it is offered as "written by
// the recorder, not by you" and its toast promises your fills are untouched.
ok('the repair leaves the user\'s own fills out of what it removes',
  /Object\.values\(marks\)\s*\.filter\(m => m && m\.by !== 'fill'\)/.test(appSource), true);

// The wiring those rules need to reach a real recording. app.js owns the write
// (and its undo) because the ledger is the app shell's, not the lazy Tesco
// module's; the module calls it with the tables just written. Pinned against the
// source text for the same reason test-motion.mjs pins paintFigure: app.js cannot
// be imported here, it touches the DOM as it evaluates.
ok('the reconciler exists in the app shell', reconStart !== -1 && reconSrc.length > 500, true);
// The caller owns the undo step — a Tesco commit folds this into its own, and a
// payslip settle takes one of its own — so taking one in here would stack two.
ok('it does not take its own undo step', !/trackAction\(/.test(reconSrc), true);
ok('its undo gives the pay date back, so recording that week again writes again',
  /state\.settings\.tescoPayLedger = wasMarks;/.test(reconSrc), true);
ok('and a line it made is tombstoned, so a merge cannot bring the undone one back',
  /tombstoneIds\(\[\.\.\.gone\]\)/.test(reconSrc), true);
// One kind of line in the ledger, not two: the automatic entry is the shape Fill
// has always written, so the dashboard, the CSV and the budget rules see the same
// thing whichever way the money got there.
ok('the entry it writes is the one Fill writes',
  /type: 'credit'/.test(reconSrc) && /category: 'misc'/.test(reconSrc)
  && /details: 'Tesco pay'/.test(reconSrc) && /method: TESCO_PAY_METHOD/.test(reconSrc), true);
// The window is a rule IN THE ENGINE, but it only holds if the shell hands one
// in: a call that drops the fourth argument creates nothing (the safe side), and
// a call that passed a wider bound would be the 4,000 → 15,000 run all over
// again. Both halves are pinned here — the window is built from today, and the
// same date gates receivedByPayDate so no line can be written ahead of the money.
ok('the shell hands the recorder a window built from today',
  /tescoPayLedgerWrites\(recorded, state\.entries, marks, tescoPayWriteWindow\(today\(\)\)\)/.test(reconSrc), true);
ok('and it reads the week table against that same today',
  /receivedByPayDate\(t\.shifts \|\| \[\], t\.payslips \|\| \[\], rates, today\(\)\)/.test(reconSrc), true);
// The window must be the set the tracker card offers, or a line could appear for
// a Thursday the card does not show and the two halves of the feature would
// disagree about which pay dates exist.
const cardSrc = appSource.slice(appSource.indexOf('const thursdays = thursdaysInMonth('), appSource.indexOf('const thursdays = thursdaysInMonth(') + 900);
ok('the tracker card lists this month’s Thursdays up to today',
  /thursdaysInMonth\(now\.getFullYear\(\), now\.getMonth\(\)\)/.test(cardSrc)
  && /d <= todayStr/.test(cardSrc), true);
// The repair is what lets a user who already took the catch-up put it back —
// and it must never touch a line they filled themselves, or "your own fills are
// untouched" would be a lie and the ledger would go negative for no reason.
ok('the repair is reachable from the Data menu only while such lines exist',
  /appWrittenTescoLines\(\);[\s\S]{0,400}?Remove automatic Tesco pay lines/.test(appSource), true);
ok('and it leaves the record alone — clearing it would hand the catch-up back',
  /function removeAppWrittenTescoLines\(\)[\s\S]{0,700}?settings\.tescoPayLedger\s*=/.test(appSource), false);
ok('and it takes the undo step of its own, since nothing called it has one',
  /function removeAppWrittenTescoLines\(\)[\s\S]{0,700}?trackAction\(/.test(appSource), true);

// ---------- where a recorded Tesco pay lands ----------
// The method id is not a label: `balanceDelta` counts a credit on a gift-card
// method (TG/LG/AG) as a card LOAD, so a week's wages written on TG went onto the
// Tesco card's balance — and into its "recorded loads" — while the account the
// payslip pays into stayed short by the whole week. The method is therefore one
// exported constant in the engine, read by every writer.
const seedSource = readFileSync(new URL('../seed.js', import.meta.url), 'utf8');
ok('a recorded Tesco pay lands on a method the app defines',
  new RegExp(`\\{ id: '${TESCO_PAY_METHOD}'`).test(seedSource), true);
const giftCardIds = (appSource.match(/const GIFT_CARD_IDS = \[([^\]]+)\]/) || [, ''])[1];
ok('and it is not a gift-card method, where a credit would read as a card load',
  giftCardIds.includes(`'${TESCO_PAY_METHOD}'`), false);
const payWrites = appSource.split('\n').filter(l => l.includes("details: 'Tesco pay'") && l.includes('method:'));
ok('every writer of a Tesco pay entry names a method', payWrites.length, 5);
ok('and every one of them names that constant rather than a literal',
  payWrites.filter(l => !l.includes('method: TESCO_PAY_METHOD')), []);
// The fallback amount the tracker repeats finds Tesco pay lines by their own
// label, not by where the money went, so a ledger already holding entries from
// when it was the card keeps counting them (a method filter would silently
// drop the fallback to zero for everyone who filled a Thursday before this).
const lastPaySrc = (appSource.match(/function lastTescoPayAmount\(\)[\s\S]{0,600}?\n\}/) || [''])[0];
ok('the fallback amount matches on the line’s own label',
  /e\.details === 'Tesco pay'/.test(lastPaySrc), true);
ok('and does not filter on the method', /e\.method ===/.test(lastPaySrc), false);
const tescoSource = readFileSync(new URL('../tesco.js', import.meta.url), 'utf8');
ok('the screen is handed the reconciler', /recordTescoPayToLedger,\n\s*\}\)\)/.test(appSource)
  || /recordTescoPayToLedger,/.test(appSource.slice(Math.max(0, appSource.indexOf('screenTesco({')), appSource.indexOf('screenTesco({') + 900)), true);
// A recording made through the tab (an import, a Final Bank Pay) is ONE undo step
// even though it moved the ledger too.
ok('a Tesco commit folds the ledger write into its own undo step',
  /const ledger = ctx\.recordTescoPayToLedger[\s\S]{0,900}?if \(ledger\) ledger\.undo\(\);/.test(tescoSource), true);
ok('and says in the toast what reached the ledger',
  /toast\(ledger \? `\$\{message\} \$\{ledger\.note\}` : message, undo, 'Undo'\)/.test(tescoSource), true);
// A payslip typed into the card has no commit behind it — those fields settle on
// a timer so a caret survives — so that path reconciles on its own settle.
ok('a payslip figure typed into the card reconciles on its own settle',
  /payslipPaintPending = false;[\s\S]{0,900}?recordTescoPayToLedger/.test(tescoSource), true);

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
// A header that lost ONE day in the middle — read at an angle with the light
// falling off across the sheet, which is the photo a roster really arrives as.
// The missing day goes back into the gap it left, because a column's date comes
// from its POSITION in the row: a fill at the left edge instead renumbers every
// day by one, which is a whole week paid a day late.
const holed = columnAnchors([headerRow([
  ...dayNames.slice(0, 3).map(ph => ({ ...ph, text: 'T' })),
  ...dayNames.slice(4).map(ph => ({ ...ph, text: 'T' })),
].map((ph, i) => ({ ...ph, text: dayNames[i < 3 ? i : i + 1].text })), 360)], today, 90);
ok('a column lost in the middle is filled in the middle', holed.cols.map(c => c.cx), [430, 610, 790, 970, 1150, 1330, 1510]);
ok('so the days after it keep their own day', holed.cols.map(c => c.weekday), [2, 3, 4, null, 6, 0, 1]);
ok('and the week still dates from its own first day',
  resolveColumnDates(holed.cols, today).map(c => c.date.toISOString().slice(8, 10)),
  ['22', '23', '24', '25', '26', '27', '28']);
// With no gap to fill, the day left over goes on the left — the end the header
// loses when the light falls off on the name column's side — and that is safe:
// the day names then date every real column by its own weekday, whatever the
// phantom in front of them is numbered. Six names surviving, so the phantom is
// not a day of this week and the six are.
const short = columnAnchors([headerRow(dayNames.slice(0, 6), 360)], today, 90);
ok('a day the header did not give up goes back on the left',
  short.cols.map(c => c.cx), [250, 430, 610, 790, 970, 1150, 1330]);
ok('and the six real days keep their own dates',
  resolveColumnDates(short.cols, today).slice(1).map(c => c.date.toISOString().slice(8, 10)),
  ['22', '23', '24', '25', '26', '27']);

ok('a title range anchors the series when no date row survived',
  resolveColumnDates([{ cx: 100 }, { cx: 200 }, { cx: 300 }], today, new Date(Date.UTC(2026, 8, 22))).map(c => c.date.toISOString().slice(0, 10)),
  ['2026-09-22', '2026-09-23', '2026-09-24']);

// The title's date range is one RUN of print, and the engine boxes a run as one
// word: "Week 39   22/09/2026 - 28/09/2026   Store 3021" comes back whole.
// Reading only whole phrases threw the range away — the one line that says WHICH
// WEEK the sheet covers, and the one line of a header big enough to survive glare.
const mergedTitle = headerRow([{ text: 'Week 39 22/09/2026 - 28/09/2026 Store 3021', x0: 60, x1: 900 }], 240);
ok('a range inside one merged title phrase still dates the week',
  columnAnchors([mergedTitle, headerRow(dayNames, 360)], today, 90).weekStart.toISOString().slice(0, 10), '2026-09-22');
ok('and the same range written out months and all',
  columnAnchors([headerRow([{ text: 'Week 39 20 September 2026 - 26 September 2026', x0: 60, x1: 900 }], 240), headerRow(dayNames, 360)], today, 90)
    .weekStart.toISOString().slice(0, 10), '2026-09-20');
// ...and the band rule that decides which rows ARE the header has to see it too,
// or the row is never offered to columnAnchors at all.
const mergedRead = parseRosterWords([
  { text: 'Week 39 22/09/2026 - 28/09/2026 Store 3021', x0: 60, y0: 200, x1: 900, y1: 236, confidence: 92 },
  ...dayNames.map(ph => ({ text: ph.text, x0: ph.x0, y0: 300, x1: ph.x1, y1: 330, confidence: 92 })),
  { text: 'Parth', x0: 10, y0: 400, x1: 98, y1: 430, confidence: 93 },
  { text: '7-15', x0: 400, y0: 402, x1: 470, y1: 432, confidence: 90 },
], today, { name: 'parth' });
ok('the band rule sees the dates inside a merged title', mergedRead.columns.length, 7);
ok('so the row is dated off the week the title states',
  mergedRead.rows[0].cells.map(c => c.date), ['2026-09-22']);

// The range says WHERE the week is; the day names say which day is which. A
// Monday-first range printed over a Sunday-first grid, or one digit read wrong,
// moves every shift by a day — and a week dated a day late is the misread nobody
// catches. The names win, because they are what this function already trusts.
const sundayFirst = Array.from({ length: 7 }, (_, i) => ({ cx: 400 + i * 180, weekday: i }));
const asWeeks = list => list.map(c => c.date.toISOString().slice(0, 10));
const shifted = resolveColumnDates(sundayFirst.map(c => ({ ...c })), today, new Date(Date.UTC(2026, 8, 21)));
ok('a range one day out is slid to the week the day names state', asWeeks(shifted),
  ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
ok('and every one of its day names then agrees', columnDatingAgreement(shifted), { named: 7, agree: 7 });
ok('a range that already agrees is left exactly where it is',
  asWeeks(resolveColumnDates(sundayFirst.map(c => ({ ...c })), today, new Date(Date.UTC(2026, 8, 20))))[0], '2026-09-20');
// A range from ANOTHER week is still where the week is (that is what it is for) —
// the slide only ever fixes the rotation, never picks a week of its own.
ok('a range for another week keeps its week and gets the rotation right',
  asWeeks(resolveColumnDates(sundayFirst.map(c => ({ ...c })), today, new Date(Date.UTC(2026, 9, 15))))[0], '2026-10-18');
ok('a grid with no day names reports no names',
  columnDatingAgreement([{ cx: 1, date: new Date(Date.UTC(2026, 8, 22)) }]), { named: 0, agree: 0 });

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

// ---------- the page as ink and paper ----------
// A sheet lit from one side: paper at 235 grey on the left edge sliding to 110
// on the right, with a line of "glyphs" printed right across it — 6px of ink,
// 6px of gap, inked 90 grey below whatever the paper is on that part of the
// page. This is the shot no single threshold can read: cut at the middle of the
// range and the shadowed third comes back as one black slab, cut at the dark end
// and the lit third comes back blank.
const litW = 240, litH = 60;
const litPage = (() => {
  const g = new Uint8Array(litW * litH);
  for (let y = 0; y < litH; y++) {
    for (let x = 0; x < litW; x++) {
      const paper = Math.round(235 - (125 * x) / (litW - 1));
      g[y * litW + x] = (x % 12 < 6 && y > 10 && y < 40) ? Math.max(0, paper - 90) : paper;
    }
  }
  return g;
})();
// The same print under flat light, as the control.
const flatPage = (() => {
  const g = new Uint8Array(litW * litH).fill(235);
  for (let y = 11; y < 40; y++) for (let x = 0; x < litW; x++) if (x % 12 < 6) g[y * litW + x] = 145;
  return g;
})();
ok('a page lit from one side is read as unevenly lit', ocrIllumination(litPage, litW, litH).uneven, true);
ok('a page under flat light is not', ocrIllumination(flatPage, litW, litH).uneven, false);
ok('the light down one side is what the spread measures',
  ocrIllumination(litPage, litW, litH).spread > 100, true);
const litBin = ocrSauvola(litPage, litW, litH, { radius: 18 });
// The three answers that matter, at the two ends of the gradient and between two
// glyphs: local thresholding is only worth its cost if it gets the ink in the
// SHADOW as well as the ink in the light.
// x%12 < 6 is the ink, so x = 3 and x = 231 are glyphs and x = 9 and x = 237 are
// the gap between two of them.
ok('the lit end reads its glyphs as ink', litBin[25 * litW + 3], 0);
ok('the shadowed end reads its glyphs as ink too', litBin[25 * litW + 231], 0);
ok('the gap between two glyphs is still paper in the light', litBin[25 * litW + 9], 255);
ok('and still paper in the shadow', litBin[25 * litW + 237], 255);
ok('the page above the print is paper at both ends',
  [litBin[2 * litW + 3], litBin[2 * litW + litW - 3]], [255, 255]);
// A page whose paper is already one flat wash must not gain speckle from the
// local rule: that is the common case, and it is the one the LSTM's own grey is
// better for.
const flatBin = ocrSauvola(flatPage, litW, litH, { radius: 18 });
let flatInk = 0;
for (const v of flatBin) if (v === 0) flatInk++;
ok('a flat page keeps exactly its printed ink', flatInk, 29 * 120);

// The marks a RULE is read from, as opposed to a glyph (ocrLocalMarks): a
// hairline table rule is a 20-grey dip, which is far too faint for the glyph
// threshold above and exactly what a fixed margin is for.
const ruledPage = (() => {
  const w = 300, h = 80;
  const g = new Uint8Array(w * h).fill(240);
  for (let y = 18; y < 22; y++) for (let x = 10; x < 290; x++) g[y * w + x] = 205;   // a faint rule
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) g[y * w + x] -= Math.round(60 * y / h); // lit from the top
  return { g, w, h };
})();
const ruledMarks = ocrLocalMarks(ruledPage.g, ruledPage.w, ruledPage.h, { drop: 26, radius: 12 });
ok('a faint rule survives the local mark threshold', ruledMarks[20 * ruledPage.w + 150], 0);
ok('and the paper either side of it does not', ruledMarks[40 * ruledPage.w + 150], 255);
const ruledByGlyphs = ocrSauvola(ruledPage.g, ruledPage.w, ruledPage.h, { radius: 12 });
ok('the same rule is what the glyph threshold throws away', ruledByGlyphs[20 * ruledPage.w + 150], 255);

// The sheet's ruled grid: long contiguous runs, not counts of ink. A column of
// text has ink in nearly every row and is still not a rule — the text leaves gaps.
const gridW = 400, gridH = 300;
const gridBin = (() => {
  const b = new Uint8Array(gridW * gridH).fill(255);
  const vAt = [40, 100, 160, 220, 280, 340], hAt = [60, 120, 180, 240];
  for (const x of vAt) for (let dx = 0; dx < 3; dx++) for (let y = 20; y < 280; y++) b[y * gridW + x + dx] = 0;
  for (const y of hAt) for (let dy = 0; dy < 2; dy++) for (let x = 20; x < 380; x++) b[(y + dy) * gridW + x] = 0;
  // A dense column of "text" — ink in most rows, never in a long run.
  for (let y = 30; y < 270; y += 7) for (let x = 60; x < 68; x++) b[y * gridW + x] = 0;
  return b;
})();
const gridLines = ocrRulingLines(gridBin, gridW, gridH);
ok('six vertical rules are found, and the column of text is not one', gridLines.v, [41, 101, 161, 221, 281, 341]);
ok('four horizontal rules are found', gridLines.h, [60.5, 120.5, 180.5, 240.5]);

// The day grid the sheet's own rules draw, accepted only when every column the
// words found falls inside the span claiming it.
const sevenCols = Array.from({ length: 7 }, (_, i) => ({ cx: 140 + i * 40 }));
const eightLines = Array.from({ length: 8 }, (_, i) => 120 + i * 40);
const snug = rosterColumnsFromRules(eightLines, sevenCols, {});
ok('the rules give seven day columns', snug.bounds.length, 7);
ok('and each one starts where the sheet drew it', snug.bounds.map(b => b[0]), [120, 160, 200, 240, 280, 320, 360]);
ok('the name column ends at the rule the sheet drew', snug.nameEdge, 120);
ok('a grid whose rules do not frame the words is refused',
  rosterColumnsFromRules(eightLines.map(x => x + 30), sevenCols, {}), null);
ok('a page with no even pitch is refused',
  rosterColumnsFromRules([120, 121, 400, 401, 700, 701], sevenCols, {}), null);
ok('too few rules to be a week are refused',
  rosterColumnsFromRules([120, 160, 200], sevenCols, {}), null);

// ---------- which reading of a photo to believe ----------
// The reader takes several readings of one photo and keeps the best, so the score
// is what decides which week gets paid. A reading that merely mentions the typed
// name is not good enough: it has to have produced the week's columns and a dated
// shift on the row that name is on.
const wkWord = (text, x0, x1, y) => ({ text, x0, x1, y0: y, y1: y + 30, confidence: 90 });
const weekNames = ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'];
const weekDates = ['22-Sep', '23-Sep', '24-Sep', '25-Sep', '26-Sep', '27-Sep', '28-Sep'];
const weekHeader = [
  ...weekNames.map((t, i) => wkWord(t, 400 + i * 180, 460 + i * 180, 350)),
  ...weekDates.map((t, i) => wkWord(t, 400 + i * 180, 500 + i * 180, 400)),
];
const ownerRowWords = [
  wkWord('Parth', 60, 200, 500), wkWord('Sharma', 210, 330, 500),
  ...['07:00-15:00', 'OFF', '12:00-20:00', 'OFF', '09:00-17:00', '10:00-16:00', 'OFF']
    .map((t, i) => wkWord(t, 400 + i * 180, 540 + i * 180, 500)),
];
const wholeWeek = rosterReadQuality([...weekHeader, ...ownerRowWords], 'Parth', today);
ok('a reading of the whole week is accepted', wholeWeek.complete, true);
ok('it found the seven columns', wholeWeek.columns, 7);
ok('and the four shifts that week holds', wholeWeek.cells, 4);
ok('and the row that carries the typed name', wholeWeek.found, true);
// The same shot read as a strip that stopped before the header: the name and the
// shifts are there, the week's columns are not, and the old reader would have
// taken it — which is how a week lands in the wrong days.
const noHeader = rosterReadQuality(ownerRowWords, 'Parth', today);
ok('a reading with no header is not accepted', noHeader.complete, false);
ok('and it scores below the whole week', noHeader.score < wholeWeek.score, true);
// The header alone is worth its columns and the corroboration behind its dating,
// and nothing for a row: there is no owner row to pay for.
const headerOnly = rosterReadQuality(weekHeader, 'Parth', today);
ok('the header alone is worth its columns, its dating and no row',
  headerOnly.score, headerOnly.columns + headerOnly.agree * 2);
ok('its seven day names all agree with the dates it gave them', headerOnly.agree, 7);
// The reading a score could not judge before: a header whose names describe no
// week at all. Read in the dark side of a photo the day names come back in an
// order no week has, so at most a couple of them can agree with any dating — and
// at most a couple is not a header the sheet can be dated from. It used to be
// called whole, on the strength of having seven of them.
const SCRAMBLED = ['Sun', 'Wed', 'Fri', 'Mon', 'Sat', 'Tue', 'Thu'];
const weekOf = (names, title) => [
  ...names.map((t, i) => wkWord(t, 400 + i * 180, 460 + i * 180, 350)),
  wkWord(title, 60, 900, 290),
  ...ownerRowWords,
];
const garbled = rosterReadQuality(weekOf(SCRAMBLED, 'Week 39 22/09/2026 - 28/09/2026'), 'Parth', today);
const sound = rosterReadQuality(weekOf(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 'Week 39 22/09/2026 - 28/09/2026'), 'Parth', today);
ok('a header whose names describe no week is not accepted', garbled.complete, false);
ok('even though it found the row and its four shifts', [garbled.found, garbled.cells, garbled.columns], [true, 4, 7]);
ok('only two of its seven names agree with the dates they were given', garbled.agree, 2);
ok('the header that does describe a week is accepted', sound.complete, true);
ok('with every one of its names agreeing', sound.agree, 7);
ok('and the reading that agrees with itself outscores the one that does not', sound.score > garbled.score, true);
// Same seven names, same title, same photo — the only difference is whether the
// names describe a week. That pair is the whole rule: it is AGREEMENT that lets a
// reading be believed, not the mere presence of a header.
ok('the two readings differ only in their names',
  [garbled.columns, sound.columns, garbled.named, sound.named], [7, 7, 7, 7]);
ok('a reading without the typed name cannot be accepted', rosterReadQuality([...weekHeader, wkWord('Aoife', 60, 200, 500)], 'Parth', today).complete, false);
ok('nothing read is worth less than anything', rosterReadQuality([], 'Parth', today).score, -1);
// The same filter the parse applies, so what is judged good is what the parse uses.
const faint = rosterReadQuality(ownerRowWords.map(w => ({ ...w, confidence: 10 })), 'Parth', today);
ok('words the parse would throw away cannot make a reading', faint.words.length, 0);
ok('and a box that is not a number is not a word',
  rosterReadQuality([...weekHeader, ...ownerRowWords, { text: 'X', x0: 0, y0: 0, x1: 1, y1: 1, confidence: 90 }], 'Parth', today).words.length, wholeWeek.words.length + 1);

// ---------- the pool the ladder's readings run on ----------
// A scan gives one photo several independent readings — three strips, then the
// plain page and the thresholded one — and they run together on a small pool of
// engines (createOcrPool). Two things have to hold whatever the machine is: a
// read never shares a worker with another read (tesseract's whitelist and page
// mode are worker state, so two passes on one worker would read each other's
// settings), and every worker a scan built is gone once the scan ends, however
// it ended.
ok('a machine with cores to spare gets three workers', ocrPoolSize(16), OCR_POOL_MAX);
ok('and never more than three', ocrPoolSize(64), 3);
ok('a four-core machine keeps a core for the UI', ocrPoolSize(4), 3);
ok('a two-core machine still gets two', ocrPoolSize(2), 2);
ok('one core does not mean the one-after-another scan', ocrPoolSize(1), 2);
ok('an unknown core count assumes a phone, not a desktop', ocrPoolSize(undefined), 3);

function fakePool(size, { failAfter = Infinity } = {}) {
  const made = [], killed = [];
  const pool = createOcrPool({
    size,
    create: async () => {
      if (made.length >= failAfter) throw new Error('the engine would not start');
      const worker = { id: made.length + 1, terminate: async () => { killed.push(worker.id); } };
      made.push(worker);
      return worker;
    },
  });
  return { pool, made, killed };
}

// One read per worker, no more read in flight than the ceiling, and reads that
// arrive with every worker busy are served first-come-first-served — the ladder
// asks in its own order, so the batch is answered in it.
{
  const { pool, made, killed } = fakePool(3);
  const held = new Set();
  let shared = 0, running = 0, peak = 0;
  const used = await Promise.all([0, 1, 2, 3, 4, 5].map(i => pool.run(async worker => {
    if (held.has(worker.id)) shared++;
    held.add(worker.id);
    running++; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 4 + (i % 3) * 4));
    running--; held.delete(worker.id);
    return worker.id;
  })));
  ok('six reads on a pool of three never share a worker', shared, 0);
  ok('three of them read at once, and no more', peak, 3);
  ok('the pool built three workers for six reads', made.length, 3);
  ok('and reuses them rather than starting one per read', new Set(used).size, 3);
  ok('every read came back with its own answer', used.length, 6);

  const order = [];
  const waiting = [
    pool.run(async w => { order.push('a'); await new Promise(r => setTimeout(r, 25)); return w.id; }),
    pool.run(async w => { order.push('b'); await new Promise(r => setTimeout(r, 25)); return w.id; }),
    pool.run(async w => { order.push('c'); return w.id; }),
    pool.run(async w => { order.push('d'); return w.id; }),
  ];
  await Promise.all(waiting);
  ok('the reads that fit start before the ones that have to wait',
    order.indexOf('a') < order.indexOf('c') && order.indexOf('b') < order.indexOf('c'), true);
  ok('and the reads that waited are served in the order they arrived',
    order.indexOf('c') < order.indexOf('d'), true);

  await pool.dispose();
  ok('dispose terminates every worker the pool built', killed.sort().join(), '1,2,3');
  const afterClose = await pool.run(async () => 'ran').then(v => v, e => e.message);
  ok('a read asked for after the scan is closed fails rather than hanging', afterClose, 'The OCR pool is closed.');
}

// An engine that will not start cannot serve the reads parked behind it either:
// they fail with the engine's own reason, so a scan ends with something the user
// can read instead of a spinner that never stops.
{
  const { pool } = fakePool(3, { failAfter: 1 });
  const outcomes = await Promise.allSettled([
    pool.run(async w => w.id),
    pool.run(async w => w.id),
    pool.run(async w => w.id),
  ]);
  ok('the read that got a worker still finishes', outcomes[0].status, 'fulfilled');
  ok('the reads behind the failure fail instead of hanging',
    outcomes.slice(1).map(o => o.status).join(), 'rejected,rejected');
  ok('and they carry the engine\u2019s own reason',
    String(outcomes[1].reason && outcomes[1].reason.message), 'the engine would not start');
  await pool.dispose();
}

// ---------- the prep workers a read's pixels are prepared on ----------
// Preparing one read — draw the region at the engine's size, binarise it, encode
// the PNG — is seconds of work on a 12 MP photo, and it used to be seconds the
// reader's own thread spent unable to start the next reading, collect the last
// one, or repaint the bar. It runs on a pool of its own now (ocr-prep-worker.js),
// sized so the engine keeps its cores and the app keeps one, and the region the
// read looks at is cut on the reader's thread and transferred.
ok('a machine with cores to spare gives prep three workers', ocrPrepSize(16), OCR_PREP_MAX);
ok('and never more than three', ocrPrepSize(64), 3);
ok('a six-core machine gives the engine its three and prep two', ocrPrepSize(6), 2);
ok('a four-core machine, where the engine already has three, gives prep one', ocrPrepSize(4), 1);
ok('an eight-core machine gives prep three', ocrPrepSize(8), 3);
ok('prep never drops to none, however tight the machine', ocrPrepSize(2), 1);
ok('an unknown core count assumes a phone, not a desktop', ocrPrepSize(undefined), 1);
ok('engine and prep together still leave a desktop the app a core',
  ocrPoolSize(12) + ocrPrepSize(12) <= 11, true);

// The box is decided in one place because every word the engine reports is mapped
// back through it: get the working size wrong and every coordinate on the sheet
// slides by the difference. These are the values the reader has always used (the
// 12 MP working budget), so a drift here is a drift in what the engine is shown.
const stripMid = ocrStripBox(4000, 3000, [0, 0.5]);
ok('a 12 MP photo read as a half-height strip', stripMid,
  { sx: 0, sy: 0, sw: 4000, sh: 1500, w: 5657, h: 2121, scale: Math.SQRT2, radius: 74 });
ok('the strip below it is the same working image, one strip lower',
  [ocrStripBox(4000, 3000, [0.5, 1]).sy, ocrStripBox(4000, 3000, [0.5, 1]).sh, ocrStripBox(4000, 3000, [0.5, 1]).w],
  [1500, 1500, 5657]);
ok('and so is the middle overlap, so the three strips share one resolution',
  ocrStripBox(4000, 3000, [0.25, 0.75]).w, stripMid.w);
ok('a small photo is upscaled to the 3\u00d7 ceiling, not past it',
  { w: ocrStripBox(800, 600, [0, 0.5]).w, h: ocrStripBox(800, 600, [0, 0.5]).h, scale: ocrStripBox(800, 600, [0, 0.5]).scale, radius: ocrStripBox(800, 600, [0, 0.5]).radius },
  { w: 2400, h: 900, scale: 3, radius: 32 });
ok('a strip the geometry cut short still gets a glyph window',
  [ocrStripBox(4000, 3000, [0.98, 1]).sh, ocrStripBox(4000, 3000, [0.98, 1]).radius], [60, 10]);
ok('a portrait sheet is scaled to the same budget',
  [ocrStripBox(3000, 6000, [0, 0.5]).w, ocrStripBox(3000, 6000, [0, 0.5]).h, ocrStripBox(3000, 6000, [0, 0.5]).radius],
  [3464, 3464, 121]);
ok('a 12 MP page is read at its own size', ocrPageBox(4000, 3000),
  { sx: 0, sy: 0, sw: 4000, sh: 3000, w: 4000, h: 3000, scale: 1, radius: 80 });
ok('a small page is upscaled to the ceiling',
  [ocrPageBox(800, 600).w, ocrPageBox(800, 600).h, ocrPageBox(800, 600).radius], [2400, 1800, 48]);
ok('a page past the budget is downscaled, never past half size',
  [ocrPageBox(6000, 4000).w, ocrPageBox(6000, 4000).h, ocrPageBox(6000, 4000).radius], [4243, 2828, 85]);
ok('the reader and its worker mean the same thing by a job',
  /'binarise'/.test(readFileSync(new URL('../ocr-prep-worker.js', import.meta.url), 'utf8')), true);

// The two views on a plain buffer — no canvas, which is the point of the worker
// shape: the threshold and the encode are the half of a read that left the
// reader's thread, and this is the function both halves call.
const imageData = (w, h, fill) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = fill(i % w, Math.floor(i / w));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return { data: d, width: w, height: h };
};
{
  // A photo shot in shade: paper at 200, ink at 64, and the stretch is what makes
  // it readable — its own percentiles decide, not a fixed level.
  const img = imageData(8, 32, (x, y) => (y % 2 ? 200 : 64));
  ok('a low-contrast image is stretched', ocrStretchData(img, 'stretch'), 'stretch');
  ok('its ink reaches full black', img.data[(0 * 8 + 0) * 4], 0);
  ok('and its paper full white', img.data[(1 * 8 + 0) * 4], 255);
  // Paper already white: stretching would only amplify the JPEG's ringing around
  // every stroke, which a thin-stroke page has to survive.
  const exposed = imageData(8, 8, () => 240);
  ok('a photo that is already exposed is left alone', ocrStretchData(exposed, 'stretch'), 'stretch');
  ok('and none of its pixels move', exposed.data[0], 240);
  ok('nothing to read is not a crash', ocrStretchData({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 'ink'), 'stretch');
  // The local threshold: paper and ink only, whatever the paper level was.
  const cell = imageData(64, 48, x => (x % 8 < 2 ? 40 : 190));
  ok('the local threshold binarises what it is given', ocrStretchData(cell, 'ink', 20), 'ink');
  ok('a thresholded read is ink and paper and nothing between',
    [...new Set([...cell.data.filter((_, i) => i % 4 === 0)])].sort((a, b) => a - b).join(), '0,255');
  ok('a stroke reads as ink', cell.data[(20 * 64 + 32) * 4], 0);
  ok('and the bare paper beside it reads as paper', cell.data[(20 * 64 + 4) * 4], 255);
}

// The round trip to a prep worker: one reply per job, matched by id (a batch asks
// for three strips at once, and they do not come back in the order they went out),
// a job-level failure that is that job's, and no read ever left waiting on a worker
// that has died — a scan that hangs is worse than one that fails with a reason.
function fakePrep() {
  const worker = { onmessage: null, onerror: null, posted: [], stopped: false, terminate() { worker.stopped = true; } };
  worker.postMessage = (message, transfer) => worker.posted.push({ message, transfer });
  return {
    worker,
    reply: data => worker.onmessage({ data }),
    die: message => worker.onerror({ message }),
  };
}
const prepFailed = e => String(e && e.message);
{
  const fake = fakePrep();
  const prep = createOcrPrepWorker(() => fake.worker);
  const blob = { size: 4096 };
  const readA = prep.post({ type: 'binarise', view: 'stretch' }, ['a-transfer']);
  const readB = prep.post({ type: 'binarise', w: 400 });
  ok('a posted job carries its own id', fake.worker.posted.map(p => p.message.id).join(), '1,2');
  ok('and the pixels are handed over, not copied', fake.worker.posted[0].transfer, ['a-transfer']);
  ok('both jobs are still waiting for an answer', fake.worker.posted.length, 2);
  // Answered out of order, on purpose: the second job's blob must not land in the
  // first read's hands.
  fake.reply({ id: 2, ok: true, blob: { size: 2 } });
  fake.reply({ id: 1, ok: true, blob });
  ok('a read gets its own answer when the batch comes back out of order',
    [(await readA).blob, (await readB).blob], [blob, { size: 2 }]);
  fake.reply({ id: 99, ok: true, blob });  // a reply nobody is waiting for
  const bad = prep.post({ type: 'binarise' });
  fake.reply({ id: 3, ok: false, error: 'a crop the worker could not draw' });
  ok('a job the worker could not do fails with its reason', await bad.then(() => 'resolved', prepFailed),
    'a crop the worker could not draw');
  const stillWorks = prep.post({ type: 'binarise' });
  fake.reply({ id: 4, ok: true, blob });
  ok('a job that failed is that job\u2019s failure, not the worker\u2019s', (await stillWorks).ok, true);

  const parked = prep.post({ type: 'binarise' });
  fake.die('the worker\u2019s script did not load');
  ok('a worker that dies fails the read waiting on it', await parked.then(() => 'resolved', prepFailed),
    'the worker\u2019s script did not load');
  ok('and the next read is not parked behind a dead worker',
    await prep.post({ type: 'binarise' }).then(() => 'resolved', prepFailed), 'the worker\u2019s script did not load');
}
{
  const fake = fakePrep();
  const prep = createOcrPrepWorker(() => fake.worker);
  const parked = prep.post({ type: 'binarise' });
  prep.terminate();
  ok('closing the pool fails the reads still waiting on it',
    await parked.then(() => 'resolved', prepFailed), 'The prep worker was closed.');
  ok('and the worker is actually terminated', fake.worker.stopped, true);
  ok('a read asked for after the scan is closed fails rather than hanging',
    await prep.post({ type: 'binarise' }).then(() => 'resolved', prepFailed), 'The prep worker was closed.');
}

// ---------- report ----------
if (fails.length) {
  console.error(`test-tesco: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error('  ✗ ' + f.replace(/^/, '').replace(/\n     /g, '\n     '));
  process.exit(1);
}
console.log(`test-tesco: OK — ${pass} assertions passed (engine matches the workbook's cached values)`);
