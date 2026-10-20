#!/usr/bin/env node
/* Hand-run browser leg for the served `app/` shell (batch 21, slice 1).
 *
 * Slice 1 owns four things and nothing else: the boot document, the PIN gate,
 * the hash route contract and the versioned worker. Until this leg existed all
 * four were verified by reading the source — `tsc -p app` and the bundle only
 * prove the module parses.
 *
 * Deliberately outside `run-guards.mjs`, for the same reason the PIN and Data
 * sheet legs are: it needs Playwright, and adding that to this repo would put a
 * browser download in front of every deploy. Playwright is resolved from the
 * shared `../design-system` install, like the other legs.
 *
 * What it does NOT cover: the update bar (it needs a second deploy to compare
 * against), an installed PWA's splash, axe, reduced motion, 375/768 widths, and
 * the ported screens' own behaviour — those belong to their slices' legs.
 *
 * Run: node scripts/app-shell.browser.mjs
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
if (!cspMatch) throw new Error('app/_headers carries no Content-Security-Policy — the shell would be exercised without it.');
const CSP = cspMatch[1].trim();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.map': 'application/json',
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
      // The worker caches by URL; no-store keeps a stale copy out of the HTTP
      // cache so a run always judges the file on disk.
      'cache-control': 'no-store',
      'content-security-policy': CSP,
      'service-worker-allowed': '/',
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

const LABELS = { dashboard: 'Dashboard', add: 'Add', history: 'History', balances: 'Balances', tesco: 'Tesco Pay', insights: 'Insights' };
const ROUTES = Object.keys(LABELS);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const cspRefusals = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) cspRefusals.push(m.text());
});

const LOCK = '#gate .gate-card';
/* Runs before the document's own scripts, so it records the state the shell
   booted in rather than the state the worker has claimed by the load event. */
await page.addInitScript(() => {
  window.__controlledAtDocStart = Boolean(navigator.serviceWorker.controller);
});

const unlocked = async () => {
  await page.locator(LOCK).waitFor({ state: 'detached', timeout: 15000 });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
};
const screenTitle = async () => (await page.locator('#screen h1.app-title').innerText()).trim();
const appText = async () => (await page.locator('#app').innerText()).replace(/\s+/g, ' ').trim();

