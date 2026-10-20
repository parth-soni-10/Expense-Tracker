#!/usr/bin/env node
/**
 * The payment methods the user owns, and the schedules they put on repeat.
 *
 * Two parity lines live here:
 *
 *   - docs/CENTS_PARITY.md line 19 — a payment-method manager creates a method
 *     visible in the entry, transfer, split, recurring and History pickers.
 *   - line 20 — built-in methods can be hidden; custom methods can be removed
 *     and restored without rewriting historical records.
 *   - line 21 — recurring bills/paydays support a schedule, reminders and
 *     one-tap completion.
 *
 * The method rules are the ones with teeth, because the obvious implementation
 * eats the ledger. `validateEntry` DROPS an entry whose method the storage
 * layer does not know, so a removal that really removed the id would delete
 * that entry's entire history at the next load — a deletion that never appears
 * as one. The three rules the guard pins:
 *
 *   1. A method out of the pickers stays a VALID id, and its history keeps
 *      naming it.
 *   2. `false` is a value, not an absent key. The settings merge is a per-key
 *      spread, which can overwrite a key but never delete one — so a restore
 *      written as a deletion would lose to the other device's `true` on every
 *      sync, and the method would come back hidden on its own, forever.
 *   3. A picker showing an existing record keeps that record's method visible
 *      even when it is hidden, or editing the record would silently move it
 *      to another account.
 *
 * The recurring rules are the ones that decide *when* a schedule lands, and a
 * date that advances wrongly is a schedule that fires on the wrong day and
 * nobody notices until the money is wrong. The two that matter: a monthly
 * schedule lands on the same day of the month every time (the shipping app
 * passed a 1-based month into a 0-based index, so every monthly advance
 * skipped a month), and every walk that could spin carries a bound.
 *
 * Run: node scripts/test-methods.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

const methods = await import('../app/lib/methods.ts');
const recurring = await import('../app/lib/recurring.ts');
const { METHODS } = await import('../app/lib/seed.ts');

/* ══ THE CATALOGUE ══════════════════════════════════════════════════════════ */

const settings = { customMethods: [], methodHidden: {} };
const catalogue = methods.everyMethod(settings);
check('the catalogue holds every built-in', catalogue.length === METHODS.length,
  `${catalogue.length} of ${METHODS.length}`);
check('the built-ins are marked as built-in', catalogue.every((m) => m.builtin));
check('nothing is hidden to begin with', catalogue.every((m) => !m.hidden));

/* ══ ADDING A METHOD ════════════════════════════════════════════════════════ */

const added = methods.addCustomMethod(settings, 'Credit Union');
check('a method can be added', added.ok === true, added.ok ? '' : added.error);
check('it is in the catalogue', methods.everyMethod(settings).some((m) => m.id === 'credit-union'));
check('it is offered by a picker', methods.allMethods(settings).some((m) => m.id === 'credit-union'));
check('the label is kept as typed', methods.everyMethod(settings).find((m) => m.id === 'credit-union').label === 'Credit Union');

const dupLabel = methods.addCustomMethod(settings, 'credit union');
check('a duplicate label is refused', dupLabel.ok === false && /already exists/i.test(dupLabel.error), dupLabel.error);
const empty = methods.addCustomMethod(settings, '   ');
check('an empty name is refused', empty.ok === false);
check('a refused add wrote nothing', methods.everyMethod(settings).length === METHODS.length + 1);

const dupId = methods.addCustomMethod(settings, 'Credit Union 2');
check('a colliding slug is suffixed rather than overwriting',
  dupId.ok === true && dupId.method.id !== 'credit-union' && dupId.method.id.startsWith('credit-union-'),
  dupId.ok ? dupId.method.id : dupId.error);

/* ══ HIDING AND REMOVING (line 20) ══════════════════════════════════════════ */

const aib = METHODS.find((m) => m.id === 'AIB');
check('a built-in can be hidden', methods.setMethodHidden(settings, 'AIB', true).ok === true);
check('it leaves the pickers', !methods.allMethods(settings).some((m) => m.id === 'AIB'));
check('it is STILL a valid id — its history keeps naming it',
  methods.everyMethod(settings).some((m) => m.id === 'AIB'));
