/* ============================================================
   The Tesco Pay sheet: its own two tables, in and out.

   The reference document is a workbook. Its Data sheet holds one row per
   shift, and its Summary sheet holds a tax table — one row per pay run, with
   that run's PAYE, USC, PRSI and pension. This module is the whole of the
   round trip, and it is deliberately ONE importer rather than two: the
   workbook's cells are written back out as the very CSV text the CSV importer
   reads, so every rule about headers, aliases, dates, times, hours and
   round-trips stays in one place, pinned by one harness, instead of a second
   importer free to disagree with the first.

   Three rules carry most of the weight, and each exists because the obvious
   implementation loses money:

   1. A row keeps its OWN hours and pay. The sheet's older rows were worked at
      rates that have since changed, so a row's own figure outranks hours ×
      rate — and two rows book a full week off with hours and no clock times.
      Dropping a row that has no clock times also lost the week's bank pay.

   2. A payslip is per PAY RUN, not per week. The sheet's tax table holds two
      rows when a week had two runs (a correction, say), and folding them into
      one lost a row from the file's own round trip. The engine still groups
      (and derives the pay date) by the week's Sunday.

   3. Final Bank Pay is TYPED, not derived. It comes off a bank statement, and
      holiday pay, a refund or a correction are all reasons it disagrees with
      gross − tax. It is carried through, never recomputed away — and an
      export writes only a figure that was actually recorded, because a derived
      one would come back on the next import looking like the bank confirmed it.

   The engine lives in `app/lib/tesco-pay.ts`; the field rule lives in
   `app/lib/csv.ts`. This module is the sheet's own vocabulary on top of both.
   ============================================================ */
import { csvCell, csvDate, csvDocument, csvRows, csvUnquote } from './csv.ts';
import {
  buildPayWeeks,
  dateOk,
  fmtHM,
  isoToUtcMidnight,
  pad2,
  parseHM,
  payslipTotal,
  payDateOf,
  r2,
  shiftPay,
  simulateTax,
  statedHours,
  todayIso,
  weekNumberOf,
  weekStartOf,
} from './tesco-pay.ts';

export const TESCO_CSV_HEADER = Object.freeze([
  'Date', 'Effective Date', 'Week', 'Day', 'Start Time', 'End Time', 'Hours',
  'Normal or Special', 'Total', 'Received?', 'Gross Income', 'Potential Tax',
  'Pension', 'Calculated Income', 'Final Bank Pay', 'Description',
]);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The sheet's own tax table, as a second table in the same file. */
export const TESCO_CSV_PAYSLIP_HEADER = Object.freeze([
  'Week Start Date', 'Pay Date', 'Week', 'PAYE', 'USC', 'PRSI', 'Future Fund', 'Total',
]);

export interface TescoShift {
  id?: string;
  date: string;
  start?: string;
  end?: string;
  hours?: number;
  gross?: number;
  bankPay?: number;
  special?: boolean;
  note?: string;
  createdAt?: string;
  [field: string]: unknown;
}

export interface TescoPayslip {
  id?: string;
  weekStart: string;
  paye?: number;
  usc?: number;
  prsi?: number;
  futureFund?: number;
  weekNo?: number;
  bankPay?: number;
  createdAt?: string;
  [field: string]: unknown;
}

/** Two decimals, so Excel reads the column as numbers rather than text. */
function csvNum(v: unknown): string {
  return v == null || v === '' ? '' : r2(Number(v)).toFixed(2);
}

/** A numeric cell, or null when it holds no number at all (0 stays 0). */
function csvNumber(raw: unknown): number | null {
  const s = String(raw == null ? '' : raw).replace(/[^\d.-]/g, '');
  if (s === '' || !Number.isFinite(Number(s))) return null;
  return Number(s);
}

/** `HH:MM(:SS)`, or the bare day fraction Excel stores. */
function csvTime(raw: unknown): string | null {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m) return (+m[1] > 23 || +m[2] > 59) ? null : fmtHM(+m[1] * 60 + +m[2]);
  if (/^0?\.\d+$/.test(s)) {
    const mins = Math.round(Number(s) * 1440);
    return mins < 1440 ? fmtHM(mins) : null;
  }
  return null;
}

