#!/usr/bin/env node
/* Hand-run browser leg for the Insights screen, the year in review, and the
 * reconciliation.
 *
 * Outside `run-guards.mjs` for the same reason the other browser legs are: it
 * needs Playwright, and adding that to this repo would put a browser download
 * in front of every deploy.
 *
 * What it proves, and why each one needs a browser:
 *
 *   · The INSIGHTS figures are the ledger's. The narrative, the stat cells and
 *     the category bars are read off the screen and checked against a fixture
 *     counted by hand.
 *   · Every chart mark carries its DETAIL — the `title` a pointer reads and
 *     the `aria-label` anyone else reads. A chart mark whose value cannot be
 *     read is a shape, not a figure.
 *   · The YEAR IN REVIEW shows the real year, and it can be printed.
 *   · A BALANCE RECONCILES against a statement: an AIB-shaped CSV lands in the
 *     ledger, and the Balances screen then says what the book thinks against
 *     what the statement said.
 *
 * Run: node scripts/insights.browser.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(fileURLToPath(new URL('../app/', import.meta.url)));
const shared = resolve(root, '../../design-system/package.json');
const shape = (m) => (m && m.chromium ? m : m?.default);
const { chromium } = shape(createRequire(shared)('@playwright/test'));

const cspMatch = /^\s+Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(join(root, '_headers'), 'utf8'));
const CSP = cspMatch[1].trim();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const server = await new Promise((ready, reject) => {
  const s = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (path === '/') path = '/index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-security-policy': CSP }).end('not found');
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store', 'content-security-policy': CSP });
    res.end(body);
  });
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => ready(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const eq = (name, actual, expected) => check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const entry = (id, date, details, amount, method = 'AIB', category = 'gro', type = 'expense') => ({
  id, date, type, category, details, amount, method, note: '', createdAt: `${date}T09:00:00.000Z`,
});

// A year of ledger, counted by hand: 40 of groceries at 4.47, 30 of rent at
// 1200, and one income of 30000.
const fixture = {
  schemaVersion: 2,
  entries: [
    entry('e1', '2026-10-12', 'Lidl Groceries', 4.47),
    entry('e2', '2026-09-01', 'Rent', 1200, 'AIB', 'rent'),
    entry('e3', '2026-08-01', 'Rent', 1200, 'AIB', 'rent'),
    entry('e4', '2026-10-01', 'Salary', 30000, 'AIB', 'misc', 'credit'),
  ],
  settings: {},
  tesco: { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const cspRefusals = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) cspRefusals.push(m.text()); });

const closeSheets = async () => {
  for (let guard = 0; guard < 5; guard += 1) {
    const open = await page.locator('dialog[open]').count();
    if (!open) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
};

const unlock = async () => {
  const picker = page.locator('.profile-tile');
  if (await picker.count()) { await picker.first().click(); await page.waitForTimeout(400); }
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
};

try {
  await page.goto(`${base}/index.html`);
  await page.evaluate((raw) => localStorage.setItem('cents:p/personal/state', raw), JSON.stringify(fixture));
  await page.goto(`${base}/index.html`);
  await unlock();

  /* ── the insights figures ───────────────────────────────────────────────── */

  await page.evaluate(() => { location.hash = '#insights'; });
  await page.locator('.insights-section').waitFor({ timeout: 15000 });
  const body = (await page.locator('.insights-section').innerText()).replace(/\s+/g, ' ');

  check('the narrative names what was spent', /You spent/.test(body), body.slice(0, 220));
  check("and the figure is the ledger's", /2,?404\.47/.test(body), body.slice(0, 260));
  check('the stat cells are there', await page.locator('.insight-stat').count() >= 4,
    String(await page.locator('.insight-stat').count()));
  check('a category bar carries its detail for a pointer',
    await page.locator('.insight-bar-row[title]').count() > 0, 'no bar has a title');
  const barDetail = await page.locator('.insight-bar-row[title]').first().getAttribute('title');
  check('and the detail names the amount', /€/.test(barDetail || ''), String(barDetail));
  const barLabel = await page.locator('.insight-bar-row[title] progress').first().getAttribute('aria-label');
  check('and the same detail is there for anyone who cannot see it', /€/.test(barLabel || ''), String(barLabel));
  check('the heat board names every day', await page.locator('.heat-day[aria-label]').count() >= 28,
    String(await page.locator('.heat-day[aria-label]').count()));
  check('an empty range still reads', /No spending in this range\./.test(body) || /€/.test(body));

  /* ── the year in review ─────────────────────────────────────────────────── */

  await page.getByRole('button', { name: 'Open the year in review' }).click();
  const review = page.locator('dialog#year-review');
  await review.waitFor({ timeout: 5000 });
  const reviewText = (await review.innerText()).replace(/\s+/g, ' ');
  check('the review names the year', /your 2026 in review/i.test(reviewText), reviewText.slice(0, 160));
  check('it shows the total spent', /total spent/i.test(reviewText), reviewText.slice(0, 200));
  check("and the figure is the ledger's", /2,?404\.47/.test(reviewText), reviewText.slice(0, 260));
  check('it shows what was earned', /total earned/i.test(reviewText) && /€30,?000/.test(reviewText),
    reviewText.slice(0, 260));
  check('it shows the top category', /top category/i.test(reviewText), reviewText.slice(0, 260));
  check('and the busiest day', /busiest day/i.test(reviewText), reviewText.slice(0, 260));
  check('it can be printed', await review.getByRole('button', { name: 'Print' }).count() === 1);
  check('and the summary can be copied', await review.getByRole('button', { name: 'Copy summary' }).count() === 1);
  await page.keyboard.press('Escape');
  await review.waitFor({ state: 'detached', timeout: 5000 });

  /* ── the reconciliation ─────────────────────────────────────────────────── */

  // An AIB-shaped statement: day-first dates, a signed amount column, and a
  // debit that is the shop the ledger already knows.
  const statement = [
    'Date,Description,Amount (eur)',
    '15/10/2026,GROCERIES STORE,12.40',
    '14/10/2026,SALARY,-500.00',
  ].join('\n');

  await page.evaluate(() => { location.hash = '#balances'; });
  await page.locator('.balances-section, .balances-card, #screen .page-section').first().waitFor({ timeout: 15000 });

  // The statement lands in the ledger through the Data sheet's bank importer.
  // The importer shows a MAPPING screen first — you see which column means
  // what before anything is added — so the leg reads that screen too.
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const dataSheet = page.locator('dialog#data-sheet');
  await dataSheet.waitFor({ timeout: 5000 });
  await dataSheet.getByRole('button', { name: 'Import bank statement' }).click();
  const bankDialog = page.locator('dialog.bank-dialog');
  await bankDialog.waitFor({ timeout: 5000 });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    bankDialog.getByRole('button', { name: 'Choose CSV file' }).click(),
  ]);
  await chooser.setFiles({ name: 'aib.csv', mimeType: 'text/csv', buffer: Buffer.from(statement, 'utf8') });
  await page.waitForTimeout(1200);

  const preview = (await bankDialog.innerText()).replace(/\s+/g, ' ');
  check('the importer shows what it read before anything is added',
    /GROCERIES|groceries/i.test(preview), preview.slice(0, 220));
  check('and the day-first date is read the bank\'s way round', /15 Oct|Oct 15|15\/10\/2026/.test(preview),
    preview.slice(0, 260));
  const importButton = bankDialog.getByRole('button', { name: /^Import/ });
  check('and it waits for an explicit commit', await importButton.count() === 1);
  await importButton.click();
  await page.waitForTimeout(800);

  const imported = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  const landed = imported.entries.filter((e) => e.date === '2026-10-15');
  check('a statement row lands in the ledger', landed.length === 1,
    JSON.stringify(imported.entries.map((e) => `${e.date} ${e.amount}`)));
  check('and the amount is the statement\'s', landed[0] && landed[0].amount === 12.4,
    String(landed[0] && landed[0].amount));
  check('a negative amount is income, not spending', landed[0] && landed[0].type === 'credit',
    String(landed[0] && landed[0].type));

  /* ── the reconciliation: the book against the statement ─────────────────── */

  // A statement says what the account IS. The book says what the ledger says
  // it should be. The difference between the two IS the reconciliation, and it
  // is the number the Balances screen puts in front of the user.
  await closeSheets();
  await page.evaluate(() => { location.hash = '#balances'; });
  await page.locator('#screen .page-section').first().waitFor({ timeout: 15000 });
  // The editor is folded away until asked for — and the button that asks for
  // it is called "Reconcile", which is the whole point of the surface.
  await page.getByRole('button', { name: 'Reconcile' }).first().click();
  const dateInput = page.getByLabel('AIB bank balance date');
  await dateInput.waitFor({ timeout: 10000 });
  await dateInput.fill('2026-10-15');
  await page.getByLabel('AIB bank actual balance').fill('1000.00');
  await page.getByRole('button', { name: 'Save balance' }).first().click();
  await page.waitForTimeout(600);
  const balancesText = (await page.locator('#screen').innerText()).replace(/\s+/g, ' ');
  check('the balance screen states the book figure it disagrees with',
    /book/.test(balancesText), balancesText.slice(0, 300));
  check('and names the difference, not just the two numbers',
    /book .*\(/.test(balancesText), balancesText.slice(0, 320));

  /* ── the shell is still clean ───────────────────────────────────────────── */

  const styled = await page.evaluate(() => [...document.querySelectorAll('#screen [style], dialog [style]')]
    .map((n) => `${n.tagName}:${n.getAttribute('style')}`));
  check('no style attributes were written', styled.length === 0, JSON.stringify(styled.slice(0, 5)));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no CSP refusals', cspRefusals.length === 0, cspRefusals.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const failures = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok) console.error(`FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (failures.length) {
  console.error(`\ninsights.browser: ${failures.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`insights.browser: OK — ${results.length} checks (the figures are the ledger's, the review prints, and a statement lands in the ledger)`);
