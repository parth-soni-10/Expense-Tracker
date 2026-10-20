/** The typed boundary of Cents' logic core.
 *
 *  These interfaces describe the one document in `expense-tracker:v1` and the
 *  values the ported modules exchange. They are deliberately permissive where
 *  the stored document is: a device can hold fields this build does not know
 *  about (an older or newer release wrote them), and validation must preserve
 *  what it does not need to rewrite. The named fields are the ones the ledger,
 *  the budget math and the guards actually read; the index signature is the
 *  contract that an unknown field survives a load/save round trip.
 */

export type EntryType = 'expense' | 'income' | 'transfer' | 'split' | 'adjustment' | 'load' | 'withdraw';

export interface Entry {
  id: string;
  type?: EntryType | string;
  name?: string;
  category?: string;
  amount?: number;
  method?: string;
  date?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Both sides of a transfer share this id. */
  transferId?: string;
  /** The payer of a split payment. */
  splitId?: string;
  /** A load/withdraw adjustment never enters budget math. */
  excluded?: boolean;
  /** RS and other non-spending markers. */
  nonSpend?: boolean;
  [field: string]: unknown;
}

export interface CentsSettings {
  customCategories?: Array<{ id: string; label?: string }>;
  customMethods?: Array<{ id: string; label?: string }>;
  /** `{ [methodId]: true|false }` — whether each method is out of the pickers.
   *  A flag rather than a removal, and `false` is a VALUE rather than an
   *  absent key: the settings merge is a per-key spread, which can overwrite
   *  a key but never delete one, so a restore written as a deletion could
   *  never beat the other device's `true`. */
  methodHidden?: Record<string, boolean>;
  categoryBudgets?: Record<string, number>;
  enabledTabs?: string[];
  deletedEntryIds?: string[];
  balanceCheckpoints?: Record<string, number>;
  [field: string]: unknown;
}

export interface TescoPayDocument {
  shifts?: Array<Record<string, unknown>>;
  payslips?: Array<Record<string, unknown>>;
  rates?: Record<string, unknown>;
  weekNos?: Record<string, number>;
  [field: string]: unknown;
}

/** `expense-tracker:v1` — schemaVersion 2 is the only shape this build writes. */
export interface CentsState {
  schemaVersion: number;
  entries: Entry[];
  settings: CentsSettings;
  tesco?: TescoPayDocument;
  lastLocalChangeAt?: string;
  localResetAt?: string;
  [field: string]: unknown;
}

export type BackupRefusal = 'empty' | 'too-large' | 'unreadable' | 'not-a-backup';

export type BackupResult =
  | { ok: false; reason: BackupRefusal }
  | { ok: true; state: CentsState; kept: number; dropped: number };

export interface CsvEntryResult {
  ok: boolean;
  reason?: string;
  entries?: Entry[];
  dropped?: number;
}