/* ── the export ───────────────────────────────────────────────────────────── */

/** The sheet's own table, column for column, round-trippable.
 *
 *  One row per shift, newest first, and each week's figures on that week's
 *  first row — the Sunday row, because the sheet's weeks run Sun → Sat. */
export function tescoCsv(
  shifts: TescoShift[],
  payslips: TescoPayslip[],
  rates: any,
  weekNos: Record<string, number> = {},
): string {
  const list = Array.isArray(shifts) ? shifts : [];
  const slips = Array.isArray(payslips) ? payslips : [];
  const weeks = new Map(buildPayWeeks(list as any, slips as any, rates).map((w: any) => [w.weekStart, w]));
  // Which shift row carries a week's figures: the week's first row by date, so
  // the Sunday when one was worked and a plain week still exports its totals
  // instead of dropping them.
  const carrier = new Map<string, string>();
  for (const s of list) {
    const ws = weekStartOf(s.date);
    if (!carrier.has(ws) || s.date < carrier.get(ws)!) carrier.set(ws, s.date);
  }
  const rows: unknown[][] = [[...TESCO_CSV_HEADER]];
  const sorted = list.slice().sort((a, b) => b.date.localeCompare(a.date)
    || String(b.start || '').localeCompare(String(a.start || '')));
  for (const s of sorted) {
    const p = shiftPay(s as any, rates);
    const ws = weekStartOf(s.date);
    const w: any = weeks.get(ws);
    const row: unknown[] = [
      // The pay week's own number, from its start — the whole Sun → Sat block
      // shares one, the way the sheet's Week column groups a week.
      s.date, s.date, weekNumberOf(ws, weekNos), DAY_NAMES[isoToUtcMidnight(s.date).getUTCDay()],
      s.start || '', s.end || '', csvNum(p ? p.hours : ''), p && p.special ? 'Special' : 'Normal',
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
  if (slips.length) {
    rows.push([], [...TESCO_CSV_PAYSLIP_HEADER]);
    const ordered = slips.slice().sort((a, b) => weekStartOf(a.weekStart).localeCompare(weekStartOf(b.weekStart)));
    for (const p of ordered) {
      // The date the sheet typed for this row, not the snapped Sunday: a second
      // pay run inside the same Sun → Sat week keeps its own date, the way the
      // sheet's tax table holds two rows for it. The engine still groups (and
      // derives the pay date) by the week's Sunday.
      const ws = weekStartOf(p.weekStart);
      const rowWeek = p.weekNo != null ? p.weekNo : weekNumberOf(ws, weekNos);
      rows.push([p.weekStart, payDateOf(ws), rowWeek, csvNum(p.paye), csvNum(p.usc),
        csvNum(p.prsi), csvNum(p.futureFund), csvNum(payslipTotal(p as any))]);
    }
  }
  return csvDocument(rows);
}

/* ── the import ───────────────────────────────────────────────────────────── */

export interface TescoParseResult {
  shifts: TescoShift[];
  payslips: TescoPayslip[];
  weekNos: Record<string, number>;
  skipped: number;
  error: string | null;
}

/** Reads back anything this engine exports, plus a plain Excel "Save as CSV".
 *
 *  Columns are matched by header name, so reordering, extra columns and the
 *  sheet's empty leading column all work. Hours, gross, tax and pension are
 *  derived from the times and the rate card, never trusted from the file — but
 *  Final Bank Pay is: the sheet types it off a bank statement, and holiday
 *  pay, a refund or a correction are all reasons it disagrees with gross − tax. */
export function parseTescoCsv(text: unknown): TescoParseResult {
  const rows = csvRows(String(text || ''));
  const norm = (r: string[]) => r.map((h) => String(h).trim().toLowerCase());
  // Each table's header is found by name rather than assumed to be a given
  // line, so a title row, a blank line or the sheet's own empty column A
  // changes nothing — and the shift table may sit above a tax table.
  const findHead = (want: string[]): number => rows.findIndex(
    (r) => { const h = norm(r); return want.every((n) => h.includes(n)); },
  );
  const at = (head: string[], ...names: string[]): number => names.reduce(
    (hit, n) => (hit >= 0 ? hit : head.indexOf(n)), -1,
  );

  const shiftHead = findHead(['date', 'start time', 'end time']);
  const slipHead = findHead(['week start date', 'paye']);
  if (shiftHead < 0 && slipHead < 0) {
    return {
      shifts: [], payslips: [], weekNos: {}, skipped: 0,
      error: 'That file needs Date, Start Time and End Time columns.',
    };
  }

  const shifts: TescoShift[] = [];
  const weekNos: Record<string, number> = {};
  // A week's net from the shift table's Final Bank Pay column, by week start.
  const weekBank = new Map<string, number>();
  let skipped = 0;

  if (shiftHead >= 0) {
    const head = norm(rows[shiftHead]);
    const iDate = at(head, 'date', 'effective date');
    const iStart = at(head, 'start time');
    const iEnd = at(head, 'end time');
    const iSpecial = at(head, 'normal or special', 'type');
    const iNote = at(head, 'description', 'note');
    // The row's own hours and pay, kept on the row: the sheet's older rows were
    // worked at rates that have since changed, and two rows book a full week
    // off with hours and no clock times.
    const iHours = at(head, 'hours');
    const iTotal = at(head, 'total');
    // The sheet's Final Bank Pay, read here and put on the week's payslip
    // below — the sheet keeps a week's net on that week's own shift row, and
    // the tax table has no column for it.
    const iBank = at(head, 'final bank pay', 'net paid');
    // The file's own week number, so a sheet's hand-typed count comes across
    // with the shifts instead of being replaced by the ISO number.
    const iWeekNo = at(head, 'week');
    // Stop at the tax table so its rows are never read as shifts.
    const end = slipHead > shiftHead ? slipHead : rows.length;
    for (const r of rows.slice(shiftHead + 1, end)) {
      const date = csvDate(r[iDate]);
      const start = csvTime(r[iStart]);
      const endTime = csvTime(r[iEnd]);
      const stated = iHours < 0 ? null : csvNumber(r[iHours]);
      const paid = iTotal < 0 ? null : csvNumber(r[iTotal]);
      const banked = iBank < 0 ? null : csvNumber(r[iBank]);
      if (!date || !dateOk(date)) { skipped += 1; continue; }
      // No times at all is only unusable when the row states no hours either —
      // a "full week off" row has no times but does have its hours, and
      // dropping it silently lost the row and the week's bank pay with it.
      if ((start == null || endTime == null) && stated == null) { skipped += 1; continue; }
      shifts.push({
        date, start, end: endTime,
        ...(stated == null ? {} : { hours: stated }),
        ...(paid == null ? {} : { gross: paid }),
        // The row's own net, which the week's figure is read off below. Kept on
        // the row as well: the sheet types it there, and a week whose figures
        // sit on a row with no payslip of its own would otherwise lose it.
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

  const payslips: TescoPayslip[] = [];
  if (slipHead >= 0) {
    const head = norm(rows[slipHead]);
    const iWeek = at(head, 'week start date', 'week start', 'date');
    const iPaye = at(head, 'paye');
    const iUsc = at(head, 'usc');
    const iPrsi = at(head, 'prsi');
    const iFund = at(head, 'future fund');
    const iBank = at(head, 'final bank pay', 'net paid');
    // The sheet's own Week count, kept per row. Deriving it from the date put
    // a different number on a couple of rows than the sheet shows, which is
    // exactly the kind of missing value this file is checked for.
    const iWeekNo = at(head, 'week');
    // One payslip per row, not per week: the sheet's tax table holds two rows
    // when a week had two pay runs (a correction, say), and folding them into
    // one lost a row from the file's own round trip. The engine still adds
    // them up for a week's total.
    const seen = new Set<string>();
    for (const r of rows.slice(slipHead + 1)) {
      const ws = csvDate(r[iWeek]);
      if (!ws || !dateOk(ws)) { skipped += 1; continue; }
      const cell = (i: number): number => (i < 0 ? 0 : (Number(String(r[i] == null ? '' : r[i]).replace(/[^\d.-]/g, '')) || 0));
      // The row's own date, not the week's Sunday: the sheet's tax table holds
      // two rows for one week when it had two pay runs, and snapping both to
      // the Sunday merged them, losing a row's figures. buildPayWeeks snaps it
      // for grouping, so the week still adds up.
      const draft: TescoPayslip = {
        weekStart: ws, paye: cell(iPaye), usc: cell(iUsc), prsi: cell(iPrsi), futureFund: cell(iFund),
      };
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
    const carried = new Set<string>();
    for (const p of payslips) {
      const ws = weekStartOf(p.weekStart);
      if (p.bankPay != null || carried.has(ws) || !weekBank.has(ws)) continue;
      p.bankPay = weekBank.get(ws);
      carried.add(ws);
    }
  }
  return { shifts, payslips, weekNos, skipped, error: null };
}

/* ── the workbook path ────────────────────────────────────────────────────── */

/** One sheet's rows — arrays of cells, as SheetJS hands them over — as CSV text. */
export function sheetRowsToCsv(rows: unknown): string {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    return cells.map((cell) => csvCell(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell)).join(',');
  }).join('\n');
}

/** Does this sheet hold the shift table? Judged by the same three header names
 *  the shift parser looks for, so the sheet this picks is the sheet that will
 *  be read. */
function sheetHasShiftHeader(rows: unknown): boolean {
  return (Array.isArray(rows) ? rows : []).slice(0, 10).some((row) => {
    const h = (Array.isArray(row) ? row : []).map((c) => String(c == null ? '' : c).trim().toLowerCase());
    return h.includes('date') && h.includes('start time') && h.includes('end time');
  });
}

/** A workbook's sheets as one CSV document: the shift table first, then
 *  whatever else the file holds (the tax table), a blank line between them.
 *
 *  The order is the point. `parseTescoCsv` reads each table by finding its
 *  header, and it stops the shift table at the tax table's header — so a
 *  workbook that keeps the tax table above the shifts (any order Excel was
 *  happy to save) would hide every shift behind it. Putting the shift sheet
 *  first is done here rather than by asking the user to reorder their sheets. */
export function workbookToCsv(sheets: unknown): string {
  const list = (Array.isArray(sheets) ? sheets : [])
    .filter((s: any) => s && Array.isArray(s.rows) && s.rows.length);
  if (!list.length) return '';
  const shiftSheet = list.find((s: any) => sheetHasShiftHeader(s.rows));
  const ordered = shiftSheet ? [shiftSheet, ...list.filter((s: any) => s !== shiftSheet)] : list;
  return ordered.map((s: any) => sheetRowsToCsv(s.rows)).join('\n\n');
}

/* ── what a parsed row becomes once it is stored ──────────────────────────── */

/** Shared by the CSV import and the tab's own add path, so the two can never
 *  drift and the rules are testable. Both keep a row's own hours and pay, and
 *  neither drops a row that has no clock times — the sheet books a week off
 *  that way, and dropping it also lost the week's bank pay. */
export function storedShift(s: any, id: string, at: string): TescoShift | null {
  if (!s || !dateOk(s.date)) return null;
  const start = parseHM(s.start);
  const end = parseHM(s.end);
  const hours = statedHours(s.hours);
  if ((start == null || end == null) && hours == null) return null;
  const money = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : r2(Number(v)));
  const gross = money(s.gross);
  const bankPay = money(s.bankPay);
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

/** A booked week off: what the card asks for — any date in the week, and the
 *  hours of pay — turned into the row that gets stored.
 *
 *  The row is dated on the week's own Sunday rather than on the day that was
 *  picked. A pay week runs Sunday → Saturday, so the Sunday is the date that
 *  says which week this is, and the week card reads a row's date back as its
 *  weekday. The shape is the sheet's own week-off rows and what the quick
 *  entry writes for `week off 7h` — hours, no clock times, the same note — so a
 *  week off added here exports, imports and merges exactly like one that
 *  arrived in a file.
 *
 *  Hours are `statedHours`' bounds (up to 168) with zero excluded: a week off
 *  worth nothing is a mistyped week off. */
export function weekOffShift(date: unknown, hours: unknown):
  { ok: true; shift: TescoShift } | { ok: false; field: string; error: string } {
  const raw = String(date == null ? '' : date).trim();
  if (!dateOk(raw)) return { ok: false, field: 'date', error: 'Pick a date in the week you were off.' };
  const n = statedHours(String(hours == null ? '' : hours).trim());
  if (n == null || !(n > 0)) {
    return { ok: false, field: 'hours', error: 'Hours of pay should be more than 0 and up to 168.' };
  }
  return {
    ok: true,
    shift: { date: weekStartOf(raw), start: '', end: '', hours: n, note: 'week off', special: false },
  };
}

export type ShiftEditResult =
  | { ok: true; shift: TescoShift }
  | { ok: false; field: string; error: string };

/** One shift's fields, validated by the same rules `storedShift` applies to a
 *  row arriving from a file — the two must agree, or a hand edit could write a
 *  row the importer would have refused.
 *
 *  `others` holds the rest of the tab's shifts as `date|start|end` keys: editing
 *  a row onto another row's day and times is refused for the same reason an
 *  import of it would be.
 *
 *  The row keeps its id and createdAt. Sync unions shifts by id, so minting a
 *  new id here would resurrect the old row from the other device on the next
 *  merge. */
export function applyShiftEdit(shift: any, fields: any, others: string[] = []): ShiftEditResult {
  const base = shift && typeof shift === 'object' ? shift : {};
  const f = fields && typeof fields === 'object' ? fields : {};
  const pick = (key: string): unknown => (key in f ? f[key] : base[key]);

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
  if (!blankHours && hours == null) {
    return { ok: false, field: 'hours', error: 'Hours should be a number between 0 and 168.' };
  }

  const hasTimes = start != null && end != null;
  if (!hasTimes && hours == null) {
    return {
      ok: false,
      field: start == null ? 'start' : 'end',
      error: 'Add both clock times, or state the hours for a week off.',
    };
  }

  // A row's own pay wins over hours × rate, which is how the sheet's older
  // rates survive an import. The same rule means fixing the times of such a
  // row would leave its old figure silently in place, so a stated pay is
  // editable here — blank it to go back to hours × rate.
  const rawGross = pick('gross');
  const blankGross = rawGross === '' || rawGross == null;
  let gross: number | null = null;
  if (!blankGross) {
    const n = Number(rawGross);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, field: 'gross', error: 'Pay should be a number €0 or more, or blank to use hours × rate.' };
    }
    gross = r2(n);
  }

  const next: TescoShift = {
    ...base,
    date,
    start: start == null ? '' : fmtHM(start),
    end: end == null ? '' : fmtHM(end),
    note: String(pick('note') ?? '').slice(0, 120).trim(),
    special: !!pick('special'),
  };
  // Blanking a field has to remove the key, not just omit it from the spread:
  // an inherited `hours` would keep out-ranking the clock times.
  if (hours == null) delete next.hours; else next.hours = hours;
  if (gross == null) delete next.gross; else next.gross = gross;

  const key = `${next.date}|${next.start}|${next.end}`;
  if (others.includes(key)) {
    return { ok: false, field: 'date', error: 'Another shift on that day already covers the same times.' };
  }
  return { ok: true, shift: next };
}

/** The row's own date and week number, not the snapped Sunday: the sheet's tax
 *  table holds two rows for a week that had two pay runs, and keying by the
 *  week merged them. buildPayWeeks snaps the date for grouping, so the week
 *  still adds up — while the export writes back the date the sheet holds. */
export function storedPayslip(p: any, id: string, at: string): TescoPayslip {
  const no = Math.trunc(Number(p.weekNo));
  const bank = p.bankPay == null || !Number.isFinite(Number(p.bankPay)) ? null : r2(Number(p.bankPay));
  return {
    id, weekStart: p.weekStart,
    paye: +p.paye || 0, usc: +p.usc || 0, prsi: +p.prsi || 0, futureFund: +p.futureFund || 0,
    ...(no >= 1 && no <= 53 ? { weekNo: no } : {}),
    ...(bank == null ? {} : { bankPay: bank }),
    createdAt: at,
  };
}

/* ── quick entry: a shift typed as a sentence ────────────────────────────── */

const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
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

function isoFromParts(year: number, month: number, day: number): string | null {
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return dateOk(iso) ? iso : null;
}

function isoAddDays(iso: string, days: number): string {
  const d = isoToUtcMidnight(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Day-first is the sheet's own order, so it is the default; a part over 12 can
// only be the day, which settles the other way round without being asked.
function dayMonth(first: number, second: number): { day: number; month: number } {
  return first > 12 || second > 12
    ? { day: Math.max(first, second), month: Math.min(first, second) }
    : { day: first, month: second };
}

/** A date that names its own year, so nothing about it can be read as a time
 *  range: the ISO form, and any three-part form whose last part is four
 *  digits. Taken out of the line before the range is looked for. */
function readDatedYear(text: string): { matched: string; iso: string | null; token?: string } | null {
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
 *  date. */
function readShiftDate(text: string, today: string): { matched: string; iso: string | null; token?: string } | null {
  const year = /\b(20\d{2})\b/.exec(text);
  const dated = readDatedYear(text);
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
  for (const [pattern, monthAt] of [[SPELLED_DAY_FIRST, 2], [SPELLED_MONTH_FIRST, 1]] as Array<[RegExp, number]>) {
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
function clockMinutes(token: string, meridiem?: string): number | null {
  if (!token) return null;
  const word = token.toLowerCase();
  if (word === 'noon' || word === 'midday') return 12 * 60;
  if (word === 'midnight') return 0;
  let hour: number;
  let minute = 0;
  if (/^\d{3,4}$/.test(token)) { hour = +token.slice(0, -2); minute = +token.slice(-2); } else {
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
function shiftRange(a: string, am: string | undefined, b: string, bm: string | undefined):
  { start: number; end: number } | null {
  let start = clockMinutes(a, am);
  let end = clockMinutes(b, bm);
  if (start == null || end == null) return null;
  const otherHalf = (half: string) => (half === 'pm' ? 'am' : 'pm');
  const halfOf = (raw?: string) => (raw || '').replace(/\./g, '').toLowerCase();
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

export interface ShiftParseResult {
  shifts: TescoShift[];
  problems: Array<{ line: number; text: string; error: string }>;
}

/** Read one shift per line. Returns the rows that are ready to store and, for
 *  every line that is not, why — a bad line never costs the good ones beside
 *  it.
 *
 *  Two decisions carry the grammar, and both are about not guessing:
 *
 *   1. A full date is taken out of the line first, then the time range. "13-09"
 *      is indistinguishable from a shift running 13:00 → 09:00, so a dashed
 *      date must carry its year ("13-09-2026") and a partial date is written
 *      with slashes or dots ("13/09"). Paying a day at the wrong time is worse
 *      than asking for a clearer line, so an unclear one is asked about.
 *   2. A range with no am/pm is read as a 12-hour clock when that lands the end
 *      after the start ("8-4" is 08:00 → 16:00) and as an overnight shift when
 *      it cannot ("20-1" is 20:00 → 01:00). One unambiguous half of the day
 *      ("8am-4", "4-9pm") teaches the other half which half it means. */
export function parseShiftText(text: unknown, today: string): ShiftParseResult {
  const day = dateOk(today) ? today : todayIso();
  const shifts: TescoShift[] = [];
  const problems: Array<{ line: number; text: string; error: string }> = [];
  String(text || '').split(/\r?\n|;/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const fail = (error: string) => problems.push({ line: index + 1, text: line, error });
    let rest = ` ${line} `;
    const take = (matched: string) => { rest = rest.replace(matched, ' '); };

    // A date that carries its year first, so the range scan below cannot read
    // part of it as a shift ("8.30-16.30" is a range; a date is not).
    let date = readDatedYear(rest);
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
    let start: number | null = null;
    let end: number | null = null;
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
    let hours: number | null = null;
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
      date: date ? date.iso! : day,
      start: start == null ? '' : fmtHM(start),
      end: end == null ? '' : fmtHM(end),
      ...(hours == null ? {} : { hours }),
      special: !!specialMatch,
      note,
    });
  });
  return { shifts, problems };
}
