/* ============================================================
   tesco.js — Tesco Pay: shift engine, Irish tax simulation,
   roster-photo OCR import, and the #tesco screen.

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

   OCR: a roster photo is parsed into (day, start, end) shifts.
   The image exists ONLY in JS memory — File → canvas → blob →
   worker. Nothing is written to storage, cache, or state; the
   canvas is zeroed and every reference dropped once parsing ends.
   ============================================================ */

import { uid, downloadText } from './storage.js';
import { getActiveProfileId } from './profiles.js';
// One CSV field rule for the whole app: this file writes the workbook out and
// reads it back, and storage.js writes the entries export with the same rule —
// so it lives in csv.js rather than in two places free to disagree. The
// apostrophe guard in it is what stops a note being read as a formula.
import { csvCell, csvUnquote, csvDocument, csvRows, csvDate } from './csv.js';
// The pixel transforms the reader shares with the worker that prepares each
// image for the engine (ocr-prep-worker.js). The box walk is the reader's own
// (the rule scan); the two thresholds are pinned by scripts/test-tesco.mjs, so
// they keep their names on this module even though they now live beside the
// worker's copy of them — see ocr-pixels.js for why there is only one copy.
import { ocrBoxWalk } from './ocr-pixels.js';
export { ocrAutoContrast, ocrSauvola, ocrStretchData } from './ocr-pixels.js';

// ---------- the pay engine lives in tesco-pay.js ----------
// Rates, paid hours, the Sunday premium, the tax simulation and the week/month
// roll-ups are one module, and the app shell imports IT rather than this file —
// which is what lets #tesco (this file: the reader, the photo pipeline, the
// workbook importer and the screen) be fetched on first visit instead of on
// boot. Every name is re-exported below so the harnesses and the screen, which
// have always imported them from here, keep resolving them.
import {
  TESCO_RATE_DEFAULTS, PAY_LAG_DAYS, WEEK_START_DOW,
  r2, pad2, isoLocal, todayIso, parseHM, fmtHM, isoToUtcMidnight, dateOk,
  paidHours, isOvernight, isSunday, statedHours, shiftPay, simulateTax,
  weekStartOf, payDateOf, weekNumberOf, payslipWeekNumberOf, isoWeekNumber,
  nextWeekStart, buildPayWeeks, weekBankWrite, monthSummary, lifetimeTotals, payslipTotal,
  weekVsEstimate, receivedByPayDate, tescoPayLedgerWrites, tescoPayWriteWindow, TESCO_PAY_METHOD,
} from './tesco-pay.js';
export {
  TESCO_RATE_DEFAULTS, r2, pad2, isoLocal, todayIso, parseHM, fmtHM, isoToUtcMidnight, dateOk,
  paidHours, isOvernight, isSunday, statedHours, shiftPay, simulateTax,
  weekStartOf, payDateOf, weekNumberOf, payslipWeekNumberOf, isoWeekNumber,
  nextWeekStart, buildPayWeeks, weekBankWrite, monthSummary, lifetimeTotals, payslipTotal,
  weekVsEstimate, receivedByPayDate, tescoPayLedgerWrites, tescoPayWriteWindow, TESCO_PAY_METHOD,
};

// The photo is read as a few overlapping horizontal strips rather than one
// canvas: a roster carries a name column and small date tokens that a 2000px
// downscale loses entirely, while a full 4080px page at the upscale those
// glyphs need would be ~200 MB. Half-height strips keep every glyph at the
// resolution that reads and stay inside a 12 MP working budget (ocrStripBox),
// and the 50% overlap means no line is ever cut in half.
const OCR_STRIP_H = 0.5;    // each strip covers half the photo's height
const OCR_STRIP_COUNT = 3;  // starts at 0 / 25% / 50%, so the strips overlap by half
// Pixels handed to the engine in one recognition, on any path: 12 MP is where a
// phone-size decode stays quick, and every scale below is chosen to land here.
const OCR_WORK_PIXELS = 12e6;
// The camera path feeds the same reader as a chosen file, so a captured frame
// is held to the same working budget and backed by the same promise.
const CAMERA_MAX_EDGE = 2000;     // longest side of a captured frame, as a file
const CAMERA_LIVE_ATTEMPTS = 12;  // frames a live read takes before it gives up

// Why the camera path cannot run, or null when it can. Checked before the
// stream is opened so the modal can explain the absence instead of failing
// silently: getUserMedia is missing outside a secure context (a plain-HTTP
// LAN address) and on older browsers.
function cameraSupport() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices
    || typeof navigator.mediaDevices.getUserMedia !== 'function') return 'unsupported';
  if (globalThis.isSecureContext === false) return 'insecure';
  return null;
}


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
const SHORT_DATE_RE = /\b(\d{1,2})[\/.]\s?(\d{1,2})\b/;

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
  const full = /(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4})/.exec(text);
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
  const dashed = /(\d{1,2})[.\-](\d{1,2})[.\-](\d{2,4})/.exec(text);
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

// ---------- OCR: text parsing (pure, Node-testable) ----------
const OCR_DIGIT_FIXES = { l: '1', I: '1', i: '1', O: '0', o: '0', D: '0', S: '5', s: '5', B: '8', Z: '2', g: '9', G: '6', b: '6' };
function fixDigits(s) { return s.replace(/[lIiODSsBZgGb]/g, c => OCR_DIGIT_FIXES[c] || c); }

// Matching the user's typed name to a name read off a photo. Recognition
// confuses look-alike glyphs, so "Parth" comes back as "Par1h" or "Partb" and
// an exact compare would find no row at all. Fold each name to one spelling
// (case, spacing and known confusions), then allow a small edit distance.
const NAME_CONFUSIONS = [['rn', 'm'], ['vv', 'w'], ['cl', 'd'], ['0', 'o'], ['1', 'l'], ['5', 's'], ['8', 'b'], ['2', 'z'], ['6', 'g'], ['9', 'g'], ['i', 'l']];
function foldName(s) {
  let t = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [a, b] of NAME_CONFUSIONS) t = t.split(a).join(b);
  return t.replace(/(.)\1+/g, '$1');
}
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
export function nameMatches(word, name) {
  const w = foldName(word), n = foldName(name);
  if (!w || n.length < 3) return false;          // too short to identify anyone
  if (w === n) return true;
  if (n.length >= 4 && w.length >= 4 && (w.includes(n) || n.includes(w))) return true; // "parth sharma" vs "parth"
  return editDistance(w, n) <= (n.length >= 7 ? 2 : 1);
}

// "14-22", "7-15.", "12:30-5:30", "14–22" → minutes; null when not a range.
//
// The minute separator is read as a colon, a full stop OR a comma, because on a
// photographed roster a colon and a full stop are the same two pixels: a colon's
// dots are round, JPEG ringing closes the gap between them, and the engine
// returns "07.00-15.00". That cell is a whole shift, and refusing it because of
// the punctuation cost the day. (Nothing else a roster prints looks like
// `d{1,2}[.,]d{2}-d{1,2}[.,]d{2}`: a date is three numbers, a clock time is two,
// and the hour is bounded below.)
export function parseTimeCell(raw) {
  let s = fixDigits(String(raw || '').trim().replace(/[.,;]+$/, ''));
  if (!s || /^(off|n\/?a|none|-+|\/+)$/i.test(s)) return null;
  const m = /^(\d{1,2})(?:[:.,](\d{2}))?\s*[-–—−]\s*(\d{1,2})(?:[:.,](\d{2}))?$/.exec(s);
  if (!m) return null;
  const sh = +m[1], sm = m[2] ? +m[2] : 0, eh = +m[3], em = m[4] ? +m[4] : 0;
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const start = sh * 60 + sm;
  let end = eh * 60 + em;
  if (end <= start) {
    // Ambiguous end hours: "12:30-5:30" is an afternoon shift (5:30pm) while
    // "20-01" runs past midnight. Take the +12h reading when it produces a
    // sane shift; otherwise the end is next day.
    const pm = end + 720;
    end = (pm > start && pm - start <= 14 * 60) ? pm : end + 1440;
  }
  return { startMin: start, endMin: end };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// A roster prints its days short ("Sun") at least as often as long ("Sunday"),
// and a photo can read 5 for S: match the first three letters, with the common
// digit-for-letter confusion folded back.
const WEEKDAY_PREFIX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function weekdayOf(text) {
  const t = String(text || '').toLowerCase().replace(/5/g, 's').replace(/0/g, 'o').replace(/[^a-z]/g, '');
  const i = t.length >= 3 ? WEEKDAY_PREFIX.indexOf(t.slice(0, 3)) : -1;
  return i < 0 ? null : i;
}
// "27-Sep" with OCR noise tolerated: "27-5ep", "27-0ct", "27 Sep".
function matchMonth(token) {
  const t = String(token || '').toLowerCase().replace(/[015]/g, d => ({ 0: 'o', 1: 'l', 5: 's' }[d]));
  if (t.length < 2) return null;
  for (const [name, idx] of Object.entries(MONTHS)) if (t.startsWith(name.slice(0, 3))) return idx;
  return null;
}
export function parseDateToken(text, today) {
  const s = String(text || '').trim();
  // "27-Sep", "20 September 2026" — the month may be written out and the year
  // may be printed beside it. A year that is there settles which year the sheet
  // is for, and that matters at the turn of the year, when the nearest-year
  // guess is wrong for half the photos taken: a roster for the week of 29 Dec,
  // photographed on 2 Jan, has to date December, not the December after next.
  // ... and only when the middle token really is a month NAME. "22/09/2026" fits
  // this shape too — day, "month" and year — and reading "09" as a month name
  // answers null, which would have thrown the whole all-numeric date away.
  const m = /^(\d{1,2})[-/. ]([A-Za-z0-9]{2,9})(?:[-/. ](\d{2,4}))?$/.exec(s);
  if (m && /[A-Za-z]/.test(m[2])) {
    const mon = matchMonth(m[2]);
    if (mon == null) return null;
    const day = +m[1];
    if (day < 1 || day > 31) return null;
    if (!today) return true;
    const year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    if (year != null && year >= 1970 && year <= 2200) {
      const printed = new Date(Date.UTC(year, mon, day));
      return Number.isNaN(printed.getTime()) ? null : printed;
    }
    return inferDate(day, Object.keys(MONTHS)[mon], today);
  }
  // A fully numeric date. Rosters head their columns "22-Sep" but their TITLE
  // with a range — "Week 39   22/09/2026 - 28/09/2026   Store 3021" — and that
  // range is the one part of the header big enough to survive glare, so it is
  // worth knowing: it says which week the sheet covers even when the date row
  // itself did not read (see columnAnchors).
  const n = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(s);
  if (!n) return null;
  // Day first, as the workbook writes it, unless only one reading is possible:
  // a 13+ in the first place can only be a day and a 13+ in the second only a
  // day too, which settles a US-style sheet the other way round.
  const a = +n[1], b = +n[2];
  const [day, mon] = a > 12 && b <= 12 ? [a, b] : b > 12 && a <= 12 ? [b, a] : [a, b];
  const year = +n[3] < 100 ? 2000 + +n[3] : +n[3];
  if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
  return today ? new Date(Date.UTC(year, mon - 1, day)) : true;
}

function inferDate(day, mon, today) {
  if (!(day >= 1 && day <= 31) || MONTHS[mon] == null) return null;
  const candidates = [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1]
    .map(y => new Date(Date.UTC(y, MONTHS[mon], day)))
    .filter(d => !Number.isNaN(d.getTime()));
  let best = null, bestGap = Infinity;
  for (const d of candidates) {
    const gap = Math.abs(d - today);
    if (gap < bestGap) { bestGap = gap; best = d; }
  }
  return bestGap <= 200 * 86400000 ? best : null;
}

// words: [{ text, x0, y0, x1, y1, confidence }] from any engine.
// Returns { rows, columns } — rows carry a best-guess name, a `matches`
// flag for the owner's row, and parsed shift cells.
// opts.name: the user's name, matched loosely against each row's name so a
// misread spelling still finds the right row (see nameMatches).
// opts.fallback: { weekStart: 'YYYY-MM-DD' } — used when the date row could not
// be read at all: the seven days are laid out evenly across the span the time
// cells occupy, starting at weekStart (roster columns are Sun→Sat in order).
// ---------- roster OCR: the grid ----------
/**
 * Where a row's name column ends and its first day begins: the left edge of the
 * first column, as the grid has it.
 *
 * NOT "a couple of word-widths left of the first column's centre", which is what
 * this used to be. A cell's text is left-aligned in its column, so a short one
 * ("OFF") sits half a cell left of its own centre — inside any threshold drawn
 * from the centre — and the day off was swallowed into the name. The name that
 * then reads "Sean Murphy OFF" matches nobody, and the scan loses the row it was
 * looking for. Erring the other way costs nothing: a name that drifts right lands
 * in the first day column, where it is not a time range and so is no cell at all.
 */
function rosterNameColumnRight(bounds) {
  return bounds && bounds.length ? bounds[0][0] : Infinity;
}

/**
 * One day column's horizontal extent: the halfway line to each neighbour, so a
 * word belongs to the column its centre falls in and never to whichever word
 * happens to sit beside it. Shared by the strip pass and the cell pass, which is
 * what makes the two agree about where a day starts.
 *
 * The first and last columns have no neighbour to meet halfway, so they are
 * extrapolated by half a column pitch. That overshoots into the name column on
 * the left, deliberately: a name that drifts right still lands left of the first
 * day (see rosterNameColumnRight), while a cell that drifted a few pixels left
 * never lands in the name column's lap.
 */
export function rosterColumnBounds(cols) {
  const cx = (cols || []).map(c => Number(c && c.cx)).filter(Number.isFinite);
  if (!cx.length) return [];
  return cx.map((c, i) => {
    const prev = i > 0 ? cx[i - 1] : null;
    const next = i < cx.length - 1 ? cx[i + 1] : null;
    const pitch = cx.length > 1 ? Math.abs((next != null ? next : c) - (prev != null ? prev : c)) : 1;
    return [
      prev != null ? (prev + c) / 2 : c - pitch / 2,
      next != null ? (c + next) / 2 : c + pitch / 2,
    ];
  });
}

// The range-shaped run inside a cell's text, so a cell carrying one shift plus
// noise still reads. Module scope so both the strip pass and the cell pass agree
// on what "a range" looks like to within a stray character.
const CELL_RANGE_RE = /\d{1,2}(?:[:.,]\d{2})?\s*[-–—−]\s*\d{1,2}(?:[:.,]\d{2})?/g;

/**
 * The shift one day column's words state, or null. Pure, so the grammar a photo
 * is read with can be pinned without a photo.
 *
 * `tokens` are the strip pass's words that fell inside the column, any order.
 * The job is to survive the ways a cell arrives broken:
 *
 *   - split into pieces by the engine ("07:00" "-" "15:00") — re-joined when
 *     they run together, which is what the gap is for;
 *   - carrying a rule line or the neighbouring column's edge ("| 07:00-15:00") —
 *     a token that is punctuation carries no glyphs, and one good token is
 *     enough, so the cell is taken from the best single token before it is lost;
 *   - read twice, because two overlapping strips both cover the row — the two
 *     reads sit on top of each other, so the duplicate is dropped (the more
 *     confident copy kept) rather than concatenated into nonsense;
 *   - holding exactly one range among noise ("07:00-15:00 x") — recovered, but
 *     only when the cell holds exactly ONE, since two ranges on one day means the
 *     grid put two days in this column and neither can be trusted to be the
 *     day's own shift.
 */
// A token of pure punctuation is a rule line the engine has dressed as text: it
// carries no glyphs, so it belongs in neither a name nor the box a cell is
// cropped by. The sheet's own rules come back this way on a real read.
const isGlyphToken = text => /[0-9A-Za-z]/.test(String(text == null ? '' : text));

/**
 * Words written back as the runs they were written in, which is what both a
 * name and the pieces of a cell need before they can be read:
 *
 *   - pieces that run together are rejoined verbatim, so the "22" "-" "Sep" a
 *     date came back in closes up into one token again;
 *   - a word that starts where the run so far already is was READ twice, not
 *     written twice — the two overlapping strips both cover the row — so the
 *     more confident copy is kept instead of the pair concatenating into
 *     "LiamLiam DoyleDoyle";
 *   - everything else keeps its own run, and the caller joins runs with a space.
 *
 * Only a substantial overlap counts as a double read (40% of the shorter token),
 * because a genuine pair of pieces can shave a pixel or two off each other.
 *
 * Punctuation is deliberately NOT filtered here: the "-" between the two halves
 * of a split range arrives as its own token with no glyph in it, and dropping it
 * would leave "07:00" and "15:00" as two ranges in one day. Filtering that noise
 * is the caller's job, where it knows whether it is reading a name or a cell.
 */
function mergeTokenRuns(words, joinGap) {
  const sorted = (words || [])
    .filter(w => w && String(w.text || '').trim())
    .map(w => ({ text: String(w.text).trim(), x0: Number(w.x0), x1: Number(w.x1), confidence: w.confidence == null ? 100 : w.confidence }))
    .sort((a, b) => a.x0 - b.x0);
  const runs = [];
  for (const t of sorted) {
    const prev = runs[runs.length - 1];
    if (prev && prev.x1 - t.x0 > Math.max(2, (t.x1 - t.x0) * 0.4)) {
      if (t.confidence > prev.confidence) { prev.text = t.text; prev.confidence = t.confidence; }
      prev.x0 = Math.min(prev.x0, t.x0);
      prev.x1 = Math.max(prev.x1, t.x1);
      continue;
    }
    if (prev && t.x0 - prev.x1 <= joinGap) { prev.text += t.text; prev.x1 = t.x1; continue; }
    runs.push({ ...t });
  }
  return runs;
}

// One row's words as text: a space only where the engine left one, so "Parth"
// "Sharma" stays two words while the fragments of one token close up. The name a
// staff row is matched on is read this way, and a rule line the engine read as
// "|" is dropped here rather than being carried into the name.
function joinRowWords(words, joinGap) {
  return mergeTokenRuns((words || []).filter(w => w && isGlyphToken(w.text)), joinGap)
    .map(r => r.text).join(' ').trim();
}

export function parseCellTokens(tokens, joinGap = 12) {
  const runs = mergeTokenRuns(tokens, joinGap);
  if (!runs.length) return null;
  const confidence = Math.round(Math.min(...runs.map(r => r.confidence)));
  const text = runs.map(r => r.text).join(' ');
  const direct = parseTimeCell(text);
  if (direct) return { ...direct, raw: text, confidence };
  // One run at a time: a column's crop can carry a rule's edge, and the shift is
  // still in there perfectly readable. But only while exactly one run IS a shift
  // — two ranges in one day means the grid put two days in this column, and
  // picking the first would be guessing which one this day was paid for.
  const ranges = runs.map(r => ({ run: r, parsed: parseTimeCell(r.text) })).filter(x => x.parsed);
  if (ranges.length === 1) return { ...ranges[0].parsed, raw: ranges[0].run.text, confidence: Math.round(ranges[0].run.confidence) };
  if (ranges.length > 1) return null;
  // Nothing came back as a whole run, but exactly one range-shaped stretch of the
  // cell's text did: that is the shift, with whatever rides beside it dropped.
  const found = text.match(CELL_RANGE_RE) || [];
  const only = found.length === 1 ? parseTimeCell(found[0]) : null;
  return only ? { ...only, raw: text, confidence } : null;
}

/**
 * The lines a page's words were written on.
 *
 * A row is a LINE, not a level: a photo of a sheet is almost never square to the
 * phone — half a degree across 1700px is 15px of drift and a hand-held shot is
 * routinely 1-3°, i.e. 30-90px — so each group keeps the slope of its own words
 * and a word joins the group whose line passes nearest it AT ITS OWN x.
 *
 * Grouping by a flat tolerance instead is what tore a tilted page apart: one
 * physical staff row landed in three groups, so the reader returned a matched
 * fragment holding a third of the week's shifts plus a couple of fragments named
 * "(unnamed row)" holding the rest.
 *
 * Pure and exported, because this decision is the whole difference between a
 * read and a mess and a photo is not needed to test it.
 */
/** The tilt of the page, as a slope in y per x.
 *
 * Taken from the words themselves, before any row is known: the median slope
 * over every pair that is far apart across the page and close enough vertically
 * to be on one line. A median, because the pairs that are NOT on one line — a
 * word from the row above, a rule the engine boxed as text — are a minority and
 * cannot move it.
 *
 * Estimating the tilt once for the page rather than per row is what keeps a
 * single bad box from forking a row: a group that fits its own slope from its own
 * two ends has nothing to go on until it holds two well-separated words, and the
 * one mis-boxed word that arrives first tilts the whole line it started.
 */
export function pageSkew(words, medianH) {
  const pts = (words || [])
    .filter(w => w && [w.x0, w.y0, w.x1, w.y1].every(Number.isFinite))
    .map(w => ({ cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2 }));
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].cx - pts[i].cx;
      if (Math.abs(dx) < medianH * 6) continue;
      const dy = pts[j].cy - pts[i].cy;
      // Wider than a line, narrower than the row pitch: a pair from two different
      // rows would drag the median toward "this page is level".
      if (Math.abs(dy) > medianH * 3.5) continue;
      slopes.push(dy / dx);
    }
  }
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  const mid = slopes[Math.floor(slopes.length / 2)];
  // Clamped to ~8.5°: past that the sheet is not being read by a phone held over
  // it, and a runaway slope would chain the whole page into one group.
  return Math.max(-0.15, Math.min(0.15, mid));
}

