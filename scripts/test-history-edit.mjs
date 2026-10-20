#!/usr/bin/env node
/**
 * The History edit path (parity line 6).
 *
 * Line 6 asks that "entry types, transfers, split payments, edits, dates,
 * categories, methods, and notes preserve existing ledger semantics". The first
 * three were pinned by `test-parity-money.mjs`; the edit path was not, and the
 * shipping app's editor does more than write new values — it records the version
 * it replaced in `mutationHistory`. Three modules in the ported core read that
 * history back:
 *
 *   * `metrics.ts` replays it to answer "what did this balance look like at that
 *     checkpoint" — the check below edits an amount *after* a reconciliation and
 *     asserts the balance still moves by the difference, not by nothing;
 *   * `lib/storage.ts` refuses to keep an `updatedAt` without a matching,
 *     strictly-chronological history, and deletes the stamp when it does not
 *     match — which drops the row out of sync ordering;
 *   * `lib/sync-merge.ts` orders a shared id by `updatedAt` then that history.
 *
 * So this guard drives the real function the dialog calls
 * (`app/src/screens/entry-edit.ts`), and asserts what a person would notice:
 * every field the edit form offers actually changes, a refusal changes nothing,
 * a grouped row stays one payment, the replaced version is recorded exactly, and
 * the edited document survives storage and a merge as the newer version.
 *
 * Run: node scripts/test-history-edit.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { readFileSync } from 'node:fs';

class MemoryStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const { applyEntryEdit, mutationTimestamp } = await import('../app/src/screens/entry-edit.ts');
const { groupEntries } = await import('../app/src/screens/history.ts');
const { loadState, saveState, validateState, MAX_MUTATION_HISTORY } = await import('../app/lib/storage.ts');
const { balanceAtForEntries, checkpointsFor } = await import('../app/src/metrics.ts');
const { mergeStates } = await import('../app/lib/sync-merge.ts');

const TODAY = '2026-10-20';
// Pinned, and in the past relative to any real run: `validateState` discards a
// mutation stamp from the future, so a fixture that pinned "next year" would be
// testing the validator's refusal rather than the edit.
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const CREATED = '2026-10-05T09:00:00.000Z';

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else failures.push(name + (detail ? ` - ${detail}` : ''));
};
const equal = (name, actual, expected) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expected),
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const sameDoc = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const entry = (over = {}) => ({
  id: 'e1',
  type: 'expense',
  date: '2026-10-05',
  amount: 10,
  method: 'AIB',
  category: 'gro',
  details: 'Lidl',
  note: '',
  createdAt: CREATED,
  ...over,
});
const edit = (over = {}) => ({
  details: 'Aldi',
  amount: 12.34,
  date: '2026-10-06',
  category: 'travel',
  method: 'Revolut',
  note: 'weekly shop',
  ...over,
});
const apply = (entries, input = {}, context = {}) => applyEntryEdit(entries, edit(input), { today: TODAY, now: NOW, ...context });

/* ── 1. an ordinary edit changes everything the form offers ─────────────────── */

{
  const one = entry({ budgetExcluded: true, customFlag: 'kept' });
  const before = clone(one);
  const result = apply([one]);
  check('a plain edit is accepted', result.ok === true, result.error);
  equal('details are written, trimmed', one.details, 'Aldi');
  equal('the date is written', one.date, '2026-10-06');
  equal('the category id is written', one.category, 'travel');
  equal('the method id is written', one.method, 'Revolut');
  equal('the note is written, trimmed', one.note, 'weekly shop');
  equal('the amount is written', one.amount, 12.34);
  equal('the type is untouched', one.type, 'expense');
  equal('the id is untouched', one.id, 'e1');
  equal('createdAt is untouched', one.createdAt, CREATED);
  equal('budgetExcluded survives the edit', one.budgetExcluded, true);
  equal('a field this build does not know survives it too', one.customFlag, 'kept');
  check('updatedAt is stamped after createdAt', Date.parse(one.updatedAt) > Date.parse(CREATED), one.updatedAt);
  equal('the stamp is the moment the guard pinned', one.updatedAt, new Date(NOW).toISOString());
  equal('one replaced version is recorded', (one.mutationHistory || []).length, 1);
  equal('and it is the version that was replaced', (one.mutationHistory || [])[0], {
    at: new Date(NOW).toISOString(),
    createdAt: CREATED,
    date: before.date,
    type: before.type,
    category: before.category,
    amount: before.amount,
    method: before.method,
  });
}

/* ── 2. what the form refuses, and that a refusal writes nothing ───────────── */

