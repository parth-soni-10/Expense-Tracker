/**
 * A statement from a bank, in whatever shape that bank writes it.
 *
 * The app can already read its OWN CSV back (`parseEntriesCsv` in storage.js),
 * which works because both ends agree on the header. A bank does not agree on
 * anything: AIB writes `Date, Description, Amount (eur)`, Revolut writes
 * `Completed Date, Description, Amount, Currency`, and half of them offer a
 * separate Debit/Credit pair instead of one signed column. So the header is a
 * guess here, shown to the user as a guess, and one screen of mapping is what
 * makes the file readable — once, per file shape.
 *
 * Everything from "here is a file" to "here is what will be written" is pure
 * and exported: this module is reached only through `import()` (it is ~15 KB
 * of a screen nobody opens twice), and a Node test can read it like any other
 * pure module — no DOM at the top level, for exactly that reason.
 *
 * Three rules the entries carry with them:
 *   · **Never round imported money.** An amount that is not exact to 2dp is
 *     dropped with a count, not tidied — the same rule `validateEntry` and the
 *     Lidl pull apply, for the same reason.
 *   · **Re-importing a file adds nothing.** Rows are matched against the ledger
 *     (date, direction, description, amount, account) multiset-wise, so the
 *     same statement imported twice is idempotent while two genuinely
 *     identical coffees in one file still both land.
 *   · **The category is guessed by the app's own keyword table**, handed in
 *     from app.js rather than copied — a second copy of those rules is a
 *     second answer to "what is a Tesco shop", free to drift.
 */
import { csvRows, csvDate } from './csv.js';

/** Refusals, worded for a person the way parseBackup's and CSV_REFUSAL's are. */
export const BANK_REFUSAL = {
  empty: 'That file has no rows in it.',
  'too-large': 'That file is too large to read.',
  unreadable: 'That file could not be read as a CSV.',
  'no-columns': 'No columns were found in that file.',
  'no-rows': 'That file has no rows under its header.',
  'no-date': 'Pick the column that holds the date.',
  'no-amount': 'Pick the column that holds the amount (or a debit and a credit column).',
  'nothing-built': 'None of the rows could be read with this mapping.',
};

const round2 = (n) => Math.round(n * 100) / 100;

/** A statement's amount cell: `€1,234.56`, `-12.40`, `(12.40)`, `12.40 DR`,
 *  `1 234,56`. Returns a number (sign included) or null when it is not a
 *  number at all — a balance column full of prose must not become money. */
export function bankAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /\b(dr|debit)\b/i.test(s) || /^-/.test(s) || /[€$£]\s*-/.test(s);
  let body = s.replace(/[()]/g, '').replace(/\b(dr|cr|debit|credit)\b/gi, '').replace(/[€$£]/g, '').trim();
  let explicitSign = false;
  // A leading minus is the sign, not part of the number.
  if (body.startsWith('-')) { explicitSign = true; body = body.slice(1); }
  if (body.startsWith('+')) body = body.slice(1);
  // Spaces are thousands separators in European exports ("1 234,56").
  if (/^\d{1,3}( \d{3})+(?:[.,]\d+)?$/.test(body)) body = body.replace(/ /g, '');
  if (!/^\d[\d.,]*$/.test(body)) return null;
  const comma = body.lastIndexOf(','), dot = body.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const integer = body.slice(0, decimalIndex).replace(/[.,]/g, '');
    body = `${integer}.${body.slice(decimalIndex + 1)}`;
  } else if (comma >= 0) {
    const parts = body.split(',');
    // "1,234" is a thousands group; "12,40" is a decimal.
    body = (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3)
      ? parts.join('')
      : body.replace(',', '.');
  }
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return negative || explicitSign ? -n : n;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A statement's date cell. Anything csvDate already understands (ISO, Excel
 *  serial, day-first `12/09/2026` — Irish banks are day-first) first, then the
 *  two shapes a spreadsheet turns a date into on the way out: `12 Sep 2026`
 *  and `Sep 12, 2026`. Answers an ISO day or null; it never guesses. */