/**
 * The lines a page's words were written on. A row is a LINE, not a level: a
 * photo of a sheet is almost never square to the phone — half a degree across
 * 1700px is 15px of drift and a hand-held shot is routinely 1-3°, i.e. 30-90px —
 * so the page's tilt is taken out of every word's y first (see pageSkew) and the
 * grouping is then the flat one it looks like: a word joins the line its centre
 * sits on, within a text height.
 *
 * Grouping by a flat tolerance on the raw y is what tore a tilted page apart:
 * one physical staff row landed in three groups, so the reader returned a matched
 * fragment holding a third of the week's shifts plus fragments named
 * "(unnamed row)" holding the rest — and the days the cell pass never saw went
 * missing from the week entirely.
 *
 * Pure, because this decision is the whole difference between a read
 * and a mess, and a photo is not needed to test it.
 */
function groupWordsIntoRows(words, medianH, skew = null) {
  const tol = Math.max(medianH * 0.9, 14);
  const slope = skew == null ? pageSkew(words, medianH) : skew;
  const flat = (words || [])
    .filter(w => w && [w.x0, w.y0, w.x1, w.y1].every(Number.isFinite))
    .map(w => ({ w, y: (w.y0 + w.y1) / 2 - slope * ((w.x0 + w.x1) / 2) }))
    .sort((a, b) => a.y - b.y);
  const rows = [];
  for (const { w, y } of flat) {
    const row = rows.find(r => Math.abs(r.cy - y) <= tol);
    if (row) { row.items.push(w); row.cy = row.items.reduce((s, i) => s + ((i.y0 + i.y1) / 2 - slope * ((i.x0 + i.x1) / 2)), 0) / row.items.length; }
    else rows.push({ cy: y, items: [w] });
  }
  // The rest of the reader walks the sheet top to bottom.
  return rows.sort((a, b) => a.cy - b.cy);
}

const DAY_MS = 86400000;
const utcMidnight = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The columns a roster's header describes, left to right.
 *
 * Tokens are taken from the header rows only — a shift range is what tells a
 * header row from a staff row, see parseRosterWords — and two rules keep the
 * sheet's own furniture out of the grid:
 *
 *  - A DATE anchors a column only from the header row that carries the most of
 *    them, and only when that row carries three or more. A real roster titles
 *    itself "Week 39  22/09/2026 - 28/09/2026  Store 3021": one or two dates, in
 *    a line of prose, a hundred pixels from the first day column. Merged into the
 *    grid they land as a phantom column at the left, every real column then sits
 *    one place away from its own date, and the whole week is paid a day late.
 *    Day NAMES are collected from every header row instead: they are what the
 *    grid is checked against (see resolveColumnDates), and a day name standing
 *    beside a title date is what proves that date is not a column.
 *  - When no header row carries three dates — a sparse header, or a date row lost
 *    to glare — those dates are returned as `weekStart` rather than as columns.
 *    A title's date range still says which week the sheet covers, which is worth
 *    far more than a phantom column.
 *
 * Missing header columns are filled in by the grid's own pitch, because rosters
 * are evenly spaced; a grid that still came out wider than a week is narrowed to
 * the seven consecutive columns that read most like one — the most day names and
 * dates, at an even pitch.
 */
/**
 * Every date-shaped token inside a phrase's text, the whole phrase first.
 *
 * A header is not always a row of separate words. The title's date range is one
 * run of print — "Week 39   22/09/2026 - 28/09/2026   Store 3021" — and the
 * engine boxes that run as a single word, so reading the phrase and nothing
 * inside it threw the range away. That range is the line that says WHICH WEEK
 * the sheet covers, and it is the part of a header big enough to survive glare
 * (see columnAnchors): it is worth finding inside a phrase, not only between two.
 *
 * Only ever used to pick the week out of a header that has no date ROW — a real
 * date row is read date by date and never goes through here.
 */
function dateTokensIn(text, today) {
  const whole = parseDateToken(text, today);
  if (whole) return [whole];
  const tokens = String(text || '').split(/[\s|]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    // A date is written as one token ("22/09/2026") or spread over two or three
    // ("20 September 2026"), so each window is tried longest first and a token
    // that gave up a date is not asked again. Longest first because the year is
    // what settles the year: reading "20 September" alone would date it by the
    // nearest year to today, which is the guess the printed year exists to beat.
    for (const span of [3, 2, 1]) {
      if (i + span > tokens.length) continue;
      const d = parseDateToken(tokens.slice(i, i + span).join(' '), today);
      if (d) { out.push(d); i += span - 1; break; }
    }
  }
  return out;
}

/** Every date a header row carries, boxed as one word or as six. Both rules that
 *  count a header's dates go through here (the band rule in parseRosterWords and
 *  the date-row choice below), so a title that arrived merged is not a title the
 *  reader is blind to. */
function rowDateTokens(row, today) {
  const out = [];
  for (const ph of (row && row.phrases) || []) for (const d of dateTokensIn(ph.text, today)) out.push(d);
  return out;
}

export function columnAnchors(headerRows, today = new Date(), mergeWithin = 90, max = 7) {
  const rows = (headerRows || []).filter(r => r && Array.isArray(r.phrases));
  const now = utcMidnight(today);
  // Which row IS the date row is judged by every date the row carries, merged
  // words included; which of its dates may ANCHOR a column is judged phrase by
  // phrase below, because a column needs a position and a phrase has one.
  let dateRow = -1, dateCount = 0;
  rows.forEach((row, i) => {
    const n = rowDateTokens(row, now).length;
    if (n > dateCount) { dateCount = n; dateRow = i; }
  });
  const tokens = [];
  rows.forEach((row, i) => {
    for (const ph of row.phrases) {
      const cx = (ph.x0 + ph.x1) / 2;
      const weekday = weekdayOf(ph.text);
      const date = dateCount >= 3 && i === dateRow ? parseDateToken(ph.text, now) : null;
      if (weekday == null && !date) continue;
      tokens.push({ cx, weekday, date, confidence: ph.confidence });
    }
  });
  // Which week the sheet covers, when a date row did not survive to say it: two
  // dates about a week apart are the range printed under the title, and the
  // earlier of the two is the week's first day.
  let weekStart = null;
  if (dateCount < 3) {
    const dates = [];
    rows.forEach(row => row.phrases.forEach(ph => {
      for (const d of dateTokensIn(ph.text, now)) dates.push(d);
    }));
    dates.sort((a, b) => a - b);
    for (let i = 0; i + 1 < dates.length; i++) {
      const gap = Math.round((dates[i + 1] - dates[i]) / DAY_MS);
      if (gap >= 5 && gap <= 7) { weekStart = dates[i]; break; }
    }
    if (!weekStart && dates.length) weekStart = dates[0];
  }
  tokens.sort((a, b) => a.cx - b.cx);
  let cols = [];
  for (const t of tokens) {
    const last = cols[cols.length - 1];
    if (last && t.cx - last.cx <= mergeWithin) {
      // A date and a day name on one column are two readings of the same day.
      if (t.date && !last.date) { last.date = t.date; last.confidence = t.confidence; }
      if (t.weekday != null && last.weekday == null) last.weekday = t.weekday;
      continue;
    }
    cols.push({ ...t });
  }
  if (cols.length >= 2) {
    const gaps = cols.slice(1).map((c, i) => c.cx - cols[i].cx).sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    if (gap > mergeWithin / 3) {
      const filled = [...cols];
      // A day the header did not give up is put back WHERE the header is missing
      // it. A column's own date is derived from its POSITION in the row — the days
      // run in order, and resolveColumnDates rebuilds the whole series from one
      // surviving anchor — so putting a column back in the wrong place renumbers
      // every day after it.
      //
      // That is not a hypothetical: read at an angle, with the light falling off
      // across the sheet, the header gives up six days' worth of tokens with the
      // seventh missing from the middle, and a fill at the left edge turned
      // Tuesday's shift into Wednesday's shift, Thursday's into Friday's — a whole
      // week paid a day late, which is the one kind of misread nobody notices.
      // The gap is where the paper says it is: doubling the pitch between two
      // columns is a missing day sitting between them, and nothing else looks like
      // that.
      while (filled.length < max) {
        let at = -1, widest = gap * 1.5;
        for (let i = 1; i < filled.length; i++) {
          const d = filled[i].cx - filled[i - 1].cx;
          if (d > widest) { widest = d; at = i; }
        }
        if (at < 0) break;
        filled.splice(at, 0, { cx: (filled[at - 1].cx + filled[at].cx) / 2 });
      }
      // No gap to fill, so the days left over are off one end of the row, and that
      // end is the left: the header gives up its first days when the light falls
      // off across the sheet, and the fall-off lands on the name column's side of a
      // hand-held shot. A day put at the left is a day before the week — it takes
      // no shift that the day names did not already give every column (the tests
      // below hold both ends of that) — where the same guess at the right walks the
      // grid off the paper.
      let left = filled[0].cx - gap;
      while (filled.length < max) { filled.unshift({ cx: left }); left -= gap; }
      cols = filled;
    }
  }
  if (cols.length > max) {
    let bestStart = 0, bestScore = -Infinity;
    for (let s = 0; s + max <= cols.length; s++) {
      const win = cols.slice(s, s + max);
      const gaps = win.slice(1).map((c, i) => c.cx - win[i].cx);
      const mid = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      const even = gaps.every(g => Math.abs(g - mid) <= mid * 0.35) ? 1 : 0;
      const score = win.filter(c => c.weekday != null).length * 3
        + win.filter(c => c.date).length + even;
      if (score > bestScore) { bestScore = score; bestStart = s; }
    }
    cols = cols.slice(bestStart, bestStart + max);
  }
  return { cols, weekStart };
}

/**
 * Give every column its date, in place.
 *
 * Three sources, in this order, because they are not equally trustworthy:
 *
 *  - A date token, and the day name printed over the same column, cannot both be
 *    right when they disagree ("23-Sep" read for 27-Sep) — the day name is the
 *    reliable signal, so the date is dropped. The surviving anchor is then the
 *    one that agrees with the most day names across the grid, and the whole
 *    series is rebuilt from it: one misread date token can move a single column,
 *    never the week.
 *  - Failing that, the week range printed under the title (columnAnchors).
 *  - Failing that, the day names alone: the week that CONTAINS today, or the
 *    nearest one. Anchoring on "the next Tuesday after today" — which is what
 *    this used to do — is a whole week late whenever today does not happen to
 *    fall inside the week being read, and that pays every shift a week late.
 */
