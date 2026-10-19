/* ============================================================
   csv.js — the one CSV field rule this app writes with, and reads
   back.

   Two modules need it and they sit on opposite sides of the boot
   path: storage.js writes the entries export AND reads one back
   (always available), and tesco.js reads a workbook back (fetched on
   the first visit to #tesco). A rule with two implementations is a
   rule that can disagree with itself, so it lives here — a few
   hundred bytes the boot path can afford, named by
   scripts/check-boot-payload.mjs and warmed by sw.js like every
   other boot module. That covers both directions: csvCell/
   csvDocument write a field, csvRows/csvDate read rows and dates
   back, so a file this app wrote can never be read two ways.

   The apostrophe rule below is a security rule as much as a
   formatting one, which is the other reason there is only one copy:
   the field a spreadsheet reads as a formula is the field a hostile
   note travels in.
   ============================================================ */

// A field is quoted only when it has to be, so the file stays readable — and a
// note containing a comma survives the round trip.
//
// A value that a spreadsheet would read as a formula (a leading =, +, - or @
// after any whitespace) gets an apostrophe in front. Excel, LibreOffice and
// Sheets all treat a leading apostrophe as "this cell is text", which is what
// stops a note like "=HYPERLINK(…)" or "=cmd|…" from executing when the export
// is opened — notes can be typed, imported from a file someone else made, or
// arrive in a synced cloud copy, so the file is not a safe container for one.
// csvUnquote() strips the apostrophe back off on import, so the round trip
// through this app is lossless.
const CSV_FORMULA_PREFIX = /^\s*[+\-=@]/;
// The shape a guard is stripped from on the way back in: a formula-looking
// remainder, OR one that starts with an apostrophe of its own (the escape of an
// escape — see csvCell). Defined once because the writer and the reader have to
// agree about it exactly, and they are the two halves of one rule.
const CSV_GUARDED = (s) => CSV_FORMULA_PREFIX.test(s) || s.startsWith("'");
// A plain number, negative included. Guarded separately from formula text: the
// apostrophe that defuses "=SUM(A1)" would turn a -56.08 tax refund into text,
// which Excel and any database load then read as a string instead of a value.
const CSV_PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

// Written in front of a file meant for a person, never of the text in between:
// Excel on Windows reads a BOM-less UTF-8 file in the machine's own ANSI code
// page, so a euro sign or an accent in a note arrives as mojibake. The bytes in
// the middle stay exactly what csvDocument() produced, which is what the tests
// and the Tesco round trip compare.
export const CSV_BOM = '\uFEFF';

/** One field, ready to be joined with commas. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // `CSV_GUARDED(s.slice(1))` is the round trip, not a flourish: a value that
  // already begins with an apostrophe AND reads as a formula after it would
  // otherwise come back with that apostrophe eaten — csvUnquote sees `'=x`,
  // takes the leading apostrophe for its own guard and answers `=x`, so a note
  // the user typed was quietly edited by an export/import (measured: `'=x`).
  // Escaping it doubles the apostrophe, and the reader strips exactly one.
  if (!CSV_PLAIN_NUMBER.test(s) && (CSV_FORMULA_PREFIX.test(s) || (s.startsWith("'") && CSV_GUARDED(s.slice(1))))) s = `'${s}`;
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Reverse of csvCell's apostrophe guard — the one field it can land on.
 *  Whitespace after the apostrophe is allowed because the guard fires on a
 *  value like "  @break" too, and the import trims it away regardless.
 *  A doubled apostrophe (`''=x`) is one escaped apostrophe, not the guard. */
export function csvUnquote(v: unknown): string {
  const s = String(v == null ? '' : v);
  return s.length > 1 && s[0] === "'" && CSV_GUARDED(s.slice(1)) ? s.slice(1) : s;
}

/** Rows of cells → one document. CRLF and a trailing newline, which is what
 *  Excel, Numbers and Sheets all write and all read back. */
export function csvDocument(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// The read side of the same rule: a real CSV splitter. Quoted fields may hold
// commas, doubled quotes and newlines, Excel writes CRLF, and its export of a
// sheet can open with an empty column A — all of which a split(',') would
// mangle. Both readers of a CSV this app writes (the Tesco workbook import and
// the entries import in storage.js) split rows here, so a file that round trips
// through this module cannot be read two different ways.
export function csvRows(text: unknown): string[][] {
  // Any scalar is text; nothing at all is no text, and no text has no rows.
  // Every other reader in this file coerce the same way (csvCell, csvUnquote,
  // csvDate, isRealDate), and this one is handed file bytes from three
  // different callers — a splitter that can throw on the empty case is a
  // caller that has to ask "is this even a string" before every read.
  const src = String(text == null ? '' : text);
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/**
 * Is this string a day that actually exists?
 *
 * The one date rule in this app, and it lives beside csvDate because that is
 * where dates arrive from outside: a file, a workbook, a locale-formatted cell.
 * Every validator that matters delegates here — `isValidCheckpointDate` in
 * storage.js (entries, checkpoints, recurring bills, the Tesco tables) and
 * `dateOk` in tesco-pay.js — because a rule with three implementations is a
 * rule that can disagree with itself, and the disagreement is silent: one side
 * drops a row the other accepted.
 *
 * The check is a round trip, and it has to be. Date.UTC ROLLS OVER an
 * out-of-range day — `Date.parse('2026-02-31')` answers a finite timestamp for
 * 2026-03-03, and `new Date('2026-02-31T00:00:00Z')` is a valid Date — so
 * neither "the shape looks right" nor "it parses" is the question being asked.
 * Reading the day back out and comparing it to what was written is the only
 * form of the check a rollover cannot pass: a string naming a day that does not
 * exist cannot equal the day it was read as.
 */
export function isRealDate(value: unknown): boolean {
  const s = String(value == null ? '' : value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === s;
}

// Dates arrive as ISO, as an Excel serial, or in a sheet's own day-first
// locale format — all three things a spreadsheet puts in a date column between
// exporting and re-saving. Answers an ISO day (YYYY-MM-DD) or null when the
// cell holds no date at all, so a caller can drop the row rather than guess —
// and "holds no date" includes a day that does not exist: a cell reading
// `31/02/2026` is a typo or a mis-typed year, not the 3rd of March, and a
// reader that silently rolls it over invents a date the file never stated.
export function csvDate(raw: unknown): string {
  const p2 = n => String(n).padStart(2, '0');
  const s = String(raw == null ? '' : raw).trim();
  const real = (iso) => (isRealDate(iso) ? iso : null);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return real(`${m[1]}-${p2(+m[2])}-${p2(+m[3])}`);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    return n > 20000 && n < 80000 ? new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10) : null; // a serial IS a day count: always real
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(s);   // day-first, a sheet's locale
  if (!m) return null;
  return real(`${m[3].length === 2 ? 2000 + +m[3] : +m[3]}-${p2(+m[2])}-${p2(+m[1])}`);
}
