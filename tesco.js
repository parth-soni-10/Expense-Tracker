/* ============================================================
   tesco.js — Tesco Pay: the shift records, the workbook import,
   quick entry and the #tesco screen.

   Recreates the Tesco Pay.xlsx model:
     * Shifts — date + start + end in, everything else derived:
       paid hours (graduated break deduction), Sunday = special
       rate (×1.5), Sunday→Saturday pay week, pay lands +11 days
       (the sheet's `L = Week Start Date + 11`, i.e. a Thursday).
     * Tax sim (the spreadsheet's "Potential Tax" LET formula):
       PAYE (20% to €846.15/wk, 40% above, −€76.93 credit),
       USC (0.5/2/3/8% bands), PRSI (4.35%; EXEMPT at €352/wk or less,
       with the €12 credit tapering away by €424),
       pension/Future Fund 1.5% of gross.
     * Payslips — the "Total tax paid" table: PAYE / USC / PRSI /
       Future Fund per pay week, negatives = Revenue refunds,
       per-component lifetime totals.

   A roster arrives by Quick entry, the shift form or the workbook
   import; there is no photo path, and none may come back
   (scripts/check-image-hygiene.mjs). The word-list parser that read a
   photographed grid was deleted with the reader it served: it had no
   caller left, and its rules are recorded in docs/PROGRESS.md batch 34.
   ============================================================ */

import { uid, downloadText } from './storage.js';
// One CSV field rule for the whole app: this file writes the workbook out and
// reads it back, and storage.js writes the entries export with the same rule —
// so it lives in csv.js rather than in two places free to disagree. The
// apostrophe guard in it is what stops a note being read as a formula.
import { csvCell, csvUnquote, csvDocument, csvRows, csvDate } from './csv.js';

// ---------- the pay engine lives in tesco-pay.js ----------
// Rates, paid hours, the Sunday premium, the tax simulation and the week/month
// roll-ups are one module, and the app shell imports IT rather than this file —
// which is what lets #tesco (this file: the workbook importer, quick entry and
// the screen) be fetched on first visit instead of on
// boot. Every name is re-exported below so the harnesses and the screen, which
// have always imported them from here, keep resolving them.
import {
  TESCO_RATE_DEFAULTS, PAY_LAG_DAYS,
  r2, pad2, isoLocal, todayIso, parseHM, fmtHM, isoToUtcMidnight, dateOk,
  paidHours, isOvernight, isSunday, statedHours, shiftPay, simulateTax,
  weekStartOf, payDateOf, weekNumberOf, payslipWeekNumberOf, isoWeekNumber,
  nextWeekStart, buildPayWeeks, weekBankWrite, monthSummary, lifetimeTotals, payslipTotal,
  weekVsEstimate, receivedByPayDate, tescoPayLedgerWrites, tescoPayWriteWindow, TESCO_PAY_METHOD,
  HOLIDAY_ACCRUAL_PCT, HOLIDAY_DEFAULT, holidayBalance,
} from './tesco-pay.js';
export {
  TESCO_RATE_DEFAULTS, r2, pad2, isoLocal, todayIso, parseHM, fmtHM, isoToUtcMidnight, dateOk,
  paidHours, isOvernight, isSunday, statedHours, shiftPay, simulateTax,
  weekStartOf, payDateOf, weekNumberOf, payslipWeekNumberOf, isoWeekNumber,
  nextWeekStart, buildPayWeeks, weekBankWrite, monthSummary, lifetimeTotals, payslipTotal,
  weekVsEstimate, receivedByPayDate, tescoPayLedgerWrites, tescoPayWriteWindow, TESCO_PAY_METHOD,
  HOLIDAY_ACCRUAL_PCT, HOLIDAY_DEFAULT, holidayBalance,
};


// ---------- CSV: the workbook's own table, round-trippable ----------
// Column for column the reference document's Data sheet (B..Q): one row per
// shift, newest first, and each week's figures on that week's first row — the
// Sunday row in the sheet, because the sheet's weeks run Sun → Sat.
export const TESCO_CSV_HEADER = Object.freeze([
  'Date', 'Effective Date', 'Week', 'Day', 'Start Time', 'End Time', 'Hours',
  'Normal or Special', 'Total', 'Received?', 'Gross Income', 'Potential Tax',
  'Pension', 'Calculated Income', 'Final Bank Pay', 'Description',
]);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The sheet keeps its actual tax figures in a second table (the Summary's
// "Total tax paid" block), so the file carries one too: the shift table above,
// the tax table below it.
// These are the sheet's own columns for that table — the pay week's number and
// the row's total included, so every cell of the sheet's table is in the file.
// Final Bank Pay is not one of them: the sheet carries the week's net on that
// week's own shift row (column 15 above). A file that keeps a bank column here
// anyway (this app exported one for a while) still imports: read by name.
export const TESCO_CSV_PAYSLIP_HEADER = Object.freeze(['Week Start Date', 'Pay Date', 'Week', 'PAYE', 'USC', 'PRSI', 'Future Fund', 'Total']);

// csvCell()/csvUnquote()/csvDocument() — the field rule and the document
// assembler — live in csv.js, shared with storage.js's entries export.
//
// Two decimals, so Excel reads the column as numbers rather than text.
function csvNum(v) { return v == null || v === '' ? '' : r2(v).toFixed(2); }

export function tescoCsv(shifts, payslips, rates, weekNos) {
  const weeks = new Map(buildPayWeeks(shifts, payslips, rates).map(w => [w.weekStart, w]));
  // Which shift row carries a week's figures: the week's first row by date, so
  // the Sunday when one was worked and a plain week still exports its totals
  // instead of dropping them.
  const carrier = new Map();
  for (const s of shifts) {
    const ws = weekStartOf(s.date);
    if (!carrier.has(ws) || s.date < carrier.get(ws)) carrier.set(ws, s.date);
  }
  const rows = [TESCO_CSV_HEADER];
  for (const s of shifts.slice().sort((a, b) => b.date.localeCompare(a.date) || String(b.start).localeCompare(String(a.start)))) {
    const p = shiftPay(s, rates);
    const ws = weekStartOf(s.date);
    const w = weeks.get(ws);
    const row = [
      // The pay week's own number, from its start — the whole Sun → Sat block
      // shares one, the way the sheet's Week column groups a week.
      s.date, s.date, weekNumberOf(ws, weekNos), DAY_NAMES[isoToUtcMidnight(s.date).getUTCDay()],
      s.start, s.end, csvNum(p ? p.hours : ''), p && p.special ? 'Special' : 'Normal',
      csvNum(p ? p.gross : ''),
      // The app's record that the pay landed is the week's payslip.
      w && w.payslip ? 'Yes' : '',
    ];
    if (w && carrier.get(ws) === s.date) {
      const sim = simulateTax(w.gross, rates);
      row.push(csvNum(w.gross), csvNum(sim.tax), csvNum(sim.pension), csvNum(sim.net),
        // The sheet's Final Bank Pay is typed from a bank statement, so only a
        // figure that was actually recorded is written. Exporting a derived
        // gross − tax there would come back on the next import looking like a
        // figure the bank confirmed.
        w.bankPaid != null ? csvNum(w.bankPaid) : '');
    } else {
      row.push('', '', '', '', '');
    }
    row.push(s.note || '');
    rows.push(row);
  }
  const slips = (payslips || []).slice().sort((a, b) => weekStartOf(a.weekStart).localeCompare(weekStartOf(b.weekStart)));
  if (slips.length) {
    rows.push([], TESCO_CSV_PAYSLIP_HEADER);
    for (const p of slips) {
      // The date the sheet typed for this row, not the snapped Sunday: a second
      // pay run inside the same Sun → Sat week keeps its own date, the way the
      // sheet's tax table holds two rows for it. The engine still groups (and
      // derives the pay date) by the week's Sunday.
      const ws = weekStartOf(p.weekStart);
      const rowWeek = p.weekNo != null ? p.weekNo : weekNumberOf(ws, weekNos);
      rows.push([p.weekStart, payDateOf(ws), rowWeek, csvNum(p.paye), csvNum(p.usc), csvNum(p.prsi), csvNum(p.futureFund), csvNum(payslipTotal(p))]);
    }
  }
  return csvDocument(rows);
}

// The row splitter and the date reader live in csv.js — the read side of the
// one field rule, shared with storage.js's entries import. Times still arrive
// as HH:MM(:SS) or as the bare day fraction Excel stores.
/** A numeric cell, or null when it holds no number at all (0 stays 0). */
function csvNumber(raw) {
  const s = String(raw == null ? '' : raw).replace(/[^\d.-]/g, '');
  if (s === '' || !Number.isFinite(Number(s))) return null;
  return Number(s);
}

function csvTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m) return (+m[1] > 23 || +m[2] > 59) ? null : fmtHM(+m[1] * 60 + +m[2]);
  if (/^0?\.\d+$/.test(s)) {
    const mins = Math.round(Number(s) * 1440);
    return mins < 1440 ? fmtHM(mins) : null;
  }
  return null;
}

// Reads back anything this engine exports plus a plain Excel "Save as CSV" of
// the sheet. Columns are matched by header name, so reordering, extra columns
// and the sheet's empty leading column all work. Hours, gross, tax and pension
// are derived from the times and the rate card, never trusted from the file —
// but Final Bank Pay is: the sheet types it off a bank statement, and holiday
// pay, a refund or a correction are all reasons it disagrees with gross − tax,
// so it is carried through rather than recomputed away.
export function parseTescoCsv(text) {
  const rows = csvRows(String(text || ''));
  const norm = r => r.map(h => String(h).trim().toLowerCase());
  // Each table's header is found by name rather than assumed to be a given line,
  // so a title row, a blank line or the sheet's own empty column A changes
  // nothing — and the shift table may sit above a tax table.
  const findHead = want => rows.findIndex(r => { const h = norm(r); return want.every(n => h.includes(n)); });
  const at = (head, ...names) => names.reduce((hit, n) => (hit >= 0 ? hit : head.indexOf(n)), -1);

  const shiftHead = findHead(['date', 'start time', 'end time']);
  const slipHead = findHead(['week start date', 'paye']);
  if (shiftHead < 0 && slipHead < 0)
    return { shifts: [], payslips: [], weekNos: {}, skipped: 0, error: 'That file needs Date, Start Time and End Time columns.' };

  const shifts = [];
  const weekNos = {};
  // A week's net from the shift table's Final Bank Pay column, by week start.
  const weekBank = new Map();
  let skipped = 0;
  if (shiftHead >= 0) {
    const head = norm(rows[shiftHead]);
    const iDate = at(head, 'date', 'effective date'), iStart = at(head, 'start time'), iEnd = at(head, 'end time');
    const iSpecial = at(head, 'normal or special', 'type'), iNote = at(head, 'description', 'note');
    // The row's own hours and pay, kept on the row (see shiftPay): the sheet's
    // older rows were worked at rates that have since changed, and two rows book
    // a full week off with hours and no clock times.
    const iHours = at(head, 'hours');
    const iTotal = at(head, 'total');
    // The sheet's Final Bank Pay, read here and put on the week's payslip below
    // — the sheet keeps a week's net on that week's own shift row, and the tax
    // table has no column for it.
    const iBank = at(head, 'final bank pay', 'net paid');
    // The file's own week number, so a sheet's hand-typed count comes across
    // with the shifts instead of being replaced by the ISO number.
    const iWeekNo = at(head, 'week');
    // Stop at the tax table so its rows are never read as shifts.
    const end = slipHead > shiftHead ? slipHead : rows.length;
    for (const r of rows.slice(shiftHead + 1, end)) {
      const date = csvDate(r[iDate]), start = csvTime(r[iStart]), end = csvTime(r[iEnd]);
      const stated = iHours < 0 ? null : csvNumber(r[iHours]);
      const paid = iTotal < 0 ? null : csvNumber(r[iTotal]);
      const banked = iBank < 0 ? null : csvNumber(r[iBank]);
      if (!date || !dateOk(date)) { skipped++; continue; }
      // No times at all is only unusable when the row states no hours either —
      // a "full week off" row has no times but does have its hours, and dropping
      // it silently lost the row and the week's bank pay with it.
      if ((start == null || end == null) && stated == null) { skipped++; continue; }
      shifts.push({
        date, start, end,
        ...(stated == null ? {} : { hours: stated }),
        ...(paid == null ? {} : { gross: paid }),
        // The row's own net, which the week's figure is read off below. Kept on
        // the row as well: the sheet types it there, and a week whose figures sit
        // on a row with no payslip of its own would otherwise lose the figure.
        ...(banked == null ? {} : { bankPay: banked }),
        // "Special" and the sheet's "BH" for a bank holiday both mean the
        // premium rate; anything else (blank included) is a normal shift.
        special: /^(s|bh)/i.test(String(r[iSpecial] == null ? '' : r[iSpecial]).trim()),
        note: iNote < 0 ? '' : csvUnquote(String(r[iNote] == null ? '' : r[iNote]).trim()).slice(0, 120),
      });
      const no = iWeekNo < 0 ? 0 : Math.trunc(Number(String(r[iWeekNo] == null ? '' : r[iWeekNo]).trim()));
      if (Number.isFinite(no) && no >= 1 && no <= 53) weekNos[weekStartOf(date)] = no;
      if (banked != null) weekBank.set(weekStartOf(date), banked);
    }
  }

  const payslips = [];
  if (slipHead >= 0) {
    const head = norm(rows[slipHead]);
    const iWeek = at(head, 'week start date', 'week start', 'date');
    const iPaye = at(head, 'paye'), iUsc = at(head, 'usc'), iPrsi = at(head, 'prsi'), iFund = at(head, 'future fund');
    const iBank = at(head, 'final bank pay', 'net paid');
    // The sheet's own Week count, kept per row. Deriving it from the date put a
    // different number on a couple of rows than the sheet shows, which is
    // exactly the kind of missing value this file is checked for.
    const iWeekNo = at(head, 'week');
    // One payslip per row, not per week: the sheet's tax table holds two rows
    // when a week had two pay runs (a correction, say), and folding them into
    // one lost a row from the file's own round trip. The engine still adds
    // them up for a week's total (buildPayWeeks).
    const seen = new Set();
    for (const r of rows.slice(slipHead + 1)) {
      const ws = csvDate(r[iWeek]);
      if (!ws || !dateOk(ws)) { skipped++; continue; }
      const cell = i => i < 0 ? 0 : (Number(String(r[i] == null ? '' : r[i]).replace(/[^\d.-]/g, '')) || 0);
      // The row's own date, not the week's Sunday: the sheet's tax table holds
      // two rows for one week when it had two pay runs (a correction, say), and
      // snapping both to the Sunday merged them, losing a row's figures.
      // buildPayWeeks snaps it for grouping, so the week still adds up.
      const draft = { weekStart: ws, paye: cell(iPaye), usc: cell(iUsc), prsi: cell(iPrsi), futureFund: cell(iFund) };
      if (iWeekNo >= 0) {
        const no = csvNumber(r[iWeekNo]);
        if (no != null && no >= 1 && no <= 53) draft.weekNo = no;
      }
      // The net that reached the bank. A blank cell stays "not known" so the
      // week keeps falling back to gross − tax.
      if (iBank >= 0) {
        const raw = String(r[iBank] == null ? '' : r[iBank]).replace(/[^\d.-]/g, '');
        const n = Number(raw);
        if (raw !== '' && Number.isFinite(n)) draft.bankPay = n;
      }
      // Re-importing the same file must not double a run, so an identical row
      // is skipped rather than appended.
      const key = JSON.stringify(draft);
      if (seen.has(key)) continue;
      seen.add(key);
      payslips.push(draft);
    }
    // A week's net lands on one of its payslips — the week's figure is the
    // week's, and buildPayWeeks adds a week's payslips up, so carrying it once
    // keeps that total right. A run that recorded its own net keeps its own.
    const carried = new Set();
    for (const p of payslips) {
      const ws = weekStartOf(p.weekStart);
      if (p.bankPay != null || carried.has(ws) || !weekBank.has(ws)) continue;
      p.bankPay = weekBank.get(ws);
      carried.add(ws);
    }
  }
  return { shifts, payslips, weekNos, skipped, error: null };
}