export function resolveColumnDates(cols, today = new Date(), weekStart = null) {
  const list = cols || [];
  if (!list.length) return list;
  const now = utcMidnight(today).getTime();
  for (const c of list) {
    if (c.date && c.weekday != null && c.date.getUTCDay() !== c.weekday) { c.date = null; c.confidence = 0; }
  }
  const agreement = (anchorIdx, anchorDate) => {
    let score = 0;
    list.forEach((c, i) => {
      if (c.weekday == null) return;
      const d = new Date(anchorDate.getTime() + (i - anchorIdx) * DAY_MS);
      if (d.getUTCDay() === c.weekday) score += 1;
    });
    return score;
  };
  const anchors = list.map((c, i) => ({ i, c })).filter(x => x.c.date);
  if (anchors.length) {
    let best = anchors[0], bestScore = -1;
    for (const a of anchors) {
      const score = agreement(a.i, a.c.date) * 1000 + (a.c.confidence || 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    list.forEach((c, i) => { c.date = new Date(best.c.date.getTime() + (i - best.i) * DAY_MS); c.confidence = undefined; });
    return list;
  }
  const start = weekStart instanceof Date ? weekStart
    : typeof weekStart === 'string' ? isoToUtcMidnight(weekStart) : null;
  if (start && !Number.isNaN(start.getTime())) {
    // The title's range says WHERE the week is; the day names say which day is
    // which — and the two can disagree, which is not a hypothetical. A roster
    // prints a Monday-first range over a Sunday-first grid, and the range is read
    // from one line of prose, so a single misread digit moves it by a day and
    // every shift on the sheet is then a day out. It used to be applied as
    // written, and a week dated a day late is the one misread nobody catches.
    //
    // So the series is slid by whole days to the offset the sheet's own day names
    // agree with most, and a tie keeps the range where it was: the names are what
    // this function has always trusted (they are why a date token that disagrees
    // with its column is dropped above), and with no names to ask the range still
    // stands on its own.
    const agreesAt = shift => list.reduce((n, c, i) => n + (c.weekday == null ? 0
      : new Date(start.getTime() + (i + shift) * DAY_MS).getUTCDay() === c.weekday ? 1 : 0), 0);
    let bestShift = 0;
    let bestAgree = agreesAt(0);
    for (let shift = -6; shift <= 6; shift++) {
      if (!shift) continue;
      const agree = agreesAt(shift);
      if (agree > bestAgree || (agree === bestAgree && Math.abs(shift) < Math.abs(bestShift))) {
        bestAgree = agree;
        bestShift = shift;
      }
    }
    list.forEach((c, i) => { c.date = new Date(start.getTime() + (i + bestShift) * DAY_MS); c.confidence = undefined; });
    return list;
  }
  const first = list.findIndex(c => c.weekday != null);
  if (first >= 0) {
    let bestStart = null, bestGap = Infinity, bestForward = false;
    for (let delta = -21; delta <= 21; delta++) {
      const d = now + delta * DAY_MS;
      if (new Date(d + first * DAY_MS).getUTCDay() !== list[first].weekday) continue;
      const end = d + (list.length - 1) * DAY_MS;
      const gap = now < d ? d - now : now > end ? now - end : 0;
      const forward = now <= d;
      if (gap < bestGap || (gap === bestGap && forward && !bestForward)) {
        bestGap = gap; bestStart = d; bestForward = forward;
      }
    }
    if (bestStart != null) list.forEach((c, i) => { c.date = new Date(bestStart + i * DAY_MS); });
  }
  return list;
}

/**
 * How much of the grid's dating the sheet's own day names corroborate.
 *
 * `named` is how many columns carry a day name at all; `agree` is how many of
 * those carry the date that name implies. The dating is one rigid series — one
 * anchor plus whole days — so these two numbers are the whole of the evidence
 * behind the week the reader is about to store: seven names all agreeing is a
 * header that was read; two of seven agreeing is a header whose names do not
 * describe one week at all, which is what a header read in the dark side of a
 * photo looks like.
 *
 * That second case used to be invisible. `complete` asked whether the header had
 * given up three names or three dates, never whether those names agreed with the
 * dates the same reading produced — so a reading whose week rested on two names
 * out of seven could still be called whole and end the reader's search. Pure and
 * exported for the same reason as every other decision taken on a photo: it is
 * the difference between a correct week and a week paid a day late, and no photo
 * is needed to see it.
 *
 * There is deliberately no third outcome here ("contradicted"). With a day name
 * on ONE column the dating can always be slid by under a week to honour it, so
 * "no name agrees" is not a state a real grid reaches; what a garbled header
 * produces is a LOW agreement, and that is what is measured.
 */
export function columnDatingAgreement(cols) {
  let named = 0, agree = 0;
  for (const c of cols || []) {
    if (!c || c.weekday == null) continue;
    named += 1;
    const d = c.date;
    if (d instanceof Date && !Number.isNaN(d.getTime()) && d.getUTCDay() === c.weekday) agree += 1;
  }
  return { named, agree };
}

export function parseRosterWords(rawWords, today = new Date(Date.UTC(2026, 8, 22)), opts = {}) {
  const words = (rawWords || [])
    .filter(w => w && String(w.text || '').trim() && (w.confidence == null || w.confidence > 25))
    .map(w => ({ ...w, text: String(w.text).trim(), cy: (w.y0 + w.y1) / 2, h: Math.max(1, w.y1 - w.y0) }))
    .sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  if (!words.length) return { rows: [], columns: [] };

  const medianH = words.map(w => w.h).sort((a, b) => a - b)[Math.floor(words.length / 2)];
  const rowTol = Math.max(medianH * 0.9, 14);
  const rows = groupWordsIntoRows(words, medianH);
  // Merge tokens on one row into phrases when horizontally adjacent
  // (tesseract splits "14-22" or "27-Sep" into fragments).
  const gapJoin = medianH * 1.6;
  for (const row of rows) {
    row.items.sort((a, b) => a.x0 - b.x0);
    row.phrases = [];
    for (const w of row.items) {
      const last = row.phrases[row.phrases.length - 1];
      if (last && w.x0 - last.x1 <= gapJoin) {
        last.text += (w.x0 - last.x1 > medianH * 0.45 ? ' ' : '') + w.text;
        last.x1 = Math.max(last.x1, w.x1);
        last.confidence = Math.min(last.confidence, w.confidence == null ? 100 : w.confidence);
      } else {
        row.phrases.push({ text: w.text, x0: w.x0, x1: w.x1, confidence: w.confidence == null ? 100 : w.confidence });
      }
    }
  }

  // Header band: the leading rows that carry a date token or a weekday name.
  //
  // Rows BETWEEN them count too, and the band closes on a staff row rather than
  // on the first row without a header token. A roster prints its name-column
  // heading ("Employee") on a line of its own between the day names and the
  // dates, so a band that stopped at the first row it could not read closed
  // before the dates — every column then lost its date and was anchored on the
  // nearest day NAME to today instead, which on a sheet read a day either side of
  // that name puts the whole week out by one and pays the wrong days.
  //
  // A shift range is what tells the two apart: no header row holds one, so the
  // first row that does is where the staff begin.
  //
  // A row counts as a header row only when it carries TWO or more of those
  // tokens, and the search runs well past the first few lines: a photo that came
  // back with junk between the title and the grid (a dark or glare-lit shot puts
  // hundreds of invented words on the page) pushes the real header further down,
  // and a single stray token on a junk row is not a header.
  const headerRows = [];
  const scanLimit = Math.max(8, Math.min(rows.length, Math.ceil(rows.length * 0.4)));
  for (const row of rows.slice(0, scanLimit)) {
    if (row.phrases.some(ph => parseTimeCell(ph.text))) break;
    const heads = rowDateTokens(row).length + row.phrases.filter(ph => weekdayOf(ph.text) != null).length;
    if (heads >= 2) headerRows.push(row);
  }
  const grid = columnAnchors(headerRows, today, medianH * 3);
  let cols = resolveColumnDates(grid.cols, today, grid.weekStart);

  // No date row was read — glare, a cut edge or a steep angle can lose it. The
  // roster still lays its days out left to right, so spread seven even columns
  // across the span its time cells occupy, the first being the week's first
  // day, and let the normal pass below separate the staff rows. (Only the
  // cells are measured, not the whole photo: the name column shares the width.)
  if (!headerRows.length && opts.fallback && opts.fallback.weekStart) {
    const times = words.filter(w => parseTimeCell(w.text));
    if (times.length) {
      const left = Math.min(...times.map(w => w.x0)), right = Math.max(...times.map(w => w.x1));
      const step = (right - left) / 7;
      const base = isoToUtcMidnight(opts.fallback.weekStart);
      cols = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(base.getTime() + i * 86400000);
        return { cx: left + step * (i + 0.5), date: d, weekday: d.getUTCDay() };
      });
    }
  }

  // Staff rows: everything below the header band. A word is placed by the GRID —
  // the column whose bounds hold its centre — not by which word happens to sit
  // beside it. Merging on horizontal distance alone is what lost a whole roster:
  // the sheet's column rules come back as "|"/"=" tokens parked exactly on the
  // cell boundary, the name column ends ~30px left of the first day, and both
  // gaps sit inside the merge distance — so "07:00-15:00 = OFF" collapsed into
  // one phrase that was no longer a range, and "Parth Sharma 07:00-15:00" into
  // one that was no longer a name, dropping the day either side of every rule.
  //
  // Segmenting by column also makes the duplicate impossible: two overlapping
  // strips that both read the row put both copies of a cell in the same column,
  // where parseCellTokens keeps one, instead of two cells racing for one day.
  const headerBottom = headerRows.length ? headerRows[headerRows.length - 1].cy + rowTol * 1.5 : rows[0].cy;
  const bounds = rosterColumnBounds(cols);
  const nameRight = rosterNameColumnRight(bounds);
  const joinGap = medianH * 0.45;
  const out = [];
  for (const row of rows) {
    if (row.cy <= headerBottom) continue;
    const nameWords = [];
    const colWords = bounds.map(() => []);
    for (const w of row.items) {
      const cx = (w.x0 + w.x1) / 2;
      if (cx < nameRight) { nameWords.push(w); continue; }
      let colIdx = 0, bestDist = Infinity;
      bounds.forEach((b, i) => {
        const dist = cx < b[0] ? b[0] - cx : cx > b[1] ? cx - b[1] : 0;
        if (dist < bestDist) { bestDist = dist; colIdx = i; }
      });
      colWords[colIdx].push(w);
    }
    if (!colWords.some(list => list.length)) continue;
    const cells = [];
    for (let i = 0; i < bounds.length; i++) {
      const parsed = parseCellTokens(colWords[i], joinGap);
      if (!parsed) continue; // "off", a rest word, or a rule's edge
      const col = cols[i];
      const date = col && col.date ? isoLocalUTC(col.date) : null;
      const weekday = col && col.date ? col.date.getUTCDay() : (col && col.weekday != null ? col.weekday : null);
      cells.push({
        date, weekday,
        startMin: parsed.startMin, endMin: parsed.endMin,
        raw: parsed.raw, confidence: parsed.confidence,
        dupe: false,
      });
    }
    if (!cells.length) continue;
    const name = joinRowWords(nameWords, joinGap);
    out.push({
      name: name || '(unnamed row)',
      matches: opts.name ? nameMatches(name, opts.name) : false,
      cells,
      // The words this row was read from — the same objects, so the cell pass can
      // crop to where the ink actually is on a tilted page without re-deriving it
      // from a row centre that a tilt moves by tens of pixels across the sheet.
      words: row.items,
    });
  }

  // Cells read at cell resolution (see ocrOwnerCells) belong to the row the
  // typed name matched: each came from a crop of one day column rather than from
  // a word box, so they are the better read of that day and win it.
  //
  // Merged a DAY at a time, not swapped wholesale. Replacing the row's cells
  // whenever the pass claimed the whole grid meant one failed crop silently
  // deleted a shift the strip pass had already read correctly — the crop a glare
  // defeated, on the day that mattered. Here a day the pass read keeps its read,
  // a day it could not read keeps the strip pass's, and a day both agree is empty
  // is the only way a day goes missing.
  if (Array.isArray(opts.cells) && opts.cells.length) {
    let owner = out.find(r => r.matches);
    if (!owner && opts.name) { owner = { name: opts.name, matches: true, cells: [] }; out.unshift(owner); }
    if (owner) {
      const merged = new Map(owner.cells.filter(c => c.date).map(c => [c.date, c]));
      for (const c of opts.cells) if (c && c.date) merged.set(c.date, c);
      owner.cells = [...merged.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
  }
  return { rows: out, columns: cols };
}
/**
 * What a read of the page is worth, as a number, and whether it is worth
 * stopping for.
 *
 * The reader used to stop at the first read that mentioned the typed name. That
 * is the wrong test, and it is wrong in the direction a person cannot see: a read
 * can carry the name and still be a worse reading of the sheet than the one that
 * comes next — the words there, the columns and the day cells garbled — and the
 * scan then commits to it. On a photo lit from one side that is exactly the
 * failure: the strips find the name, and the row they hand back has the whole
 * week's cells shifted into the neighbouring days.
 *
 * So a read is SCORED on what it actually produced — how many of the week's
 * columns it found, whether the typed name is on one of its rows, how many dated
 * shifts that row holds, whether those dates are distinct (two shifts on one date
 * is the grid folding a neighbouring column into it, and is penalised rather than
 * rewarded) and how much of the week's dating the sheet's own day names agree with
 * (columnDatingAgreement) — and the reader reads the sheet another way while no
 * read has yet come back COMPLETE: the full seven columns, the row, at least one
 * dated shift on it, and a week the header does not contradict.
 *
 * The words are filtered to exactly what parseRosterWords will keep, so "good"
 * cannot drift from "what the parse will actually use": a read scored complete
 * here is a read whose parse is complete.
 *
 * Pure, and exported, because this decision — which reading of a photo to believe
 * — is the whole difference between a correct week and a week paid a day late.
 */
export function rosterReadQuality(rawWords, name, today = new Date()) {
  const words = (rawWords || []).filter(w => w && String(w.text || '').trim()
    && (w.confidence == null || w.confidence > 25)
    && [w.x0, w.y0, w.x1, w.y1].every(Number.isFinite));
  if (!words.length) return { words: [], found: false, columns: 0, cells: 0, score: -1, complete: false, named: 0, agree: 0 };
  const parsed = parseRosterWords(words, today, { name });
  const owner = name ? parsed.rows.find(r => r.matches) : null;
  const dated = owner ? owner.cells.filter(c => c && c.date).map(c => new Date(c.date).getTime()) : [];
  const cells = dated.length;
  const sameDay = new Set(dated).size !== cells;
  // How the week was dated: the day names and the date tokens the header gave up,
  // and — the number that actually decides whether the dating is evidence or a
  // guess — how many of those names the dates the grid ended up with agree with
  // (columnDatingAgreement). Both halves are checked, because the grid's dates are
  // rebuilt from whichever of them survived and a header read in the dark side of a
  // photo can leave too few of either for that to be anything but a guess.
  const { named, agree } = columnDatingAgreement(parsed.columns);
  const dateTokens = parsed.columns.filter(c => c && c.date).length;
  // Corroboration is worth points: between two readings of one photo, the one
  // whose week is attested by the sheet's own day names is the one to believe.
  // Two points a name, because a column of the grid is worth one — a dating backed
  // by three names has to outrank a grid that found two extra (phantom) columns,
  // and it does.
  const score = cells * 4 + parsed.columns.length + (owner ? 12 : 0) - (sameDay ? 8 : 0)
    + agree * 2;
  return {
    words, found: !!owner, columns: parsed.columns.length, cells, score, sameDay, named, agree, dated: dateTokens,
    // Complete: a whole week's columns, the typed name on one of the rows, a dated
    // shift read off that row — and a header the week could actually be DATED
    // from, which needs three or more day names or three or more date tokens. Days
    // are Sunday→Saturday in order, so a grid whose dates rest on one surviving
    // token has one column's worth of evidence for seven columns' worth of
    // answer, and on a photo read in the dark that is how a week is paid a day
    // late. Anything less is worth another reading.
    // ... and a week the header can actually be dated from, which is the names
    // saying so rather than merely being present. Three names that agree are the
    // floor; a header that gave up fewer is judged on all of the few it gave (so
    // two names reading one week both count), and a header with no names at all
    // still needs three date tokens — the old rule, where it is still the right
    // one. What this replaces is `named >= 3 || dateTokens >= 3`, which accepted
    // SEVEN names of which two agreed, i.e. a header that describes no week.
    complete: !!(owner && parsed.columns.length >= 7 && cells >= 1 && !sameDay
      && (named === 0 ? dateTokens >= 3 : named >= 2 && agree >= Math.min(named, 3))),
    parsed,
  };
}

function isoLocalUTC(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

// ---------- OCR: the engine pool (browser only) ----------
// One worker per read in flight, rather than one worker for the whole scan. A
// scan is a ladder of independent readings of the same photo (see ocrRosterRow),
// and reading them one after another spent a whole ladder's wall clock on one
// core: three strips, then the page, then the page again through a threshold,
// each a whole image through a whole engine, none of them waiting on the last.
//
// The ceiling is three, not one per core, and that is about memory rather than
// CPU: every read in flight holds a working image of its own, and the reader
// upscales to a 12 MP budget, so each one is ~48 MB of RGBA on the main thread
// and again in the worker that reads it. Three is also all the widest batch
// asks for (three strips).
export const OCR_POOL_MAX = 3;
/**
 * How many workers to build on this machine. One fewer than it has cores, so
 * the UI keeps a core while the engine works, and never fewer than two: a single
 * worker is the one-after-another scan this pool exists to replace.
 */
export function ocrPoolSize(cores) {
  const n = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4;
  return Math.max(2, Math.min(OCR_POOL_MAX, n - 1));
}

/**
 * A FIFO pool of at most `size` workers, one read on each at a time.
 *
 * Reads on ONE worker are sequential by necessity: tesseract's settings — the
 * character whitelist, the page-segmentation mode — are state on the worker, so
 * two passes sharing one would read each other's configuration. Separate
 * workers have no such problem, which is what makes the pool safe. Workers are
 * created on demand up to the ceiling; a read that arrives with all of them busy
 * waits its turn.
 *
 * `create` is injected so the bookkeeping can be exercised without an engine
 * (see the pool section in scripts/test-tesco.mjs): spawn on demand, park a
 * caller when the pool is full, hand a freed worker to the longest-waiting
 * caller, and on dispose terminate everything that was ever created.
 */
export function createOcrPool({ create, size = 1 } = {}) {
  const cap = Math.max(1, Math.floor(size) || 1);
  const all = [];      // every worker created, for the one teardown
  const idle = [];     // workers with no read on them
  const waiters = [];  // acquire() calls parked for a worker
  let creating = 0;    // workers mid-start
  let closed = false;

  async function spawn() {
    creating++;
    try {
      const worker = await create();
      all.push(worker);
      return worker;
    } catch (err) {
      // A worker that would not start cannot serve the reads parked behind it
      // either, and leaving them parked would hang the scan. Fail them all with
      // the real reason; the next scan builds a fresh pool.
      for (const w of waiters.splice(0)) w.reject(err);
      throw err;
    } finally { creating--; }
  }

  async function acquire() {
    if (closed) throw new Error('The OCR pool is closed.');
    if (idle.length) return idle.pop();
    if (all.length + creating < cap) return spawn();
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function release(worker) {
    if (closed) return;
    const waiting = waiters.shift();
    if (waiting) waiting.resolve(worker);
    else idle.push(worker);
  }

  async function run(fn) {
    const worker = await acquire();
    try { return await fn(worker); } finally { release(worker); }
  }

  async function dispose() {
    closed = true;
    for (const w of waiters.splice(0)) w.reject(new Error('The OCR pool is closed.'));
    const workers = all.splice(0);
    idle.length = 0;
    await Promise.all(workers.map(w => {
      try { return Promise.resolve(w && w.terminate && w.terminate()).catch(() => {}); }
      catch { return null; }
    }));
  }

  return { run, acquire, release, dispose, get size() { return cap; } };
}

let _ocrPool = null;
// Both pools — the engine's above and the prep workers' below — are built lazily
// and torn down again as soon as a scan finishes (see disposeOcrWorker): the only
// place a decoded roster image could outlive the scan is a worker's heap, and
// destroying the workers is the cheapest way to be certain nothing lingers.
// Re-scanning re-inits the engine (~2-3s per worker, started together; the model
// itself is cached in IndexedDB, so nothing is re-downloaded) and re-fetches the
// prep worker's script, which the service worker has cached.
export async function disposeOcrWorker() {
  const pools = [_ocrPool, _ocrPrep];
  _ocrPool = null;
  _ocrPrep = null;
  await Promise.all(pools.filter(Boolean).map(p => p.dispose()));
}

// ---------- OCR: preparing a read, off the main thread ----------
// A read is prepared in three steps — draw the region at the engine's resolution,
// binarise it, encode it as the PNG tesseract.js is handed — and on a 12 MP strip
// the thread doing them is busy through 316–684 ms of the 1.4–1.8 s they take
// (measured interleaved with the version below, on one machine, with a
// MessageChannel ping loop). That is time the app cannot start the next reading,
// collect the last one, or repaint the bar: preparing a read was the one part of a
// scan that could not overlap the engine. So the threshold and the encode run on
// workers of its own (ocr-prep-worker.js) — 151–292 ms of longest stall, and
// 0.4–0.6 s of prep — and what stays here is the draw and the readback, which is
// where the pixels are and therefore the only place the image can be made the
// image it has always been.
//
// Three at most, and on a small machine fewer: the engine's pool keeps
// `ocrPoolSize(cores)` threads busy and the app needs one to stay alive, so prep
// may have what is left over. It never drops below one, because prep on the main
// thread is the thing this exists to stop — and even one worker lets the encode
// of one read overlap the engine's read of the last.
export const OCR_PREP_MAX = 3;
/** How many prep workers to build on a machine with `cores` cores. */
export function ocrPrepSize(cores) {
  const n = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4;
  return Math.max(1, Math.min(OCR_PREP_MAX, n - 1 - ocrPoolSize(n)));
}

/**
 * One prep worker, as the pool sees it: `post` one job and wait for its blob,
 * `terminate` to end it. Every reply is matched to its job by id, so the jobs a
 * batch sends at once cannot be answered out of order into each other.
 *
 * `open` is injected so the round trip can be exercised without a browser (see
 * the prep section in scripts/test-tesco.mjs): a job whose reply never arrives
 * must not park its reader for the rest of the scan, so a worker that dies — or a
 * postMessage that throws before the job left — fails every job waiting on it, at
 * once and with the real reason.
 */
export function createOcrPrepWorker(open = () => new Worker('/ocr-prep-worker.js', { type: 'module' })) {
  const worker = open();
  const pending = new Map();
  let seq = 0;
  let dead = null;   // the reason this worker will never answer again, if it died
  const failAll = err => {
    dead = err;
    for (const job of [...pending.values()]) job.reject(err);
    pending.clear();
  };
  worker.onmessage = event => {
    const res = event && event.data;
    const job = res && pending.get(res.id);
    if (!job) return;
    pending.delete(res.id);
    if (res.ok) job.resolve(res);
    else job.reject(new Error(res.error || 'The prep worker could not prepare that read.'));
  };
  // A worker whose script failed to load, or that died mid-job, says so as a
  // window error event rather than as a reply. Nothing is left waiting: a scan
  // that hangs is worse than one that fails with a reason.
  worker.onerror = event => {
    failAll(new Error((event && event.message) || 'The prep worker failed.'));
  };
  return {
    post(message, transfer = []) {
      // A worker that has already died must not park the next read behind it for
      // the length of the scan: the scan is failing, and it should say so now.
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, ...message }, transfer); }
        catch (err) { pending.delete(id); reject(err); }
      });
    },
    terminate() {
      failAll(new Error('The prep worker was closed.'));
      try { worker.terminate(); } catch { /* already gone */ }
    },
  };
}

