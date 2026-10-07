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

// The read side of the same rule: a real CSV splitter. Quoted fields may hold
// commas, doubled quotes and newlines, Excel writes CRLF, and its export of a
// sheet can open with an empty column A — all of which a split(',') would
// mangle. Both readers of a CSV this app writes (the Tesco workbook import and
// the entries import in storage.js) split rows here, so a file that round trips
// through this module cannot be read two different ways.
export function csvRows(text) {
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

// Dates arrive as ISO, as an Excel serial, or in a sheet's own day-first
// locale format — all three things a spreadsheet puts in a date column between
// exporting and re-saving. Answers an ISO day (YYYY-MM-DD) or null when the
// cell holds no date at all, so a caller can drop the row rather than guess.
export function csvDate(raw) {
  const p2 = n => String(n).padStart(2, '0');
  const s = String(raw == null ? '' : raw).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${p2(+m[2])}-${p2(+m[3])}`;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    return n > 20000 && n < 80000 ? new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10) : null;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(s);   // day-first, a sheet's locale
  if (!m) return null;
  return `${m[3].length === 2 ? 2000 + +m[3] : +m[3]}-${p2(+m[2])}-${p2(+m[1])}`;
}
