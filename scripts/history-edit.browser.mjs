#!/usr/bin/env node
/* Hand-run browser leg for the History edit dialog.
 *
 * `scripts/test-history-edit.mjs` (27th guard) proves what the editor *writes* —
 * every field, the grouped-row arithmetic, the refusals, the replaced version
 * that checkpoint balances and merges read. It cannot prove that the dialog
 * calls it. This leg does: it serves `app/` under its own `_headers` (the strict
 * CSP, no inline anything), unlocks with the built-in PIN, opens the real editor
 * from a real row, saves, and reads the document back out of storage.
 *
 * Deliberately outside `run-guards.mjs` for the same reason the PIN and Data-sheet
 * legs are: it needs Playwright, and this repo has no browser dependency. It
 * resolves Playwright from `../design-system`, like the other two.
 *
 * Run: node scripts/history-edit.browser.mjs
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
const eqJson = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** A local YYYY-MM-DD, `days` before today — the ledger's own calendar day. */
const day = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const entry = (id, date, details, amount, method = 'AIB', category = 'gro', extra = {}) => ({
  id, date, type: 'expense', category, details, amount, method, note: '', createdAt: `${date}T09:00:00.000Z`, ...extra,
});
const fixture = {
  schemaVersion: 2,
  entries: [
    entry('e1', day(2), 'Lidl run', 4.47),
    entry('t1', day(1), 'Move to savings', 50, 'AIB', 'misc', { transferId: 'tr1' }),
    entry('t2', day(1), 'Move to savings', 50, 'Revolut', 'misc', { transferId: 'tr1', type: 'credit' }),
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

const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
const rowFor = (text) => page.locator('.ledger-row').filter({ hasText: text });
const openEditor = async (text) => {
  await rowFor(text).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('dialog.history-dialog').waitFor({ timeout: 5000 });
  return page.locator('dialog.history-dialog');
};

try {
  await page.goto(`${base}/index.html`);
  await page.evaluate((raw) => localStorage.setItem('cents:p/personal/state', raw), JSON.stringify(fixture));
  await page.goto(`${base}/index.html`);
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.net-worth-head .display-num').waitFor({ timeout: 15000 });
  await page.evaluate(() => { location.hash = '#history'; });
  await page.locator('.ledger-row').first().waitFor({ timeout: 15000 });

  /* ── 1. an ordinary edit, through the dialog ─────────────────────────────── */

  const before = (await stored()).entries.find((e) => e.id === 'e1');
  let dialog = await openEditor('Lidl run');
  eq('the editor opens with the row\u2019s description', await dialog.getByLabel('Description').inputValue(), 'Lidl run');
  eq('and its amount, to two decimals', await dialog.getByLabel('Amount in euros').inputValue(), '4.47');
  eq('and its date', await dialog.getByLabel('Date').inputValue(), day(2));
  eq('and its category', await dialog.getByLabel('Category').inputValue(), 'gro');
  eq('and its method', await dialog.getByLabel('Payment method').inputValue(), 'AIB');

  await dialog.getByLabel('Description').fill('Aldi run');
  await dialog.getByLabel('Amount in euros').fill('9.99');
  await dialog.getByLabel('Date').fill(day(0));
  await dialog.getByLabel('Category').selectOption('travel');
  await dialog.getByLabel('Payment method').selectOption('Revolut');
  await dialog.getByLabel('Note').fill('moved to Revolut');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('dialog.history-dialog').waitFor({ state: 'detached', timeout: 5000 });

  const after = (await stored()).entries.find((e) => e.id === 'e1');
  eq('the description is saved', after.details, 'Aldi run');
  eq('the amount is saved', after.amount, 9.99);
  eq('the date is saved', after.date, day(0));
  eq('the category is saved', after.category, 'travel');
  eq('the method is saved', after.method, 'Revolut');
  eq('the note is saved', after.note, 'moved to Revolut');
  eq('the creation moment is kept', after.createdAt, before.createdAt);
  check('the edit is stamped after creation', Date.parse(after.updatedAt) > Date.parse(after.createdAt), after.updatedAt);
  eq('the replaced version is recorded', (after.mutationHistory || []).length, 1);
  eq('and it holds the old amount', (after.mutationHistory || [])[0]?.amount, 4.47);
  eq('and the old date', (after.mutationHistory || [])[0]?.date, day(2));
  eq('and the old category', (after.mutationHistory || [])[0]?.category, 'gro');
  eq('and the old method', (after.mutationHistory || [])[0]?.method, 'AIB');
  eq('the stamp matches the last version it replaced', after.updatedAt, (after.mutationHistory || [])[0]?.at);

  await page.evaluate(() => { location.hash = '#dashboard'; });
  await page.evaluate(() => { location.hash = '#history'; });
  await page.locator('.ledger-row').first().waitFor({ timeout: 15000 });
  check('the row shows the edit after a route change', (await rowFor('Aldi run').innerText()).includes('Travel'), await rowFor('Aldi run').innerText());

  /* ── 2. a refusal writes nothing at all ──────────────────────────────────── */

  const untouched = (await stored()).entries.find((e) => e.id === 'e1');
  dialog = await openEditor('Aldi run');
  // A date beyond `max` never reaches the handler: the browser's own constraint
  // validation stops the submit first, which is the right behaviour and is why
  // the reachable refusal is the amount one.
  await dialog.getByLabel('Amount in euros').fill('0');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(150);
  check('the dialog stays open on a refusal', await page.locator('dialog.history-dialog').isVisible());
  eq('the refusal says what is wrong', (await page.locator('dialog.history-dialog .add-status').innerText()).trim(), 'Enter an amount greater than zero.');
  eqJson('and the stored entry is untouched', (await stored()).entries.find((e) => e.id === 'e1'), untouched);
  await page.locator('dialog.history-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('dialog.history-dialog').waitFor({ state: 'detached', timeout: 5000 });

  /* ── 3. a transfer row edits both legs as one payment ───────────────────── */

  dialog = await openEditor('Move to savings');
  await dialog.getByLabel('Amount in euros').fill('75');
  await dialog.getByLabel('Description').fill('Moved to savings');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('dialog.history-dialog').waitFor({ state: 'detached', timeout: 5000 });
  const legs = (await stored()).entries.filter((e) => e.transferId === 'tr1');
  eqJson('both legs take the typed amount', legs.map((e) => e.amount), [75, 75]);
  eqJson('both legs carry the new description', legs.map((e) => e.details), ['Moved to savings', 'Moved to savings']);
  eqJson('both legs record their replaced version', legs.map((e) => (e.mutationHistory || []).length), [1, 1]);
  eq('the pair is still one row', await rowFor('Moved to savings').count(), 1);

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));
  check('no CSP refusals', cspRefusals.length === 0, cspRefusals.join('; '));
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.close(done));
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`history-edit: ${failed.length} of ${results.length} checks failed:`);
  for (const r of failed) console.error(`  x ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
  process.exit(1);
}
console.log(`history-edit: OK — ${results.length} checks passed (the History dialog writes every field through the real form, records the version it replaced, refuses a zero amount without touching the document, and edits a transfer as one payment).`);