let _ocrPrep = null;
function ensureOcrPrep() {
  if (!_ocrPrep) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
    _ocrPrep = createOcrPool({ create: createOcrPrepWorker, size: ocrPrepSize(cores) });
  }
  return _ocrPrep;
}
function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/tesseract/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine (vendor/tesseract/tesseract.min.js).'));
    document.head.appendChild(s);
  });
}
let _progressSink = () => {};
async function createOcrWorker() {
  await loadTesseractScript();
  const origin = window.location.origin;
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: `${origin}/vendor/tesseract/worker.min.js`,
    corePath: `${origin}/vendor/tesseract`,
    langPath: `${origin}/vendor/tesseract`,
    // tesseract.js otherwise wraps its worker in a blob URL, and inside a
    // blob-based worker a relative URL has no base to resolve against, so the
    // core cannot locate its .wasm sibling ("Failed to parse URL"). Loading the
    // worker from its real same-origin URL gives it a base, which is what lets
    // us ship the wasm as a plain file instead of the 3.9 MB base64-inlined
    // variant. That variant embeds the module as a data: URL the core loads,
    // which a strict connect-src blocks — it only worked here by falling back,
    // logging a CSP error per scan.
    workerBlobURL: false,
    logger: m => { if (m && typeof m.progress === 'number') _progressSink(m.progress); },
  });
  // How the engine is told to size its own layout work. A canvas carries no
  // resolution, so the engine assumes 70 dpi and — taking our upscaled page at
  // face value — treats a roster's 30px glyphs as a headline and its line
  // spacing as a paragraph gap. 300 is the truth for a sheet upscaled to the
  // 12 MP working budget (that is about A4 at 300 dpi), and it is what the line
  // and word heuristics are then measured against. Set once per worker, because
  // it describes the images every pass hands over.
  await worker.setParameters({ user_defined_dpi: '300' }).catch(() => {});
  return worker;
}
async function ensureOcrPool() {
  if (!_ocrPool) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
    _ocrPool = createOcrPool({ create: createOcrWorker, size: ocrPoolSize(cores) });
  }
  return _ocrPool;
}

// Draw the photo onto the display canvas (fit to `maxW`), releasing the decoded
// bitmap immediately. Used for the on-screen preview.
async function drawPhotoPreview(file, canvas, maxW = 720) {
  const buf = await file.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }), { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxW / bitmap.width);
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  // `willReadFrequently` on purpose, and it is the caller's canvas that makes it
  // matter: the app hands the SAME canvas to this preview and to ocrRosterRow as
  // its working surface, and a canvas only ever has one 2d context — the first
  // options object wins. Created without it here, every readback the reader then
  // does (one per strip, one per page pass, one per cell view) is served by a
  // GPU-backed surface and stalls on a readback, which the browser complains
  // about once per scan. The preview is drawn to once and read back dozens of
  // times, so the CPU-backed surface is the right one for it.
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
}

// ---------- OCR: reading the photo ----------
// The reading pipeline is three small pieces, each with one job:
//   ocrStripRanges()  where to look (overlapping half-height strips)
//   ocrStripWords()   read one strip at the resolution small glyphs need
//   ocrRosterRow()    read the sheet until a reading carries the typed name
//                     AND the week around it, and keep the best reading it took
// and one piece underneath them all: preparing a read's pixels, which happens on
// its own workers (ocrPrepSize, prepRead) so that it cannot hold the reader's
// thread while the engine works.
// Read one horizontal strip and return its words in ORIGINAL-image pixel
// coordinates, so strips read separately stitch into one shared space.
//
// strip: [y0, y1] as fractions of image height. The working image and the blob
// live only inside this call — the region is cut, prepared on a prep worker and
// read, and the worker's own surface goes with the scan. Nothing is written to
// storage, cache, or the network.
/**
 * How far the sheet is off square, in radians, read off the ink itself.
 *
 * The words can be levelled per row (see pageSkew) but the SHEET cannot: a page
 * photographed 3.5° off square carries its header half a week to the RIGHT of its
 * last staff row, because the two are 1000px apart down the page — 3.5° over
 * 1000px is 60px of sideways drift, a third of a day column. Nothing downstream
 * survives that: the day grid is dated off the header, the cells are read off
 * the rows, and every short token between them ("OFF" is 40px wide) then lands in
 * the neighbouring day's column. Rotating the photo level once, before anything
 * is read, is what makes the header and the rows share one frame.
 *
 * The angle is the one whose horizontal projection of the ink is sharpest: a
 * level line of text puts its whole stroke count into one row of the profile, a
 * tilted one smears it over as many rows as it drifts. Coarse scan then a refine
 * at a quarter of the step, on a downscaled grey copy — a few hundred thousand
 * pixels, so the whole search is cheap enough to run on every scan.
 *
 * The search reaches as far as the reader is willing to believe a sheet can be
 * held off square, and no further: ±8.5° is the same bound pageSkew puts on the
 * tilt it will trust from the words, and past it a sheet is not being read by a
 * phone held over it — it is being read sideways, which the quarter-turn path
 * handles by turning the whole photo instead. A narrower search is not safer, it
 * is just blind exactly where a photograph starts to be hard: a sheet 7° off
 * square delivers its header half a week to the left of its last staff row, and
 * an estimator that will not look past 6° reports the page as 6° and levels it
 * 1° wrong — every column then lands its crop just far enough off the line to
 * read the row above.
 *
 * Pure over a grey buffer (0 = black), so the estimate can be tested without a
 * camera. Returns the content's own rotation: rotate the image by -tilt to level
 * it.
 */
export function ocrEstimateTilt(grey, w, h, opts = {}) {
  const maxDeg = opts.maxDeg == null ? 8.5 : opts.maxDeg;
  const step = opts.step == null ? 0.5 : opts.step;
  if (!grey || !w || !h || grey.length < w * h) return 0;
  const cx = w / 2, cy = h / 2;
  const offset = Math.ceil(Math.hypot(w, h) / 2) + 2;
  const bins = new Float64Array(2 * offset + 2);
  const score = deg => {
    const t = deg * Math.PI / 180;
    const sin = Math.sin(t), cos = Math.cos(t);
    bins.fill(0);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      const dy = y - cy;
      for (let x = 0; x < w; x++) {
        if (grey[base + x] > 128) continue;          // paper
        // The y of this pixel in a frame rotated by -t, which is the frame the
        // page would be level in: a line written at the photo's own rotation of t
        // lands flat in it, and so stacks its ink into one bin.
        const i = Math.round(offset - (x - cx) * sin + dy * cos);
        if (i >= 0 && i < bins.length) bins[i] += 1;
      }
    }
    let sum = 0, sq = 0;
    for (let i = 0; i < bins.length; i++) { sum += bins[i]; sq += bins[i] * bins[i]; }
    return bins.length > 0 ? sq / Math.max(1, sum) : 0;
  };
  let best = 0, bestScore = -1;
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += step) {
    const s = score(deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  const fine = [best - step * 0.5, best, best + step * 0.5]
    .filter(d => d >= -maxDeg && d <= maxDeg)
    .map(d => ({ d, s: score(d) }))
    .sort((a, b) => b.s - a.s);
  return (fine[0] ? fine[0].d : best) * Math.PI / 180;
}

// The photo, decoded once for every pass that needs it (the strips, the page and
// the cells) instead of once each. `imageOrientation: 'from-image'` is what makes
// a phone photo taken in portrait arrive the right way up.
async function decodePhoto(file) {
  const buf = await file.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }), { imageOrientation: 'from-image' });
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

// The photo turned level, in a canvas big enough to hold the whole sheet at any
// angle the estimator accepts. Its own coordinates replace the photo's from here
// on, so every box the engine reports is in a frame the header and the rows both
// agree on.
async function levelPhoto(source, tilt) {
  const cv = document.createElement('canvas');
  const cos = Math.abs(Math.cos(tilt)), sin = Math.abs(Math.sin(tilt));
  const w = source.width, h = source.height;
  cv.width = Math.max(1, Math.round(w * cos + h * sin));
  cv.height = Math.max(1, Math.round(w * sin + h * cos));
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cv.width, cv.height);
  g.translate(cv.width / 2, cv.height / 2);
  g.rotate(-tilt);
  g.drawImage(source.bitmap, -w / 2, -h / 2, w, h);
  const bitmap = await createImageBitmap(cv);
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

// The photo turned a quarter turn. Half the roster photos people take are of a
// sheet held sideways (the sheet is landscape, the phone is not), and a page the
// engine sees rotated 90° is not a page it can read at all — but the same page
// turned back is. Tried only when nothing in the sheet's own orientation carried
// the typed name, so the cost falls on the scan that was failing anyway.
async function turnPhoto(source, turn = 90) {
  const cv = document.createElement('canvas');
  cv.width = source.height;
  cv.height = source.width;
  const g = cv.getContext('2d');
  g.translate(cv.width / 2, cv.height / 2);
  g.rotate(turn * Math.PI / 180);
  g.drawImage(source.bitmap, -source.width / 2, -source.height / 2, source.width, source.height);
  const bitmap = await createImageBitmap(cv);
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

// A small grey copy of the photo: long side 640 is enough to see a half-degree
// off square across a page and small enough to project 25 times, and the same
// shape serves the rule scan further up, which wants a little more resolution to
// separate two rules three pixels apart from one rule six pixels wide.
function greyThumb(source, maxEdge = 640) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff';
  c.fillRect(0, 0, w, h);
  c.drawImage(source.bitmap, 0, 0, w, h);
  const d = c.getImageData(0, 0, w, h).data;
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  }
  return { grey, w, h };
}

// How the photo is lit, from a small grey copy of it: whether the paper's own
// brightness is one flat wash or slides across the frame. Answered before any
// word is read, because it decides which image the engine is given (ocrIllumination).
function ocrPhotoLight(source) {
  try {
    const t = greyThumb(source, 320);
    return ocrIllumination(t.grey, t.w, t.h);
  } catch { return { spread: 0, paper: 255, ink: 0, uneven: false }; }
}

// The sheet's ruled grid in the source's own pixel coordinates, or null when the
// page does not print one the reader can trust (see ocrRulingLines,
// rosterColumnsFromRules). Marks rather than Sauvola: a rule is faint, and the
// glyph threshold is tuned to ask for a mark much darker than a hairline rule is.
function ocrPhotoRules(source) {
  try {
    const t = greyThumb(source, 1500);
    const marks = ocrLocalMarks(t.grey, t.w, t.h, {
      drop: 26,
      radius: Math.max(8, Math.round(Math.min(t.w, t.h) * 0.02)),
    });
    if (!marks.length) return null;
    const lines = ocrRulingLines(marks, t.w, t.h);
    if (!lines.v.length) return null;
    return {
      v: lines.v.map(x => x * (source.width / t.w)),
      h: lines.h.map(y => y * (source.height / t.h)),
    };
  } catch { return null; }
}

/**
 * The page as ink and paper, thresholded LOCALLY rather than globally.
 *
 * Everything above this point treats the photo's light as one number: a single
 * linear stretch of the whole frame (ocrAutoContrast). That is the right answer
 * for a sheet photographed in flat shade, and the wrong one for the sheet that
 * is really photographed — a lamp at one end, a window at the other, a phone's
 * own shadow across the bottom third. There the paper is at 200 grey in the light
 * and 120 in the shade, so no single threshold separates ink from paper anywhere
 * except in the band it was tuned for: the light end binarises to a solid black
 * slab and the dark end to blank white. A page read that way loses a whole
 * column of shifts.
 *
 * The engine's own binariser is the same global Otsu — tesseract's maintainers
 * describe it as "custom global Otsu without normalization" of "rather bad
 * quality", and it is what every segmentation and layout decision is made from,
 * even though recognition itself runs on the grey image. So the useful move is
 * the one this function makes: do the local threshold here, where the roster's
 * own geometry is known, and hand the engine a page that is already clean.
 *
 * Sauvola's rule, computed from two box means (see the sliding windows below):
 *
 *     T = m * (1 + k * (s / R - 1))
 *
 * A pixel is ink when it is darker than the mean `m` of the window it sits in,
 * by a margin that grows with the window's own standard deviation `s`. On bare
 * paper s is ~0, so T = m(1-k) and only a real mark survives; in a band of text s
 * is large, so T rises toward m and faint strokes in that band are still caught.
 * That is what makes it follow a lighting gradient — m moves with the light, and
 * the decision moves with it.
 *
 * `k = 0.24` and `R = 128` are the values Sauvola's own paper recommends and the
 * ones the document-binarisation literature converges on for photographed text.
 * Pure over a grey buffer (0 = black), so the threshold the reader uses can be
 * pinned without a camera. Returns 0 for ink and 255 for paper.
 */
/**
 * Ink as "meaningfully darker than the paper around it", by a fixed margin.
 *
 * The local threshold that reads a RULE, where ocrSauvola reads glyphs, and the
 * difference matters: Sauvola's margin grows with the window's own contrast, so
 * on the flat paper beside a hairline table rule it asks for a mark far darker
 * than the rule is — and a roster printed with light grey rules then comes back
 * with no grid at all, which is the one thing the grid is wanted for. A margin
 * fixed in grey levels asks the same question everywhere: is this pixel at least
 * `drop` below the paper it sits on? A faint rule says yes, paper texture says no.
 *
 * This is the classic mean − C adaptive threshold, and the background it subtracts
 * is a wide box mean — wider than any stroke, so it follows a lamp's hotspot and a
 * shadow across the sheet but never a glyph. Pure, over a grey buffer.
 */
