/* ============================================================
   tesco-pay.js — the Tesco Pay engine: rates, shift hours, the
   Sunday premium, the Irish tax simulation, and the week/month
   roll-ups those feed.

   This module exists so the app shell can have its figures without
   the rest of Tesco Pay. The dashboard shows a month's hours, an
   anticipated net and what the bank has received, and those come
   from here — but the screen, the roster-photo reader, the pixel
   pipeline and the workbook importer (tesco.js) are ~240 KB that a
   session may never need. app.js therefore imports THIS file on
   boot and fetches tesco.js on the first visit to #tesco, which
   scripts/test-boot-payload.mjs pins.

   Nothing here touches the DOM, storage, a worker or a canvas, so
   it can be imported by the shell (and by Node) without any of the
   app's other machinery: the whole file is arithmetic and dates.

   tesco.js re-exports every name below, because the harnesses and
   the screen have always imported them from there.
   ============================================================ */

// One date rule for the whole app, owned by csv.js (see isRealDate): the "is
// this a day that exists" question is the same one its CSV reader asks of a
// cell, and a second copy here is a copy that could roll 2026-02-31 over to
// March while the other refused it. csv.js imports nothing, so the boot path
// this file is on does not grow a dependency chain for it.
import { isRealDate } from './csv.js';

// ---------- constants ----------
export const TESCO_RATE_DEFAULTS = Object.freeze({
  normal: 14.44,          // €/h Monday–Saturday
  specialMultiplier: 1.5, // Sunday & bank holidays
  pensionPct: 1.5,        // Future Fund employee share, % of gross
  payeCredit: 76.93,      // €/week tax credit
  payeCutoff: 846.15,     // €/week 20% band ceiling
  payeRateLow: 20,        // %
  payeRateHigh: 40,       // %
  // The workbook's own rate, so its rows come back out of an export unchanged. The
  // statute moved on 1 Oct 2026 (4.2% → 4.35%): the rates card names both rates and
  // this field is where the new one is typed, rather than a default that would
  // silently rewrite the tax on every week the sheet was built from.
  prsiRate: 4.2,          // % class A1 — 4.35% from 1 Oct 2026
});
export const PAY_LAG_DAYS = 11;   // the sheet's pay-date formula: week start + 11 (Thursday)
// 0=Sun..6=Sat. The workbook anchors each pay week on its **Sunday**: the
// weekly SUM block (L = SUM(J…:J…)) sits on the Sunday row and sums Sunday →
// Saturday, and every hand-entered "Week Start Date" in the tax table is a
// Sunday. Anchoring on Saturday instead shifted whole weeks by a day, which
// moved a week's gross — and therefore its tax, pension and net — into the
// neighbouring week.
export const WEEK_START_DOW = 0;

// ---------- small helpers ----------
// Currency rounding, half away from zero — matches Excel's ROUND(). The
// epsilon matters: 0.2*550.525-76.93 is 33.174999... in binary, which plain
// Math.round would take down to 33.17 where the spreadsheet says 33.18.
export function r2(v) {
  const n = Number(v) || 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7) / 100;
}
export function pad2(n) { return String(n).padStart(2, '0'); }
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

