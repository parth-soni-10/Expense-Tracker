#!/usr/bin/env node
/* Hand-run browser leg for the Settings sheet, the payment-method manager and
 * the recurring manager.
 *
 * Deliberately outside `run-guards.mjs` for the same reason the PIN leg is:
 * it needs Playwright, and adding that to this repo would put a browser
 * download in front of every deploy. It resolves Playwright the same way
 * pin-screens.browser.mjs does, serves app/ under the production CSP from
 * app/_headers, and drives the surfaces the way a person would.
 *
 * What it proves, and why each one needs a browser rather than a Node guard:
 *
 *   · the THEME toggle flips once. A guard can check the key is written in one
 *     place; only a browser can show that one click is one flip, that the
 *     header's control and the sheet's control agree, and that the choice
 *     survives a reload.
 *   · a method the user ADDS reaches the entry picker. The rules are pinned in
 *     Node (test-methods.mjs); what Node cannot see is the select on the Add
 *     screen actually offering it.
 *   · a method the user TAKES OUT leaves the pickers and nothing else. The
 *     history that named it must still validate and still be named — the
 *     failure mode is silent, and a browser can read the screen.
 *   · a RECURRING rule is scheduled, and "Paid" logs it once and advances the
 *     schedule, so the same charge cannot be paid twice.
 *
 * Run: node scripts/settings.browser.mjs
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
  entries: [
    entry('e1', '2026-10-12', 'Lidl Groceries', 4.47, 'Revolut'),
    entry('e2', '2026-10-13', 'Tesco', 12.4, 'AIB'),
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

const unlock = async () => {
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('.pin-lock').waitFor({ state: 'detached', timeout: 15000 });
};

/** Close every open sheet. They are real modals, so one covers the next and
 *  the nav underneath — a person would dismiss them the same way. */
