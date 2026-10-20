/* The Data sheet: where the ledger is, and every way to take it somewhere else.
 *
 * Ported from the `data` level of the shipping app's menu (app.js), and kept a
 * sheet rather than a route on purpose: it is a place you go to move your data,
 * not a place the app lives, and the URL contract (docs/URL_CONTRACT.md) has no
 * `#data` for that reason.
 *
 * The rules it inherits, each one a decision rather than a style:
 *   · a restore MERGES — nothing on this device is deleted, and the newest
 *     version of each entry wins (lib/sync-merge.ts, the same union the cloud
 *     path uses);
 *   · a restore is ONE undo, and the toast carries it;
 *   · an unreadable stored document is offered back as a merge when it parses
 *     and as a download when it does not — those bytes are the only copy;
 *   · the mirror line is the last verdict actually measured, and "nothing has
 *     been checked" is said out loud instead of passing for in-sync;
 *   · nothing writes a style attribute: the sheet runs under `style-src 'self'`.
 */
import { el, byId } from '../dom.ts';
import { toast } from '../toast.ts';
import { today } from '../format.ts';
import { CATEGORIES } from '../../lib/seed.ts';
import type { CentsState } from '../../lib/types.ts';
import {
  CSV_REFUSAL,
  MAX_BACKUP_BYTES,
  clearUndoJournal,
  downloadText,
  exportEntriesCsv,
  exportJSON,
  parseBackup,
  parseEntriesCsv,
  readStateText,
  resetToBlank,
  saveState,
  unreadableBackup,
  validateState,
} from '../../lib/storage.ts';
import { getSyncSettings } from '../../lib/settings.ts';
import { mirrorStatus, syncCheckMirror, syncStatus } from '../../lib/sync.ts';
import { categoryLabel, everyMethod, methodLabel } from '../metrics.ts';
import {
  BACKUP_REFUSAL,
  formatBytes,
  applyRestore,
  documentBytes,
  entryCountLabel,
  planRestore,
  storageLabel,
} from '../data-report.ts';
import { openBankStatement } from './bank-statement.ts';
import type { ScreenContext } from './context.ts';

/** Ask one question and resolve the answer. A nested <dialog> sits in the top
 *  layer above the sheet, which is what keeps a destructive confirmation in
 *  front of the thing it is asking about. */
function confirmSheet(title: string, body: string, confirmText: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'history-dialog' }) as HTMLDialogElement;
    const done = (answer: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    dialog.append(el('div', { class: 'history-dialog-card' },
      el('div', { class: 'add-card-head' }, el('span', { class: 'eyebrow' }, title)),
      el('p', { class: 'data-confirm-text' }, body),
      el('div', { class: 'add-actions' },
        el('button', {
          type: 'button',
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          onClick: () => done(true),
        }, confirmText),
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => done(false) }, 'Cancel'),
      ),
    ));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); done(false); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** One hidden input per picker kind, reused: picking the same file twice has to
 *  fire again, so the value is cleared before every open. */
function pickFile(accept: string, label: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, class: 'data-file', 'aria-label': label });
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null), { once: true });
    // A cancelled picker fires no change event in every browser; the input is
    // removed with the sheet, and a second pick simply makes a fresh one.
    document.body.append(input);
    input.click();
  });
}

/** Label → stored id, the mirror of the pair entriesCsv() is handed at export.
 *  A label that matches nothing is left as written, so a hand-edited file that
 *  already carries ids round trips too (validateEntry judges it). */
function csvResolvers(state: CentsState) {
  const allCategories = [
    ...CATEGORIES,
    ...(Array.isArray(state.settings?.customCategories) ? state.settings.customCategories : [])
      .map((category: any) => ({ id: String(category.id), label: String(category.label || category.id) })),
  ];
  const methods = everyMethod(state.settings || {});
  const find = (list: Array<{ id: string; label: string }>) => (label: string) => {
    const want = String(label).trim().toLowerCase();
    return list.find((item) => String(item.label).trim().toLowerCase() === want)?.id || null;
  };
  return { category: find(allCategories), method: find(methods) };
}