try {
  /* ── 1. a first-time visitor: nothing stored, nothing controlled ────────── */
  await page.goto(`${base}/`, { waitUntil: 'load' });
  eq('a fresh origin stores no document', (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cents:p/')).length)), 0);
  eq('the document boots uncontrolled on a first visit', await page.evaluate(() => window.__controlledAtDocStart === false), true);
  check('the module finished booting', await page.evaluate(() => Boolean(window.__centsBooted)));
  check('the shell announces its own version', /^\d{4}-\d{2}-\d{2}$/.test(await page.evaluate(() => window.__cents?.shell || '')), await page.evaluate(() => window.__cents?.shell));

  /* ── 2. the gate: locked, opaque, and the built-in PIN named ────────────── */
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  eq('the app is hidden until the PIN is accepted', await page.locator('#app').isVisible(), false);
  const lockText = (await page.locator(LOCK).innerText()).replace(/\s+/g, ' ').trim();
  check('the lock names the built-in test PIN', lockText.includes('100901'), lockText.slice(0, 160));
  eq('the lock is a modal dialog with an accessible name', await page.locator(LOCK).getAttribute('aria-label'), 'Unlock cents');
  const inlineStyles = await page.evaluate(() => [...document.querySelectorAll('[style]')].map((n) => `${n.tagName}:${n.getAttribute('style')}`));
  eq('the document carries no style attributes', inlineStyles.length, 0);
  eq('the document carries no runtime <style>', await page.evaluate(() => document.querySelectorAll('style').length), 0);

  /* ── 3. a wrong PIN does not open the door ──────────────────────────────── */
  await page.locator('input[aria-label="PIN"]').fill('000000');
  // The keyboard, not locator.press: a correct PIN removes the gate mid-press,
  // and locator.press then waits forever for an element that has just gone.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200); // the PBKDF2 derivation is deliberately slow
  eq('a wrong PIN leaves the gate up', await page.locator(LOCK).count(), 1);
  eq('a wrong PIN leaves the app hidden', await page.locator('#app').isVisible(), false);

  /* ── 4. the built-in PIN opens it, on an empty document ─────────────────── */
  await page.locator('input[aria-label="PIN"]').fill('100901');
  // The keyboard, not locator.press: a correct PIN removes the gate mid-press,
  // and locator.press then waits forever for an element that has just gone.
  await page.keyboard.press('Enter');
  await unlocked();
  eq('an unlocked empty document opens the dashboard', await screenTitle(), 'Dashboard');
  check('the screen rendered something', (await appText()).length > 0);
  check('the gate was removed, not merely stopped', await page.locator(LOCK).count() === 0 && !(await page.locator('#gate').isVisible()));
  const nav = await page.locator('#app-nav a.app-tab').allInnerTexts();
  eq('the nav lists the six contract routes', nav.join(','), ROUTES.map((r) => LABELS[r]).join(','));
  eq('the nav also holds the Data trigger', await page.locator('#app-nav .app-data-trigger').count(), 1);

  /* ── 5. every hash route renders and marks itself current ───────────────── */
  for (const id of ROUTES) {
    await page.evaluate((h) => { location.hash = h; }, `#${id}`);
    /* Polled rather than awaited: a route that renders the wrong heading is a
       finding to report, and `waitForFunction` would abort the run on it —
       losing every check after the first broken screen. */
    let title = '';
    const settled = Date.now() + 8000;
    while (Date.now() < settled && title !== LABELS[id]) {
      title = await page.locator('#screen h1.app-title').innerText().catch(() => '');
      if (title !== LABELS[id]) await page.waitForTimeout(100);
    }
    eq(`#${id} renders its own screen`, title, LABELS[id]);
    eq(`#${id} marks its tab current`, await page.locator('#app-nav a.app-tab[aria-current="page"]').innerText().catch(() => ''), LABELS[id]);
    eq(`#${id} moves focus to its heading`, await page.locator('#screen h1.app-title').getAttribute('tabindex').catch(() => null), '-1');
  }

  /* ── 6. unknown hash, query string, and a deep link through the gate ────── */
  await page.evaluate(() => { location.hash = '#nonsense'; });
  await page.waitForFunction(() => document.querySelector('#screen h1.app-title')?.textContent?.trim() === 'Dashboard', null, { timeout: 15000 });
  eq('an unknown hash lands on the dashboard', await screenTitle(), 'Dashboard');
  await page.evaluate(() => { location.hash = '#add?more=1&type=credit'; });
  await page.waitForFunction(() => document.querySelector('#screen h1.app-title')?.textContent?.trim() === 'Add', null, { timeout: 15000 });
  eq('the route keeps its query', await page.evaluate(() => window.__cents.route().params.toString()), 'more=1&type=credit');

  // A different path, not just a different hash: same-document navigation would
  // never re-run the boot and the gate would be missing for the wrong reason.
  await page.goto(`${base}/index.html#history`, { waitUntil: 'load' });
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  eq('a deep link still opens locked', await page.locator(LOCK).count(), 1);
  await page.locator('input[aria-label="PIN"]').fill('100901');
  // The keyboard, not locator.press: a correct PIN removes the gate mid-press,
  // and locator.press then waits forever for an element that has just gone.
  await page.keyboard.press('Enter');
  await unlocked();
  eq('a deep link lands on its own route after unlocking', await screenTitle(), 'History');

  /* ── 7. the worker: registered, versioned, and serving the shell offline ── */
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys();
    return { script: reg?.active?.scriptURL || '', state: reg?.active?.state || '', names };
  });
  check('the worker is active and is the shell\'s own', /\/sw\.js$/.test(swState.script) && swState.state === 'activated', JSON.stringify(swState));
  const shellCache = swState.names.find((n) => /^cents-app-v\d+$/.test(n));
  check('the cache name is versioned', Boolean(shellCache), swState.names.join(','));
  const versionInSource = /const CACHE = '(cents-app-v\d+)'/.exec(readFileSync(join(root, 'sw.js'), 'utf8'))?.[1];
  eq('the running cache is the version the source declares', shellCache, versionInSource);
  /* The worker warms the shell in the background, so wait for the whole list
     rather than sampling one file: every entry it declares must be cached, and
     the cache must hold nothing the list does not name (a stray key would mean
     the fetch handler cached a response the install path never intended). */
  const SHELL = [.../const SHELL = \[([\s\S]*?)\];/.exec(readFileSync(join(root, 'sw.js'), 'utf8'))[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check('the worker declares a shell list', SHELL.length > 15, `${SHELL.length} entries`);
  const cacheKeys = async () => page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => /^cents-app-v\d+$/.test(n));
    if (!shell) return null;
    const keys = await (await caches.open(shell)).keys();
    return keys.map((r) => new URL(r.url).pathname);
  });
  const deadline = Date.now() + 20000;
  let keys = await cacheKeys() || [];
  while (Date.now() < deadline && SHELL.some((u) => !keys.includes(u))) {
    await page.waitForTimeout(250);
    keys = await cacheKeys() || [];
  }
  const missing = SHELL.filter((u) => !keys.includes(u));
  const extra = keys.filter((u) => !SHELL.includes(u));
  eq('every shell entry is in the cache', missing.join(','), '');
  eq('the cache holds nothing the shell list does not name', extra.join(','), '');

  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  eq('a first install shows no update bar', await page.locator('.update-bar').count(), 0);
  const offlineLock = await page.locator(LOCK).count();
  eq('offline, the shell still boots to the gate', offlineLock, 1);
  const offlineShell = await page.evaluate(() => Boolean(window.__cents));
  check('offline, the module still runs', offlineShell);
  await context.setOffline(false);

  /* ── 8. nothing was ever refused or thrown ─────────────────────────────── */
  eq('no page error', pageErrors.length, 0);
  eq('no CSP refusal', cspRefusals.length, 0);
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`);
if (cspRefusals.length) console.error(`CSP refusals:\n  ${cspRefusals.join('\n  ')}`);
if (failed.length) {
  console.error(`\napp-shell: ${failed.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`\napp-shell: OK — ${results.length} checks, six routes, worker ${/const CACHE = '(cents-app-v\d+)'/.exec(readFileSync(join(root, 'sw.js'), 'utf8'))?.[1]}`);
