#!/usr/bin/env node
/**
 * Gate C, part 2 — the browser leg. Load the frozen document into the real,
 * rendered app behind the test PIN, in a fresh Playwright context, and assert
 * that the screens agree with the document.
 *
 * Part 1 (`scripts/test-load-existing.mjs`) proves the storage contract: the
 * ported core reads, saves and round-trips the fixture unchanged in an
 * in-memory context. This half proves the other end of Gate C: the app a person
 * actually sees renders *that document* — the same net worth, the same eight
 * entries, the same checkpoint, the same categories — rather than merely
 * accepting its bytes.
 *
 * What makes it a fresh context, and why that matters:
 *   · `browser.newContext()` starts with empty storage for this origin, and the
 *     run asserts that before writing anything. No device is read: the browser
 *     is a new profile with no `cents:profiles`, no `cents:p/<id>/*`, no PIN and
 *     no credential. The only things it ever holds are the fixture and the
 *     default profile the app itself creates.
 *   · The document is written under `cents:p/personal/state` — the real key —
 *     and a PIN is seeded under `cents:p/personal/privacy` the way the Privacy
 *     lock screen stores one: PBKDF2 with the app's own iteration count. There
 *     is no built-in PIN to unlock with any more, so a leg that wants a lock
 *     has to make one — and a run with no seeded credential is asserted to open
 *     without one.
 *   · The clock is pinned inside the fixture's own month. The fixture is frozen
 *     (October 2026), so a dashboard keyed on "this month" would go blank the
 *     moment the calendar moved past it; `page.clock.setFixedTime` a day after
 *     its newest entry makes every figure deterministic forever. Timers are
 *     untouched — only the wall clock is fixed.
 *   · The page is served with the production `Content-Security-Policy` from
 *     `_headers`, applied to every response, so a figure that renders only when
 *     the policy is relaxed cannot pass here.
 *
 * It uses Playwright, which this repo deliberately does not depend on: the
 * guard suite is twenty-one pure-Node checks with no install step. So this leg is
 * kept out of `run-guards.mjs` (and CI) rather than making every push install a
 * browser. Run it by hand before the cutover:
 *
 *   node scripts/pin-screens.browser.mjs
 *
 * Playwright is resolved from, in order: `$CENTS_PLAYWRIGHT`, this repo's own
 * `node_modules` (if it ever has them), then the shared tooling project's
 * install (`../design-system`), which is where it lives in this workspace.
 *
 * The fixture is `scripts/fixtures/expense-tracker-v1.schema2.json`, built by
 * `scripts/make-cents-fixture.mjs` with the OLD modules. Nothing here writes to
 * it, and nothing here touches the deployed site: the server is a loopback
 * static server over this checkout.
 */
import { createServer } from 'node:http';
import { pbkdf2Sync, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
/* `CENTS_FIXTURE` exists so a deliberately broken copy can prove the leg fails;
   the frozen document itself is what runs by default. */
const FIXTURE = resolve(here, process.env.CENTS_FIXTURE || 'fixtures/expense-tracker-v1.schema2.json');
const KEY = 'cents:p/personal/state';
const PRIVACY_KEY = 'cents:p/personal/privacy';
/* A PIN this run invents. The app ships no credential of its own, so the lock
   this leg exercises is one it seeds exactly as the Privacy lock screen would;
   `check-pin-screens.mjs` holds the iteration count to app.js's. */
const PIN = 'test4242';
const PBKDF2_ITERATIONS = 310_000;
const MINUS = '\u2212';

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const entries = fixture.entries;
if (!Array.isArray(entries) || !entries.length) throw new Error(`${FIXTURE}: no entries — the fixture is not usable.`);

/* ── what the fixture says the screens must say ──────────────────────────────
   Every expectation below is derived from the document, not typed from a
   screenshot, so a regenerated fixture moves the expectations with it. The two
   rules that are not obvious are commented where they are used. */
const money = n => '€' + n.toFixed(2);
const grouped = n => '€' + n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Transfers move money between the reader's own accounts: the app lists both
   legs but counts neither in the month's spending or income. */
const delta = e => (e.type === 'credit' ? e.amount : e.type === 'expense' ? -e.amount : 0);
const spend = entries.filter(e => e.type === 'expense' && !e.transferId).reduce((s, e) => s + e.amount, 0);
const income = entries.filter(e => e.type === 'credit' && !e.transferId).reduce((s, e) => s + e.amount, 0);
const categoryTotals = {};
for (const e of entries) {
  if (e.type !== 'expense' || e.transferId) continue;
  categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
}
const topCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];
const budget = fixture.settings.monthlyBudget;
const vouchers = fixture.settings.tescoVouchers;
const checkpoint = fixture.settings.balanceCheckpoints?.AIB?.[0];
if (!checkpoint) throw new Error(`${FIXTURE}: no AIB balance checkpoint — the leg asserts the checkpoint on screen.`);
/* A checkpoint is the account's actual balance on its date; later movements add
   to it. The fixture's only entry on that date is a €0 note, so >= is exact. */
