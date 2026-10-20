/* ============================================================
   The payment methods the user owns.

   A method is not a row in a list the app may delete from: it is an id that
   entries, transfers, splits, recurring bills and the History screen all name.
   `validateEntry` DROPS an entry whose method the storage layer does not know,
   so a removal that really removed the id would delete that entry's entire
   history at the next load — a deletion that never appears as one.

   Three rules carry the whole feature, and all three exist because the obvious
   implementation eats the ledger:

   1. A method out of the pickers STAYS a valid method id. It is a tombstone
      (`settings.methodHidden`), not a removal from `customMethods`, and not a
      removal from the allowed set either. The entry that used it keeps
      validating and keeps naming the history that used it.

   2. `false` is a VALUE, not an absent key. The settings merge is a per-key
      spread — `{...older, ...newer}` — which can overwrite a key but never
      delete one. A restore written as a deletion could therefore never beat
      the other device's `true`, and the method would come back hidden on every
      sync, forever. Written as an explicit `false`, the fresher side simply
      overwrites it, in both directions. A stale `false` is harmless; a stale
      `true` would hide a method the user brought back.

   3. A picker showing an existing record keeps that record's method visible,
      even when the method has since been hidden. `formView`'s method select
      RESETS its value to the first option when the current one is not in the
      list, so an entry edited after its method was removed would have been
      silently moved to another account on save.

   The ported `app/lib/storage.ts` owns the *shape* (`normalizeMethodHidden`,
   `updateAllowedMethods`); this module owns the *rules* a screen asks.
   ============================================================ */
import { METHODS } from './seed.ts';

export interface Method {
  id: string;
  label: string;
  /** A built-in: the app shipped it. */
  builtin: boolean;
  /** Out of the pickers, but still a valid id. */
  hidden: boolean;
}

export type MethodResult =
  | { ok: true; method: Method }
  | { ok: false; error: string };

function customMethods(settings: any): Array<{ id: string; label?: string }> {
  return Array.isArray(settings?.customMethods) ? settings.customMethods : [];
}

/** The hidden flags, as a map of id → boolean. `false` is meaningful. */
export function hiddenFlags(settings: any): Record<string, boolean> {
  const raw = settings?.methodHidden;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') out[id] = value;
  }
  return out;
}

/** The document's whole catalogue: built-ins and the user's own, hidden or not.
 *  This is the list labels and validation read — never the picker list. */
export function everyMethod(settings: any): Method[] {
  const hidden = hiddenFlags(settings);
  const out: Method[] = METHODS.map((method) => ({
    id: method.id,
    label: method.label,
    builtin: true,
    hidden: hidden[method.id] === true,
  }));
  for (const method of customMethods(settings)) {
    if (!method || typeof method.id !== 'string' || !method.id) continue;
    if (out.some((existing) => existing.id.toLowerCase() === method.id.toLowerCase())) continue;
    out.push({
      id: method.id,
      label: method.label || method.id,
      builtin: false,
      hidden: hidden[method.id] === true,
    });
  }
  return out;
}

/** What a picker offers: everything that is not out of the pickers. */
export function allMethods(settings: any): Method[] {
  return everyMethod(settings).filter((method) => !method.hidden);
}

/** What a picker offers FOR AN EXISTING RECORD. The record's own method is
 *  kept in the list even when it is hidden — see rule 3 above. */
export function methodPickerIds(settings: any, selectedId?: string | null): string[] {
  const shown = allMethods(settings).map((method) => method.id);
  if (!selectedId) return shown;
  const known = everyMethod(settings).some((method) => method.id === selectedId);
  if (known && !shown.includes(selectedId)) shown.push(selectedId);
  return shown;
}

/** The methods a picker offers, as `{ id, label }` pairs. */
export function methodOptions(settings: any, selectedId?: string | null): Array<{ id: string; label: string }> {
  const ids = methodPickerIds(settings, selectedId);
  return everyMethod(settings)
    .filter((method) => ids.includes(method.id))
    .map((method) => ({ id: method.id, label: method.label }));
}

export function isMethodHidden(settings: any, id: string): boolean {
  return hiddenFlags(settings)[id] === true;
}

/** How many records name each method — entries plus recurring bills, which
 *  name one too and would lose their selection if the method went away. */
export function methodUsage(state: any): Map<string, number> {
  const usage = new Map<string, number>();
  const bump = (id: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    usage.set(id, (usage.get(id) || 0) + 1);
  };
  for (const entry of (Array.isArray(state?.entries) ? state.entries : [])) bump(entry?.method);
  for (const rule of (Array.isArray(state?.settings?.recurring) ? state.settings.recurring : [])) bump(rule?.method);
  return usage;
}

/** The id a typed name becomes: lowercase, words joined by a dash. */
export function slugForMethod(label: string): string {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Add a method the user owns.
 *
 *  Mutates `settings` in place so the caller's one `saveState` writes it, and
 *  answers with the method it added or the reason it refused. A refusal writes
 *  nothing at all — a half-added method is a method the pickers offer and the
 *  ledger does not know. */
export function addCustomMethod(settings: any, label: string, idSuffix = '000'): MethodResult {
  const raw = String(label || '').trim();
  if (!raw) return { ok: false, error: 'Enter a name for the method.' };
  if (raw.length > 40) return { ok: false, error: 'Use 40 characters or fewer.' };
  const catalogue = everyMethod(settings);
  if (catalogue.some((method) => method.label.toLowerCase() === raw.toLowerCase())) {
    return { ok: false, error: 'That method already exists.' };
  }
  let id = slugForMethod(raw) || 'method';
  if (catalogue.some((method) => method.id.toLowerCase() === id.toLowerCase())) {
    id = `${id}-${String(idSuffix).slice(-3) || '000'}`;
  }
  if (!Array.isArray(settings.customMethods)) settings.customMethods = [];
  settings.customMethods.push({ id, label: raw });
  // Offered immediately: a name the user just typed is not something a stale
  // flag for the same slug gets to keep out of the pickers. Written as an
  // explicit false, for the reason in rule 2.
  const hidden = hiddenFlags(settings);
  if (hidden[id]) settings.methodHidden = { ...hidden, [id]: false };
  return { ok: true, method: { id, label: raw, builtin: false, hidden: false } };
}

/** Take a method out of the pickers, or put it back.
 *
 *  A tombstone, never a deletion: see rule 1. The id stays valid, so the
 *  history that used it survives, and the cloud merge unions the list by id. */
export function setMethodHidden(settings: any, id: string, hidden: boolean): MethodResult {
  const known = everyMethod(settings).some((method) => method.id === id);
  if (!known) return { ok: false, error: 'That method is not in the list.' };
  const before = hiddenFlags(settings);
  // `false`, never a deleted key: a spread can overwrite a key but cannot
  // remove one, so a restore written as an absence would lose to the other
  // device's `true` on every sync.
  settings.methodHidden = { ...before, [id]: hidden === true };
  return { ok: true, method: { id, label: '', builtin: false, hidden: hidden === true } };
}
