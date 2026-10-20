/* Reconciliation checkpoints: writing, removing and the status a balance row
 * shows. The maths that READS a checkpoint lives in `src/metrics.ts`; this is
 * the write side, kept apart so a screen cannot invent a checkpoint shape.
 */
import type { CentsState } from '../lib/types.ts';
import { BALANCE_METHOD_IDS, isValidCheckpointDate } from '../lib/storage.ts';
import { today } from './format.ts';
import type { Checkpoint } from './metrics.ts';

const MAX_BALANCE = 1e9;

function store(state: CentsState): Record<string, Checkpoint[]> {
  const settings = state.settings as any;
  if (!settings.balanceCheckpoints || typeof settings.balanceCheckpoints !== 'object') settings.balanceCheckpoints = {};
  return settings.balanceCheckpoints;
}

/** Save (or replace) the balance for a method on a date. Refuses a future date,
 *  a non-finite amount and a silly one; rounds to cents like every other money
 *  write. Returns false when the value was not saved. */
export function saveCheckpoint(state: CentsState, methodId: string, date: string, balance: number): boolean {
  if (!BALANCE_METHOD_IDS.includes(methodId)) return false;
  if (!isValidCheckpointDate(date) || date > today()) return false;
  if (!Number.isFinite(+balance) || Math.abs(+balance) > MAX_BALANCE) return false;
  const points = store(state);
  const existing = Array.isArray(points[methodId]) ? points[methodId] : [];
  points[methodId] = [
    ...existing.filter((point) => point.date !== date),
    { date, at: new Date().toISOString(), balance: Math.round(balance * 100) / 100 },
  ].sort((a, b) => a.date.localeCompare(b.date));
  return true;
}

/** Remove one checkpoint, returning the record so an undo can put it back. */
export function removeCheckpoint(state: CentsState, methodId: string, date: string): Checkpoint | null {
  if (!BALANCE_METHOD_IDS.includes(methodId) || date === '1970-01-01') return null;
  const points = store(state);
  const existing = points[methodId];
  if (!Array.isArray(existing)) return null;
  const removed = existing.find((point) => point.date === date);
  if (!removed) return null;
  points[methodId] = existing.filter((point) => point.date !== date);
  return removed;
}

/** The latest checkpoint a person saved (the internal baseline does not count). */
export function userCheckpoint(state: CentsState, methodId: string, targetDate = today()): Checkpoint | null {
  const points = store(state)[methodId] || [];
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point.date === '1970-01-01') break;
    if (point.date <= targetDate) return point;
  }
  return null;
}

/** How reconciled this account is, in the words the row shows. An empty ledger
 *  reads as a step not taken yet, not as a fault. */
export function accountStatus(state: CentsState, methodId: string): { label: string; hint: string } {
  const checkpoint = userCheckpoint(state, methodId);
  if (!checkpoint) {
    return {
      label: state.entries.length ? 'Not reconciled' : 'Set a balance',
      hint: 'No end-of-day balance has been saved for this account. Reconcile it once and the app can tell your book balance from the real one.',
    };
  }
  const ageDays = Math.max(0, Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${checkpoint.date}T00:00:00Z`)) / 86400000));
  const hint = 'Days since this account\u2019s balance was checked against the real one.';
  if (ageDays === 0) return { label: 'Reconciled today', hint };
  if (ageDays <= 7) return { label: `Reconciled ${ageDays}d ago`, hint };
  return { label: 'Reconcile soon', hint };
}
