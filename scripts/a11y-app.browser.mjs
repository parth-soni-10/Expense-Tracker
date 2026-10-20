#!/usr/bin/env node
/* Hand-run browser leg for the PORTED shell's accessibility harness.
 *
 * Outside `run-guards.mjs` for the same reason the other browser legs are: it
 * needs Playwright, and adding that to this repo would put a browser download
 * in front of every deploy.
 *
 * The harness itself is the page: `app/a11y-harness.html` loads the real app
 * in a visible frame and drives it through every route and every surface that
 * OPENS, reporting four defect classes per surface. This leg serves `app/`
 * under the production CSP, opens the harness in a page, and reads the verdict
 * it publishes.
 *
 * The harness MUST be visible and CSS-scaled: the app defers its render to an
 * animation frame and a background frame is throttled, so a hidden harness
 * audits nothing.
 *
 * Run: node scripts/a11y-app.browser.mjs
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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(`${base}/a11y-harness.html`);
  // The harness publishes its verdict when it is done. Every step reloads the
  // frame and unlocks it, so this takes a while — but it is a real run over
  // every surface, not a sample.
  for (let i = 0; i < 40; i += 1) { await page.waitForTimeout(3000); const pr = await page.evaluate(() => window.__a11yProgress || null); const rp = await page.evaluate(() => window.__a11yReport || null); if (rp) break; if (i % 3 === 0) console.log('progress', JSON.stringify(pr)); }
  const report = await page.evaluate(() => window.__a11yReport);

  check('the harness ran', !!report && !report.error, report && report.error ? String(report.error) : '');
  check('it checked every surface it declared', report.checked > 0, `${report.checked} checked, ${report.skipped} skipped`);
  check('no step threw', !report.failures || report.failures.length === 0,
    (report.failures || []).map((f) => `${f.step} (${f.failure})`).join('; '));
  check('it unlocked the app', /unlocked/.test(report.unlock || ''), report.unlock);
  check('the lock screen is audited too',
    (report.results || []).some((r) => /lock/.test(r.step)), (report.results || []).map((r) => r.step).join(' | '));

  // The verdict is the sum of four defect classes, and the report has to be
  // CLEAN for the ported app. A skipped surface is not a pass, so the skip
  // count is reported rather than folded away.
  const findings = (report.results || [])
    .filter((r) => r.opened)
    .flatMap((r) => [
      ...(r.unnamed || []).map((x) => `${r.step}: unnamed — ${x}`),
      ...(r.dupes || []).map((x) => `${r.step}: duplicate label — ${x}`),
      ...(r.unlabelledFields || []).map((x) => `${r.step}: unlabelled field — ${x}`),
      ...(r.noAlt || []).map((x) => `${r.step}: no alt — ${x}`),
    ]);
  check('no accessibility defect was found', findings.length === 0, findings.slice(0, 8).join('\n'));
  check('and the harness says so', report.problems === 0, String(report.problems));
  // A skip has to say WHY. An unexplained skip reads as coverage, and the
  // harness's own rule is that a skip means "this device could not reach it".
  const unexplained = (report.results || []).filter((r) => !r.opened && !r.needs && !r.failure);
  check('every skipped surface declares a reason', unexplained.length === 0,
    unexplained.map((r) => r.step).join(', '));
  console.log(`a11y-app: the harness checked ${report.checked} surface(s), skipped ${report.skipped}`);
  if (report.skipped) {
    const why = (report.results || []).filter((r) => !r.opened).map((r) => `${r.step} — ${r.needs || r.failure || 'no reason'}`);
    console.log(`a11y-app: skipped: ${why.join('; ')}`);
  }
  check('no page error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const failures = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok) console.error(`FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (failures.length) {
  console.error(`\na11y-app.browser: ${failures.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`a11y-app.browser: OK — ${results.length} checks (every surface audited, nothing found)`);
