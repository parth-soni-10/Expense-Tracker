/* The Data surface's arithmetic, separated from its DOM.
 *
 * Everything a person reads on Data answers one question — where is my ledger
 * right now — and every one of those answers is a small rule: how big the
 * document is, how many rows it holds, and what a restore from a file will
 * actually add. Those rules live here, not in the sheet, so a Node guard can
 * read them (scripts/test-data-portability.mjs) and the screen cannot print a
 * number the check does not know about.
 *
 * The merge itself is not re-implemented: it is lib/sync-merge.ts's
 * `mergeStates`, which is the same newest-version-wins union the cloud path
 * uses. A restore that merged differently from a sync would be a second answer
 * to "which copy of this entry is mine".
 */
import type { CentsState, Entry } from '../lib/types.ts';
import { mergeStates } from '../lib/sync-merge.ts';
import { validateState } from '../lib/storage.ts';
import { COINS_DEFAULT, cashBalance, cashDeltaOf, coinsForAmount, computeCashTotal } from './metrics.ts';

/** Why a backup was refused, worded for a person — ported from app.js so the
 *  refusal a returning user remembers is the one they get. */
export const BACKUP_REFUSAL: Record<string, string> = {
  empty: 'That file is empty.',
  'too-large': 'That file is far too large to be one of this app\u2019s backups.',
  unreadable: 'That file is not valid JSON \u2014 it may be truncated. Try another copy.',
  'not-a-backup': 'That file is not a cents. backup: it has no list of entries.',
};

/** Bytes as the Data row prints them: never "0 B", never a fraction of a KB at
 *  the bottom of the range, one decimal at the top. */
export function formatBytes(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The document's own size in bytes, as localStorage holds it: UTF-16, so two
 *  bytes a character, measured from the text actually on disk rather than from
 *  an in-memory object that may hold edits no save has landed yet. */
export function documentBytes(text: string | null): number {
  return (typeof text === 'string' ? text.length : 0) * 2;
}

/** "1.2 MB · persistent" — the size and whether the browser has promised to
 *  keep it. `durable === null` means the platform would not say, and the row
 *  says so rather than guessing "persistent". */
export function storageLabel(bytes: number, durable: boolean | null): string {
  const kept = durable === null ? 'persistence unknown' : durable ? 'persistent' : 'best-effort';
  return `${formatBytes(bytes)} \u00b7 ${kept}`;
}

export function entryCountLabel(count: number): string {
  const n = Number.isFinite(Number(count)) ? Number(count) : 0;
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

/** A stable string for a value: object keys sorted at every level.
 *
 *  `JSON.stringify` is not a comparison here. The merge rebuilds
 *  `balanceCheckpoints` from a Set, so the same map comes back with its methods
 *  in a different order and a plain string compare calls an identical document
 *  "changed" — which would make the sheet offer a restore of a file this device
 *  already holds, every time. Key order is not content. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      // An absent field and an empty one are the same fact. The merge writes
      // `deletedEntryIds: []` into a document that never had the key, so a
      // compare that counts that as content would report every unchanged file
      // as a change (measured: the identical-document case).
      if (child === undefined || child === null) continue;
      if (Array.isArray(child) && child.length === 0) continue;
      if (typeof child === 'object' && !Array.isArray(child) && Object.keys(child as object).length === 0) continue;
      parts.push(`${JSON.stringify(key)}:${stable(child)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Rows as a comparison: identity and content, in a fixed order (the merge keeps
 *  local order and appends, so position is not content either). */
function rowKey(rows: unknown): string {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a: any, b: any) => String(a?.id || '').localeCompare(String(b?.id || '')));
  return stable(list);
}

/** What a restore of `incoming` would do to `state`, without doing it. */
export interface RestorePlan {
  merged: CentsState;
  added: number;
  addedShifts: number;
  changed: boolean;
}

/**
 * Plan a merge. Pure: it validates and unions, and touches neither the
 * document it was handed nor storage. `changed` is false when the file holds
 * nothing this device does not already have, which is the case the sheet must
 * report as "nothing to restore" instead of claiming a successful import.
 */
export function planRestore(state: CentsState, incoming: Partial<CentsState> | null): RestorePlan {
  const before = state && Array.isArray(state.entries) ? state : validateState(null);
  const merged = validateState(mergeStates(before, incoming));
  const added = merged.entries.length - before.entries.length;
  const addedShifts = (merged.tesco?.shifts?.length || 0) - (before.tesco?.shifts?.length || 0);
  const changed = added > 0 || addedShifts > 0
    || rowKey(merged.entries) !== rowKey(before.entries)
    || rowKey(merged.tesco?.shifts) !== rowKey(before.tesco?.shifts)
    || stable(merged.settings) !== stable(before.settings);
  return { merged, added, addedShifts, changed };
}

/**
 * Re-anchor the Cash balance from a restored file.
 *
 * The merge keeps THIS device's settings whenever its change stamp is newer,
 * which for a restore is the ordinary case — and that is exactly how a ledger
 * comes back with entries on Cash and a balance of €0.00: the rows arrived, the
 * figure describing them did not. Ported from app.js's `adoptBackupCash`; the
 * file's own figure wins only when this device has no cash balance to defend.
 */
export function adoptBackupCash(state: CentsState, backup: Partial<CentsState> | null): boolean {
  if (cashBalance(state.settings, state.entries) !== 0) return false;
  const bSet: any = backup && typeof backup === 'object' ? backup.settings : null;
  const bEntries: Entry[] = backup && Array.isArray(backup.entries) ? backup.entries : [];
  const fileCash = cashBalance(bSet || {}, bEntries);
  const fileDelta = bEntries.reduce((sum, entry) => sum + cashDeltaOf(entry), 0);
  const hasFileFigure = !!bSet
    && (fileCash !== 0 || bSet.coinsManual === false || Object.keys(bSet.coins || {}).length > 0);
  const localDeltas = state.entries.reduce((sum, entry) => sum + cashDeltaOf(entry), 0);
  const target = Math.round((fileCash + (localDeltas - fileDelta)) * 100) / 100;
  if (hasFileFigure) {
    if (bSet.coinsManual === false) {
      (state.settings as any).cashBase = Math.round((target - localDeltas) * 100) / 100;
      (state.settings as any).coinsManual = false;
    } else {
      (state.settings as any).coinsManual = true;
      (state.settings as any).coins = coinsForAmount(target);
    }
    return true;
  }
  if (state.entries.some((entry) => entry.method === 'Cash')) {
    // No figure in the file: follow the rows, the way app.js's cashAutoFollow
    // does — the coin count is the base and every Cash row moves it.
    const settings: any = state.settings;
    settings.cashBase = Math.round(computeCashTotal({ ...COINS_DEFAULT, ...(settings.coins || {}) }) * 100) / 100;
    settings.coinsManual = false;
    return true;
  }
  return false;
}

/** Adopt a planned merge into the document the shell holds. Returns what the
 *  caller needs to word the confirmation. */
export function applyRestore(state: CentsState, plan: RestorePlan, backup: Partial<CentsState> | null): void {
  const merged = plan.merged;
  for (const key of Object.keys(merged) as (keyof CentsState)[]) {
    (state as any)[key] = merged[key];
  }
  adoptBackupCash(state, backup);
}
