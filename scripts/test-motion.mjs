#!/usr/bin/env node
/**
 * Motion harness — the app's one piece of self-contained animation logic.
 *
 * app.js cannot be imported anywhere: it touches the DOM the moment it is
 * evaluated, and this repo has no test framework. `paintFigure` is the one
 * function in there that is arithmetic rather than DOM plumbing — it decides
 * whether a headline figure moves, from what, and where it comes to rest — so it
 * is lifted straight out of the file's own text and run here against a fake
 * clock. Testing a copy would be testing the copy; the slice is found by index
 * and the guard fails loudly if the shape it looks for is gone.
 *
 * What it pins, and why each one matters:
 *   · a figure that has changed counts from where the reader last saw it, and
 *     lands on the formatted target exactly — an intermediate frame must never
 *     be where the number comes to rest, or a total would be off by cents;
 *   · a re-render that changed nothing does not move at all (every keystroke
 *     repaints the screen, and a figure that counted on each one would flicker);
 *   · a figure never seen before arrives at its value rather than counting up
 *     from zero, which would be decoration instead of information;
 *   · reduced motion, and a session with no requestAnimationFrame, get the
 *     number instantly;
 *   · a second change while one is running wins, and the frames of the first
 *     cannot write over it.
 *
 * The second thing it pins is the route transition's bound. A view transition
 * does not run its update callback until the browser has captured the old state,
 * and capturing needs a compositor frame — so a document that cannot produce one
 * leaves the navigation waiting on a snapshot instead of drawing the next
 * screen. That is not hypothetical: in a webview that was not compositing, a
 * route change took 4040ms, while the same navigation with the API unavailable
 * took 9ms. `renderRoute` is lifted out of app.js the same way `paintFigure` is
 * and run against a fake `document`, so the budget, the skip and the release can
 * be checked without a browser.
 *
 * The third is the chart popup wiring contract: the attributes the charts emit
 * have to be covered by a `wireChartTips` selector, or a mark is silently
 * unreadable. The trigger itself is tippy's and is not checkable here — a
 * headless bridge emits no hover at all — so this is the half that can be.
 *
 * Run: node scripts/test-motion.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = src.indexOf('const _figureValues = new Map();');
const fnStart = src.indexOf('function paintFigure');
const end = src.indexOf('\n}\n', fnStart);
if (start < 0 || fnStart < 0 || end < 0) {
  console.error('test-motion: paintFigure is no longer where this harness looks for it in app.js.');
  process.exit(1);
}
const code = src.slice(start, end + 2);
// A sanity check on the slice: if app.js moved and this grabbed the wrong span of
// text, every assertion below would pass against nothing at all.
if (!/function paintFigure/.test(code) || !/_figureValues/.test(code) || code.length > 2600) {
  console.error(`test-motion: lifted an implausible slice (${code.length} chars) — check the markers in app.js.`);
  process.exit(1);
}

let clock = 0;
let queue = [];
const build = (reduceMotion) => {
  const performance = { now: () => clock };
  const requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  const cancelAnimationFrame = () => {};
  const fmt = (n) => `${n < 0 ? '−' : ''}€${Math.abs(n).toFixed(2)}`;
  return new Function('fmt', '_reduceMotion', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    code + '\nreturn { paintFigure };')(fmt, reduceMotion, performance, requestAnimationFrame, cancelAnimationFrame);
};
const el = () => ({ textContent: '' });
// Each frame re-queues the next, so a drain must be bounded — an unbounded
// `while (queue.length)` here never terminates.
const drain = (watched = null, limit = 60) => {
  const out = [];
  let n = 0;
  while (queue.length && n++ < limit) {
    const fn = queue.shift();
    clock += 16;
    fn();
    if (watched) out.push(watched.textContent);
  }
  return out;
};

let pass = 0;
const fails = [];
const ok = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n     got ${g}\n    want ${w}`);
};

// A figure never seen before arrives at its value: no frames, no counting up.
let app = build(false);
let a = el();
app.paintFigure(a, 'month', 24);
ok('first sight writes the figure and animates nothing', [a.textContent, queue.length], ['€24.00', 0]);

// Every keystroke repaints the screen; an unchanged value must not move.
queue = []; a = el();
app.paintFigure(a, 'month', 24);
ok('an unchanged value never animates', [a.textContent, queue.length], ['€24.00', 0]);

// A changed figure counts from where it was, then rests on the exact target.
queue = []; a = el(); clock = 0;
app.paintFigure(a, 'month', 30);
const queued = queue.length;
const frames = drain(a);
ok('a changed figure queues exactly one frame', queued, 1);
ok('it passes through intermediate values',
  [frames.length > 5, frames[1] !== '€24.00' && frames[1] !== '€30.00', frames.includes('€30.00')].join(),
  'true,true,true');
ok('and comes to rest on the exact target', [a.textContent, frames[frames.length - 1]], ['€30.00', '€30.00']);

// The count is monotonic from the old value to the new one — no overshoot, the
// 'calm and quick' rule the CSS timing tokens carry.
// 24 → 30, so each frame is at or above the last, and none passes the target.
const nums = frames.map(f => Number(f.replace(/[^\d.]/g, '')));
ok('and never overshoots', nums.every((n, i) => (i === 0 ? n >= 24 : n >= nums[i - 1] && n <= 30)), true);

// Reduced motion: the number, instantly.
app = build(true); queue = []; a = el();
app.paintFigure(a, 'month', 12); app.paintFigure(a, 'month', 99);
ok('reduced motion writes the figure with nothing queued', [a.textContent, queue.length], ['€99.00', 0]);

// A change during a count replaces it: the older frames cannot write over the
// newer figure (a stale total must never land on screen).
app = build(false); queue = []; a = el(); clock = 0;
app.paintFigure(a, 'month', 10);
clock += 100;
app.paintFigure(a, 'month', 200);
drain();
ok('the newest target wins', a.textContent, '€200.00');

// Two figures keep their own history: the hero total and the balance both move.
app = build(false); queue = [];
const x = el(), y = el();
app.paintFigure(x, 'month', 5); app.paintFigure(y, 'balance', 9);
drain();
app.paintFigure(x, 'month', 7);
drain();
ok('two figures keep their own last value', [x.textContent, y.textContent], ['€7.00', '€9.00']);

// A count across zero lands on the signed figure the app formats everywhere else.
app = build(false); queue = []; a = el(); clock = 0;
app.paintFigure(a, 'balance', 4); app.paintFigure(a, 'balance', -4);
drain();
ok('a count across zero lands on the signed figure', a.textContent, '−€4.00');

// A figure that is not a number is not a figure: the empty state stays empty
// rather than printing "€NaN".
queue = []; a = el();
app.paintFigure(a, 'month', NaN);
ok('a non-finite value writes nothing', a.textContent, '');

// ---------- the route transition, and the bound that keeps it honest ----------
const vtStart = src.indexOf('const VT_BUDGET');
const rtAt = src.indexOf('function renderRoute()');
const rtEnd = src.indexOf('\n}\n', rtAt);
if (vtStart < 0 || rtAt < 0 || rtEnd < 0 || vtStart > rtAt) {
  console.error('test-motion: renderRoute is no longer where this harness looks for it in app.js.');
  process.exit(1);
}
const routeCode = src.slice(vtStart, rtEnd + 2);
if (!/VT_BUDGET/.test(routeCode) || !/skipTransition/.test(routeCode) || routeCode.length > 2200) {
  console.error(`test-motion: lifted an implausible renderRoute slice (${routeCode.length} chars).`);
  process.exit(1);
}
// The route change is the transition's only entry point: if app.js ever goes back
// to wiring hashchange straight at render(), every assertion below is moot.
ok('hashchange is still wired through renderRoute',
  /addEventListener\('hashchange',\s*renderRoute\)/.test(src), true);

/**
 * Render the lifted renderRoute against a stand-in browser.
 *   vt       — does the engine have the View Transitions API at all
 *   reduce   — has the reader asked for less motion
 *   invoke   — does the browser ask for the new state (a compositing one does, on
 *              the next frame; a webview that cannot snapshots does not at all)
 *   throws   — an engine that refuses the transition outright
 * The sandbox declares the flags renderRoute closes over, so their real values
 * after a call can be read back through `flags()`.
 */
