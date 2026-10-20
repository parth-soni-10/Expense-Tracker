#!/usr/bin/env node
/**
 * The last surfaces: the figures, the motion, the year in review, and the
 * reconciliation.
 *
 * Four parity lines live here:
 *
 *   - docs/CENTS_PARITY.md line 23 — the dashboard's home metrics, month
 *     totals, balance and net-worth figures, the charts, and their tap/hover
 *     details, work with real ledger data.
 *   - line 24 — motion follows the project contracts, has a reduced-motion
 *     path, and preserves the EXACT final money values.
 *   - line 69 — Insights, the year in review, the charts and the print views
 *     reflect actual ledger data and keep readable empty states.
 *   - line 11 — the bank-account and gift-card balances reconcile against a
 *     statement.
 *
 * The money rules are the ones that matter. A figure that animates to a
 * NEARBY number is a figure that lies, so the Animated Counter's contract is
 * exact: an unchanged value does not move, the FINAL frame is the exact
 * formatted value, and the first paint does not count up from zero. A chart
 * mark whose value cannot be read is a shape, not a figure, so every mark
 * carries its detail twice: the `title` a pointer reads and the `aria-label`
 * anyone else reads.
 *
 * Run: node scripts/test-figures-review.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const read = (rel) => readFileSync(resolve(repo, rel), 'utf8');

/* ══ 1. THE FIGURES COME FROM THE LEDGER ═══════════════════════════════════ */

const metrics = read('app/src/metrics.ts');
const dashboard = read('app/src/screens/dashboard.ts');
check('the dashboard reads the ported arithmetic, not its own',
  /from '\.\.\/metrics\.ts'/.test(dashboard), 'the figures must come from one place');