export function ocrLocalMarks(grey, w, h, opts = {}) {
  if (!grey || !w || !h || grey.length < w * h) return new Uint8Array(0);
  const drop = opts.drop == null ? 30 : opts.drop;
  const r = Math.max(4, Math.min(96, Math.round(
    opts.radius == null ? Math.min(w, h) / 12 : opts.radius)));
  const out = new Uint8Array(w * h);
  ocrBoxWalk(grey, w, h, r, (x, y, m) => {
    out[y * w + x] = grey[y * w + x] < m - drop ? 0 : 255;
  });
  return out;
}

/**
 * How far the photo's own light is from being one flat wash.
 *
 * Which view a page wants is a question about the photo, and it is answerable
 * before anything is read: the paper's brightness in one corner versus another.
 * A sheet on a desk under a ceiling light is even, and there the global stretch
 * is right — it keeps the anti-aliased edge of every stroke, which is exactly
 * what the LSTM reads. A sheet with a window down one side is not, and there the
 * local threshold is the only thing that reads the dark third at all.
 *
 * Measured as the spread of the PAPER level between tiles, not of every pixel:
 * tiles are compared by their own high percentile, because paper is what most of
 * a tile is even when the tile holds a line of shifts, and because a percentile
 * ignores the ink rather than averaging it in. An even sheet's tiles come back
 * within a few grey levels of each other however much text they hold.
 *
 * Pure, so the choice can be pinned without a photo.
 */
export function ocrIllumination(grey, w, h, opts = {}) {
  if (!grey || !w || !h || grey.length < w * h) return { spread: 0, paper: 255, ink: 0, uneven: false };
  const tiles = Math.max(2, opts.tiles || 5);
  const unevenAt = opts.unevenAt == null ? 26 : opts.unevenAt;
  const hist = new Uint32Array(256);
  for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
  const totalPx = w * h;
  // The page's own paper level, for the ink share below.
  let acc = 0, paper = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= totalPx * 0.75) { paper = v; break; } }
  const t = tiles, lv = new Array(t * t).fill(null);
  for (let ty = 0; ty < t; ty++) {
    for (let tx = 0; tx < t; tx++) {
      const x0 = Math.floor(tx * w / t), x1 = Math.floor((tx + 1) * w / t);
      const y0 = Math.floor(ty * h / t), y1 = Math.floor((ty + 1) * h / t);
      const px = Math.max(1, (x1 - x0) * (y1 - y0));
      const tile = new Uint32Array(256);
      for (let y = y0; y < y1; y++) {
        const base = y * w;
        for (let x = x0; x < x1; x++) tile[grey[base + x]]++;
      }
      let a = 0;
      for (let v = 0; v < 256; v++) { a += tile[v]; if (a >= px * 0.8) { lv[ty * t + tx] = v; break; } }
      if (lv[ty * t + tx] == null) lv[ty * t + tx] = 255;
    }
  }
  const spread = Math.max(...lv) - Math.min(...lv);
  // A photo whose paper is dark as a whole is not "uneven" — it is underexposed,
  // and that is what ocrAutoContrast is for. Only the DIFFERENCE between tiles
  // asks for a local threshold.
  const ink = (() => {
    const cut = Math.max(40, paper - 60);
    let sum = 0;
    for (let v = 0; v < cut; v++) sum += hist[v];
    return sum / totalPx;
  })();
  return { spread, paper, ink, uneven: spread >= unevenAt };
}

/**
 * The sheet's ruled lines, read off the ink itself.
 *
 * A roster is a table, and a table printed with its rules on states its own
 * structure: the vertical lines ARE the column boundaries and the horizontal
 * ones are the row pitch, printed to within a pixel. Reading a day column off the
 * x of the day name printed over it instead is a guess that has to be right on a
 * tilted, glare-lit photo — the name is a 20px token, the engine boxes it ±10px, 
 * and the column it describes is 200px wide, so a 10px error is a tenth of a day.
 * The rule is a 1000px line and cannot be boxed wrong by more than the stroke.
 *
 * This is the classical document-analysis step (long dark run-lengths along and
 * across the page, the way a table-recognition pipeline finds its grid) and it is
 * cheap enough to run on every scan: two O(pixels) passes over a downscaled copy.
 *
 * A line is a run, not a count: a column of text also has ink in most of its
 * rows, and counting ink would mistake a dense column for a rule. A rule is a
 * CONTIGUOUS run covering most of the table's extent, which no column of text
 * has — glyphs leave gaps between them.
 *
 * Pure over a binary buffer (0 = ink), so the grid a photo is read with can be
 * pinned without a photo. Returns the line centres, left to right / top to bottom.
 */
export function ocrRulingLines(binary, w, h, opts = {}) {
  if (!binary || !w || !h || binary.length < w * h) return { v: [], h: [] };
  const vFrac = opts.vFrac == null ? 0.3 : opts.vFrac;
  const hFrac = opts.hFrac == null ? 0.35 : opts.hFrac;
  const minV = opts.minV == null ? Math.round(h * vFrac) : opts.minV;
  const minH = opts.minH == null ? Math.round(w * hFrac) : opts.minH;
  const v = ocrLineCentres(binary, w, h, true, minV, Math.max(1, Math.round(w * 0.006)));
  const hz = ocrLineCentres(binary, w, h, false, minH, Math.max(1, Math.round(h * 0.006)));
  return { v, h: hz };
}

// The centre of each run of adjacent scanlines (columns when `vertical`) that
// carries one contiguous stretch of ink at least `minRun` long. Adjacent hits
// merge into one line — a rule is 2-3px of stroke, not one.
function ocrLineCentres(binary, w, h, vertical, minRun, mergeWithin) {
  const outer = vertical ? w : h;
  const inner = vertical ? h : w;
  const step = vertical ? 1 : w;
  const at = (o, i) => (vertical ? binary[i * w + o] : binary[o * w + i]);
  const hits = [];
  for (let o = 0; o < outer; o++) {
    let run = 0, best = 0;
    for (let i = 0; i < inner; i++) {
      if (at(o, i) === 0) { run++; if (run > best) best = run; }
      else run = 0;
    }
    if (best >= minRun) hits.push(o);
  }
  const lines = [];
  for (const x of hits) {
    const last = lines[lines.length - 1];
    if (last && x - last[last.length - 1] <= mergeWithin) last.push(x);
    else lines.push([x]);
  }
  // The stroke's own centre, not its leading edge: a 3px rule read by its first
  // hit is a pixel and a half to the left of where the paper put it, and this
  // number becomes a cell boundary.
  return lines.map(run => (run[0] + run[run.length - 1]) / 2);
}

/**
 * The day columns the sheet's own rules draw, or null when they do not add up.
 *
 * Only ever a REFINEMENT of the grid the words already produced, never a
 * replacement for it: the words say how many days there are and which day each
 * one is, and this says exactly where each one ends. So a grid is accepted here
 * only when it agrees with the words twice over — seven day columns between the
 * name column and the table's right edge, and every column the words found
 * falling inside the rule span that claims it. Anything else (a sheet printed
 * without rules, rules the glare erased, a page of prose that happens to have a
 * long line in it) returns null and the caller keeps the grid it had.
 *
 * The name column's own right edge is a rule on every roster that has one, and it
 * is the boundary this most needs to get right: `rosterNameColumnRight` is what
 * separates the name from the first day, and a name that swallows "OFF" matches
 * nobody. Pure, so the acceptance rule can be pinned without a photo.
 */
export function rosterColumnsFromRules(vLines, cols, opts = {}) {
  const list = (cols || []).filter(c => c && Number.isFinite(Number(c.cx)));
  const lines = (vLines || []).filter(Number.isFinite).map(Number).sort((a, b) => a - b);
  if (!list.length || lines.length < 4) return null;
  const pitch = list.length > 1 ? (list[list.length - 1].cx - list[0].cx) / (list.length - 1) : 0;
  if (!(pitch > 0)) return null;
  // The name column's right edge: the last rule left of the first day column.
  const firstCx = list[0].cx;
  const nameEdge = [...lines].filter(x => x <= firstCx - pitch * 0.25).pop();
  if (!Number.isFinite(nameEdge)) return null;
  // Every rule from there on, minus the page's own outer border on the far side.
  const edges = [nameEdge];
  for (const x of lines) {
    if (x <= nameEdge + Math.max(4, pitch * 0.08)) continue;
    if (x - edges[edges.length - 1] < Math.max(4, pitch * 0.35)) continue;
    edges.push(x);
  }
  // Seven day columns need eight boundaries, and a roster that printed its last
  // column without closing it has seven.
  if (edges.length === list.length) edges.push(edges[edges.length - 1] + pitch);
  if (edges.length !== list.length + 1) return null;
  const bounds = edges.slice(0, -1).map((a, i) => [a, edges[i + 1]]);
  // Evenly spaced, or this is not a column grid: a title's own rule, a table with
  // a merged cell, or a page whose rules were read at the wrong pitch.
  const gaps = bounds.map(([a, b]) => b - a);
  const mid = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (!(mid > 0) || gaps.some(g => Math.abs(g - mid) > mid * 0.3)) return null;
  // The words have to fall where the rules say they do. This is the check that
  // makes the whole refinement safe: a grid that would move a column off the ink
  // it was read from is thrown away, and the caller keeps the grid the words gave.
  const agree = list.every((c, i) => c.cx >= bounds[i][0] - pitch * 0.2 && c.cx <= bounds[i][1] + pitch * 0.2);
  if (!agree) return null;
  return {
    bounds,
    centres: bounds.map(([a, b]) => ({ cx: (a + b) / 2 })),
    nameEdge,
    pitch: mid,
  };
}

// v5 keeps words on data.words; older builds and some images only fill blocks.
function tesseractWords(result) {
  const words = Array.isArray(result?.data?.words) ? result.data.words : [];
  if (words.length) return words;
  if (Array.isArray(result?.data?.blocks)) {
    return result.data.blocks.flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
  }
  return [];
}

/**
 * The working image one read is handed: which region of the photo to look at, the
 * size to draw it at, and the glyph window its threshold uses. Pure, so the one
 * place these numbers are decided can be pinned without a photo (see
 * scripts/test-tesco.mjs).
 *
 * Decided here rather than on the prep worker because the read's word boxes are
 * mapped back through them: `sx/sy/sw/sh` are the region, `w/h` the working image
 * it becomes, and `w/h` against `sw/sh` is the factor every coordinate coming back
 * from the engine is scaled by. A box computed in two places is a box that can
 * disagree with itself.
 *
 * Upscale toward the factor that works, capped by the working budget. A small
 * photo is the one case that wants more than 2× — its glyphs are 20px tall and a
 * shift's own digits are what the engine gets wrong at that size — and the budget
 * already stops the upscale from costing more than one working image.
 */
export function ocrStripBox(imgW, imgH, strip, work = OCR_WORK_PIXELS) {
  const sy = Math.max(0, Math.round(strip[0] * imgH));
  const sh = Math.max(24, Math.min(imgH - sy, Math.round((strip[1] - strip[0]) * imgH)));
  const scale = Math.max(0.5, Math.min(3, Math.sqrt(work / Math.max(1, imgW * sh))));
  const w = Math.max(1, Math.round(imgW * scale));
  const h = Math.max(1, Math.round(sh * scale));
  return {
    sx: 0, sy, sw: imgW, sh, w, h, scale,
    // A strip is a third of a page wide and full width, so the window that reads
    // its glyphs is sized from the glyphs themselves: about three of them, which
    // is wider than a stroke and narrower than a word.
    radius: Math.max(10, Math.round(h * 0.035)),
  };
}

/** The same for the whole-page pass: the entire sheet at the working budget. */
export function ocrPageBox(imgW, imgH, work = OCR_WORK_PIXELS) {
  const scale = Math.max(0.5, Math.min(3, Math.sqrt(work / Math.max(1, imgW * imgH))));
  const w = Math.max(1, Math.round(imgW * scale));
  const h = Math.max(1, Math.round(imgH * scale));
  return {
    sx: 0, sy: 0, sw: imgW, sh: imgH, w, h, scale,
    // The whole page is where a roster's grid lives: ~30px glyphs on a sheet whose
    // long side is up to 3× the working budget, so the window is the glyph band.
    radius: Math.max(12, Math.round(w * 0.02)),
  };
}

/**
 * One read's image, prepared where it cannot block the reader.
 *
 * The draw and the readback stay here, because that is where the pixels are: the
 * same `drawImage` with the same source rectangle on the same canvas as before
 * the encode moved, so the image the engine ends up reading is the image it was
 * always handed, pixel for pixel. Everything after the readback — the threshold,
 * and the PNG encode that is the expensive half of a strip read — goes to a prep
 * worker (ocr-prep-worker.js), and the buffer is transferred rather than copied,
 * so this thread's part ends at the post.
 *
 * Handing the worker a cropped bitmap to draw itself would be cheaper (5 ms of
 * this thread, the whole prep on the worker) and it was measured to shift 1,716
 * pixels of a 12 MP strip by up to three grey levels — `drawImage` resamples a
 * source rectangle and a pre-cut image slightly differently — which flipped the
 * harness's `blurry` scenario through the cell pass. Three grey levels on 0.01 %
 * of the pixels is not a difference this reader can afford.
 */
async function prepEncode(prep, source, box, view = 'stretch') {
  const canvas = ocrScratchCanvas();
  try {
    canvas.width = Math.max(1, box.w);
    canvas.height = Math.max(1, box.h);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(source.bitmap, box.sx, box.sy, box.sw, box.sh, 0, 0, box.w, box.h);
    const img = c.getImageData(0, 0, box.w, box.h);
    const read = await prep.post(
      { type: 'binarise', data: img.data.buffer, w: box.w, h: box.h, view, radius: box.radius },
      [img.data.buffer],
    );
    return read.blob;
  } finally {
    // Runs on every path — a draw that threw, a worker that died mid-read, a
    // cancelled scan — so this read's copy of the photo never outlives it.
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Take a prep worker for the length of one read, so its surface belongs to that
// read alone — and so a batch of reads does not queue on one prep worker while
// the others sit idle.
function prepRead(pool, source, box, view = 'stretch') {
  return pool.run(prep => prepEncode(prep, source, box, view));
}

// A drawing surface for one read in flight. The ladder's own reads (the strips and
// the pages) have their surfaces made on a prep worker now; the cell pass still
// draws here, and each read of it owns its surface for the same reason it always
// did: a read is two awaits long (the blob, then recognize), so two reads sharing
// one canvas would have the second draw over the first before it was ever encoded.
function ocrScratchCanvas() { return document.createElement('canvas'); }

async function ocrStripWords(worker, prep, source, strip, view = 'stretch') {
  const box = ocrStripBox(source.width, source.height, strip);
  const blob = await prepRead(prep, source, box, view);
  const result = await worker.recognize(blob);
  // Nothing is zeroed on the way out any more, because nothing here held pixels:
  // the region was cut, prepared elsewhere and read, and the prep worker's own
  // surface is released with the scan (see disposeOcrWorker).
  const kx = box.sw / box.w, ky = box.sh / box.h;
  return tesseractWords(result).map(w => ({
    text: w.text,
    x0: (w.bbox?.x0 ?? 0) * kx, x1: (w.bbox?.x1 ?? 0) * kx,
    y0: box.sy + (w.bbox?.y0 ?? 0) * ky, y1: box.sy + (w.bbox?.y1 ?? 0) * ky,
    confidence: w.confidence,
  }));
}

// Read the WHOLE photo in one pass, in image pixel coordinates.
//
// The strip pass is the cheap path — each strip holds the upscale small glyphs
// need while staying inside the working budget — but it costs the engine the
// page: a strip that starts below the header holds no title, no date band and no
// column headings, and on a sheet that is two or three degrees off square the
// layout analysis has nothing to straighten against, so it can box a whole
// column of one row as a single tall blob instead of reading it line by line.
// A row in that band is invisible to the strip pass: the typed name is simply
// not among its words, however legible the photo is. This pass gives the engine
// the sheet's own layout, and is what the reader falls back to when the strips
// have not found the row.
async function ocrPageWords(worker, prep, source, opts = {}) {
  const { view = 'stretch', psm = null } = opts;
  const box = ocrPageBox(source.width, source.height);
  const blob = await prepRead(prep, source, box, view);
  if (psm) await worker.setParameters({ tessedit_pageseg_mode: psm });
  const result = await worker.recognize(blob);
  const k = box.sw / box.w;
  return tesseractWords(result).map(w => ({
    text: w.text,
    x0: (w.bbox?.x0 ?? 0) * k, x1: (w.bbox?.x1 ?? 0) * k,
    y0: (w.bbox?.y0 ?? 0) * k, y1: (w.bbox?.y1 ?? 0) * k,
    confidence: w.confidence,
  }));
}

// The vertical slices the photo is read in: half-height strips starting at 0,
// 25% and 50%, so consecutive strips overlap by half and no row is ever cut in
// two by a strip boundary.
export function ocrStripRanges(count = OCR_STRIP_COUNT, height = OCR_STRIP_H) {
  const span = Math.max(0, 1 - height) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const start = Math.min(i * span, Math.max(0, 1 - height));
    return [start, Math.min(1, start + height)];
  });
}

