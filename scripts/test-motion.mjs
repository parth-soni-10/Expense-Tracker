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
 * The second thing it pins is that a route change costs nothing but the render.
 * It used to hand the change to the View Transitions API, and that was a stall:
 * the browser will not call the update callback until it has captured the old
 * state, and capturing needs a compositor frame — so a document that cannot
 * produce one waited out a whole fallback budget before drawing anything.
 * Measured on a webview that was not compositing: ~270ms per tab switch (~250 of
 * it the budget) against ~20ms with no transition. So the guard now pins the
 * ABSENCE of that machinery, in app.js and in the CSS: no startViewTransition,
 * no budget, no entrance animation on the screen. `renderRoute` is lifted out of
 * app.js the same way `paintFigure` is and run against a fake `render`, so the
 * claim that a navigation renders once and arms nothing is checked, not assumed.
 *
 * The third is the menu's motion budget. Every row used to spring in on its own,
 * staggered through eight nth-child delays, on top of the level's slide: 19-21
 * live animations and 285ms to settle on every open and every drill, measured.
 * The rows arrive with the panel now and only the level's directional slide is
 * left, so what is pinned is the absence of the per-row entrance and the presence
 * of a 0.2s ceiling on every duration in the menu section — the felt latency is
 * the thing that regresses quietly, one rule at a time. The same section carries
 * the file's last backdrop-filter, now gone: a fixed masked band that re-samples
 * the page behind it does that on every scrolled frame.
 *
 * The fourth is the chart popup wiring contract: the attributes the charts emit
 * have to be covered by a `wireChartTips` selector, or a mark is silently
 * unreadable. The trigger itself is tippy's and is not checkable here — a
 * headless bridge emits no hover at all — so this is the half that can be.
 *
 * Run: node scripts/test-motion.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  // The Insights screen and its chart cluster moved into their own deferred
  // module in the boot split. Appended after app.js so the slices below (which
  // search from the front) still lift app.js's own text, while every absence
  // and coverage check reads BOTH files — a removed flourish or an unwired tip
  // attribute must not become legal by changing module.
  + '\n' + readFileSync(new URL('../insights.js', import.meta.url), 'utf8');
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

// ---------- a route change costs the render and nothing else ----------
// The delay this exists to keep out: the app used to hand every route change to
// the View Transitions API, and a browser that cannot capture a compositor frame
// never runs the update callback — so the tab switch waited out a 250ms budget
// before drawing at all, with a 180/220ms cross-fade on top of it. That is fixed
// by not using the API, and the fix is only worth anything if its return fails
// the build, so the machinery is pinned ABSENT here twice: in app.js, and in the
// CSS that carried the animation.
const rtAt = src.indexOf('function renderRoute()');
const rtEnd = src.indexOf('\n}\n', rtAt);
if (rtAt < 0 || rtEnd < 0) {
  console.error('test-motion: renderRoute is no longer where this harness looks for it in app.js.');
  process.exit(1);
}
const routeCode = src.slice(rtAt, rtEnd + 2);
// A bound on the slice, not just its presence: renderRoute is allowed to be a
// plain render and nothing more, so machinery coming back has to fail here.
ok('renderRoute is small enough to be a plain render', routeCode.length <= 400, true);

// The route change is the only entry point that matters: if hashchange ever stops
// going through renderRoute, every assertion below is checking dead code.
ok('hashchange is still wired through renderRoute',
  /addEventListener\('hashchange',\s*renderRoute\)/.test(src), true);

ok('app.js never hands a render to the View Transitions API',
  /startViewTransition|skipTransition|VT_BUDGET/.test(src), false);