{
  const cases = [
    ['a zero amount', { amount: 0 }, 'Enter an amount greater than zero.'],
    ['a negative amount', { amount: -4 }, 'Enter an amount greater than zero.'],
    ['an unreadable amount', { amount: Number.NaN }, 'Enter an amount greater than zero.'],
    ['a future date', { date: '2026-10-21' }, 'Pick a date that is not in the future.'],
    ['a date that is not a date', { date: '06/10/2026' }, 'Pick a date that is not in the future.'],
  ];
  for (const [label, input, message] of cases) {
    const one = entry();
    const before = clone(one);
    const result = apply([one], input);
    check(`${label} is refused`, result.ok === false);
    equal(`${label} refusal says why`, result.error, message);
    check(`${label} leaves the entry exactly as it was`, sameDoc(one, before));
  }
  const one = entry();
  const result = apply([one], { date: TODAY });
  check('today is not "the future"', result.ok === true, result.error);
  equal('and the date is written', one.date, TODAY);
  const blank = entry({ details: '  ' });
  apply([blank], { details: '   ' });
  equal('a blank description falls back to a word, not an empty row', blank.details, 'Entry');
  const padded = entry();
  apply([padded], { note: '  padded  ' });
  equal('a note is stored trimmed', padded.note, 'padded');
}

/* ── 3. a split row is one payment: the total is split across its legs ──────── */

{
  const legs = [
    entry({ id: 's1', splitId: 'sp1', amount: 30, method: 'AIB', details: 'Tesco' }),
    entry({ id: 's2', splitId: 'sp1', amount: 20, method: 'TG', details: 'Tesco' }),
  ];
  const result = apply(legs, { amount: 50, details: 'Tesco run', date: '2026-10-07', category: 'gro', method: 'AIB' });
  check('a split edit is accepted', result.ok === true, result.error);
  equal('the first leg takes the difference', legs[0].amount, 30);
  equal('the other legs keep their amounts', legs[1].amount, 20);
  equal('the row still sums to the typed total', Math.round((legs[0].amount + legs[1].amount) * 100) / 100, 50);
  equal('every leg carries the same description', [legs[0].details, legs[1].details], ['Tesco run', 'Tesco run']);
  equal('every leg carries the new date', [legs[0].date, legs[1].date], ['2026-10-07', '2026-10-07']);
  equal('both legs record their own replaced version', [(legs[0].mutationHistory || []).length, (legs[1].mutationHistory || []).length], [1, 1]);
  equal('and the second leg\u2019s records what it was (a gift-card leg at 20)', (legs[1].mutationHistory || [])[0]?.amount, 20);
  equal('the row is still one row', groupEntries(legs).length, 1);

  // An edit that would leave the first leg at zero is refused, and the message
  // names the money rather than the rule.
  const short = [
    entry({ id: 't1', splitId: 'sp2', amount: 30 }),
    entry({ id: 't2', splitId: 'sp2', amount: 20 }),
  ];
  const before = clone(short);
  const refused = apply(short, { amount: 20 });
  check('a split total that the other legs already meet is refused', refused.ok === false);
  equal('and the refusal names the other legs total', refused.error, 'The other legs already total €20.00 — the first leg would be zero or less.');
  equal('a refused split changes nothing', short, before);
}

/* ── 4. a transfer stays a transfer: both legs move together ────────────────── */

{
  const legs = [
    entry({ id: 't1', transferId: 'tr1', amount: 50, method: 'AIB', details: 'To Revolut' }),
    entry({ id: 't2', transferId: 'tr1', type: 'credit', amount: 50, method: 'Revolut', details: 'To Revolut' }),
  ];
  const result = apply(legs, { amount: 75, details: 'Moved to Revolut', category: 'misc', method: 'AIB' });
  check('a transfer edit is accepted', result.ok === true, result.error);
  equal('both legs take the typed amount', [legs[0].amount, legs[1].amount], [75, 75]);
  equal('both legs keep the transfer id', [legs[0].transferId, legs[1].transferId], ['tr1', 'tr1']);
  equal('both legs carry the new description', [legs[0].details, legs[1].details], ['Moved to Revolut', 'Moved to Revolut']);
  equal('both legs are stamped', [typeof legs[0].updatedAt, typeof legs[1].updatedAt], ['string', 'string']);
  equal('every leg keeps its own replaced version', [(legs[0].mutationHistory || [])[0]?.amount, (legs[1].mutationHistory || [])[0]?.amount], [50, 50]);
  equal('the row is still one transfer row', groupEntries(legs)[0].type, 'transfer');
}

/* ── 5. the history cap refuses instead of silently rewriting ──────────────── */

{
  const full = entry({
    mutationHistory: Array.from({ length: MAX_MUTATION_HISTORY }, (_, i) => ({
      at: new Date(Date.parse(CREATED) + i + 1).toISOString(),
      createdAt: CREATED,
      date: '2026-10-05',
      type: 'expense',
      category: 'gro',
      amount: 10,
      method: 'AIB',
    })),
    updatedAt: new Date(Date.parse(CREATED) + MAX_MUTATION_HISTORY).toISOString(),
  });
  const before = clone(full);
  const result = apply([full]);
  check('a full edit history is refused', result.ok === false);
  equal('the refusal explains what to do instead', result.error,
    'This entry has reached the maximum edit history. Duplicate it as a new entry instead.');
  check('and nothing is written', sameDoc(full, before));
  equal('and no version is appended', (full.mutationHistory || []).length, (before.mutationHistory || []).length);
}