check('the flag is true', settings.methodHidden.AIB === true);

check('a restore is possible', methods.setMethodHidden(settings, 'AIB', false).ok === true);
check('the flag is an explicit false, not an absent key',
  settings.methodHidden.AIB === false && 'AIB' in settings.methodHidden,
  JSON.stringify(settings.methodHidden));
check('it is back in the pickers', methods.allMethods(settings).some((m) => m.id === 'AIB'));

check('an unknown method cannot be hidden', methods.setMethodHidden(settings, 'nope', true).ok === false);

// The merge is a per-key last-write-wins on `methodHidden`, and the fresher
// side spreads LAST. A restore written as a DELETION could never beat the
// other device's `true`; a restore written as `false` overwrites it. This is
// the real merge, not a hand-rolled spread.
const { mergeStates } = await import('../app/lib/sync-merge.ts');
const older = {
  schemaVersion: 2,
  entries: [],
  settings: { methodHidden: { AIB: true, Revolut: false } },
  lastLocalChangeAt: '2026-10-19T00:00:00.000Z',
};
const newer = {
  schemaVersion: 2,
  entries: [],
  settings: { methodHidden: { AIB: false } },
  lastLocalChangeAt: '2026-10-20T00:00:00.000Z',
};
const merged = mergeStates(older, newer);
check('a restore survives a merge (the newer false wins)', merged.settings.methodHidden.AIB === false,
  JSON.stringify(merged.settings.methodHidden));
check('a key only the older side has survives the merge too', merged.settings.methodHidden.Revolut === false,
  JSON.stringify(merged.settings.methodHidden));
check('a removal syncs too — the fresher side holds the true',
  mergeStates(
    { schemaVersion: 2, entries: [], settings: { methodHidden: { AIB: false } }, lastLocalChangeAt: '2026-10-19T00:00:00.000Z' },
    { schemaVersion: 2, entries: [], settings: { methodHidden: { AIB: true } }, lastLocalChangeAt: '2026-10-20T00:00:00.000Z' },
  ).settings.methodHidden.AIB === true,
  JSON.stringify(mergeStates(
    { schemaVersion: 2, entries: [], settings: { methodHidden: { AIB: false } }, lastLocalChangeAt: '2026-10-19T00:00:00.000Z' },
    { schemaVersion: 2, entries: [], settings: { methodHidden: { AIB: true } }, lastLocalChangeAt: '2026-10-20T00:00:00.000Z' },
  ).settings.methodHidden));
check('and the fresher side always wins, whichever way it went',
  mergeStates(newer, older).settings.methodHidden.AIB === false
  && mergeStates(older, newer).settings.methodHidden.AIB === false,
  'the fresher side must decide');

// The catalogue is a union by id, so a tombstone is what keeps a method from
// coming back on its own — but a tombstone is a flag, never a removal from
// customMethods, or the cloud's union would refill the list.
const custom = methods.addCustomMethod(settings, 'Apple Pay');
check('a custom method can be removed', methods.setMethodHidden(settings, custom.method.id, true).ok === true);
check('it leaves the pickers', !methods.allMethods(settings).some((m) => m.id === custom.method.id));
check('its id is still valid', methods.everyMethod(settings).some((m) => m.id === custom.method.id));
check('it is still in customMethods — a tombstone, not a deletion',
  settings.customMethods.some((m) => m.id === custom.method.id));
check('it can be restored', methods.setMethodHidden(settings, custom.method.id, false).ok === true);
check('and comes back to the pickers', methods.allMethods(settings).some((m) => m.id === custom.method.id));

/* ══ THE PICKERS (line 19) ══════════════════════════════════════════════════ */

check('a picker offers the catalogue minus the hidden ones',
  methods.methodPickerIds(settings).length === methods.allMethods(settings).length);