export function isoToUtcMidnight(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
// A REAL calendar day, asked of csv.js's one date rule rather than answered
// here a second way. The old shape check (`^\d{4}-\d{2}-\d{2}$` plus "does it
// parse") passed 2026-02-31 happily — Date.UTC rolls an out-of-range day over
// to March 3 and hands back a finite timestamp — so a workbook cell typed
// `31/02/2026` arrived as a shift dated the 31st of February: shown on the
// card as a day that does not exist and grouped by weekStartOf into the week of
// the 3rd of March. Every caller of this one (the shift importer, the week-off
// form, the quick parser, the payslip grouping) inherits the fix.
export function dateOk(s) { return isRealDate(s); }

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

/** Is this a number a row could state as its own hours? Empty, a non-number,
 *  a negative or an absurd figure all mean "not stated". */
export function statedHours(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 168 ? r2(n) : null;
}

export function shiftPay(shift, rates) {
  const R = { ...TESCO_RATE_DEFAULTS, ...rates };
  const start = parseHM(shift.start), end = parseHM(shift.end);
  // Was this row a shift at all? A booked absence — a week off, which the sheet
  // and the Week off card both write as hours and no clock times — is not, and
  // that is what the premium below turns on.
  const worked = start != null && end != null;
  // A row's own hours win over its clock times. The sheet states them, and its
  // ladder is not the only rule in play: two rows book a full week off with no
  // times at all (20 h), and its older blocks break a shift differently. So an
  // imported row keeps the hours it was paid for; only a shift typed in the app
  // has none stated and derives them.
  const own = statedHours(shift.hours);
  const hours = own != null ? own : (worked ? paidHours(start, end) : null);
  if (hours == null) return null;
  // The Sunday multiplier is a premium for WORKING Sunday, so it follows a row
  // with clock times; a row that states its hours and no times is a booked week
  // off paying those hours at the card rate, unless the row itself says special
  // (which is what a week the sheet paid at premium carries). Dating a week off
  // on the week's Sunday used to pay it at ×1.5 silently — the Week off card dates
  // its row there so the week is unambiguous, and a 7h week off came out as
  // €151.62 instead of €101.08.
  const special = !!shift.special || (worked && isSunday(shift.date));
  // Likewise a row's own pay, where the file states one: the sheet's older rows
  // were worked at rates that have since changed (€14.02/€21.03 against today's
  // €14.44/€21.66), and one bank holiday is a straight 2×. Recomputing those at
  // today's rate would silently rewrite what was actually paid.
  const card = r2(special ? R.normal * R.specialMultiplier : R.normal);
  const paid = shift.gross == null || !Number.isFinite(Number(shift.gross)) ? null : r2(shift.gross);
  const gross = paid == null ? r2(hours * card) : paid;
  return { hours, special, rate: hours > 0 ? r2(gross / hours) : card, gross };
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
  // PRSI, class A employee. Two rules, and the first one is not "4.35% with a
  // credit": an employee on €352 a week or less is EXEMPT from PRSI altogether.
  // Charging the full rate below that threshold was a real over-estimate — a
  // €300 week (about 20 hours) owes €0 PRSI, not the €12.60 this used to take, and
  // its whole tax bill is the USC (€2.54), which is what a payslip for such a week
  // shows. Above the threshold the €12 weekly credit tapers away by one-sixth of
  // the earnings over €352.01, reaching nothing at €424; in any week the employee
  // is liable, every euro of the week is.
  const prsiGross = g * R.prsiRate / 100;
  const EXEMPT_UP_TO = 352, CREDIT_FROM = 352.01, CREDIT_TO = 424, MAX_CREDIT = 12;
  const prsi = g <= EXEMPT_UP_TO ? 0
    : Math.max(0, r2(prsiGross - (g <= CREDIT_TO ? MAX_CREDIT - (g - CREDIT_FROM) / 6 : 0)));
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

// The week number a payslip row prints. A number the payslip carries itself —
// typed on the sheet's tax table, or imported from its Week column — wins,
// because that is the number printed on the payslip the row is transcribing.
// Otherwise it is the week's own number, derived exactly as the week card above
// derives it, so the two cards never disagree. Null when the row has no usable
// date at all, which the caller renders as "no number" rather than a guess.
export function payslipWeekNumberOf(p, weekNos) {
  const own = Math.trunc(Number(p && p.weekNo));
  if (Number.isFinite(own) && own >= 1 && own <= 53) return own;
  const start = p && dateOk(p.weekStart) ? weekStartOf(p.weekStart) : null;
  return start ? weekNumberOf(start, weekNos) : null;
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
    // The sheet's Final Bank Pay, typed from a bank statement: the net that
    // actually landed, which no formula here can derive (holiday pay, a refund
    // or a correction are all reasons it differs from gross − tax). The sheet
    // keeps it on the week's shift row; the tab edits it on the payslip, which
    // therefore wins where one records a net — otherwise a week carrying the net
    // on its shift row alone (no payslip of its own) would drop the figure.
    const finite = list => list.filter(x => x.bankPay != null && Number.isFinite(Number(x.bankPay)));
    const netted = finite(w.payslips).length ? finite(w.payslips) : finite(w.shifts);
    w.bankPaid = netted.length ? r2(netted.reduce((sum, p) => sum + Number(p.bankPay), 0)) : null;
    // One pass at the user's rates, so a week's totals always agree with the
    // per-shift rows the tab prints under them and with monthSummary above.
    const pays = w.shifts.map(s => shiftPay(s, rates)).filter(Boolean);
    w.gross = r2(pays.reduce((sum, p) => sum + p.gross, 0));
    w.hours = r2(pays.reduce((sum, p) => sum + p.hours, 0));
  }
  return [...weeks.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

// What one pay week's money did, in order of authority:
//   * Final Bank Pay, typed off a statement: the money the user watched land, so
//     it wins — and, unlike an estimate below, it counts whatever the calendar
//     says (holiday pay, a refund or a correction is exactly why it differs from
//     gross − tax, and the shift rows cannot express any of them);
//   * otherwise the sheet's Calculated Income (O = Gross Income − Potential Tax
//     − Pension): the week's gross minus the tax + Future Fund its payslips
//     recorded. A refund week's negative tax lands as money in, which is the
//     sheet's own arithmetic;
//   * otherwise the week's simulated net — the very "→ net €X" figure the week
//     card prints under its estimate, so what the month claims and what the week
//     shows are one piece of arithmetic.
// A week with a payslip but no shift rows is the one case nothing can be derived
// from: its tax alone says nothing about the gross it was taken out of, so only a
// refund (negative tax) is money that landed — a positive total there is not money
// arriving, and it claims nothing.
function weekReceived(w, rates) {
  if (w.bankPaid != null) return w.bankPaid;
  if (!w.shifts.length) return w.paid < 0 ? r2(-w.paid) : 0;
  if (w.payslips.length) return r2(w.gross - w.paid);
  return w.gross > 0 ? simulateTax(w.gross, rates).net : 0;
}

// Money that reached the bank over the weeks handed in. A week is counted only
// once its pay date has come round, because a week of the current month is
// normally paid in the NEXT one (pay date = the week's Sunday + 11) and an
// estimate for a week the bank has not paid yet would claim money that has not
// arrived. A typed bank figure is counted regardless — the user saw that money.
// Weeks with no record at all are estimated rather than counted as €0, which is
// what made a month's Received add up to one bank line while three worked weeks
// sat in it (see monthSummary).
function receivedTotal(weeks, rates, today) {
  return r2(weeks.reduce((sum, w) => {
    if (w.bankPaid == null && payDateOf(w.weekStart) > today) return sum;
    return sum + weekReceived(w, rates);
  }, 0));
}
/**
 * What each pay date brought, keyed by the date the money landed (`payDateOf` —
 * the week's Sunday + 11, the Thursday the sheet pays on). This is the join
 * between the Tesco Pay tab and the ledger's Tesco pay tracker: the tracker's
 * entry for a Thursday is the same figure as the tab's own Received for the week
 * that was paid on it, rather than a second opinion about one payment.
 *
 * Only a week with something RECORDED is offered, and the source travels with
 * the amount so a caller can say which: `bank` is a typed Final Bank Pay — money
 * the user watched land — and `recorded` is the week's own arithmetic, gross
 * minus the tax its payslips withheld (the sheet's Calculated Income). A week
 * with nothing recorded yet is left out on purpose: its simulated net is an
 * estimate, and an estimate written into the ledger as income is a wrong figure
 * the user never sees arrive (the month card may count it as received — the
 * ledger must not, which is why the two diverge here and only here).
 *
 * A week that brought nothing in is left out too — a zero-amount ledger entry is
 * not a payment.
 *
 * And a week whose pay date has not come round is not received either - the rule
 * receivedTotal has always applied (a week of the current month is paid in the
 * NEXT one, so its estimate would claim money that has not arrived). Without it
 * here the ledger wrote a line DATED IN THE FUTURE on any recording made in the
 * first days of a month. A typed bank figure is kept whatever the date, exactly
 * as receivedTotal keeps it: the user watched that money land. So `today` is the
 * claim that time has passed, and a missing or malformed one leaves only bank
 * figures - which are true whenever they are read - rather than assuming every
 * week has been paid.
 */
export function receivedByPayDate(shifts, payslips, rates, today) {
  const cutoff = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : '';
  const out = {};
  for (const w of buildPayWeeks(shifts, payslips, rates)) {
    const source = w.bankPaid != null ? 'bank' : w.payslips.length ? 'recorded' : null;
    if (!source) continue;
    const payDate = payDateOf(w.weekStart);
    if (source !== 'bank' && payDate > cutoff) continue;
    const amount = weekReceived(w, rates);
    if (!(amount > 0)) continue;
    out[payDate] = { amount, source };
  }
  return out;
}

/**
 * Where a recorded Tesco pay lands in the ledger: the account the payslip pays
 * INTO, which is the bank — never the Tesco gift card.
 *
 * The method id decides more than a label. `balanceDelta` treats a credit on a
 * TG/LG/AG method as a card LOAD, so a week's wages written on TG did three
 * wrong things at once: the money was added to the Tesco card's balance instead
 * of the account's, it was counted as `loaded` on that card ("recorded loads"
 * read as if the user had topped the card up), and the account the money
 * actually arrived in was short by the whole week.
 *
 * One constant, read by every writer — the per-row Fill, Auto-fill, the amount
 * modal and the automatic recording — because four copies of a method id is
 * four chances for one of them to disagree about where someone's wages go.
 * `'AIB'` is a built-in in seed.js's METHODS, so it is always a valid method id
 * whatever the user has removed from their pickers (a hidden method still
 * resolves, and a dropped entry is irreversible — see updateAllowedMethods).
 */
export const TESCO_PAY_METHOD = 'AIB';

/**
 * The window in which the automatic recorder may CREATE a line: the current
 * month, up to and including today.
 *
 * The first version of the recorder had no window, so one recording wrote every
 * pay date the Tesco tables had ever held. Measured on six months of payslips
 * that is 25 lines and 9,377.75 in a SINGLE run, and it is how a balance the user
 * had been managing by hand went from 4,000 to 15,000 without anyone asking for
 * it - the drama was never a wrong sum, it was an unbounded catch-up.
 *
 * The window is not an arbitrary slice of history: it is exactly the set of
 * Thursdays the tracker card offers to fill (`thursdaysInMonth`, filtered to
 * `d <= today`), so what this writer may create and what the card lists are one
 * and the same set. A line can never appear for a date the card does not show,
 * and the card's own Fill covers everything inside the window that Tesco Pay has
 * a figure for - which is why the two halves can be changed together.
 *
 * Null when `today` is not a usable date, and tescoPayLedgerWrites creates
 * NOTHING without a window: the unbounded case is the one that moves money.
 */
export function tescoPayWriteWindow(today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/**
 * The ledger lines a Tesco recording owes — the automatic half of the tracker
 * above. `recorded` is receivedByPayDate's map, `entries` the ledger's own, and
 * `written` this app's record of what it has already written
 * (`settings.tescoPayLedger`: pay date → `{ id, amount }`, the line and the
 * figure it was written at).
 *
 * Three rules, and each one closes a way the ledger could disagree with the tab:
 *   * a pay date with a recorded figure and NOTHING on it in the ledger is a
 *     create — unless an income entry already sits on that date, which is the
 *     user's own line (a Fill, or a payslip typed into the Add screen) and wins;
 *   * a pay date this app wrote before is followed only while the line is still
 *     the one it wrote: the entry is there, at the amount written. A line the
 *     user has since edited by hand is theirs to keep, so a correction to the
 *     week does not overwrite their figure;
 *   * a pay date in `written` whose entry is gone is a line the user DELETED.
 *     It is never created again — which is the whole reason the record is worth
 *     keeping, since without it the next recording of that week would undo the
 *     deletion and the money would keep coming back.
 *
 * A fourth case is the third rule reaching past the recorder's own lines: a
 * mark tagged `by: 'fill'` is a line the USER filled (app.js's
 * `withTescoFillMark`), and such a date is theirs end to end — not created over
 * while their line exists, not created after they delete it, and not moved when
 * the week's figure changes. Without that tag rule 1 only ever saw the
 * recorder's marks, so a hand-filled Thursday deleted in History looked simply
 * unfilled and the next Tesco commit inside the write window wrote the money
 * straight back.
 *
 * Nothing here ever removes a ledger entry: the ledger is the user's, and a
 * recording that disappears (a week's payslips deleted, a bank figure cleared)
 * leaves the money it already paid where it is.
 *
 * The "is this date already paid?" test mirrors app.js's isIncomeEntry for the
 * yes/no it needs — a credit that is not half of a transfer. A same-date entry
 * of the user's own is the only thing it stops a line for, so reading it too
 * widely can only ever hold a line back, never double one up.
 */
export function tescoPayLedgerWrites(recorded, entries, written, writeWindow) {
  const create = [];
  const update = [];
  const marks = written && typeof written === 'object' && !Array.isArray(written) ? written : {};
  // A create needs a window and has to fall inside it. Malformed windows are
  // dropped rather than widened: with no window at all nothing may be created,
  // because "no bound" is the failure mode that wrote a year of history at once.
  const win = writeWindow && typeof writeWindow === 'object'
    && typeof writeWindow.from === 'string' && typeof writeWindow.to === 'string'
    && writeWindow.from <= writeWindow.to ? writeWindow : null;
  const inWindow = (date) => !!win && date >= win.from && date <= win.to;
  const rows = Array.isArray(entries) ? entries : [];
  const paidDates = new Set(rows.filter(e => e && e.type === 'credit' && !e.transferId).map(e => e.date));
  const byId = new Map(rows.filter(e => e && typeof e.id === 'string').map(e => [e.id, e]));
  for (const date of Object.keys(recorded || {}).sort()) {
    const amount = r2(Number(recorded[date] && recorded[date].amount));
    if (!(amount > 0)) continue;
    const mark = marks[date];
    // A date the USER filled is theirs end to end: never created over, even
    // once their line is gone (which is the whole point of the tag), and never
    // followed when the week's figure moves — a figure they typed is their
    // reading of what landed, not this app's.
    if (mark && mark.by === 'fill') continue;
    if (!mark) {
      if (!inWindow(date) || paidDates.has(date)) continue;
      create.push({ date, amount, source: recorded[date].source });
      continue;
    }
    const line = byId.get(mark.id);
    if (!line) continue;                                     // deleted: it stays deleted
    if (Number(line.amount) !== Number(mark.amount)) continue; // edited by hand: their figure
    if (amount === Number(mark.amount)) continue;             // the recording has not moved
    update.push({ date, id: mark.id, amount, source: recorded[date].source });
  }
  return { create, update };
}

// The week card's "vs est" chip: how far the week's recorded money sits from the
// estimate printed above it, and which of the estimate's figures it was measured
// against — a comparison of two different bases is a number that belongs to
// neither line, which is how a week recording a €469.78 bank figure against an
// estimated €69.11 of withholding printed "+0.81 vs est" beside a net estimate of
// €470.59. The precedence is the recorded line's own, top down:
//   * a net that reached the bank is measured against the estimate's NET, the two
//     figures a week can be checked side by side against a statement ("Received
//     €469.78" against "→ net €470.59") — and it is the only base that means
//     anything on a week whose bank figure arrived with no payslip of its own;
//   * a week with a payslip and no bank figure has only its withholding to go on,
//     and a payslip total is PAYE+USC+PRSI+Future Fund, so what it is measured
//     against is the estimate's tax PLUS its pension (never the net, a different
//     figure entirely).
// The sign says which way: negative is money short of the estimate, so a caller
// can print `−0.81 vs est net` without deciding anything for itself. Null when the
// week recorded nothing to compare or has no gross to estimate from.
export function weekVsEstimate(w, rates) {
  if (!w || !(w.gross > 0)) return null;
  const sim = simulateTax(w.gross, rates);
  if (w.bankPaid != null) return { against: 'net', delta: r2(w.bankPaid - sim.net) };
  const paid = w.payslips && w.payslips.length ? w.paid : null;
  return paid == null ? null : { against: 'tax', delta: r2(paid - (sim.tax + sim.pension)) };
}

// ---------- a week's final bank pay: one figure, one home ----------
/**
 * Where a week's final bank pay is written.
 *
 * The sheet types it off a bank statement, so it is the one figure here that no
 * formula can derive — holiday pay, a refund or a correction all make it
 * disagree with gross − tax. It is also a WEEK's figure, not a row's, and the tab
 * has two homes for it: the sheet keeps it on the week's shift row (tescoCsv
 * calls that row the week's carrier — its first row by date, the Sunday when one
 * was worked), while the Payslips card has a Bank field of its own.
 *
 * buildPayWeeks sums every figure it finds on a week's records (a payslip's when
 * any payslip has one, otherwise the shift rows'), so writing one figure into two
 * homes would pay it twice. This puts it on the week's carrier row AND on the
 * week's own payslip — the row the tab edits, the last of that week — and clears
 * it from every other record of that week, so the week's received figure is
 * exactly what was typed and the two homes can never disagree.
 *
 * A blank or unreadable amount clears the week: "not known" is a real state here
 * (the received line hides), and quietly zeroing it would claim the bank paid
 * nothing. A negative is kept — a clawback is a real statement line.
 *
 * Returns new arrays; the caller commits them. `carrierId` is the row the cell
 * was typed on, so the week comes from the row rather than from a date two rows
 * can share.
 */
export function weekBankWrite(shifts, payslips, carrierId, amount) {
  const list = Array.isArray(shifts) ? shifts : [];
  const slips = Array.isArray(payslips) ? payslips : [];
  const carrier = list.find(s => s.id === carrierId);
  if (!carrier) return { shifts: list, payslips: slips };
  const ws = weekStartOf(carrier.date);
  const raw = amount == null ? '' : String(amount).trim();
  const n = raw === '' || !Number.isFinite(Number(raw)) ? null : r2(Number(raw));
  // Copy-on-write, and an unchanged figure hands back the same record: the cell
  // commits on change, and clicking in and straight back out must not look like
  // an edit (nor leave an undo step behind).
  const setOn = (row, mine) => {
    const v = mine ? n : null;
    if (v == null) {
      if (row.bankPay == null) return row;
      const { bankPay, ...rest } = row;
      return rest;
    }
    return row.bankPay != null && r2(row.bankPay) === v ? row : { ...row, bankPay: v };
  };
  const own = slips.filter(p => weekStartOf(p.weekStart) === ws).pop() || null;
  return {
    shifts: list.map(s => (weekStartOf(s.date) === ws ? setOn(s, s.id === carrierId) : s)),
    payslips: slips.map(p => (weekStartOf(p.weekStart) === ws ? setOn(p, !!own && p.id === own.id) : p)),
  };
}

// Month summary — the sheet's monthly stats block. The three figures sit on two
// bases on purpose, and the labels say which:
//   * hours are the month's own shifts, by shift date — the hours worked in this
//     month, which is what "hours this month" means;
//   * the anticipated figure is a NET, and a net is a weekly thing (the PAYE
//     credit, the USC bands and the PRSI threshold are all per week), so it is
//     simulated once per pay week on the week's whole gross and the week is
//     placed in the month its Sunday falls in — the sheet's own month rule. It is
//     never prorated across a boundary: half a week's tax is a fiction, and a
//     straddling week would otherwise be counted in two months;
//   * received is money that landed, so it follows the PAY DATE, not the week: the
//     week of 27 Sep is paid on 8 Oct and belongs to October, while the week of
//     30 Aug was paid in September and belongs to September. Counting it by week
//     start used to move both edges of the month the wrong way.
// `today` only decides which weeks have been paid yet (see receivedTotal); it is a
// parameter so the harness can pin a month without a wall clock.
export function monthSummary(shifts, payslips, rates, year, monthIdx, today = todayIso()) {
  const inMonth = iso => { const d = isoToUtcMidnight(iso); return d.getUTCFullYear() === year && d.getUTCMonth() === monthIdx; };
  const weeks = buildPayWeeks(shifts, payslips, rates);
  let hours = 0;
  for (const s of shifts) {
    if (!inMonth(s.date)) continue;
    const p = shiftPay(s, rates);
    if (p) hours += p.hours;
  }
  let anticipated = 0;
  for (const w of weeks) {
    if (!inMonth(w.weekStart) || w.gross <= 0) continue;
    anticipated += simulateTax(w.gross, rates).net;
  }
  const received = receivedTotal(weeks.filter(w => inMonth(payDateOf(w.weekStart))), rates, today);
  return { hours: r2(hours), anticipated: r2(anticipated), received };
}
// The same figures over every week the tab holds. Expected and received are both
// nets, so the two compare directly here too — one is what the hours should pay,
// the other what the bank has actually paid.
export function lifetimeTotals(shifts, payslips, rates, today = todayIso()) {
  const weeks = buildPayWeeks(shifts, payslips, rates);
  let hours = 0, anticipated = 0;
  for (const w of weeks) {
    hours += w.hours;
    if (w.gross > 0) anticipated += simulateTax(w.gross, rates).net;
  }
  return { hours: r2(hours), anticipated: r2(anticipated), received: receivedTotal(weeks, rates, today) };
}
export function payslipTotal(p) { return r2((+p.paye || 0) + (+p.usc || 0) + (+p.prsi || 0) + (+p.futureFund || 0)); }

// ---------- holiday hours ----------
/**
 * Holiday accrues at 8% of the hours worked — the statutory rate for a rota
 * whose hours vary (four working weeks a year, banked as you earn them).
 *
 * The clock and the amount are different things, and the difference is the
 * whole rule: a pay week runs Sunday → Saturday, its pay date is that week's
 * Sunday + 11 days (`payDateOf`), and the credit lands ON that Thursday. So
 * "every Thursday, 8% of the previous week's hours" is one pay week at a time —
 * the Thursday the week is paid is the Thursday its holiday is posted, which is
 * why this needs no second schedule of its own.
 */
export const HOLIDAY_ACCRUAL_PCT = 8;

/** The shape a document with no holiday balance has: nothing to accrue from
 *  yet. `anchorDate` empty is what "not set up" reads as (see holidayBalance). */
export const HOLIDAY_DEFAULT = Object.freeze({ anchorDate: '', anchorHours: 0, taken: 0 });

function isoAddDays(iso, days) {
  const d = isoToUtcMidnight(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Pay dates are Thursdays (week start + 11), so the next credit is the next
// Thursday — read off the calendar rather than off the weeks on file, because
// the week that is about to be paid may have no shifts entered yet and the
// card still has to say when the next posting is.
function nextThursdayAfter(iso) {
  const d = isoToUtcMidnight(iso);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 4);
  return d.toISOString().slice(0, 10);
}

/**
 * The holiday balance: what has accrued since the opening figure, minus what has
 * been taken.
 *
 * `holiday` is `settings.tescoHoliday` — `{ anchorDate, anchorHours, taken }`:
 * the balance Tesco showed on a day, and any hours used that the tab's own weeks
 * off do not account for. Three rules, and the third is the one that keeps the
 * opening figure honest:
 *
 *   * a week's credit is 8% of the hours that week paid (`buildPayWeeks`'
 *     hours, so a row stating its own hours is credited what it was paid for),
 *     posted on `payDateOf(weekStart)`;
 *   * a credit counts only once its Thursday has come round — a shift entered
 *     ahead of the rota, or a week still in progress, has not been earned yet —
 *     and only when that Thursday is AFTER `anchorDate`, because the opening
 *     figure is the balance as it stood that day: replaying the week already
 *     inside it would count the same hours twice. That is why the balance of
 *     35.10 set on a Thursday accrues again from the NEXT Thursday;
 *   * taken holiday is a week-off row (hours and no clock times — what booking
 *     holiday looks like here, see shiftPay) that has come round by today, dated
 *     after the anchor, plus the manual figure. A row with clock times is work,
 *     and it is already in the week's credit: subtracting it as well would take
 *     the same hours twice. A week off still ahead is booked, not used.
 *
 * The returned `ledger` is the same arithmetic written out line by line — the
 * opening figure, every posted credit, every week off and the typed figure,
 * each with the balance after it — so a balance read off a payslip can be
 * checked movement by movement instead of trusted as a total. It is built HERE
 * and not in the card for the reason this module exists: a card that assembles
 * its own rows is a second set of rules. Its last row's `balance` IS
 * `outstanding` (pinned in the harness), and the typed figure has no date —
 * it is one adjustment, not a movement on a day.
 *
 * Nothing here writes, and nothing throws: a document with junk in the holiday
 * slot reads as "not set up" rather than as a balance of NaN.
 */
export function holidayBalance(shifts, holiday, rates, today = todayIso()) {
  const src = holiday && typeof holiday === 'object' && !Array.isArray(holiday) ? holiday : HOLIDAY_DEFAULT;
  const hoursOf = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1000 ? r2(n) : 0;
  };
  const anchorDate = dateOk(src.anchorDate) ? src.anchorDate : '';
  const anchorHours = hoursOf(src.anchorHours);
  const manualTaken = hoursOf(src.taken);
  // An unusable clock is not a claim that time has passed (the same rule
  // dateOk enforces everywhere): with no day, nothing has been posted yet.
  const day = dateOk(today) ? today : '';
  // The rows are filtered before any arithmetic: buildPayWeeks assumes a record
  // with a date (it is handed the document's validated tables everywhere else),
  // and this function is also read by a harness and by a card that must never
  // throw — a null row or a day that does not exist is simply not a week.
  const rows = (Array.isArray(shifts) ? shifts : [])
    .filter(s => s && typeof s === 'object' && !Array.isArray(s) && dateOk(s.date));
  const creditOf = (hours) => r2(Number(hours) * HOLIDAY_ACCRUAL_PCT / 100);

  // Hours WORKED per pay week. A week off is paid hours but not worked hours,
  // so its row is excluded from the base: accruing 8% of a holiday would have
  // the balance earn holiday for being spent, which is the one direction this
  // arithmetic must never round in the user's favour. The same rows are the
  // "taken" side below, so the two can never both count the same week.
  const worked = new Map();
  for (const s of rows) {
    if (!(s.start && s.end) && statedHours(s.hours) != null) continue;
    const pay = shiftPay(s, rates);
    if (!pay || !(pay.hours > 0)) continue;
    const ws = weekStartOf(s.date);
    worked.set(ws, r2((worked.get(ws) || 0) + pay.hours));
  }
  const weeks = [...worked.entries()]
    .map(([weekStart, hours]) => ({ weekStart, payDate: payDateOf(weekStart), hours, credit: creditOf(hours) }))
    .sort((a, b) => a.payDate.localeCompare(b.payDate) || a.weekStart.localeCompare(b.weekStart));

  const posted = !anchorDate || !day ? [] : weeks.filter(w => w.payDate > anchorDate && w.payDate <= day);
  const accrued = r2(posted.reduce((sum, w) => sum + w.credit, 0));

  const weekOff = rows.filter(s => s && typeof s === 'object' && dateOk(s.date)
    && !(s.start && s.end) && statedHours(s.hours) != null);
  // Taken means taken: a week off dated in the future is booked, not used, so it
  // comes off when its week arrives rather than when it was typed in.
  const takenAutomatic = !anchorDate || !day
    ? 0
    : r2(weekOff.filter(s => s.date > anchorDate && s.date <= day).reduce((sum, s) => sum + statedHours(s.hours), 0));
  const taken = r2(takenAutomatic + manualTaken);

  // The working, oldest first. One list of dated movements, sorted by date (a
  // credit before a week off that starts on the same day: the money is posted
  // on that Thursday, the holiday starts on it), then the undated typed figure.
  const ledger = [];
  if (anchorDate) {
    let running = anchorHours;
    const dated = [
      ...posted.filter(w => w.credit > 0).map(w => ({
        date: w.payDate, order: 0, kind: 'credit', weekStart: w.weekStart, workedHours: w.hours, hours: w.credit,
      })),
      ...weekOff
        .filter(s => s.date > anchorDate && s.date <= day && statedHours(s.hours) > 0)
        .map(s => ({ date: s.date, order: 1, kind: 'weekOff', hours: r2(-statedHours(s.hours)) })),
    ].sort((a, b) => a.date.localeCompare(b.date)
      || a.order - b.order
      || String(a.weekStart || '').localeCompare(String(b.weekStart || '')))
      // `order` is the sort's tie-break, not part of a movement.
      .map(({ order, ...row }) => row);
    ledger.push({ kind: 'opening', date: anchorDate, hours: anchorHours, balance: r2(running) });
    for (const row of dated) {
      running = r2(running + row.hours);
      ledger.push({ ...row, balance: running });
    }
    if (manualTaken > 0) {
      running = r2(running - manualTaken);
      ledger.push({ kind: 'typed', date: '', hours: r2(-manualTaken), balance: running });
    }
  }

  // The next posting, whether or not its week has any hours on file yet: the
  // week a Thursday pays starts eleven days before it (`PAY_LAG_DAYS`).
  let next = null;
  if (anchorDate && day) {
    const payDate = nextThursdayAfter(day);
    const weekStart = isoAddDays(payDate, -PAY_LAG_DAYS);
    const week = weeks.find(w => w.weekStart === weekStart) || null;
    next = { payDate, weekStart, hours: week ? week.hours : 0, credit: week ? week.credit : 0 };
  }

  return {
    configured: !!anchorDate,
    anchorDate,
    anchorHours,
    accrued,
    takenAutomatic,
    manualTaken,
    taken,
    // A negative is a real state (holiday taken ahead of what has been earned).
    outstanding: anchorDate ? r2(anchorHours + accrued - taken) : 0,
    ledger,
    // Newest first, for a card that wants to show its working.
    credits: posted.slice().reverse(),
    next,
  };
}
