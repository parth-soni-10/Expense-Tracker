/* ============================================================
   Tesco Pay, the write side.

   The read side lives in `screens/tesco.ts`; the rules live in
   `app/lib/tesco-sheet.ts` (the sheet's own two tables) and
   `app/lib/tesco-pay.ts` (the engine). This file is the surface that changes
   the document, and every rule it obeys is a rule the ported modules own.

   What is here, and why each one is a decision rather than a field:

   · QUICK ENTRY — one shift per line, written the way the shift is remembered
     ("mon 8-4", "yesterday 12:30-20:15", "week off 7h"). Every line is
     previewed before any of it is written, and **one bad line blocks the
     batch**: a half-written week is worse than a week that was not written.

   · ADD A SHIFT — the same row, typed field by field.

   · WEEK OFF — a booked week off is hours and no clock times, dated on the
     week's own Sunday, because a pay week runs Sunday → Saturday and the
     Sunday is the date that says which week this is.

   · PAY RULES & TAX RATES — the rate card, with the Sunday rate derived from
     the normal rate and the multiplier rather than stored twice, and the PRSI
     rule carrying its effective date (the statute moved on 1 October 2026, and
     the default stays at the old rate so the workbook's own rows survive an
     export unchanged).

   · IMPORT / EXPORT — the sheet's own columns, out and back in. The workbook
     path fetches SheetJS **on the first workbook chosen**: 245 KB that a CSV
     import must never wait on, and that a boot must never pay for.

   · DUPLICATE SUPPRESSION — a shift is keyed by `date|start|end`, so the same
     shift twice in one file is one shift, and a hand edit onto another shift's
     slot is refused for the same reason an import of it would be.
   ============================================================ */
import { el } from '../dom.ts';
import { toast } from '../toast.ts';
import { trackAction } from '../actions.ts';
import { uid } from '../../lib/storage.ts';
import { downloadText } from '../../lib/storage.ts';
import { fmt, today } from '../format.ts';
import {
  PAY_LAG_DAYS,
  TESCO_PAY_METHOD,
  TESCO_RATE_DEFAULTS,
  r2,
  receivedByPayDate,
  shiftPay,
  simulateTax,
  tescoPayLedgerWrites,
  tescoPayWriteWindow,
  todayIso,
  weekStartOf,
} from '../../lib/tesco-pay.ts';
import {
  applyShiftEdit,
  parseShiftText,
  parseTescoCsv,
  storedPayslip,
  storedShift,
  tescoCsv,
  weekOffShift,
  workbookToCsv,
  type TescoPayslip,
  type TescoShift,
} from '../../lib/tesco-sheet.ts';
import { loadVendor } from '../vendor.ts';
import type { ScreenContext } from './context.ts';

export interface TescoState {
  shifts: TescoShift[];
  payslips: TescoPayslip[];
  rates: any;
  weekNos: Record<string, number>;
}

/** Everything a Tesco screen reads, in one place, so a card and the screen
 *  never disagree about what the document holds. */
export function tescoState(ctx: ScreenContext): TescoState {
  const tesco: any = (ctx.state as any).tesco || {};
  const settings: any = (ctx.state as any).settings || {};
  return {
    shifts: Array.isArray(tesco.shifts) ? tesco.shifts : [],
    payslips: Array.isArray(tesco.payslips) ? tesco.payslips : [],
    rates: { ...TESCO_RATE_DEFAULTS, ...(settings.tescoRates || {}) },
    weekNos: (settings.tescoWeekNos || {}) as Record<string, number>,
  };
}

function writeTesco(ctx: ScreenContext, shifts: TescoShift[], payslips: TescoPayslip[]): void {
  const tesco: any = (ctx.state as any).tesco || {};
  tesco.shifts = shifts;
  tesco.payslips = payslips;
  (ctx.state as any).tesco = tesco;
}

const shiftKey = (shift: { date: string; start?: string; end?: string }): string =>
  `${shift.date}|${shift.start || ''}|${shift.end || ''}`;

/** The rows a list of parsed shifts becomes, with the duplicates dropped.
 *  A shift is keyed by its day and its clock times, so the same shift twice in
 *  one file is one shift. */
export function freshShifts(list: any[], seen: Set<string>): TescoShift[] {
  const out: TescoShift[] = [];
  const at = new Date().toISOString();
  for (const s of list) {
    const draft = storedShift(s, uid(), at);
    if (!draft) continue;
    const key = shiftKey(draft);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(draft);
  }
  return out;
}

