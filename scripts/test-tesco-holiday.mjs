#!/usr/bin/env node
/**
 * Holiday hours — the Tesco tab's accrual, pinned.
 *
 * The rule the user states is one sentence — every Thursday, 8% of the previous
 * week's hours goes onto the holiday balance — and it hides three decisions that
 * are easy to get subtly wrong, all of them about which weeks count:
 *
 *   · a pay week runs Sunday → Saturday and is paid on that Sunday + 11 (a
 *     Thursday), so "every Thursday" means one pay week at a time, and the
 *     Thursday the week is PAID is the Thursday its holiday posts;
 *   · the opening figure is the balance Tesco showed on a day, so the week that
 *     figure already contains is never credited again — a balance of 35.10 set
 *     on a Thursday accrues from the NEXT Thursday, which is exactly what the
 *     user asked for and exactly what a naive "sum every week" would break;
 *   · taken holiday is a week off that has come ROUND (not one merely booked),
 *     and a row with clock times is work — it is already in the week's credit,
 *     so subtracting it as well would take the same hours twice.
 *
 * holidayBalance is pure arithmetic in tesco-pay.js, so this file runs it
 * directly against fixed days. The rest pins the two halves that are not
 * arithmetic: the document shape (storage.js's validator and sync-merge.js's
 * merge, because a balance that a merge can eat is a balance that vanishes),
 * and the wiring in app.js/tesco.js, which cannot be run here — those files
 * touch the DOM on evaluation — so their source text is asserted the way
 * test-motion.mjs asserts paintFigure's.
 *
 * Run: node scripts/test-tesco-holiday.mjs
 * Also a step in scripts/run-guards.mjs.
 */
import { readFileSync } from 'node:fs';
import {
  holidayBalance, HOLIDAY_ACCRUAL_PCT, HOLIDAY_DEFAULT,
  payDateOf, weekStartOf, r2,
} from '../tesco-pay.js';
import { validateState } from '../storage.js';
import { mergeStates } from '../sync-merge.js';

