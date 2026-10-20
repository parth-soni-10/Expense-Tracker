#!/usr/bin/env node
/* Hand-run browser leg for the Data sheet (slice 5).
 *
 * Deliberately outside `run-guards.mjs` for the same reason the PIN leg is:
 * it needs Playwright, and adding that to this repo would put a browser
 * download in front of every deploy. It resolves Playwright the same way
 * pin-screens.browser.mjs does, serves app/ under the production CSP from
 * app/_headers, and drives the sheet the way a person would: open it, read the
 * four facts, export both files, restore a backup, import a CSV, map and import
 * a bank statement, reset and undo it, and recover a quarantined copy.
 *
 * Run: node scripts/data-sheet.browser.mjs
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
const fixture = {
  schemaVersion: 2,
  entries: [entry('e1', '2026-10-12', 'Lidl Groceries', 4.47), entry('e2', '2026-10-13', 'Tesco', 12.4)],
  settings: {},
  tesco: { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
const cspRefusals = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) cspRefusals.push(m.text()); });

try {
  await page.goto(`${base}/index.html`);
  await page.evaluate((raw) => localStorage.setItem('cents:p/personal/state', raw), JSON.stringify(fixture));
  await page.goto(`${base}/index.html`);
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('.pin-lock').waitFor({ state: 'detached', timeout: 15000 });
  await page.locator('.net-worth-head .display-num').waitFor({ timeout: 15000 });

  // Data lives in the nav, beside the tabs, and opens a sheet.
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor({ timeout: 5000 });
  const sheet = page.locator('dialog#data-sheet');
  const text = async () => (await sheet.innerText()).replace(/\s+/g, ' ').trim();
  // The size row is refined once the browser answers whether storage is
  // persistent; wait for the finished sentence rather than racing the await.
  await page.waitForFunction(() => /(KB|MB) · (persistent|best-effort|persistence unknown)/.test(document.querySelector('#data-sheet')?.textContent || ''), null, { timeout: 5000 });
  const body = await text();
  check('the sheet reports the entry count', /entries 2 entries/i.test(body), body.slice(0, 200));
  check('it reports a real document size', /on this device \d+ (kb|mb) · (persistent|best-effort|persistence unknown)/i.test(body), body.slice(0, 260));
  check('cloud sync says Off rather than implying a sync', /cloud sync\s+sync off/i.test(body), body.slice(0, 260));
  check('no cloud copy is said out loud for the mirror', /github mirror no cloud copy/i.test(body), body.slice(0, 320));
  const styled = await sheet.evaluate((el) => [...el.querySelectorAll('[style]')].map((n) => `${n.tagName}:${n.getAttribute('style')}`));
  check('the data rows carry no style attributes', styled.length === 0, JSON.stringify(styled));
  if (styled.length) console.log('STYLED:', styled.slice(0, 5));

  // Export JSON: a real download, with the document in it.
  const [jsonDownload] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: /Export data/ }).click()]);
  check('the JSON export is named for the day', /^expenses-\d{4}-\d{2}-\d{2}\.json$/.test(jsonDownload.suggestedFilename()), jsonDownload.suggestedFilename());
  const jsonText = readFileSync(await jsonDownload.path(), 'utf8');
  const exported = JSON.parse(jsonText);
  check('the JSON export carries both entries', exported.entries.length === 2, exported.entries.length);
  check('and carries no PIN material', !('pinHash' in (exported.settings || {})), JSON.stringify(Object.keys(exported.settings || {})));

  // Export CSV.
  const [csvDownload] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: /Export CSV/ }).click()]);
  const csvText = readFileSync(await csvDownload.path(), 'utf8');
  check('the CSV export names the columns', csvText.replace(/^\uFEFF/, '').split('\r\n')[0] === 'Date,Type,Category,Details,Amount,Method,Note', JSON.stringify(csvText.split('\r\n')[0]));
  check('the CSV carries readable labels', csvText.includes('Groceries'), csvText.slice(0, 300));
  check('the CSV money is two decimals', csvText.includes('12.40'), csvText.slice(0, 300));

  // Restore the same document back: nothing to restore, not a fake success.
  let chooser = page.waitForEvent('filechooser');
  await sheet.getByRole('button', { name: /Restore from backup/ }).click();
  let fc = await chooser;
  await fc.setFiles({ name: jsonDownload.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(jsonText) });
  await page.waitForFunction(() => (document.querySelector('#data-sheet')?.textContent || '').includes('Nothing to restore'), null, { timeout: 10000 });
  check('an identical backup is reported as nothing to restore', true);

  // Import a CSV with one new row: mapping by name, merge through confirm.
  const csv = '\uFEFFDate,Type,Category,Details,Amount,Method,Note\r\n2026-10-14,expense,Groceries,Aldi,8.20,AIB bank,\r\n';
  chooser = page.waitForEvent('filechooser');
  await sheet.getByRole('button', { name: /Import CSV/ }).click();
  fc = await chooser;
  await fc.setFiles({ name: 'expenses.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor({ state: 'detached', timeout: 10000 });
  const countAfterCsv = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).entries.length);
  eq('the CSV import adds its one row', countAfterCsv, 3);
  eq('and labels resolve back to ids', await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).entries.find((e) => e.details === 'Aldi')?.category), 'gro');

  // A JSON restore that actually merges: one new row, a newer copy of an
  // existing row, and two rows the file never mentions (which must survive).
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor();
  const mergeBackup = {
    schemaVersion: 2,
    entries: [
      entry('e1', '2026-10-12', 'Lidl Groceries', 4.47),
      { ...entry('e2', '2026-10-13', 'Tesco', 20), createdAt: '2026-10-14T09:00:00.000Z' },
      entry('e3', '2026-10-11', 'Rewe', 9.99),
    ],
    settings: {},
    tesco: { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] },
  };
  chooser = page.waitForEvent('filechooser');
  await page.locator('dialog#data-sheet').getByRole('button', { name: /Restore from backup/ }).click();
  fc = await chooser;
  await fc.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(mergeBackup)) });
  await page.locator('dialog.history-dialog').waitFor();
  await page.locator('dialog.history-dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor({ state: 'detached', timeout: 10000 });
  const merged = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).entries);
  eq('the backup adds its one new row', merged.length, 4);
  eq('the newer copy of a row wins', merged.find((e) => e.id === 'e2')?.amount, 20);
  eq('a row the file never mentions is kept', merged.filter((e) => e.id === 'e2').length, 1);
  check('the CSV row is still here after the restore', merged.some((e) => e.details === 'Aldi'), JSON.stringify(merged.map((e) => e.details)));

  // Bank statement: headerless-ish AIB shape with a signature guess, preview, commit.
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor();
  const bank = 'Date,Description,Amount (eur)\r\n15/10/2026,LIDL 1234,-6.75\r\n16/10/2026,SALARY ACME,2500.00\r\n';
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import bank statement/ }).click();
  const bankDialog = page.locator('dialog.bank-dialog');
  await bankDialog.waitFor();
  await page.getByRole('button', { name: 'Choose CSV file' }).click();
  fc = await chooser;
  await fc.setFiles({ name: 'aib.csv', mimeType: 'text/csv', buffer: Buffer.from(bank) });
  await bankDialog.getByText('2 transactions ready').waitFor({ timeout: 10000 });
  const bankText = (await bankDialog.innerText()).replace(/\s+/g, ' ');
  check('the bank mapper previews what it will write', /2 transactions ready/.test(bankText), bankText.slice(0, 200));
  check('and guesses the date column from the cells', await bankDialog.locator('select[aria-label="Date column"]').inputValue() === '0');
  check('and the amount column from the header', await bankDialog.locator('select[aria-label="Amount column"]').inputValue() === '2');
  await bankDialog.getByRole('button', { name: /^Import 2$/ }).click();
  await bankDialog.waitFor({ state: 'detached', timeout: 10000 });
  const afterBank = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).entries);
  eq('the bank import commits both rows', afterBank.length, 6);
  eq('the day-first date is read as a day', afterBank.find((e) => e.details.includes('LIDL'))?.date, '2026-10-15');
  eq('the debit is an expense', afterBank.find((e) => e.details.includes('LIDL'))?.type, 'expense');
  eq('the credit is income', afterBank.find((e) => e.details.includes('SALARY'))?.type, 'credit');

  // Reset, then undo: the sheet's one destructive action has to be reversible.
  // The Data sheet is still open behind the bank dialog, so it is used as it is.
  await page.locator('dialog#data-sheet').waitFor();
  await page.getByRole('button', { name: /Reset all data/ }).click();
  await page.locator('dialog.history-dialog').waitFor();
  await page.locator('dialog.history-dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor({ state: 'detached' });
  eq('reset clears the ledger', await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).entries.length), 0);
  await page.getByRole('button', { name: 'Undo' }).click();
  eq('undo restores it', await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).entries.length), 6);

  // The quarantine offer only exists when a copy does.
  await page.evaluate(() => localStorage.setItem('cents:p/personal/quarantine', '{"entries": [broken'));
  await page.reload();
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('.pin-lock').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.locator('dialog#data-sheet').waitFor();
  check('an unreadable copy is offered back', (await page.locator('dialog#data-sheet').innerText()).includes('Recover unreadable copy'));

  // ...and it downloads, byte for byte, when it cannot be merged.
  const [rawDownload] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: /Recover unreadable copy/ }).click();
      await page.locator('dialog.history-dialog').waitFor();
      await page.locator('dialog.history-dialog').getByRole('button', { name: 'Download', exact: true }).click();
    })(),
  ]);
  check('the kept copy downloads as a file', /^cents-unreadable-\d{4}-\d{2}-\d{2}\.json$/.test(rawDownload.suggestedFilename()), rawDownload.suggestedFilename());
  eq('with the bytes that were kept', readFileSync(await rawDownload.path(), 'utf8'), '{"entries": [broken');

  // Mobile: the sheet must fit without horizontal overflow.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.locator('dialog#data-sheet').evaluate((el) => el.scrollTo(0, 0));
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sheet: (() => { const s = document.querySelector('dialog#data-sheet'); return s ? s.scrollWidth - s.clientWidth : 0; })(),
  }));
  eq('no horizontal overflow at 390px (document)', overflow.doc, 0);
  eq('no horizontal overflow at 390px (sheet)', overflow.sheet, 0);
  check('the sheet renders at 390px', await page.locator('dialog#data-sheet .data-action').count() >= 5);

  eq('no page errors', pageErrors.length, 0);
  eq('no CSP refusals', cspRefusals.length, 0);
} catch (error) {
  // A leg that throws must still say how far it got: the checks that ran are
  // listed below, and the exception is the one that stopped it.
  check('the leg ran to the end', false, error.message.slice(0, 200));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok) console.error(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\ndata-sheet: ${failed.length ? `${failed.length} FAILED, ` : ''}${results.length - failed.length} passed`);
process.exit(failed.length ? 1 : 0);