const buildRoute = ({ vt, reduce, invoke = true, throws = false }) => {
  const calls = { renders: 0, starts: 0, skips: 0, cb: null };
  const timers = [];
  const impl = throws
    ? `(cb) => { calls.starts++; calls.cb = cb; throw new Error('refused'); }`
    : `(cb) => { calls.starts++; calls.cb = cb; const p = ${invoke} ? cb() : null; return { finished: Promise.resolve(p), skipTransition: () => { calls.skips++; } }; }`;
  const body = `
const _reduceMotion = ${reduce};
let _renderSilent = false, _flushWaiters = null, _vtRunning = false;
const render = () => { calls.renders++; };
const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
const clearTimeout = (id) => { if (id) timers[id - 1] = null; };
const document = { startViewTransition: ${vt ? impl : 'undefined'} };
${routeCode}
return { renderRoute, VT_BUDGET, flags: () => ({ _vtRunning, _renderSilent }) };
`;
  const app = new Function('calls', 'timers', body)(calls, timers);
  return { app, calls, timers, armed: () => timers.filter(Boolean), run: () => timers.forEach(t => t && t.fn()) };
};

// No API: the plain render, and nothing armed that could fire later.
let r = buildRoute({ vt: false, reduce: false });
r.app.renderRoute();
ok('no API: the route renders on the spot and arms no watchdog',
  [r.calls.renders, r.calls.starts, r.armed().length], [1, 0, 0]);