export function openDataSheet(ctx: ScreenContext): void {
  const { state, save, refresh } = ctx;
  if (byId('data-sheet')) return;

  const facts = el('div', { class: 'data-facts' });
  const message = el('p', { class: 'data-message', role: 'status', 'aria-live': 'polite' });
  const actions = el('div', { class: 'data-actions' });

  const dialog = el('dialog', { id: 'data-sheet', class: 'data-dialog', 'aria-label': 'Data' },
    el('div', { class: 'data-card' },
      el('div', { class: 'data-head' },
        el('h2', { class: 'data-title serif' }, 'Data'),
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => dialog.close() }, 'Close'),
      ),
      el('p', { class: 'data-lead muted' }, 'Your ledger lives on this device. These rows say where it is; the actions take a copy or merge one back.'),
      facts,
      message,
      actions,
    ),
  ) as HTMLDialogElement;
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);

  /** One fact row, built once and filled in place. The rows exist before the
   *  first await so the sheet is never a blank box: the entry count and the
   *  local size come from this device, and only the browser's persistence
   *  promise needs to be asked for. */
  const fact = (label: string) => {
    const value = el('span', { class: 'data-fact-value' }, '…');
    const note = el('span', { class: 'data-fact-note muted' });
    const row = el('div', { class: 'data-fact' },
      el('span', { class: 'data-fact-label' }, label), value, note,
    );
    return { row, value, note };
  };

  const entriesFact = fact('Entries');
  const sizeFact = fact('On this device');
  const syncFact = fact('Cloud sync');
  const mirrorFact = fact('GitHub mirror');
  // Everything this device can answer without asking the browser: the count,
  // the size, the sync setting and the last measured mirror verdict. The sheet
  // opens with all four already filled, and only the two questions that need an
  // await (is this storage persistent, and what does the cloud say right now)
  // refine them afterwards.
  const bytesNow = documentBytes(readStateText());
  const syncNow = syncStatus();
  const syncSettingsNow = getSyncSettings();
  // No cloud copy is answerable from settings alone, so it is said at once
  // rather than after a round trip: the common case on a local-first device.
  const cloudOff = !syncSettingsNow.enabled || !syncSettingsNow.endpoint || !syncSettingsNow.password;
  const cachedMirror = mirrorStatus(syncSettingsNow.mirror);
  entriesFact.value.textContent = entryCountLabel(state.entries.length);
  sizeFact.value.textContent = formatBytes(bytesNow);
  syncFact.value.textContent = syncNow.label;
  syncFact.note.textContent = syncNow.detail || '';
  mirrorFact.value.textContent = cloudOff ? 'No cloud copy' : cachedMirror.known ? cachedMirror.label : 'Not checked';
  mirrorFact.note.textContent = cloudOff
    ? 'Cloud sync is off on this device, so there is nothing in the cloud to mirror.'
    : cachedMirror.known ? cachedMirror.detail : 'No comparison has been made on this device yet.';
  mirrorFact.row.classList.toggle('is-gap', !cloudOff && !!cachedMirror.gap);
  facts.append(entriesFact.row, sizeFact.row, syncFact.row, mirrorFact.row);

  /* ── the facts ─────────────────────────────────────────────────────────── */

  async function paintFacts(): Promise<void> {
    const bytes = bytesNow;
    let durable: boolean | null = null;
    try {
      if (navigator.storage && typeof navigator.storage.persisted === 'function') {
        durable = await navigator.storage.persisted();
      }
    } catch { durable = null; }
    if (!dialog.isConnected) return;

    sizeFact.value.textContent = storageLabel(bytes, durable);
    sizeFact.note.textContent = durable === false
      ? 'The browser may evict this document under storage pressure. An export is the copy that survives.'
      : '';

    const sync = syncNow;
    syncFact.value.textContent = sync.label;
    syncFact.note.textContent = sync.detail || '';

    // The mirror line starts as the last measured verdict — and says so when
    // there is none, because "nothing has been checked" must never read as
    // "in sync". With no cloud copy there is nothing to ask about.
    const cached = cachedMirror;
    if (cloudOff) return;
    mirrorFact.value.textContent = cached.known ? cached.label : 'Not checked';
    mirrorFact.note.textContent = cached.known ? cached.detail : 'No comparison has been made on this device yet.';
    mirrorFact.row.classList.toggle('is-gap', !!cached.gap);
    const result = await syncCheckMirror().catch(() => ({ ok: false, reason: 'unreachable' }));
    if (!dialog.isConnected) return;
    if (!result || !(result as any).ok) {
      mirrorFact.note.textContent = `${cached.known ? cached.detail : ''} Could not compare the two copies just now.`.trim();
      return;
    }
    const live = mirrorStatus((result as any).mirror);
    mirrorFact.value.textContent = live.label;
    mirrorFact.note.textContent = live.detail;
    mirrorFact.row.classList.toggle('is-gap', !!live.gap);
  }

  /* ── taking a copy out ─────────────────────────────────────────────────── */

  const action = (label: string, note: string, run: () => void | Promise<void>, danger = false) => el('button', {
    type: 'button',
    class: `data-action${danger ? ' is-danger' : ''}`,
    onClick: () => { void run(); },
  },
  el('span', { class: 'data-action-label' }, label),
  note ? el('span', { class: 'data-action-note' }, note) : null,
  );

  /** One merge path for every file the sheet can read: plan, confirm, adopt,
   *  save, offer the undo. `entries` alone is enough for a CSV — planRestore
   *  unions whatever it is given. */
  async function mergeIn(incoming: Partial<CentsState>, source: string, confirmText: string): Promise<void> {
    const plan = planRestore(state, incoming);
    if (!plan.changed) {
      message.textContent = 'Nothing to restore: this device already has everything in that file.';
      return;
    }
    const parts: string[] = [];
    if (plan.added > 0) parts.push(`${plan.added} ${plan.added === 1 ? 'entry' : 'entries'}`);
    if (plan.addedShifts > 0) parts.push(`${plan.addedShifts} ${plan.addedShifts === 1 ? 'shift' : 'shifts'}`);
    const ok = await confirmSheet(
      'Merge this file?',
      `Add ${parts.length ? parts.join(' and ') : 'settings'} from ${source}? Nothing on this device is deleted — the newest version of each entry wins.`,
      confirmText,
    );
    if (!ok) return;

    const before = validateState(JSON.parse(JSON.stringify(state)));
    applyRestore(state, plan, incoming);
    if (!save()) {
      // The document on disk is unchanged, so the screen must not show a merge
      // that a reload will not: put the snapshot back before saying so.
      adopt(state, before);
      message.textContent = 'Could not save on this device. The file was not merged.';
      return;
    }
    // Every journal record describes the document this merge has just replaced:
    // left in place, undoing one later would re-add rows from the old ledger
    // over the merged one. The merge's own undo is this session's snapshot.
    clearUndoJournal();
    dialog.close();
    refresh();
    toast(`Merged ${parts.length ? parts.join(' and ') : 'settings'} from ${source}.`, {
      label: 'Undo',
      run: () => {
        adopt(state, before);
        saveState(state);
        refresh();
        toast('Merge undone.');
      },
    }, 8000);
  }

  async function readTextFile(file: File, refusal: string): Promise<string | null> {
    if (file.size > MAX_BACKUP_BYTES) {
      message.textContent = refusal;
      return null;
    }
    try {
      return await file.text();
    } catch {
      message.textContent = 'That file could not be read.';
      return null;
    }
  }

  async function restoreBackup(): Promise<void> {
    const file = await pickFile('.json,application/json', 'Choose a backup file');
    if (!file) return;
    const text = await readTextFile(file, BACKUP_REFUSAL['too-large']);
    if (text == null) return;
    const verdict = parseBackup(text);
    if (!verdict.ok) {
      // `strict` is off in this app's tsconfig (strictNullChecks included), so
      // the union does not narrow on `ok`; the cast is the narrowing.
      const reason = (verdict as { reason?: string }).reason || '';
      message.textContent = BACKUP_REFUSAL[reason] || 'That file could not be read as a backup.';
      return;
    }
    if (!verdict.kept) {
      message.textContent = verdict.dropped
        ? `That backup has ${verdict.dropped} entries and none of them could be read.`
        : 'That backup is empty.';
      return;
    }
    if (verdict.dropped) message.textContent = `${verdict.dropped} unreadable ${verdict.dropped === 1 ? 'entry was' : 'entries were'} skipped.`;
    await mergeIn(verdict.state as Partial<CentsState>, file.name || 'that file', 'Restore');
  }

  async function importCsv(): Promise<void> {
    const file = await pickFile('.csv,text/csv,text/plain', 'Choose a CSV file');
    if (!file) return;
    const text = await readTextFile(file, CSV_REFUSAL['too-large']);
    if (text == null) return;
    const verdict = parseEntriesCsv(text, csvResolvers(state), state.entries);
    if (!verdict.ok) {
      message.textContent = CSV_REFUSAL[verdict.reason] || 'That file could not be read as a CSV.';
      return;
    }
    if (!verdict.kept) {
      message.textContent = verdict.duplicates && !verdict.dropped
        ? `${verdict.duplicates === 1 ? 'That row is' : `Those ${verdict.duplicates} rows are`} already in your ledger.`
        : verdict.dropped
          ? `That CSV has ${verdict.dropped} ${verdict.dropped === 1 ? 'row' : 'rows'} and none of them could be read.`
          : 'That CSV has no rows under its header.';
      return;
    }
    const skipped = [
      verdict.dropped ? `${verdict.dropped} unreadable ${verdict.dropped === 1 ? 'row' : 'rows'}` : '',
      verdict.duplicates ? `${verdict.duplicates} already here` : '',
    ].filter(Boolean).join(', ');
    if (skipped) message.textContent = `Skipped ${skipped}.`;
    await mergeIn({ entries: verdict.entries }, file.name || 'that file', 'Import');
  }

  /** A document that would not open is parked by loadState rather than dropped.
   *  Offer it back: as a merge when it parses, as bytes when it does not. */
  async function recoverQuarantine(): Promise<void> {
    const raw = unreadableBackup();
    if (!raw) {
      message.textContent = 'There is no unreadable copy stored on this device.';
      return;
    }
    const verdict = parseBackup(raw);
    if (verdict.ok && verdict.kept) {
      const ok = await confirmSheet(
        'Restore the kept copy?',
        `A copy of a document this app could not read is still on this device. It holds ${verdict.kept} ${verdict.kept === 1 ? 'entry' : 'entries'}. Merge it in, or cancel and keep it where it is.`,
        'Merge it in',
      );
      if (!ok) return;
      await mergeIn(verdict.state as Partial<CentsState>, 'the kept copy', 'Merge it in');
      return;
    }
    const ok = await confirmSheet(
      'Download the kept copy?',
      'This copy cannot be read as a document, so it cannot be merged. It can be downloaded, which is the only way to keep it — a backup taken before it was damaged may still open.',
      'Download',
    );
    if (!ok) return;
    downloadText(`cents-unreadable-${today()}.json`, raw, 'application/json');
    message.textContent = 'Downloaded the kept copy.';
  }

  async function resetAll(): Promise<void> {
    const ok = await confirmSheet(
      'Reset all data?',
      'This clears every entry, balance checkpoint and setting on this device. The whole ledger can be brought back with Undo until you reload.',
      'Reset',
      true,
    );
    if (!ok) return;
    const before = validateState(JSON.parse(JSON.stringify(state)));
    const fresh = resetToBlank();
    adopt(state, fresh);
    // The reload-safe journal describes rows this reset has just removed; left
    // in place, an Undo after a reload would put them back into a document the
    // user asked to be empty.
    clearUndoJournal();
    dialog.close();
    refresh();
    toast(`All data cleared${before.entries.length ? ` — ${before.entries.length} ${before.entries.length === 1 ? 'entry' : 'entries'} can be brought back with Undo` : ''}.`, {
      label: 'Undo',
      run: () => {
        adopt(state, before);
        saveState(state);
        refresh();
        toast('Data restored.');
      },
    }, 8000);
  }

  actions.append(
    action('Export data', 'The document as JSON — what Restore reads back', () => {
      exportJSON(state);
      message.textContent = 'Exported.';
    }),
    action('Export CSV', 'One row per entry, for a spreadsheet', () => {
      exportEntriesCsv(state, { category: (id: string) => categoryLabel(state.settings, id), method: (id: string) => methodLabel(state.settings, id) });
      message.textContent = 'Exported CSV.';
    }),
    action('Restore from backup', 'Merges a .json export back in', restoreBackup),
    action('Import CSV', 'Merges a .csv export back in', importCsv),
    action('Import bank statement', 'Date, description and amount — mapped once', () => openBankStatement(ctx)),
  );
  if (unreadableBackup()) {
    actions.append(action('Recover unreadable copy', 'Kept from a document that would not open', recoverQuarantine));
  }
  actions.append(action('Reset all data', 'Clears this device — undoable until you reload', resetAll, true));

  // The size is read again after every open, not cached: a save that happened
  // while the sheet was closed must not leave a stale figure on screen.
  void paintFacts();
  dialog.showModal();
}

/** Copy every key of one document onto another, in place: the shell holds the
 *  document as a const, so a screen may only ever mutate it. */
function adopt(target: CentsState, source: CentsState): void {
  for (const key of Object.keys(target) as (keyof CentsState)[]) delete (target as any)[key];
  for (const key of Object.keys(source) as (keyof CentsState)[]) (target as any)[key] = source[key];
}