/** A payslip is keyed by the row's own date, so importing an overlapping file
 *  can never duplicate a row — and a week that had two pay runs keeps both
 *  because the two rows carry their own dates. */
export function freshSlips(list: any[], seen: Set<string>): TescoPayslip[] {
  const out: TescoPayslip[] = [];
  const at = new Date().toISOString();
  for (const p of list) {
    const draft = storedPayslip(p, uid(), at);
    if (!draft || !draft.weekStart || seen.has(draft.weekStart)) continue;
    seen.add(draft.weekStart);
    out.push(draft);
  }
  return out;
}

/* ── the quick entry card ─────────────────────────────────────────────────── */

export function buildQuickEntryCard(ctx: ScreenContext): HTMLElement {
  const text = el('textarea', {
    class: 'add-input tesco-quick-text',
    rows: '3',
    'aria-label': 'Shifts, one per line',
    placeholder: 'mon 8-4\nyesterday 12:30-20:15\nweek off 7h',
  }) as HTMLTextAreaElement;
  const preview = el('div', { class: 'tesco-quick-preview' });
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const parsed = (): ReturnType<typeof parseShiftText> => parseShiftText(text.value, today());

  const paint = (): void => {
    preview.replaceChildren();
    const result = parsed();
    if (!text.value.trim()) {
      preview.append(el('p', { class: 'muted' },
        'One shift per line: "mon 8-4", "yesterday 12:30-20:15", "week off 7h".'));
      return;
    }
    for (const shift of result.shifts) {
      const pay = shiftPay(shift as any, tescoState(ctx).rates);
      preview.append(el('div', { class: 'tesco-quick-row' },
        el('span', { class: 'tesco-quick-date' }, shift.date),
        el('span', { class: 'tesco-quick-when' },
          shift.start && shift.end ? `${shift.start}–${shift.end}` : `${shift.hours ?? '?'}h, no clock times`),
        el('span', { class: 'muted' }, pay ? `${fmt(pay.gross)} · ${pay.special ? 'special' : 'normal'}` : ''),
        shift.note ? el('span', { class: 'muted' }, shift.note) : null,
      ));
    }
    for (const problem of result.problems) {
      preview.append(el('div', { class: 'tesco-quick-row is-bad' },
        el('span', { class: 'tesco-quick-date' }, `line ${problem.line}`),
        el('span', { class: 'tesco-quick-when' }, problem.error),
      ));
    }
  };

  text.addEventListener('input', paint);

  const add = (): void => {
    const result = parsed();
    // ONE BAD LINE BLOCKS THE BATCH. A half-written week is worse than a week
    // that was not written: the pay figure for it would be short, and nobody
    // would notice until the money did not add up.
    if (result.problems.length) {
      status.textContent = `${result.problems.length} line${result.problems.length === 1 ? '' : 's'} could not be read — nothing was added.`;
      status.className = 'add-status is-error';
      paint();
      return;
    }
    if (!result.shifts.length) {
      status.textContent = 'Nothing to add.';
      status.className = 'add-status';
      return;
    }
    const before = { shifts: tescoState(ctx).shifts, payslips: tescoState(ctx).payslips };
    const seen = new Set(before.shifts.map(shiftKey));
    const added = freshShifts(result.shifts, seen);
    if (!added.length) {
      status.textContent = 'Those shifts are already stored.';
      status.className = 'add-status is-error';
      return;
    }
    writeTesco(ctx, [...before.shifts, ...added], before.payslips);
    const step = trackAction(ctx.save, {
      label: `Added ${added.length} shift${added.length === 1 ? '' : 's'}`,
      undo: () => { writeTesco(ctx, before.shifts, before.payslips); ctx.save(); },
    });
    status.textContent = '';
    status.className = 'add-status';
    text.value = '';
    toast(`Added ${added.length} shift${added.length === 1 ? '' : 's'}.`, { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
    ctx.refresh();
  };

  paint();
  return el('div', { class: 'card tesco-card' },
    el('div', { class: 'eyebrow' }, 'Quick entry'),
    text,
    preview,
    el('div', { class: 'add-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Add shifts'),
    ),
    status,
  );
}

/* ── the add-a-shift card ─────────────────────────────────────────────────── */

export function buildAddShiftCard(ctx: ScreenContext): HTMLElement {
  const dateField = el('input', { type: 'date', class: 'add-input', value: today(), max: today(), 'aria-label': 'Shift date' }) as HTMLInputElement;
  const startField = el('input', { type: 'text', class: 'add-input', placeholder: '09:00', 'aria-label': 'Start time', autocomplete: 'off' }) as HTMLInputElement;
  const endField = el('input', { type: 'text', class: 'add-input', placeholder: '17:00', 'aria-label': 'End time', autocomplete: 'off' }) as HTMLInputElement;
  const hoursField = el('input', { type: 'text', class: 'add-input', inputmode: 'decimal', placeholder: 'hours', 'aria-label': 'Hours of pay', autocomplete: 'off' }) as HTMLInputElement;
  const specialField = el('input', { type: 'checkbox', class: 'add-check', 'aria-label': 'Special rate' }) as HTMLInputElement;
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const add = (): void => {
    const hours = hoursField.value.trim();
    const draft = {
      date: dateField.value,
      start: startField.value.trim(),
      end: endField.value.trim(),
      ...(hours ? { hours } : {}),
      special: specialField.checked,
      note: '',
    };
    // The SAME rules an import applies, so a typed row can never be one the
    // importer would have refused.
    const stored = storedShift(draft, uid(), new Date().toISOString());
    if (!stored) {
      status.textContent = 'Give both clock times, or state the hours for a week off.';
      status.className = 'add-status is-error';
      return;
    }
    const before = { shifts: tescoState(ctx).shifts, payslips: tescoState(ctx).payslips };
    const seen = new Set(before.shifts.map(shiftKey));
    if (seen.has(shiftKey(stored))) {
      status.textContent = 'A shift on that day with the same times is already stored.';
      status.className = 'add-status is-error';
      return;
    }
    seen.add(shiftKey(stored));
    writeTesco(ctx, [...before.shifts, stored], before.payslips);
    const step = trackAction(ctx.save, {
      label: 'Added a shift',
      undo: () => { writeTesco(ctx, before.shifts, before.payslips); ctx.save(); },
    });
    status.textContent = '';
    status.className = 'add-status';
    startField.value = '';
    endField.value = '';
    hoursField.value = '';
    specialField.checked = false;
    toast('Shift added.', { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
    ctx.refresh();
  };

  return el('div', { class: 'card tesco-card' },
    el('div', { class: 'eyebrow' }, 'Add a shift'),
    el('div', { class: 'add-row' },
      el('label', { class: 'add-label', for: 'tesco-shift-date' }, 'Date'),
      dateField,
    ),
    el('div', { class: 'add-row' },
      startField,
      endField,
    ),
    el('div', { class: 'add-row' },
      hoursField,
      el('label', { class: 'add-check-row' }, specialField, 'Special rate'),
    ),
    el('div', { class: 'add-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Add shift'),
    ),
    status,
  );
}

/* ── the week-off card ────────────────────────────────────────────────────── */

export function buildWeekOffCard(ctx: ScreenContext): HTMLElement {
  const dateField = el('input', { type: 'date', class: 'add-input', value: today(), 'aria-label': 'Week off date' }) as HTMLInputElement;
  const hoursField = el('input', { type: 'text', class: 'add-input', inputmode: 'decimal', value: '7', 'aria-label': 'Hours of pay', autocomplete: 'off' }) as HTMLInputElement;
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const add = (): void => {
    const made = weekOffShift(dateField.value, hoursField.value);
    if (made.ok === false) {
      status.textContent = made.error;
      status.className = 'add-status is-error';
      return;
    }
    const before = { shifts: tescoState(ctx).shifts, payslips: tescoState(ctx).payslips };
    const stored = storedShift(made.shift, uid(), new Date().toISOString());
    if (!stored) {
      status.textContent = 'That week off could not be stored — give a date and some hours.';
      status.className = 'add-status is-error';
      return;
    }
    const seen = new Set(before.shifts.map(shiftKey));
    if (seen.has(shiftKey(stored))) {
      status.textContent = 'That week off is already stored.';
      status.className = 'add-status is-error';
      return;
    }
    writeTesco(ctx, [...before.shifts, stored], before.payslips);
    const step = trackAction(ctx.save, {
      label: 'Added a week off',
      undo: () => { writeTesco(ctx, before.shifts, before.payslips); ctx.save(); },
    });
    status.textContent = `Booked on ${stored.date} — the week's Sunday.`;
    status.className = 'add-status';
    toast('Week off booked.', { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
    ctx.refresh();
  };

  return el('div', { class: 'card tesco-card' },
    el('div', { class: 'eyebrow' }, 'Week off'),
    el('p', { class: 'muted tesco-card-note' },
      'A booked week off is hours and no clock times, dated on the week\'s Sunday — a pay week runs Sunday to Saturday.'),
    el('div', { class: 'add-row' },
      dateField,
      hoursField,
    ),
    el('div', { class: 'add-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Book week off'),
    ),
    status,
  );
}

/* ── the rates card ───────────────────────────────────────────────────────── */

export function buildRatesCard(ctx: ScreenContext): HTMLElement {
  const settings: any = (ctx.state as any).settings || {};
  const rates = { ...TESCO_RATE_DEFAULTS, ...(settings.tescoRates || {}) };
  const grid = el('div', { class: 'tesco-rates-grid' });
  const sundayRate = el('span', { class: 'tesco-derived' });
  const refreshSunday = (): void => {
    sundayRate.textContent = `= ${fmt(r2(Number(rates.normal) * Number(rates.specialMultiplier)))}/h`;
  };

  const field = (label: string, key: string, hint?: HTMLElement): HTMLElement => {
    const input = el('input', {
      type: 'number', step: '0.01', class: 'add-input', value: String(rates[key]), 'aria-label': label,
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const value = parseFloat(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      rates[key] = value;
      refreshSunday();
      // The rate card is written through as it is typed, so a half-typed
      // number never lands on the document.
      settings.tescoRates = { ...rates };
      (ctx.state as any).settings = settings;
      ctx.save();
    });
    return el('div', { class: 'tesco-rate-field' },
      el('label', { class: 'add-label' }, label),
      input,
      hint || null,
    );
  };

  refreshSunday();
  grid.append(field('Normal per hour', 'normal'));
  grid.append(field('Sunday multiplier', 'specialMultiplier', sundayRate));
  grid.append(field('Pension percent', 'pensionPct'));
  grid.append(field('PAYE credit', 'payeCredit'));
  grid.append(field('PAYE cutoff', 'payeCutoff'));
  grid.append(field('PRSI percent', 'prsiRate'));

  return el('div', { class: 'card tesco-card' },
    el('div', { class: 'eyebrow' }, 'Pay rules & tax rates'),
    grid,
    el('p', { class: 'muted tesco-card-note' },
      `Pay week runs Sunday to Saturday; the payslip lands ${PAY_LAG_DAYS} days after the week starts (Thursday). USC bands are statutory and fixed; PRSI is exempt at 352 a week or less and its 12 credit tapers away by 424. The PRSI rate above is the one you set for the weeks you are estimating: 4.35% from 1 October 2026, 4.2% before that, and the default stays at 4.2% so the workbook's own rows survive an export unchanged.`),
  );
}

/* ── import / export ──────────────────────────────────────────────────────── */

export function buildDataCard(ctx: ScreenContext): HTMLElement {
  // The workbook path: SheetJS reads the .xlsx and hands its sheets back as
  // the CSV text everything above already knows, so the import rules live in
  // one place. Fetched on the FIRST WORKBOOK chosen — never at boot, and never
  // for a CSV, which must not wait on 245 KB it will not use.
  const workbookText = async (file: File): Promise<string> => {
    await loadVendor('xlsx', { js: 'vendor/xlsx.mini.min.js' });
    const XLSX = (globalThis as any).XLSX;
    if (!XLSX) throw new Error('xlsx unavailable');
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheets = (book.SheetNames || []).map((name: string) => ({
      name,
      rows: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true }),
    }));
    return workbookToCsv(sheets);
  };

  const fileIn = el('input', {
    type: 'file',
    class: 'add-input tesco-file-input',
    id: 'tesco-file-input',
    accept: '.csv,text/csv,.xlsx,.xlsm',
    'aria-label': 'Import a Tesco Pay file',
  }) as HTMLInputElement;

  fileIn.addEventListener('change', async () => {
    const file = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!file) return;
    const workbook = /\.(xlsx|xlsm)$/i.test(file.name);
    let text: string;
    try {
      text = workbook ? await workbookText(file) : await file.text();
    } catch {
      toast(workbook
        ? 'That workbook could not be read — save it as CSV and import that.'
        : 'That file could not be read.');
      return;
    }
    const parsed = parseTescoCsv(text);
    if (parsed.error) { toast(parsed.error); return; }
    if (!parsed.shifts.length && !parsed.payslips.length) {
      toast('No shifts or tax figures found in that file.');
      return;
    }
    const counts: string[] = [];
    if (parsed.shifts.length) counts.push(`${parsed.shifts.length} shift${parsed.shifts.length > 1 ? 's' : ''}`);
    if (parsed.payslips.length) counts.push(`${parsed.payslips.length} payslip week${parsed.payslips.length > 1 ? 's' : ''}`);
    toast(`${counts.join(' and ')} read from ${file.name}`
      + (parsed.skipped ? `, ${parsed.skipped} row${parsed.skipped > 1 ? 's' : ''} skipped` : '')
      + '. Importing adds them to what is already stored.');
    importTesco(ctx, parsed.shifts, parsed.payslips, parsed.weekNos);
  });

  const exportBtn = el('button', {
    type: 'button', class: 'btn btn-ghost',
    onClick: () => {
      const state = tescoState(ctx);
      if (!state.shifts.length) { toast('No shifts to export yet.'); return; }
      downloadText(`tesco-pay-${todayIso()}.csv`, tescoCsv(state.shifts, state.payslips, state.rates, state.weekNos), 'text/csv');
      toast(`Exported ${state.shifts.length} shift${state.shifts.length > 1 ? 's' : ''} — the workbook's columns.`);
    },
  }, 'Export CSV');

  return el('div', { class: 'card tesco-card' },
    el('div', { class: 'eyebrow' }, 'Import / export'),
    el('div', { class: 'add-actions' },
      exportBtn,
    ),
    // The file input is VISIBLE rather than hidden behind a button: the served
    // app runs under `style-src 'self'`, so it cannot carry the `display:none`
    // the shipping app used, and a visible control is the accessible one.
    el('div', { class: 'tesco-file-row' },
      el('label', { class: 'add-label', for: 'tesco-file-input' }, 'Import a file'),
      fileIn,
    ),
    el('p', { class: 'muted tesco-card-note' },
      'CSV or the workbook itself (.xlsx), in the sheet\'s own columns: one row per shift, newest first, each week\'s figures on its first row. A workbook\'s sheets are read as they are — the tax table may sit above or below the shifts.'),
  );
}

/** Add a parsed file to what is already stored, with the duplicates dropped. */
export function importTesco(
  ctx: ScreenContext,
  shiftRows: any[],
  slipRows: any[],
  weekNos: Record<string, number>,
): void {
  const before = { shifts: tescoState(ctx).shifts, payslips: tescoState(ctx).payslips };
  const beforeWeekNos = { ...tescoState(ctx).weekNos };
  const seenShifts = new Set(before.shifts.map(shiftKey));
  const seenSlips = new Set(before.payslips.map((p) => String(p.weekStart)));
  const addedShifts = freshShifts(shiftRows, seenShifts);
  const addedSlips = freshSlips(slipRows, seenSlips);
  if (!addedShifts.length && !addedSlips.length) {
    toast('Everything in that file is already stored.');
    return;
  }
  writeTesco(ctx, [...before.shifts, ...addedShifts], [...before.payslips, ...addedSlips]);
  const settings: any = (ctx.state as any).settings;
  settings.tescoWeekNos = { ...beforeWeekNos, ...(weekNos || {}) };
  (ctx.state as any).settings = settings;
  const step = trackAction(ctx.save, {
    label: 'Imported Tesco Pay rows',
    undo: () => {
      writeTesco(ctx, before.shifts, before.payslips);
      settings.tescoWeekNos = beforeWeekNos;
      ctx.save();
    },
  });
  const n = addedShifts.length + addedSlips.length;
  toast(`Imported ${n} row${n === 1 ? '' : 's'}.`, { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
  ctx.refresh();
}

/* ── a shift row's own actions ────────────────────────────────────────────── */

export function buildShiftActions(ctx: ScreenContext, shift: TescoShift): HTMLElement {
  const edit = el('button', {
    type: 'button', class: 'btn-link', 'aria-label': `Edit shift on ${shift.date}`,
    onClick: () => openShiftEditor(ctx, shift),
  }, 'Edit');
  const remove = el('button', {
    type: 'button', class: 'btn-link', 'aria-label': `Delete shift on ${shift.date}`,
    onClick: () => {
      const state = tescoState(ctx);
      const before = { shifts: state.shifts, payslips: state.payslips };
      const deleted = before.shifts.filter((s) => s.id === shift.id);
      const tesco: any = (ctx.state as any).tesco;
      const tombstones = Array.isArray(tesco.deletedShiftIds) ? tesco.deletedShiftIds : [];
      tesco.deletedShiftIds = [...new Set([...tombstones, String(shift.id)])];
      writeTesco(ctx, before.shifts.filter((s) => s.id !== shift.id), before.payslips);
      const step = trackAction(ctx.save, {
        label: 'Delete shift',
        undo: () => {
          writeTesco(ctx, before.shifts, before.payslips);
          const t: any = (ctx.state as any).tesco;
          t.deletedShiftIds = (Array.isArray(t.deletedShiftIds) ? t.deletedShiftIds : [])
            .filter((id: string) => id !== String(shift.id));
          ctx.save();
        },
      });
      void deleted;
      toast('Shift deleted.', { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
      ctx.refresh();
    },
  }, 'Delete');
  return el('span', { class: 'tesco-row-actions' }, edit, remove);
}

/** The shift editor: the same rules an import applies, so a hand edit can
 *  never write a row the importer would have refused. */
export function openShiftEditor(ctx: ScreenContext, shift: TescoShift): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'tesco-shift-editor' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card' });
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const dateField = el('input', { type: 'date', class: 'add-input', value: String(shift.date || ''), 'aria-label': 'Shift date' }) as HTMLInputElement;
  const startField = el('input', { type: 'text', class: 'add-input', value: String(shift.start || ''), 'aria-label': 'Start time', autocomplete: 'off' }) as HTMLInputElement;
  const endField = el('input', { type: 'text', class: 'add-input', value: String(shift.end || ''), 'aria-label': 'End time', autocomplete: 'off' }) as HTMLInputElement;
  const hoursField = el('input', { type: 'text', class: 'add-input', value: shift.hours == null ? '' : String(shift.hours), 'aria-label': 'Hours of pay', autocomplete: 'off' }) as HTMLInputElement;
  const grossField = el('input', { type: 'text', class: 'add-input', inputmode: 'decimal', value: shift.gross == null ? '' : String(shift.gross), 'aria-label': 'Pay for this shift', autocomplete: 'off' }) as HTMLInputElement;
  const specialField = el('input', { type: 'checkbox', class: 'add-check', 'aria-label': 'Special rate' }) as HTMLInputElement;
  specialField.checked = !!shift.special;

  const close = (): void => { dialog.close(); };
  dialog.addEventListener('close', () => { dialog.remove(); ctx.refresh(); });

  const save = (): void => {
    const state = tescoState(ctx);
    const others = state.shifts
      .filter((s) => s.id !== shift.id)
      .map(shiftKey);
    const result = applyShiftEdit(shift, {
      date: dateField.value,
      start: startField.value.trim(),
      end: endField.value.trim(),
      hours: hoursField.value.trim(),
      gross: grossField.value.trim(),
      special: specialField.checked,
    }, others);
    if (result.ok === false) {
      status.textContent = result.error;
      status.className = 'add-status is-error';
      return;
    }
    const before = { shifts: state.shifts, payslips: state.payslips };
    writeTesco(ctx, before.shifts.map((s) => (s.id === shift.id ? result.shift : s)), before.payslips);
    const step = trackAction(ctx.save, {
      label: 'Edit shift',
      undo: () => { writeTesco(ctx, before.shifts, before.payslips); ctx.save(); },
    });
    toast('Shift saved.', { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
    close();
  };

  card.append(
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Edit shift'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close the shift editor', onClick: close }, 'Close'),
    ),
    el('div', { class: 'add-row' }, dateField),
    el('div', { class: 'add-row' }, startField, endField),
    el('div', { class: 'add-row' }, hoursField, grossField),
    el('div', { class: 'add-row' }, el('label', { class: 'add-check-row' }, specialField, 'Special rate')),
    status,
    el('div', { class: 'add-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save shift'),
    ),
  );
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}

/* ── a payslip row's own actions ──────────────────────────────────────────── */

export function buildPayslipActions(ctx: ScreenContext, payslip: TescoPayslip): HTMLElement {
  return el('span', { class: 'tesco-row-actions' },
    el('button', {
      type: 'button', class: 'btn-link', 'aria-label': `Delete payslip for ${payslip.weekStart}`,
      onClick: () => {
        const state = tescoState(ctx);
        const before = { shifts: state.shifts, payslips: state.payslips };
        const tesco: any = (ctx.state as any).tesco;
        const tombstones = Array.isArray(tesco.deletedPayslipIds) ? tesco.deletedPayslipIds : [];
        tesco.deletedPayslipIds = [...new Set([...tombstones, String(payslip.id)])];
        writeTesco(ctx, before.shifts, before.payslips.filter((p) => p.id !== payslip.id));
        const step = trackAction(ctx.save, {
          label: 'Delete payslip',
          undo: () => {
            writeTesco(ctx, before.shifts, before.payslips);
            const t: any = (ctx.state as any).tesco;
            t.deletedPayslipIds = (Array.isArray(t.deletedPayslipIds) ? t.deletedPayslipIds : [])
              .filter((id: string) => id !== String(payslip.id));
            ctx.save();
          },
        });
        toast('Payslip deleted.', { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
        ctx.refresh();
      },
    }, 'Delete'),
  );
}

/** The week's own net, typed off a bank statement. It is never derived:
 *  holiday pay, a refund or a correction are all reasons it disagrees with
 *  gross − tax, so a derived figure would quietly overwrite the user's. */
export function buildBankPayEditor(ctx: ScreenContext, weekStart: string): HTMLElement {
  const state = tescoState(ctx);
  const week = state.shifts.find((s) => weekStartOf(s.date) === weekStart);
  const existing = state.payslips.find((p) => p.weekStart === weekStart);
  const input = el('input', {
    type: 'text', class: 'add-input', inputmode: 'decimal', autocomplete: 'off',
    value: existing && existing.bankPay != null ? String(existing.bankPay) : '',
    'aria-label': `Final bank pay for the week of ${weekStart}`,
  }) as HTMLInputElement;
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const save = (): void => {
    const raw = input.value.trim();
    const before = { shifts: state.shifts, payslips: state.payslips };
    const amount = raw === '' ? null : Number(raw);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      status.textContent = 'The bank pay should be a number of euros, or blank for "not known".';
      status.className = 'add-status is-error';
      return;
    }
    const slips = [...before.payslips];
    const at = slips.findIndex((p) => p.weekStart === weekStart);
    if (at === -1) {
      if (amount == null) { status.textContent = 'There is no payslip for that week yet.'; status.className = 'add-status is-error'; return; }
      slips.push(storedPayslip({
        weekStart, paye: 0, usc: 0, prsi: 0, futureFund: 0, bankPay: amount,
      }, uid(), new Date().toISOString()));
    } else {
      const next = { ...slips[at] };
      if (amount == null) delete next.bankPay; else next.bankPay = r2(amount);
      slips[at] = next;
    }
    writeTesco(ctx, before.shifts, slips);
    const step = trackAction(ctx.save, {
      label: 'Set the week\'s bank pay',
      undo: () => { writeTesco(ctx, before.shifts, before.payslips); ctx.save(); },
    });
    status.textContent = 'Saved.';
    status.className = 'add-status';
    toast('Bank pay saved.', { label: 'Undo', run: () => { step.undo(); ctx.refresh(); } });
    ctx.refresh();
  };

  void week;
  return el('div', { class: 'tesco-bankpay' },
    el('label', { class: 'add-label' }, 'Final bank pay'),
    input,
    el('button', { type: 'button', class: 'btn btn-ghost', onClick: save }, 'Save'),
    status,
  );
}

/** The week's tax estimate, from the engine — never typed, never stored. */
export function weekTaxEstimate(weekGross: number, rates: any): { tax: number; pension: number; net: number } {
  return simulateTax(weekGross, rates);
}

/* ── the ledger's side of a Tesco recording ────────────────────────────────── */

/** A line the USER filled, marked as theirs.
 *
 *  The recorder writes `Tesco pay` lines too, and it must never touch one the
 *  user typed: a figure they entered is their reading of what landed, not this
 *  app's. The tag travels with the line through a merge — it is per-key
 *  last-write-wins on the date — so a device that never saw the fill still
 *  knows the line is not the recorder's. */
export function withTescoFillMark(
  marks: Record<string, any>,
  dateStr: string,
  id: string,
  amount: number,
): Record<string, any> {
  return { ...(marks || {}), [dateStr]: { id, amount, by: 'fill' } };
}

/** The lines THIS APP wrote, and not the user's. The repair removes these and
 *  the menu row counts them, and both promise "not by you" — so a fill the user
 *  made has to stay out of it even though it is in the very same record. */
export function appWrittenTescoLines(state: any): any[] {
  const marks = (state?.settings?.tescoPayLedger || {}) as Record<string, any>;
  const ids = new Set(Object.values(marks)
    .filter((m: any) => m && m.by !== 'fill')
    .map((m: any) => m.id)
    .filter(Boolean));
  return (state?.entries || []).filter((e: any) => ids.has(e.id));
}

/** Write the pay the tab already knows about into the ledger, so the money
 *  reaches Balances without anyone pressing Fill.
 *
 *  The rules live in `tescoPayLedgerWrites` and are pinned by
 *  `scripts/test-tesco.mjs`: create only where the ledger is silent, follow the
 *  recorded figure while the line is still the one this app wrote, and never
 *  bring a deleted line back. What is here is the WRITE itself — one entry per
 *  pay date, `Tesco pay` on `TESCO_PAY_METHOD` (the bank the payslip pays
 *  into, not the Tesco card) and category misc, exactly the shape Fill has
 *  always written.
 *
 *  Answers `{ undo, note }` for the caller to fold into its own action, or null
 *  when the recording told the ledger nothing new. Nothing here calls
 *  `trackAction`: the caller owns that, and two actions must not be stacked. */
export function recordTescoPayToLedger(ctx: ScreenContext): { undo: () => void; note: string } | null {
  const state = tescoState(ctx);
  const settings: any = (ctx.state as any).settings || {};
  const recorded = receivedByPayDate(state.shifts, state.payslips, state.rates, today());
  const marks = (settings.tescoPayLedger || {}) as Record<string, any>;
  // The window a CREATE may fall in — this month, up to today — which is the set
  // of Thursdays the tracker card lists and offers to fill. Older pay dates are
  // history the user manages with Fill, and an unbounded catch-up here is what
  // turned a hand-managed balance into a year of back pay in one recording.
  const plan = tescoPayLedgerWrites(recorded, (ctx.state as any).entries, marks, tescoPayWriteWindow(today()));
  if (!plan.create.length && !plan.update.length) return null;

  const wasMarks = { ...marks };
  const wasAmounts: Array<[string, number]> = [];
  const nextMarks = { ...marks };
  const created: any[] = [];
  const entries = ((ctx.state as any).entries || []) as any[];

  for (const write of plan.create) {
    const entry = {
      id: uid(), createdAt: new Date().toISOString(), date: write.date, type: 'credit',
      category: 'misc', details: 'Tesco pay', amount: write.amount, method: TESCO_PAY_METHOD, note: '',
    };
    entries.push(entry);
    created.push(entry);
    nextMarks[write.date] = { id: entry.id, amount: write.amount };
  }
  const updated: any[] = [];
  for (const write of plan.update) {
    const entry = entries.find((e) => e.id === write.id);
    if (!entry) continue;
    wasAmounts.push([entry.id, entry.amount]);
    entry.amount = write.amount;
    updated.push(entry);
    nextMarks[write.date] = { id: write.id, amount: write.amount };
  }
  settings.tescoPayLedger = nextMarks;
  (ctx.state as any).settings = settings;
  (ctx.state as any).entries = entries;
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  ctx.save();

  const undo = (): void => {
    const gone = new Set(created.map((e) => e.id));
    (ctx.state as any).entries = ((ctx.state as any).entries || []).filter((e: any) => !gone.has(e.id));
    for (const [id, amount] of wasAmounts) {
      const entry = ((ctx.state as any).entries || []).find((e: any) => e.id === id);
      if (entry) entry.amount = amount;
    }
    settings.tescoPayLedger = wasMarks;
    ctx.save();
  };
  const note = created.length
    ? `Updated ${fmt(created.reduce((sum, e) => sum + (Number(e.amount) || 0), 0))} to Balances.`
    : `Updated ${updated.length} recorded pay${updated.length === 1 ? '' : 's'}.`;
  return { undo, note };
}

/** Write ONE pay date into the ledger, the way the Fill button has always
 *  done it: the figure the tab already knows for that Thursday, marked as the
 *  USER's own line so the recorder leaves it alone. */
export function fillTescoPayDate(ctx: ScreenContext, dateStr: string): { ok: boolean; note?: string } {
  const state = tescoState(ctx);
  const settings: any = (ctx.state as any).settings || {};
  const recorded = receivedByPayDate(state.shifts, state.payslips, state.rates, today());
  const known = recorded[dateStr];
  if (!known || !(Number(known.amount) > 0)) {
    return { ok: false, note: 'That week has no recorded pay to put in the ledger.' };
  }
  const entries = ((ctx.state as any).entries || []) as any[];
  const entry = {
    id: uid(), createdAt: new Date().toISOString(), date: dateStr, type: 'credit',
    category: 'misc', details: 'Tesco pay', amount: known.amount, method: TESCO_PAY_METHOD, note: '',
  };
  entries.push(entry);
  settings.tescoPayLedger = withTescoFillMark(settings.tescoPayLedger || {}, dateStr, entry.id, known.amount);
  (ctx.state as any).settings = settings;
  (ctx.state as any).entries = entries;
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  ctx.save();
  return { ok: true, note: `Updated ${fmt(known.amount)} to Balances.` };
}
