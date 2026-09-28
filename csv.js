/* ============================================================
   csv.js — the one CSV field rule this app writes with, and reads
   back.

   Two modules need it and they sit on opposite sides of the boot
   path: storage.js writes the entries export (always available),
   and tesco.js reads a workbook back (fetched on the first visit to
   #tesco). A rule with two implementations is a rule that can
   disagree with itself, so it lives here — a few hundred bytes the
   boot path can afford, named by scripts/check-boot-payload.mjs and
   warmed by sw.js like every other boot module.

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
export const CSV_FORMULA_PREFIX = /^\s*[+\-=@]/;
// A plain number, negative included. Guarded separately from formula text: the
// apostrophe that defuses "=SUM(A1)" would turn a -56.08 tax refund into text,
// which Excel and any database load then read as a string instead of a value.
export const CSV_PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

// Written in front of a file meant for a person, never of the text in between:
// Excel on Windows reads a BOM-less UTF-8 file in the machine's own ANSI code
// page, so a euro sign or an accent in a note arrives as mojibake. The bytes in
// the middle stay exactly what csvDocument() produced, which is what the tests
// and the Tesco round trip compare.
export const CSV_BOM = '\uFEFF';

/** One field, ready to be joined with commas. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (!CSV_PLAIN_NUMBER.test(s) && CSV_FORMULA_PREFIX.test(s)) s = `'${s}`;
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Reverse of csvCell's apostrophe guard — the one field it can land on.
 *  Whitespace after the apostrophe is allowed because the guard fires on a
 *  value like "  @break" too, and the import trims it away regardless. */
export function csvUnquote(v) {
  const s = String(v == null ? '' : v);
  return s.length > 1 && s[0] === "'" && /^\s*[+\-=@]/.test(s.slice(1)) ? s.slice(1) : s;
}

/** Rows of cells → one document. CRLF and a trailing newline, which is what
 *  Excel, Numbers and Sheets all write and all read back. */
export function csvDocument(rows) {
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
