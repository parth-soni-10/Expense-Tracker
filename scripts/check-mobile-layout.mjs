#!/usr/bin/env node
/**
 * Keeps a rendered figure inside the box it is rendered in, at a phone width.
 *
 * Why this is a guard rather than a style rule: a Node script cannot read a
 * rendered DOM, but the two ways this failed are both static and both silent.
 *
 *   1. A figure reached the card UNFORMATTED. The Insights row read
 *      `statCard('Average / month', avg)` — the raw float — and printed
 *      `5924.6900000000005` at 30px, wider than the 306px card, in a card whose
 *      overflow is visible, so it simply drew past its own border. Every
 *      sibling stat went through fmt(); this one did not, and nothing about
 *      passing a number where a string belongs is an error in JS. The check
 *      below is on the ARGUMENT, so it catches the shape and not the instance:
 *      a bare number, a bare identifier or a bare member chain is refused.
 *
 *   2. A value was too long for the type size it was set at. `statValueSize()`
 *      is lifted out of app.js and run here (app.js cannot be imported — it
 *      touches the DOM on evaluation), so the tiers are checked rather than
 *      eyeballed: a longer value never gets a bigger size, a size is never
 *      larger than the row's own 30px, and the two values this row really
 *      produces land where the fix put them. The CSS beside it is the belt:
 *      a grid item is `min-width: auto`, which lets its content push the track
 *      wider than the grid meant it to be, and `overflow-wrap` is what turns a
 *      value that outgrows its card into a second line instead of a spill.
 *
 * The third part is the same failure in the dock. Six tabs at a 10px label and
 * a 22px icon came to 323px inside a 277px bar: `flex: 1` cannot shrink an item
 * past its min-content width, and a flex item's min-content is its longest
 * word, so the last tab — Insights, on the screen this was found on — hung off
 * the edge of the display instead of compressing. `min-width: 0` is what
 * unlocks the shrink and the label's own ellipsis guard is what stops it
 * spilling if a seventh tab is ever added.
 *
 * Every fix here was measured on the served app at 320, 360, 390, 480 and
 * 1000px, on all six routes (laying every row out first — `content-visibility:
 * auto` means a below-the-fold row is never laid out, so a static audit of the
 * page reports it clean). What a Node guard can hold is the part that regresses
 * without a browser: change `fmt(avg)` back to `avg` or delete one `min-width`
 * and this fails.
 *
 * Three things a sweep of this page will report that are NOT defects, named here
 * so they are not "fixed": a `margin: -5px -6px` action button (a tap target
 * bleeding into its card's padding, while the button's own box does not
 * overflow); the heatmap's `.heat-tip` (absolutely positioned, `opacity: 0`, and
 * `display: none` once tippy has wired the scope); and the `body[data-wide]`
 * history table, whose `.card` is `overflow-x: auto` on purpose — its children
 * past the viewport are the table scrolling inside its own box.
 *
 * Run: node scripts/check-mobile-layout.mjs
 * Also wired into the Netlify build command (netlify.toml).
 */
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
// The Insights row (statCard, statValueSize, every call site) moved into the
// deferred insights.js in the boot split, so both files are scanned: a bare
// figure must not become legal by changing file.
const insights = readFileSync(new URL('../insights.js', import.meta.url), 'utf8');
const cssRaw = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
// Comments come off first, and not for tidiness: the notes in both files name
// what was removed and why, so a search for `statValueSize` or `min-width` would
// find the explanation of the rule rather than the rule.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0;
const fails = [];
const ok = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n     got ${g}\n    want ${w}`);
};

/** The top-level arguments of every `statCard(...)` call, split on depth-0 commas. */
function statCardCalls(src) {
  const out = [];
  const re = /statCard\(/g;
  let m;
  while ((m = re.exec(src))) {
    // `function statCard(label, value)` is the declaration, not a call: its
    // second parameter is a bare identifier and always would be.
    if (/function\s+$/.test(src.slice(0, m.index))) continue;
    let i = m.index + m[0].length;
    let depth = 1, arg = '', args = [], quote = null;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') { arg += ch + (src[++i] ?? ''); continue; }
        if (ch === quote) quote = null;
        arg += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; arg += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) break; }
      if (ch === ',' && depth === 1) { args.push(arg.trim()); arg = ''; continue; }
      arg += ch;
    }
    args.push(arg.trim());
    out.push({ args, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

// ---- 1. a figure reaches the card already formatted ----------------------
// Each call carries the file it lives in: `line 1234` is meaningless when the
// next line of the failure could be in the other module.
const callsOf = (src, file) => statCardCalls(src).map(c => ({ ...c, where: `${file}:${c.line}` }));
const calls = [...callsOf(app, 'app.js'), ...callsOf(insights, 'insights.js')];
ok('statCard is still called from the Insights row', calls.length >= 2, true);
ok('and every call passes a label and a value',
  calls.filter(c => c.args.length !== 2).map(c => c.where), []);

// A bare value: `avg`, a number literal, or `x.y` — a figure handed over as
// itself rather than as the string the card renders. `fmt(x)`, `String(x)` and a
// literal are the shapes that are allowed; anything else has to be a phrase the
// caller built, which an inline call or ternary covers.
const BARE = [
  /^[A-Za-z_$][\w$]*$/,                             // identifier
  /^-?\d+(\.\d+)?$/,                                // numeric literal
  /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/,        // member chain, no call
];
const WHOLE_CALL = /^([A-Za-z_$][\w$]*)\s*\(/;
const FORMATTERS = new Set(['fmt', 'String']);
const unformatted = calls.filter(c => {
  const v = c.args[1] ?? '';
  if (BARE.some(re => re.test(v))) return true;
  const whole = WHOLE_CALL.exec(v);
  return whole ? !FORMATTERS.has(whole[1]) : false;
}).map(c => `${c.where}: ${c.args[1]}`);
ok('no stat value is handed over as a bare figure', unformatted, []);

// ---- 2. the size the value is set at fits the card -----------------------
const fnAt = insights.indexOf('function statValueSize');
const fnEnd = insights.indexOf('\n}\n', fnAt);
if (fnAt < 0 || fnEnd < 0) {
  console.error('check-mobile-layout: statValueSize is no longer where this guard looks for it in insights.js.');
  process.exit(1);
}
const fnCode = insights.slice(fnAt, fnEnd + 2);
if (!/function statValueSize/.test(fnCode) || fnCode.length > 600) {
  console.error(`check-mobile-layout: lifted an implausible slice (${fnCode.length} chars) — check the markers in insights.js.`);
  process.exit(1);
}
const statValueSize = new Function(`${fnCode}\nreturn statValueSize;`)();

// `fmt` lives in app.js and cannot be imported; this is only the shape of the
// argument the call sites are checked against.
const fmtLike = (n) => `${n < 0 ? '−' : ''}€${Math.abs(n).toFixed(2)}`;

// The figure the shipped defect printed was the raw float, 18 characters at
// 30px and wider than the card it sat in. Both the formatted total and that
// float have to be answered, and the float small.
ok('a total is set at the row size', statValueSize(fmtLike(5924.69)), 30);
ok('a total with thousands separators still fits the row size', statValueSize('€12,345.67'), 30);
ok('and the unformatted float the bug printed is not', statValueSize('5924.6900000000005') < 30, true);
ok('a phrase is set smaller than a total',
  statValueSize('AIB bank · €2475.99') < statValueSize('€5924.69'), true);
ok('and the size never grows with the value',
  Array.from({ length: 60 }, (_, n) => n).every(n => {
    const a = statValueSize('x'.repeat(n + 1)), b = statValueSize('x'.repeat(n));
    return a <= b;
  }), true);
ok('and is always a positive number inside the row ceiling',
  [0, 1, 5, 40].every(n => {
    const s = statValueSize('x'.repeat(n));
    return typeof s === 'number' && s > 0 && s <= 30;
  }), true);
ok('an empty or missing value is still answered', [statValueSize(null), statValueSize(undefined), statValueSize('')].map(s => typeof s === 'number' && s > 0), [true, true, true]);

// ---- 3. the CSS that keeps a value inside its own card -------------------
/** Body of the first `selector { … }` rule, or null. */
const ruleBody = (text, selector) => {
  const at = text.indexOf(selector + ' {');
  if (at < 0) return null;
  const open = text.indexOf('{', at), close = text.indexOf('}', open);
  return close < 0 ? null : text.slice(open + 1, close);
};
/** Body of the media block whose query matches, and which contains `needle`. */
const mediaBody = (text, query, needle) => {
  const re = new RegExp(`@media \\(${query}\\) \\{`, 'g');
  let m;
  while ((m = re.exec(text))) {
    let i = text.indexOf('{', m.index), depth = 1;
    for (i++; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const body = text.slice(m.index, i);
    if (needle ? body.includes(needle) : true) return body;
  }
  return null;
};

const statsRow = ruleBody(css, '.insight-stats');
ok('the stat row is a rule in styles.css', typeof statsRow === 'string', true);
ok('and it is the grid the four cards are laid out in',
  /display\s*:\s*grid/.test(statsRow ?? ''), true);

const statCard = ruleBody(css, '.stat-card');
const statValue = ruleBody(css, '.stat-value');
ok('the card disclaims its grid item min-width', /min-width\s*:\s*0/.test(statCard ?? ''), true);
ok('and so does the value', /min-width\s*:\s*0/.test(statValue ?? ''), true);
// .display-num's line-height was written for 30px type. A value set smaller
// rides that band; a value that wraps puts its second line inside the first
// line's glyphs. The rule has to set its own.
ok('and the value sets its own line-height', /line-height\s*:/.test(statValue ?? ''), true);
ok('and can wrap rather than spill its card',
  /overflow-wrap\s*:\s*(anywhere|break-word)/.test(statValue ?? ''), true);

// The phone has to be able to change the row: an inline gap/margin outranks a
// media query, which is how the phone rule below was dead text. Scanned across
// both files — the row itself is built in insights.js since the boot split.
ok('the stat row carries no inline layout the phone cannot override',
  /class: 'insight-stats', style:/.test(app + insights), false);
const phoneStats = mediaBody(css, 'max-width: 639px', '.stat-card');
ok('the phone block tightens the row rather than the desktop rules alone',
  /\.insight-stats\s*\{[^}]*gap\s*:/.test(phoneStats ?? ''), true);

// ---- 4. the dock compresses instead of hanging off the screen ------------
const dockMedia = mediaBody(css, 'max-width: 639px', '.bottom-tab {');
ok('the bottom dock is still a phone-width rule', typeof dockMedia === 'string', true);
const dockTab = ruleBody(dockMedia ?? '', '.bottom-tab');
ok('a dock tab disclaims its flex item min-width', /min-width\s*:\s*0/.test(dockTab ?? ''), true);
ok('and its label can ellipsize rather than push the tab off-screen',
  /\.bottom-tab\s*>\s*span\s*\{[^}]*text-overflow\s*:\s*ellipsis/.test(dockMedia ?? ''), true);
// Six tabs is the whole of TABS; if the dock ever has to hold more, it has to
// be checked at a phone width again rather than assumed to still fit.
ok('the dock is sized for the tabs the app declares',
  (app.match(/^\s*\{ id: '(dashboard|add|history|balances|tesco|insights)', label:/gm) ?? []).length, 6);

// ---- 5. the History row's columns cannot be starved by its buttons -------
// The phone layout is `auto minmax(0, 1fr) auto`: the middle track is the one
// that gives, and the third is `auto`, so it is sized by its widest cell — and
// the two action buttons ("Exclude budget" is 106px on its own) are far wider
// than any figure. Measured at a 320px viewport the middle column came out 28px
// wide and the method pill ("Revolut Main", 77px) painted over the button beside
// it in the same grid row: an overlap of painted text, confirmed by measuring the
// text ranges, not a tight gap. Below 360px the buttons take a row of their own,
// which frees the figures' column to size to the figures (71px) and the middle to
// 133px. Above that the same row fits as it is, so the rule is scoped to where it
// actually breaks rather than to the whole phone range.
const histPhone = mediaBody(css, 'max-width: 639px', '.history-row {');
ok('the history row is still a phone-width rule', typeof histPhone === 'string', true);
ok('with the middle column as the flexible track',
  /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/.test(histPhone ?? ''), true);
const histNarrow = mediaBody(css, 'max-width: 359px', '.history-actions');
ok('and below 360px the row actions leave the figures\' column',
  /\.history-actions\s*\{[^}]*grid-column:\s*2\s*\/\s*4/.test(histNarrow ?? ''), true);
ok('and take their own grid row there',
  /\.history-actions\s*\{[^}]*grid-row:\s*4/.test(histNarrow ?? ''), true);

// ---- 6. the account meta line wraps where the row stacks ----------------
// "recorded loads €0.00 · spending …" was an inline `white-space: nowrap`, and an
// inline declaration is the one thing a media query cannot override: below 480px
// this row stacks, and 202px of nowrap text behind the account name pushed the
// row 22px past its own card at a 320px viewport. It is a stylesheet rule now, so
// the phone query can reach it.
const metaSpans = (app.match(/class: 'muted balance-row-meta'/g) ?? []).length;
ok('the account meta line is styled from the stylesheet', metaSpans >= 3, true);
ok('and no inline nowrap is left on it',
  /font-size:10px;white-space:nowrap/.test(app), false);
const metaRule = ruleBody(css, '.balance-row-meta');
ok('the meta line declares its own type',
  /font-size\s*:\s*10px/.test(metaRule ?? '') && /white-space\s*:\s*nowrap/.test(metaRule ?? ''), true);
ok('and can wrap on a phone, where the row is stacked and has no room',
  /\.balance-row-meta\s*\{\s*white-space\s*:\s*normal/.test(mediaBody(css, 'max-width: 639px', '.balance-row-meta') ?? ''), true);

// ---- 7. the net worth figure is TODAY's balance, not the last entry's ----
// The dashboard card painted `vals[vals.length - 1]` — the balance at the most
// recent ENTRY's date, which equals today's total only when the last account
// entry IS today. A reconcile recorded after that entry (the normal
// reconcile-then-wait window) changes every balance on screen but not that
// point, so the card showed the pre-reconcile BOOK value — inflated whenever
// actual < book, which is the very reason one reconciles — while the hero and
// the Balances screen showed the truth, self-healing only on the next
// transaction. Reproduced at 479.78 vs 50.00 on a seeded ledger. The figure
// must be `runningBalance` (today's checkpoint-aware total), and the trend
// must get a final point at today so the line lands on the number it labels.
const nwPaint = /paintFigure\(netWorthEl, 'dashboard-net-worth', (\w+)\)/.exec(app);
ok('the net worth card still paints a figure', !!nwPaint, true);
const nwSrc = nwPaint
  ? (app.match(new RegExp(`const ${nwPaint[1]} = [^;]+;`)) ?? [])[0]
  : null;
ok("and that figure is today's checkpoint-aware total, not a point's balance",
  !!nwSrc && /runningBalance/.test(nwSrc), true);
ok('the balance at the last entry date is never handed to it again',
  /const lastVal = vals\[vals\.length - 1\]/.test(app), false);
ok('and the sparkline ends at today, where the number reads',
  /points\.at\(-1\)\.date < today\(\)/.test(app)
  && /\[\.\.\.points, \{ date: today\(\), balance: runningBalance \}\]/.test(app), true);

console.log(fails.length
  ? `check-mobile-layout: ${fails.length} FAILED\n\n${fails.join('\n')}`
  : `check-mobile-layout: OK — ${pass} assertions passed (a figure reaches its card formatted, at a size its own length chose; the card and the value can neither push their track wider nor spill; six dock tabs compress instead of hanging off the screen; a history row's action buttons cannot starve the column its labels sit in, and the account meta line wraps where the row stacks; net worth reads today's checkpoint-aware balance, never the last entry's book value)`);
process.exitCode = fails.length ? 1 : 0;
