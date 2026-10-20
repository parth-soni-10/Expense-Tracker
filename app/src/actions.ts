/* Undoable state changes, with the reload-safe journal.
 *
 * The shipping app's rule is that a destructive action applies immediately and
 * can be undone — including after a reload, because the toast's six seconds are
 * not the only window in which a mis-tap should be recoverable. The journal
 * itself is already ported (`app/lib/storage.ts`: a capped stack of
 * `{label, at, entries, checkpoints}` records); this module is the call site
 * every screen goes through, plus the restore half.
 *
 * Nothing here decides WHAT to remove; callers mutate the document and hand the
 * removed rows over, so the restore can put back exactly what went away.
 */
import type { CentsState, Entry } from '../lib/types.ts';
import { clearUndoJournal, loadUndoJournal, popUndoJournal, saveUndoJournal } from '../lib/storage.ts';

export interface JournalCheckpoint {
  methodId: string;
  point: { date: string; balance: number; at?: string };
}

export interface UndoStep {
  label: string;
  undo: () => void;
  /** Rows this action removed, so a reload can re-add them. */
  entries?: Entry[];
  checkpoints?: JournalCheckpoint[];
}

/** Run a change, remember how to undo it, and keep the journal record. */
export function trackAction(save: () => boolean, step: UndoStep): UndoStep {
  const entries = Array.isArray(step.entries) ? step.entries.map((entry) => ({ ...entry })) : [];
  const checkpoints = Array.isArray(step.checkpoints)
    ? step.checkpoints.map((c) => ({ methodId: c.methodId, point: { ...c.point } }))
    : [];
  save();
  if (entries.length || checkpoints.length) {
    saveUndoJournal({
      label: step.label,
      at: new Date().toISOString(),
      entries,
      checkpoints,
    });
  }
  return step;
}

/** What a journal record holds that the live document no longer has. */
export function missingJournalData(state: CentsState, journal: any): { entries: Entry[]; checkpoints: JournalCheckpoint[] } {
  const entries: Entry[] = Array.isArray(journal?.entries) ? journal.entries : [];
  const checkpoints: JournalCheckpoint[] = Array.isArray(journal?.checkpoints) ? journal.checkpoints : [];
  const live = Array.isArray(state.entries) ? state.entries : [];
  return {
    entries: entries.filter((entry) => entry && !live.some((e) => e.id === entry.id)),
    checkpoints: checkpoints.filter((c) => c && c.methodId && c.point
      && !((state.settings?.balanceCheckpoints as any)?.[c.methodId] || []).some((point: any) => point.date === c.point.date)),
  };
}

/** Put a journal record's rows back. Returns true if anything was re-added
 *  (false when the data is already there, which is what a double undo sees). */
export function restoreUndoJournal(state: CentsState, save: () => boolean, journal: any): boolean {
  const missing = missingJournalData(state, journal);
  if (missing.entries.length) {
    state.entries.push(...missing.entries);
    state.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const tombstones = Array.isArray(state.settings.deletedEntryIds) ? state.settings.deletedEntryIds : [];
    const revived = new Set(missing.entries.map((entry) => entry.id));
    state.settings.deletedEntryIds = tombstones.filter((id) => !revived.has(id));
  }
  for (const checkpoint of missing.checkpoints) {
    const settings = state.settings as any;
    if (!settings.balanceCheckpoints) settings.balanceCheckpoints = {};
    settings.balanceCheckpoints[checkpoint.methodId] = [
      ...(settings.balanceCheckpoints[checkpoint.methodId] || []).filter((point: any) => point.date !== checkpoint.point.date),
      checkpoint.point,
    ].sort((a: any, b: any) => a.date.localeCompare(b.date));
  }
  const changed = missing.entries.length > 0 || missing.checkpoints.length > 0;
  if (changed) save();
  return changed;
}

/** Delete entries and tombstone them, as one undoable batch. */
export function deleteEntries(
  state: CentsState,
  save: () => boolean,
  ids: string[],
  label: string,
): UndoStep {
  const removed = state.entries.filter((entry) => ids.includes(entry.id));
  state.entries = state.entries.filter((entry) => !ids.includes(entry.id));
  const tombstones = Array.isArray(state.settings.deletedEntryIds) ? state.settings.deletedEntryIds : [];
  state.settings.deletedEntryIds = [...new Set([...tombstones, ...ids])];
  return trackAction(save, {
    label,
    entries: removed,
    undo: () => {
      state.entries.push(...removed);
      state.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      state.settings.deletedEntryIds = (state.settings.deletedEntryIds || []).filter((id) => !ids.includes(id));
    },
  });
}

/** The most recent journal record that still has data to restore, newest
 *  first, discarding records whose rows are already back. */
export function latestUndo(state: CentsState): any | null {
  for (let guard = 0; guard < 5; guard++) {
    const journal = loadUndoJournal();
    if (!journal) return null;
    const missing = missingJournalData(state, journal);
    if (!missing.entries.length && !missing.checkpoints.length) { popUndoJournal(); continue; }
    return journal;
  }
  return null;
}

export { clearUndoJournal, popUndoJournal };