const methodSum = method => entries.filter(e => e.method === method && e.date >= checkpoint.date)
  .reduce((s, e) => s + delta(e), 0);
const aiBalance = checkpoint.balance + methodSum('AIB');
const savingsBalance = methodSum('RS');
const mainBalance = methodSum('Revolut');
const netWorth = aiBalance + savingsBalance + mainBalance;
/* Funded category budgets: the by-category card shows each one beside the
   target it is measured against, so the target is asserted from the document
   rather than from a percentage this leg would have to recompute. */
const fundedBudgets = Object.entries(fixture.settings.categoryBudgets || {})
  .filter(([, limit]) => +limit > 0);
/* A split pair renders as one grouped row, keyed by the shared split id; an
   ordinary entry is its own row. */
const rowKey = e => e.splitId || e.id;
const rowKeys = [...new Set(entries.map(rowKey))];
const splitGroups = [...new Set(entries.filter(e => e.splitId).map(e => e.splitId))];
const rowKeysOfType = type => [...new Set(entries.filter(e => e.type === type).map(rowKey))];
/* The filter chips count every entry in a category, transfers and notes
   included; only the monthly spend excludes transfers. */
const categoryEntryCount = id => entries.filter(e => e.category === id).length;
const tombstone = fixture.settings.deletedEntryIds?.[0];

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* Pin the clock inside the fixture's month: one day after its newest entry, or
   on that entry when it is already the month's last day. */
const latestDate = entries.map(e => e.date).sort().at(-1);
const frozen = new Date(`${latestDate}T12:00:00Z`);
const nextDay = new Date(frozen);
nextDay.setUTCDate(nextDay.getUTCDate() + 1);
if (nextDay.getUTCMonth() === frozen.getUTCMonth()) frozen.setTime(nextDay.getTime());
const expectedMonth = `${MONTHS[frozen.getUTCMonth()]} ${frozen.getUTCFullYear()}`;
const checkpointDate = new Date(`${checkpoint.date}T00:00:00Z`);
const checkpointDay = `${checkpointDate.getUTCDate()} ${MONTHS_SHORT[checkpointDate.getUTCMonth()]}`;

/* Deep equality that does not care about key order: the app re-serialises the
   document it loads, so the stored JSON is not byte-identical to the fixture. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/* ── Playwright, wherever it lives ─────────────────────────────────────────── */
async function loadPlaywright() {
  const tried = [];
  /* `import()` of Playwright's CommonJS entry can put the API on `.default`
     depending on how the module is detected, so normalise both shapes. */
  const shape = mod => (mod && mod.chromium ? mod : mod?.default);
  for (const spec of [process.env.CENTS_PLAYWRIGHT, '@playwright/test', 'playwright'].filter(Boolean)) {
    try {
      const found = shape(await import(spec));
      if (found?.chromium) return found;
      tried.push(`${spec}: no chromium export`);
    } catch (error) {
      tried.push(`${spec}: ${error.code || error.message}`);
    }
  }
  const shared = resolve(root, '../design-system/package.json');
  if (existsSync(shared)) {
    try {
      const found = shape(createRequire(shared)('@playwright/test'));
      if (found?.chromium) return found;
      tried.push('../design-system @playwright/test: no chromium export');
    } catch (error) {
      tried.push(`../design-system @playwright/test: ${error.code || error.message}`);
    }
  }
  throw new Error('Could not load Playwright. Install it (`npm i -D @playwright/test`) or point CENTS_PLAYWRIGHT at its entry file.\n  ' + tried.join('\n  '));
}