// ---------- OCR: reading the owner's row, cell by cell ----------
// A strip read is cheap and finds the header and the typed name, but its word
// boxes cannot be trusted on a tall, glare-lit photo — tesseract reported a
// six-letter name as a 126px-tall box on the sample roster — and a roster's
// cells are ~30px glyphs, so cropping "to the box" lands beside the text as
// often as on it. The owner's row is therefore re-read the way a person reads a
// row: one cell at a time, each crop aligned to the ink of its own column. That
// also follows a tilted sheet, which a whole-width strip read cannot.
const OCR_CELL_UPSCALE = 3;    // one cell is ~0.3 MP: the 12 MP working budget is never near
const OCR_CELL_BG = 18;        // "darker than its own row's average by this much" = ink
const OCR_CELL_BG_FAINT = 8;   // for a cell in glare, where 18 finds no glyphs at all
// A cell is looked at through these views, best first, until one reads back as a
// shift. Flat-field first: it is the only one that survives glare.
const OCR_CELL_MODES = ['local', 'ink', 'grey'];

/**
 * Run one read — or one column's few reads — on a surface of its own, drawn into
 * by `fn` and released here. Two reads sharing a canvas is the one thing the pool
 * cannot survive (see ocrScratchCanvas), so a read that the pool hands a worker
 * is handed a surface with it.
 */
function ocrOnScratch(pool, fn) {
  return pool.run(async worker => {
    const surface = ocrScratchCanvas();
    try { return await fn(worker, surface); }
    finally { surface.width = 0; surface.height = 0; }
  });
}

/**
 * The same word, read twice.
 *
 * The strips overlap by half so that no row is ever cut in two, which means the
 * rows in that overlap are read by two strips and their words arrive twice — at
 * slightly different boxes, because each strip gives the engine a different
 * amount of its own line to lay out. Left in, the copies double every row the
 * reader has to group, two copies of the same word can fork one staff row into
 * two (the name in one, the shifts in the other), and a duplicated cell can win
 * the same column twice. Same text, overlapping boxes, one line apart at most:
 * the copy with the higher confidence is the one kept.
 */
export function dedupeWords(words = []) {
  const kept = [];
  const byText = new Map();
  for (const w of [...words].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    if (!w || ![w.x0, w.y0, w.x1, w.y1].every(Number.isFinite)) continue;
    const key = String(w.text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!key) continue;
    const list = byText.get(key) || [];
    const cy = (w.y0 + w.y1) / 2, h = Math.max(4, w.y1 - w.y0);
    const dupe = list.some(o => Math.abs((o.y0 + o.y1) / 2 - cy) <= h * 0.6 && w.x0 < o.x1 && o.x0 < w.x1);
    if (dupe) continue;
    list.push(w);
    byText.set(key, list);
    kept.push(w);
  }
  return kept;
}
// A cell holds a range of hours or a rest word, nothing else — telling the
// engine so removes most of its wrong answers ("17-22" for "17-22.").
const OCR_CELL_CHARS = '0123456789:-·. oOffFhHaAlLnNsSwW/()';

// "Ink" is what is meaningfully darker than its own row's average — not a fixed
// level. That is what makes glare, the photo's brightness gradient and the
// sheet's horizontal rule lines all disappear: a rule darkens a whole row, so
// nothing in that row is darker than its own mean.
function rowInkCut(d, w, y, bg = OCR_CELL_BG) {
  const base = y * w * 4;
  let sum = 0;
  for (let x = 0; x < w; x++) sum += d[base + x * 4];
  return sum / w - bg;
}

// One cell as the engine wants it: glyphs upscaled to the size tesseract reads
// reliably, then binarised against each row's own average so glare, gradient and
// shadow all cancel instead of hardening into speckle.
function ocrCellImage(bitmap, canvas, box, scale, mode, bg = OCR_CELL_BG) {
  const w = Math.max(16, Math.round((box.x1 - box.x0) * scale));
  const h = Math.max(16, Math.round((box.y1 - box.y0) * scale));
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingQuality = 'high';
  c.drawImage(bitmap, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  if (mode === 'grey') {
    // The same cell as plain grey, stretched to full contrast: a second view
    // for a glyph the binarised one loses (a thin "1", a faint hyphen).
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
    const total = w * h;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
    const span = Math.max(24, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, Math.round(((d[i] - lo) / span) * 255)));
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  } else if (mode === 'local') {
    // Flat-field the cell: compare every pixel with the paper brightness around
    // it, estimated by a box blur, so a glyph reads as dark against its own
    // surroundings wherever the glare happens to be. This is the one view that
    // survives a photo shot through a reflection.
    ocrFlatField(d, w, h);
  } else {
    for (let y = 0; y < h; y++) {
      const cut = rowInkCut(d, w, y, bg);
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = base + x * 4;
        const v = d[i] < cut ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
  }
  c.putImageData(img, 0, 0);
}

// Remove the paper's own brightness from a cell. The background is a box blur of
// the crop — far wider than a stroke, so it follows glare and shadow but not the
// glyphs — and what is left is scaled so the darkest one percent of the crop
// reads as full black. In place, on the image data.
export function ocrFlatField(d, w, h) {
  const n = w * h;
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) grey[i] = d[i * 4];
  const r = Math.max(8, Math.min(Math.round(Math.min(w, h) * 0.6), Math.round(w / 4)));
  const span = 2 * r + 1;
  const clampX = x => (x < 0 ? 0 : x >= w ? w - 1 : x);
  const clampY = y => (y < 0 ? 0 : y >= h ? h - 1 : y);
  const tmp = new Float32Array(n), bg = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += grey[base + clampX(x)];
    for (let x = 0; x < w; x++) {
      tmp[base + x] = sum / span;
      sum += grey[base + clampX(x + r + 1)] - grey[base + clampX(x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clampY(y) * w + x];
    for (let y = 0; y < h; y++) {
      bg[y * w + x] = sum / span;
      sum += tmp[clampY(y + r + 1) * w + x] - tmp[clampY(y - r) * w + x];
    }
  }
  const diff = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, bg[i] - grey[i]));
    diff[i] = v;
    hist[Math.round(v)]++;
  }
  let acc = 0, peak = 12;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * 0.01) { peak = Math.max(12, v); break; }
  }
  const gain = 255 / peak;
  for (let i = 0; i < n; i++) {
    const v = Math.round(255 - Math.min(255, diff[i] * gain));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
}

async function ocrReadCell(worker, bitmap, canvas, box, opts = {}) {
  const { accept = () => false, bg = OCR_CELL_BG, chars = '' } = opts;
  if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) return { text: '', confidence: 0 };
  // Both of these are state on the WORKER, and a cell read now lands on whichever
  // worker the pool hands it — so everything the read needs from the engine is set
  // with the read rather than left for the pass to have set once. '7' is "single
  // text line", which is exactly what one cell is (see OCR_CELL_MODES).
  await worker.setParameters({ tessedit_char_whitelist: chars, tessedit_pageseg_mode: '7' });
  try {
    let best = { text: '', confidence: 0 };
    for (const mode of OCR_CELL_MODES) {
      ocrCellImage(bitmap, canvas, box, OCR_CELL_UPSCALE, mode, bg);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const res = await worker.recognize(blob);
      const read = {
        text: String(res?.data?.text || '').replace(/\s+/g, ' ').trim(),
        confidence: Math.round(res?.data?.confidence ?? 0),
      };
      if (read.text && read.confidence > best.confidence) best = read;
      // A read the caller can use ends the search; otherwise the cell is looked at
      // again through the other view of the same glyphs before giving up on it.
      if (read.text && accept(read.text)) return read;
    }
    return best;
  } finally {
    // The whitelist is a property of the cell pass, and the name read shares
    // this worker: left set, it would restrict every later read too.
    if (chars) await worker.setParameters({ tessedit_char_whitelist: '' }).catch(() => {});
  }
}

// Read the row the typed name sits on, cell by cell. Returns the cells it read
// (already in the shape parseRosterWords emits, dated off the same grid) and
// whether every column of that grid was attempted.
//
// The name and the day columns are read at the same time. They are independent
// readings of one row — the name confirms WHICH row, the columns say what is on
// it — and the crops are all cut from the same words before any read starts, so
// the confirmation no longer holds the week behind it. The day the owner does not
// work is exactly the day left blank, so the tail of every scan is the pass with
// the most to read and the least to say: on a seven-column week that is eight
// reads, which one worker used to take in turn. Reading a name the row does not
// carry costs nothing extra — the columns are read either way, and a pass that
// cannot confirm its row merges with the strip pass instead of replacing it.
async function ocrOwnerCells(pool, source, opts = {}) {
  const { name, nameWord, cols, rowWords = [], medianH = 24, skew = null, progress, ruleGrid = null } = opts;
  const bitmap = source.bitmap;
  const imgW = source.width, imgH = source.height;
  // Where each day starts and ends: the sheet's own ruled lines when they add
  // up (rosterColumnsFromRules), the day names' own positions otherwise. The
  // rules are the better answer by a lot — a 1000px line cannot be boxed wrong
  // the way a 20px day name can — and because the rule grid is only accepted if
  // every column the words found falls inside the span that claims it, taking it
  // can only straighten a cell's crop, never move it onto the wrong day.
  const bounds = (ruleGrid && ruleGrid.bounds) || rosterColumnBounds(cols);

  // Every crop is aimed by where the strip pass saw the ink, not by where the
  // grid guessed it would be. A word box's HEIGHT can be nonsense under glare —
  // that is why the row is not cropped to one word — but the union of a line's
  // words is the text's own position, and a cell re-read inside its own glyphs
  // cannot clip a long shift the way a grid box can (measured on the sample
  // roster: the grid cell was 12px narrower than the text at each end, which is
  // exactly where "07:00-15:00" keeps its two outermost digits).
  const band = rowWords.filter(w => [w.x0, w.y0, w.x1, w.y1].every(Number.isFinite));
  const boxOf = list => ({
    x0: Math.min(...list.map(w => w.x0)), y0: Math.min(...list.map(w => w.y0)),
    x1: Math.max(...list.map(w => w.x1)), y1: Math.max(...list.map(w => w.y1)),
  });
  // A crop with room around its glyphs: sideways enough to keep a stray
  // character of the column beside it out of frame, vertically enough to hold a
  // descender — while staying well inside the row above and below.
  const crop = box => {
    const padX = Math.max(2, medianH * 0.3);
    const cy = (box.y0 + box.y1) / 2;
    const halfH = Math.max(medianH * 0.75, (box.y1 - box.y0) / 2 + medianH * 0.25);
    return {
      x0: Math.max(0, box.x0 - padX), x1: Math.min(imgW, box.x1 + padX),
      y0: Math.max(0, cy - halfH), y1: Math.min(imgH, cy + halfH),
    };
  };
  const nameRight = rosterNameColumnRight(bounds);
  const nameParts = band.filter(w => (w.x0 + w.x1) / 2 < nameRight);
  const rowCy = (nameWord.y0 + nameWord.y1) / 2;
  // The row's own line, from the two ends of its words: a crop for a column the
  // strip pass saw nothing in has to sit on the line AT THAT COLUMN'S x, which
  // on a tilted page is not where the name is (90px apart at 3° across a page).
  //
  // The tilt comes from the page, not from this row's own two ends. A row whose
  // right-hand cells the strip pass missed leaves a span half a week wide, and a
  // slope fitted to that span lands the crop for the missing columns tens of
  // pixels off the line — over a row's own height, which is exactly enough to
  // read the sheet's rule instead of the shift that is there. See pageSkew.
  const lineYAt = (() => {
    if (band.length < 2) return () => rowCy;
    const cx = w => (w.x0 + w.x1) / 2, cy = w => (w.y0 + w.y1) / 2;
    const slope = skew != null ? Math.max(-0.15, Math.min(0.15, skew))
      : (() => {
        const sorted = [...band].sort((a, b) => cx(a) - cx(b));
        const a = sorted[0], b = sorted[sorted.length - 1];
        const span = cx(b) - cx(a);
        return span <= 0 ? 0 : Math.max(-0.15, Math.min(0.15, (cy(b) - cy(a)) / span));
      })();
    const base = band.reduce((s, w) => s + (cy(w) - slope * cx(w)), 0) / band.length;
    return x => base + slope * x;
  })();

  // Confirm the row by reading its name, one word at a time: the strip carries
  // the band column beside the name ("Parth 20"), which no whole-line compare
  // survives. The crop is the name column as this photo has it — the words the
  // strip pass found left of the first day — not a width guessed from the column
  // pitch, which on the sample roster started 140px into the name and read back
  // "harma".
  progress(0.86, 'Checking your name on this row');
  const nameBox = nameParts.length
    ? crop(boxOf(nameParts))
    : crop({ x0: nameWord.x0, y0: nameWord.y0, x1: nameWord.x1, y1: nameWord.y1 });
  const nameTask = ocrOnScratch(pool, (worker, surface) =>
    ocrReadCell(worker, bitmap, surface, nameBox,
      { accept: text => String(text).split(/\s+/).some(w => nameMatches(w, name)) }))
    .then(read => {
      const validated = String(read.text || '').split(/\s+/).filter(Boolean).some(w => nameMatches(w, name));
      if (!validated) progress(0.87, 'That row does not carry your name');
      return validated;
    });

  // One job per day column, in column order, and the pool decides how many of
  // them read at once.
  const readable = cols.filter((_, i) => bounds[i] && bounds[i][1] - bounds[i][0] > 20).length;
  let done = 0;
  const readColumn = (i, x0, x1) => {
    // The words that landed in this column, rules and all: a token that is pure
    // punctuation is a rule line the engine dressed as text, so it carries no
    // glyphs and is left out of the box its neighbours are measured by.
    const own = band.filter(w => {
      const cx = (w.x0 + w.x1) / 2;
      return cx >= x0 && cx < x1 && isGlyphToken(w.text);
    });
    // A column with no words of its own is a day the strip pass found nothing
    // on — a day off, or one it missed. Its crop is the grid cell this time, so
    // the silence is still heard and "nothing here" stays a real answer.
    const columnLine = lineYAt((x0 + x1) / 2);
    const box = own.length
      ? boxOf(own)
      : { x0, x1, y0: columnLine - medianH, y1: columnLine + medianH };
    return ocrOnScratch(pool, async (worker, surface) => {
      let parsed = null, read = { text: '', confidence: 0 };
      // Two sensitivities: the cell's own ink cut, then a fainter one for a cell
      // sitting in the photo's glare, where the glyphs are washed out and the
      // first cut finds nothing. Only a cell that fails pays for the second look.
      for (const bg of [OCR_CELL_BG, OCR_CELL_BG_FAINT]) {
        read = await ocrReadCell(worker, bitmap, surface, crop(box), {
          accept: text => parseTimeCell(text) || /^\s*(off|hol|n\/?a)\b/i.test(text),
          bg, chars: OCR_CELL_CHARS,
        });
        // One line of one cell, so the tolerant cell grammar applies unchanged —
        // a rule's edge riding along in the crop no longer costs the shift.
        parsed = read.text ? parseCellTokens([{ text: read.text, x0: 0, x1: 1, confidence: read.confidence }], 0) : null;
        if (parsed) break;
      }
      if (!parsed) return null;
      const col = cols[i];
      return {
        date: col && col.date ? isoLocalUTC(col.date) : null,
        weekday: col && col.date ? col.date.getUTCDay() : (col && col.weekday != null ? col.weekday : null),
        startMin: parsed.startMin, endMin: parsed.endMin,
        raw: read.text, confidence: read.confidence, dupe: false,
      };
    }).finally(() => {
      // The day is reported as it arrives, so the bar walks the week as the reads
      // come back rather than pretending one of them is the only one running.
      done++;
      progress(0.88 + (done / readable) * 0.1, `Read ${done} of ${readable} shifts`);
    });
  };
  const columns = cols.map((_, i) => {
    const span = bounds[i];
    return span && span[1] - span[0] > 20 ? readColumn(i, span[0], span[1]) : null;
  });
  const jobs = [nameTask, ...columns];
  // A read that throws still ends the scan, but its siblings are in flight: a
  // rejection nobody is left waiting for is an error the user never asked to see.
  const [validated, ...readCells] = await Promise.all(jobs).catch(err => {
    for (const p of jobs) if (p) p.catch(() => {});
    throw err;
  });
  const cells = readCells.filter(Boolean);
  // "Complete" only once the row itself is confirmed: a full grid read off the
  // wrong row would otherwise replace the matched row's cells with another
  // person's shifts. Unconfirmed, the pass merges instead of replacing.
  return { cells, complete: !!validated && cols.length >= 7 };
}