check('a hidden method stays in the picker for a record that names it',
  methods.setMethodHidden(settings, 'Revolut', true).ok === true
  && methods.methodPickerIds(settings, 'Revolut').includes('Revolut'),
  JSON.stringify(methods.methodPickerIds(settings, 'Revolut')));
check('a hidden method is not offered to a record that does not name it',
  !methods.methodPickerIds(settings, 'AIB').includes('Revolut'));
check('an unknown id is not added to the picker',
  !methods.methodPickerIds(settings, 'ghost').includes('ghost'));
check('the options carry labels the pickers can show',
  methods.methodOptions(settings, 'Revolut').every((o) => typeof o.label === 'string' && o.label.length > 0));

// A method the user just typed is offered immediately — a stale flag for the
// same slug does not get to keep it out of the pickers. The case this is for
// is a hidden method whose `customMethods` entry did not survive (an older
// document, a hand-edited one): the flag is still there, the entry is not, and
// re-adding the same name must offer it again rather than hide it.
const stale = { customMethods: [], methodHidden: { 'new-bank': true } };
const addedOverStale = methods.addCustomMethod(stale, 'New Bank');
check('the typed name becomes a slug', addedOverStale.ok === true && addedOverStale.method.id === 'new-bank',
  addedOverStale.ok ? addedOverStale.method.id : addedOverStale.error);
check('re-adding a name clears a stale hidden flag',
  addedOverStale.ok === true && stale.methodHidden['new-bank'] === false,
  JSON.stringify(stale.methodHidden));
check('and it is offered right away', methods.allMethods(stale).some((m) => m.id === 'new-bank'));

// Usage counts records, so the manager can say what a removal touches.
const usage = methods.methodUsage({
  entries: [{ method: 'AIB' }, { method: 'AIB' }, { method: 'Revolut' }],
  settings: { recurring: [{ method: 'AIB' }] },
});
check('usage counts entries and recurring bills', usage.get('AIB') === 3 && usage.get('Revolut') === 1,
  JSON.stringify([...usage]));

/* ══ THE SCHEDULE (line 21) ═════════════════════════════════════════════════ */

// The monthly bug the shipping app had: a 1-based month passed into a 0-based
// index, so every monthly advance skipped a month.
check('a monthly schedule lands on the same day of the month',
  recurring.advanceRecurringDate('2026-08-15', 'monthly', 15) === '2026-09-15',
  recurring.advanceRecurringDate('2026-08-15', 'monthly', 15));
check('and December rolls into January', recurring.advanceRecurringDate('2026-12-15', 'monthly', 15) === '2027-01-15',
  recurring.advanceRecurringDate('2026-12-15', 'monthly', 15));
check('a monthly schedule clamps to a short month',
  recurring.advanceRecurringDate('2026-01-31', 'monthly', 31) === '2026-02-28',
  recurring.advanceRecurringDate('2026-01-31', 'monthly', 31));
check('a yearly schedule clamps 29 February to the 28th',
  recurring.advanceRecurringDate('2028-02-29', 'yearly', 29) === '2029-02-28',
  recurring.advanceRecurringDate('2028-02-29', 'yearly', 29));
check('a weekly schedule steps seven days',
  recurring.advanceRecurringDate('2026-10-15', 'weekly') === '2026-10-22');
check('a fortnightly schedule steps fourteen days',
  recurring.advanceRecurringDate('2026-10-15', 'fortnightly') === '2026-10-29');
check('a daily schedule steps one day',
  recurring.advanceRecurringDate('2026-10-15', 'daily') === '2026-10-16');
check('an unknown frequency does not move the date',
  recurring.advanceRecurringDate('2026-10-15', 'weeklyly') === '2026-10-15');
check('a junk date does not move either',
  recurring.advanceRecurringDate('not-a-date', 'weekly') === 'not-a-date');

// A walk that cannot advance must stop, not spin.
const stuck = { id: 'r1', frequency: 'weeklyly', nextDate: '2026-10-15' };
const walked = recurring.advancePast(stuck, '2026-12-01');
check('a schedule that cannot advance stops instead of spinning',
  walked.nextDate === '2026-10-15' && walked.exhausted === true, JSON.stringify(walked));