// Reduced motion: a transition is not even attempted.
r = buildRoute({ vt: true, reduce: true });
r.app.renderRoute();
ok('reduced motion: the transition is never even attempted',
  [r.calls.renders, r.calls.starts, r.armed().length], [1, 0, 0]);

// The ordinary browser: it asks for the new state, so the transition runs and
// the watchdog stands down rather than rendering a second time.
r = buildRoute({ vt: true, reduce: false, invoke: true });
r.app.renderRoute();
ok('a browser that asks for the new state gets the transition',
  [r.calls.renders, r.calls.starts, r.calls.skips], [1, 1, 0]);
r.run();
ok('and its watchdog stands down once the browser has asked',
  [r.calls.renders, r.calls.skips], [1, 0]);

// The bug this bound exists for: a document that cannot capture a snapshot.
r = buildRoute({ vt: true, reduce: false, invoke: false });
r.app.renderRoute();
ok('a browser that cannot snapshot has not frozen the route yet',
  [r.calls.renders, r.calls.starts, r.armed().length], [0, 1, 1]);
// Read defensively: if the watchdog is gone entirely, the assertion above has
// already recorded it, and the point of the harness is to report, not to throw.
const armed = r.armed();
ok('the budget is short enough that nobody waits on a snapshot',
  [typeof r.app.VT_BUDGET === 'number' && r.app.VT_BUDGET <= 400, armed.length ? armed[0].ms : null],
  [true, r.app.VT_BUDGET]);
r.run();
ok('the watchdog renders the route itself, skips the transition, and clears the flags',
  [r.calls.renders, r.calls.skips, r.app.flags()._vtRunning, r.app.flags()._renderSilent],
  [1, 1, false, false]);
// The callback can still arrive afterwards; it must not leave the guard stuck on,
// which would silently downgrade every later navigation to a plain render.
r.calls.cb();
ok('a callback that arrives late leaves the guard free for the next navigation',
  [r.calls.renders, r.app.flags()._vtRunning], [2, false]);

// An engine that refuses the transition outright is a plain render, not a dead end.
r = buildRoute({ vt: true, reduce: false, throws: true });
r.app.renderRoute();
ok('a refused transition is turned into a plain render',
  [r.calls.renders, r.calls.starts, r.armed().length, r.app.flags()._vtRunning], [1, 1, 0, false]);

// One transition at a time: a second navigation while the first is unresolved
// renders plainly instead of queueing behind it.
r = buildRoute({ vt: true, reduce: false, invoke: false });
r.app.renderRoute();
r.app.renderRoute();
ok('a navigation during an unresolved transition renders plainly',
  [r.calls.renders, r.calls.starts], [1, 1]);

// ---------- the chart popup wiring contract ----------
// A chart mark's popup is the only way to read it — a bar is a shape, not a table
// cell — so a mark attribute that no wireChartTips() selector covers is a chart
// nobody can read. The trigger itself cannot be checked here (it is tippy's, and
// a headless bridge emits no hover), but the contract between the attributes the
// charts emit and the selectors the scopes are wired for can be, and it is the
// half that goes wrong silently.
const emitted = new Set([...src.matchAll(/'?(data-[\w-]*tip)'\s*:/g)].map(m => m[1]));
const delegates = [...src.matchAll(/wireChartTips\([^,]+,\s*'([^']+)'/g)].map(m => m[1]);
ok('the charts emit at least one tip attribute', emitted.size >= 1, true);
ok('and every one of them is covered by a wired scope',
  [...emitted].filter(a => !delegates.some(sel => sel.includes(a))), []);
ok('every wiring call names a selector for an emitted attribute',
  delegates.filter(sel => ![...emitted].some(a => sel.includes(a))), []);
ok('and there is a wiring call per chart scope that needs one',
  delegates.length >= 3, true);

console.log(fails.length
  ? `test-motion: ${fails.length} FAILED\n\n${fails.join('\n')}`
  : `test-motion: OK — ${pass} assertions passed (a figure counts when it changes and rests on its exact total; a route change never waits on a snapshot; every chart mark is wired to a popup)`);
process.exitCode = fails.length ? 1 : 0;