// Find the user's row and read it, without asking them to frame it.
//
// Roster photos are handed round, shot at an angle or taken through glare, and
// "drag a band across your row" is the one step that breaks when they are. The
// strips are read top-down instead — the first always carries the date header
// at the top of the sheet — so the common scan is two reads: header, then row.
// Every word comes back in image-pixel coordinates for parseRosterWords() to
// turn into dated cells.
//
// The strips are the CHEAP reading, not the deciding one. Each reading the photo
// is given is scored on what it actually produced and the best is kept
// (rosterReadQuality), so the reader escalates — page, then a locally-thresholded
// page, then the photo turned a quarter turn — until one comes back whole. A
// reading that merely mentions the typed name no longer ends the scan: a read can
// carry the name and still put the week's shifts on the wrong days.
//
// The worker pools are built here and torn down in the same breath: a worker's
// heap is the one place a decoded image could outlive the scan, so dropping the
// workers covers success, a throw mid-scan, and a scan that found nothing. Each
// rung of the ladder is a BATCH of independent readings of one photo — the three
// strips, then the plain page and the thresholded one, then the two quarter turns
// — taken together on the pool and believed in the order the one-after-another
// ladder reached them, so the batch buys the wall clock back and nothing else
// (see createOcrPool). Each reading's pixels are prepared on a second, smaller
// pool of prep workers on the way (see ocrPrepSize), which is what keeps the
// reader's own thread free while a strip is being drawn, thresholded and encoded.
export async function ocrRosterRow(file, canvas, opts = {}, onProgress) {
  const name = String(opts.name || '');
  const today = opts.today || new Date();
  const progress = onProgress || (() => {});
  const ranges = ocrStripRanges();
  const words = [];
  let scanned = 0, found = false, pagePass = false;
  let cells = [], cellsComplete = false;
  // Every reading of this photo the reader accepted as an answer, in the order
  // they were taken, with the score each one earned (rosterReadQuality).
  const tries = [];
  progress(0.02, 'Reading photo');
  let decoded = null, leveled = null;
  try {
    const pool = await ensureOcrPool();
    const prep = await ensureOcrPrep();
    decoded = await decodePhoto(file);
    // Level the sheet before anything is read off it, so its header and its staff
    // rows share one frame (see ocrEstimateTilt). Under a third of a degree is
    // under 5px across a page — below what the grid needs, and not worth a second
    // copy of the photo.
    let source = decoded;
    try {
      const thumb = greyThumb(source);
      const tilt = ocrEstimateTilt(thumb.grey, thumb.w, thumb.h);
      if (Math.abs(tilt) > 0.006) {
        leveled = await levelPhoto(source, tilt);
        source = leveled;
      }
    } catch { /* an unreadable thumbnail is read unlevelled, as before */ }
    let best = null;
    /**
     * Offer a reading of the photo. Keeps it if it is the best so far and says
     * whether the reader can stop: only a reading that came back whole ends the
     * search, so a read that merely mentions the name no longer does.
     */
    const consider = (tag, list) => {
      // The strip overlap reads each row twice, so the dedupe happens here, once
      // per reading, before anything is judged or built on top of it.
      const q = rosterReadQuality(dedupeWords(list), name, today);
      tries.push({ tag, words: q.words.length, columns: q.columns, cells: q.cells, score: q.score, complete: q.complete, found: q.found, named: q.named, agree: q.agree, dated: q.dated });
      if (q.words.length && (!best || q.score > best.score)) best = q;
      return q;
    };
    let settled = false;
    // The strips are three independent readings of one sheet, so the pool takes
    // all three at once: a row that sits in the last strip then costs one strip's
    // wait instead of three. What is KEPT is exactly what the one-after-another
    // loop kept — every strip up to and including the first that carries the typed
    // name — because the three reads the pool ran are the same three reads, and the
    // ones after the name was found were in flight, not extra evidence. So the
    // answer, the reads counted behind it and the bar are the old loop's, and only
    // the waiting is gone.
    {
      let done = 0;
      // Three reads in flight have no single 0→1 for the engine's own progress to
      // fill, so the bar steps once per strip finished rather than sliding.
      _progressSink = () => {};
      progress(0.1, `Scanning the photo for your row`);
      const readStrip = async strip => {
        try {
          return await pool.run(worker => ocrStripWords(worker, prep, source, strip));
        } finally {
          done++;
          progress(0.1 + (done / ranges.length) * 0.75, `Scanned part ${done} of ${ranges.length}`);
        }
      };
      const strips = ranges.map(readStrip);
      // A read that throws still ends the scan, as it did when they ran one after
      // another — but its siblings are in flight, and a rejection nobody is left
      // waiting for is an error the user never asked to see (and, once the pool is
      // torn down under it, one about a worker that was terminated, which reads
      // like a bug in the app). So the batch is collected before the failure goes on.
      const reads = await Promise.all(strips).catch(err => {
        for (const p of strips) p.catch(() => {});
        throw err;
      });
      for (const read of reads) {
        words.push(...read);
        scanned++;
        // The strips only have to FIND the row — it is the whole-page reads that
        // settle which reading of the photo is believed, below.
        if (name && read.some(w => nameMatches(w.text, name))) break;
      }
    }
    settled = consider('strips', words).complete;
    // Not settled: read the sheet whole, and read it as a grid at the same time. A
    // strip has no page around it to be laid out against, and on an off-square
    // photo that is what makes the engine drop a whole row (see ocrPageWords) — and
    // on a photo lit from one side the strips find the name on a row whose day
    // cells have slid into the columns beside it. The two readings answer that one
    // question — the whole page, and the IMAGE changed rather than the request: a
    // locally-thresholded page when the shot is lit unevenly (a lamp one side, a
    // shadow the other), and sparse text mode either way, which is the
    // page-segmentation setting for exactly this content ("find as much text as
    // possible in no particular order" is a table said in Tesseract's own words).
    //
    // Read one after the other, the plain page's answer was the price of the
    // thresholded one's question: on the harness's own lamp scenario the plain page
    // reads 0 columns, so that whole first read was wait. They are taken together
    // now, and only the readings the ladder would have reached are believed, in the
    // order it would have reached them, so the answer is the one it gave.
    if (name && !settled) {
      const light = ocrPhotoLight(source);
      const altTag = light.uneven ? 'page-ink' : 'page-sparse';
      _progressSink = () => {};
      progress(0.87, light.uneven
        ? 'Reading the whole page, and evening out the light'
        : 'Reading the whole page, and its grid');
      const pages = [
        pool.run(worker => ocrPageWords(worker, prep, source)),
        pool.run(worker => ocrPageWords(worker, prep, source, { view: light.uneven ? 'ink' : 'stretch', psm: '11' })),
      ];
      const [page, alt] = await Promise.all(pages).catch(err => {
        for (const p of pages) p.catch(() => {});
        throw err;
      });
      pagePass = true;
      scanned++;
      settled = consider('page', page).complete;
      // The grid reading is an answer only if the ladder would have got to it, and
      // by then it was taken long ago.
      if (!settled) { scanned++; settled = consider(altTag, alt).complete; }
    }
    // Still not settled, and the likeliest reason by far is a sheet photographed
    // sideways: turn it back a quarter turn and read the page again. Both quarter
    // turns are taken at once — half the roster photos people take are of a
    // landscape sheet in a portrait hand, and this is the rung that decides those
    // — and whichever frame reads best is the frame everything else is read in.
    // Believed in the ladder's own order, so a photo that reads upright is not
    // re-read upside down: only the frames the ladder would have reached are scored.
    if (name && !settled) {
      const turns = [90, -90];
      progress(0.93, 'Turning the photo up the other way');
      _progressSink = () => {};
      const frames = await Promise.all(turns.map(turn => turnPhoto(source, turn)));
      let won = -1;
      try {
        // The mode is named rather than inherited. Page-segmentation mode is state
        // on the worker, and with more than one worker a read lands on whichever is
        // free — so left unset, a turned page would be read in whatever mode the
        // rung before it happened to leave on that worker, which is not a decision
        // at all. Sparse text is the mode the ladder has always brought here ('11',
        // set by the rung that ran just before these) and the harness reads the
        // sideways photos in it, so it is what a turned page is read in.
        const turned = frames.map(frame => pool.run(worker => ocrPageWords(worker, prep, frame, { psm: '11' })));
        const reads = await Promise.all(turned).catch(err => {
          for (const p of turned) p.catch(() => {});
          throw err;
        });
        for (let i = 0; i < turns.length; i++) {
          scanned++;
          if (consider(`turn${turns[i]}`, reads[i]).complete) { won = i; break; }
        }
        if (won >= 0) {
          if (leveled && leveled.bitmap) leveled.bitmap.close();
          leveled = frames[won];
          source = frames[won];
          settled = true;
        }
      } finally {
        // The quarter turn the ladder did not believe is this scan's rubbish too.
        frames.forEach((frame, i) => { if (i !== won && frame.bitmap) frame.bitmap.close(); });
      }
    }
    // The reading the rest of the scan is built on: the one that came back whole
    // if any did, otherwise the one that read the most of the sheet.
    const kept = (best && best.words) || [];
    words.length = 0;
    words.push(...kept);
    found = !!(best && best.found);
    // The row was located, so read it again at cell resolution — the strip pass
    // only had to find the header and the name (see ocrOwnerCells). The column
    // grid comes from the same words, so no second engine session is needed.
    const nameWord = found ? words.find(w => nameMatches(w.text, name)) : null;
    if (nameWord) {
      // One parse serves both halves: the column grid, and the owner's own row —
      // the words the cell pass crops to.
      const parsed = parseRosterWords(words, today, { name });
      const cols = parsed.columns;
      if (cols.length >= 2) {
        // Where the sheet draws its own column boundaries. Computed here, once,
        // after the page is settled (a turned photo has turned its rules too) and
        // before any cell is cropped to a boundary that is only a guess.
        const rules = ocrPhotoRules(source);
        const ruleGrid = rules ? rosterColumnsFromRules(rules.v, cols, {}) : null;
        _progressSink = () => {};
        // The cell pass crops to where the ink actually is, so it needs the words
        // of the owner's own row and a text height to size a crop with. The words
        // come from the parse — the row the typed name matched — rather than from
        // a band around the name's centre: on a tilted page that centre is tens of
        // pixels off the row's own line by the time it reaches the last day, and
        // the cells it "missed" were simply outside the band.
        const heights = words.map(w => Math.max(4, w.y1 - w.y0)).sort((a, b) => a - b);
        const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 24;
        const owner = parsed.rows.find(r => r.matches);
        const rowWords = (owner && owner.words) || [nameWord];
        const read = await ocrOwnerCells(pool, source, {
          name, nameWord, cols, rowWords, medianH, skew: pageSkew(words, medianH), progress, ruleGrid,
        });
        cells = read.cells;
        cellsComplete = read.complete;
      }
    }
  } finally {
    _progressSink = () => {};
    // Every worker this scan built — the engines and the prep workers — gone with
    // the photo: a worker's heap is the one place a decoded roster image could
    // outlive the scan.
    await disposeOcrWorker();
    // The caller's canvas is only the on-screen preview now — every read draws on
    // a prep worker's surface of its own — but it is still zeroed here on every
    // path, so "the photo is gone" stays true of the preview the scan started from
    // (see discardPhoto).
    canvas.width = 0;
    canvas.height = 0;
    // The photo and the levelled copy of it are this scan's, and neither outlives
    // it either.
    if (decoded && decoded.bitmap) decoded.bitmap.close();
    if (leveled && leveled.bitmap) leveled.bitmap.close();
  }
  return { words, found, scanned, pagePass, cells, cellsComplete, tries };
}

// ============================================================
//  Screen
// ============================================================
// Open/closed state of the "Pay rules & tax rates" panel. Module scope, not
// screen scope: render() re-invokes screenTesco(), so a local would reset and
// the panel would snap shut on the debounced repaint after every edit — and
// because an input inside a closed <details> can't take focus, that silently
// dropped the caret too.
let ratesPanelOpen = false;
// The last roster read, kept here for the same reason: render() re-invokes
// screenTesco(), so a background sync poll or an update toast rebuilding the
// screen would otherwise throw away a parse the user is still reviewing. A
// scan takes seconds and several reads, so that window is real.
let scanState = null;   // { parsed, picked, note, profileId }
// The sheet's first column date, as typed on the scan card. Held here for the
// same reason as scanState: render() re-invokes screenTesco(), so a rebuild used
// to snap the anchor back to this week while the sheet on the desk was a month
// old — and the reader silently dated the shifts it found from the wrong week.
// Session-only on purpose: persisted, next week's read would inherit an anchor
// nobody chose any more, which is the same mistake the other way round.
let rosterAnchor = null;

/**
 * A roster read belongs to the profile that took it. The slot above is
 * module-level (one card at a time), so switching profiles would otherwise
 * hand the next person the previous one's row — names and shift times from
 * someone else's sheet. Same rule as staleResponse() in app.js: stamp the
 * result with its owner and drop it when that is not who is active now.
 */
export function scanSlotForProfile(slot, profileId) {
  return slot && slot.profileId === profileId ? slot : null;
}
// Which lists are unfolded. Same reason again: render() re-invokes screenTesco(),
// so a flag declared in there would reset the instant it was toggled — the
// "show all" button would repaint straight back to the collapsed state.
let showAllWeeks = false;
let showAllSlips = false;