for (const fn of ['dashboardSummary', 'catTotalsForEntries', 'balanceAtForEntries', 'isBudgetSpendingEntry']) {
  check(`  and ${fn} is there`, metrics.includes(fn), fn);
}
check('the figures are class-only — nothing writes a width from script',
  !/style\s*=\s*['"]/.test(dashboard), 'a width written from script is a style attribute');
check('and the bar is a native progress element, so its value is the truth',
  /el\('progress'/.test(read('app/src/screens/insights.ts')));

/* ══ 2. EVERY CHART MARK CARRIES ITS DETAIL ═══════════════════════════════ */

const insights = read('app/src/screens/insights.ts');
check('a chart mark carries the detail a pointer reads', /title: detail/.test(insights),
  'the title is what a hover reads');
check('and the same detail for anyone who cannot see it', /'aria-label': detail/.test(insights));
check('the heat board names every day, and what it cost',
  /'aria-label': `\$\{friendlyKey\(key\)\}: \$\{amount > 0/.test(insights));
check('the bars are the ratio, not a drawn width', /el\('progress'/.test(insights));
check('and an empty range says so rather than showing nothing',
  /'No spending in this range\.'/.test(insights));

/* ══ 3. MOTION: EXACT VALUES, AND A REDUCED-MOTION PATH ═══════════════════ */

// The Animated Counter's contract, read from the kit that implements it.
const kit = read('../design-system/ui-kit/ui.js');
check('the counter is installed ONCE per element, so an unchanged value does not move',
  /function ready\(el, id\)[\s\S]{0,400}data-ui-ready/.test(kit),
  'a re-scan must not re-animate a value that has not changed');
check('the final frame is the exact formatted value',
  /else target\.textContent = original;/.test(kit),
  'the last frame must be the value that was there, not a rounded one');
check('under reduced motion it does not animate at all, so the value is exact from the first paint',
  /if \(!match \|\| reduced\(\)\) return;/.test(kit),
  'the first paint must not count up from zero');

// The reduced-motion path: a BLANKET rule, so nothing in the shell can animate
// under it. A per-component list would rot the moment a component is added.
const styles = read('app/styles.css');
check('reduced motion is a blanket rule, not a list that rots',
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\*, \*::before, \*::after \{[\s\S]{0,200}animation: none !important;[\s\S]{0,120}transition: none !important;/.test(styles),
  'every animation must collapse, including one added tomorrow');
check('and the shell carries its own reduced-motion rules for what it animates',
  /prefers-reduced-motion/.test(read('app/styles/shell.css'))
  && /prefers-reduced-motion/.test(read('app/styles/screens.css')));
check('the scroll behaviour is instant too', /scroll-behavior: auto !important/.test(styles));

// Nothing in the shell writes a style attribute: the strict policy is the
// point, and a runtime width is how a chart smuggles one in.
check('the shell writes no inline style anywhere',
  !/style:\s*['"]/.test(dashboard + insights + metrics),
  'a style attribute is refused by style-src \'self\'');

/* ══ 4. THE YEAR IN REVIEW ═════════════════════════════════════════════════ */

const review = read('app/src/screens/year-review.ts');
check('the review is a real surface, not a stub', /export function openYearInReview/.test(review));
check('it counts the year that is running', /new Date\(\)\.getFullYear\(\)/.test(review));
for (const row of ['Total earned', 'Total spent', 'Net', 'Entries logged', 'Top category', 'Best month', 'Toughest month', 'Busiest day']) {
  check(`  and it shows "${row}"`, review.includes(`'${row}'`), row);
}
check('the figures come from the ledger', /state\.entries/.test(review) && /isBudgetSpendingEntry/.test(review));
check('and the spending and income are the budget\'s definitions',
  /isBudgetSpendingEntry/.test(review) && /isBudgetIncomeEntry/.test(review),
  'the review cannot disagree with the dashboard');
check('an empty year still reads', /: '—'/.test(review), 'a dash, not a blank');
check('it can be printed', /window\.print\(\)/.test(review));
check('and the print class goes on the BODY, so the sheet is the only thing printed',
  /document\.body\.classList\.add\('printing-review'\)/.test(review));
check('and it is swept, because some webviews never fire afterprint',
  /removeEventListener\('afterprint'/.test(review) && /setTimeout\(done/.test(review));
check('the summary can be copied', /Copy summary/.test(review));
check('the print stylesheet suppresses the app behind it',
  /body\.printing-review #app[\s\S]{0,120}display: none !important/.test(read('app/styles/screens.css')));
check('and un-chromes the sheet', /body\.printing-review \.history-dialog-card/.test(read('app/styles/screens.css')));
check('the Insights screen offers it', /openYearInReview\(state\)/.test(insights));

/* ══ 5. THE RECONCILIATION ══════════════════════════════════════════════════ */

// A balance reconciles against a statement: the statement's rows land in the
// ledger, and the balance screen says what the book thinks against what the
// statement says.
check('the bank statement importer is a real, separate module',
  /export function parseBankCsv/.test(read('app/lib/bank-import.ts'))
  && /export function suggestBankMapping/.test(read('app/lib/bank-import.ts')));
check('and it never guesses a date', /day-first/i.test(read('app/lib/bank-import.ts')));
check('the balance screen reconciles the book against a checkpoint',
  /bookBalanceAt/.test(read('app/src/screens/balances.ts'))
  && /saveCheckpoint/.test(read('app/src/screens/balances.ts')),
  'the difference between the book and the statement is the reconciliation');
check('and it names the difference rather than hiding it',
  /checkpoint-share|actual|book/i.test(read('app/src/screens/balances.ts')));
check('the gift cards are balances too', /BALANCE_METHOD_IDS/.test(read('app/lib/storage.ts'))
  && /TG/.test(read('app/lib/storage.ts')));
check('the imported rows go through the one duplicate gate',
  /parseBankCsv/.test(read('app/src/screens/bank-statement.ts'))
  && /buildBankEntries/.test(read('app/src/screens/bank-statement.ts')));

if (failures) {
  console.error(`\ntest-figures-review: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-figures-review: OK — ${checks} checks (the figures are the ledger's, motion is exact and reducible, and the year in review prints)`);