/* ── 6. two edits in the same millisecond still make a valid history ───────── */

{
  const one = entry();
  apply([one], { amount: 11 });
  const first = one.updatedAt;
  apply([one], { amount: 12 });
  check('the second stamp is strictly later than the first', Date.parse(one.updatedAt) > Date.parse(first),
    `${first} then ${one.updatedAt}`);
  equal('both versions are kept, oldest first', (one.mutationHistory || []).length, 2);
  check('and the history is chronological', Date.parse((one.mutationHistory || [])[1]?.at) > Date.parse((one.mutationHistory || [])[0]?.at));
  equal('the newest version is the one the entry now shows', one.amount, 12);
  equal('mutationTimestamp of an untouched entry is after its createdAt',
    Date.parse(mutationTimestamp(entry(), NOW)) > Date.parse(CREATED), true);
}

/* ── 7. the edited document survives storage, and is the newer version ─────── */

{
  const one = entry();
  apply([one]);
  const state = { schemaVersion: 2, entries: [one], settings: {} };
  check('the document saves', saveState(state) === true);
  const loaded = loadState();
  equal('the edited row is still there after a reload', loaded.entries.length, 1);
  equal('with the edited amount', loaded.entries[0]?.amount, 12.34);
  equal('and the edit stamp is kept, not discarded as detached', loaded.entries[0]?.updatedAt, new Date(NOW).toISOString());
  equal('with its replaced version', (loaded.entries[0]?.mutationHistory || []).length, 1);
  equal('and that version is unchanged by the round trip', (loaded.entries[0]?.mutationHistory || [])[0]?.amount, 10);

  // A merge with the pre-edit copy: the edited row is the one that survives.
  const cloudCopy = { schemaVersion: 2, entries: [entry({ amount: 999 })], settings: {} };
  const merged = mergeStates(state, cloudCopy);
  equal('a merge keeps the edited row, not the older copy', merged.entries[0]?.amount, 12.34);
  equal('the merge does not duplicate the row', merged.entries.length, 1);
}

/* ── 8. a checkpoint balance stays honest after an edit ───────────────────── */

{
  // The account held €100 on 10 Oct, with the €10 shop already counted. On 20 Oct
  // the shop is corrected to €50: the true balance is €60 (100 − 40 more left).
  const checkpoints = { AIB: [{ date: '2026-10-10', balance: 100, at: '2026-10-10T20:00:00.000Z' }] };
  const shop = entry({ date: '2026-10-05', amount: 10, method: 'AIB' });
  apply([shop], { amount: 50, date: '2026-10-05', method: 'AIB', category: 'gro' });
  const settings = { balanceCheckpoints: checkpoints };
  const withHistory = balanceAtForEntries([shop], 'AIB', '2026-10-12', checkpointsFor(settings));
  equal('the balance moves by the difference the edit made, not by the new amount', withHistory, 60);

  // What the same document reports with no history to replay: the edit is
  // invisible to the checkpoint, which is why the history is not optional.
  const stripped = entry({ date: '2026-10-05', amount: 50, method: 'AIB', updatedAt: shop.updatedAt });
  equal('without the history the edit would vanish from that balance',
    balanceAtForEntries([stripped], 'AIB', '2026-10-12', checkpointsFor(settings)), 100);

  // ... and for a date after the edit, the ledger's own figures already agree.
  const plain = entry({ date: '2026-10-05', amount: 50, method: 'AIB' });
  const baseline = { balanceCheckpoints: { AIB: [{ date: '1970-01-01', balance: 100 }] } };
  equal('a checkpoint with no later edit reports the plain ledger figure',
    balanceAtForEntries([plain], 'AIB', '2026-10-12', checkpointsFor(baseline)), 50);
}

/* ── 9. the shipping editor still records the same two fields ─────────────── */

{
  // Parity means the port reproduces the app being replaced. If the shipping
  // editor ever stops keeping the replaced version, the history this guard
  // asserts would be a port of nothing.
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  check('the shipping editor still builds a previousVersion', source.includes('const previousVersion = initial ? {'));
  check('and still appends it to mutationHistory',
    source.includes('mutationHistory: [...(Array.isArray(initial.mutationHistory) ? initial.mutationHistory : []), previousVersion]'));
  check('with the same cap the port uses', source.includes('const MAX_MUTATION_HISTORY = 1000;'));
}

/* ── report ────────────────────────────────────────────────────────────────── */

if (failures.length) {
  console.error(`test-history-edit: ${failures.length} failure(s) of ${pass + failures.length} checks:`);
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log(`test-history-edit: OK — ${pass} checks passed (an edit writes every field the form offers and records the version it replaced, refuses what the form refuses without touching the document, keeps a grouped row whole, survives storage and a merge, and leaves a checkpoint balance honest).`);