export function bankDate(raw) {
  const iso = csvDate(raw);
  if (iso) return iso;
  const s = String(raw == null ? '' : raw).trim();
  let m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const day = +m[1];
    if (day >= 1 && day <= 31) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const day = +m[2];
    if (day >= 1 && day <= 31) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/** Some banks export a table with no header at all (and some separate on a
 *  semicolon, a few on a tab). Both are decided from the text before the split,
 *  never after — a comma inside a quoted field is not a delimiter. */
function normalizeDelimiters(text) {
  const hasQuotes = text.includes('"');
  const hasComma = text.includes(',');
  if (hasQuotes) return text;
  if (!hasComma && text.includes(';')) return text.split(/\r?\n/).map(line => line.split(';').join(',')).join('\n');
  if (!hasComma && !text.includes(';') && text.includes('\t')) return text.replace(/\t/g, ',');
  return text;
}

/**
 * Read a statement CSV into `{ columns, rows }`.
 *
 * The first row is treated as a header UNLESS it already holds a date, which
 * is how a headerless export is told apart from a one-row file.
 */
export function parseBankCsv(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return { ok: false, reason: 'empty' };
  let rows;
  try {
    rows = csvRows(normalizeDelimiters(src));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!rows.length) return { ok: false, reason: 'empty' };
  const width = Math.max(...rows.map(r => r.length));
  if (!width) return { ok: false, reason: 'no-columns' };
  const firstHasDate = rows[0].some(cell => bankDate(cell) !== null);
  const columns = firstHasDate
    ? Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
    : rows[0].map((h, i) => String(h == null ? '' : h).trim() || `Column ${i + 1}`);
  const body = firstHasDate ? rows : rows.slice(1);
  if (!body.length) return { ok: false, reason: 'no-rows' };
  return { ok: true, columns, rows: body.map(r => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
}

const HEADER_SCORE = [
  ['date', /\bdate\b|\bday\b|\bposted\b|\bbooking\b|\bvalue date\b|\bcompleted\b/i],
  ['description', /desc|narrative|details|memo|payee|reference|name|statement|comment|merchant/i],
  ['amount', /^(amount|value|sum|amount eur|amount \(eur\)|transaction amount|gross amount)$/i],
  ['debit', /debit|withdrawal|money out|paid out|\bout\b|expense/i],
  ['credit', /credit(?! card)|deposit|money in|paid in|\bin\b|income/i],
];

/**
 * One cell of a row that may not be a row at all.
 *
 * A bank file is a print somebody else made, so no shape about it is
 * guaranteed — and not being a list of cells is the same as being an empty
 * one. bankAmount/bankDate answer null for junk rather than throwing, and the
 * guesser has to hold that same line: a throw in here takes the whole mapping
 * screen down before it can draw, which is the one moment the user could have
 * fixed the file by hand.
 */
const cellAt = (row, i) => (row && typeof row === 'object' ? String(row[i] ?? '') : '');

/**
 * The mapper's first guess, from the header words and then from the cells
 * themselves — because a header is only a header if the bank wrote one.
 * Answers indexes into `columns`, `-1` when nothing looks like that field.
 *
 * Total on both arguments, for the reason above: a column list or row list
 * that is missing, empty or the wrong shape gets the same answer a file with
 * no recognisable columns gets — "nothing looks like that field" — which is a
 * state the screen already knows how to render (every field starts blank and
 * the user picks), where a throw is a screen that never appears.
 */
export function suggestBankMapping(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const sample = (Array.isArray(rows) ? rows : []).slice(0, 40);
  const find = (name) => {
    const rule = HEADER_SCORE.find(([key]) => key === name)[1];
    const hit = cols.findIndex(c => rule.test(String(c).trim()));
    // "Balance" is a running total, not a transaction amount: never guess it.
    if (name === 'amount' && hit >= 0 && /balance/i.test(cols[hit])) return -1;
    return hit;
  };
  const date = find('date');
  const description = find('description');
  let amount = find('amount');
  const debit = find('debit');
  const credit = find('credit');
  const usable = (i, test) => i >= 0 && sample.length && sample.filter(r => test(cellAt(r, i))).length >= sample.length * 0.6;
  // A running total is never the amount, whichever way the cells look: it is
  // the sum of every column that IS one.
  const notBalance = (i) => i >= 0 && !/balance/i.test(String(cols[i] || ''));
  if (!usable(date, v => bankDate(v) !== null)) {
    const guess = cols.findIndex((_, i) => usable(i, v => bankDate(v) !== null));
    return columnGuess(guess, cols, sample, description);
  }
  if (amount < 0 || debit < 0 || credit < 0) {
    // Fall back to the cells: a column most of whose values are signed numbers
    // is the amount column, whichever word the bank put on top of it.
    const signedNumeric = cols.findIndex((_, i) => i !== date && notBalance(i) && usable(i, v => bankAmount(v) !== null && /[+\-(]|^-/.test(v)));
    const anyNumeric = cols.findIndex((_, i) => i !== date && notBalance(i) && usable(i, v => bankAmount(v) !== null));
    if (amount < 0) amount = signedNumeric >= 0 ? signedNumeric : anyNumeric;
    if (debit < 0 && credit < 0) {
      // One signed column instead of a pair: leave both unset so the user
      // picks — guessing is what makes an import wrong in a way nobody sees.
    }
  }
  let desc = description;
  if (!usable(desc, v => v.trim().length > 0)) {
    // The widest text column that is neither the date nor the amount.
    let best = -1, bestWidth = 0;
    cols.forEach((_, i) => {
      if (i === date || i === amount) return;
      const width = sample.reduce((sum, r) => sum + cellAt(r, i).trim().length, 0);
      if (width > bestWidth) { bestWidth = width; best = i; }
    });
    desc = best;
  }
  return { date, description: desc, amount, debit, credit };
}

/** The headerless case: the date column was found from its cells, and the rest
 *  follows from there rather than from words that are not in the file.
 *  `sample` is already the first 40 rows and `cols` is already a column list:
 *  the caller above is the one that makes both of those true. */
function columnGuess(dateIndex, cols, sample, descriptionHeader) {
  if (dateIndex < 0) return { date: -1, description: descriptionHeader ?? -1, amount: -1, debit: -1, credit: -1 };
  const notBalance = (i) => !/balance/i.test(String(cols[i] || ''));
  const numeric = cols.findIndex((_, i) => i !== dateIndex && notBalance(i)
    && sample.filter(r => bankAmount(cellAt(r, i)) !== null).length >= sample.length * 0.6);
  const signed = cols.findIndex((_, i) => i !== dateIndex && i !== numeric && notBalance(i)
    && sample.filter(r => { const n = bankAmount(cellAt(r, i)); return n !== null && n < 0; }).length >= Math.min(3, sample.length));
  const described = cols.findIndex((_, i) => i !== dateIndex && i !== numeric
    && sample.reduce((sum, r) => sum + cellAt(r, i).trim().length, 0) > sample.length * 3);
  // With three columns and no words to go on, the one that is neither the day
  // nor the money is where the description went.
  const fallbackText = cols.findIndex((_, i) => i !== dateIndex && i !== numeric);
  return {
    date: dateIndex,
    description: described >= 0 ? described : (fallbackText >= 0 ? fallbackText : -1),
    amount: signed >= 0 ? signed : numeric,
    debit: -1,
    credit: -1,
  };
}

const normDetails = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The mapping, made real: one entry per row that survives all four checks
 * (a date, a non-zero amount exact to 2dp, not already in the ledger).
 *
 * `guessCategory` and `decorate` are handed in — the keyword table lives in
 * app.js (one copy of those rules), and ids/createdAt are app.js's business.
 * Returns the entries plus every reason a row did not become one, because
 * "imported 118 of 140" is a sentence the user can act on and "imported 118"
 * is not.
 */
export function buildBankEntries({ rows, mapping, method, guessCategory = () => 'misc', decorate = (e) => e, existing = [] }) {
  const have = new Map();
  const bump = (key) => have.set(key, (have.get(key) || 0) + 1);
  const take = (key) => {
    const left = have.get(key) || 0;
    if (left > 0) { have.set(key, left - 1); return true; }
    return false;
  };
  for (const e of Array.isArray(existing) ? existing : []) {
    if (!e || !e.date) continue;
    bump(`${e.date}|${e.type}|${normDetails(e.details)}|${round2(Number(e.amount) || 0)}|${e.method}`);
  }
  const stats = { kept: 0, duplicates: 0, noDate: 0, badAmount: 0, empty: 0 };
  const entries = [];
  const creditAt = mapping.credit >= 0 ? mapping.credit : -1;
  const debitAt = mapping.debit >= 0 ? mapping.debit : -1;
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = bankDate(row[mapping.date]);
    if (!date) { stats.noDate += 1; continue; }
    let value = null;
    if (creditAt >= 0 || debitAt >= 0) {
      // Separate columns: money out and money in are separate cells, and a
      // row that fills neither is not a transaction.
      const debit = debitAt >= 0 ? bankAmount(row[debitAt]) : null;
      const credit = creditAt >= 0 ? bankAmount(row[creditAt]) : null;
      if (debit != null && debit !== 0) value = -Math.abs(debit);
      else if (credit != null && credit !== 0) value = Math.abs(credit);
    } else {
      value = bankAmount(row[mapping.amount]);
    }
    if (value == null || value === 0) { stats.empty += 1; continue; }
    if (round2(value) !== value) { stats.badAmount += 1; continue; }   // never round imported money
    const details = String(row[mapping.description] == null ? '' : row[mapping.description]).trim() || 'Bank transaction';
    const amount = Math.round(Math.abs(value) * 100) / 100;
    const type = value < 0 ? 'expense' : 'credit';
    const key = `${date}|${type}|${normDetails(details)}|${amount}|${method}`;
    if (take(key)) { stats.duplicates += 1; continue; }
    entries.push(decorate({
      date,
      type,
      category: guessCategory(details),
      details,
      amount,
      method,
      note: 'Imported from a bank statement',
    }));
    stats.kept += 1;
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return { entries, ...stats };
}

/** "118 ready, 22 skipped — 20 had no date we could read, 2 are already here."
 *  Returns '' when nothing was skipped, so the preview stays clean. */
export function bankImportSummary(result) {
  const skip = result.noDate + result.badAmount + result.empty + result.duplicates;
  if (!skip) return '';
  const parts = [];
  if (result.noDate) parts.push(`${result.noDate} with no readable date`);
  if (result.badAmount) parts.push(`${result.badAmount} with an amount that is not exact money`);
  if (result.empty) parts.push(`${result.empty} with no amount`);
  if (result.duplicates) parts.push(`${result.duplicates} already in your ledger`);
  return `${skip} row${skip === 1 ? '' : 's'} skipped — ${parts.join(', ')}.`;
}

/**
 * The one screen that makes a file shape readable: pick the file, check the
 * mapping, see what it will write, import it.
 *
 * The modal opens FIRST and the file picker lives inside it, which is what
 * makes the surface auditable at all (a page cannot see or dismiss the OS file
 * dialog) — and what lets the mapping be corrected before anything is written.
 */
export function openBankImport(ctx) {
  const {
    $, iconSpan, toast, fmt, friendlyDate, swalConfirm, methods, isTopModal,
    guessCategory, uid, nowIso, commitAdded, render,
  } = ctx;
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Import bank statement', tabindex: '-1', style: 'max-width:560px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);
  const close = () => { document.removeEventListener('keydown', onEsc, true); input.remove(); bg.remove(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  let parsed = null;      // { columns, rows }
  let mapping = null;     // { date, description, amount, debit, credit }
  let account = (methods && methods[0] && methods[0].id) || 'AIB';
  let fileName = '';

  const input = $('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'restore-file bank-import-file', 'aria-label': 'Choose a bank statement CSV', style: 'display:none;' });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';                    // the same file twice must fire again
    if (file) void loadFile(file);
  });
  document.body.appendChild(input);

  const body = $('div');
  const header = () => {
    modal.replaceChildren(
      $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' },
        $('div', null,
          $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;margin:0;' }, 'Import bank statement'),
          $('div', { class: 'muted', style: 'font-size:11px;' }, parsed ? fileName : 'A CSV your bank exported. Nothing is written until you say so.'),
        ),
        $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
      ),
      body,
    );
  };

  async function loadFile(file) {
    if (file.size > 32 * 1024 * 1024) { toast(BANK_REFUSAL['too-large']); return; }
    let text;
    try {
      text = await file.text();
    } catch {
      toast(BANK_REFUSAL.unreadable);
      return;
    }
    const verdict = parseBankCsv(text);
    if (!verdict.ok) { toast(BANK_REFUSAL[verdict.reason] || BANK_REFUSAL.unreadable); return; }
    parsed = verdict;
    fileName = file.name || 'that file';
    mapping = suggestBankMapping(parsed.columns, parsed.rows);
    drawMapping();
  }

  const select = (label, value, onPick, noneLabel) => {
    const sel = $('select', { 'aria-label': label, style: 'font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;max-width:190px;' });
    sel.append($('option', { value: '-1' }, noneLabel));
    parsed.columns.forEach((name, i) => sel.append($('option', { value: String(i) }, name)));
    sel.value = String(value);
    sel.addEventListener('change', () => { onPick(Number(sel.value)); drawPreview(); });
    return $('div', null,
      $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, label),
      sel,
    );
  };

  const accountSelect = () => {
    const sel = $('select', { 'aria-label': 'Account these transactions belong to', style: 'font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;max-width:190px;' });
    for (const m of (methods || [])) sel.append($('option', { value: m.id }, m.label));
    sel.value = account;
    sel.addEventListener('change', () => { account = sel.value; drawPreview(); });
    return $('div', null,
      $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, 'Account'),
      sel,
    );
  };

  const build = () => {
    const usable = mapping && mapping.date >= 0
      && (mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0);
    if (!usable) return null;
    return buildBankEntries({
      rows: parsed.rows,
      mapping,
      method: account,
      guessCategory,
      decorate: e => ({ ...e, id: uid(), createdAt: nowIso() }),
      existing: ctx.existingEntries ? ctx.existingEntries() : [],
    });
  };

  let previewEl;
  function drawPreview() {
    if (!previewEl || !previewEl.isConnected) return;
    const result = build();
    if (!result) {
      previewEl.replaceChildren($('div', { class: 'muted', style: 'font-size:12px;margin-top:12px;' },
        BANK_REFUSAL[mapping && mapping.date < 0 ? 'no-date' : 'no-amount']));
      return;
    }
    const summary = bankImportSummary(result);
    const shown = result.entries.slice(0, 5);
    previewEl.replaceChildren(
      $('div', { style: 'font-size:13px;margin-top:14px;font-weight:600;' },
        result.entries.length ? `${result.entries.length} transaction${result.entries.length === 1 ? '' : 's'} ready` : 'Nothing to import yet'),
      summary ? $('div', { class: 'muted', style: 'font-size:12px;margin-top:3px;' }, summary) : null,
      shown.length ? $('div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:4px;' },
        ...shown.map(e => $('div', { style: 'display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:5px 0;border-bottom:1px solid var(--line);' },
          $('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
            `${friendlyDate(e.date)} · ${e.details}`),
          $('span', { class: 'tnum', style: `flex-shrink:0;color:${e.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};` },
            `${e.type === 'credit' ? '+' : '-'}${fmt(e.amount)}`),
        )),
      ) : null,
      $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;' },
        $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { parsed = null; mapping = null; drawPick(); } }, 'Choose another file'),
        $('button', {
          type: 'button', class: 'btn btn-primary',
          style: result.entries.length ? '' : 'opacity:.5;pointer-events:none;',
          onClick: () => void confirmImport(result),
        }, 'Import'),
      ),
    );
  }

  async function confirmImport(result) {
    const ok = await swalConfirm({
      title: 'Import this statement?',
      text: `Add ${result.entries.length} transaction${result.entries.length === 1 ? '' : 's'} from ${fileName} to ${account}? Nothing already in your ledger is deleted, and the whole import is one undo.`,
      confirmButtonText: 'Import',
    });
    if (!ok) return;
    const count = result.entries.length;
    close();
    commitAdded(result.entries, `Imported ${count} bank transaction${count === 1 ? '' : 's'}`, () => {
      toast(`Imported ${count} transaction${count === 1 ? '' : 's'}.`);
      render();
    });
  }

  const modeBtn = (label, active, onClick) => $('button', {
    type: 'button',
    'aria-pressed': active ? 'true' : 'false',
    style: `font-size:11px;padding:5px 10px;border-radius:999px;cursor:pointer;font-family:inherit;`
      + `border:1px solid ${active ? 'var(--accent)' : 'var(--line)'};`
      + `background:${active ? 'var(--accent-soft)' : 'transparent'};`
      + `color:${active ? 'var(--accent)' : 'var(--muted)'};`,
    onClick,
  }, label);

  function drawMapping() {
    const pair = mapping.debit >= 0 || mapping.credit >= 0;
    const retype = (toPair) => {
      const guess = suggestBankMapping(parsed.columns, parsed.rows);
      if (toPair) {
        mapping.debit = guess.debit;
        mapping.credit = guess.credit;
        mapping.amount = -1;
      } else {
        mapping.amount = guess.amount;
        mapping.debit = -1;
        mapping.credit = -1;
      }
      drawMapping();
    };
    body.replaceChildren(
      $('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;' },
        $('span', { class: 'eyebrow' }, 'Amounts'),
        modeBtn('One signed column', !pair, () => retype(false)),
        modeBtn('Debit and credit', pair, () => retype(true)),
      ),
      $('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:12px;' },
        select('Date column', mapping.date, v => { mapping.date = v; }, '— choose —'),
        select('Description column', mapping.description, v => { mapping.description = v; }, '— none —'),
        pair
          ? $('div', null,
              $('div', { style: 'display:flex;gap:8px;' },
                select('Debit column', mapping.debit, v => { mapping.debit = v; }, '— none —'),
                select('Credit column', mapping.credit, v => { mapping.credit = v; }, '— none —'),
              ),
            )
          : select('Amount column', mapping.amount, v => { mapping.amount = v; }, '— choose —'),
        accountSelect(),
      ),
      previewEl = $('div'),
    );
    drawPreview();
  }

  function drawPick() {
    body.replaceChildren(
      $('p', { class: 'muted', style: 'font-size:13px;line-height:1.6;margin:8px 0 16px;' },
        'Export a CSV from your bank (AIB, Revolut, anything with a date, a description and an amount), then choose it here. You will see which column means what before anything is added.'),
      $('button', { type: 'button', class: 'btn btn-primary', onClick: () => input.click() }, iconSpan('download', 'md'), ' Choose CSV file'),
    );
  }

  header();
  drawPick();
}