// ---------- import: a workbook (.xlsx), read as the sheet's own two tables ----------
// The reference document is a workbook, and until now the only way in was to save a
// CSV out of Excel if you prefer, and hand that over. SheetJS reads
// the file itself — and this is the whole of the new importer: the two sheets' cells
// are written back out as the very CSV text `parseTescoCsv` already reads, so every
// rule about headers, aliases, dates, times, hours and round-trips stays in one
// place, pinned by one harness, instead of a second importer free to disagree with
// the first.
//
// Dates are read as the SERIAL NUMBERS Excel stores, not as Date objects: `csvDate`
// does Excel's 1899-12-30 arithmetic in UTC (TZ-free), while SheetJS's date objects
// are built in local time and land on the day before in a negative-offset zone. A
// time cell needs no handling either — it is a fraction of a day, which `csvTime`
// already reads.
/** One sheet's rows — arrays of cells, as SheetJS hands them over — as CSV text. */
export function sheetRowsToCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map(row => {
    const cells = Array.isArray(row) ? row : [row];
    return cells.map(cell => csvCell(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell)).join(',');
  }).join('\n');
}
/** Does this sheet hold the shift table? Judged by the same three header names the
 *  shift parser looks for, so the sheet this picks is the sheet that will be read. */
function sheetHasShiftHeader(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 10).some(row => {
    const h = (Array.isArray(row) ? row : []).map(c => String(c == null ? '' : c).trim().toLowerCase());
    return h.includes('date') && h.includes('start time') && h.includes('end time');
  });
}
/**
 * A workbook's sheets as one CSV document: the shift table first, then whatever else
 * the file holds (the tax table), a blank line between them.
 *
 * The order is the point. `parseTescoCsv` reads each table by finding its header, and
 * it stops the shift table at the tax table's header — so a workbook that keeps the
 * tax table above the shifts (any order Excel was happy to save) would hide every
 * shift behind it. Putting the shift sheet first is done here rather than by asking
 * the user to reorder their sheets.
 */
export function workbookToCsv(sheets) {
  const list = (Array.isArray(sheets) ? sheets : [])
    .filter(s => s && Array.isArray(s.rows) && s.rows.length);
  if (!list.length) return '';
  const shiftSheet = list.find(s => sheetHasShiftHeader(s.rows));
  const ordered = shiftSheet ? [shiftSheet, ...list.filter(s => s !== shiftSheet)] : list;
  return ordered.map(s => sheetRowsToCsv(s.rows)).join('\n\n');
}

// ---------- import: what a parsed row becomes once it is stored ----------
// Shared by the CSV import and the tab's own add path, so the two can never
// drift and the rules are testable. Both keep a row's own hours and pay (see
// shiftPay), and neither drops a row that has no clock times — the sheet books
// a week off that way, and dropping it also lost the week's bank pay.
export function storedShift(s, id, at) {
  if (!dateOk(s.date)) return null;
  const start = parseHM(s.start), end = parseHM(s.end);
  const hours = statedHours(s.hours);
  if ((start == null || end == null) && hours == null) return null;
  const money = v => (v == null || !Number.isFinite(Number(v)) ? null : r2(v));
  const gross = money(s.gross), bankPay = money(s.bankPay);
  return {
    id, date: s.date,
    start: start == null ? '' : fmtHM(start),
    end: end == null ? '' : fmtHM(end),
    ...(hours == null ? {} : { hours }),
    ...(gross == null ? {} : { gross }),
    ...(bankPay == null ? {} : { bankPay }),
    note: String(s.note || '').slice(0, 120),
    special: !!s.special,
    createdAt: at,
  };
}

// ---------- the Week off card's row ----------
/**
 * A booked week off: what the card asks for — any date in the week, and the hours
 * of pay — turned into the row that gets stored.
 *
 * The row is dated on the week's own Sunday rather than on the day that was
 * picked. A pay week runs Sunday → Saturday (WEEK_START_DOW), so the Sunday is the
 * date that says which week this is, and the week card reads a row's date back as
 * its weekday: "Sun 27 Sep · week off 7h". The shape is the sheet's own week-off
 * rows and what the quick entry writes for `week off 7h` — hours, no clock times,
 * the same note — so a week off added here exports, imports and merges exactly
 * like one that arrived in a file.
 *
 * Hours are `statedHours`' bounds (up to 168) with zero excluded: a week off worth
 * nothing is a mistyped week off. Returns `{ ok: true, shift }` or
 * `{ ok: false, field, error }`, the shape applyShiftEdit answers in, so the card
 * can name the field it is complaining about and the harness can pin every rule
 * without a DOM.
 */
export function weekOffShift(date, hours) {
  const raw = String(date == null ? '' : date).trim();
  if (!dateOk(raw)) return { ok: false, field: 'date', error: 'Pick a date in the week you were off.' };
  const n = statedHours(String(hours == null ? '' : hours).trim());
  if (n == null || !(n > 0)) {
    return { ok: false, field: 'hours', error: 'Hours of pay should be more than 0 and up to 168.' };
  }
  return { ok: true, shift: { date: weekStartOf(raw), start: '', end: '', hours: n, note: 'week off', special: false } };
}

// ---------- editing: what a hand edit may change on a stored shift ----------
// One shift's fields, validated by the same rules `storedShift` applies to a
// row arriving from a file — the two must agree, or a hand edit could write a
// row the importer would have refused. Returns `{ ok: true, shift }` or
// `{ ok: false, field, error }`, so the edit sheet can point at the field that
// is wrong and the harness can pin every rule without a DOM.
//
// `others` holds the rest of the tab's shifts as `date|start|end` keys, the same
// key `freshShifts` dedupes on: editing a row onto another row's day and times
// is refused for the same reason an import of it would be.
//
// The row keeps its id and createdAt. Sync unions shifts by id, so minting a new
// id here would resurrect the old row from the other device on the next merge.
export function applyShiftEdit(shift, fields, others = []) {
  const base = shift && typeof shift === 'object' ? shift : {};
  const f = fields && typeof fields === 'object' ? fields : {};
  const pick = key => (key in f ? f[key] : base[key]);

  const date = String(pick('date') ?? '').trim();
  if (!dateOk(date)) return { ok: false, field: 'date', error: 'Enter the date as YYYY-MM-DD.' };

  const rawStart = String(pick('start') ?? '').trim();
  const rawEnd = String(pick('end') ?? '').trim();
  const start = rawStart ? parseHM(rawStart) : null;
  const end = rawEnd ? parseHM(rawEnd) : null;
  if (rawStart && start == null) return { ok: false, field: 'start', error: 'Start time should read like 08:00.' };
  if (rawEnd && end == null) return { ok: false, field: 'end', error: 'End time should read like 16:00.' };

  // Blank means "not stated", which is a real state: a booked week off has
  // hours and no clock times, and an imported row's hours are its own.
  const rawHours = pick('hours');
  const blankHours = rawHours === '' || rawHours == null;
  const hours = blankHours ? null : statedHours(rawHours);
  if (!blankHours && hours == null) return { ok: false, field: 'hours', error: 'Hours should be a number between 0 and 168.' };

  const hasTimes = start != null && end != null;
  if (!hasTimes && hours == null) {
    return { ok: false, field: start == null ? 'start' : 'end', error: 'Add both clock times, or state the hours for a week off.' };
  }

  // A row's own pay wins over hours × rate (see shiftPay), which is how the
  // sheet's older rates survive an import. The same rule means fixing the times
  // of such a row would leave its old figure silently in place, so a stated pay
  // is editable here — blank it to go back to hours × rate.
  const rawGross = pick('gross');
  const blankGross = rawGross === '' || rawGross == null;
  let gross = null;
  if (!blankGross) {
    const n = Number(rawGross);
    if (!Number.isFinite(n) || n < 0) return { ok: false, field: 'gross', error: 'Pay should be a number €0 or more, or blank to use hours × rate.' };
    gross = r2(n);
  }

  const next = {
    ...base,
    date,
    start: start == null ? '' : fmtHM(start),
    end: end == null ? '' : fmtHM(end),
    note: String(pick('note') ?? '').slice(0, 120).trim(),
    special: !!pick('special'),
  };
  // Blanking a field has to remove the key, not just omit it from the spread:
  // an inherited `hours` would keep out-ranking the clock times in shiftPay.
  if (hours == null) delete next.hours; else next.hours = hours;
  if (gross == null) delete next.gross; else next.gross = gross;

  const key = `${next.date}|${next.start}|${next.end}`;
  if (others.includes(key)) return { ok: false, field: 'date', error: 'Another shift on that day already covers the same times.' };
  return { ok: true, shift: next };
}

// The row's own date and week number, not the snapped Sunday: the sheet's tax
// table holds two rows for a week that had two pay runs, and keying by the week
// merged them. buildPayWeeks snaps the date for grouping, so the week still adds
// up — while the export writes back the date the sheet actually holds.
export function storedPayslip(p, id, at) {
  const no = Math.trunc(Number(p.weekNo));
  const bank = p.bankPay == null || !Number.isFinite(Number(p.bankPay)) ? null : r2(p.bankPay);
  return {
    id, weekStart: p.weekStart,
    paye: +p.paye || 0, usc: +p.usc || 0, prsi: +p.prsi || 0, futureFund: +p.futureFund || 0,
    ...(no >= 1 && no <= 53 ? { weekNo: no } : {}),
    ...(bank == null ? {} : { bankPay: bank }),
    createdAt: at,
  };
}

// ---------- quick entry: a shift typed as a sentence ----------
// The Tesco tab's quick entry: one shift per line, written the way the shift is
// remembered rather than the way a form wants it — "mon 8-4 stock take",
// "yesterday 12:30-20:15", "fri 20:00-01:00", "week off 7h". Pure text → rows,
// so the harness can pin the grammar the way it pins the spreadsheet's
// arithmetic, and the card can show exactly what it is about to add.
//
// Two decisions carry the grammar, and both are about not guessing:
//
//   1. A full date is taken out of the line first, then the time range. "13-09"
//      is indistinguishable from a shift running 13:00 → 09:00, so a dashed
//      date must carry its year ("13-09-2026") and a partial date is written
//      with slashes or dots ("13/09"). Paying a day at the wrong time is worse
//      than asking for a clearer line, so an unclear one is asked about.
//   2. A range with no am/pm is read as a 12-hour clock when that lands the end
//      after the start ("8-4" is 08:00 → 16:00) and as an overnight shift when
//      it cannot ("20-1" is 20:00 → 01:00). One unambiguous half of the day
//      ("8am-4", "4-9pm") teaches the other half which half it means.
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// One end of a time range: 8, 08:30, 8.30, 0800, 1630, noon, midnight, 4pm.
// Longest numeric form first: '1630' must read as 16:30 rather than as the hour
// 16 followed by a stray '30' left behind in the note.
const TIME_ATOM = "(\\d{3,4}|\\d{1,2}(?:[:.]\\d{2})?|noon|midday|midnight)\\s*(a\\.?m\\.?|p\\.?m\\.?)?";
const TIME_RANGE_RE = new RegExp(`${TIME_ATOM}\\s*(?:-|–|—|to|until|till)\\s*${TIME_ATOM}`, 'gi');
const HOURS_RE = /\b(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:h|hr|hrs|hours)\b/i;
const SPECIAL_RE = /\b(special|bh|bank\s*holiday|double\s*time|time\s*and\s*a\s*half)\b/i;
const WEEKDAY_RE = /\b(last|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)\b/i;
const NAMED_DAY_RE = /\b(today|tonight|yesterday|yday)\b/i;
const SPELLED_DAY_FIRST = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/i;
const SPELLED_MONTH_FIRST = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const SHORT_DATE_RE = /\b(\d{1,2})[/.]\s?(\d{1,2})\b/;

