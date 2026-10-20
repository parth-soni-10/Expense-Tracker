#!/usr/bin/env node
/* Hand-run browser leg for the Tesco Pay write surfaces.
 *
 * Outside `run-guards.mjs` for the same reason the other browser legs are: it
 * needs Playwright, and adding that to this repo would put a browser download
 * in front of every deploy. It resolves Playwright the way pin-screens does,
 * serves app/ under the production CSP from app/_headers, and drives the sheet
 * the way a person would.
 *
 * What it proves, and why each one needs a browser rather than a Node guard:
 *
 *   · QUICK ENTRY — one shift per line, every line previewed before any of it
 *     is written, and ONE BAD LINE BLOCKS THE BATCH. A half-written week is
 *     worse than a week that was not written: the pay figure for it would be
 *     short, and nobody would notice until the money did not add up.
 *   · THE FORM — the same row, typed field by field, and the same rules an
 *     import applies.
 *   · A WEEK OFF — hours and no clock times, dated on the week's own Sunday.
 *   · DUPLICATE SUPPRESSION — the same shift twice is one shift, and a hand
 *     edit onto another shift's slot is refused.
 *   · THE RATE CARD — a rule is written through as it is typed, and the Sunday
 *     rate is DERIVED from the normal rate and the multiplier.
 *   · THE FILE OUT AND BACK IN — the export is the sheet's own columns, and
 *     re-importing it does not double a run.
 *   · THE LAZY BOUNDARY — SheetJS is 245 KB, and it must never be in the boot
 *     path. The leg asserts the vendor file is NOT requested until a workbook
 *     is actually chosen, and that the boot bundle does not carry it.
 *
 * Run: node scripts/tesco-sheet.browser.mjs
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

const fixture = {
  schemaVersion: 2,
  entries: [],
  settings: {},
  tesco: { shifts: [], payslips: [], deletedShiftIds: [], deletedPayslipIds: [] },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const cspRefusals = [];
const requested = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) cspRefusals.push(m.text()); });
page.on('request', (r) => requested.push(r.url()));

const unlock = async () => {
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
};
const tescoState = () => page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')));

try {
  await page.goto(`${base}/index.html`);
  await page.evaluate((raw) => localStorage.setItem('cents:p/personal/state', raw), JSON.stringify(fixture));
  await page.goto(`${base}/index.html`);
  await unlock();
  await page.evaluate(() => { location.hash = '#tesco'; });
  await page.locator('#screen .tesco-section').waitFor({ timeout: 15000 });

  /* ── the lazy boundary ──────────────────────────────────────────────────── */

  check('SheetJS is NOT in the boot path',
    !requested.some((u) => u.includes('xlsx')), requested.filter((u) => u.includes('xlsx')).join(', '));
  const bundle = readFileSync(join(root, 'dist', 'main.js'), 'utf8');
  // The bundle may NAME the vendor file — the loader has to know where to
  // fetch it from — but it must not carry the library. 245 KB of SheetJS in
  // the boot path would be the failure this boundary exists to prevent.
  check('and the boot bundle does not carry the library itself',
    bundle.length < 500_000, `${Math.round(bundle.length / 1024)} KB`);
  // `parse_zip` is an internal name inside the library. The app never mentions
  // it, so finding it in the bundle would mean the library itself is in there.
  // marker for the LIBRARY being in the bundle rather than for the app
  // asking for it.
  check('the bundle has no SheetJS code in it', !bundle.includes('parse_zip'));

  /* ── the quick entry card ───────────────────────────────────────────────── */

  const quick = page.locator('.tesco-quick-text');
  await quick.waitFor({ timeout: 5000 });
  await quick.fill('mon 8-4\ntue 12:30-20:15');
  await page.waitForTimeout(150);
  const previewRows = await page.locator('.tesco-quick-row').count();
  eq('both lines are previewed before anything is written', previewRows, 2);

  await page.getByRole('button', { name: 'Add shifts' }).click();
  await page.waitForTimeout(250);
  let stored = await tescoState();
  eq('both shifts are stored', stored.tesco.shifts.length, 2);
  check('the first shift reads 08:00 to 16:00',
    stored.tesco.shifts.some((s) => s.start === '08:00' && s.end === '16:00'),
    JSON.stringify(stored.tesco.shifts));
  check('the second reads 12:30 to 20:15',
    stored.tesco.shifts.some((s) => s.start === '12:30' && s.end === '20:15'));

  /* ── one bad line blocks the batch ──────────────────────────────────────── */

  await quick.fill('mon 8-4\nnonsense line\ntue 9-5');
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Add shifts' }).click();
  await page.waitForTimeout(250);
  stored = await tescoState();
  eq('a bad line means NOTHING is added', stored.tesco.shifts.length, 2);
  const status = await page.locator('.tesco-card .add-status').first().innerText().catch(() => '');
  check('and the refusal says so', /could not be read|nothing was added/i.test(status), status);

  /* ── duplicate suppression ──────────────────────────────────────────────── */

  await quick.fill('mon 8-4');
  await page.waitForTimeout(120);
  await page.getByRole('button', { name: 'Add shifts' }).click();
  await page.waitForTimeout(250);
  stored = await tescoState();
  eq('the same shift twice is one shift', stored.tesco.shifts.length, 2);

  /* ── the form ───────────────────────────────────────────────────────────── */

  await page.getByLabel('Shift date').fill('2026-10-15');
  await page.getByLabel('Start time', { exact: true }).fill('09:00');
  await page.getByLabel('End time', { exact: true }).fill('17:00');
  await page.getByRole('button', { name: 'Add shift', exact: true }).click();
  await page.waitForTimeout(250);
  stored = await tescoState();
  eq('a typed shift is stored', stored.tesco.shifts.length, 3);
  check('with the date and times it was given',
    stored.tesco.shifts.some((s) => s.date === '2026-10-15' && s.start === '09:00' && s.end === '17:00'));

  // A row with neither times nor hours is refused, with a reason.
  await page.getByLabel('Shift date').fill('2026-10-16');
  await page.getByLabel('Start time', { exact: true }).fill('');
  await page.getByLabel('End time', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Add shift', exact: true }).click();
  await page.waitForTimeout(200);
  stored = await tescoState();
  eq('a shift with no times and no hours is refused', stored.tesco.shifts.length, 3);

  /* ── the week off ───────────────────────────────────────────────────────── */

  await page.getByLabel('Week off date').fill('2026-10-21');
  await page.getByLabel('Hours of pay').first().fill('7');
  await page.getByRole('button', { name: 'Book week off' }).click();
  await page.waitForTimeout(250);
  stored = await tescoState();
  const weekOff = stored.tesco.shifts.find((s) => s.hours === 7 && !s.start);
  check('a week off is stored with hours and no clock times', !!weekOff, JSON.stringify(stored.tesco.shifts));
  check('and it is dated on the week\'s Sunday', weekOff && weekOff.date === '2026-10-18',
    weekOff ? weekOff.date : '');

  /* ── the rate card ──────────────────────────────────────────────────────── */

  const normalField = page.getByLabel('Normal per hour');
  await normalField.fill('20');
  await page.waitForTimeout(250);
  stored = await tescoState();
  eq('a rate is written through as it is typed', stored.settings.tescoRates.normal, 20);
  const sunday = await page.locator('.tesco-derived').innerText();
  check('the Sunday rate is DERIVED from the normal rate and the multiplier',
    /=\s*€?30(\.00)?\/h/.test(sunday), sunday);

  /* ── the export, and the file back in ───────────────────────────────────── */

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]).then(([d]) => d);
  const csvPath = await download.path();
  const csv = readFileSync(csvPath, 'utf8');
  check('the export is the sheet\'s own columns',
    csv.includes('Start Time') && csv.includes('End Time') && csv.includes('Final Bank Pay'),
    csv.split('\n')[0]);
  check('and it carries every shift', csv.split('\n').filter((l) => l.includes(',')).length >= 4,
    `${csv.split('\n').length} lines`);

  // Re-importing the same file must not double a run.
  await page.getByLabel('Import a Tesco Pay file').setInputFiles({
    name: 'tesco-pay.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
  });
  await page.waitForTimeout(500);
  stored = await tescoState();
  eq('re-importing the same file adds nothing', stored.tesco.shifts.length, 4);

  /* ── the shift editor ───────────────────────────────────────────────────── */

  await page.getByRole('button', { name: 'Edit shift on 2026-10-15' }).click();
  const editor = page.locator('dialog#tesco-shift-editor');
  await editor.waitFor({ timeout: 5000 });
  await editor.getByLabel('End time').fill('18:00');
  await editor.getByRole('button', { name: 'Save shift' }).click();
  await page.waitForTimeout(400);
  stored = await tescoState();
  check('an edit is saved', stored.tesco.shifts.some((s) => s.date === '2026-10-15' && s.end === '18:00'),
    JSON.stringify(stored.tesco.shifts));

  // An edit onto another shift's slot is refused — the same reason an import
  // of it would be. "mon" on 20 October 2026 is the 19th, so this edit tries
  // to put it on the 15th's shift.
  await page.getByRole('button', { name: 'Edit shift on 2026-10-19' }).click();
  await editor.waitFor({ timeout: 5000 });
  await editor.getByLabel('Shift date').fill('2026-10-15');
  await editor.getByLabel('Start time').fill('09:00');
  await editor.getByLabel('End time').fill('18:00');
  await editor.getByRole('button', { name: 'Save shift' }).click();
  await page.waitForTimeout(300);
  stored = await tescoState();
  const onTheFifteenth = stored.tesco.shifts.filter((s) => s.date === '2026-10-15').length;
  eq('an edit onto another shift\'s slot is refused', onTheFifteenth, 1);
  const editorStatus = await editor.locator('.add-status').innerText().catch(() => '');
  check('and it says why', /already covers the same times/i.test(editorStatus), editorStatus);
  await page.keyboard.press('Escape');

  /* ── the lazy boundary, from the other side ─────────────────────────────── */

  // Choosing a WORKBOOK is what fetches the library. A CSV must never wait on
  // 245 KB it will not use, and a boot must never pay for it. So a workbook
  // that cannot be read is the proof the fetch happened: the vendor file is
  // requested, SheetJS tries, and the app says so instead of breaking.
  await page.getByLabel('Import a Tesco Pay file').setInputFiles({
    name: 'not-a-workbook.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('this is not a workbook', 'utf8'),
  });
  await page.waitForTimeout(1500);
  check('choosing a workbook DOES fetch the library — the boundary is deferred, not absent',
    requested.some((u) => u.includes('xlsx.mini.min.js')),
    requested.filter((u) => u.includes('xlsx')).join(', '));
  const workbookToast = await page.locator('.app-toast').innerText().catch(() => '');
  check('and a workbook that cannot be read is refused, in a sentence',
    /could not be read|needs Date|not a workbook/i.test(workbookToast), workbookToast);

  /* ── the pay, and the ledger's side of it ──────────────────────────────── */

  // A week whose pay date has PASSED, so the recorder may write it: a shift in
  // the week of Sunday 4 October 2026 pays on the 15th, which is before today.
  await page.getByLabel('Shift date').fill('2026-10-06');
  await page.getByLabel('Start time', { exact: true }).fill('09:00');
  await page.getByLabel('End time', { exact: true }).fill('17:00');
  await page.getByRole('button', { name: 'Add shift', exact: true }).click();
  await page.waitForTimeout(300);

  // The week's own net, typed off a bank statement — never derived. Each week
  // carries its own editor, so the Save button is scoped to the one beside
  // this week's field.
  const bankPay = page.getByLabel('Final bank pay for the week of 2026-10-04');
  await bankPay.waitFor({ timeout: 5000 });
  await bankPay.fill('469.78');
  await page.locator('.tesco-bankpay')
    .filter({ has: page.getByLabel('Final bank pay for the week of 2026-10-04') })
    .getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(400);
  stored = await tescoState();
  check('the bank figure is stored on the week\'s payslip',
    stored.tesco.payslips.some((p) => p.weekStart === '2026-10-04' && p.bankPay === 469.78),
    JSON.stringify(stored.tesco.payslips));

  // Now the ledger's side: the pay the tab knows about, written into the
  // ledger so the money reaches Balances.
  const fillButton = page.getByRole('button', { name: 'Put the pay of 2026-10-15 in the ledger' });
  await fillButton.waitFor({ timeout: 5000 });
  check('a passed pay with no ledger line is offered to be put there', await fillButton.count() === 1);
  await fillButton.click();
  await page.waitForTimeout(400);
  stored = await tescoState();
  const payEntry = stored.entries.find((e) => e.details === 'Tesco pay' && e.date === '2026-10-15');
  check('the pay lands in the ledger on its pay date', !!payEntry, JSON.stringify(stored.entries));
  check('for the figure the sheet recorded', payEntry && payEntry.amount === 469.78, String(payEntry && payEntry.amount));
  check('and it lands in the BANK, not on the Tesco card',
    payEntry && payEntry.method === 'AIB', String(payEntry && payEntry.method));
  check('and it is marked as the user\'s own line, so the recorder leaves it alone',
    stored.settings.tescoPayLedger?.['2026-10-15']?.by === 'fill',
    JSON.stringify(stored.settings.tescoPayLedger));
  check('and the recorder does not write it a second time',
    stored.entries.filter((e) => e.details === 'Tesco pay' && e.date === '2026-10-15').length === 1,
    String(stored.entries.filter((e) => e.details === 'Tesco pay').length));

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
  console.error(`\ntesco-sheet.browser: ${failures.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`tesco-sheet.browser: OK — ${results.length} checks (the sheet writes, refuses and round-trips)`);