/* ── the checkout's own static server, under the production CSP ───────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const cspMatch = /^\s+Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(join(root, '_headers'), 'utf8'));
const CSP = cspMatch ? cspMatch[1].trim() : null;
if (!CSP) throw new Error('_headers carries no Content-Security-Policy — the leg would run without the policy the site is served under.');

function startServer() {
  return new Promise((ready, reject) => {
    const server = createServer((req, res) => {
      let path;
      try {
        path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      if (path === '/') path = '/index.html';
      const file = resolve(root, '.' + path);
      const inside = file === root || file.startsWith(root + sep);
      if (!inside || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': CSP }).end('not found');
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
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => ready(server));
  });
}

/* ── checks ───────────────────────────────────────────────────────────────── */
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const equal = (name, actual, expected) => check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const includes = (name, haystack, needle) => check(name, String(haystack).includes(needle), `missing ${JSON.stringify(needle)}`);

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
let context;
const pageErrors = [];
const cspRefusals = [];

try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Refused to|Content Security Policy/i.test(message.text())) cspRefusals.push(message.text());
  });
  await page.clock.setFixedTime(frozen);

  /* 1. A fresh context: empty storage, on the app's own origin, before the
        fixture goes in. */
  await page.goto(`${base}/404.html`, { waitUntil: 'load' });
  equal('a fresh context starts with empty storage', (await page.evaluate(() => Object.keys(localStorage))).length, 0);
  equal('no profile registry exists before the fixture is loaded', await page.evaluate(() => localStorage.getItem('cents:profiles')), null);

  /* 2. Load the frozen document under the real key, and seed a PIN of this
        run's own — the app has no credential to fall back on. */
  const salt = randomUUID();
  const hash = pbkdf2Sync(PIN, salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
  await page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [KEY, JSON.stringify(fixture)]);
  await page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [PRIVACY_KEY, JSON.stringify({ hash, salt, kdf: 'pbkdf2' })]);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.locator('input[aria-label="PIN"]').waitFor({ timeout: 15000 });
  equal('the app opens locked when a PIN is set', await page.locator('.pin-lock').count(), 1);
  check('the lock screen does not print any PIN', !(await page.locator('.pin-lock').innerText()).includes(PIN));
  await page.locator('input[aria-label="PIN"]').fill(PIN);
  await page.locator('.pin-lock').waitFor({ state: 'detached', timeout: 15000 });
  await page.locator('.net-worth-head .display-num').waitFor({ timeout: 15000 });

  const appText = async () => (await page.locator('#app').innerText()).replace(/\s+/g, ' ').trim();
  const openScreen = async (hash, marker) => {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForFunction(m => document.querySelector('#app')?.innerText.includes(m), marker, { timeout: 15000 });
  };

  /* 3. Dashboard — the figures the document holds, in the fixture's month. */
  const dash = await appText();
  equal("net worth is the document's net worth", (await page.locator('.net-worth-head .display-num').innerText()).trim(), money(netWorth));
  includes("the dashboard is in the fixture's month", dash, expectedMonth);
  includes("budget spent is the month's spending, of the stored budget", dash, `${money(spend)}/ ${money(budget)}`);
  includes("the ledger count is the document's entry count", dash, `${entries.length} ENTRIES LOGGED`);
  includes("income is the month's non-transfer credits", dash, `Income ${money(income)}`);
  const net = spend - income; /* the app prints the balance as signed money */
  const signed = n => `${n < 0 ? MINUS : n > 0 ? '+' : ''}${money(Math.abs(n))}`;
  includes('net is spending minus income', dash, `Net ${signed(net)}`);
  includes('paper vouchers are the stored count', dash, `Vouchers ${money(vouchers)}`);
  includes('the leading category total is on the dashboard', dash, money(topCategory[1]));

  /* The read-outs: one Pulse card, whose spent figure is the month's spending
     and whose runway figure is a whole number of days. (These used to check
     the Hairline three-figure strip, removed with the redesign — the card that
     carries the same job is checked instead of the surface that no longer
     exists.) */
  const pulse = page.locator('.financial-pulse');
  equal('one pulse card mounts', await pulse.count(), 1);
  const pulseText = (await pulse.innerText()).replace(/\s+/g, ' ').trim();
  check("the pulse card's spent figure is the month's spending",
    pulseText.includes(`SPENT\u24be ${money(spend)}`) && /RUNWAY\u24be \d+ days/.test(pulseText),
    `got ${JSON.stringify(pulseText.slice(0, 220))}, expected ${money(spend)} spent and a runway in whole days`);
  includes('the by-category card measures a funded category against its own target',
    dash, `of ${money(fundedBudgets[0][1])}`);

  /* 4. History — the same rows, with the split pair grouped and the tombstone
        gone. */
  await openScreen('#history', 'MONTHLY SUM');
  const hist = await appText();
  /* Rows are laid out in a scrolling table whose `innerText` is empty, so the
     text of the rows themselves is read with `textContent`. */
  const histText = (await page.locator('#app').evaluate(el => el.textContent)).replace(/\s+/g, ' ').trim();
  const rows = await page.evaluate(() => [...document.querySelectorAll('#app .history-row')].map(el => ({
    key: el.dataset.id,
    type: [...el.classList].find(name => name !== 'history-row' && name.endsWith('-row')),
  })));
  equal('one row per entry, with the split pair grouped', rows.length, rowKeys.length);
  equal("history rows are the document's entries", JSON.stringify(rows.map(r => r.key).sort()), JSON.stringify(rowKeys.slice().sort()));
  for (const id of splitGroups) {
    equal(`split group ${id.slice(0, 8)} is one row`, rows.filter(r => r.key === id).length, 1);
    check('the split legs are not rows of their own', !rows.some(r => entries.some(e => e.splitId === id && e.id === r.key)));
  }
  check('the tombstoned entry is not on screen', !tombstone || !(await page.locator('#app').innerHTML()).includes(tombstone));
  equal("spending rows are the document's expenses", rows.filter(r => r.type === 'expense-row').length, rowKeysOfType('expense').length);
  equal("income rows are the document's credits", rows.filter(r => r.type === 'income-row').length, rowKeysOfType('credit').length);
  equal("the note row is the document's note", rows.filter(r => r.type === 'note-row').length, rowKeysOfType('note').length);
  for (const chip of [
    `All · ${entries.length}`,
    `Groceries · ${categoryEntryCount('gro')}`,
    `Misc · ${categoryEntryCount('misc')}`,
    `Spending · ${entries.filter(e => e.type === 'expense').length}`,
    `Income · ${entries.filter(e => e.type === 'credit').length}`,
  ]) includes(`history filter "${chip}"`, hist, chip);
  includes("the month sum is the document's spending", hist, `MONTHLY SUM · EXPENSES ${money(spend)}`);
  equal('both transfer legs are listed', (histText.match(/To savings/g) || []).length, 2);
  includes('the split entries are on the ledger', histText, 'Dinner split');
  const transfers = entries.filter(e => e.transferId);
  includes('the transfer in credits the receiving account', histText, `+${money(transfers.find(e => e.type === 'credit').amount)}`);

  /* 5. Balances — the checkpoint and the per-account movements. */
  await openScreen('#balances', 'ACCOUNT BALANCES');
  const balanceRows = await page.evaluate(() => [...document.querySelectorAll('.balance-editor-row')]
    .map(el => el.textContent.replace(/\s+/g, ' ').trim()));
  const balanceRow = label => balanceRows.find(text => text.startsWith(label)) || '';
  includes('AIB is reconciled on the checkpoint date', balanceRow('AIB bank'), `reconciled ${checkpointDay}`);
  includes('the AIB balance is the checkpoint plus later movements', balanceRow('AIB bank'), money(aiBalance));
  includes('the checkpoint is shown against the book', balanceRow('AIB bank'), `+${money(checkpoint.balance)} vs book`);
  includes("Revolut Main holds the document's main-account movement", balanceRow('Revolut Main'),
    `${mainBalance < 0 ? MINUS : ''}${money(Math.abs(mainBalance))}`);
  includes('Revolut Savings holds the transfer in', balanceRow('Revolut Savings'), money(savingsBalance));
  includes('paper vouchers are on the balances screen', await appText(), money(vouchers));

  /* 6. Insights — the month's totals from the same entries. */
  await openScreen('#insights', 'THE SHORT VERSION');
  const insights = await appText();
  const led = /led by (.+?) at €([\d,]+\.\d{2})/.exec(insights);
  check("insights names the month's spend and its leading category",
    !!led && Number(led[2].replace(/,/g, '')) === topCategory[1] && insights.includes(`You spent ${money(spend)} in this range`),
    `got ${JSON.stringify(led ? led[0] : insights.slice(0, 160))}, expected the leading total ${money(topCategory[1])}`);
  includes('insights counts the spending entries', insights, `SPENDING ENTRIES ${entries.filter(e => e.type === 'expense' && !e.transferId).length}`);
  includes("insights totals the month's spend", insights, `BY CATEGORY ${money(spend)} spent`);

  /* 7. Tesco — the shift the document stores. */
  await openScreen('#tesco', 'HOURS THIS MONTH');
  const tesco = await appText();
  const shift = fixture.tesco?.shifts?.[0];
  if (shift) includes('the Tesco shift is on its week', tesco, `${shift.start}`);
  includes('the Tesco screen reads the stored shift end', tesco, `${shift.end.replace('-', '\u2013')}`);

  /* 8. Add — the document's custom category and method reach the form. */
  await openScreen('#add', 'QUICK CAPTURE');
  const customCategory = fixture.settings.customCategories?.[0];
  const customMethod = fixture.settings.customMethods?.[0];
  if (customCategory) equal(`the custom category "${customCategory.label}" is offered`, await page.locator('.pill-cat', { hasText: customCategory.label }).count(), 1);
  if (customMethod) {
    const option = page.locator(`option[value="${customMethod.id}"]`).first();
    equal(`the custom method "${customMethod.label}" is offered`, await option.count() ? await option.innerText() : '', customMethod.label);
  }

  /* 9. Nothing else was written, and the document was not altered. */
  const keys = (await page.evaluate(() => Object.keys(localStorage))).sort();
  equal('the context holds only the document, its PIN and the default profile', JSON.stringify(keys), JSON.stringify([KEY, PRIVACY_KEY, 'cents:profiles'].sort()));
  const stored = await page.evaluate(key => localStorage.getItem(key), KEY);
  equal('the stored document still deep-equals the fixture', canonical(JSON.parse(stored)), canonical(fixture));
  const profiles = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('cents:profiles') || 'null'); } catch { return null; }
  });
  const profileIds = Array.isArray(profiles?.profiles) ? profiles.profiles.map(p => p.id) : [];
  check('the registry holds no profile but the default', profileIds.every(id => id === 'personal'), profileIds.join(','));
  check('the registry carries no PIN or credential', !profiles || (!('pinHash' in profiles) && !('credential' in profiles)));
  check('no other profile document was created', keys.every(k => k === KEY || k === PRIVACY_KEY || k === 'cents:profiles'), keys.join(','));

  equal('no page error', pageErrors.length, 0);
  equal('no CSP refusal', cspRefusals.length, 0);
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  server.closeAllConnections?.();
  await new Promise(done => server.close(done));
}

const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`);
if (cspRefusals.length) console.error(`CSP refusals:\n  ${cspRefusals.join('\n  ')}`);
if (failed.length) {
  console.error(`\npin-screens: ${failed.length} of ${results.length} check(s) failed`);
  process.exit(1);
}
console.log(`\npin-screens: OK — ${results.length} checks, ${entries.length} entries, PIN ${PIN}, ${expectedMonth}`);
