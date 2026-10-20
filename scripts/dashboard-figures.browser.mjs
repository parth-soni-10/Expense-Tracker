#!/usr/bin/env node
/* Hand-run browser leg for the dashboard's three Hairline figures and the kit.
 *
 * Deliberately outside `run-guards.mjs` for the same reason the PIN and Data
 * legs are: it needs Playwright, and adding that to this repo would put a
 * browser download in front of every deploy. It resolves Playwright the same way
 * they do, serves the ported `app/` under the production CSP from `app/_headers`
 * (so `style-src 'self'` is actually enforced while the figures draw), seeds the
 * frozen document behind the PIN lock, and then checks the things a screenshot
 * cannot prove:
 *
 *   - the three cards are the real figures: a mounted SVG per host, the
 *     registered figure's own name, the figure's aria-label, and a read-out that
 *     carries the ledger's number rather than the word `rest`;
 *   - pointing at the tide reads a date and a balance — the figure's only
 *     interaction;
 *   - the kitchen: every `data-ui` host the dashboard carries has been installed
 *     into `data-component`, the budget bar reads its own percent, and the pulse
 *     counter restores the exact figure it started from;
 *   - nothing in the screen writes a style attribute, and the console reports no
 *     CSP refusal;
 *   - a budget edit re-renders the screen without leaving a second set of
 *     figures behind, which is the bug the shipping wrapper had;
 *   - the same at 390px, with no horizontal overflow, and with reduced motion on.
 *
 * Run: node scripts/dashboard-figures.browser.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(fileURLToPath(new URL('../app/', import.meta.url)));
const here = fileURLToPath(new URL('./', import.meta.url));
const shared = resolve(root, '../../design-system/package.json');
const shape = (m) => (m && m.chromium ? m : m?.default);
const { chromium } = shape(createRequire(shared)('@playwright/test'));

const cspMatch = /^\s+Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(join(root, '_headers'), 'utf8'));
const CSP = cspMatch[1].trim();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

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
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
      'content-security-policy': CSP,
    });
    res.end(body);
  });
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => ready(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const eq = (name, actual, expected) => check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const matches = (name, actual, re, detail = '') => check(name, re.test(String(actual)), detail || String(actual).slice(0, 300));

const fixture = readFileSync(resolve(here, 'fixtures/expense-tracker-v1.schema2.json'), 'utf8');

async function unlock(page) {
  await page.goto(`${base}/index.html`);
  await page.evaluate((raw) => localStorage.setItem('cents:p/personal/state', raw), fixture);
  await page.goto(`${base}/index.html`);
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  await page.locator('input[aria-label="PIN"]').fill('100901');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.net-worth-head .display-num').waitFor({ timeout: 15000 });
  // The figures paint on the frame after the screen mounts; wait for the tide's
  // own aria-label, which only exists once a figure has mounted.
  await page.waitForFunction(() => {
    const tide = document.getElementById('cents-balance-tide');
    return Boolean(tide && tide.querySelector('svg path'));
  }, null, { timeout: 15000 });
}

const browser = await chromium.launch();

try {
  /* ── the figures, at a desktop width, under the real policy ──────────────── */

  const context = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  const page = await context.newPage();
  const pageErrors = [];
  const cspRefusals = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) cspRefusals.push(m.text());
  });

  await unlock(page);

  const card = page.locator('.figures-card');
  eq('the dashboard carries one figures card', await card.count(), 1);
  eq('with three figure cards', await page.locator('.figures-card .hairline-card').count(), 3);

  const figures = await page.evaluate(() => [...document.querySelectorAll('.hairline-figure')].map((host) => ({
    id: host.id,
    figure: host.getAttribute('data-hairline'),
    role: host.getAttribute('role'),
    label: host.getAttribute('aria-label') || '',
    paths: host.querySelectorAll('svg path').length,
    read: host.parentElement?.querySelector('[data-hairline-read]')?.textContent || '',
    styled: host.querySelectorAll('[style]').length,
  })));
  eq('all three hosts mounted a figure', figures.filter((f) => f.figure).length, 3);
  eq('the balance tide is the tide', figures.find((f) => f.id === 'cents-balance-tide')?.figure, 'balance-tide');
  eq('the envelope garden is the garden', figures.find((f) => f.id === 'cents-envelope-garden')?.figure, 'envelope-garden');
  eq('the receipt constellation is the constellation', figures.find((f) => f.id === 'cents-receipt-constellation')?.figure, 'receipt-constellation');
  for (const f of figures) {
    check(`${f.id} drew geometry`, f.paths > 0, `${f.paths} path(s)`);
    eq(`${f.id} is an image to a screen reader`, f.role, 'img');
    check(`${f.id} describes itself`, f.label.length > 12, f.label);
    eq(`${f.id} writes no style attribute`, f.styled, 0);
  }

  const reads = Object.fromEntries(figures.map((f) => [f.id, f.read]));
  matches('the tide reads its day count and balance', reads['cents-balance-tide'], /^\d+ days? · €[\d,]+\.\d{2}$/);
  matches('the garden reads its envelopes', reads['cents-envelope-garden'], /^\d+ envelopes? · /);
  matches('the constellation reads its receipts', reads['cents-receipt-constellation'], /^\d+ recent entr(?:y|ies)$/);
  check('no read-out is left on rest', Object.values(reads).every((r) => r && r !== 'rest'), JSON.stringify(reads));
  check('the tide offers its pointer reading', /Point at a column/.test(figures[0].label), figures[0].label);

  // Pointing at a column is the tide's whole interaction: the read-out becomes a
  // date and a balance.
  const tide = page.locator('#cents-balance-tide');
  const box = await tide.boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.62);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.62, { steps: 4 });
  await page.waitForFunction(() => /^\d{1,2} [A-Z][a-z]{2} · €[\d,]+\.\d{2}$/.test(
    document.getElementById('cents-balance-tide')?.parentElement?.querySelector('[data-hairline-read]')?.textContent || '',
  ), null, { timeout: 5000 }).catch(() => {});
  matches('pointing at a tide column reads its date and balance',
    await page.evaluate(() => document.getElementById('cents-balance-tide')?.parentElement?.querySelector('[data-hairline-read]')?.textContent || ''),
    /^\d{1,2} [A-Z][a-z]{2} · €[\d,]+\.\d{2}$/);

  /* ── the kit, on the dashboard's own hosts ────────────────────────────────── */

  const components = await page.evaluate(() => {
    const seen = new Map();
    for (const node of document.querySelectorAll('#screen [data-component]')) {
      for (const id of node.getAttribute('data-component').split(/\s+/).filter(Boolean)) {
        seen.set(id, (seen.get(id) || 0) + 1);
      }
    }
    return Object.fromEntries(seen);
  });
  check('the pulse figures are the kit counter', (components['animated-counter'] || 0) >= 4,
    JSON.stringify(components));
  eq('the budget card installed once', components['budget-card'], 1);
  eq('the budget field carries its tip', components['warm-tooltip'], 1);
  // The installer rounds: 3.3% of the budget reads as 3 on the bar, which is what
  // a progressbar's aria-valuenow is allowed to be (an integer in its range).
  eq('the budget bar reports its own percent',
    await page.getAttribute('.budget-card [data-ui-bar]', 'aria-valuenow'), '3');
  eq('the bar is exposed as a progressbar',
    await page.getAttribute('.budget-card [data-ui-bar]', 'role'), 'progressbar');

  // The counter counts and then restores the exact text the render computed.
  // Located by its own label, not by a substring: every hint under the pulse
  // names spending somewhere, so `hasText: 'Spent'` finds the runway first.
  // €29.47 is the frozen document's October spending, counted by hand from the
  // fixture (4.47 + 12.50 + 12.50), not read back from the screen.
  const spentStat = page.locator('.pulse-stat').filter({ has: page.locator('.eyebrow', { hasText: /^Spent/ }) });
  await page.waitForFunction(() => {
    const node = [...document.querySelectorAll('.pulse-stat')]
      .find((n) => /^Spent/.test(n.querySelector('.eyebrow')?.textContent || ''));
    return node?.querySelector('.pulse-figure')?.textContent === '€29.47';
  }, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  eq('the counter settles on the ledger figure', await spentStat.locator('.pulse-figure').textContent(), '€29.47');

  const styled = await page.evaluate(() => [...document.querySelectorAll('#screen [style], #screen style')].map((n) => n.tagName));
  eq('the whole screen writes no style attribute and injects no stylesheet', styled.length, 0);

  /* ── a re-render repaints, and does not stack figures ────────────────────── */

  await page.locator('#budget-input').fill('1000');
  await page.waitForFunction(() => document.querySelector('.budget-percent')?.textContent === '2.9%', null, { timeout: 5000 });
  await page.waitForFunction(() => Boolean(document.getElementById('cents-balance-tide')?.querySelector('svg path')), null, { timeout: 5000 });
  eq('a budget edit still leaves exactly one balance tide',
    await page.locator('#cents-balance-tide').count(), 1);
  eq('and one set of three figures', await page.locator('.hairline-figure svg').count(), 3);
  eq('the budget edit was saved', await page.evaluate(() => JSON.parse(localStorage.getItem('cents:p/personal/state')).settings.monthlyBudget), 1000);
  eq('the redraw did not leave a second budget bar', await page.locator('.budget-card [data-ui-bar]').count(), 1);

  eq('no page errors', pageErrors.length, 0, pageErrors.join(' | '));
  eq('no CSP refusals', cspRefusals.length, 0, cspRefusals.join(' | '));
  await context.close();

  /* ── a phone, reduced motion ─────────────────────────────────────────────── */

  const phone = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
  const small = await phone.newPage();
  const smallErrors = [];
  small.on('pageerror', (e) => smallErrors.push(e.message));
  await unlock(small);
  eq('the three figures draw on a phone too', await small.locator('.hairline-figure svg').count(), 3);
  const overflow = await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  eq('the figures do not push the page sideways at 390px', overflow, 0);
  // Reduced motion: the counter lands on its final text with no count-up.
  const landed = await small.evaluate(() => [...document.querySelectorAll('.pulse-stat')]
    .find((n) => n.textContent.startsWith('Spent'))?.querySelector('.pulse-figure')?.textContent || '');
  eq('with reduced motion the counter is already at the figure', landed, '€29.47');
  eq('no page errors on the phone', smallErrors.length, 0, smallErrors.join(' | '));
  await phone.close();
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.error(`FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
if (failed.length) {
  console.error(`\ndashboard-figures: ${failed.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`dashboard-figures: OK — ${results.length} checks: the three figures mount, read and repaint under the production CSP, and the kit installs on the dashboard's own hosts`);
