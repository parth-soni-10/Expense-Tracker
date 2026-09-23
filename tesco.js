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
       USC (0.5/2/3/8% bands), PRSI (4.2% with tapering credit),
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

// ---------- constants ----------
export const TESCO_RATE_DEFAULTS = Object.freeze({
  normal: 14.44,          // €/h Monday–Saturday
  specialMultiplier: 1.5, // Sunday & bank holidays
  pensionPct: 1.5,        // Future Fund employee share, % of gross
  payeCredit: 76.93,      // €/week tax credit
  payeCutoff: 846.15,     // €/week 20% band ceiling
  payeRateLow: 20,        // %
  payeRateHigh: 40,       // %
  prsiRate: 4.2,          // % (Oct 2025 class A0)
});
const PAY_LAG_DAYS = 11;   // the sheet's pay-date formula: week start + 11 (Thursday)
// 0=Sun..6=Sat. The workbook anchors each pay week on its **Sunday**: the
// weekly SUM block (L = SUM(J…:J…)) sits on the Sunday row and sums Sunday →
// Saturday, and every hand-entered "Week Start Date" in the tax table is a
// Sunday. Anchoring on Saturday instead shifted whole weeks by a day, which
// moved a week's gross — and therefore its tax, pension and net — into the
// neighbouring week.
const WEEK_START_DOW = 0;
// The photo is read as a few overlapping horizontal strips rather than one
// canvas: a roster carries a name column and small date tokens that a 2000px
// downscale loses entirely, while a full 4080px page at the upscale those
// glyphs need would be ~200 MB. Half-height strips keep every glyph at the
// resolution that reads and stay inside a 12 MP working budget (ocrStripWords),
// and the 50% overlap means no line is ever cut in half.
const OCR_STRIP_H = 0.5;    // each strip covers half the photo's height
const OCR_STRIP_COUNT = 3;  // starts at 0 / 25% / 50%, so the strips overlap by half

// ---------- small helpers ----------
// Currency rounding, half away from zero — matches Excel's ROUND(). The
// epsilon matters: 0.2*550.525-76.93 is 33.174999... in binary, which plain
// Math.round would take down to 33.17 where the spreadsheet says 33.18.
export function r2(v) {
  const n = Number(v) || 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7) / 100;
}
function pad2(n) { return String(n).padStart(2, '0'); }
export function isoLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function todayIso() { return isoLocal(new Date()); }