function isoFromParts(year, month, day) {
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return dateOk(iso) ? iso : null;
}

function isoAddDays(iso, days) {
  const d = isoToUtcMidnight(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Day-first is the sheet's own order, so it is the default; a part over 12 can
// only be the day, which settles the other way round without being asked.
function dayMonth(first, second) {
  return first > 12 || second > 12 ? { day: Math.max(first, second), month: Math.min(first, second) }
    : { day: first, month: second };
}

/** A date that names its own year, so nothing about it can be read as a time
 *  range: the ISO form, and any three-part form whose last part is four digits.
 *  Taken out of the line before the range is looked for. */
function readDatedYear(text, today) {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return { matched: iso[0], iso: isoFromParts(+iso[1], +iso[2], +iso[3]), token: iso[0] };
  const full = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(text);
  if (full) {
    const { day, month } = dayMonth(+full[1], +full[2]);
    return { matched: full[0], iso: isoFromParts(+full[3], month, day), token: full[0] };
  }
  return null;
}

/** The date a line names, with the text that named it (so it can be taken out
 *  of the line) and the token to report when something date-shaped is not a
 *  date. Called once the time range has been lifted out, which is what makes a
 *  dashed partial date ("13-09") safe to read here. */
function readShiftDate(text, today) {
  const year = /\b(20\d{2})\b/.exec(text);
  const dated = readDatedYear(text, today);
  if (dated) return dated;
  const dashed = /(\d{1,2})[.-](\d{1,2})[.-](\d{2,4})/.exec(text);
  if (dashed) {
    const { day, month } = dayMonth(+dashed[1], +dashed[2]);
    const yy = +dashed[3];
    return { matched: dashed[0], iso: isoFromParts(yy < 100 ? 2000 + yy : yy, month, day), token: dashed[0] };
  }
  const slash = SHORT_DATE_RE.exec(text);
  if (slash) {
    const { day, month } = dayMonth(+slash[1], +slash[2]);
    const y = year ? +year[1] : new Date(`${today}T00:00:00Z`).getUTCFullYear();
    return { matched: slash[0], iso: isoFromParts(y, month, day), token: slash[0] };
  }
  const named = NAMED_DAY_RE.exec(text);
  if (named) {
    const word = named[1].toLowerCase();
    return { matched: named[0], iso: isoAddDays(today, word === 'yesterday' || word === 'yday' ? -1 : 0) };
  }
  for (const [pattern, monthAt] of [[SPELLED_DAY_FIRST, 2], [SPELLED_MONTH_FIRST, 1]]) {
    const m = pattern.exec(text);
    if (!m) continue;
    const month = MONTH_INDEX[m[monthAt].slice(0, 3).toLowerCase()];
    if (!month) continue;
    const day = +(monthAt === 2 ? m[1] : m[2]);
    const y = year ? +year[1] : new Date(`${today}T00:00:00Z`).getUTCFullYear();
    return { matched: m[0], iso: isoFromParts(y, month, day), token: m[0] };
  }
  const weekday = WEEKDAY_RE.exec(text);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[2].slice(0, 3).toLowerCase()];
    const from = isoToUtcMidnight(today).getUTCDay();
    const relative = (weekday[1] || '').toLowerCase();
    // A weekday on its own is the one just gone (or today); "last" skips today,
    // "next" reaches forwards.
    if (relative === 'next') return { matched: weekday[0], iso: isoAddDays(today, ((target - from + 7) % 7) || 7) };
    let back = (from - target + 7) % 7;
    if (relative === 'last' && back === 0) back = 7;
    return { matched: weekday[0], iso: isoAddDays(today, -back) };
  }
  return null;
}

/** Minutes past midnight for one end of a range, or null when it is not a time. */
function clockMinutes(token, meridiem) {
  if (!token) return null;
  const word = token.toLowerCase();
  if (word === 'noon' || word === 'midday') return 12 * 60;
  if (word === 'midnight') return 0;
  let hour, minute = 0;
  if (/^\d{3,4}$/.test(token)) { hour = +token.slice(0, -2); minute = +token.slice(-2); }
  else {
    const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(token);
    if (!m) return null;
    hour = +m[1];
    minute = m[2] ? +m[2] : 0;
  }
  if (minute > 59 || hour > 23) return null;
  const half = (meridiem || '').replace(/\./g, '').toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** A whole range in minutes past midnight, reading it the way it was written. */
function shiftRange(a, am, b, bm) {
  let start = clockMinutes(a, am);
  let end = clockMinutes(b, bm);
  if (start == null || end == null) return null;
  const otherHalf = half => (half === 'pm' ? 'am' : 'pm');
  const halfOf = raw => (raw || '').replace(/\./g, '').toLowerCase();
  if (am && !bm) {
    // The end follows the start's half of the day when that reads forwards, and
    // the other half when it does not ("8am-4" is a morning start, an afternoon
    // end). Both halves stated are taken as written: "8pm-4am" is overnight.
    const same = clockMinutes(b, halfOf(am));
    const other = clockMinutes(b, otherHalf(halfOf(am)));
    if (same != null && same > start) end = same;
    else if (other != null && other > start) end = other;
  } else if (bm && !am) {
    const same = clockMinutes(a, halfOf(bm));
    const other = clockMinutes(a, otherHalf(halfOf(bm)));
    if (same != null && same < end) start = same;
    else if (other != null && other < end) start = other;
  } else if (!am && !bm) {
    // No half of the day stated anywhere: "8-4" can only be a daytime shift,
    // while "20-1" can only be the overnight one it looks like.
    const hour = /^(\d{1,2})/.exec(b);
    if (end <= start && start <= 12 * 60 && hour && +hour[1] <= 12) end += 12 * 60;
  }
  return { start, end };
}

/**
 * Read one shift per line. Returns the rows that are ready to store and, for
 * every line that is not, why — a bad line never costs the good ones beside it.
 */
export function parseShiftText(text, today) {
  const day = dateOk(today) ? today : todayIso();
  const shifts = [];
  const problems = [];
  String(text || '').split(/\r?\n|;/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const fail = error => problems.push({ line: index + 1, text: line, error });
    let rest = ` ${line} `;
    const take = matched => { rest = rest.replace(matched, ' '); };

    // A date that carries its year first, so the range scan below cannot read
    // part of it as a shift ("8.30-16.30" is a range; a date is not).
    let date = readDatedYear(rest, day);
    if (date) {
      if (!date.iso) { fail(`"${date.token}" is not a date`); return; }
      take(date.matched);
    }

    // Every range-looking token, so two of them ("13-09 8-4") are reported
    // rather than one silently winning.
    const ranges = [...rest.matchAll(TIME_RANGE_RE)];
    if (ranges.length > 1) {
      fail('two sets of times on one line — write one shift per line (a dashed date needs its year: 13/09)');
      return;
    }
    let start = null, end = null;
    if (ranges.length === 1) {
      const [whole, a, am, b, bm] = ranges[0];
      const pair = shiftRange(a, am, b, bm);
      if (!pair) { fail(`"${whole.trim()}" is not a pair of times`); return; }
      ({ start, end } = pair);
      take(whole);
    }

    // The rest of the date shapes — now that no time range is left to confuse
    // them, a partial dashed date is readable here too.
    if (!date) {
      date = readShiftDate(rest, day);
      if (date) {
        if (date.token && !date.iso) { fail(`"${date.token}" is not a date`); return; }
        take(date.matched);
      }
    }

    const hoursText = HOURS_RE.exec(rest);
    let hours = null;
    if (hoursText) {
      hours = r2(parseFloat(hoursText[1].replace(',', '.')));
      if (!(hours > 0) || hours > 24) { fail(`"${hoursText[0]}" is not a number of hours`); return; }
      take(hoursText[0]);
    }
    if (start == null && hours == null) {
      fail("no times — try 'mon 8-4', or state the hours for a week off ('mon 7h')");
      return;
    }
    if (start != null && hours != null) {
      fail('both times and hours — keep one of them');
      return;
    }

    const specialMatch = SPECIAL_RE.exec(rest);
    if (specialMatch) take(specialMatch[0]);
    const note = rest.replace(/[\s,;·|]+/g, ' ').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').slice(0, 120);
    shifts.push({
      date: date ? date.iso : day,
      start: start == null ? '' : fmtHM(start),
      end: end == null ? '' : fmtHM(end),
      ...(hours == null ? {} : { hours }),
      special: !!specialMatch,
      note,
    });
  });
  return { shifts, problems };
}

/**
 * One line of quick entry's preview: what the row will be, in the units the
 * week card will show it in. `pay` is shiftPay's answer for `shift` (or null),
 * `money` the app's currency formatter. Module scope and string-only so the
 * harness can pin it — the card used to branch on whether the shift priced at
 * all, which sent a stated-hours row (a booked week off) down the clock-times
 * branch and printed an empty range: "Thu 24 Sep · – +1 · 7h".
 */
export function shiftPreviewLine(shift, pay, money) {
  const bits = [`${weekdayShort(shift.date)} ${prettyDate(shift.date)}`];
  if (shift.start && shift.end) {
    const over = isOvernight(parseHM(shift.start), parseHM(shift.end)) ? ' +1' : '';
    bits.push(`${shift.start}–${shift.end}${over}`);
    if (pay) bits.push(`${pay.hours}h`);
  } else {
    bits.push(`${pay ? pay.hours : shift.hours}h stated, no clock times`);
  }
  if (pay) bits.push(`${pay.special ? 'special' : 'normal'} ${money(pay.rate)}/h → ${money(pay.gross)}`);
  // The note is part of the row that gets written, so it belongs in the
  // preview — otherwise the only unverified part of the row is the one the
  // user typed in their own words.
  if (shift.note) bits.push(shift.note);
  return bits.join(' · ');
}


// Open/closed state of the "Pay rules & tax rates" panel. Module scope, not
// screen scope: render() re-invokes screenTesco(), so a local would reset and
// the panel would snap shut on the debounced repaint after every edit — and
// because an input inside a closed <details> can't take focus, that silently
// dropped the caret too.
let ratesPanelOpen = false;
// Which lists are unfolded. Same reason again: render() re-invokes screenTesco(),
// so a flag declared in there would reset the instant it was toggled — the
// "show all" button would repaint straight back to the collapsed state.
let showAllWeeks = false;
let showAllSlips = false;

// ================= foldable cards =================
// The Tesco tab is several cards in one scroll, and the ones a user is not
// working in — the manual form, the week-off card, the tax table, the
// importer — were all paying for that scroll every visit. Each becomes a
// disclosure whose title is its own control: no chevron-only affordance, no
// nested interactive elements, and the choice is remembered between visits.
//
// The reading and writing of that choice are HANDED IN: this module keeps its
// hands off browser storage entirely (a photo must never be near a persistence
// path, and scripts/check-image-hygiene.mjs pins that this file writes none),
// so app.js owns the little key and this file only says what it wants kept.

/** Fold a card behind its own title. Everything after `.tesco-card-title` moves
 *  into a body the button controls; the card's own layout is untouched, so a
 *  folded card is just its heading. Returns the card for chaining. */
function foldCard(card, id, defaultOpen = false, foldGet = null, foldSet = null) {
  const title = card.querySelector('.tesco-card-title');
  if (!title) return card;
  const body = document.createElement('div');
  body.className = 'tesco-card-body';
  body.id = `tesco-fold-${id}`;
  let node = title.nextSibling;
  while (node) {
    const next = node.nextSibling;
    body.appendChild(node);          // reparent, never re-render: the card's
    node = next;                     // handlers and inputs survive the move
  }
  card.appendChild(body);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tesco-fold-btn';
  btn.setAttribute('aria-controls', body.id);
  while (title.firstChild) btn.appendChild(title.firstChild);
  title.appendChild(btn);
  let open = defaultOpen;
  try { if (typeof foldGet === 'function') open = !!foldGet(id, defaultOpen); } catch { open = defaultOpen; }
  const paint = () => {
    body.style.display = open ? '' : 'none';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', () => {
    open = !open;
    try { if (typeof foldSet === 'function') foldSet(id, open); } catch { /* storage unavailable */ }
    paint();
  });
  paint();
  return card;
}