// ================= foldable cards =================
// The Tesco tab is nine cards in one scroll, and the ones a user is not
// working in — the manual form, the roster scanner, the tax table, the
// importer — were all paying for that scroll every visit. Each becomes a
// disclosure whose title is its own control: no chevron-only affordance, no
// nested interactive elements, and the choice is remembered between visits.
//
// The reading and writing of that choice are HANDED IN: this module keeps its
// hands off browser storage entirely (the roster photo must never be near a
// persistence path — scripts/check-image-hygiene.mjs pins it), so app.js owns
// the little key and this file only says what it wants remembered.

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

  // The camera is reachable from exactly one place: the roster-scan card below,
  // which owns the name and the first-column date a read needs. The Add-shift
  // card carried a second door of its own ("Scan from camera") into the same
  // flow — two buttons for one camera, so the one beside the form is gone.

  // ----- add shift -----
  screen.appendChild(fold(buildAddCard(), 'add-shift'));
  // ----- week off -----
  screen.appendChild(fold(buildWeekOffCard(), 'week-off'));
  // The Add tab's quick field, in shift clothes: describe it, watch the preview
  // resolve, then add it. Same grammar-shaped chips and example chips, because
  // the two fields teach the same habit — say it, check it, save it.
  screen.appendChild(fold(buildQuickCard(), 'quick-entry', true));
  // ----- roster scan -----
  screen.appendChild(fold(buildScanCard(), 'scan-roster'));
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

  // ================= roster scan =================
  // Type your name, choose the photo, read. Nothing is framed by hand: the
  // engine scans the photo top-down and stops at the row carrying the name
  // (see ocrRosterRow), which is what makes an angled or glare-lit photo work.
  function buildScanCard() {
    // Whoever this card is being built for owns anything it shows: a read made
    // under another profile is dropped here rather than restored.
    const ownerProfileId = getActiveProfileId() || 'personal';
    scanState = scanSlotForProfile(scanState, ownerProfileId);
    let busy = false;
    let file = null;          // memory only: dropped when the card re-renders
    const canvas = $('canvas', { class: 'tesco-scan-preview', 'aria-hidden': 'true' });
    const wrap = $('div', { class: 'tesco-scan-wrap', style: 'display:none;' }, canvas);
    // Debounced, not immediate: persist() rewrites the document and schedules a
    // sync push, so one write per keystroke is wasteful for a 40-character name.
    let nameTimer = 0;
    const nameIn = $('input', {
      type: 'text', value: state().settings.tescoName || '', placeholder: 'e.g. Parth',
      'aria-label': 'Your name on the roster', class: 'tesco-in', maxLength: 40, autocomplete: 'off',
      // Written through as it is typed, so a rebuild mid-entry (a sync poll, an
      // undo repaint) hands the card back with the name still in it. It used to
      // be saved only once a read ran, so it was gone at exactly the moment the
      // next read needed it. No render() here — the photo is memory-only and
      // would be dropped with it (see `file` above).
      onInput: e => {
        state().settings.tescoName = e.target.value;
        clearTimeout(nameTimer);
        nameTimer = setTimeout(persist, 400);
      },
    });
    const weekIn = $('input', {
      type: 'date', value: rosterAnchor || weekStartOf(todayIso()), 'aria-label': 'First column date', class: 'tesco-in',
      onInput: e => { if (dateOk(e.target.value)) rosterAnchor = e.target.value; },
    });
    const readBtn = $('button', { type: 'button', class: 'btn btn-primary', style: 'display:none;', onClick: () => run() }, 'Read my shifts');
    const status = $('div', { class: 'muted', style: 'font-size:12px;' }, 'Photo or camera shot of the weekly roster — processed in memory, never stored.');
    const bar = $('div', { class: 'tesco-progress', style: 'display:none;' }, $('div', { class: 'tesco-progress-fill' }));
    const resultBox = $('div', { style: 'margin-top:12px;' });
    const input = $('input', { type: 'file', accept: 'image/*', class: 'tesco-file', 'aria-label': 'Roster photo' });

    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) load(f); });

    async function load(f) {
      file = f;
      scanState = null;   // a new photo invalidates the previous read
      resultBox.replaceChildren();
      wrap.style.display = 'block';
      readBtn.style.display = 'inline-flex';
      readBtn.disabled = false;
      try {
        await drawPhotoPreview(file, canvas);
        status.textContent = 'Photo loaded. Press read — your row is found by name.';
      } catch {
        status.textContent = 'Could not open that image.';
        file = null;
      }
    }

    async function run() {
      if (busy || !file) return;
      const name = nameIn.value.trim();
      if (!name) { toast('Type your name as it appears on the roster, so your row can be found.'); nameIn.focus(); return; }
      busy = true;
      // Remembered so the next roster only needs the photo. A preference rather
      // than data, so it is saved without taking an undo slot.
      state().settings.tescoName = name;
      persist();
      resultBox.replaceChildren();
      bar.style.display = 'block';
      let note = '';
      const setP = (p, msg) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; if (msg) status.textContent = msg; };
      try {
        const { words, found, scanned, cells, cellsComplete } = await ocrRosterRow(file, canvas, { name }, setP);
        setP(0.85, 'Reading the shifts');
        const parsed = parseRosterWords(words, new Date(), { fallback: { weekStart: weekIn.value }, name, cells, cellsComplete });
        // The cell pass is what turns "a row was found" into "these shifts were
        // read", so say how many it managed and leave the rest to be filled in.
        const cellNote = cellsComplete
          ? ` Read ${cells.length} shift${cells.length === 1 ? '' : 's'} cell by cell${cells.length < 7 ? '; fix any day left blank' : ''}.`
          : '';
        note = !parsed.rows.length
          ? 'Nothing read — try a photo with the whole sheet in frame, or check the name.'
          : found
            ? `Found your row on pass ${scanned} of ${OCR_STRIP_COUNT}.${cellNote} Photo discarded from memory.`
            : `No row named “${name}” was read — pick your row below and fix anything the scanner misread.`;
        // Held so a rebuild mid-review reopens the same row instead of nothing.
        const matched = parsed.rows.findIndex(r => r.matches);
        // Stamped with the card's owner, not with whoever is active when the
        // read finishes: a switch mid-scan must not mark it as theirs.
        scanState = { parsed, picked: matched >= 0 ? matched : null, note, profileId: ownerProfileId };
        renderResult(parsed);
      } catch (err) {
        note = err && err.message ? err.message : 'Scan failed.';
      } finally {
        setTimeout(() => { bar.style.display = 'none'; bar.firstChild.style.width = '0%'; }, 600);
        discardPhoto(note);
        busy = false;
      }
    }

    // ---------- camera capture ----------
    // The roster photo can be taken here instead of picked from the gallery.
    // A frame is drawn to a scratch canvas, encoded to a Blob and handed to the
    // same reader a chosen file goes to, so the promise holds on this path too:
    // nothing is written to storage, the canvas is zeroed and the stream's
    // tracks are stopped the moment the modal closes — including when a render
    // replaces the screen underneath the open camera — and "Stop live read"
    // releases them there and then, so the camera light never outlives the click.
    // "Live read" keeps taking frames until the sheet in front of the lens parses
    // into shifts, then stops itself and hands the read to the reviewer.
    function openRosterCameraNow() {
      // One camera at a time. This guard used to sit on the Add-shift card's
      // wrapper, so it has to live on the function itself now that the scan
      // card's "Use camera" is the only door in (a second Enter on it, or any
      // future caller, must not open a second stream).
      if (document.querySelector('[role="dialog"][aria-label="Scan roster with the camera"]')) return;
      const video = $('video', {
        playsinline: true, autoplay: true, muted: true, 'aria-label': 'Camera preview',
        style: 'width:100%;height:240px;object-fit:cover;background:#000;border-radius:10px;display:block;',
      });
      const shot = $('canvas', { 'aria-hidden': 'true' });   // scratch only: never mounted
      const status = $('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;min-height:36px;margin-top:10px;' },
        'Fill the frame with the sheet, then Capture — or start a live read and let it find your shifts.');
      const liveBtn = $('button', { type: 'button', class: 'btn btn-ghost', 'aria-pressed': 'false' }, 'Live read');
      const captureBtn = $('button', { type: 'button', class: 'btn btn-primary' }, 'Capture');
      // `finish` is a hoisted declaration below; wiring it here is what makes
      // Cancel release the camera (it used to be inert, so the light stayed on).
      const cancelBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => finish() }, 'Cancel');
      // Shown in place of the (black) preview once the stream is released, so an
      // off camera reads as deliberate rather than broken.
      const camOff = $('div', { style: 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#fff;font-size:13px;line-height:1.5;text-align:center;padding:0 18px;background:#000;border-radius:10px;' },
        'Camera off — press Start camera to read the sheet, or Cancel to use a photo instead.');
      const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) finish(); } });
      bg.appendChild($('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan roster with the camera', style: 'max-width:520px;' },
        $('div', { class: 'tesco-card-title' }, 'Scan the roster'),
        $('div', { style: 'position:relative;' }, video, camOff),
        status,
        $('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;' }, captureBtn, liveBtn, cancelBtn),
      ));
      stackModal(bg);

      let stream = null;
      let opening = false;      // a getUserMedia request is in flight
      let live = false;
      let busy = false;
      let closed = false;
      const stopStream = () => {
        if (stream) { for (const track of stream.getTracks()) track.stop(); stream = null; }
        video.srcObject = null;
        shot.width = 0; shot.height = 0;
      };
      // A render (a sync poll landing, a toast repaint) rebuilds the screen and
      // drops this modal with it. Without this the camera light would stay on.
      const watcher = new MutationObserver(() => { if (!bg.isConnected) stopStream(); });
      watcher.observe(document.body, { childList: true });
      function finish() {
        if (closed) return;
        closed = true;
        live = false;
        stopStream();
        watcher.disconnect();
        document.removeEventListener('keydown', onKey, true);
        bg.remove();
      }
      function onKey(ev) { if (ev.key === 'Escape' && isTopModal(bg)) { ev.preventDefault(); finish(); } }
      document.addEventListener('keydown', onKey, true);

      // One frame as a File that lives only as long as the read it feeds.
      async function grabFrame() {
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return null;   // the stream has not produced a picture yet
        const scale = Math.min(1, CAMERA_MAX_EDGE / Math.max(w, h));
        shot.width = Math.max(1, Math.round(w * scale));
        shot.height = Math.max(1, Math.round(h * scale));
        shot.getContext('2d').drawImage(video, 0, 0, shot.width, shot.height);
        const blob = await new Promise(res => shot.toBlob(res, 'image/jpeg', 0.92));
        shot.width = 0;
        shot.height = 0;
        return blob ? new File([blob], 'roster-camera.jpg', { type: 'image/jpeg' }) : null;
      }
      // True once a read has produced cells the user can review.
      const readSomething = () => !!(scanState && scanState.parsed
        && scanState.parsed.rows.some(r => r.cells && r.cells.length));

      // The frame MUST be taken from a live video: stopping the stream or
      // detaching the element first leaves nothing to read.
      async function readLiveFrame() {
        const frame = await grabFrame();
        if (!frame) {
          status.textContent = 'The camera is still warming up — hold still a moment and press Capture again.';
          return false;
        }
        await load(frame);
        await run();
        return readSomething();
      }

      const nameMissing = () => {
        if (nameIn.value.trim()) return false;
        toast('Type your name as it appears on the roster first — your row is found by name.');
        nameIn.focus();
        return true;
      };

      captureBtn.addEventListener('click', async () => {
        if (busy) return;
        if (nameMissing()) { finish(); return; }
        busy = true;
        const frame = await grabFrame();
        busy = false;
        if (!frame) { status.textContent = 'The camera is still warming up — hold still a moment and press Capture again.'; return; }
        finish();                   // camera off before the slow part
        await load(frame);
        await run();
      });

      liveBtn.addEventListener('click', async () => {
        if (live) {
          // Stopping the read releases the camera with it: the light going out is
          // the point of the click, so it must not wait for the modal to close.
          live = false;
          stopStream();
          setLiveUi();
          status.textContent = 'Live read stopped and the camera released — press Start camera to take a frame, or Cancel.';
          return;
        }
        // The button cycles Start camera → Live read → Stop live read, so one
        // press does exactly what its label says: this press only re-arms the
        // camera, the next one scans.
        if (!stream) { await openStream(); return; }
        if (nameMissing()) { finish(); return; }
        live = true;
        setLiveUi();
        liveLoop();
      });
      function setLiveUi() {
        liveBtn.setAttribute('aria-pressed', String(live));
        liveBtn.textContent = live ? 'Stop live read' : (stream ? 'Live read' : 'Start camera');
        liveBtn.classList.toggle('btn-primary', live);
        liveBtn.classList.toggle('btn-ghost', !live);
        captureBtn.disabled = !stream;    // nothing to grab from a released stream
        camOff.style.display = stream ? 'none' : 'flex';
      }
      async function liveLoop() {
        for (let attempt = 1; live && attempt <= CAMERA_LIVE_ATTEMPTS; attempt++) {
          status.textContent = `Live read ${attempt} of ${CAMERA_LIVE_ATTEMPTS} — hold the whole sheet in frame and keep it flat.`;
          busy = true;
          const read = await readLiveFrame().catch(() => false);
          busy = false;
          if (!live) return;
          if (read) {
            finish();
            toast('Shifts read from the camera — check them before adding.');
            return;
          }
          await new Promise(r => setTimeout(r, 600));
        }
        if (!live) return;
        live = false;
        setLiveUi();
        status.textContent = 'No shifts read — keep the whole sheet in the frame with the row of names in view, or press Capture.';
      }

      // Acquires (or re-acquires) the stream. Kept as one function so "Stop live
      // read" can release the device and "Start camera" can hand it straight back.
      async function openStream() {
        if (stream || opening || closed) return;
        opening = true;
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
            audio: false,
          });
          if (closed) { for (const track of s.getTracks()) track.stop(); return; }
          stream = s;
          video.srcObject = s;
          video.muted = true;
          video.playsInline = true;
          const played = video.play();
          if (played && played.catch) played.catch(() => {});
          if (!live) status.textContent = 'Camera ready — fill the frame with the sheet, then Capture, or start a live read.';
          setLiveUi();
        } catch (err) {
          const reason = err && err.name;
          status.textContent = reason === 'NotAllowedError' ? 'Camera permission was refused — allow it for this site, or use Choose photo.'
            : reason === 'NotFoundError' || reason === 'OverconstrainedError' ? 'No camera found on this device — use Choose photo.'
            : reason === 'NotReadableError' ? 'The camera is busy in another app — close it and try again.'
            : 'Could not start the camera — use Choose photo instead.';
          captureBtn.disabled = true;
          liveBtn.disabled = true;
        } finally {
          opening = false;
        }
      }
      // The stream is opened last, so a permission refusal leaves a modal that
      // says why and points at the gallery path rather than a dead black box.
      const support = cameraSupport();
      if (support) {
        status.textContent = support === 'insecure'
          ? 'The camera needs a secure (HTTPS) connection — use Choose photo instead.'
          : 'The camera is not available in this browser — use Choose photo instead.';
        captureBtn.disabled = true;
        liveBtn.disabled = true;
        return;
      }
      openStream();
    }
    // Every scan ends here: ocrRosterRow has zeroed the canvas and terminated the
    // workers that held the pixels, so this removes the (now empty) preview chrome
    // and says so plainly — "the photo is gone" is something the user can see
    // rather than take on trust.
    function discardPhoto(note) {
      file = null;
      wrap.style.display = 'none';
      readBtn.style.display = 'none';
      status.textContent = note || 'Photo discarded from memory — choose it again to read another row.';
    }

    // Reopens the last read after a rebuild, so a parse survives a repaint.
    if (scanState && scanState.parsed.rows.length) {
      status.textContent = scanState.note;
      renderResult(scanState.parsed);
    }

    function renderResult(parsed) {
      resultBox.replaceChildren();
      if (!parsed.rows.length) return;
      // The row whose name matches the typed one, else the row with most cells.
      let picked = scanState && scanState.picked != null ? scanState.picked : parsed.rows.findIndex(r => r.matches);
      if (picked < 0) picked = parsed.rows.reduce((best, r, i) => (r.cells.length > parsed.rows[best].cells.length ? i : best), 0);

      const rowList = $('div', { class: 'tesco-rowlist' },
        ...parsed.rows.map((r, i) => $('button', {
          type: 'button',
          class: `tesco-row${i === picked ? ' active' : ''}`,
          onClick: (e) => {
            picked = i;
            if (scanState) scanState.picked = i;
            rowList.querySelectorAll('.tesco-row').forEach((el, j) => el.classList.toggle('active', j === i));
            drawEditor(parsed.rows[i]);
          },
        },
          $('span', { class: 'tesco-row-name' }, r.name || '(row)'),
          $('span', { class: 'muted', style: 'font-size:11px;' }, `${r.cells.length} shift${r.cells.length === 1 ? '' : 's'}`),
          r.matches ? $('span', { class: 'tesco-chip tesco-chip-good' }, 'you?') : null,
        )),
      );
      const editor = $('div', {});
      drawEditor(parsed.rows[picked]);
      function drawEditor(row) {
        editor.replaceChildren();
        // Duplicate reads (two tokens landing on one day) start unchecked so
        // the default add is clean; the user can tick them back on.
        const checks = row.cells.map(c => !c.dupe);
        const rowsBox = $('div', { class: 'tesco-celledit' });
        const draw = () => {
          rowsBox.replaceChildren();
          row.cells.forEach((cell, i) => {
            const dateVal = cell.date || nextDateForWeekday(cell.weekday);
            const startVal = fmtHM(cell.startMin), endVal = fmtHM(cell.endMin);
            // Numbered per cell: these are addressed identities (restoreFocusedField
            // looks fields up by aria-label), and a seven-cell read used to put seven
            // "Date" fields on one screen — a re-render mid-fix moved the caret to
            // whichever cell came first. 'Include shift N' is also stable where the
            // date-based label collided whenever two cells read no date at all.
            const cb = $('input', { type: 'checkbox', checked: checks[i], 'aria-label': `Include shift ${i + 1}`, onChange: e => { checks[i] = e.target.checked; refresh(); } });
            if (cell.dupe) cb.title = 'Possibly a duplicate read — check before adding';
            const dIn = $('input', { type: 'date', value: dateVal || todayIso(), 'aria-label': `Date ${i + 1}`, class: 'tesco-in', onInput: e => { cell.date = e.target.value; } });
            // The hours beside the times are recomputed as they are corrected. They
            // used to be painted once when the row was drawn, so fixing a misread
            // end time left "7h" sitting next to a cell that would be added as 11h
            // — the one number in the row you check before pressing Add selected.
            const hours = $('span', { class: 'muted', style: 'font-size:11px;min-width:44px;text-align:right;' });
            const refreshHours = () => { hours.textContent = `${paidHours(cell.startMin, cell.endMin)}h`; };
            const sIn = $('input', { type: 'time', value: startVal, 'aria-label': `Start ${i + 1}`, class: 'tesco-in', onInput: e => { cell.startMin = parseHM(e.target.value) ?? cell.startMin; refreshHours(); } });
            const eIn = $('input', { type: 'time', value: endVal, 'aria-label': `End ${i + 1}`, class: 'tesco-in', onInput: e => { cell.endMin = parseHM(e.target.value) ?? cell.endMin; refreshHours(); } });
            refreshHours();
            rowsBox.appendChild($('div', { class: 'tesco-celledit-row' }, cb, dIn, sIn, eIn, hours, $('span', { class: 'muted', style: 'font-size:10px;' }, cell.raw)));
          });
        };
        const summary = $('div', { class: 'muted', style: 'font-size:12px;margin-top:8px;' });
        const refresh = () => {
          const n = checks.filter(Boolean).length;
          summary.textContent = n ? `${n} shift${n > 1 ? 's' : ''} will be added.` : 'Nothing selected.';
          addAll.disabled = !n;
        };
        const addAll = $('button', { type: 'button', class: 'btn btn-primary', style: 'margin-top:10px;', onClick: () => {
          const list = row.cells.filter((c, i) => checks[i]).map(c => ({ date: c.date, start: fmtHM(c.startMin), end: fmtHM(c.endMin) }));
          if (addShifts(list, 'scanned shift')) {
            scanState = null;   // read and added: nothing left to restore
            resultBox.replaceChildren($('div', { class: 'muted', style: 'font-size:12px;' }, 'Added. The photo was never saved.'));
          }
        } }, 'Add selected');
        draw(); refresh();
        editor.appendChild($('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px;' }, 'Times parsed from the photo — fix anything the scanner misread:'));
        editor.appendChild(rowsBox);
        editor.appendChild(summary);
        editor.appendChild(addAll);
      }
      resultBox.appendChild(rowList);
      resultBox.appendChild(editor);
    }
    function nextDateForWeekday(wd) {
      if (wd == null) return null;
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + ((wd - d.getUTCDay() + 7) % 7));
      return d.toISOString().slice(0, 10);
    }

    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Scan roster', iconSpan('clock', 'md')),
      $('div', { class: 'tesco-form-row' },
        $('label', { class: 'tesco-numfield' }, $('span', null, 'Your name'), nameIn),
      ),
      $('div', { class: 'tesco-form-row tesco-form-row-spread' },
        $('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' },
          $('label', { class: 'btn btn-ghost tesco-filelabel' }, file ? 'Choose another' : 'Choose roster photo', input),
          $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => openRosterCameraNow() }, 'Use camera'),
        ),
        status,
      ),
      wrap,
      $('div', { class: 'tesco-form-row', style: 'align-items:center;gap:8px;' },
        $('label', { class: 'tesco-numfield' }, $('span', null, 'First column'), weekIn),
        readBtn,
      ),
      bar,
      resultBox,
    );
  }

  // ================= pay weeks =================
  function buildWeeksCard() {
    const weeks = buildPayWeeks(shifts(), payslips(), rates);
    const card = $('div', { class: 'card' });
    card.appendChild($('div', { class: 'tesco-card-title' }, 'Pay weeks', iconSpan('clock', 'md')));
    if (!weeks.length) {
      card.appendChild($('div', { class: 'muted', style: 'font-size:13px;' }, 'No shifts yet — add one above or scan the roster photo.'));
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
    const actual = w.payslips.length ? w.paid : null;
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