export function parseHM(str) {
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = +m[1], min = m[2] ? +m[2] : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
export function fmtHM(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

function isoToUtcMidnight(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function dateOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(isoToUtcMidnight(s).getTime()); }

// ---------- engine: hours ----------
// Break deduction ladder, exactly the spreadsheet's IFS:
//   starts before 12:00 AND ≥7h → −60m; >7h → −45m; >6h → −30m; >5h → −15m.
export function paidHours(startMin, endMin) {
  let raw = endMin - startMin;
  if (raw <= 0) raw += 1440; // overnight shift
  const startH = startMin / 60, rawH = raw / 60;
  let paid = rawH;
  if (startH < 12 && rawH >= 7) paid = rawH - 1;
  else if (rawH > 7) paid = rawH - 0.75;
  else if (rawH > 6) paid = rawH - 0.5;
  else if (rawH > 5) paid = rawH - 0.25;
  return r2(paid);
}
export function isOvernight(startMin, endMin) { return endMin <= startMin; }

// ---------- engine: pay & tax ----------
export function isSunday(dateStr) { return isoToUtcMidnight(dateStr).getUTCDay() === 0; }

export function shiftPay(shift, rates) {
  const R = { ...TESCO_RATE_DEFAULTS, ...rates };
  const start = parseHM(shift.start), end = parseHM(shift.end);
  if (start == null || end == null) return null;
  const hours = paidHours(start, end);
  const special = !!shift.special || isSunday(shift.date);
  const rate = r2(special ? R.normal * R.specialMultiplier : R.normal);
  return { hours, special, rate, gross: r2(hours * rate) };
}

// The spreadsheet's Potential Tax formula, ported 1:1 (all €/week figures).
export function simulateTax(gross, rates) {
  const R = { ...TESCO_RATE_DEFAULTS, ...rates };
  const g = Math.max(0, Number(gross) || 0);
  const lo = R.payeRateLow / 100, hi = R.payeRateHigh / 100;
  const paye = Math.max(0, r2(lo * Math.min(g, R.payeCutoff) + hi * Math.max(0, g - R.payeCutoff) - R.payeCredit));
  const uscBands = [231, 551.9230769, 1347.2307692];
  const usc = r2(
    0.005 * Math.min(g, uscBands[0]) +
    0.02 * Math.max(0, Math.min(g, uscBands[1]) - uscBands[0]) +
    0.03 * Math.max(0, Math.min(g, uscBands[2]) - uscBands[1]) +
    0.08 * Math.max(0, g - uscBands[2])
  );
  const prsiGross = g * R.prsiRate / 100;
  const CREDIT_THRESHOLD = 352.01, MAX_CREDIT = 12;
  const prsiCredit = g < CREDIT_THRESHOLD ? 0 : (g <= 424 ? MAX_CREDIT - (g - CREDIT_THRESHOLD) / 6 : 0);
  const prsi = Math.max(0, r2(prsiGross - prsiCredit));
  // The sheet's pension column is a raw percentage (N17 = L*1.5%) and its
  // Calculated Income subtracts that raw value (O17 = L−M−N), so rounding the
  // pension before subtracting moves the net by a cent whenever the raw figure
  // lands on a half-cent (€287.00 → 4.305). Keep the rounded value for display,
  // the raw one for the net.
  const pensionRaw = g * R.pensionPct / 100;
  const pension = r2(pensionRaw);
  const tax = r2(paye + usc + prsi);
  return { paye, usc, prsi, pension, tax, net: r2(g - tax - pensionRaw) };
}

// ---------- engine: pay weeks ----------
export function weekStartOf(dateStr) {
  const d = isoToUtcMidnight(dateStr);
  const shift = (d.getUTCDay() - WEEK_START_DOW + 7) % 7; // days since the week's start
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}
export function payDateOf(weekStart) {
  const d = isoToUtcMidnight(weekStart);
  d.setUTCDate(d.getUTCDate() + PAY_LAG_DAYS);
  return d.toISOString().slice(0, 10);
}
// The week number to show for a pay week. A stored number — typed by hand on a
// week card, or imported from the sheet's own column — always wins; otherwise
// the nearest stored number earlier in the year carries forward one per week,
// which is how the sheet's counter behaves. With nothing stored anywhere, the
// ISO number is a sane placeholder. (The sheet restarts at 1 each March, so a
// year boundary is corrected by editing that week once.)
export function weekNumberOf(weekStart, weekNos) {
  const map = weekNos && typeof weekNos === 'object' ? weekNos : {};
  const stored = (key) => {
    const no = Math.trunc(Number(map[key]));
    return Number.isFinite(no) && no >= 1 ? no : null;
  };
  const own = stored(weekStart);
  if (own != null) return own;
  // Otherwise the nearest stored number either side carries across, one per
  // week — so a single week typed by hand numbers the weeks around it too.
  // Counting through a March reset would land at nought or below, so a
  // candidate that does is passed over and the ISO week stands in instead.
  const base = isoToUtcMidnight(weekStart);
  for (let step = 1; step <= 60; step++) {
    for (const [dir, at] of [[-1, step], [1, -step]]) {
      const day = new Date(base);
      day.setUTCDate(day.getUTCDate() + 7 * at);
      const hit = stored(day.toISOString().slice(0, 10));
      if (hit != null && hit + dir * step >= 1) return hit + dir * step;
    }
  }
  return isoWeekNumber(weekStart);
}

export function isoWeekNumber(dateStr) {
  const d = isoToUtcMidnight(dateStr);
  const target = new Date(d);
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
}

export function nextWeekStart(afterIso) {
  const d = isoToUtcMidnight(weekStartOf(afterIso));
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

// Group shifts and payslips into Sunday→Saturday pay weeks. A payslip's typed
// weekStart is snapped to its week's Sunday so the two sides always join.
export function buildPayWeeks(shifts, payslips, rates) {
  const weeks = new Map();
  const week = (key) => {
    if (!weeks.has(key)) weeks.set(key, { weekStart: key, shifts: [], payslips: [] });
    return weeks.get(key);
  };
  for (const s of shifts) week(weekStartOf(s.date)).shifts.push(s);
  for (const p of payslips) week(weekStartOf(p.weekStart)).payslips.push(p);
  for (const w of weeks.values()) {
    w.shifts.sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
    w.payslips.sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
    // One payslip per week is the normal case, and the row the tab edits. A
    // correction run inside the same week adds to it instead of one silently
    // replacing the other — the sheet's tax table holds both rows, and the
    // importer has always summed them.
    w.payslip = w.payslips[w.payslips.length - 1] || null;
    w.paid = r2(w.payslips.reduce((sum, p) => sum + payslipTotal(p), 0));
    const banked = w.payslips.filter(p => p.bankPay != null && Number.isFinite(Number(p.bankPay)));
    // The sheet's Final Bank Pay, typed from a bank statement: the net that
    // actually landed, which no formula here can derive (holiday pay, a refund
    // or a correction are all reasons it differs from gross − tax).
    w.bankPaid = banked.length ? r2(banked.reduce((sum, p) => sum + Number(p.bankPay), 0)) : null;
    // One pass at the user's rates, so a week's totals always agree with the
    // per-shift rows the tab prints under them and with monthSummary above.
    const pays = w.shifts.map(s => shiftPay(s, rates)).filter(Boolean);
    w.gross = r2(pays.reduce((sum, p) => sum + p.gross, 0));
    w.hours = r2(pays.reduce((sum, p) => sum + p.hours, 0));
  }
  return [...weeks.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

// Money that actually landed. A week whose payslip recorded its net into the
// bank uses that figure — the sheet types it from a statement, and it is the
// only way holiday pay, a tax refund or a correction can be counted, since the
// shift rows cannot express any of them. Otherwise it is the spreadsheet's
// Calculated Income (O = Gross Income − Potential Tax − Pension): the week's
// gross minus the tax + Future Fund its payslips recorded. A payslip with no
// shifts beside it has no gross to net against, so it contributes nothing.
function receivedTotal(weeks) {
  return r2(weeks.reduce((sum, w) => {
    if (w.bankPaid != null) return sum + w.bankPaid;
    return w.payslips.length && w.shifts.length ? sum + (w.gross - w.paid) : sum;
  }, 0));
}
// Month summary — the spreadsheet's monthly stats block, simplified to a
// calendar-month basis: hours/anticipated by shift date, received by the pay
// week whose week start falls in the month.
export function monthSummary(shifts, payslips, rates, year, monthIdx) {
  const inMonth = iso => { const d = isoToUtcMidnight(iso); return d.getUTCFullYear() === year && d.getUTCMonth() === monthIdx; };
  let hours = 0, anticipated = 0;
  for (const s of shifts) {
    if (!inMonth(s.date)) continue;
    const p = shiftPay(s, rates);
    if (p) { hours += p.hours; anticipated += p.gross; }
  }
  const received = receivedTotal(buildPayWeeks(shifts, payslips, rates).filter(w => inMonth(w.weekStart)));
  return { hours: r2(hours), anticipated: r2(anticipated), received };
}
export function lifetimeTotals(shifts, payslips, rates) {
  let hours = 0, anticipated = 0;
  for (const s of shifts) {
    const p = shiftPay(s, rates);
    if (p) { hours += p.hours; anticipated += p.gross; }
  }
  return { hours: r2(hours), anticipated: r2(anticipated), received: receivedTotal(buildPayWeeks(shifts, payslips, rates)) };
}
export function payslipTotal(p) { return r2((+p.paye || 0) + (+p.usc || 0) + (+p.prsi || 0) + (+p.futureFund || 0)); }

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
export const TESCO_CSV_PAYSLIP_HEADER = Object.freeze(['Week Start Date', 'Pay Date', 'PAYE', 'USC', 'PRSI', 'Future Fund', 'Final Bank Pay']);

// A field is quoted only when it has to be, so the file stays readable — and a
// note containing a comma survives the round trip.
//
// A value that a spreadsheet would read as a formula (a leading =, +, - or @
// after any whitespace) gets an apostrophe in front. Excel, LibreOffice and
// Sheets all treat a leading apostrophe as "this cell is text", which is what
// stops a note like "=HYPERLINK(…)" or "=cmd|…" from executing when the
// export is opened — notes can be typed, imported from a file someone else
// made, or arrive in a synced cloud copy, so the file is not a safe container
// for one. csvUnquote() strips the apostrophe back off on import, so the round
// trip through this app is lossless.
const CSV_FORMULA_PREFIX = /^\s*[+\-=@]/;
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (CSV_FORMULA_PREFIX.test(s)) s = `'${s}`;
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Reverse of csvCell's apostrophe guard — the one field it can land on.
 *  Whitespace after the apostrophe is allowed because the guard fires on a
 *  value like "  @break" too, and the import trims it away regardless. */
function csvUnquote(v) {
  const s = String(v == null ? '' : v);
  return s.length > 1 && s[0] === "'" && /^\s*[+\-=@]/.test(s.slice(1)) ? s.slice(1) : s;
}
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
  const lines = [TESCO_CSV_HEADER.join(',')];
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
        // The sheet's Final Bank Pay is typed from a bank statement. Where the
        // week's payslip recorded its net, that is what landed; otherwise the
        // app exports what should have (gross minus the tax it recorded) rather
        // than inventing a number.
        w.payslip ? csvNum(w.bankPaid != null ? w.bankPaid : w.gross - w.paid) : '');
    } else {
      row.push('', '', '', '', '');
    }
    row.push(s.note || '');
    lines.push(row.map(csvCell).join(','));
  }
  const slips = (payslips || []).slice().sort((a, b) => weekStartOf(a.weekStart).localeCompare(weekStartOf(b.weekStart)));
  if (slips.length) {
    lines.push('', TESCO_CSV_PAYSLIP_HEADER.join(','));
    for (const p of slips) {
      // The stored week start, not the snapped one: a second pay run inside the
      // same Sun → Sat week keeps its own date, the way the sheet's tax table
      // holds two rows for it. The import snaps both back onto the week.
      const ws = weekStartOf(p.weekStart);
      lines.push([p.weekStart, payDateOf(ws), csvNum(p.paye), csvNum(p.usc), csvNum(p.prsi), csvNum(p.futureFund), csvNum(p.bankPay)].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

// A real CSV splitter: quoted fields may hold commas, doubled quotes and
// newlines, Excel writes CRLF, and its export of the sheet opens with an empty
// column A — all of which a split(',') would mangle.
function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Dates arrive as ISO, as an Excel serial, or in the sheet's own day-first
// locale format; times as HH:MM(:SS) or as the bare day fraction Excel stores.
function csvDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    return n > 20000 && n < 80000 ? new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10) : null;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(s);   // day-first, the sheet's locale
  if (!m) return null;
  return `${m[3].length === 2 ? 2000 + +m[3] : +m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
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
// and the sheet's empty leading column all work. Only the inputs are imported —
// the computed columns (hours, gross, tax, pension, net, bank pay) are derived
// from the times and the rate card, never trusted from the file.
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
  let skipped = 0;
  if (shiftHead >= 0) {
    const head = norm(rows[shiftHead]);
    const iDate = at(head, 'date', 'effective date'), iStart = at(head, 'start time'), iEnd = at(head, 'end time');
    const iSpecial = at(head, 'normal or special', 'type'), iNote = at(head, 'description', 'note');
    // The file's own week number, so a sheet's hand-typed count comes across
    // with the shifts instead of being replaced by the ISO number.
    const iWeekNo = at(head, 'week');
    // Stop at the tax table so its rows are never read as shifts.
    const end = slipHead > shiftHead ? slipHead : rows.length;
    for (const r of rows.slice(shiftHead + 1, end)) {
      const date = csvDate(r[iDate]), start = csvTime(r[iStart]), end = csvTime(r[iEnd]);
      if (!date || !dateOk(date) || start == null || end == null) { skipped++; continue; }
      shifts.push({
        date, start, end,
        special: /^s/i.test(String(r[iSpecial] == null ? '' : r[iSpecial]).trim()),
        note: iNote < 0 ? '' : csvUnquote(String(r[iNote] == null ? '' : r[iNote]).trim()).slice(0, 120),
      });
      const no = iWeekNo < 0 ? 0 : Math.trunc(Number(String(r[iWeekNo] == null ? '' : r[iWeekNo]).trim()));
      if (Number.isFinite(no) && no >= 1 && no <= 53) weekNos[weekStartOf(date)] = no;
    }
  }

  const payslips = [];
  if (slipHead >= 0) {
    const head = norm(rows[slipHead]);
    const iWeek = at(head, 'week start date', 'week start', 'date');
    // One payslip per pay week: the sheet can hold two pay runs inside one week
    // (a correction, say), and those are the same week's tax, so they add up
    // rather than one silently replacing the other.
    const fields = [['paye', 'paye'], ['usc', 'usc'], ['prsi', 'prsi'], ['futureFund', 'future fund']];
    const iBank = at(head, 'final bank pay', 'net paid');
    const byWeek = new Map();
    for (const r of rows.slice(slipHead + 1)) {
      const ws = csvDate(r[iWeek]);
      if (!ws || !dateOk(ws)) { skipped++; continue; }
      const cell = i => i < 0 ? 0 : (Number(String(r[i] == null ? '' : r[i]).replace(/[^\d.-]/g, '')) || 0);
      const week = weekStartOf(ws);
      let draft = byWeek.get(week);
      if (!draft) {
        draft = { weekStart: week, paye: 0, usc: 0, prsi: 0, futureFund: 0 };
        byWeek.set(week, draft);
      }
      for (const [key, col] of fields) draft[key] += cell(head.indexOf(col));
      // The net that reached the bank. A blank cell must stay "not known" so
      // the week keeps falling back to gross − tax, and two runs in one week
      // add up the way their tax figures do.
      if (iBank >= 0) {
        const raw = String(r[iBank] == null ? '' : r[iBank]).replace(/[^\d.-]/g, '');
        const n = Number(raw);
        if (raw !== '' && Number.isFinite(n)) draft.bankPay = (draft.bankPay || 0) + n;
      }
    }
    payslips.push(...byWeek.values());
  }
  return { shifts, payslips, weekNos, skipped, error: null };
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
export function parseTimeCell(raw) {
  let s = fixDigits(String(raw || '').trim().replace(/[.,;]+$/, ''));
  if (!s || /^(off|n\/?a|none|-+|\/+)$/i.test(s)) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?$/.exec(s);
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
function parseDateToken(text, today) {
  const m = /^(\d{1,2})[-/. ]([A-Za-z0-9]{2,9})$/.exec(String(text || '').trim());
  if (!m) return null;
  const mon = matchMonth(m[2]);
  if (mon == null) return null;
  return today ? inferDate(+m[1], Object.keys(MONTHS)[mon], today) : true;
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
export function parseRosterWords(rawWords, today = new Date(Date.UTC(2026, 8, 22)), opts = {}) {
  const words = (rawWords || [])
    .filter(w => w && String(w.text || '').trim() && (w.confidence == null || w.confidence > 25))
    .map(w => ({ ...w, text: String(w.text).trim(), cy: (w.y0 + w.y1) / 2, h: Math.max(1, w.y1 - w.y0) }))
    .sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  if (!words.length) return { rows: [], columns: [] };

  const medianH = words.map(w => w.h).sort((a, b) => a - b)[Math.floor(words.length / 2)];
  const rowTol = Math.max(medianH * 0.9, 14);
  const rows = [];
  for (const w of words) {
    const row = rows.find(r => Math.abs(r.cy - w.cy) <= rowTol);
    if (row) { row.items.push(w); row.cy = row.items.reduce((s, i) => s + i.cy, 0) / row.items.length; }
    else rows.push({ cy: w.cy, items: [w] });
  }
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

  // Header band: the contiguous run of leading rows that actually carry a
  // date token or a weekday name (a store/title row above them is skipped).
  // Rows below the band are staff rows, so the band must close at the first
  // row without a header token — otherwise the staff rows land inside it.
  const headerRows = [];
  for (const row of rows.slice(0, Math.min(5, rows.length))) {
    const isHeader = row.phrases.some(ph => parseDateToken(ph.text) || weekdayOf(ph.text) != null);
    if (isHeader) headerRows.push(row);
    else if (headerRows.length) break;
  }
  const candidates = [];
  for (const row of headerRows) {
    for (const ph of row.phrases) {
      const d = parseDateToken(ph.text, today);
      if (d) { candidates.push({ cx: (ph.x0 + ph.x1) / 2, date: d, confidence: ph.confidence }); continue; }
      const wd = weekdayOf(ph.text);
      if (wd != null) candidates.push({ cx: (ph.x0 + ph.x1) / 2, weekday: wd, confidence: ph.confidence });
    }
  }
  // Merge near-identical column anchors (date + weekday on the same column).
  candidates.sort((a, b) => a.cx - b.cx);
  const mergedCols = [];
  for (const c of candidates) {
    const last = mergedCols[mergedCols.length - 1];
    if (last && Math.abs(last.cx - c.cx) <= medianH * 3) {
      if (c.date && !last.date) { last.date = c.date; last.confidence = c.confidence; }
      if (c.weekday != null && last.weekday == null) last.weekday = c.weekday;
    } else mergedCols.push({ ...c });
  }
  // Extrapolate the uniform grid outwards so missed header columns still map
  // (rosters are evenly spaced); cap at 7 columns.
  let cols = mergedCols;
  if (mergedCols.length >= 2) {
    const gaps = [];
    for (let i = 1; i < mergedCols.length; i++) gaps.push(mergedCols[i].cx - mergedCols[i - 1].cx);
    gaps.sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    if (gap > medianH * 2) {
      cols = [...mergedCols];
      let left = cols[0].cx - gap;
      while (cols.length < 7) { cols.unshift({ cx: left }); left -= gap; }
      let right = cols[cols.length - 1].cx + gap;
      while (cols.length < 7) { cols.push({ cx: right }); right += gap; }
    }
  }
  // A misread date token ("23-Sep" for 27-Sep) and its column's weekday name
  // cannot both be right — when they disagree, the day name is the reliable
  // signal, so drop the date and rebuild the whole series from the anchor that
  // best agrees with the day names across the grid.
  for (const c of cols) {
    if (c.date && c.weekday != null && c.date.getUTCDay() !== c.weekday) { c.date = null; c.confidence = 0; }
  }
  const agreement = (anchorIdx, anchorDate) => {
    let score = 0;
    cols.forEach((c, i) => {
      if (c.weekday == null) return;
      const d = new Date(anchorDate.getTime() + (i - anchorIdx) * 86400000);
      if (d.getUTCDay() === c.weekday) score += 1;
    });
    return score;
  };
  const anchors = cols.map((c, i) => ({ i, c })).filter(x => x.c.date);
  if (anchors.length) {
    let best = anchors[0], bestScore = -1;
    for (const a of anchors) {
      const score = agreement(a.i, a.c.date) * 1000 + (a.c.confidence || 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    cols.forEach((c, i) => { c.date = new Date(best.c.date.getTime() + (i - best.i) * 86400000); c.confidence = undefined; });
  } else if (cols.length) {
    // No usable date token: anchor the grid on the first day name, nearest to today.
    const first = cols.find(c => c.weekday != null);
    if (first) {
      const base = isoToUtcMidnight(isoLocalUTC(today));
      base.setUTCDate(base.getUTCDate() + ((first.weekday - base.getUTCDay() + 7) % 7));
      const off = cols.indexOf(first);
      cols.forEach((c, i) => { c.date = new Date(base.getTime() + (i - off) * 86400000); });
    }
  }

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

  // Staff rows: everything below the header band.
  const headerBottom = headerRows.length ? headerRows[headerRows.length - 1].cy + rowTol * 1.5 : rows[0].cy;
  const out = [];
  for (const row of rows) {
    if (row.cy <= headerBottom) continue;
    const firstColX = cols.length ? cols[0].cx : Infinity;
    const nameParts = [];
    const cellPhrases = [];
    for (const ph of row.phrases) {
      const cx = (ph.x0 + ph.x1) / 2;
      if (cx < firstColX - medianH * 2.2) nameParts.push(ph);
      else cellPhrases.push(ph);
    }
    if (!cellPhrases.length) continue;
    const name = nameParts.map(p => p.text).join(' ').trim();
    const cells = [];
    const usedCols = new Map(); // colIndex → best cell, so duplicate reads don't both default on
    for (const ph of cellPhrases) {
      const cx = (ph.x0 + ph.x1) / 2;
      let colIdx = -1, bestDist = Infinity;
      cols.forEach((c, i) => {
        const dist = Math.abs(c.cx - cx);
        if (dist < bestDist) { bestDist = dist; colIdx = i; }
      });
      const parsed = parseTimeCell(ph.text);
      if (!parsed) continue; // "off", headers, noise
      const col = colIdx >= 0 ? cols[colIdx] : null;
      const date = col && col.date ? isoLocalUTC(col.date) : null;
      const weekday = col && col.date ? col.date.getUTCDay() : (col && col.weekday != null ? col.weekday : null);
      const cell = {
        date, weekday,
        startMin: parsed.startMin, endMin: parsed.endMin,
        raw: ph.text, confidence: Math.round(ph.confidence),
        dupe: false,
      };
      const prev = usedCols.get(colIdx);
      if (prev) {
        // Two reads landed on one day (grid drift or a stray token): keep the
        // more confident as the default and flag the other for review.
        if (cell.confidence > prev.confidence) { prev.dupe = true; usedCols.set(colIdx, cell); }
        else cell.dupe = true;
      } else usedCols.set(colIdx, cell);
      cells.push(cell);
    }
    if (!cells.length) continue;
    out.push({
      name: name || '(unnamed row)',
      matches: opts.name ? nameMatches(name, opts.name) : false,
      cells,
    });
  }

  // Cells read at cell resolution (see ocrOwnerCells) belong to the row the
  // typed name matched: each came from a crop of one day column rather than from
  // a word box, so they replace that row's loose strip reads. When the pass
  // covered the whole grid its silence about a day means the day is blank; when
  // it only covered part of the grid, the strip reads it never covered are kept.
  if (Array.isArray(opts.cells) && opts.cells.length) {
    let owner = out.find(r => r.matches);
    if (!owner && opts.name) { owner = { name: opts.name, matches: true, cells: [] }; out.unshift(owner); }
    if (owner) {
      if (opts.cellsComplete) {
        owner.cells = opts.cells;
      } else {
        const merged = new Map(owner.cells.map(c => [c.date, c]));
        for (const c of opts.cells) merged.set(c.date, c);
        owner.cells = [...merged.values()];
      }
    }
  }
  return { rows: out, columns: cols };
}
function isoLocalUTC(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

// ---------- OCR: engine wiring (browser only) ----------
let _ocrPromise = null;
// The worker is created lazily and torn down again as soon as a scan finishes
// (see disposeOcrWorker): the only place a decoded roster image could outlive
// the scan is the worker's heap, and destroying it is the cheapest way to be
// certain nothing lingers. Re-scanning re-inits the engine (~2-3s; the model
// itself is cached in IndexedDB, so nothing is re-downloaded).
export async function disposeOcrWorker() {
  const pending = _ocrPromise;
  _ocrPromise = null;
  if (!pending) return;
  try { const worker = await pending; await worker.terminate(); } catch { /* already gone */ }
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
async function ensureOcrWorker() {
  if (!_ocrPromise) {
    _ocrPromise = (async () => {
      await loadTesseractScript();
      const origin = window.location.origin;
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: `${origin}/vendor/tesseract/worker.min.js`,
        corePath: `${origin}/vendor/tesseract`,
        langPath: `${origin}/vendor/tesseract`,
        // tesseract.js otherwise wraps its worker in a blob URL, and inside a
        // blob-based worker a relative URL has no base to resolve against, so
        // the core cannot locate its .wasm sibling ("Failed to parse URL").
        // Loading the worker from its real same-origin URL gives it a base,
        // which is what lets us ship the wasm as a plain file instead of the
        // 3.9 MB base64-inlined variant. That variant embeds the module as a
        // data: URL the core loads, which a strict connect-src blocks — it
        // only worked here by falling back, logging a CSP error per scan.
        workerBlobURL: false,
        logger: m => { if (m && typeof m.progress === 'number') _progressSink(m.progress); },
      });
    })();
    _ocrPromise.catch(() => { _ocrPromise = null; });
  }
  return _ocrPromise;
}

// Draw the photo onto the display canvas (fit to `maxW`), releasing the decoded
// bitmap immediately. Used for the on-screen preview.
export async function drawPhotoPreview(file, canvas, maxW = 720) {
  const buf = await file.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }), { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxW / bitmap.width);
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
}

// ---------- OCR: reading the photo ----------
// The reading pipeline is three small pieces, each with one job:
//   ocrStripRanges()  where to look (overlapping half-height strips)
//   ocrStripWords()   read one strip at the resolution small glyphs need
//   ocrRosterRow()    stop at the row carrying the typed name
// Read one horizontal strip and return its words in ORIGINAL-image pixel
// coordinates, so strips read separately stitch into one shared space.
//
// strip: [y0, y1] as fractions of image height. The decoded bitmap, the strip
// canvas and the blob all live only inside this call — the bitmap is released
// and the canvas zeroed before it returns, and nothing is written to storage,
// cache, or the network.
async function ocrStripWords(worker, file, canvas, strip) {
  let bitmap = null;
  try {
    const buf = await file.arrayBuffer();
    bitmap = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }), { imageOrientation: 'from-image' });
    const imgW = bitmap.width, imgH = bitmap.height;
    const sy = Math.max(0, Math.round(strip[0] * imgH));
    const sh = Math.max(24, Math.min(imgH - sy, Math.round((strip[1] - strip[0]) * imgH)));
    // Upscale toward the factor that works, capped by a 12 MP working budget.
    const scale = Math.max(0.5, Math.min(2, Math.sqrt(12e6 / Math.max(1, imgW * sh))));
    canvas.width = Math.max(1, Math.round(imgW * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, sy, imgW, sh, 0, 0, canvas.width, canvas.height);
    bitmap.close(); // pixel data released before recognition starts
    bitmap = null;

    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const result = await worker.recognize(blob);
    // v5 keeps words on data.words; fall back to walking blocks.
    let words = Array.isArray(result?.data?.words) ? result.data.words : [];
    if (!words.length && Array.isArray(result?.data?.blocks)) {
      words = result.data.blocks.flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
    }
    const kx = imgW / canvas.width, ky = sh / canvas.height;
    return words.map(w => ({
      text: w.text,
      x0: (w.bbox?.x0 ?? 0) * kx, x1: (w.bbox?.x1 ?? 0) * kx,
      y0: sy + (w.bbox?.y0 ?? 0) * ky, y1: sy + (w.bbox?.y1 ?? 0) * ky,
      confidence: w.confidence,
    }));
  } finally {
    // Runs on every path — success, a decode that threw, a cancelled scan — so
    // the strip canvas is always zeroed and the bitmap always released.
    if (bitmap) bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
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
const OCR_CELL_INSET = 0.07;   // keeps a column's own rule line out of the crop
const OCR_CELL_BG = 18;        // "darker than its own row's average by this much" = ink
const OCR_CELL_BG_FAINT = 8;   // for a cell in glare, where 18 finds no glyphs at all
const OCR_CELL_RUN = 0.6;      // a cell's ink: strokes, not a rule across the column
const OCR_CELL_DRIFT = 0.42;   // how far a cell's ink may sit from the row's line
// A cell is looked at through these views, best first, until one reads back as a
// shift. Flat-field first: it is the only one that survives glare.
const OCR_CELL_MODES = ['local', 'ink', 'grey'];
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

// Per-row ink counts for one column slice: one run per line of text.
function ocrInkProfile(bitmap, canvas, x0, y0, x1, y1, bg = OCR_CELL_BG, maxRunFrac = 0.22) {
  const w = Math.max(8, Math.round(x1 - x0));
  const h = Math.max(8, Math.round(y1 - y0));
  // A rectangle that is off the image, or one the grid produced as NaN, has no
  // ink to report — returning an empty profile keeps the caller on its normal
  // "nothing in this cell" path instead of throwing out of the whole scan.
  if (![w, h, x0, y0].every(Number.isFinite) || x1 - x0 < 8 || y1 - y0 < 8) return new Float32Array(0);
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
  const d = c.getImageData(0, 0, w, h).data;
  // Only runs of ink a GLYPH could make count: the sheet's own rule lines run
  // unbroken across the crop, so a row that is one long run is a rule, not
  // text — which is how a ruled roster stops reading as forty lines of ink.
  const maxRun = Math.max(6, Math.round(w * maxRunFrac));
  const ink = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const cut = rowInkCut(d, w, y, bg);
    const base = y * w * 4;
    let n = 0, run = 0;
    for (let x = 0; x < w; x++) {
      if (d[base + x * 4] < cut) { run++; continue; }
      if (run && run <= maxRun) n += run;
      run = 0;
    }
    if (run && run <= maxRun) n += run;
    ink[y] = n;
  }
  return ink;
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
  await worker.setParameters({ tessedit_char_whitelist: chars });
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

// Pure, so the decisions taken on a photo can be tested without one.
// Contiguous runs of ink in a vertical profile — one run per line of text.
export function ocrInkBands(ink, minInk = 2, minH = 4) {
  const bands = [];
  let start = -1, peak = 0;
  for (let i = 0; i <= ink.length; i++) {
    const v = i < ink.length ? ink[i] : 0;
    if (v >= minInk) {
      if (start < 0) { start = i; peak = v; } else if (v > peak) peak = v;
      continue;
    }
    if (start >= 0) {
      if (i - start >= minH) bands.push({ y0: start, y1: i, cy: (start + i) / 2, ink: peak });
      start = -1;
    }
  }
  return bands;
}

// Keep only the bands a line of text could be. A ruled sheet puts a faint rule
// between its rows, and a faint rule breaks into short runs as readily as text
// does, so richness of ink will not separate them — height does: glyphs are tens
// of pixels tall. Without this the row pitch reads as half its true value and a
// cell's crop lands on the rule instead of the shift.
export function ocrTextBands(bands) {
  const heights = bands.map(b => b.y1 - b.y0).sort((a, b) => a - b);
  const med = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  return bands.filter(b => b.y1 - b.y0 >= Math.max(8, med * 0.6));
}

// The part of a band that actually carries strokes. A profile band can run from
// one rule to the next, and a crop that includes those empty edges is what
// truncates a long line of text: cropped to its glyphs it reads back whole.
function ocrTightBand(ink, band, minInk) {
  let y0 = band.y0, y1 = band.y1;
  while (y0 < y1 && ink[y0] < minInk) y0++;
  while (y1 > y0 && ink[y1 - 1] < minInk) y1--;
  return { y0, y1, cy: (y0 + y1) / 2 };
}

// The line a cell sits on, as the centre of mass of the ink in its window. A
// band's midpoint is dragged by a rule welded to the text it shares a row with
// (the sheet's bands run from rule to rule), while the mass sits on the glyphs —
// which is what keeps a chain of cells on one row across a photo.
function ocrInkCentre(ink, minInk) {
  let sum = 0, mass = 0;
  for (let i = 0; i < ink.length; i++) { sum += i * ink[i]; mass += ink[i]; }
  return mass < minInk * 3 ? null : sum / mass;
}

// The line a cell sits on: the band nearest `prior`, and never one so far away
// that it must belong to the row above or below.
export function ocrPickBand(bands, prior, maxDrift) {
  let best = null, bestD = maxDrift;
  for (const b of bands) {
    const d = Math.abs(b.cy - prior);
    if (d <= bestD) { best = b; bestD = d; }
  }
  return best;
}

// Read the row the typed name sits on, cell by cell. Returns the cells it read
// (already in the shape parseRosterWords emits, dated off the same grid) and
// whether every column of that grid was attempted.
async function ocrOwnerCells(worker, file, canvas, opts = {}) {
  const { name, nameWord, cols, progress } = opts;
  const cells = [];
  // "Complete" only once the row itself is confirmed: a full grid read off the
  // wrong row would otherwise replace the matched row's cells with another
  // person's shifts. Unconfirmed, the pass merges instead of replacing.
  let complete = false;
  let bitmap = null;
  try {
    // Every read in this pass is one line of one cell, which is exactly what
    // "single text line" tells the engine to expect. The worker is disposed at
    // the end of the scan, so the strip pass's own setting is untouched.
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const buf = await file.arrayBuffer();
    bitmap = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }), { imageOrientation: 'from-image' });
    const imgW = bitmap.width, imgH = bitmap.height;
    // Column bounds: halfway between neighbouring centres, half a gap at each
    // end, then inset clear of the rule lines.
    const cx = cols.map(c => c.cx);
    const bounds = cx.map((c, i) => {
      const left = i > 0 ? (cx[i - 1] + c) / 2 : c - (cx[1] - cx[0]) / 2;
      const right = i < cx.length - 1 ? (c + cx[i + 1]) / 2 : c + (c - cx[i - 1]) / 2;
      const inset = Math.max(2, (right - left) * OCR_CELL_INSET);
      return [Math.max(0, left + inset), Math.min(imgW, right - inset)];
    });

    // Three rectangles, one job each: the name column's strip is what the rows
    // are measured in, the name itself is read from a box that reaches far enough
    // left to hold it, and each day column is cropped inside its own bounds.
    const colGap = Math.max(40, cx[1] - cx[0]);
    const profX0 = Math.max(0, cx[0] - colGap * 0.95);
    const profX1 = Math.max(profX0 + 40, cx[0] - colGap * 0.15);
    const nameX0 = Math.max(0, cx[0] - colGap * 1.3);
    // 5% of the strip's width per row: a line of text puts tens of stroke pixels
    // in a row, while paper grain and a faint rule leave a handful — at 2% the
    // noise read as ink and every row looked 60px tall.
    const nameMinInk = Math.max(4, Math.round((profX1 - profX0) * 0.05));

    // Pitch: a line of text is tens of pixels tall and a sheet's rows are a little
    // over twice that. Measuring the TEXT heights is what sizes a window that
    // holds one row and not its neighbours — a rule is a few pixels tall, and
    // reading rules as rows made the pitch come out at half its true value.
    const textHeights = ocrInkBands(ocrInkProfile(bitmap, canvas, profX0, 0, profX1, imgH), nameMinInk, 3)
      .map(b => b.y1 - b.y0).filter(h => h >= 14).sort((a, b) => a - b);
    const textH = textHeights.length ? textHeights[Math.floor(textHeights.length / 2)] : imgH * 0.012;
    const pitch = Math.min(Math.max(textH * 2.1, imgH * 0.012), imgH * 0.05);
    // The window a cell is looked for in: one row's worth either side of the line,
    // and no more. Widening it to catch a cell whose text sits high in a tilted
    // photo merges the neighbouring rows' bands into a single run instead, which
    // measures worse on the sample roster than the tighter window does.
    const win = Math.max(10, Math.round(pitch * 0.45));

    // The row's line. A word box's HEIGHT is unreliable but its centre is not —
    // the strip read puts the name within a few pixels of its line — so the row
    // is that point refined by the ink around it. One measurement, not a chain of
    // bands: a chain accumulates whatever bias each column has and walks onto the
    // next row (measured on a real roster: 12px a column, one whole row off by the
    // last day).
    const anchorCy = (nameWord.y0 + nameWord.y1) / 2;
    const probe0 = Math.max(0, Math.round(anchorCy - win));
    const probeRel = ocrInkCentre(ocrInkProfile(bitmap, canvas, profX0, probe0, profX1, Math.min(imgH, Math.round(anchorCy + win))), nameMinInk);
    const rowCy = probeRel == null ? anchorCy : probe0 + probeRel;

    // Confirm the row by reading its name, one word at a time: the strip carries
    // the band column beside the name ("Parth 20"), which no whole-line compare
    // survives.
    progress(0.86, 'Checking your name on this row');
    const nameRead = await ocrReadCell(worker, bitmap, canvas, {
      x0: nameX0, x1: profX1, y0: Math.max(0, Math.round(rowCy - textH * 0.8)), y1: Math.min(imgH, Math.round(rowCy + textH * 0.8)),
    }, { accept: text => String(text).split(/\s+/).some(w => nameMatches(w, name)) });
    const validated = String(nameRead.text || '').split(/\s+/).filter(Boolean).some(w => nameMatches(w, name));
    if (!validated) progress(0.87, 'That row does not carry your name');

    for (let i = 0; i < cols.length; i++) {
      const [x0, x1] = bounds[i];
      if (!(x1 - x0 > 20)) continue;
      progress(0.88 + (i / cols.length) * 0.1, `Reading shift ${i + 1} of ${cols.length}`);
      // Measure the column's ink between its own rule lines, never across them:
      // a vertical rule runs the full height of the crop, so leaving it in puts
      // the same ink on every row and the "line" reads as the window's middle —
      // which is exactly where the sheet's horizontal rule sits.
      const inset = Math.max(3, Math.round((x1 - x0) * 0.06));
      // A rule is short and fat, a line of glyphs is tall — and the sheet's rule
      // sits directly under its text, so a lax height test picks the rule as the
      // row's line and crops the glyphs in half. Keep only bands as tall as the
      // name that anchors this row, then take the one nearest it.
      //
      // Only a band as tall as the name that anchors this row can be a line of
      // text; the rule directly beneath it is shorter.
      const minBandH = Math.max(6, Math.round(textH * 0.75));
      const margin = Math.round(textH * 0.15);
      let parsed = null, read = { text: '', confidence: 0 };
      // A cell's text is not always on the line the row is tracked at: the sheet's
      // day columns drift tens of pixels from it when the photo is taken at an
      // angle, and the glyphs hang above the rule the tracking follows. So a cell
      // that reads back as nothing gets a second look with the window lifted by a
      // text height — and only the cells that fail pay for it. The same two looks
      // are then repeated at a fainter sensitivity, for cells in the photo's glare.
      for (const bg of [OCR_CELL_BG, OCR_CELL_BG_FAINT]) {
        for (const lift of [0, Math.round(textH * 0.6)]) {
          const line = rowCy - lift;
          const win0 = Math.max(0, Math.round(line - win));
          const win1 = Math.min(imgH, Math.round(line + win));
          // Under glare a glyph's strokes blur into each other and the run limit
          // written for rule lines starts discarding them as if they were rules, so
          // a cell is profiled with a limit only a rule across the whole column
          // can exceed.
          const profile = ocrInkProfile(bitmap, canvas, x0 + inset, win0, x1 - inset, win1, bg, OCR_CELL_RUN);
          // Of the bands in the window, the line of text is the tall one and the
          // sheet's rule the short one, so only glyph-height bands are candidates;
          // between two, the row's own is the band ending nearest its line.
          const band = ocrInkBands(profile, 2, minBandH)
            .reduce((a, b) => (!a || Math.abs(b.y1 - (line - win0)) < Math.abs(a.y1 - (line - win0)) ? b : a), null);
          if (!band) continue;
          // Crop to the strokes of that band. The trim threshold has to be low: one
          // sized to a shadowed cell trims a glare-lit one down to the rule beside
          // it, which is the one thing in that crop that is not a shift.
          const strokes = ocrTightBand(profile, band, Math.max(2, Math.round((x1 - x0) * 0.02)));
          read = await ocrReadCell(worker, bitmap, canvas, {
            x0: x0 + inset, x1: x1 - inset,
            y0: Math.max(0, win0 + strokes.y0 - margin), y1: Math.min(imgH, win0 + strokes.y1 + margin),
          }, {
            accept: text => parseTimeCell(text) || /^\s*(off|hol|n\/?a)\b/i.test(text),
            bg, chars: OCR_CELL_CHARS,
          });
          // A cell's crop can still carry a character from the column beside it (the
          // band number, a rule's edge). If the whole text is not a range but holds
          // exactly one, that is the cell's shift.
          const found = String(read.text || '').match(/\d{1,2}(?::\d{2})?\s*[-–—]\s*\d{1,2}(?::\d{2})?/g) || [];
          parsed = parseTimeCell(read.text) || (found.length === 1 ? parseTimeCell(found[0]) : null);
          if (parsed) break;
        }
        if (parsed) break;
      }
      if (!parsed) continue;
      const col = cols[i];
      cells.push({
        date: col && col.date ? isoLocalUTC(col.date) : null,
        weekday: col && col.date ? col.date.getUTCDay() : (col && col.weekday != null ? col.weekday : null),
        startMin: parsed.startMin, endMin: parsed.endMin,
        raw: read.text, confidence: read.confidence, dupe: false,
      });
    }
    complete = validated && cols.length >= 7;
  } finally {
    if (bitmap) bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
  return { cells, complete };
}

// Find the user's row and read it, without asking them to frame it.
//
// Roster photos are handed round, shot at an angle or taken through glare, and
// "drag a band across your row" is the one step that breaks when they are. The
// strips are read top-down instead — the first always carries the date header
// at the top of the sheet — and stop as soon as the typed name appears, so the
// common scan is two reads: header, then row. Every word comes back in
// image-pixel coordinates for parseRosterWords() to turn into dated cells.
//
// The worker is created here and torn down in the same breath: its heap is the
// one place a decoded image could outlive the scan, so dropping it covers
// success, a throw mid-scan, and a scan that found nothing.
export async function ocrRosterRow(file, canvas, opts = {}, onProgress) {
  const name = String(opts.name || '');
  const today = opts.today || new Date();
  const progress = onProgress || (() => {});
  const ranges = ocrStripRanges();
  const words = [];
  let scanned = 0, found = false;
  let cells = [], cellsComplete = false;
  progress(0.02, 'Reading photo');
  try {
    const worker = await ensureOcrWorker();
    for (const strip of ranges) {
      const from = 0.1 + (scanned / ranges.length) * 0.75;
      progress(from, `Scanning part ${scanned + 1} of ${ranges.length} for your row`);
      // While tesseract works through a strip, let its own 0→1 progress fill
      // that strip's slice of the bar rather than jumping back to the start.
      _progressSink = p => progress(from + (p * 0.75) / ranges.length, '');
      const read = await ocrStripWords(worker, file, canvas, strip);
      words.push(...read);
      scanned++;
      if (name && read.some(w => nameMatches(w.text, name))) { found = true; break; }
    }
    // The row was located, so read it again at cell resolution — the strip pass
    // only had to find the header and the name (see ocrOwnerCells). The column
    // grid comes from the same words, so no second engine session is needed.
    const nameWord = found ? words.find(w => nameMatches(w.text, name)) : null;
    if (nameWord) {
      const cols = parseRosterWords(words, today, { name }).columns;
      if (cols.length >= 2) {
        _progressSink = () => {};
        const read = await ocrOwnerCells(worker, file, canvas, { name, nameWord, cols, progress });
        cells = read.cells;
        cellsComplete = read.complete;
      }
    }
  } finally {
    _progressSink = () => {};
    disposeOcrWorker();
  }
  return { words, found, scanned, cells, cellsComplete };
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

export function screenTesco(ctx) {
  const { $, iconSpan, toast, persist, render, trackAction, swalConfirm, fmt } = ctx;
  const state = () => ctx.getState();
  const t = state().tesco || { shifts: [], payslips: [] };
  const rates = { ...TESCO_RATE_DEFAULTS, ...(state().settings.tescoRates || {}) };
  const now = new Date();
  // Debounced repaint for the payslip fields, at screen scope because the row
  // builder is a sibling of the card builder, not a child. A keystroke updates
  // its own row instantly (refreshTotal) and the week card, footer and month
  // stats follow on a short timer — repainting per character would rebuild the
  // tab under the caret. Focus survives the repaint because the app restores it
  // by aria-label, which is why those labels carry the payslip id.
  let payslipRenderTimer = null;
  function schedulePayslipRender() {
    clearTimeout(payslipRenderTimer);
    payslipRenderTimer = setTimeout(() => { persist(); render(); }, 450);
  }
  function shifts() { return t.shifts || []; }
  function payslips() { return t.payslips || []; }
  // Read live, not from the captured `t`: a week number typed on one card must
  // show on every other card of that week without a stale copy winning.
  function weekNos() { return ctx.getState().settings.tescoWeekNos || {}; }

  const screen = $('section', { class: 'page-section tesco-section', 'aria-label': 'Tesco Pay' });

  // ----- header stats -----
  const month = monthSummary(shifts(), payslips(), rates, now.getFullYear(), now.getMonth());
  const life = lifetimeTotals(shifts(), payslips(), rates);
  screen.appendChild($('div', { class: 'card tesco-stats' },
    $('div', { class: 'tesco-stats-grid' },
      statCell('Hours this month', `${month.hours}h`),
      statCell('Anticipated', fmt(month.anticipated)),
      statCell('Received', fmt(month.received)),
    ),
    $('div', { class: 'muted', style: 'font-size:12px;margin-top:10px;' },
      `Lifetime: ${life.hours}h · ${fmt(life.anticipated)} anticipated · ${fmt(life.received)} received`),
  ));
  function statCell(label, value) {
    return $('div', { class: 'tesco-stat' },
      $('div', { style: 'font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;' }, label),
      $('div', { class: 'tesco-stat-value' }, value),
    );
  }

  // ----- add shift -----
  screen.appendChild(buildAddCard());
  // ----- roster scan -----
  screen.appendChild(buildScanCard());
  // ----- pay weeks -----
  screen.appendChild(buildWeeksCard());
  // ----- payslips -----
  screen.appendChild(buildPayslipsCard());
  // ----- rates -----
  screen.appendChild(buildRatesCard());
  // ----- import / export -----
  screen.appendChild(buildDataCard());
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

  // Normalise a batch and drop anything already stored or repeated inside it —
  // an imported file that lists a day twice must not pay it twice. The caller
  // owns the key set, so one set can span a whole import.
  function freshShifts(list, seen) {
    const out = [];
    for (const s of list) {
      if (!dateOk(s.date) || parseHM(s.start) == null || parseHM(s.end) == null) continue;
      const draft = { id: uid(), date: s.date, start: fmtHM(parseHM(s.start)), end: fmtHM(parseHM(s.end)), note: String(s.note || '').slice(0, 120), special: !!s.special, createdAt: new Date().toISOString() };
      const key = `${draft.date}|${draft.start}|${draft.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(draft);
    }
    return out;
  }
  // A payslip is keyed by its week, so importing an overlapping file can never
  // duplicate a week's tax (or overwrite figures you typed by hand).
  function freshSlips(list, seen) {
    const out = [];
    for (const p of list) {
      const ws = weekStartOf(p.weekStart);
      if (!dateOk(ws) || seen.has(ws)) continue;
      seen.add(ws);
      out.push({
        id: uid(), weekStart: ws, paye: +p.paye || 0, usc: +p.usc || 0, prsi: +p.prsi || 0, futureFund: +p.futureFund || 0,
        bankPay: Number.isFinite(Number(p.bankPay)) && p.bankPay != null ? +p.bankPay : undefined,
        createdAt: new Date().toISOString(),
      });
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
    const undo = () => {
      const cur = ctx.getState();
      cur.tesco.shifts = before.shifts;
      cur.tesco.payslips = before.payslips;
      cur.settings.tescoWeekNos = { ...before.weekNos };
      persist(); render();
    };
    trackAction(undo, label);
    persist(); render();
    toast(message, undo, 'Undo');
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

  // A whole file at once: shifts, the tax table beside them, and the week
  // numbers the file carries.
  function importTesco(list, slips, numbers) {
    const before = snapshot();
    const fresh = freshShifts(list, new Set(before.shifts.map(s => `${s.date}|${s.start}|${s.end}`)));
    const freshTax = freshSlips(slips, new Set(before.payslips.map(p => weekStartOf(p.weekStart))));
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

  function updateShift(id, patch) {
    const before = [...shifts()];
    ctx.getState().tesco.shifts = before.map(s => s.id === id ? { ...s, ...patch } : s);
    persist(); render();
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
    const nameIn = $('input', {
      type: 'text', value: state().settings.tescoName || '', placeholder: 'e.g. Parth',
      'aria-label': 'Your name on the roster', class: 'tesco-in', maxLength: 40, autocomplete: 'off',
    });
    const weekIn = $('input', { type: 'date', value: weekStartOf(todayIso()), 'aria-label': 'First column date', class: 'tesco-in' });
    const readBtn = $('button', { type: 'button', class: 'btn btn-primary', style: 'display:none;', onClick: () => run() }, 'Read my shifts');
    const status = $('div', { class: 'muted', style: 'font-size:12px;' }, 'Photo of the weekly roster — processed in memory, never stored.');
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

    // Every scan ends here: the pixels are already zeroed by ocrStripWords, this
    // removes the (now empty) preview chrome and says so plainly, so "the photo
    // is gone" is something the user can see rather than take on trust.
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
            const cb = $('input', { type: 'checkbox', checked: checks[i], 'aria-label': `Include ${dateVal || 'shift'}`, onChange: e => { checks[i] = e.target.checked; refresh(); } });
            if (cell.dupe) cb.title = 'Possibly a duplicate read — check before adding';
            const dIn = $('input', { type: 'date', value: dateVal || todayIso(), 'aria-label': 'Date', class: 'tesco-in', onInput: e => { cell.date = e.target.value; } });
            const sIn = $('input', { type: 'time', value: startVal, 'aria-label': 'Start', class: 'tesco-in', onInput: e => { cell.startMin = parseHM(e.target.value) ?? cell.startMin; } });
            const eIn = $('input', { type: 'time', value: endVal, 'aria-label': 'End', class: 'tesco-in', onInput: e => { cell.endMin = parseHM(e.target.value) ?? cell.endMin; } });
            const hours = $('span', { class: 'muted', style: 'font-size:11px;min-width:44px;text-align:right;' }, `${paidHours(cell.startMin, cell.endMin)}h`);
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
        $('label', { class: 'btn btn-ghost tesco-filelabel' }, file ? 'Choose another' : 'Choose roster photo', input),
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
      onInput: e => e.target.blur(),   // commit on Enter/blur, not per keystroke
    });
    const head = $('div', { class: 'tesco-week-head' },
      $('div', {},
        $('div', { style: 'font-weight:600;font-size:13px;' }, `Week of ${prettyDate(w.weekStart)}`),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:2px;display:flex;align-items:center;gap:4px;' },
          `Payslip ${prettyDate(payDateOf(w.weekStart))} · wk`, weekNo),
      ),
      $('div', { style: 'text-align:right;' },
        $('div', { class: 'tesco-week-gross' }, w.gross > 0 ? fmt(w.gross) : '—'),
        $('div', { class: 'muted', style: 'font-size:11px;' }, `${w.hours}h`),
      ),
    );
    box.appendChild(head);

    if (w.shifts.length) {
      const list = $('div', { class: 'tesco-shiftlist' });
      for (const s of w.shifts) list.appendChild(shiftRow(s));
      box.appendChild(list);
    }
    if (sim) {
      box.appendChild($('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;' },
        `Est. PAYE ${fmt(sim.paye)} · USC ${fmt(sim.usc)} · PRSI ${fmt(sim.prsi)} · FF ${fmt(sim.pension)} → net ${fmt(sim.net)}`));
    }
    if (actual != null) {
      // Compare like with like: a payslip total is PAYE+USC+PRSI+Future Fund,
      // so the estimate must include the pension (Future Fund) too.
      const delta = sim ? r2(actual - (sim.tax + sim.pension)) : null;
      const chip = delta != null
        ? $('span', { class: `tesco-chip ${Math.abs(delta) < 1 ? 'tesco-chip-good' : 'tesco-chip-warn'}` },
            `${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta)).slice(1)} vs est`)
        : null;
      box.appendChild($('div', { class: 'tesco-actual' },
        $('span', { style: 'font-weight:600;font-size:12px;' }, `Payslip total ${fmt(actual)}`),
        w.bankPaid != null ? $('span', { class: 'tesco-derived' }, `Received ${fmt(w.bankPaid)}`) : null,
        chip,
      ));
    }
    return box;
  }

  function shiftRow(s) {
    const p = shiftPay(s, rates);
    const row = $('div', { class: 'tesco-shiftrow' },
      $('span', { class: 'tesco-shift-day' }, weekdayShort(s.date)),
      $('span', { class: 'tesco-shift-time' }, `${s.start}–${s.end}${isOvernight(parseHM(s.start), parseHM(s.end)) ? '+1' : ''}`),
      // Badge the *computed* rate type: a Sunday shift is special even when the
      // stored flag was never set by hand.
      p && p.special ? $('span', { class: 'tesco-chip' }, 'special') : null,
      $('span', { class: 'muted', style: 'font-size:11px;' }, `${p ? p.hours : '?'}h`),
      $('span', { class: 'tesco-shift-amt' }, p ? fmt(p.gross) : '—'),
      $('button', { type: 'button', class: 'icon-btn tesco-del', title: 'Delete shift', 'aria-label': 'Delete shift', onClick: async () => {
        if (await swalConfirm({ title: 'Delete shift?', text: `${prettyDate(s.date)} ${s.start}–${s.end}`, danger: true, confirmButtonText: 'Delete' })) deleteShift(s.id);
      } }, '×'),
    );
    return row;
  }

  // ================= payslips (the "Total tax paid" table) =================
  function buildPayslipsCard() {
    const card = $('div', { class: 'card' });
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

    // Per-component totals — the spreadsheet's SUBTOTAL footer.
    const comp = { paye: 0, usc: 0, prsi: 0, futureFund: 0 };
    for (const p of payslips()) for (const k of Object.keys(comp)) comp[k] += (+p[k] || 0);
    card.appendChild(list);
    card.appendChild(addBtn);
    card.appendChild($('div', { class: 'tesco-totals' },
      $('span', null, 'Total tax paid'),
      $('span', null, `PAYE ${fmt(comp.paye)}`),
      $('span', null, `USC ${fmt(comp.usc)}`),
      $('span', null, `PRSI ${fmt(comp.prsi)}`),
      $('span', null, `FF ${fmt(comp.futureFund)}`),
      $('span', { class: 'tesco-totals-sum' }, fmt(r2(comp.paye + comp.usc + comp.prsi + comp.futureFund))),
    ));
    return card;
  }

  function payslipRow(p) {
    const total = $('span', { class: 'tesco-payslip-total' }, fmt(payslipTotal(p)));
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
      $('input', { type: 'date', value: p.weekStart, 'aria-label': `Week start ${p.id}`, class: 'tesco-in tesco-in-date', onInput: e => { if (dateOk(e.target.value)) { updatePayslip(p.id, { weekStart: e.target.value }); schedulePayslipRender(); } } }),
      $('div', { class: 'tesco-payslip-grid' },
        numField('PAYE', numIn('paye')), numField('USC', numIn('usc')), numField('PRSI', numIn('prsi')), numField('FF', numIn('futureFund')),
        // The net that landed in the bank, when the payslip states it. Optional
        // on purpose: a blank falls back to gross − tax.
        numField('Bank', numIn('bankPay', true)),
      ),
      $('div', { class: 'tesco-payslip-foot' },
        $('span', { class: 'muted', style: 'font-size:11px;' }, `Pay ${prettyDate(payDateOf(weekStartOf(p.weekStart)))}`),
        total,
        $('button', { type: 'button', class: 'icon-btn tesco-del', title: 'Delete payslip', 'aria-label': 'Delete payslip', onClick: async () => {
          if (await swalConfirm({ title: 'Delete payslip?', text: `Week of ${prettyDate(p.weekStart)}`, danger: true, confirmButtonText: 'Delete' })) deletePayslip(p.id);
        } }, '×'),
      ),
    );
  }
  function numField(label, input) {
    return $('label', { class: 'tesco-numfield' }, $('span', null, label), input);
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
    // Sunday is normal × multiplier, so show the figure it works out to right
    // under the factor: editing either field moves it, which is the point of
    // storing a multiple rather than its own rate.
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
      const wrap = numField(label, input);
      if (hint) wrap.appendChild(hint);
      return wrap;
    };
    grid.appendChild(field('Normal €/h', 'normal'));
    grid.appendChild(field('Sunday ×', 'specialMultiplier', undefined, sundayRate));
    grid.appendChild(field('Pension %', 'pensionPct'));
    grid.appendChild(field('PAYE credit €', 'payeCredit'));
    grid.appendChild(field('PAYE cutoff €', 'payeCutoff'));
    grid.appendChild(field('PRSI %', 'prsiRate'));
    details.appendChild($('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;' },
      `Pay week runs Sunday → Saturday; the payslip lands ${PAY_LAG_DAYS} days after the week starts (Thursday). USC bands are statutory and fixed.`));
    details.appendChild(grid);
    return details;
  }

  // ================= import / export =================
  // The workbook's own table out, and the same table back in. Import reads the
  // inputs off the file and lets the engine recompute the rest, so a sheet whose
  // older rows were built with a superseded formula can't smuggle its wrong
  // hours or tax back into the app.
  function buildDataCard() {
    // No FileReader: file.text() is the whole read, and the input is cleared the
    // moment it hands over — nothing keeps a reference to the file.
    const fileIn = $('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Import a Tesco Pay CSV', style: 'display:none' });
    fileIn.addEventListener('change', async () => {
      const file = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!file) return;
      const parsed = parseTescoCsv(await file.text());
      if (parsed.error) { toast(parsed.error); return; }
      if (!parsed.shifts.length && !parsed.payslips.length) { toast('No shifts or tax figures found in that file.'); return; }
      const counts = [];
      if (parsed.shifts.length) counts.push(`${parsed.shifts.length} shift${parsed.shifts.length > 1 ? 's' : ''}`);
      if (parsed.payslips.length) counts.push(`${parsed.payslips.length} payslip week${parsed.payslips.length > 1 ? 's' : ''}`);
      const ok = await swalConfirm({
        title: 'Import from CSV?',
        text: `${counts.join(' and ')} read from “${file.name}”`
          + (parsed.skipped ? `, ${parsed.skipped} row${parsed.skipped > 1 ? 's' : ''} skipped` : '')
          + '. Dates, times, the special flag, notes and payslip tax come in; hours, pay and the tax estimate are recalculated.',
        confirmButtonText: 'Import',
      });
      if (ok) importTesco(parsed.shifts, parsed.payslips, parsed.weekNos);
    });
    const exportBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => {
      if (!shifts().length) { toast('No shifts to export yet.'); return; }
      downloadText(`tesco-pay-${todayIso()}.csv`, tescoCsv(shifts(), payslips(), rates, weekNos()), 'text/csv');
      toast(`Exported ${shifts().length} shift${shifts().length > 1 ? 's' : ''} — the workbook's columns.`);
    } }, 'Export CSV');
    const importBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileIn.click() }, 'Import CSV');
    return $('div', { class: 'card' },
      $('div', { class: 'tesco-card-title' }, 'Import / export', iconSpan('data', 'md')),
      $('div', { class: 'tesco-form-row' }, exportBtn, importBtn, fileIn),
      $('div', { class: 'muted', style: 'font-size:12px;margin-top:8px;' },
        'CSV in the sheet’s own columns: one row per shift, newest first, each week’s figures on its first row.'),
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