let pass = 0;
const fails = [];
function ok(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${name}\n      expected ${e}\n      actual   ${a}`);
}
function okTrue(name, value) {
  ok(name, !!value, true);
}

// A worked shift: 07:00–15:00 is 7 paid hours (the ladder takes an hour because
// it starts before noon and runs 7+). Two of them make a 14h week.
const worked = (date, start = '07:00', end = '15:00') => ({ date, start, end });
const off = (date, hours = 7) => ({ date, hours });
const hol = (over = {}) => ({ ...HOLIDAY_DEFAULT, anchorDate: '2026-10-15', anchorHours: 35.10, taken: 0, ...over });

// ============================================================
// 1. The rate itself
// ============================================================
ok('the accrual rate is the statutory 8%', HOLIDAY_ACCRUAL_PCT, 8);
ok('the default document has no balance to accrue from', HOLIDAY_DEFAULT, { anchorDate: '', anchorHours: 0, taken: 0 });

// ============================================================
// 2. A week credits 8% of its hours, on the Thursday it is paid
// ============================================================
{
  // Week of Sun 11 Oct 2026 → Sat 17 Oct. Paid Thursday 22 Oct.
  const shifts = [worked('2026-10-11'), worked('2026-10-12')];
  ok('the week starts on its Sunday', weekStartOf('2026-10-12'), '2026-10-11');
  ok('and is paid 11 days later, on the Thursday', payDateOf('2026-10-11'), '2026-10-22');
  const b = holidayBalance(shifts, hol(), {}, '2026-10-22');
  ok('14h earns 1.12h', b.accrued, 1.12);
  ok('and the balance is the opening figure plus it', b.outstanding, r2(35.10 + 1.12));
  ok('the credit names its week and its pay date', b.credits, [{ weekStart: '2026-10-11', payDate: '2026-10-22', hours: 14, credit: 1.12 }]);
  // The day before the pay date, nothing has posted yet.
  ok('nothing posts before the Thursday', holidayBalance(shifts, hol(), {}, '2026-10-21').accrued, 0);
}

// ============================================================
// 3. The week already inside the opening figure is not credited twice
// ============================================================
{
  // The balance was read on the Thursday the week was paid — so that week's
  // holiday is part of the 35.10, and accrual begins with the NEXT Thursday.
  const shifts = [worked('2026-10-11'), worked('2026-10-12')];
  const sameDay = holidayBalance(shifts, hol({ anchorDate: '2026-10-22' }), {}, '2026-10-22');
  ok('an anchor on the pay date accrues nothing', sameDay.accrued, 0);
  ok('so the balance stays 35.10', sameDay.outstanding, 35.10);
  ok('and the next posting is the following Thursday', sameDay.next.payDate, '2026-10-29');
  // One day later, the same week is behind the anchor and does credit.
  ok('an anchor the day before does credit it', holidayBalance(shifts, hol({ anchorDate: '2026-10-21' }), {}, '2026-10-22').accrued, 1.12);
}

// ============================================================
// 4. A week still ahead is not earned yet
// ============================================================
{
  const shifts = [worked('2026-10-11'), worked('2026-10-12'), worked('2026-10-19'), worked('2026-10-20')];
  const b = holidayBalance(shifts, hol(), {}, '2026-10-22');
  ok('only the completed week counts', b.accrued, 1.12);
  ok('the week on file for the next Thursday is what it will credit', b.next, {
    payDate: '2026-10-29', weekStart: '2026-10-18', hours: 14, credit: 1.12,
  });
  ok('a week later both have posted', holidayBalance(shifts, hol(), {}, '2026-10-29').accrued, 2.24);
}

// ============================================================
// 5. Taken: a week off that has come round, never a worked row
// ============================================================
{
  // Sunday 25 Oct is the start of the week paid 5 Nov.
  const booked = [off('2026-10-25', 7)];
  ok('a week off still ahead is booked, not taken', holidayBalance(booked, hol(), {}, '2026-10-22').takenAutomatic, 0);
  ok('it comes off when its week arrives', holidayBalance(booked, hol(), {}, '2026-10-25').takenAutomatic, 7);
  // Dated before the anchor: already inside the figure the user read.
  ok('a week off before the anchor is already inside it', holidayBalance([off('2026-10-04', 7)], hol(), {}, '2026-10-22').takenAutomatic, 0);
  // A worked row is work: its hours are in the week's credit.
  ok('a worked shift is never taken holiday', holidayBalance([worked('2026-10-12')], hol(), {}, '2026-10-22').takenAutomatic, 0);
  // A week off is paid hours, not worked ones: it must not earn holiday for
  // being taken. 7h worked + 7h week off credits 0.56, not 1.12.
  const mixed = holidayBalance([worked('2026-10-19'), off('2026-10-21', 7)], hol(), {}, '2026-10-29');
  ok('a week off earns nothing itself', mixed.accrued, 0.56);
  ok('and comes off the balance', [mixed.takenAutomatic, mixed.outstanding], [7, r2(35.10 + 0.56 - 7)]);
  // Manual hours are added to the automatic ones, not substituted for them.
  const both = holidayBalance([off('2026-10-25', 7)], hol({ taken: 1.5 }), {}, '2026-10-25');
  ok('typed hours add to the weeks off', [both.takenAutomatic, both.manualTaken, both.taken], [7, 1.5, 8.5]);
  // No week has been paid between the anchor (Thu 15 Oct) and Sun 25 Oct, so
  // the only figure on this balance is 35.10 minus what was taken.
  ok('and come off the balance', both.outstanding, r2(35.10 - 8.5));
}

// ============================================================
// 6. The balance can go negative, and the next posting is a date not a lookup
// ============================================================
{
  const b = holidayBalance([off('2026-10-18', 7)], hol({ anchorDate: '2026-10-15', anchorHours: 1 }), {}, '2026-10-22');
  ok('a balance can be in the red', b.outstanding, -6);
  const empty = holidayBalance([], hol({ anchorDate: '2026-10-22' }), {}, '2026-10-22');
  ok('the next Thursday is known with no shifts at all', empty.next, {
    payDate: '2026-10-29', weekStart: '2026-10-18', hours: 0, credit: 0,
  });
}

// ============================================================
// 7. Rounding is per posting, at cent precision
// ============================================================
{
  // A row that states its own hours AND has clock times is a worked row (the
  // sheet's imported shape); only hours with no clock times are a week off.
  ok('8% of 21.5h is 1.72', holidayBalance([{ date: '2026-10-12', start: '07:00', end: '15:00', hours: 21.5 }], hol(), {}, '2026-10-22').accrued, 1.72);
  ok('8% of 3h is 0.24', holidayBalance([{ date: '2026-10-12', start: '07:00', end: '15:00', hours: 3 }], hol(), {}, '2026-10-22').accrued, 0.24);
  // Two postings of a third of an hour each: each rounds on its own, so the
  // total is the sum of what was posted, not a re-rounding of the sum.
  const two = holidayBalance([worked('2026-09-27'), worked('2026-10-04')], hol({ anchorDate: '2026-09-24' }), {}, '2026-10-22');
  ok('each posting rounds as its own amount', two.accrued, r2(0.56 + 0.56));
}

// ============================================================
// 8. Nothing here throws, and junk reads as "not set up"
// ============================================================
{
  const junk = holidayBalance(null, null, null, null);
  ok('no shifts, no balance, no clock', [junk.configured, junk.outstanding, junk.next], [false, 0, null]);
  const bad = holidayBalance([{ date: '2026-02-31', start: '07:00', end: '15:00' }, null, 'x'], 'nope', {}, '2026-13-40');
  ok('a day that does not exist is not a shift', bad.accrued, 0);
  okTrue('and the answers are still numbers', Number.isFinite(bad.outstanding) && Number.isFinite(bad.taken));
  const noDay = holidayBalance([worked('2026-10-12')], hol(), {}, 'nonsense');
  ok('an unusable clock claims no time has passed', [noDay.accrued, noDay.takenAutomatic, noDay.next], [0, 0, null]);
}

// ============================================================
// 9. The document: one shape, and a merge that cannot eat it
// ============================================================
{
  const fresh = validateState({ entries: [] });
  ok('a fresh document has the block', fresh.settings.tescoHoliday, { anchorDate: '', anchorHours: 0, taken: 0 });
  const kept = validateState({ entries: [], settings: { tescoHoliday: { anchorDate: '2026-10-22', anchorHours: 35.1, taken: 1.5 } } });
  ok('a valid balance survives validation', kept.settings.tescoHoliday, { anchorDate: '2026-10-22', anchorHours: 35.1, taken: 1.5 });
  const junkBlock = validateState({ entries: [], settings: { tescoHoliday: { anchorDate: '2026-02-31', anchorHours: -5, taken: 'lots' } } });
  ok('a day that does not exist reads as not set up', junkBlock.settings.tescoHoliday, { anchorDate: '', anchorHours: 0, taken: 0 });
  ok('validation is idempotent on it', validateState(kept).settings.tescoHoliday, kept.settings.tescoHoliday);

  // Field-wise, both ways: a balance re-set on one device and holiday typed on
  // the other are different facts about different fields.
  const local = { entries: [], settings: { tescoHoliday: { anchorHours: 20 } }, tesco: {}, lastLocalChangeAt: '2026-10-20T10:00:00.000Z' };
  const cloud = { entries: [], settings: { tescoHoliday: { anchorDate: '2026-10-01', taken: 2 } }, tesco: {}, lastLocalChangeAt: '2026-10-21T10:00:00.000Z' };
  ok('a merge keeps both sides of the balance', mergeStates(local, cloud).settings.tescoHoliday,
    { anchorHours: 20, anchorDate: '2026-10-01', taken: 2 });
  ok('and the same when the local copy is the fresher one', mergeStates(cloud, local).settings.tescoHoliday,
    { anchorHours: 20, anchorDate: '2026-10-01', taken: 2 });
}

// ============================================================
// 9b. The ledger: the balance written out line by line
// ============================================================
{
  // 35.10 read off Tesco on Thu 8 Oct, a 7h week paid on Thu 15 Oct, a week off
  // on Mon 19 Oct, 2h typed, and a week off booked for 26 Oct that has not come
  // round yet. The 22 Oct shift's week is paid on 29 Oct, after this clock.
  const b = holidayBalance(
    [worked('2026-10-07'), worked('2026-10-22'), off('2026-10-19', 7), off('2026-10-26', 7)],
    hol({ anchorDate: '2026-10-08', anchorHours: 35.1, taken: 2 }), {}, '2026-10-22');
  ok('the ledger opens with the figure Tesco showed', b.ledger[0],
    { kind: 'opening', date: '2026-10-08', hours: 35.1, balance: 35.1 });
  ok("then each Thursday's credit, on the day that week is paid", b.ledger[1],
    { date: '2026-10-15', kind: 'credit', weekStart: '2026-10-04', workedHours: 7, hours: 0.56, balance: 35.66 });
  ok('then a week off that has come round, on its own day', b.ledger[2],
    { date: '2026-10-19', kind: 'weekOff', hours: -7, balance: 28.66 });
  ok('then the typed figure — undated, and last', b.ledger[3],
    { kind: 'typed', date: '', hours: -2, balance: 26.66 });
  ok('the last balance is the outstanding figure', b.ledger.at(-1).balance, b.outstanding);
  ok('and there is nothing else in it', b.ledger.length, 4);

  // The two weeks that must NOT be in it, each for its own reason.
  okTrue('a week off still ahead is booked, not taken', !b.ledger.some(row => row.date === '2026-10-26'));
  okTrue('and a week whose Thursday has not come round is not credited', !b.ledger.some(row => row.date === '2026-10-29'));

  // The running balance is the previous one plus the movement, every line — that
  // is what makes it checkable against a payslip rather than a total to trust.
  ok('every row continues the one before it',
    b.ledger.every((row, i) => i === 0 ? row.balance === row.hours : row.balance === r2(b.ledger[i - 1].balance + row.hours)),
    true);
  ok('and the dates run oldest first',
    b.ledger.slice(1).every((row, i) => !row.date || !b.ledger[i].date || b.ledger[i].date <= row.date), true);

  // An unconfigured document has no working to show, and a typed figure on its
  // own is a movement with no date — neither may invent a row.
  ok('no balance, no ledger', holidayBalance([], HOLIDAY_DEFAULT, {}, '2026-10-22').ledger, []);
  const onlyTyped = holidayBalance([], hol({ anchorDate: '2026-10-22', anchorHours: 10, taken: 1 }), {}, '2026-10-22');
  ok('a typed figure with no other movement is still a line', onlyTyped.ledger.map(row => row.kind), ['opening', 'typed']);

  const tesco = readFileSync(new URL('../tesco.js', import.meta.url), 'utf8');
  okTrue('the card renders the engine\'s own rows', /function paintLedger\(b\)/.test(tesco) && /b\.configured \? b\.ledger : \[\]/.test(tesco));
  okTrue('and computes no credit of its own', !/\*\s*HOLIDAY_ACCRUAL_PCT\s*\/\s*100/.test(tesco));
  okTrue('the ledger is a fold, remembered per device',
    /foldGet\('holiday-ledger', null\)/.test(tesco) && /foldSet\('holiday-ledger', open\)/.test(tesco));
  okTrue('and its toggle names how much is behind it', /Show the holiday ledger · \$\{n\} movement/.test(tesco));
}

// ============================================================
// 10. The wiring: the card is on the Tesco screen, and the dashboard refreshes
// ============================================================
{
  const tesco = readFileSync(new URL('../tesco.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

  okTrue('the Tesco screen appends the holiday card', /screen\.appendChild\(buildHolidayCard\(\)\);/.test(tesco));
  okTrue('the card derives from the one engine, with the live tables', /holidayBalance\(shifts\(\), holiday\(\), rates, isoLocal\(now\)\)/.test(tesco));
  okTrue('the weekly note names the rate from the constant, not a literal',
    /HOLIDAY_ACCRUAL_PCT\}% of each week's hours/.test(tesco) && /Next: \$\{HOLIDAY_ACCRUAL_PCT\}/.test(tesco));
  okTrue('the opening figure is dated the day it is typed',
    /anchorDate: holiday\(\)\.anchorDate \|\| isoLocal\(now\)/.test(tesco));
  okTrue('the three fields are named for the reader',
    ['Holiday balance from Tesco', 'Holiday balance date', 'Holiday hours taken']
      .every(label => tesco.includes(`'aria-label': '${label}'`)));
  okTrue('and Enter commits them, so a typed figure is not left uncommitted',
    (tesco.match(/onKeydown: commitOnEnter/g) || []).length === 2 && /const commitOnEnter = e => \{ if \(e\.key === 'Enter'\) e\.target\.blur\(\); \}/.test(tesco));

  // The card is the READING of the balance, so a field showing 35.10 beside a
  // card reading 0.00h is the card contradicting the user — which is what a
  // `change`-only commit produced. Only `input` has the value while it is being
  // typed, so that is where the card has to follow from.
  okTrue('the fields commit as they are typed, not only when left',
    (tesco.match(/onInput: e => \{\n\s*const n = typedHours\(e\.target, false\);/g) || []).length === 2
    && /const writeLive = \(patch\) => \{[\s\S]{0,80}put\(patch\);/.test(tesco));
  const putFn = /const put = \(patch\) => \{([\s\S]*?)\n    \};/.exec(tesco);
  okTrue('and the card repaints itself, without rebuilding the field being typed in',
    !!putFn && /paintHoliday\(\)/.test(putFn[1]) && !/render\(\)/.test(putFn[1]));
  okTrue('the write to storage is debounced, and leaving the field flushes it',
    /setTimeout\(\(\) => \{ persistTimer = 0; persist\(\); \}, 300\)/.test(tesco)
    && /const write = \(patch\) => \{ stopPersistTimer\(\); put\(patch\); persist\(\); \}/.test(tesco));
  okTrue('an unreadable intermediate value changes nothing',
    /if \(raw === ''\) return commit \? 0 : null;/.test(tesco)
    && /if \(n !== null\) writeLive\(/.test(tesco));

  // A paid Thursday used to print its figure with no way to touch it, so a wrong
  // amount could only be fixed by finding the row in History. The card offers the
  // edit now — but only for the line it is counting, identified by being Tesco
  // pay, so an unrelated credit landing on a Thursday is left alone.
  okTrue('a paid Thursday offers Edit on the line the card counted',
    /const payLine = paid\s*\n\s*\? state\.entries\.find\(e => e\.date === d && e\.type === 'credit' && e\.details === 'Tesco pay'\)\s*\n\s*: null;/.test(app));
  okTrue('and it opens that entry in the ordinary editor', /onClick: \(\) => openEdit\(payLine\.id\)/.test(app));
  okTrue('the row action is addressed for the reader',
    /'aria-label': `Edit Tesco pay for \$\{friendlyDate\(d\)\}`/.test(app));

  okTrue('the dashboard card carries the refresh control', /onClick: refreshTescoPay/.test(app));
  // The dashboard's holiday figure must be the tab's, computed by the SAME
  // engine from the same tables — a second arithmetic is a second answer to a
  // figure the user reads off a payslip. Only once it is set up, too: 0.00h on
  // an unconfigured document would read as "none earned".
  okTrue('the dashboard reads the holiday balance from the one engine',
    /const tescoHoliday = holidayBalance\(tescoShifts, state\.settings\.tescoHoliday, tescoRates, isoLocal\(now\)\)/.test(app));
  okTrue('and prints it only once a balance is set up',
    /tescoHoliday\.configured \? ` · \$\{Number\(tescoHoliday\.outstanding\)\.toFixed\(2\)\}h holiday` : ''/.test(app));
  okTrue('a button is not nested inside the card link', /class: 'card', style: 'display:flex;align-items:center;gap:12px;margin-bottom:24px;'/.test(app));
  const fn = /function refreshTescoPay\(\) \{([\s\S]*?)\n\}/.exec(app);
  okTrue('refreshTescoPay exists', !!fn);
  okTrue('it writes the recorded pay to the ledger', !!fn && /recordTescoPayToLedger\(\)/.test(fn[1]));
  okTrue('as one named, undoable step', !!fn && /trackAction\(ledger\.undo, 'Tesco pay to Balances'\)/.test(fn[1]));
  okTrue('and repaints, so the card cannot sit on a stale figure', !!fn && /\n  render\(\);/.test(fn[1]));
}

// ============================================================
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-tesco-holiday: ${fails.length} FAILED, ${pass} passed\n`);
  for (const failure of fails) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`test-tesco-holiday: OK — ${total} assertions (8% a week on the Thursday, the opening figure never counted twice, taken is weeks off that have come round, and the card + refresh are wired)`);