// The walk is bounded: a daily schedule paid six months late needs ~180 steps,
// and a schedule that pays itself for years must still stop.
const daily = { id: 'r2', frequency: 'daily', nextDate: '2026-01-01' };
const bounded = recurring.advancePast(daily, '2030-01-01');
check('a walk that would run for years is cut short', bounded.exhausted === true, JSON.stringify(bounded));
check('and it stopped inside its budget', bounded.nextDate < '2030-01-01', bounded.nextDate);
check('a reachable target IS reached',
  recurring.advancePast({ id: 'r2b', frequency: 'daily', nextDate: '2026-01-01' }, '2026-01-10').nextDate === '2026-01-11',
  recurring.advancePast({ id: 'r2b', frequency: 'daily', nextDate: '2026-01-01' }, '2026-01-10').nextDate);
check('the daily budget is 400 steps', recurring.advanceBudget('daily') === 400);
check('the monthly budget is 48 steps', recurring.advanceBudget('monthly') === 48);

// The first occurrence of a new schedule is the next one on or after now.
const now = new Date(2026, 9, 20); // 20 October 2026
check('a monthly schedule first lands on the next 15th',
  recurring.computeInitialNextDate('monthly', 15, now) === '2026-11-15',
  recurring.computeInitialNextDate('monthly', 15, now));
check('a monthly schedule first lands on this month when the day has not passed',
  recurring.computeInitialNextDate('monthly', 25, now) === '2026-10-25',
  recurring.computeInitialNextDate('monthly', 25, now));
check('a yearly schedule first lands next year',
  recurring.computeInitialNextDate('yearly', 20, now) === '2027-10-20',
  recurring.computeInitialNextDate('yearly', 20, now));
check('a weekly schedule first lands in the future',
  recurring.computeInitialNextDate('weekly', 20, now) === '2026-10-27',
  recurring.computeInitialNextDate('weekly', 20, now));
check('the requested day is clamped to the month',
  recurring.computeInitialNextDate('monthly', 31, new Date(2026, 1, 10)) === '2026-02-28',
  recurring.computeInitialNextDate('monthly', 31, new Date(2026, 1, 10)));

// Occurrences inside a horizon, earliest first.
const rule = { id: 'r3', frequency: 'weekly', dayOfMonth: 1, nextDate: '2026-10-22' };
const upcoming = recurring.upcomingOccurrences(rule, 30, 6, new Date(2026, 9, 20));
check('the next occurrences are listed', upcoming.length === 5, JSON.stringify(upcoming));
check('earliest first', upcoming[0] === '2026-10-22' && upcoming[1] === '2026-10-29');
check('a limit is honoured', recurring.upcomingOccurrences(rule, 30, 2, new Date(2026, 9, 20)).length === 2);
check('a daily schedule projects more than a cap of six would',
  recurring.upcomingOccurrences({ id: 'r4', frequency: 'daily', nextDate: '2026-10-21' }, 30, 40, new Date(2026, 9, 20)).length === 30,
  String(recurring.upcomingOccurrences({ id: 'r4', frequency: 'daily', nextDate: '2026-10-21' }, 30, 40, new Date(2026, 9, 20)).length));

// The frequency label a schedule shows.
check('a monthly schedule is labelled with its day', recurring.frequencyLabel('monthly', 1) === 'Monthly · 1st',
  recurring.frequencyLabel('monthly', 1));
check('a weekly schedule is just the cadence', recurring.frequencyLabel('weekly') === 'Weekly');
check('the ordinal is the suffix, so the day is not printed twice',
  recurring.ordinal(1) === 'st' && recurring.ordinal(2) === 'nd' && recurring.ordinal(3) === 'rd'
  && recurring.ordinal(4) === 'th' && recurring.ordinal(11) === 'th' && recurring.ordinal(21) === 'st',
  [recurring.ordinal(1), recurring.ordinal(2), recurring.ordinal(3), recurring.ordinal(4), recurring.ordinal(11), recurring.ordinal(21)].join(' '));