export function screenTesco(ctx) {
  const { $, iconSpan, toast, persist, render, trackAction, swalConfirm, fmt, stackModal, isTopModal, loadVendor } = ctx;
  const state = () => ctx.getState();
  // Fold state lives in app.js's storage (see foldCard above).
  const fold = (card, id, open = false) => foldCard(card, id, open, ctx.foldGet, ctx.foldSet);
  const t = state().tesco || { shifts: [], payslips: [] };
  const rates = { ...TESCO_RATE_DEFAULTS, ...(state().settings.tescoRates || {}) };
  const now = new Date();
  // Debounced repaint for the payslip fields, at screen scope because the row
  // builder is a sibling of the card builder, not a child. A keystroke updates
  // its own row instantly (refreshTotal) and everything derived from the figures
  // follows on a short timer — repainting per character would rebuild the tab
  // under the caret.
  //
  // The card itself is only rebuilt once the caret has LEFT it. Focus survives a
  // repaint (app.js restores it by aria-label, which is why those labels carry
  // the payslip id) but the caret does not: a number input has no selection API —
  // selectionStart is null on type=number — so the replacement field comes back
  // with its value selected and the next digit overwrites the figure just typed.
  // While a field in the card holds the caret, then, the timer refreshes only the
  // text around it (refreshDerived), and the full render follows as soon as the
  // caret moves on.
  let payslipRenderTimer = null;
  let payslipPaintPending = false;

  // Text-only refreshers for the displays derived from the payslip figures — the
  // week cards, the tax footer, the month stats. Each writes into nodes holding
  // no inputs, so refreshing can never disturb the field being typed into.
  const derivedRefreshers = [];
  function refreshDerived() {
    for (const refresh of derivedRefreshers) {
      try { refresh(); } catch { /* cosmetic only — never break a keystroke for it */ }
    }
  }
  function payslipFieldFocused() {
    const active = document.activeElement;
    return !!(active && active.closest && active.closest('.tesco-payslips-card'));
  }
  function schedulePayslipRender() {
    payslipPaintPending = true;
    clearTimeout(payslipRenderTimer);
    payslipRenderTimer = setTimeout(repaintAfterPayslipEdit, 450);
  }
  function repaintAfterPayslipEdit() {
    payslipRenderTimer = null;
    if (!payslipPaintPending) return;
    if (payslipFieldFocused()) {
      refreshDerived();
      // Keep watching: the figures stay live while the caret is in the card, and
      // the first tick after it leaves does the full repaint.
      payslipRenderTimer = setTimeout(repaintAfterPayslipEdit, 450);
      return;
    }
    payslipPaintPending = false;
    // A payslip figure typed into the card is a recording too, and it has no
    // commit behind it (these fields settle on a timer so a caret survives — see
    // the note above), so the ledger follows here instead, as its own action and
    // only when the figure actually moved. Nothing at all happens while the week
    // holds no recorded pay: the week card's estimate is not money the ledger may
    // write down (tescoPayLedgerWrites sees no entry for it in receivedByPayDate).
    const ledger = ctx.recordTescoPayToLedger ? ctx.recordTescoPayToLedger() : null;
    if (ledger) trackAction(ledger.undo, 'Tesco pay to Balances');
    persist();
    render();
    if (ledger) toast(ledger.note, ledger.undo, 'Undo');
  }
  function shifts() { return t.shifts || []; }
  function payslips() { return t.payslips || []; }
  // Read live, not from the captured `t`: a week number typed on one card must
  // show on every other card of that week without a stale copy winning.
  function weekNos() { return ctx.getState().settings.tescoWeekNos || {}; }

  const screen = $('section', { class: 'page-section tesco-section', 'aria-label': 'Tesco Pay' });

  // ----- header stats -----
  // Built as live nodes and re-filled by paintStats(): a payslip figure typed
  // further down moves this month's received total, and that must not require a
  // repaint of the card being typed into.
  const statHours = $('div', { class: 'tesco-stat-value' });
  const statAnticipated = $('div', { class: 'tesco-stat-value' });
  const statReceived = $('div', { class: 'tesco-stat-value' });
  const lifetimeLine = $('div', { class: 'muted', style: 'font-size:12px;margin-top:10px;' });
  function paintStats() {
    // The same day the month above is read from, handed to the summary so the two
    // agree about which of the month's weeks the bank has paid yet (see
    // receivedTotal) — a wall clock could disagree with `now` in a long-lived tab.
    const today = isoLocal(now);
    const month = monthSummary(shifts(), payslips(), rates, now.getFullYear(), now.getMonth(), today);
    const life = lifetimeTotals(shifts(), payslips(), rates, today);
    statHours.textContent = `${month.hours}h`;
    statAnticipated.textContent = fmt(month.anticipated);
    statReceived.textContent = fmt(month.received);
    lifetimeLine.textContent = `Lifetime: ${life.hours}h · ${fmt(life.anticipated)} anticipated · ${fmt(life.received)} received`;
  }
  paintStats();
  derivedRefreshers.push(paintStats);
  screen.appendChild($('div', { class: 'card tesco-stats' },
    $('div', { class: 'tesco-stats-grid' },
      statCell('Hours this month', statHours),
      // Both money figures are nets, so they compare directly: what the month's
      // hours should pay after tax, and what the bank has actually paid in. The
      // labels carry the difference — anticipated is simulated (hence "est."),
      // while received is money that landed, dated by its pay date.
      statCell('Anticipated (est. net)', statAnticipated),
      statCell('Received this month', statReceived),
    ),
    lifetimeLine,
  ));
  function statCell(label, value) {
    return $('div', { class: 'tesco-stat' },
      $('div', { style: 'font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;' }, label),
      value,
    );
  }

  // ----- holiday hours -----
  // 8% of each pay week's hours, posted on the Thursday that week is paid. All
  // of the arithmetic is holidayBalance's (tesco-pay.js, harness-pinned); this
  // card is the reading of it plus the one figure only the user knows — the
  // balance Tesco showed them, on a day they read it. The week already inside
  // that figure is never counted again, which is why a balance set on a Thursday
  // starts accruing from the NEXT one.
  screen.appendChild(buildHolidayCard());

  function buildHolidayCard() {
    const holiday = () => ({ ...HOLIDAY_DEFAULT, ...(ctx.getState().settings.tescoHoliday || {}) });
    // Two decimals, because a holiday balance is read against a payslip — "2.4h"
    // leaves the reader to decide whether that is 2.40 or 2.04.
    const hoursText = (v) => `${r2(Number(v) || 0).toFixed(2)}h`;
    const valueEl = $('div', { class: 'display-num', style: 'font-size:28px;line-height:1.1;margin-top:2px;' });
    const sumEl = $('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:4px;' });
    const takenEl = $('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;' });
    const nextEl = $('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:6px;' });

    // The working, line by line — the opening figure, each Thursday's credit,
    // each week off and the typed figure, with the balance after each. Every
    // row comes from holidayBalance's own `ledger`: this card formats, it never
    // adds. A long history is folded away, and the fold is remembered per device
    // like the rest of this screen's folds (chrome, not document state).
    const ledgerBody = $('div', { id: 'tesco-holiday-ledger', class: 'tesco-ledger-body' });
    let ledgerOpen = null;
    try { if (typeof ctx.foldGet === 'function') ledgerOpen = ctx.foldGet('holiday-ledger', null); } catch { ledgerOpen = null; }
    const setLedgerOpen = (open, remember = true) => {
      ledgerOpen = open;
      ledgerBody.style.display = open ? '' : 'none';
      ledgerToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const n = ledgerBody.querySelectorAll('.tesco-ledger-row').length;
      ledgerToggle.textContent = open
        ? 'Hide the holiday ledger'
        : `Show the holiday ledger · ${n} movement${n === 1 ? '' : 's'}`;
      if (remember) {
        try { if (typeof ctx.foldSet === 'function') ctx.foldSet('holiday-ledger', open); } catch { /* storage unavailable */ }
      }
    };
    const ledgerToggle = $('button', {
      type: 'button', class: 'btn-link tesco-ledger-toggle',
      'aria-controls': ledgerBody.id, 'aria-expanded': 'true',
      onClick: () => setLedgerOpen(!ledgerOpen),
    });
    // A typed taken figure has no day of its own: it is one adjustment, not a
    // movement on a date, so its row says so rather than borrowing today's. A
    // row from another year keeps the compact day and month (the column is 62px
    // on a 320px phone) and puts the year under it, where it cannot widen the
    // row past the card.
    const ledgerDate = (row) => {
      if (row.kind === 'typed') return ['Typed'];
      const date = `${weekdayShort(row.date)} ${prettyDate(row.date)}`;
      return row.date.slice(0, 4) === isoLocal(now).slice(0, 4)
        ? [date]
        : [date, $('span', { class: 'tesco-ledger-year' }, row.date.slice(0, 4))];
    };
    const ledgerRow = (row) => {
      const what = row.kind === 'opening' ? 'Opening balance, as Tesco showed it'
        : row.kind === 'credit' ? `${HOLIDAY_ACCRUAL_PCT}% of ${hoursText(row.workedHours)} · week of ${prettyDate(row.weekStart)}`
          : row.kind === 'weekOff' ? 'Week off'
            : 'Taken, typed in';
      const delta = `${row.hours < 0 ? '\u2212' : '+'}${hoursText(Math.abs(row.hours))}`;
      return $('li', { class: `tesco-ledger-row is-${row.kind}` },
        $('span', { class: 'tesco-ledger-date' }, ...ledgerDate(row)),
        $('span', { class: 'tesco-ledger-what' }, what),
        $('span', { class: 'tesco-ledger-figure' },
          // The opening row IS the balance it opens with: printing it twice (as
          // a movement and as the running total) would read as two figures.
          row.kind === 'opening' ? null : $('span', { class: 'tesco-ledger-delta' }, delta),
          $('span', { class: 'tesco-ledger-balance' }, $('span', { class: 'sr-only' }, 'Balance '), hoursText(row.balance)),
        ),
      );
    };
    function paintLedger(b) {
      ledgerBody.replaceChildren();
      const rows = b.configured ? b.ledger : [];
      if (!rows.length) {
        ledgerToggle.style.display = 'none';
        ledgerBody.style.display = 'none';
        return;
      }
      ledgerToggle.style.display = '';
      const list = $('ol', { class: 'tesco-ledger', 'aria-label': 'Holiday balance, movement by movement' },
        ...rows.map(ledgerRow),
      );
      ledgerBody.append(
        $('p', { class: 'muted tesco-ledger-caption' }, 'Oldest first. The last balance is the figure above.'),
        list);
      // Short histories are worth showing unasked; a year of Thursdays is not.
      if (ledgerOpen === null) setLedgerOpen(rows.length <= 8, false);
      else setLedgerOpen(ledgerOpen, false);
    }

    function paintHoliday() {
      const b = holidayBalance(shifts(), holiday(), rates, isoLocal(now));
      valueEl.textContent = b.configured ? hoursText(b.outstanding) : '—';
      // A negative is real — holiday taken ahead of what has been earned — and
      // it is the one state worth colouring, so it cannot be read as a typo.
      valueEl.style.color = b.configured && b.outstanding < 0 ? 'var(--negative)' : '';
      paintLedger(b);
      if (!b.configured) {
        sumEl.textContent = `Set the hours Tesco shows today. From there this card adds ${HOLIDAY_ACCRUAL_PCT}% of each week's hours on the Thursday that week is paid, and takes off the holiday you use.`;
        takenEl.textContent = '';
        nextEl.textContent = '';
        return;
      }
      sumEl.textContent = `${hoursText(b.anchorHours)} on ${prettyDateLong(b.anchorDate)} + ${hoursText(b.accrued)} accrued − ${hoursText(b.taken)} taken`;
      takenEl.textContent = `Taken: ${hoursText(b.takenAutomatic)} from weeks off, ${hoursText(b.manualTaken)} typed below`;
      nextEl.textContent = !b.next ? ''
        : b.next.hours > 0
          ? `Next: ${HOLIDAY_ACCRUAL_PCT}% of ${b.next.hours}h for the week of ${prettyDate(b.next.weekStart)} — +${hoursText(b.next.credit)} on ${prettyDateLong(b.next.payDate)}`
          : `Next posting is ${prettyDateLong(b.next.payDate)} — no hours on file for the week of ${prettyDate(b.next.weekStart)} yet.`;
    }
    paintHoliday();
    derivedRefreshers.push(paintHoliday);

    // Committed as it is typed, never only when the field is left. The card IS
    // the reading of the balance, so a field showing 35.10 beside a card reading
    // 0.00h is the card contradicting the user — and that is exactly what a
    // `change`-only commit produced: the value was in the input, the figure above
    // it still said 0.00h, and nothing moved until the caret left the field.
    //
    // What is NOT done per keystroke is re-rendering the screen. The card repaints
    // itself from the value just written (no input is rebuilt, so the caret and
    // the "35.10" the user typed both stay), the rest of the screen has nothing
    // to recompute, and the write to storage is debounced — a four-digit figure
    // lands on disk as one document, not four.
    let persistTimer = 0;
    const stopPersistTimer = () => { if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; } };
    const put = (patch) => {
      ctx.getState().settings.tescoHoliday = { ...holiday(), ...patch };
      paintHoliday();
    };
    const writeLive = (patch) => {
      put(patch);
      stopPersistTimer();
      persistTimer = setTimeout(() => { persistTimer = 0; persist(); }, 300);
    };
    // Leaving the field commits the same figure again, this time to storage in the
    // same task: a balance typed and then abandoned must survive a reload.
    const write = (patch) => { stopPersistTimer(); put(patch); persist(); };
    // Enter commits, exactly as it does in the week card's bank cell: the change
    // event fires when the field is left, and a figure typed and followed by
    // Enter would otherwise keep the caret — and the pending write — where it is.
    const commitOnEnter = e => { if (e.key === 'Enter') e.target.blur(); };
    // A number input reports "" for text it cannot read yet ("35."), so an
    // unreadable intermediate changes nothing and the card keeps the last real
    // figure; an empty field is still 0 once the user leaves it.
    const typedHours = (el, commit) => {
      const raw = String(el.value).trim();
      if (raw === '') return commit ? 0 : null;
      const n = Number(raw);
      // The same ceiling the document keeps (normalizeTescoHoliday): a figure the
      // validator would zero is refused here, rather than shown and then lost.
      return Number.isFinite(n) && n >= 0 && n <= 1000 ? r2(n) : null;
    };
    const openIn = $('input', {
      type: 'number', min: '0', max: '1000', step: '0.01', inputmode: 'decimal',
      // Blank, not 0: an empty field says "not set yet" where a 0 would claim a
      // balance of nothing.
      value: holiday().anchorHours || '', placeholder: '35.10',
      // Named for whose figure it is. The number above this card is the app's
      // outstanding balance; this one is Tesco's, on a day — which is why it is
      // an opening figure and not a second reading of the same thing.
      'aria-label': 'Holiday balance from Tesco', class: 'tesco-in', style: 'width:100%;',
      onKeydown: commitOnEnter,
      // The first balance typed is dated today, because that is what it is: what
      // Tesco shows now. The date field beside it is how an older figure — one
      // read off a payslip — is given the day it was true.
      onInput: e => {
        const n = typedHours(e.target, false);
        if (n !== null) writeLive({ anchorHours: n, anchorDate: holiday().anchorDate || isoLocal(now) });
      },
      onChange: e => {
        const n = typedHours(e.target, true);
        if (n !== null) write({ anchorHours: n, anchorDate: holiday().anchorDate || isoLocal(now) });
      },
    });
    const dateIn = $('input', {
      type: 'date', value: holiday().anchorDate, 'aria-label': 'Holiday balance date', class: 'tesco-in', style: 'width:100%;',
      onChange: e => { if (dateOk(e.target.value)) write({ anchorDate: e.target.value }); },
    });
    const takenIn = $('input', {
      type: 'number', min: '0', max: '1000', step: '0.01', inputmode: 'decimal',
      value: holiday().taken || '', placeholder: '0',
      'aria-label': 'Holiday hours taken', class: 'tesco-in', style: 'width:100%;',
      onKeydown: commitOnEnter,
      onInput: e => {
        const n = typedHours(e.target, false);
        if (n !== null) writeLive({ taken: n });
      },
      onChange: e => {
        const n = typedHours(e.target, true);
        if (n !== null) write({ taken: n });
      },
    });
    const field = (label, input) => $('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted);flex:1 1 120px;min-width:0;' },
      $('span', null, label), input);

    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Holiday hours', iconSpan('clock', 'md')),
      valueEl,
      sumEl,
      takenEl,
      nextEl,
      $('div', { class: 'tesco-form-row', style: 'margin-top:12px;' },
        field('Hours Tesco shows', openIn),
        field('As of', dateIn),
        field('Taken (typed)', takenIn),
      ),
      $('div', { class: 'muted', style: 'font-size:11px;line-height:1.5;margin-top:2px;' },
        `A week off written on this tab comes off automatically on the day it starts. Type anything else Tesco has recorded as taken — the two are added together.`),
      $('div', { class: 'tesco-ledger-wrap' }, ledgerToggle, ledgerBody),
    );
  }

  // The roster scanner card used to sit between the quick field and the pay
  // weeks; it went with the photo reader (`97fb40f`). Nothing here reaches a
  // camera, and scripts/check-image-hygiene.mjs keeps it that way.

  // ----- add shift -----
  screen.appendChild(fold(buildAddCard(), 'add-shift'));
  // ----- week off -----
  screen.appendChild(fold(buildWeekOffCard(), 'week-off'));
  // The Add tab's quick field, in shift clothes: describe it, watch the preview
  // resolve, then add it. Same grammar-shaped chips and example chips, because
  // the two fields teach the same habit — say it, check it, save it.
  screen.appendChild(fold(buildQuickCard(), 'quick-entry', true));
  // ----- pay weeks -----
  // Stays open: it is the screen's answer — the week you were paid for — and
  // the shift rows it holds are the only way to edit one from here.
  screen.appendChild(fold(buildWeeksCard(), 'pay-weeks', true));
  // ----- payslips -----
  screen.appendChild(fold(buildPayslipsCard(), 'payslips'));
  // ----- rates -----
  screen.appendChild(buildRatesCard());
  // ----- import / export -----
  screen.appendChild(fold(buildDataCard(), 'import-export'));
  // ----- start over -----
  screen.appendChild(buildClearCard());

  // ================= add shift =================
  function buildAddCard() {
    const draft = { date: todayIso(), start: '07:00', end: '15:00', note: '' };
    const dateIn = $('input', { type: 'date', value: draft.date, 'aria-label': 'Shift date', class: 'tesco-in', onInput: e => { draft.date = e.target.value; } });
    const startIn = $('input', { type: 'time', value: draft.start, 'aria-label': 'Start time', class: 'tesco-in', onInput: e => { draft.start = e.target.value; } });
    const endIn = $('input', { type: 'time', value: draft.end, 'aria-label': 'End time', class: 'tesco-in', onInput: e => { draft.end = e.target.value; } });
    const noteIn = $('input', { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Shift note', class: 'tesco-in tesco-in-grow', maxLength: 120, onInput: e => { draft.note = e.target.value; } });
    const preview = $('div', { class: 'muted', style: 'font-size:12px;min-height:16px;' });
    const refreshPreview = () => {
      preview.textContent = '';
      if (!draft.date || !dateOk(draft.date)) { preview.textContent = 'Pick a date.'; return; }
      const p = shiftPay({ ...draft, special: false }, rates);
      if (!p) { preview.textContent = 'Check the times.'; return; }
      preview.textContent = `Paid ${p.hours}h · ${p.special ? 'special' : 'normal'} ${fmt(p.rate)}/h → ${fmt(p.gross)}`;
    };
    [dateIn, startIn, endIn].forEach(i => i.addEventListener('input', refreshPreview));
    refreshPreview();

    const addBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      if (!dateOk(draft.date)) { toast('Pick a valid date.'); return; }
      if (parseHM(draft.start) == null || parseHM(draft.end) == null) { toast('Check the times.'); return; }
      addShifts([{ date: draft.date, start: draft.start, end: draft.end, note: draft.note.trim() }]);
      draft.note = ''; noteIn.value = '';
    } }, 'Add shift');

    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Add shift', iconSpan('plus', 'md')),
      $('div', { class: 'tesco-form-row' }, dateIn, startIn, endIn),
      $('div', { class: 'tesco-form-row' }, noteIn, addBtn),
      preview,
    );
  }

  // ================= week off =================
  // A booked week off has no clock times: it is a row that states the hours it
  // pays and nothing else — the sheet's own shape, and what the quick entry
  // already writes for "week off 7h". This card is the one place that asks for
  // it outright: which week, and how many hours of pay.
  //
  // The row is weekOffShift's answer (module scope, harness-pinned), dated on the
  // week's Sunday so the week card reads it back as the week it belongs to —
  // "Sun 27 Sep · week off 7h" — and pays it at the card rate (see shiftPay: a
  // row with hours and no times is a booked absence, not a Sunday worked). The
  // preview is shiftPreviewLine over shiftPay, the same two functions the quick
  // card previews with and the week row renders with, so what this card promises
  // and what the week card pays are one piece of arithmetic rather than two that
  // happen to agree today.
  function buildWeekOffCard() {
    const draft = { date: todayIso(), hours: '7' };
    const dateIn = $('input', { type: 'date', value: draft.date, 'aria-label': 'Week off date', class: 'tesco-in', onInput: e => { draft.date = e.target.value; refreshPreview(); } });
    // The bounds are statedHours', with 0 left out: a week off worth nothing is a
    // mistyped week off. `step: any` so the browser never red-outlines an hours
    // figure (7.3) that this app's own rule accepts — the two would disagree, and
    // the app's rule is the one that writes the row.
    const hoursIn = $('input', { type: 'number', min: '0', max: '168', step: 'any', value: draft.hours, 'aria-label': 'Week off hours', class: 'tesco-in', onInput: e => { draft.hours = e.target.value; refreshPreview(); } });
    const preview = $('div', { class: 'muted', style: 'font-size:12px;min-height:16px;' });
    // Rates are read live off the tab's own settings: a preview that captured
    // them would keep quoting the card rate from before an edit.
    function refreshPreview() {
      const result = weekOffShift(draft.date, draft.hours);
      if (!result.ok) { preview.textContent = result.error; return; }
      const ratesNow = { ...TESCO_RATE_DEFAULTS, ...(ctx.getState().settings.tescoRates || {}) };
      preview.textContent = shiftPreviewLine(result.shift, shiftPay(result.shift, ratesNow), fmt);
    }
    refreshPreview();

    const addBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const result = weekOffShift(draft.date, draft.hours);
      if (!result.ok) { toast(result.error); return; }
      // Committing re-renders the tab, so the card comes back with its defaults
      // (this week, 7h) — the fields themselves need no resetting here.
      addShifts([result.shift], 'week off');
    } }, 'Add week off');

    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Week off', iconSpan('briefcase', 'md')),
      $('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px;' }, 'The whole week off: pick any day of that week and the hours it pays — no clock times needed.'),
      $('div', { class: 'tesco-form-row' }, dateIn, hoursIn, addBtn),
      preview,
    );
  }

  // ================= quick entry =================
  // The parser is parseShiftText (module scope, harness-pinned); this card only
  // shows what it understood before anything is written. That preview matters
  // more here than on the Add tab: a mis-read time is a mis-paid week, and the
  // row it writes is worth real money.
  function buildQuickCard() {
    const preview = $('div', { class: 'muted', style: 'font-size:12px;min-height:18px;' });
    const detectRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;' });
    const detectParts = ['Date', 'Start', 'End', 'Special'].map(name => {
      const el = $('span', { class: 'quick-detect-chip', 'aria-hidden': 'true' }, name);
      detectRow.append(el);
      return { name, el };
    });
    // Each part of the grammar lights the moment a line resolves it, so the
    // field teaches itself instead of needing the hint read twice. "Any line"
    // rather than the first: a batch that is half clock times and half a
    // booked week off should not look like it failed to read the times.
    const syncDetectChips = (parsed) => {
      const shifts = (parsed && parsed.shifts) || [];
      const on = {
        Date: shifts.length > 0,
        Start: shifts.some(s => !!s.start),
        End: shifts.some(s => !!s.end),
        Special: shifts.some(s => !!s.special),
      };
      for (const part of detectParts) {
        part.el.classList.toggle('quick-detect-chip-on', !!on[part.name]);
        part.el.replaceChildren(on[part.name] ? iconSpan('check-circle', 'sm') : document.createTextNode('·'),
          $('span', {}, ' ' + part.name));
      }
    };

    const line = (text, bad) => $('div', { style: bad ? 'color:var(--negative);' : '' }, text);
    const renderPreview = (text) => {
      if (!String(text || '').trim()) {
        preview.replaceChildren('Write the shift the way you would say it — the preview fills in as you type.');
        syncDetectChips(null);
        return;
      }
      const parsed = parseShiftText(text, todayIso());
      syncDetectChips(parsed);
      const lines = [];
      for (const problem of parsed.problems) lines.push(line(`Line ${problem.line}: ${problem.error}`, true));
      // Priced with the live rate card, so the preview argues with the week
      // card rather than with a second copy of the arithmetic.
      for (const s of parsed.shifts) lines.push(line(shiftPreviewLine(s, shiftPay(s, rates), fmt)));
      preview.replaceChildren(...lines);
    };

    const input = $('textarea', {
      placeholder: 'Try: mon 8-4 stock take', 'aria-label': 'Quick shift entry', rows: '2',
      class: 'tesco-in', style: 'width:100%;font-size:13px;margin-bottom:8px;',
      onInput: e => renderPreview(e.target.value),
    });
    const examples = [
      { label: 'mon 8-4', hint: 'the Monday just gone' },
      { label: 'yesterday 12:30-20:15', hint: 'an afternoon shift' },
      { label: 'sat 9-5 stock take', hint: 'with a note' },
      { label: 'sun 10-4', hint: 'Sunday rates are worked out for you' },
      { label: 'fri 20:00-01:00', hint: 'an overnight shift' },
      { label: 'week off 7h', hint: 'a booked week off, no clock times' },
      { label: '13/09 9-5 special', hint: 'a bank holiday abroad or a Sunday you worked' },
    ];
    const chips = $('div', { class: 'tesco-quick-chips' },
      ...examples.map(ex => $('button', { type: 'button', class: 'quick-chip', 'aria-label': `Example: ${ex.label} (${ex.hint})`, onClick: () => {
        input.value = ex.label;
        renderPreview(ex.label);
        input.focus();
      } }, ex.label)),
    );
    renderPreview('');

    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Quick entry', iconSpan('sparkle', 'md')),
      $('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px;' }, 'One shift per line, written the way you remember it — check the preview, then add it.'),
      chips,
      input,
      detectRow,
      preview,
      $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px;' },
        $('button', { type: 'button', class: 'btn btn-primary', style: 'font-size:12px;', onClick: () => {
          const parsed = parseShiftText(input.value, todayIso());
          if (parsed.problems.length) { toast('Check the lines marked above, then try again.'); return; }
          if (!parsed.shifts.length) { toast('Describe a shift first — try “mon 8-4”.'); input.focus(); return; }
          if (addShifts(parsed.shifts, 'shift')) { input.value = ''; renderPreview(''); }
          input.focus();
        } }, 'Add shifts'),
      ),
    );
  }

  // Normalise a batch and drop anything already stored or repeated inside it —
  // an imported file that lists a day twice must not pay it twice. The caller
  // owns the key set, so one set can span a whole import.
  function freshShifts(list, seen) {
    const out = [];
    const at = new Date().toISOString();
    for (const s of list) {
      const draft = storedShift(s, uid(), at);
      if (!draft) continue;
      const key = `${draft.date}|${draft.start}|${draft.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(draft);
    }
    return out;
  }
  // A payslip is keyed by the row's own date, so importing an overlapping file
  // can never duplicate a row — and a week that had two pay runs keeps both.
  function freshSlips(list, seen) {
    const out = [];
    const at = new Date().toISOString();
    for (const p of list) {
      const draft = storedPayslip(p, uid(), at);
      if (!draft || !dateOk(draft.weekStart) || seen.has(draft.weekStart)) continue;
      seen.add(draft.weekStart);
      out.push(draft);
    }
    return out;
  }
  // Everything a Tesco action can touch, so `before` is a clean undo snapshot
  // and `next` is the state to write — one step per action, however much it did.
  function snapshot() {
    return { shifts: [...shifts()], payslips: [...payslips()], weekNos: { ...weekNos() } };
  }
  function commitTesco(before, next, label, message) {
    const table = ctx.getState().tesco;
    table.shifts = [...next.shifts].sort((a, b) => a.date.localeCompare(b.date));
    table.payslips = [...next.payslips].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    ctx.getState().settings.tescoWeekNos = { ...next.weekNos };
    // The ledger's half of the recording, in the SAME undo step and read from the
    // tables just written: a week Tesco Pay has recorded pay for gets (or
    // follows) its Balances line here, so recording the pay IS the line landing
    // and one Undo takes both back. null when the recording told the ledger
    // nothing it did not already know — which is every shift-only commit, since a
    // shift is not money until a payslip or a bank figure says what it paid.
    const ledger = ctx.recordTescoPayToLedger ? ctx.recordTescoPayToLedger() : null;
    const undo = () => {
      const cur = ctx.getState();
      cur.tesco.shifts = before.shifts;
      cur.tesco.payslips = before.payslips;
      cur.settings.tescoWeekNos = { ...before.weekNos };
      if (ledger) ledger.undo();
      persist(); render();
    };
    trackAction(undo, label);
    persist(); render();
    toast(ledger ? `${message} ${ledger.note}` : message, undo, 'Undo');
  }

  function addShifts(list, label = 'shift') {
    const before = snapshot();
    const fresh = freshShifts(list, new Set(before.shifts.map(s => `${s.date}|${s.start}|${s.end}`)));
    if (!fresh.length) { toast('Nothing new to add — those shifts already exist.'); return false; }
    commitTesco(before, { ...before, shifts: [...before.shifts, ...fresh] },
      `Add ${fresh.length} ${label}${fresh.length > 1 ? 's' : ''}`,
      `Added ${fresh.length} shift${fresh.length > 1 ? 's' : ''}.`);
    return true;
  }

  // The week's final bank pay, typed by hand on the week's carrier row. The rule
  // is weekBankWrite's (module scope, harness-pinned): the figure is the week's,
  // so it is written to the row it was typed on and to the week's own payslip,
  // and cleared from every other record of that week. One commit, one undo step.
  //
  // Nothing here runs per keystroke — the cell commits on change — so a full
  // render after it is safe. A value that changed nothing (clicking in and back
  // out) is not an edit and is not toasted: the arrays come back with the very
  // same records, which is what the identity check below asks.
  function writeWeekBank(carrierId, raw) {
    const before = snapshot();
    const next = weekBankWrite(before.shifts, before.payslips, carrierId, raw);
    const changed = next.shifts.some((s, i) => s !== before.shifts[i])
      || next.payslips.some((p, i) => p !== before.payslips[i]);
    if (!changed) return false;
    const blank = raw == null || String(raw).trim() === '';
    commitTesco(before, { ...before, shifts: next.shifts, payslips: next.payslips },
      'Record bank pay', blank ? 'Final bank pay cleared.' : 'Final bank pay saved.');
    return true;
  }

  // A whole file at once: shifts, the tax table beside them, and the week
  // numbers the file carries.
  function importTesco(list, slips, numbers) {
    const before = snapshot();
    const fresh = freshShifts(list, new Set(before.shifts.map(s => `${s.date}|${s.start}|${s.end}`)));
    const freshTax = freshSlips(slips, new Set(before.payslips.map(p => p.weekStart)));
    // The file's week numbers fill in only what is not already known, so a week
    // you numbered by hand is never overwritten by an older file.
    const weekNosNext = { ...before.weekNos };
    for (const [week, no] of Object.entries(numbers || {})) {
      const n = Math.trunc(Number(no));
      if (week in weekNosNext) continue;
      if (Number.isFinite(n) && n >= 1 && n <= 53) weekNosNext[week] = n;
    }
    const numbersAdded = Object.keys(weekNosNext).length > Object.keys(before.weekNos).length;
    if (!fresh.length && !freshTax.length && !numbersAdded) { toast('Nothing new — that file is already in.'); return; }
    const parts = [];
    if (fresh.length) parts.push(`${fresh.length} shift${fresh.length > 1 ? 's' : ''}`);
    if (freshTax.length) parts.push(`${freshTax.length} payslip week${freshTax.length > 1 ? 's' : ''}`);
    commitTesco(before,
      { ...before, shifts: [...before.shifts, ...fresh], payslips: [...before.payslips, ...freshTax], weekNos: weekNosNext },
      `Import ${parts.join(' and ')}`, `Imported ${parts.join(' and ')}.`);
  }

  // Every week the tab holds, gone at once. Both id tables are tombstoned for the
  // same reason a single delete is (see below): sync unions by id, so a wipe with
  // no tombstones comes straight back from the other device's copy on the next
  // merge. One snapshot, one undo, so the whole thing is reversible for as long
  // as the app holds undo steps.
  function clearAllTesco() {
    const before = snapshot();
    const shiftIds = before.shifts.map(s => s.id);
    const slipIds = before.payslips.map(p => p.id);
    const restore = () => {
      const cur = ctx.getState();
      cur.tesco.shifts = before.shifts;
      cur.tesco.payslips = before.payslips;
      cur.settings.tescoWeekNos = { ...before.weekNos };
      shiftIds.forEach(id => tombstone('deletedShiftIds', id, false));
      slipIds.forEach(id => tombstone('deletedPayslipIds', id, false));
      persist(); render();
    };
    ctx.getState().tesco.shifts = [];
    ctx.getState().tesco.payslips = [];
    ctx.getState().settings.tescoWeekNos = {};
    shiftIds.forEach(id => tombstone('deletedShiftIds', id, true));
    slipIds.forEach(id => tombstone('deletedPayslipIds', id, true));
    trackAction(restore, 'Delete all Tesco Pay weeks');
    persist(); render();
    toast(`Deleted ${count(before.shifts.length, 'shift')} and ${count(before.payslips.length, 'payslip week')}.`, restore, 'Undo');
  }

  // Plural helper for the counts the card and the toast both state.
  function count(n, noun) { return `${n} ${noun}${n === 1 ? '' : 's'}`; }

  // A deleted row must stay tombstoned until every device has merged. Sync
  // unions shifts/payslips by id and drops only ids it finds in these lists,
  // so a delete with no tombstone comes straight back from the other device's
  // older copy on the next merge.
  function tombstone(field, id, dead) {
    const table = ctx.getState().tesco || (ctx.getState().tesco = {});
    const set = new Set(Array.isArray(table[field]) ? table[field] : []);
    if (dead) set.add(id); else set.delete(id);
    table[field] = [...set];
  }

  function deleteShift(id) {
    const before = [...shifts()];
    const restore = () => {
      ctx.getState().tesco.shifts = before;
      tombstone('deletedShiftIds', id, false);
      persist(); render();
    };
    ctx.getState().tesco.shifts = before.filter(s => s.id !== id);
    tombstone('deletedShiftIds', id, true);
    trackAction(restore, 'Delete shift');
    persist(); render();
    toast('Shift deleted.', restore, 'Undo');
  }

  // A hand edit is an ordinary Tesco commit: one snapshot, one undo step, and
  // the same sort-on-write the import path uses, so changing a date re-slots the
  // row into the week it now belongs to. The validation lives in applyShiftEdit
  // (module scope, harness-testable) rather than here; this only knows how to
  // put the result back into the tab. Returns the applied edit's own result, so
  // the sheet can show the error beside the field that caused it.
  function updateShift(id, fields) {
    const before = snapshot();
    const target = before.shifts.find(s => s.id === id);
    if (!target) return { ok: false, field: null, error: 'That shift is no longer in the tab.' };
    const others = before.shifts.filter(s => s.id !== id).map(s => `${s.date}|${s.start}|${s.end}`);
    const result = applyShiftEdit(target, fields, others);
    if (!result.ok) return result;
    commitTesco(before,
      { ...before, shifts: before.shifts.map(s => (s.id === id ? result.shift : s)) },
      'Edit shift', 'Shift updated.');
    return result;
  }

  // A week card's row is a summary — day, times, hours, pay — so editing one
  // happens in a sheet rather than inline: five fields inside a 12px row would
  // be unreadable on a phone, and every commit rebuilds the week card, which no
  // field holding a caret survives (see the payslip notes above). The sheet
  // validates through applyShiftEdit and previews the row with
  // shiftPreviewLine — the same pair the quick entry uses — so what Save writes
  // is on screen before it is written, and the rules are the importer's own.
  function openShiftEditor(id) {
    const target = shifts().find(s => s.id === id);
    if (!target) return;
    const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
    const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit shift', tabindex: '-1', style: 'max-width:460px;' });

    const field = (label, input, cls = '') => $('label', { class: `tesco-edit-field${cls ? ' ' + cls : ''}` }, $('span', null, label), input);
    // Labelled "Edit shift …", not "Shift …": the Add shift card on the screen
    // behind this sheet already owns those names, and two controls sharing an
    // accessible name in one document is ambiguous to a screen reader — as well
    // as to app.js's restoreFocusedField, which looks a field up by aria-label.
    const inCls = 'tesco-in';
    const dateIn = $('input', { type: 'date', class: inCls, value: target.date, 'aria-label': 'Edit shift date' });
    const startIn = $('input', { type: 'time', class: inCls, value: target.start || '', 'aria-label': 'Edit shift start' });
    const endIn = $('input', { type: 'time', class: inCls, value: target.end || '', 'aria-label': 'Edit shift end' });
    const hoursIn = $('input', { type: 'number', class: inCls, min: '0', max: '168', step: '0.25', value: target.hours == null ? '' : target.hours, placeholder: 'from times', 'aria-label': 'Edit shift hours' });
    // Prefilled only when the row states its own pay: that figure outranks
    // hours × rate, so fixing the times of an imported row would otherwise leave
    // the old amount in place. Blanking it hands the row back to the rates.
    const grossIn = $('input', { type: 'number', class: inCls, min: '0', step: '0.01', value: target.gross == null ? '' : target.gross, placeholder: 'hours × rate', 'aria-label': 'Edit shift pay' });
    const noteIn = $('input', { type: 'text', class: inCls, maxLength: 120, value: target.note || '', placeholder: 'e.g. stock take', 'aria-label': 'Edit shift note' });
    const specialIn = $('input', { type: 'checkbox', checked: !!target.special, 'aria-label': 'Edit shift special' });
    const errorEl = $('div', { style: 'font-size:12px;line-height:1.5;min-height:17px;margin-top:10px;color:var(--negative);' });
    const previewEl = $('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin-top:2px;' });
    const saveBtn = $('button', { type: 'button', class: 'btn btn-primary' }, 'Save');

    const inputs = { date: dateIn, start: startIn, end: endIn, hours: hoursIn, gross: grossIn };
    const read = () => ({
      date: dateIn.value, start: startIn.value, end: endIn.value,
      hours: hoursIn.value, gross: grossIn.value, note: noteIn.value, special: specialIn.checked,
    });

    // The sheet holds no rendered app state — only its own text nodes — so
    // re-validating on every keystroke cannot disturb a caret or a repaint.
    const check = () => {
      const others = shifts().filter(s => s.id !== id).map(s => `${s.date}|${s.start}|${s.end}`);
      const res = applyShiftEdit(target, read(), others);
      for (const [name, input] of Object.entries(inputs)) input.classList.toggle('tesco-edit-bad', !res.ok && res.field === name);
      errorEl.textContent = res.ok ? '' : res.error;
      previewEl.textContent = res.ok
        ? `Saves as ${shiftPreviewLine(res.shift, shiftPay(res.shift, rates), fmt)}`
        : '';
      return res;
    };
    for (const input of [dateIn, startIn, endIn, hoursIn, grossIn, noteIn]) input.addEventListener('input', check);
    specialIn.addEventListener('change', check);

    // Save re-checks rather than trusting the last keystroke, and says so out
    // loud when it refuses: the message sits beside its field, which on a phone
    // can be scrolled past, so it is toasted and focused too.
    saveBtn.addEventListener('click', () => {
      const res = check();
      if (!res.ok) {
        toast(res.error);
        const bad = inputs[res.field];
        if (bad) bad.focus();
        return;
      }
      const applied = updateShift(id, read());
      if (!applied.ok) toast(applied.error);
      close();
    });
    const deleteBtn = $('button', { type: 'button', class: 'btn btn-danger' }, 'Delete');
    deleteBtn.addEventListener('click', async () => {
      const times = target.start && target.end ? `${target.start}–${target.end}` : 'week off';
      if (!await swalConfirm({ title: 'Delete shift?', text: `${prettyDate(target.date)} ${times}`, danger: true, confirmButtonText: 'Delete' })) return;
      deleteShift(id);
      close();
    });

    modal.append(
      $('div', { style: 'display:flex;justify-content:space-between;align-items:center;' },
        $('h2', { class: 'serif', style: 'font-size:28px;font-weight:400;' }, 'Edit shift'),
        $('button', { type: 'button', class: 'btn-link', onClick: () => close() }, 'Close')),
      $('p', { class: 'muted', style: 'font-size:12px;line-height:1.5;' },
        'Leave the times blank for a booked week off and state its hours; leave the pay blank to use the hours and rates.'),
      // A row per pair, the date and the note across the full width: a date
      // control clips its own text below about 145px, which three fields across
      // cannot give it — while each half of a pair is exactly what its control
      // needs (see the sheet's CSS).
      $('div', { class: 'tesco-edit-sheet' },
        field('Date', dateIn, 'tesco-edit-field-wide'),
        $('div', { class: 'tesco-edit-row' }, field('Start', startIn), field('End', endIn)),
        $('div', { class: 'tesco-edit-row' }, field('Hours', hoursIn), field('Pay override €', grossIn)),
        field('Note', noteIn, 'tesco-edit-field-wide')),
      $('label', { style: 'display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer;' },
        specialIn,
        $('span', { class: 'muted', style: 'font-size:12px;' }, 'Special rate ×1.5 — a Sunday is paid special whether or not this is ticked.')),
      errorEl,
      previewEl,
      $('div', { class: 'tesco-edit-actions' },
        deleteBtn,
        $('span', { style: 'margin-left:auto;display:flex;gap:8px;' },
          $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => close() }, 'Cancel'),
          saveBtn)),
    );

    const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
    const onKey = ev => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey, true);
    bg.appendChild(modal);
    stackModal(bg);
    check();
    modal.focus({ preventScroll: true });
  }


  // ================= pay weeks =================
  function buildWeeksCard() {
    const weeks = buildPayWeeks(shifts(), payslips(), rates);
    const card = $('div', { class: 'card' });
    card.appendChild($('div', { class: 'tesco-card-title' }, 'Pay weeks', iconSpan('clock', 'md')));
    if (!weeks.length) {
      card.appendChild($('div', { class: 'muted', style: 'font-size:13px;' }, 'No shifts yet — add one above, or describe one in Quick entry.'));
      return card;
    }
    const shown = showAllWeeks ? weeks : weeks.slice(0, 8);
    for (const w of shown) card.appendChild(weekBlock(w));
    if (weeks.length > 8) {
      card.appendChild($('button', { type: 'button', class: 'btn btn-ghost', style: 'margin-top:10px;', onClick: () => { showAllWeeks = !showAllWeeks; render(); } },
        showAllWeeks ? 'Show fewer' : `Show all ${weeks.length} weeks`));
    }
    return card;
  }

  function weekBlock(w) {
    const sim = w.gross > 0 ? simulateTax(w.gross, rates) : null;
    const box = $('div', { class: 'tesco-week' });
    // The week number is the sheet's own column, so it is editable: the sheet
    // counts 1..52/53 from where its pay year starts and restarts at 1, which
    // no calendar rule here can predict. A typed number is stored per week and
    // carries forward one per week.
    const weekNo = $('input', {
      type: 'number', min: '1', max: '53', value: weekNumberOf(w.weekStart, weekNos()),
      'aria-label': `Week number ${w.weekStart}`, class: 'tesco-weekno',
      onChange: e => {
        const no = Math.trunc(Number(e.target.value));
        const map = { ...(ctx.getState().settings.tescoWeekNos || {}) };
        if (Number.isFinite(no) && no >= 1 && no <= 53) map[w.weekStart] = no;
        else delete map[w.weekStart];
        ctx.getState().settings.tescoWeekNos = map;
        persist(); render();
      },
      // No onInput here on purpose. Blurring on the first keystroke committed the
      // field, and the render that followed handed the replacement number input
      // back with its value selected — so the second digit of a two-digit week
      // number overwrote the first. Committing on change (Enter, or leaving the
      // field) is what actually lets a number be typed.
    });
    const head = $('div', { class: 'tesco-week-head' },
      $('div', {},
        $('div', { style: 'font-weight:600;font-size:13px;' }, `Week of ${prettyDate(w.weekStart)}`),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:2px;display:flex;align-items:center;gap:4px;' },
          // Same words and the same full date as the payslips card below, so one
          // figure isn't called "Payslip 24 Sep" here and "Pay date" there.
          `Pay date ${prettyDateLong(payDateOf(w.weekStart))} · wk`, weekNo),
      ),
      $('div', { style: 'text-align:right;' },
        $('div', { class: 'tesco-week-gross' }, w.gross > 0 ? fmt(w.gross) : '—'),
        $('div', { class: 'muted', style: 'font-size:11px;' }, `${w.hours}h`),
      ),
    );
    box.appendChild(head);

    if (w.shifts.length) {
      const list = $('div', { class: 'tesco-shiftlist' });
      // The week is passed down so the row that carries the week's bank figure
      // knows it is that row (see weekBankWrite), rather than every row growing
      // a cell that would sum with its neighbours'.
      for (const s of w.shifts) list.appendChild(shiftRow(s, w));
      box.appendChild(list);
    }
    if (sim) {
      box.appendChild($('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;' },
        `Est. PAYE ${fmt(sim.paye)} · USC ${fmt(sim.usc)} · PRSI ${fmt(sim.prsi)} · FF ${fmt(sim.pension)} → net ${fmt(sim.net)}`));
    }
    // Shown whenever the week recorded anything — its payslips' tax, a net typed
    // on its row, or both. A net typed on the row used to be invisible here (the
    // line was built only for a week with a payslip) even though receivedTotal has
    // always counted it, so the month's Received said more than the week did.
    const figures = actualFigures(w);
    if (figures.length) {
      const actualEl = $('div', { class: 'tesco-actual' }, ...figures);
      box.appendChild(actualEl);
      // A payslip figure typed below moves this week's line, so it is re-filled
      // in place rather than by rebuilding the screen: replaceChildren() leaves
      // the field being typed into — and its caret — untouched.
      derivedRefreshers.push(() => {
        const fresh = buildPayWeeks(shifts(), payslips(), rates).find(x => x.weekStart === w.weekStart);
        const figures = fresh ? actualFigures(fresh) : [];
        actualEl.style.display = figures.length ? '' : 'none';
        actualEl.replaceChildren(...figures);
      });
    }
    return box;
  }

  // The week's recorded figures: the tax + Future Fund its payslips withheld, the
  // net that reached the bank, and how far the recorded money sits from the
  // estimate above it. weekVsEstimate owns that comparison — including WHICH of the
  // estimate's figures it is against (the net for a bank figure, the withholding
  // for a payslip-only week) — so the chip and the harness cannot disagree about
  // what "vs est" means, and the chip names the base it used.
  // Named, not just totalled: "Payslip total €72.11" beside "Received €478.42" left
  // the reader to guess what the first figure was — and a week whose payslips were
  // all removed in the meantime returns no figures at all, so the line hides.
  function actualFigures(w) {
    const actual = w.payslips.length ? w.paid : null;
    // A week's net is a week's figure whether a payslip or a shift row of that
    // week states it, so it is shown either way — and its own line, since a week
    // with a net but no payslip has no tax withheld to report.
    const received = w.bankPaid;
    if (actual == null && received == null) return [];
    const vs = weekVsEstimate(w, rates);
    return [
      actual == null ? null : $('span', { style: 'font-weight:600;font-size:12px;' }, `Tax paid ${fmt(actual)}`),
      received == null ? null : $('span', { class: 'tesco-derived' }, `Received ${fmt(received)}`),
      vs == null ? null
        : $('span', { class: `tesco-chip ${Math.abs(vs.delta) < 1 ? 'tesco-chip-good' : 'tesco-chip-warn'}` },
            `${vs.delta >= 0 ? '+' : '−'}${fmt(Math.abs(vs.delta)).slice(1)} vs est ${vs.against}`),
    ];
  }

  function shiftRow(s, w) {
    const p = shiftPay(s, rates);
    // A booked week off has hours and no clock times; show that rather than a
    // mangled "–" range.
    const times = s.start && s.end
      ? `${s.start}–${s.end}${isOvernight(parseHM(s.start), parseHM(s.end)) ? '+1' : ''}`
      : 'week off';
    // The week's final bank pay is typed on the week's carrier row — its first
    // row by date, which is the row the sheet and the CSV put a week's figures on
    // (see weekBankWrite). One cell for the week, not one per row: buildPayWeeks
    // adds a week's figures up, so two typed boxes in one week would pay twice.
    const isCarrier = !!w && w.shifts[0] === s;
    const bankIn = isCarrier ? $('input', {
      type: 'number', step: '0.01', inputmode: 'decimal',
      class: 'tesco-in tesco-shift-bank-in', placeholder: '—',
      value: w.bankPaid == null ? '' : w.bankPaid,
      // The label names the row's own date, so it is unique in the document —
      // and it is the pivot the scan card's "pay date" is counted from.
      'aria-label': `Final bank pay ${prettyDateLong(s.date)}`,
      title: 'Final bank pay — what actually reached the bank. Leave it blank if you have not been paid yet.',
      // No onInput here on purpose (the same reason the week number above waits
      // for change): render() rebuilds the whole screen, and a rebuilt number
      // field has no caret to keep — the next digit would land in the wrong
      // place. Leaving the field, or Enter, which blurs it, is the commit.
      onChange: e => writeWeekBank(s.id, e.target.value),
      onKeydown: e => { if (e.key === 'Enter') e.target.blur(); },
    }) : null;
  
    const row = $('div', { class: 'tesco-shiftrow' },
      $('span', { class: 'tesco-shift-day' }, weekdayShort(s.date)),
      $('span', { class: 'tesco-shift-time' }, times),
      // Badge the *computed* rate type: a Sunday shift is special even when the
      // stored flag was never set by hand.
      p && p.special ? $('span', { class: 'tesco-chip' }, 'special') : null,
      $('span', { class: 'muted', style: 'font-size:11px;' }, `${p ? p.hours : '?'}h`),
      // The row's tail: the week's gross, the bank cell and the two buttons, as
      // ONE group. The group wraps whole to its own line when the row runs out of
      // room, which is what keeps the buttons on screen at a phone width (split,
      // the delete button was the piece that fell off the card) — and on a wide
      // screen the group's auto margin keeps the amount flush right, exactly where
      // it was before the bank cell existed.
      $('span', { class: 'tesco-shift-tail' },
        $('span', { class: 'tesco-shift-amt' }, p ? fmt(p.gross) : '—'),
        bankIn ? $('label', { class: 'tesco-shift-bank' },
          $('span', { class: 'tesco-shift-bank-label' }, 'Bank'),
          bankIn,
        ) : null,
        $('span', { class: 'tesco-shift-actions' },
          $('button', { type: 'button', class: 'icon-btn tesco-edit', title: 'Edit shift', 'aria-label': `Edit shift ${prettyDate(s.date)} ${times}`, onClick: () => openShiftEditor(s.id) }, iconSpan('pencil', 'md')),
          // Addressed like the pencil beside it: a `aria-label` is how a control is
          // found (restoreFocusedField, the harness probes), so one screen must
          // never carry two of the same — every row's delete was "Delete shift".
          $('button', { type: 'button', class: 'icon-btn tesco-del', title: 'Delete shift', 'aria-label': `Delete shift ${prettyDate(s.date)} ${times}`, onClick: async () => {
            if (await swalConfirm({ title: 'Delete shift?', text: `${prettyDate(s.date)} ${times}`, danger: true, confirmButtonText: 'Delete' })) deleteShift(s.id);
          } }, '×')),
      ),
    );
    return row;
  }

  // ================= payslips (the "Total tax paid" table) =================
  function buildPayslipsCard() {
    // The class marks the card whose fields must not be rebuilt while one of them
    // holds the caret (see payslipFieldFocused).
    const card = $('div', { class: 'card tesco-payslips-card' });
    card.appendChild($('div', { class: 'tesco-card-title' }, 'Payslips — tax paid', iconSpan('wallet', 'md')));
    const list = $('div', {});
    const slips = [...payslips()].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    if (!slips.length) list.appendChild($('div', { class: 'muted', style: 'font-size:13px;' }, 'Enter the tax figures from each payslip. Refunds go in as negatives.'));
    // A year of payslips is a lot of number inputs, so the list folds like the
    // weeks card does.
    for (const p of (showAllSlips ? slips : slips.slice(0, 6))) list.appendChild(payslipRow(p));
    if (slips.length > 6) list.appendChild($('button', { type: 'button', class: 'btn btn-ghost', style: 'margin-top:10px;', onClick: () => { showAllSlips = !showAllSlips; render(); } },
      showAllSlips ? 'Show fewer' : `Show all ${slips.length} payslips`));

    const addBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'margin-top:10px;', onClick: () => {
      const ws = slips.length ? nextWeekStart(slips[0].weekStart) : weekStartOf(todayIso());
      addPayslip({ id: uid(), weekStart: ws, paye: 0, usc: 0, prsi: 0, futureFund: 0, createdAt: new Date().toISOString() });
    } }, '+ Add payslip week');

    // Per-component totals — the spreadsheet's SUBTOTAL footer. Re-filled in
    // place while a figure above is being typed, so the totals keep up without
    // the card being rebuilt under the caret (see derivedRefreshers).
    const compPaye = $('span'), compUsc = $('span'), compPrsi = $('span'), compFf = $('span');
    const compSum = $('span', { class: 'tesco-totals-sum' });
    function paintTotals() {
      const comp = { paye: 0, usc: 0, prsi: 0, futureFund: 0 };
      for (const p of payslips()) for (const k of Object.keys(comp)) comp[k] += (+p[k] || 0);
      compPaye.textContent = `PAYE ${fmt(comp.paye)}`;
      compUsc.textContent = `USC ${fmt(comp.usc)}`;
      compPrsi.textContent = `PRSI ${fmt(comp.prsi)}`;
      compFf.textContent = `FF ${fmt(comp.futureFund)}`;
      compSum.textContent = fmt(r2(comp.paye + comp.usc + comp.prsi + comp.futureFund));
    }
    paintTotals();
    derivedRefreshers.push(paintTotals);
    card.appendChild(list);
    card.appendChild(addBtn);
    card.appendChild($('div', { class: 'tesco-totals' },
      $('span', null, 'Total tax paid'),
      compPaye, compUsc, compPrsi, compFf, compSum,
    ));
    return card;
  }

  function payslipRow(p) {
    const total = $('span', { class: 'tesco-payslip-total' }, fmt(payslipTotal(p)));
    const ws = weekStartOf(p.weekStart);
    // A display, like the week card's figure is editable: typing a week's number
    // once numbers every week around it, so this row follows the week card
    // rather than competing with it for the same stored value.
    const weekNo = payslipWeekNumberOf(p, weekNos());
    // aria-labels carry the payslip id: the app restores focus across renders
    // by label, so two rows sharing "Payslip paye" would send the caret to the
    // wrong row after the debounced repaint below.
    // `optional` is for the net that reached the bank: clearing it means "not
    // known", not €0, or a blank field would zero that week's received figure.
    const numIn = (key, optional) => $('input', {
      type: 'number', step: '0.01', value: p[key] ?? '',
      'aria-label': `Payslip ${key} ${p.id}`, class: 'tesco-in tesco-in-num',
      onInput: e => {
        const v = parseFloat(e.target.value);
        updatePayslip(p.id, { [key]: Number.isFinite(v) ? v : (optional ? undefined : 0) });
        refreshTotal();            // instant feedback on this row
        schedulePayslipRender();   // then the week card, footer and month stats follow
      },
    });
    const refreshTotal = () => {
      const fresh = payslips().find(x => x.id === p.id);
      if (fresh) total.textContent = fmt(payslipTotal(fresh));
    };
    return $('div', { class: 'tesco-payslip' },
      // Which week this payslip covers, at a glance: the date it is keyed by and
      // its week number — the number the sheet's tax table prints, and the one
      // the week card above shows for the same week.
      $('div', { class: 'tesco-payslip-head' },
        $('input', { type: 'date', value: p.weekStart, 'aria-label': `Week start ${p.id}`, class: 'tesco-in tesco-in-date', onInput: e => { if (dateOk(e.target.value)) { updatePayslip(p.id, { weekStart: e.target.value }); schedulePayslipRender(); } } }),
        weekNo == null ? null : $('span', {
          class: 'tesco-chip tesco-payslip-wk',
          title: 'Week number — edit it on the week card above',
        }, `Wk ${weekNo}`),
      ),
      $('div', { class: 'tesco-payslip-grid' },
        numField('PAYE', numIn('paye')), numField('USC', numIn('usc')), numField('PRSI', numIn('prsi')), numField('FF', numIn('futureFund')),
        // The net that landed in the bank, when the payslip states it. Optional
        // on purpose: a blank falls back to gross − tax.
        numField('Bank', numIn('bankPay', true)),
      ),
      $('div', { class: 'tesco-payslip-foot' },
        // Week start + 11 days is the sheet's own pay-date formula, and the
        // weekday is the point of it: the money lands on the Thursday. Named and
        // dated in full for that reason — a bare "24 Sep" left it unclear which
        // year the row belonged to and which day to look for it on a statement.
        $('span', { class: 'muted', style: 'font-size:11px;' }, `Pay date ${prettyDateLong(payDateOf(ws))}`),
        // Labelled, because a bare number after four input fields was the thing
        // that read as ambiguous: this is what the week's payslip withheld.
        $('span', { class: 'tesco-payslip-tax' },
          $('span', { class: 'muted', style: 'font-size:11px;' }, 'Tax paid'),
          total,
        ),
        $('button', { type: 'button', class: 'icon-btn tesco-del', title: 'Delete payslip', 'aria-label': `Delete payslip week of ${prettyDate(p.weekStart)}`, onClick: async () => {
          if (await swalConfirm({ title: 'Delete payslip?', text: `Week of ${prettyDate(p.weekStart)}`, danger: true, confirmButtonText: 'Delete' })) deletePayslip(p.id);
        } }, '×'),
      ),
    );
  }
  // The optional hint rides on the LABEL line, not under the input. A trailing
  // line only one field has made that cell taller than its neighbour, so the
  // grid's rows stopped being evenly spaced (a hole under the field beside it).
  // On the label line every cell is the same height and the hint still sits
  // beside the number it derives from.
  function numField(label, input, hint) {
    return $('label', { class: 'tesco-numfield' },
      $('span', { class: 'tesco-numfield-label' }, $('span', null, label), hint || null),
      input,
    );
  }

  function addPayslip(p) {
    const before = [...payslips()];
    ctx.getState().tesco.payslips = [...before, p].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    trackAction(() => { ctx.getState().tesco.payslips = before; persist(); render(); }, 'Add payslip');
    persist(); render();
    toast('Payslip week added.', () => { ctx.getState().tesco.payslips = before; persist(); render(); }, 'Undo');
  }
  function updatePayslip(id, patch) {
    ctx.getState().tesco.payslips = payslips().map(p => p.id === id ? { ...p, ...patch } : p);
    persist();
  }
  function deletePayslip(id) {
    const before = [...payslips()];
    const restore = () => {
      ctx.getState().tesco.payslips = before;
      tombstone('deletedPayslipIds', id, false);
      persist(); render();
    };
    ctx.getState().tesco.payslips = before.filter(p => p.id !== id);
    tombstone('deletedPayslipIds', id, true);
    trackAction(restore, 'Delete payslip');
    persist(); render();
    toast('Payslip deleted.', restore, 'Undo');
  }

  // ================= rates =================
  function buildRatesCard() {
    const details = $('details', { class: 'tesco-rates', onToggle: e => { ratesPanelOpen = e.target.open; } }, $('summary', null, 'Pay rules & tax rates'));
    details.open = ratesPanelOpen;
    const grid = $('div', { class: 'tesco-rates-grid' });
    let timer = null;
    // Sunday is normal × multiplier, so show the figure it works out to on the
    // factor's own label line: editing either field moves it, which is the
    // point of storing a multiple rather than its own rate.
    const sundayRate = $('span', { class: 'tesco-derived' });
    const refreshSundayRate = () => {
      sundayRate.textContent = `= ${fmt(r2(rates.normal * rates.specialMultiplier))}/h`;
    };
    refreshSundayRate();
    const field = (label, key, step, hint) => {
      const input = $('input', {
        type: 'number', step: step || '0.01', value: rates[key], 'aria-label': label, class: 'tesco-in tesco-in-num',
        onInput: e => {
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v) || v < 0) return;
          rates[key] = v;
          refreshSundayRate();
          clearTimeout(timer);
          timer = setTimeout(() => {
            ctx.getState().settings.tescoRates = { ...rates };
            persist(); render();
          }, 500);
        },
      });
      return numField(label, input, hint);
    };
    grid.appendChild(field('Normal €/h', 'normal'));
    grid.appendChild(field('Sunday ×', 'specialMultiplier', undefined, sundayRate));
    grid.appendChild(field('Pension %', 'pensionPct'));
    grid.appendChild(field('PAYE credit €', 'payeCredit'));
    grid.appendChild(field('PAYE cutoff €', 'payeCutoff'));
    grid.appendChild(field('PRSI %', 'prsiRate'));
    details.appendChild($('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;' },
      `Pay week runs Sunday → Saturday; the payslip lands ${PAY_LAG_DAYS} days after the week starts (Thursday). USC bands are statutory and fixed; PRSI is exempt at €352 a week or less and its €12 credit tapers away by €424 (4.35% from 1 October 2026, 4.2% before that — set the rate above if you are estimating an older week).`));
    details.appendChild(grid);
    return details;
  }

  // ================= import / export =================
  // The workbook's own table out, and the same table back in. A shift row keeps
  // the hours and pay it was paid for (see shiftPay) — the sheet's older rows
  // were worked at rates that have since changed — while the week's own totals
  // stay derived from the rows, so they cannot disagree with the shifts above
  // them.
  function buildDataCard() {
    // The workbook path: SheetJS reads the .xlsx and hands its sheets back as the CSV
    // text everything below already knows (workbookToCsv), so the import rules live
    // in one place. Fetched on the first workbook chosen — never at boot, and never
    // for a CSV, which must not wait on 245 KB it will not use.
    async function workbookText(file) {
      await loadVendor('xlsx', { js: 'vendor/xlsx.mini.min.js' });
      if (typeof XLSX === 'undefined') throw new Error('xlsx unavailable');
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheets = (book.SheetNames || []).map(name => ({
        name,
        rows: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true }),
      }));
      return workbookToCsv(sheets);
    }
    // No FileReader: file.text() is the whole read, and the input is cleared the
    // moment it hands over — nothing keeps a reference to the file. The legacy .xls
    // binary is not offered: the vendored SheetJS build reads .xlsx/.xlsm only, and
    // offering an extension the reader cannot open is worse than not offering it.
    const fileIn = $('input', { type: 'file', accept: '.csv,text/csv,.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'aria-label': 'Import a Tesco Pay file', style: 'display:none' });
    fileIn.addEventListener('change', async () => {
      const file = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!file) return;
      const workbook = /\.(xlsx|xlsm)$/i.test(file.name);
      let text;
      try {
        text = workbook ? await workbookText(file) : await file.text();
      } catch (err) {
        toast(workbook ? 'That workbook could not be read — save it as CSV and import that.' : 'That file could not be read.');
        return;
      }
      const parsed = parseTescoCsv(text);
      if (parsed.error) { toast(parsed.error); return; }
      if (!parsed.shifts.length && !parsed.payslips.length) { toast('No shifts or tax figures found in that file.'); return; }
      const counts = [];
      if (parsed.shifts.length) counts.push(`${parsed.shifts.length} shift${parsed.shifts.length > 1 ? 's' : ''}`);
      if (parsed.payslips.length) counts.push(`${parsed.payslips.length} payslip week${parsed.payslips.length > 1 ? 's' : ''}`);
      const ok = await swalConfirm({
        title: workbook ? 'Import from workbook?' : 'Import from CSV?',
        text: `${counts.join(' and ')} read from “${file.name}”`
          + (parsed.skipped ? `, ${parsed.skipped} row${parsed.skipped > 1 ? 's' : ''} skipped` : '')
          + '. Each row brings its own hours and pay, the special flag and your notes; a week\u2019s totals and tax estimate are worked out from the rows.',
        confirmButtonText: 'Import',
      });
      if (ok) importTesco(parsed.shifts, parsed.payslips, parsed.weekNos);
    });
    const exportBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => {
      if (!shifts().length) { toast('No shifts to export yet.'); return; }
      downloadText(`tesco-pay-${todayIso()}.csv`, tescoCsv(shifts(), payslips(), rates, weekNos()), 'text/csv');
      toast(`Exported ${shifts().length} shift${shifts().length > 1 ? 's' : ''} — the workbook's columns.`);
    } }, 'Export CSV');
    const importBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileIn.click() }, 'Import');
    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Import / export', iconSpan('data', 'md')),
      $('div', { class: 'tesco-form-row' }, exportBtn, importBtn, fileIn),
      $('div', { class: 'muted', style: 'font-size:12px;margin-top:8px;' },
        'CSV or the workbook itself (.xlsx), in the sheet’s own columns: one row per shift, newest first, each week’s figures on its first row. A workbook’s sheets are read as they are — the tax table may sit above or below the shifts.'),
    );
  }

  // ================= start over =================
  function buildClearCard() {
    const nShifts = shifts().length, nSlips = payslips().length;
    const empty = !nShifts && !nSlips;
    const button = $('button', {
      type: 'button', class: 'btn btn-danger',
      onClick: async () => {
        if (empty) { toast('There are no Tesco Pay weeks to delete.'); return; }
        const ok = await swalConfirm({
          title: 'Delete all Tesco Pay weeks?',
          text: `${count(nShifts, 'shift')} and ${count(nSlips, 'payslip week')} are removed, with the week numbers that go with them. Your pay rules and rates stay. You can undo it straight after.`,
          danger: true, confirmButtonText: 'Delete everything',
        });
        if (ok) clearAllTesco();
      },
    }, 'Delete all weeks');
    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Delete all weeks', iconSpan('alert', 'md')),
      $('div', { class: 'tesco-form-row' }, button),
      $('div', { class: 'muted', style: 'font-size:12px;margin-top:8px;' },
        empty
          ? 'Nothing stored yet.'
          : `${count(nShifts, 'shift')} and ${count(nSlips, 'payslip week')} are stored, on this device and every device it syncs with.`),
    );
  }

  return screen;
}

function weekdayShort(dateStr) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][isoToUtcMidnight(dateStr).getUTCDay()];
}
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(iso) {
  if (!iso || !dateOk(iso)) return '—';
  const d = isoToUtcMidnight(iso);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}
// The same date with its weekday and year. Used for a payslip's pay date, where
// both carry meaning: the formula lands the money on a Thursday, and a roster
// spans a year boundary — so "Thu 24 Sep 2026" is matchable against a bank
// statement where "24 Sep" is not.
function prettyDateLong(iso) {
  if (!iso || !dateOk(iso)) return '—';
  const d = isoToUtcMidnight(iso);
  return `${weekdayShort(iso)} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}