ok('and renderRoute itself names no deferral',
  /setTimeout|requestAnimationFrame|await |Promise|\.then\(/.test(routeCode), false);
ok('and it does not reach for the document', /document\./.test(routeCode), false);

/** Render the lifted renderRoute against a fake render, counting what it asks for. */
const buildRoute = () => {
  const calls = { renders: 0 };
  const timers = [];
  const body = `
const render = () => { calls.renders++; };
const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
${routeCode}
return { renderRoute };
`;
  const app = new Function('calls', 'timers', body)(calls, timers);
  return { app, calls, timers };
};
let r = buildRoute();
r.app.renderRoute();
ok('a route change renders once and arms nothing',
  [r.calls.renders, r.timers.length], [1, 0]);
// Back to back, as a user flicking through tabs does: still one render each, and
// no state that a later navigation could be gated on.
r = buildRoute();
r.app.renderRoute(); r.app.renderRoute(); r.app.renderRoute();
ok('and three navigations in a row render three times and arm nothing',
  [r.calls.renders, r.timers.length], [3, 0]);

// The CSS half: with the machinery gone, a screen must still not animate itself
// in. A rule that animates .screen is the stutter back under a new name.
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
ok('no rule animates the screen as it arrives',
  /^\.screen\s*\{[^}]*animation\s*:/m.test(css), false);
ok('and the staggered-children rules are gone', /\.screen\.stagger/.test(css), false);
ok('and the view-transition pseudo-elements are gone',
  /::view-transition|view-transition-name|centsVt/.test(css), false);
// countUp is in here for the same reason, from the other direction: it was an
// entry animation on a figure INSIDE the dashboard, so it replayed on every
// switch back to the Home tab rather than on the route change itself.
ok('and no keyframes are left named for an entry animation',
  /@keyframes (riseIn|centsVt|countUp)/.test(css), false);
// screenIn survives on purpose: the things that appear INTO a screen that is
// already there (the bulk bar, an empty state) still fade in.
ok('screenIn is still there for the things that appear into a screen',
  /@keyframes screenIn/.test(css) && /\.bulk-bar \{ animation: screenIn/.test(css), true);

// ---------- the menu's motion budget ----------
// The menu was the slowest thing in the app and nobody had measured it. Every
// row sprang in on its own (menuRowIn, staggered through eight nth-child delays
// ramping to 0.125s) on top of the level's slide, so a menu open AND every drill
// ran 19-21 live animations and took 285ms to come to rest — for 15 rows the user
// had just asked to see. Measured at a phone viewport, before and after: it now
// settles in 160ms with 6 animations, and the last thing moving is the trigger's
// own burger-to-X morph, which is the tap's feedback. So the budget below is the
// point: every duration in the menu section has to stay inside 0.2s or the felt
// latency creeps back in one rule at a time.
// Comments are stripped first, and that is not tidiness: the notes in
// styles.css name what was removed (menuRowIn, the stagger, backdrop-filter), so
// a search for those names finds the explanation of their absence and fails. The
// assertions have to be about rules. The slice markers ARE comments, so the
// slice comes off `css` and only then has its comments removed.
const rulesOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const cssRules = rulesOf(css);
const menuSection = rulesOf(css.slice(css.indexOf('Animated drill-down menu'), css.indexOf('Visual polish')));
ok('the menu section was found in styles.css', menuSection.length > 800, true);
const menuDecls = [...menuSection.matchAll(/(?:^|[;{\s])(?:animation|animation-name|transition|animation-delay):([^;}]+)/g)].map(m => m[1]);
const menuDurations = menuDecls.flatMap(v => [...v.matchAll(/(\d*\.?\d+)s(?![a-z])/g)].map(m => Number(m[1])));
ok('and it declares motion durations at all', menuDurations.length >= 6, true);
ok('every duration in the menu is inside a 0.2s budget', menuDurations.filter(d => d > 0.2), []);
ok('the rows no longer animate in on their own', /menuRowIn|\.menu-level\.shown/.test(cssRules), false);
ok('and nothing in the menu is staggered', /nth-child\(\d+\)\s*\{\s*animation-delay/.test(cssRules), false);
ok('and app.js no longer arms a per-row entrance', /classList\.add\('shown'\)/.test(src), false);

// The phone edge bands were decorative, and each one was a full-page backdrop
// sample per scrolled frame — the same trade the sticky header and the modal
// scrims already lost. The rule is the whole file's: no element re-samples the
// page behind it. The bands themselves went in the slop pass, which is that trade
// taken one step further: a masked tint costs no re-sampling, but it still costs
// a painted strip on every scrolled frame plus a scroll listener and a header
// measurement to reveal it — ornament on a page whose surfaces are already flat.
ok('no declaration anywhere re-samples the page behind an element',
  /backdrop-filter\s*:/.test(cssRules), false);
ok('and the phone edge bands are gone, with everything that existed to drive them',
  /edge-blur|edge-scrolled|__hdrBottom/.test(cssRules + src), false);

// ---------- the flourishes, pinned absent ----------
// Every one of these was a delight rather than information: confetti at the
// month's end, a disk popping into a checkmark on Save, a checkmark popping on
// Paid, a donut drawing itself in, and a spotlight following the cursor across
// every card. They are pinned as ABSENT because each is a plausible-looking
// addition in review ("just a 0.3s pop") that buys a repaint on a screen someone
// is trying to read, and two of them carried a vendored library with them. The
// tests look at rules as well as call sites, so restoring one means deleting an
// assertion rather than quietly re-adding a rule.
ok('no confetti — not the burst, not the DOM fallback, not the keyframes',
  /triggerConfetti|domConfetti|confettiFall|\.confetti-piece/.test(cssRules + src), false);
ok('and neither of the two pop animations is back',
  /@keyframes (savePop|checkPop)/.test(cssRules), false);
ok('and nothing loads anime.js to draw the donut in',
  /anime\.min\.js|drawDonutAnimated/.test(src), false);
ok('and no card follows the cursor around',
  /initCardSpotlight|--mx|var\(--my/.test(cssRules + src), false);

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
  : `test-motion: OK — ${pass} assertions passed (a figure counts when it changes and rests on its exact total; a route change renders and waits on nothing; every chart mark is wired to a popup; nothing animates for its own sake)`);
process.exitCode = fails.length ? 1 : 0;
