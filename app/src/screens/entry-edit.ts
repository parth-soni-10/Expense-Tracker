/* The History row editor's one mutation, as a function a guard can run.
 *
 * The dialog needs a document and a pointer, so it cannot be executed by a Node
 * guard — but the half that decides what the ledger holds afterwards can, so it
 * lives here and `history.ts` calls it. That split is what parity line 6 was
 * missing: the ported edit wrote the new values and nothing else, while the
 * shipping editor (`app.js`, the `previousVersion` / `mutationHistory` block)
 * also keeps the version it replaced.
 *
 * The history is load-bearing, not decorative, in three places the ported core
 * already reads:
 *
 *   * `metrics.ts`'s `entryVersionAt` replays it to answer "what did this
 *     balance look like at that checkpoint", so an edit that moves an amount or
 *     a date after a reconciliation must keep the old version for the balance to
 *     stay honest;
 *   * `lib/storage.ts` refuses to keep an `updatedAt` without a matching,
 *     strictly-chronological history behind it — it deletes the stamp instead,
 *     which silently drops the row out of version ordering in a sync merge;
 *   * `lib/sync-merge.ts` orders a shared id by `updatedAt`, then the last
 *     history point, then `createdAt`.
 *
 * So the rules are the shipping app's: the stamp is strictly after the version
 * being replaced, and the replaced version carries its own date, type, category,
 * amount and method — the fields a checkpoint balance is rebuilt from.
 */
import type { Entry } from '../../lib/types.ts';
import { MAX_MUTATION_HISTORY } from '../../lib/storage.ts';
import { fmt } from '../format.ts';

export interface EntryEditInput {
  details: string;
  /** Parsed euros — NaN when the field could not be read, which is refused. */
  amount: number;
  date: string;
  category: string;
  method: string;
  note: string;
}

export interface EntryEditContext {
  /** Today's local date (`YYYY-MM-DD`), passed in so "not the future" is testable. */
  today: string;
  /** Milliseconds for the mutation stamp; the guard pins it. */
  now?: number;
}

/** A refusal carries the sentence the dialog shows; a success carries nothing.
 *  (One interface rather than a discriminated union: this project's tsconfig
 *  runs with `strict: false`, where a boolean discriminant does not narrow.) */
export interface EntryEditResult {
  ok: boolean;
  error?: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The version of an entry as it stands before an edit — the shape storage
 *  validates and `entryVersionAt` hands back while reconstructing a balance. */
export interface PreviousVersion {
  at: string;
  createdAt: string;
  date: string;
  type: string;
  category: string;
  amount: number;
  method: string;
}

const historyOf = (entry: Entry): PreviousVersion[] =>
  (Array.isArray(entry.mutationHistory) ? entry.mutationHistory as PreviousVersion[] : []);

/**
 * The stamp an edit is written with: the wall clock, but never at or before the
 * moment the entry (or its last version) already carries. Two edits inside one
 * millisecond would otherwise produce a history `validateState` rejects as
 * unordered, and it would then discard the whole history *and* the timestamp.
 */
export function mutationTimestamp(entry: Entry, now = Date.now()): string {
  const created = Date.parse(String(entry?.createdAt ?? ''));
  const latest = Date.parse(String(historyOf(entry).at(-1)?.at ?? ''));
  const next = Math.max(now, Number.isFinite(created) ? created + 1 : 0, Number.isFinite(latest) ? latest + 1 : 0);
  return new Date(next).toISOString();
}

/**
 * Apply one edit to a grouped row's entries, in place, or refuse it with the
 * message the dialog shows.
 *
 * A row is one logical payment, so an edit touches every leg: a transfer keeps
 * both legs equal (the typed amount is the group's total), a split takes the
 * difference on its first leg, and details, date, category, method and note are
 * the same on every leg. Nothing is touched on a refusal — the caller's document
 * is exactly as it was, which is what lets a guard compare it before and after.
 */
export function applyEntryEdit(entries: Entry[], input: EntryEditInput, context: EntryEditContext): EntryEditResult {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, error: 'There is no entry to update.' };

  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date > context.today) {
    return { ok: false, error: 'Pick a date that is not in the future.' };
  }

  // A split's amount is the group's total, so the first leg takes what the
  // others leave — and a total they already meet would make it zero or negative.
  const others = entries.slice(1).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const isTransfer = Boolean(entries[0].transferId);
  const isSplit = Boolean(entries[0].splitId);
  const first = isTransfer || isSplit ? null : round2(amount);
  if (isSplit && round2(amount - others) <= 0) {
    return { ok: false, error: `The other legs already total ${fmt(others)} — the first leg would be zero or less.` };
  }

  // The cap is the shipping editor's, checked before anything is written: an
  // entry whose history is full is refused, not silently rewritten.
  if (entries.some((entry) => historyOf(entry).length >= MAX_MUTATION_HISTORY)) {
    return { ok: false, error: 'This entry has reached the maximum edit history. Duplicate it as a new entry instead.' };
  }

  const details = String(input.details ?? '').trim() || 'Entry';
  const note = String(input.note ?? '').trim();
  const now = context.now ?? Date.now();

  for (const entry of entries) {
    const at = mutationTimestamp(entry, now);
    entry.mutationHistory = [...historyOf(entry), {
      at,
      // Storage only keeps a point whose creation moment is the entry's own, so
      // this is the entry's stamp and not the moment of the edit.
      createdAt: String(entry.createdAt ?? ''),
      date: String(entry.date ?? ''),
      type: String(entry.type ?? 'expense'),
      category: String(entry.category ?? ''),
      amount: Number(entry.amount) || 0,
      method: String(entry.method ?? ''),
    }];
    entry.updatedAt = at;
    entry.details = details;
    entry.category = input.category;
    entry.date = input.date;
    entry.note = note;
    entry.method = input.method;
    if (isTransfer) entry.amount = round2(amount);
  }

  if (isSplit) entries[0].amount = round2(amount - others);
  if (first !== null) entries[0].amount = first;

  return { ok: true };
}