/* ══ THE SUGGESTION ═════════════════════════════════════════════════════════ */

// A charge worth putting on the schedule: three of the same, regular, and not
// already scheduled.
const entries = [
  { type: 'expense', details: 'Rent', amount: 1200, method: 'AIB', date: '2026-07-01' },
  { type: 'expense', details: 'Rent', amount: 1200, method: 'AIB', date: '2026-08-01' },
  { type: 'expense', details: 'Rent', amount: 1200, method: 'AIB', date: '2026-09-01' },
  { type: 'expense', details: 'Rent', amount: 1200, method: 'AIB', date: '2026-10-01' },
];
const suggestion = recurring.recurringSuggestion(entries, []);
check('a regular charge is suggested', !!suggestion, String(suggestion));
check('it is monthly', suggestion?.frequency === 'monthly', suggestion?.frequency);
check('it carries the most recent entry', suggestion?.entry?.date === '2026-10-01');
check('the day of the month comes from that entry', suggestion?.dayOfMonth === 1);

check('a charge already on the schedule is not suggested again',
  recurring.recurringSuggestion(entries, [{
    id: 'r', frequency: 'monthly', dayOfMonth: 1, nextDate: '2026-11-01',
    details: 'Rent', amount: 1200, method: 'AIB', type: 'expense',
  }]) === null);

const irregular = [
  { type: 'expense', details: 'Odd', amount: 10, method: 'AIB', date: '2026-01-05' },
  { type: 'expense', details: 'Odd', amount: 10, method: 'AIB', date: '2026-04-19' },
  { type: 'expense', details: 'Odd', amount: 10, method: 'AIB', date: '2026-11-30' },
];
check('an irregular charge is not suggested', recurring.recurringSuggestion(irregular, []) === null);

const habit = [
  { type: 'expense', details: 'Coffee', amount: 3.5, method: 'Cash', date: '2026-10-01' },
  { type: 'expense', details: 'Coffee', amount: 3.5, method: 'Cash', date: '2026-10-02' },
  { type: 'expense', details: 'Coffee', amount: 3.5, method: 'Cash', date: '2026-10-03' },
];
check('a daily habit is not suggested', recurring.recurringSuggestion(habit, []) === null);

/* ══ BUILDING A RULE ════════════════════════════════════════════════════════ */

const made = recurring.makeRecurringRule({ id: 'rec_1', details: 'Rent', amount: 1200, method: 'AIB', frequency: 'monthly', dayOfMonth: 1 });
check('a rule can be built', made.ok === true, made.ok ? '' : made.error);
check('it carries the first occurrence', made.ok && /^20\d\d-\d\d-\d\d$/.test(made.rule.nextDate));
check('it rounds the amount to cents', made.ok && made.rule.amount === 1200);
check('a rule with no name is refused', recurring.makeRecurringRule({ id: 'x', details: '  ', amount: 10, frequency: 'monthly' }).ok === false);
check('a rule with no amount is refused', recurring.makeRecurringRule({ id: 'x', details: 'Rent', amount: 0, frequency: 'monthly' }).ok === false);
check('a rule with an unknown cadence is refused', recurring.makeRecurringRule({ id: 'x', details: 'Rent', amount: 10, frequency: 'hourly' }).ok === false);

// A rule the storage layer accepts must round-trip through validateState.
const { validateState } = await import('../app/lib/storage.ts');
const state = validateState({
  schemaVersion: 2,
  entries: [],
  settings: { recurring: [made.rule] },
});
check('the rule survives validation', state.settings.recurring.length === 1);
check('it keeps its cadence and its next date',
  state.settings.recurring[0].frequency === 'monthly'
  && state.settings.recurring[0].nextDate === made.rule.nextDate,
  JSON.stringify(state.settings.recurring[0]));

if (failures) {
  console.error(`\ntest-methods: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-methods: OK — ${checks} checks (a method survives its own removal; a schedule lands on the day it says it does)`);