const closeSheets = async () => {
  for (let guard = 0; guard < 5; guard += 1) {
    const open = await page.locator('dialog[open]').count();
    if (!open) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
};

try {
  await page.goto(`${base}/index.html`);
  await page.evaluate((raw) => localStorage.setItem('cents:p/personal/state', raw), JSON.stringify(fixture));
  await page.goto(`${base}/index.html`);
  await unlock();
  await page.locator('#screen .app-title').waitFor({ timeout: 15000 });

  /* ── the theme toggle ──────────────────────────────────────────────────── */

  eq('the theme starts light', await page.evaluate(() => document.documentElement.dataset.theme || 'light'), 'light');
  eq('nothing is stored yet', await page.evaluate(() => localStorage.getItem('cents-theme')), null);

  const headerToggle = page.locator('.app-theme-toggle');
  check('the header carries a theme toggle', await headerToggle.count() === 1);
  await headerToggle.click();
  eq('one click is one flip', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  eq('the choice is remembered', await page.evaluate(() => localStorage.getItem('cents-theme')), 'dark');
  await headerToggle.click();
  eq('a second click flips it back', await page.evaluate(() => document.documentElement.dataset.theme || 'light'), 'light');

  // The sheet's control and the header's control are two views of one fact.
  // The sheet is a modal, so the header's control is behind it — the sheet
  // carries its own, and the two agree.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.locator('dialog#settings-sheet');
  await sheet.waitFor({ timeout: 5000 });
  const sheetToggle = sheet.getByRole('button', { name: /Use the (dark|light) theme/ });
  check('the sheet carries a theme control', await sheetToggle.count() === 1);
  await sheetToggle.click();
  eq('the sheet control flips the theme once', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  eq('the header control agrees', await headerToggle.getAttribute('aria-pressed'), 'true');
  await sheetToggle.click();
  eq('and back again', await page.evaluate(() => document.documentElement.dataset.theme || 'light'), 'light');
  await sheet.getByRole('button', { name: 'Close settings' }).click();
  await sheet.waitFor({ state: 'detached', timeout: 5000 });

  // Per-device persistence: the choice survives a reload.
  await headerToggle.click();
  await page.reload();
  await unlock();
  eq('the choice survives a reload', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  eq('and the key is still the only one', await page.evaluate(() => localStorage.getItem('cents-theme')), 'dark');
  await page.evaluate(() => localStorage.setItem('cents-theme', 'light'));
  await page.reload();
  await unlock();
  eq('and a device that chose light reads as light', await page.evaluate(() => document.documentElement.dataset.theme || 'light'), 'light');

  /* ── the payment-method manager ────────────────────────────────────────── */

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#settings-sheet').waitFor({ timeout: 5000 });
  await page.locator('dialog#settings-sheet').getByRole('button', { name: 'Manage' }).first().click();
  const manager = page.locator('dialog#method-manager');
  await manager.waitFor({ timeout: 5000 });
  check('the manager lists the built-ins', (await manager.innerText()).includes('AIB bank'));

  await manager.getByLabel('New method name').fill('Credit Union');
  await manager.getByRole('button', { name: 'Add method' }).click();
  check('the new method is in the list', (await manager.innerText()).includes('Credit Union'));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  check('it was written to the document', stored.settings.customMethods?.some((m) => m.id === 'credit-union'),
    JSON.stringify(stored.settings.customMethods));
  eq('and it is not hidden', stored.settings.methodHidden?.['credit-union'] ?? false, false);

  // The entry picker must offer it.
  await closeSheets();
  await page.evaluate(() => { location.hash = '#add?more=1'; });
  await page.locator('#entry-method').waitFor({ timeout: 5000 });
  const options = await page.locator('#entry-method option').allTextContents();
  check('the entry picker offers the new method', options.includes('Credit Union'), JSON.stringify(options));
  check('and it still offers the built-ins', options.includes('AIB bank'), JSON.stringify(options));

  // A method taken out leaves the pickers and NOTHING else.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#settings-sheet').waitFor({ timeout: 5000 });
  await page.locator('dialog#settings-sheet').getByRole('button', { name: 'Manage' }).first().click();
  await page.locator('dialog#method-manager').waitFor({ timeout: 5000 });
  await page.locator('dialog#method-manager').getByRole('button', { name: 'Delete Credit Union' }).click();
  const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  eq('it is hidden', afterDelete.settings.methodHidden?.['credit-union'], true);
  check('but it is STILL a valid method — it stays in customMethods',
    afterDelete.settings.customMethods?.some((m) => m.id === 'credit-union'),
    JSON.stringify(afterDelete.settings.customMethods));
  check('and the entry that used it still validates',
    afterDelete.entries.length === 2, JSON.stringify(afterDelete.entries.map((e) => e.id)));
  check('and it still keeps its own method', afterDelete.entries[0].method === 'Revolut',
    afterDelete.entries[0].method);

  await closeSheets();
  await page.evaluate(() => { location.hash = '#add?more=1'; });
  await page.locator('#entry-method').waitFor({ timeout: 5000 });
  const afterOptions = await page.locator('#entry-method option').allTextContents();
  check('the picker no longer offers it', !afterOptions.includes('Credit Union'), JSON.stringify(afterOptions));
  check('but it still offers the built-ins', afterOptions.includes('AIB bank'), JSON.stringify(afterOptions));

  // And it can be restored.
  await closeSheets();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#settings-sheet').waitFor({ timeout: 5000 });
  await page.locator('dialog#settings-sheet').getByRole('button', { name: 'Manage' }).first().click();
  await page.locator('dialog#method-manager').waitFor({ timeout: 5000 });
  await page.locator('dialog#method-manager').getByRole('button', { name: 'Restore Credit Union' }).click();
  const afterRestore = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  eq('the restore is an explicit false, not an absent key', afterRestore.settings.methodHidden?.['credit-union'], false);
  check('and the key is still there', 'credit-union' in (afterRestore.settings.methodHidden || {}));

  /* ── the recurring manager ─────────────────────────────────────────────── */

  await closeSheets();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#settings-sheet').waitFor({ timeout: 5000 });
  await page.locator('dialog#settings-sheet').getByRole('button', { name: 'Manage' }).nth(1).click();
  const recurring = page.locator('dialog#recurring-manager');
  await recurring.waitFor({ timeout: 5000 });

  await recurring.getByLabel('What repeats').fill('Rent');
  await recurring.getByLabel('Amount in euros').fill('1200');
  await recurring.getByLabel('How often it repeats').selectOption('monthly');
  await recurring.getByLabel('Day of the month').fill('1');
  await recurring.getByRole('button', { name: 'Add', exact: true }).click();
  const recurringText = (await recurring.innerText()).replace(/\s+/g, ' ');
  check('the rule is listed with its cadence', /Rent/.test(recurringText) && /Monthly/.test(recurringText), recurringText.slice(0, 220));
  check('and with the date it next lands on', /\d{4}-\d{2}-\d{2}/.test(recurringText), recurringText.slice(0, 220));
  const withRule = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  eq('one rule was written', withRule.settings.recurring?.length, 1);
  const nextDate = withRule.settings.recurring[0].nextDate;
  check('and it lands on the first of a month', /-01$/.test(nextDate), nextDate);
  check('and it is in the future', nextDate >= new Date().toISOString().slice(0, 10), nextDate);

  // One-tap completion: it logs the occurrence and advances the schedule, so
  // the same charge cannot be paid twice.
  const before = withRule.entries.length;
  await recurring.getByRole('button', { name: 'Pay Rent' }).click();
  const afterPay = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  eq('paying logs one entry', afterPay.entries.length, before + 1);
  check('and the entry is the charge', afterPay.entries.some((e) => e.details === 'Rent' && e.amount === 1200),
    JSON.stringify(afterPay.entries.map((e) => e.details)));
  check('and the schedule advanced past it', afterPay.settings.recurring[0].nextDate > nextDate,
    `${nextDate} -> ${afterPay.settings.recurring[0].nextDate}`);

  // And the toast offers the undo.
  const toastText = await page.locator('.app-toast').innerText().catch(() => '');
  check('the toast offers an undo', /Undo/.test(toastText), toastText);
  await page.locator('.app-toast-action').click();
  const afterUndo = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));
  eq('undo takes the entry back', afterUndo.entries.length, before);
  eq('and puts the schedule back', afterUndo.settings.recurring[0].nextDate, nextDate);

  /* -- the lock ------------------------------------------------------------ */

  await closeSheets();

  // Setting a PIN: the credential lives on the DEVICE, outside the document,
  // so it is never synced and never travels with a backup.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#settings-sheet').waitFor({ timeout: 5000 });
  await page.getByLabel('New PIN').fill('4321');
  await page.getByRole('button', { name: 'Set PIN', exact: true }).click();
  await page.waitForTimeout(300);
  const deviceKeys = await page.evaluate(() => Object.keys(localStorage));
  check('the PIN is written to the device, not into the document',
    deviceKeys.some((k) => k.startsWith('cents:p/personal/privacy')), deviceKeys.join(', '));
  const documentHasPin = await page.evaluate(
    () => 'pinHash' in (JSON.parse(localStorage.getItem('cents:p/personal/state')).settings || {}));
  check('and the document carries no PIN', documentHasPin === false);

  // Locking now: the same door the idle clock uses.
  await page.getByRole('button', { name: 'Lock now' }).click();
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 5000 });
  check('the app is hidden behind the lock', await page.evaluate(() => document.getElementById('app').hidden === true));

  // The new PIN is the one that opens it; the built-in one is not.
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.waitForTimeout(400);
  check('the built-in PIN no longer opens it', await page.locator('input[aria-label="PIN"]').count() > 0);
  await page.locator('input[aria-label="PIN"]').fill('4321');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.waitForTimeout(600);
  check('the PIN of your own does', await page.locator('input[aria-label="PIN"]').count() === 0);

  // A hidden window is COVERED, never locked: the app-switcher snapshot is
  // taken while hidden, and a tab switch is not an absence.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  check('a hidden window is covered', await page.locator('#privacy-cover').count() === 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  check('and the cover comes down on the way back', await page.locator('#privacy-cover').count() === 0);
  check('and the app was never locked by hiding it', await page.locator('input[aria-label="PIN"]').count() === 0);
  /* -- the profiles ------------------------------------------------------- */

  await closeSheets();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#settings-sheet').waitFor({ timeout: 5000 });
  await page.getByLabel('New profile name').fill('Sam');
  await page.getByRole('button', { name: 'Add profile' }).click();
  await page.waitForTimeout(300);
  const registry = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:profiles')));
  check('a profile can be created', registry.profiles.some((p) => p.name === 'Sam'),
    JSON.stringify(registry.profiles));
  check('and it has its own id', registry.profiles.some((p) => p.id === 'sam'),
    JSON.stringify(registry.profiles.map((p) => p.id)));

  // The admin's door: the owner may manage people, and the tab chips write
  // into the TARGET's document.
  await page.getByRole('button', { name: 'Manage people' }).click();
  const admin = page.locator('dialog#admin-panel');
  await admin.waitFor({ timeout: 5000 });
  check('the admin panel lists the people', (await admin.innerText()).includes('Sam'),
    (await admin.innerText()).slice(0, 200));
  const chip = admin.getByRole('button', { name: /Tesco Pay for Sam: (shown|hidden)/ });
  await chip.waitFor({ timeout: 5000 });
  const wasOn = /shown/.test(await chip.getAttribute('aria-label'));
  await chip.click();
  await page.waitForTimeout(400);
  const samsDoc = await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/sam/state') || 'null'));
  const tabs = samsDoc?.settings?.enabledTabs || [];
  check('a tab change is written to THAT profile\'s document',
    wasOn ? !tabs.includes('tesco') : tabs.includes('tesco'), JSON.stringify(tabs));
  /* ── the shell is still clean ──────────────────────────────────────────── */

  const styled = await page.evaluate(() => [...document.querySelectorAll('#screen [style], dialog [style]')]
    .map((n) => `${n.tagName}:${n.getAttribute('style')}`));
  check('no style attributes were written', styled.length === 0, JSON.stringify(styled.slice(0, 5)));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no CSP refusals', cspRefusals.length === 0, cspRefusals.slice(0, 3).join(' | '));

  const keys = await page.evaluate(() => Object.keys(localStorage));
  check('only the expected keys were written', keys.every((k) => k === 'cents:p/personal/state' || k === 'cents:profiles' || k === 'cents-theme' || k.startsWith('cents:p/personal/') || k.startsWith('cents:p/sam/')),
    keys.join(', '));
} finally {
  await browser.close();
  server.close();
}

const failures = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok) console.error(`FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (failures.length) {
  console.error(`\nsettings.browser: ${failures.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`settings.browser: OK — ${results.length} checks (the theme flips once and persists, a method reaches the pickers, a schedule lands on the day it says)`);
