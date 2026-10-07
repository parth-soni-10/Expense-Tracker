/* ============================================================
   insights.js — the #insights screen: the range picker, the
   category donut and its bars, the month-by-month chart, the
   stat cards (Savings rate among them), the data-health card,
   the range as a CSV, and the Year in review modal.

   Deferred like tesco.js: app.js fetches it on the first visit
   to #insights (and warms it when an Insights link is pointed
   at or tabbed to), so a session that never opens the tab never
   parses ~39 KB of drawing code. It reaches back into app.js
   for the shell's helpers through the export block app.js keeps
   for it — $, state, fmt, the label resolvers, wireChartTips —
   because a chart and the screen beside it must not become two
   answers to "what is category gro called". The imports from
   storage.js/csv.js are the same modules app.js imports; they
   are named directly rather than re-exported.
   ============================================================ */

import { downloadText, isValidCheckpointDate } from './storage.js';
import { csvDocument, CSV_BOM } from './csv.js';
// The shell's own names. `state` is a live binding, so the screen keeps
// reading the current document across a reload or a cloud merge.
import {
  $, state, today, fmt, friendlyDate, monthKey, monthLabel, offsetDateKey,
  persist, toast, iconSpan, isTopModal, methodLabel, methodShort, categoryLabel,
  entriesForMonth, catTotalsForEntries, emptyIcon, emptyStateCard,
  heatColor, heatDigitInk, stat, accountBalanceHistory, computeDataHealth,
  duplicateGroups, removeDuplicateEntry, reviewForMonth, wireChartTips,
  wireFlatpickr, isSpendingEntry, isIncomeEntry, isBudgetSpendingEntry,
  isBudgetIncomeEntry,
} from './app.js';

export function screenInsights() {
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  const fromParam = params.get('from') || '';
  const toParam = params.get('to') || '';
  // −89, not −90: "Last 90 days" ending today STARTS 89 days back, and the
  // two disagreed — so on load no preset was active at all, even though the
  // range on screen was exactly that one.
  const defaultFrom = offsetDateKey(today(), -89);
  let fromDate = isValidCheckpointDate(fromParam) ? fromParam : defaultFrom;
  let toDate = isValidCheckpointDate(toParam) ? toParam : today();
  // Keep malformed or reversed URL ranges from producing misleading totals,
  // and persist the corrected order so the URL and the pickers always agree.
  if (fromDate > toDate) {
    [fromDate, toDate] = [toDate, fromDate];
    params.set('from', fromDate);
    params.set('to', toDate);
    history.replaceState(null, '', '#insights?' + params.toString());
  }

  const rangeEntries = state.entries.filter(e => e.date >= fromDate && e.date <= toDate);
  const recent = rangeEntries;

  const c = $('section', { class: 'page-section insights-section', 'aria-label': 'Insights' });

  // Date range picker
  const fromInput = $('input', { type: 'date', value: fromDate, 'aria-label': 'From date', style: 'width:auto;font-size:13px;', onChange: (e) => {
    params.set('from', e.target.value); location.hash = 'insights?' + params.toString();
  } });
  const toInput = $('input', { type: 'date', value: toDate, 'aria-label': 'To date', style: 'width:auto;font-size:13px;', onChange: (e) => {
    params.set('to', e.target.value); location.hash = 'insights?' + params.toString();
  } });
  wireFlatpickr(fromInput, { defaultDate: fromDate });
  wireFlatpickr(toInput, { defaultDate: toDate });

  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, 'Where it goes.'),
    $('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' },
      fromInput,
      $('span', { class: 'muted range-sep' }, iconSpan('arrow-right', 'sm')),
      toInput,
      (fromParam || toParam) ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { location.hash = 'insights'; } }, 'Reset') : null,
      // The range as a file — the category table below, as CSV. Defined later
      // in this function (hoisted), because it reads figures computed below.
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'height:28px;padding:0 10px;font-size:12px;', onClick: () => exportInsightStats() }, 'Export stats'),
    ),
  ));

  // Quick range presets so the two date pickers aren't the only way in.
  const lastMonthStart = new Date(); lastMonthStart.setDate(1); lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
  const lastMonthKey = `${lastMonthStart.getFullYear()}-${String(lastMonthStart.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthDays = new Date(lastMonthStart.getFullYear(), lastMonthStart.getMonth() + 1, 0).getDate();
  const presetRanges = [
    { label: 'This month', from: monthKey(today()) + '-01', to: today() },
    { label: 'Last month', from: lastMonthKey + '-01', to: `${lastMonthKey}-${String(lastMonthDays).padStart(2, '0')}` },
    { label: 'Last 90 days', from: offsetDateKey(today(), -89), to: today() },
    { label: 'Year to date', from: `${new Date().getFullYear()}-01-01`, to: today() },
    // Whole ledger. The start is the earliest entry rather than a floor, so the
    // pill lights up the moment it is chosen and the range reads as a span of
    // real data instead of a 1970 the pickers have to swallow.
    { label: 'All time', from: state.entries.reduce((min, e) => (e.date < min ? e.date : min), today()), to: today() },
  ];
  const presetRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px;' },
    $('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;' }, 'Range'),
    ...presetRanges.map(p => $('button', {
      type: 'button', class: 'pill pill-cat', 'data-active': fromDate === p.from && toDate === p.to ? 'true' : 'false',
      'aria-pressed': fromDate === p.from && toDate === p.to ? 'true' : 'false',
      onClick: () => { params.set('from', p.from); params.set('to', p.to); location.hash = 'insights?' + params.toString(); },
    }, p.label)),
  );
  c.appendChild(presetRow);

  const months = {};
  for (const e of recent.filter(isSpendingEntry)) {
    const k = monthKey(e.date);
    months[k] = (months[k] || 0) + e.amount;
  }
  const monthList = Object.entries(months).sort(([a],[b]) => a.localeCompare(b));
  const avg = monthList.length ? monthList.reduce((s, [,v]) => s+v, 0) / monthList.length : 0;

  const methodTotals = {};
  for (const e of recent.filter(isSpendingEntry)) methodTotals[e.method] = (methodTotals[e.method] || 0) + e.amount;
  const topMethodEntry = Object.entries(methodTotals).sort((a,b) => b[1]-a[1])[0];
  const topCategoryEntry = Object.entries(catTotalsForEntries(recent)).sort((a, b) => b[1] - a[1])[0];
  const insightTotal = recent.filter(isSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  // Savings rate for THIS range, judged the way the month comparison judges
  // income: through the budget helpers, so transfers and fixed-cost
  // bookkeeping are not counted as take-home. No income in the range reads
  // '-' rather than a flattering or damning 0%.
  const rangeIncome = recent.filter(isBudgetIncomeEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const rangeSpend = recent.filter(isBudgetSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const savingsRate = rangeIncome > 0 ? Math.round(((rangeIncome - rangeSpend) / rangeIncome) * 100) : null;
  const rangeStartTime = Date.parse(`${fromDate}T00:00:00Z`);
  const rangeEndTime = Date.parse(`${toDate}T00:00:00Z`);
  const rangeLength = Number.isFinite(rangeStartTime) && Number.isFinite(rangeEndTime) && rangeEndTime >= rangeStartTime
    ? Math.floor((rangeEndTime - rangeStartTime) / 86400000) + 1
    : 0;
  const previousFrom = rangeLength ? offsetDateKey(fromDate, -rangeLength) : '';
  const previousTo = rangeLength ? offsetDateKey(fromDate, -1) : '';
  const insightPrevious = rangeLength
    ? state.entries.filter(entry => entry.date >= previousFrom && entry.date <= previousTo && isSpendingEntry(entry))
      .reduce((sum, entry) => sum + entry.amount, 0)
    : 0;
  const insightDelta = insightTotal - insightPrevious;

  c.appendChild($('div', { class: 'insight-narrative card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow' }, 'The short version'),
    $('p', { class: 'serif insight-narrative-text' }, recent.some(isSpendingEntry)
      ? `You spent ${fmt(insightTotal)} in this range${topCategoryEntry ? `, led by ${categoryLabel(topCategoryEntry[0])} at ${fmt(topCategoryEntry[1])}` : ''}.`
      : 'Log a few expenses and your spending story will appear here.'),
    insightPrevious > 0 ? $('div', { class: 'insight-narrative-note muted' },
      `${fmt(Math.abs(insightDelta))} ${insightDelta <= 0 ? 'less' : 'more'} than the preceding period.`,
    ) : null,
  ));

  if (state.entries.length === 0) {
    c.appendChild(emptyStateCard({ icon: 'chart', title: 'No data yet', blurb: 'Log a few expenses and your spending story, heatmap and charts will appear here.', actionLabel: 'Add your first entry', actionHref: '#add' }));
  }

  c.appendChild($('div', { class: 'insight-stats' },
    statCard('Average / month', fmt(avg)),
    statCard('Top method', topMethodEntry ? `${(methodShort(topMethodEntry[0]))} · ${fmt(topMethodEntry[1])}` : '-'),
    statCard('Spending entries', String(recent.filter(isSpendingEntry).length)),
    statCard('Categories active', String(new Set(recent.filter(isSpendingEntry).map(e => e.category)).size)),
    statCard('Savings rate', savingsRate === null ? '-' : `${savingsRate}%`),
  ));

  // Calendar heatmap - follows the selected range's end month, so it never
  // contradicts the date range the rest of the screen honours.
  const now = new Date();
  const heatKey = monthKey(toDate);
  const heatEntries = entriesForMonth(heatKey).filter(isSpendingEntry);
  const heatByDay = {};
  for (const e of heatEntries) heatByDay[e.date] = (heatByDay[e.date] || 0) + e.amount;
  const maxDay = Math.max(1, ...Object.values(heatByDay));
  const [hy, hm] = heatKey.split('-').map(Number);
  const lastDay = new Date(hy, hm, 0).getDate();
  const firstDow = new Date(hy, hm - 1, 1).getDay(); // 0=Sun
  // Mon-start: shift Sun→6, Mon→0 … Sat→5
  const monAdjusted = (firstDow + 6) % 7;
  
  const heatCells = [];
  for (let i = 0; i < monAdjusted; i++) heatCells.push($('div')); // empty leading cells
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${hy}-${String(hm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const val = heatByDay[ds] || 0;
    const intensity = maxDay > 0 ? val / maxDay : 0;
    const color = intensity === 0 ? 'var(--line)' : heatColor(
      intensity < 0.25 ? 0.22 : intensity < 0.5 ? 0.42 : intensity < 0.75 ? 0.65 : 1
    );
    const tip = val > 0 ? `${fmt(val)}` : '';
    const ttip = val > 0 ? `${friendlyDate(ds)} · ${fmt(val)}` : '';
    heatCells.push($('div', { class: 'heat-cell-wrap', style: 'position:relative;' },
      tip ? $('div', { class: 'heat-tip' }, tip) : null,
      $('div', {
        class: 'heat-cell', 'data-tip': ttip || null, role: 'button', tabindex: '0',
        'aria-label': `${friendlyDate(ds)}${val ? `, spent ${fmt(val)}` : ''} - view ${val ? 'these entries' : 'this day'} in history`,
        onClick: () => { location.hash = `history?month=${heatKey}&day=${ds}`; },
        onKeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            location.hash = `history?month=${heatKey}&day=${ds}`;
          }
        },
        style: `border-radius:5px;aspect-ratio:1;background:${color};cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;${val === 0 ? 'opacity:0.5;' : ''}${ds === today() ? 'box-shadow:0 0 0 1.5px var(--ink);' : ''}`,
      },
        val > 0 ? $('span', { style: `color:${heatDigitInk(intensity)};font-weight:600;font-size:8px;` }, String(d)) : null,
      ),
    ));
  }

  const heatGrid = $('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;' },
    ...['M','T','W','T','F','S','S'].map(l => $('div', { style: 'text-align:center;font-size:10px;color:var(--muted);padding-bottom:4px;' }, l)),
    ...heatCells,
  );
  wireChartTips(heatGrid, '.heat-cell[data-tip]');
  c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:12px;' }, `Spending heatmap · ${monthLabel(heatKey)}`),
    heatGrid,
    $('div', { style: 'margin-top:8px;font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px;' },
      $('span', null, 'Less'),
      ...[0, 0.25, 0.5, 0.75, 1].map(i => $('span', { style: `display:inline-block;width:12px;height:12px;border-radius:3px;background:${i===0?'var(--line)':heatColor(i)};` })),
      $('span', null, 'More'),
    ),
  ));

  const catTotals = catTotalsForEntries(recent);
  const catRows = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  // One drill for both category figures: the range on screen is the frame the
  // History screen's range mode takes verbatim, so the two screens compose —
  // click a slice or a bar and the ledger opens filtered to that category over
  // exactly these dates.
  const drillCategory = (cat) => { location.hash = `history?from=${fromDate}&to=${toDate}&cat=${cat}`; };

  // The range as a spreadsheet: the category table on screen, plus the frame
  // it was read over. csvCell's own rules ride along through csvDocument — a
  // category named "=Something" is defused like any other field.
  function exportInsightStats() {
    const rows = [['Category', 'Spending', 'Share of range']];
    for (const [cat, val] of catRows) {
      rows.push([categoryLabel(cat), Number(val).toFixed(2), insightTotal ? `${Math.round((val / insightTotal) * 100)}%` : '0%']);
    }
    rows.push([]);
    rows.push(['Range', `${fromDate} to ${toDate}`, '']);
    rows.push(['Spending', Number(insightTotal).toFixed(2), '']);
    rows.push(['Savings rate', savingsRate === null ? '' : `${savingsRate}%`, '']);
    downloadText(`insights-${fromDate}_${toDate}.csv`, CSV_BOM + csvDocument(rows), 'text/csv;charset=utf-8');
  }

  c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'By category'),
    catRows.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('coin'), ' No expenses in this range.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:22px;' },
          donutChart(catRows, drillCategory),
          $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
            ...catRows.map(([cat, val]) => barWithSpark(cat, val, maxCat, val === maxCat, drillCategory)),
          ),
        ),
  ));

  // Month-by-month grouped bars: spending vs income over the last 12 months
  c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'Month by month'),
    monthOverMonthChart(),
  ));

  // Category mix over time - stacked areas, so the shape of spending is readable
  // month to month without losing the category breakdown.
  const stacked = stackedAreaChart();
  if (stacked) {
    c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
      $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'Category mix over time'),
      stacked,
    ));
  }

  const methodRows = Object.entries(methodTotals).sort((a,b)=>b[1]-a[1]);
  const maxMethod = methodRows[0]?.[1] || 1;    c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'Payment mix'),
    methodRows.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('coin'), ' No expenses in this range.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
          ...methodRows.map(([m, val]) => bar(methodLabel(m), val, maxMethod, val === maxMethod)),
        ),
  ));

  // Account balance history
  const balanceHistory = accountBalanceHistory();
  if (balanceHistory.points.length > 0) {
    const chartW = 640, chartH = 170, padX = 42, padY = 18;
    const values = balanceHistory.points.flatMap(p => balanceHistory.methods.map(m => p.balances[m.id]));
    const minValue = Math.min(0, ...values), maxValue = Math.max(1, ...values), range = maxValue - minValue || 1;
    const xAt = i => padX + (balanceHistory.points.length === 1 ? 0 : i * ((chartW - padX * 1.5) / (balanceHistory.points.length - 1)));
    const yAt = value => chartH - padY - ((value - minValue) / range) * (chartH - padY * 2);
    const palette = ['var(--chart-line)', 'var(--muted)', 'var(--ink)'];
    const lines = balanceHistory.methods.map((method, index) => {
      const d = balanceHistory.points.map((point, i) => `${i ? 'L' : 'M'} ${xAt(i)} ${yAt(point.balances[method.id])}`).join(' ');
      return $('path', { d, style: `fill:none;stroke:${palette[index]};stroke-width:2;stroke-linecap:round;stroke-linejoin:round;` });
    });
    c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;overflow:hidden;' },
      $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px;' },
        $('div', null,        $('div', { class: 'eyebrow' }, 'Account balance history'), $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Month-end balances anchored to dated reconciliation checkpoints.')),
        $('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;' }, ...balanceHistory.methods.map((m, i) => $('span', { class: 'muted', style: 'font-size:11px;display:flex;align-items:center;gap:5px;' }, $('span', { style: `width:7px;height:7px;border-radius:50%;background:${palette[i]};` }), methodShort(m.id)))),
      ),
      $('svg', { viewBox: `0 0 ${chartW} ${chartH}`, role: 'img', 'aria-label': 'Account balance history chart', style: 'width:100%;height:auto;min-height:150px;overflow:visible;' },
        $('line', { x1: padX, y1: yAt(0), x2: chartW - padX / 2, y2: yAt(0), style: 'stroke:var(--line);stroke-width:1;' }),
        ...lines,
        ...balanceHistory.points.map((point, i) => $('text', { x: xAt(i), y: chartH - 2, 'text-anchor': i === 0 ? 'start' : i === balanceHistory.points.length - 1 ? 'end' : 'middle', style: 'fill:var(--muted);font-size:9px;' }, monthLabel(point.key).split(' ')[0].slice(0, 3))),
      ),
    ));
  }

  // Monthly review assistant
  const reviewKey = monthKey(today());
  const review = reviewForMonth(reviewKey);
  c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:12px;' }, `Monthly review · ${monthLabel(reviewKey)} · month to date`),
    $('div', { style: 'display:flex;flex-direction:column;gap:8px;' }, ...review.lines.map(line => $('div', { class: 'serif', style: 'font-size:16px;' }, line))),
  ));

  // Duplicate cleanup
  const duplicateSets = duplicateGroups();
  if (duplicateSets.length) {
    c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
      $('div', { class: 'row between', style: 'margin-bottom:12px;' }, $('div', { class: 'eyebrow' }, `Possible duplicates · ${duplicateSets.reduce((sum, group) => sum + group.length - 1, 0)}`), $('span', { class: 'muted', style: 'font-size:11px;' }, 'Keep the first, remove extras')),
      $('div', { style: 'display:flex;flex-direction:column;gap:10px;' }, ...duplicateSets.flatMap(group => group.slice(1).map(entry => $('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;' },
        $('div', { style: 'min-width:0;' }, $('div', { style: 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, entry.details), $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, `${friendlyDate(entry.date)} · ${methodShort(entry.method)} · ${fmt(entry.amount)}`)),
        $('button', { type: 'button', class: 'btn btn-danger', style: 'padding:5px 10px;font-size:11px;flex-shrink:0;', onClick: () => removeDuplicateEntry(entry.id) }, 'Delete duplicate'),
      )))),
    ));
  }

  // Data health card
  const health = computeDataHealth(state.entries);
  const healthColor = health.score >= 80 ? 'var(--positive)' : health.score >= 50 ? 'var(--accent)' : 'var(--negative)';
  c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
      $('div', { class: 'eyebrow' }, 'Data health'),
      $('span', { class: 'display-num', style: `font-size:22px;color:${healthColor};` }, `${health.score}%`),
    ),
    health.issues.length === 0
      ? $('div', { class: 'empty', style: 'padding:8px 0;display:inline-flex;align-items:center;gap:6px;' }, 'Your data looks clean!', iconSpan('sparkle', 'sm'))
      : $('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          ...health.issues.map(issue => $('div', { style: 'font-size:13px;padding:6px 0;border-bottom:1px solid var(--line);' }, '· ', issue)),
        ),
  ));

  // Year-in-review button
  c.appendChild($('div', { style: 'text-align:center;padding:16px 0;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: openYearInReview }, iconSpan('chart', 'md'), 'Year in review'),
  ));

  return c;
}
// A stat card's value is one headline, and not every headline is a total: the
// top method reads "AIB bank · €2475.99". Set at a total's 30px that wrapped
// onto a second line, overran its card and dominated the row, so the size
// follows the value's own length. What it must NOT do is decide the value: a
// figure arrives here already formatted (fmt(avg), never the raw float, which
// printed 5924.6900000000005) and the third tier is there so that a longer
// value than the row expected still fits the narrowest card the grid makes.
function statValueSize(value) {
  const n = String(value ?? '').length;
  if (n <= 10) return 30;
  if (n <= 16) return 22;
  return 18;
}
function statCard(label, value) {
  const numEl = $('div', { class: 'display-num stat-value', style: `font-size:${statValueSize(value)}px;margin-top:8px;` }, value);
  return $('div', { class: 'card stat-card' },
    $('div', { class: 'eyebrow' }, label),
    numEl,
  );
}
function bar(label, value, max, isMax) {
  return $('div', null,
    $('div', { class: 'row between', style: 'font-size:13px;margin-bottom:8px;' },
      $('span', null, label),
      $('span', { class: 'display-num', style: 'font-size:14px;' }, fmt(value)),
    ),
    $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;' },
      $('div', { style: `height:100%;width:${(value/max)*100}%;background:${isMax ? 'var(--accent)' : 'var(--bar-soft)'};border-radius:99px;transition:width .5s cubic-bezier(0.2,0.8,0.2,1);` }),
    ),
  );
}

// ---------- category bars with sparkline ----------
/** Monthly spending totals for a category over the last N months. */
function categorySparkData(catId, months = 12) {
  const now = new Date();
  const keys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys.map(key => entriesForMonth(key).filter(e => isSpendingEntry(e) && e.category === catId).reduce((s, e) => s + e.amount, 0));
}

function sparklinePath(values, w = 60, h = 20) {
  const mn = Math.min(...values), mx = Math.max(...values);
  const rng = mx - mn || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - 3 - ((v - mn) / rng) * (h - 6)).toFixed(1)}`).join(' ');
}

function barWithSpark(cat, val, max, isMax, onPick = null) {
  const values = categorySparkData(cat);
  const hasSpark = values.some(v => v > 0);
  // The row is named by its own text (category + amount), so it needs no
  // aria-label — and must not have one: two controls on one screen sharing an
  // addressed identity is a defect in this app, not a nicety.
  const pick = onPick ? {
    role: 'button', tabindex: '0', style: 'cursor:pointer;',
    onClick: () => onPick(cat),
    onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(cat); } },
  } : {};
  return $('div', { class: 'insight-bar-row', ...pick },
    $('div', { class: 'row between', style: 'font-size:13px;margin-bottom:8px;' },
      $('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;' },
        hasSpark ? $('svg', { width: '60', height: '20', 'aria-hidden': 'true', style: 'flex-shrink:0;' },
          $('path', { d: sparklinePath(values), style: 'fill:none;stroke:var(--chart-line);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;' }),
        ) : null,
        $('span', { style: 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, categoryLabel(cat)),
      ),
      $('span', { class: 'display-num', style: 'font-size:14px;' }, fmt(val)),
    ),
    $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;' },
      $('div', { style: `height:100%;width:${(val / max) * 100}%;background:${isMax ? 'var(--accent)' : 'var(--bar-soft)'};border-radius:99px;transition:width .5s cubic-bezier(0.2,0.8,0.2,1);` }),
    ),
  );
}

// ---------- donut chart ----------
// SVG donut built from stroke-dasharray segments. Starts at 12 o'clock and
// sweeps clockwise; the centre shows the total. Legend lists share per slice.
const DONUT_PALETTE = ['var(--accent)', 'color-mix(in srgb, var(--accent) 82%, var(--bg))', 'color-mix(in srgb, var(--accent) 64%, var(--bg))', 'color-mix(in srgb, var(--accent) 48%, var(--bg))', 'color-mix(in srgb, var(--accent) 34%, var(--bg))', 'var(--muted)', 'color-mix(in srgb, var(--muted) 55%, var(--bg))', 'var(--line)'];
function donutChart(rows, onPick = null) {
  const total = rows.reduce((s, [, v]) => s + v, 0);
  if (!total) return null;
  const R = 52, C = 2 * Math.PI * R, W = 180, H = 180;
  let acc = 0;
  const segments = rows.map(([cat, val], i) => {
    const frac = val / total;
    const len = Math.max(0, frac * C - 2);
    const finalOff = -acc * C;
    // A slice is a target and a figure: clickable to the entries behind it
    // (named, because an SVG shape carries no text of its own), while the
    // legend beside it is named by its own text.
    const seg = $('circle', {
      cx: W / 2, cy: H / 2, r: R, fill: 'none', stroke: DONUT_PALETTE[i % DONUT_PALETTE.length],
      'stroke-width': 16, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': String(finalOff - len),
      'data-chart-tip': `${categoryLabel(cat)} · ${fmt(val)} · ${Math.round(frac * 100)}%`,
      ...(onPick ? {
        role: 'button', tabindex: '0', 'aria-label': `View ${categoryLabel(cat)} in history`,
        onClick: () => onPick(cat),
        onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(cat); } },
      } : {}),
      style: `transition:stroke-dasharray .6s cubic-bezier(0.2,0.8,0.2,1);${onPick ? 'cursor:pointer;' : ''}`,
    });
    seg._finalOff = finalOff;
    acc += frac;
    return seg;
  });
  // No draw-in: every segment is set to its final offset as it is built. A
  // sweep here replayed on every repaint of the card, and a chart is a figure
  // the reader has come to read rather than an arrival to announce.
  segments.forEach(seg => seg.setAttribute('stroke-dashoffset', String(seg._finalOff)));
  const legend = rows.map(([cat, val], i) => {
    const pct = Math.round((val / total) * 100);
    // The legend prints the share; the popup is where the money is. Named by
    // its own text when it is also a way into the ledger.
    return $('div', {
      'data-chart-tip': `${categoryLabel(cat)} · ${fmt(val)} · ${pct}%`,
      style: 'display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;',
      ...(onPick ? {
        role: 'button', tabindex: '0',
        onClick: () => onPick(cat),
        onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(cat); } },
      } : {}),
    },
      $('span', { style: `width:8px;height:8px;border-radius:2px;background:${DONUT_PALETTE[i % DONUT_PALETTE.length]};flex-shrink:0;` }),
      $('span', { style: 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, categoryLabel(cat)),
      $('span', { class: 'muted', style: 'flex-shrink:0;' }, `${pct}%`),
    );
  });
  const donut = $('div', { style: 'display:flex;align-items:center;gap:28px;flex-wrap:wrap;' },
    $('div', { style: 'position:relative;flex-shrink:0;' },
      $('svg', { viewBox: `0 0 ${W} ${H}`, width: '150', height: '150', 'aria-label': 'Category share donut', style: 'transform:rotate(-90deg);' }, ...segments),
      $('div', { style: 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;' },
        $('span', { class: 'display-num', style: 'font-size:20px;' }, fmt(total)),
        $('span', { class: 'muted', style: 'font-size:10px;' }, 'spent'),
      ),
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:8px;flex:1;min-width:150px;' }, ...legend),
  );
  wireChartTips(donut, '[data-chart-tip]');
  return donut;
}

// ---------- month-over-month comparison ----------
// Grouped bars for the last 12 calendar months: spending (accent) vs income
// (positive), so trends across the year read at a glance.
function monthOverMonthChart() {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let exp = 0, inc = 0;
    for (const e of entriesForMonth(key)) {
      if (isSpendingEntry(e)) exp += e.amount;
      else if (isIncomeEntry(e)) inc += e.amount;
    }
    months.push({ key, exp, inc });
  }
  const max = Math.max(1, ...months.flatMap(m => [m.exp, m.inc]));
  const W = 640, H = 170, padB = 24, padT = 10;
  const slot = W / months.length;
  const bw = Math.min(16, slot * 0.2);
  const xAt = i => i * slot + (slot - bw * 2 - 4) / 2;
  const yAt = v => H - padB - (v / max) * (H - padB - padT);
  const rects = [];
  const labels = [];
  const hits = [];
  months.forEach((m, i) => {
    const x = xAt(i);
    if (m.exp > 0) rects.push($('rect', { x, y: yAt(m.exp), width: bw, height: H - padB - yAt(m.exp), rx: 2, style: 'fill:var(--chart-bar);' }));
    if (m.inc > 0) rects.push($('rect', { x: x + bw + 4, y: yAt(m.inc), width: bw, height: H - padB - yAt(m.inc), rx: 2, style: 'fill:var(--positive);' }));
    labels.push($('text', { x: x + bw + 2, y: H - 8, 'text-anchor': 'middle', style: 'fill:var(--muted);font-size:9px;' }, monthLabel(m.key).split(' ')[0].slice(0, 3)));
    // A month is one target, not two: a bw-wide bar is ~10px, which is not a
    // hover target on a phone, and a month's two figures belong together anyway.
    // Appended last so it sits over the bars it covers, and painted rather than
    // `fill: none` — a transparent fill is still a fill, so it takes the events.
    // The target doubles as the way into that month's ledger (Enter/Space too,
    // and named, because a shape carries no text). The svg's own role goes with
    // it: a role="img" would declare the children presentational and hide every
    // one of these from a screen reader.
    hits.push($('rect', {
      class: 'mom-hit', x: i * slot, y: padT, width: slot, height: H - padB - padT, rx: 4, fill: 'transparent',
      'data-chart-tip': `${monthLabel(m.key)} · Spending ${fmt(m.exp)} · Income ${fmt(m.inc)}`,
      role: 'button', tabindex: '0', 'aria-label': `View ${monthLabel(m.key)} in history`,
      onClick: () => { location.hash = `history?month=${m.key}`; },
      onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); location.hash = `history?month=${m.key}`; } },
    }));
  });
  const chart = $('div', null,
    $('div', { style: 'display:flex;gap:14px;justify-content:flex-end;margin-bottom:10px;' },
      $('span', { class: 'muted', style: 'font-size:11px;display:flex;align-items:center;gap:5px;' }, $('span', { style: 'width:8px;height:8px;border-radius:2px;background:var(--chart-bar);' }), 'Spending'),
      $('span', { class: 'muted', style: 'font-size:11px;display:flex;align-items:center;gap:5px;' }, $('span', { style: 'width:8px;height:8px;border-radius:2px;background:var(--positive);' }), 'Income'),
    ),
    $('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-label': 'Monthly spending vs income, last 12 months', style: 'width:100%;height:auto;' }, ...rects, ...labels, ...hits),
  );
  wireChartTips(chart, '[data-chart-tip]');
  return chart;
}

// ---------- stacked area chart ----------
// Category mix over the last 12 months as stacked SVG areas. Top 6 categories
// by total spend; everything else is folded out so the legend stays readable.
function stackedAreaChart() {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const totals = {};
  for (const key of months) {
    for (const e of entriesForMonth(key)) if (isSpendingEntry(e)) totals[e.category] = (totals[e.category] || 0) + e.amount;
  }
  const topCats = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
  if (!topCats.length) return null;
  const series = topCats.map(cat => months.map(key => entriesForMonth(key).filter(e => isSpendingEntry(e) && e.category === cat).reduce((s, e) => s + e.amount, 0)));
  const W = 640, H = 170, padL = 8, padR = 8, padB = 24, padT = 10;
  const maxTotal = Math.max(1, ...months.map((_, i) => topCats.reduce((s, __, ci) => s + series[ci][i], 0)));
  const xAt = i => padL + (months.length === 1 ? 0 : i * ((W - padL - padR) / (months.length - 1)));
  const yAt = v => H - padB - (v / maxTotal) * (H - padB - padT);
  const layers = topCats.map((cat, ci) => {
    const stack = series[ci].map((v, i) => {
      const base = ci === 0 ? 0 : topCats.slice(0, ci).reduce((s, __, cj) => s + series[cj][i], 0);
      return { top: base + v, bottom: base };
    });
    const fwd = stack.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(s.top).toFixed(1)}`).join(' ');
    const back = stack.slice().reverse().map((s, i) => `L ${xAt(months.length - 1 - i).toFixed(1)} ${yAt(s.bottom).toFixed(1)}`).join(' ');
    return $('path', { d: `${fwd} ${back} Z`, style: `fill:${DONUT_PALETTE[ci % DONUT_PALETTE.length]};opacity:0.85;` });
  });
  const labels = months.map((key, i) => $('text', { x: xAt(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle', style: 'fill:var(--muted);font-size:9px;' }, monthLabel(key).split(' ')[0].slice(0, 3)));
  return $('div', { class: 'chart-fade' },
    $('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:10px;' },
      ...topCats.map((cat, ci) => $('span', { class: 'muted', style: 'font-size:11px;display:flex;align-items:center;gap:5px;' }, $('span', { style: `width:8px;height:8px;border-radius:2px;background:${DONUT_PALETTE[ci % DONUT_PALETTE.length]};flex-shrink:0;` }), categoryLabel(cat))),
    ),
    $('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Category mix over the last 12 months', style: 'width:100%;height:auto;' }, ...layers, ...labels),
  );
}

// ---------- modal: year in review ----------
export function openYearInReview() {
  const now = new Date();
  const year = now.getFullYear();
  const yearEntries = state.entries.filter(e => e.date >= `${year}-01-01` && e.date <= `${year}-12-31`);
  const expOnly = yearEntries.filter(isSpendingEntry);
  const incOnly = yearEntries.filter(isIncomeEntry);
  const totalSpent = expOnly.reduce((s,e) => s + e.amount, 0);
  const totalEarned = incOnly.reduce((s,e) => s + e.amount, 0);
  const topCat = Object.entries(expOnly.reduce((a,e) => { a[e.category] = (a[e.category]||0) + e.amount; return a; }, {})).sort((a,b) => b[1]-a[1])[0];
  const busiestDay = Object.entries(expOnly.reduce((a,e) => { const v = a[e.date]||{count:0,total:0}; a[e.date] = {count:v.count+1,total:v.total+e.amount}; return a; }, {})).sort((a,b) => b[1].total - a[1].total)[0];
  const months = {};
  for (const e of expOnly) { const k = monthKey(e.date); months[k] = (months[k]||0) + e.amount; }
  const bestMonth = Object.entries(months).sort((a,b) => a[1]-b[1])[0];
  const worstMonth = Object.entries(months).sort((a,b) => b[1]-a[1])[0];

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Year in review', tabindex: '-1', style: 'max-width:560px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);
  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:28px;' }, `Your ${year} in review`),
    $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close'),
  ));

  const rows = [
    ['Total earned', fmt(totalEarned), 'var(--positive)'],
    ['Total spent', fmt(totalSpent), 'var(--negative)'],
    ['Net', fmt(totalEarned - totalSpent), (totalEarned - totalSpent) >= 0 ? 'var(--positive)' : 'var(--negative)'],
    ['Entries logged', String(yearEntries.length), ''],
    ['Top category', topCat ? `${categoryLabel(topCat[0])} · ${fmt(topCat[1])}` : '-', ''],
    ['Best month', bestMonth ? `${monthLabel(bestMonth[0])} · ${fmt(bestMonth[1])}` : '-', ''],
    ['Toughest month', worstMonth ? `${monthLabel(worstMonth[0])} · ${fmt(worstMonth[1])}` : '-', ''],
    ['Busiest day', busiestDay ? `${friendlyDate(busiestDay[0])} - ${busiestDay[1].count} entries, ${fmt(busiestDay[1].total)}` : '-', ''],
  ];
  for (const [label, value, color] of rows) {
    modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px;' },
      $('span', { class: 'muted' }, label),
      $('span', { class: 'display-num', style: color ? `color:${color};font-size:16px;` : 'font-size:16px;' }, value),
    ));
  }

  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;' },
    // Print / save as PDF: the review is the one thing in this app worth
    // putting on paper, and the print stylesheet shows ONLY this sheet — the
    // header, the screen behind it and the toast stack are all suppressed.
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => {
      document.body.classList.add('printing-review');
      const done = () => { document.body.classList.remove('printing-review'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      // Some embedded webviews never fire afterprint; the class is harmless
      // there, but a delayed sweep keeps the page from staying hidden.
      setTimeout(done, 30000);
      window.print();
    } }, 'Print'),
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Close'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const text = rows.map(([l,v]) => `${l}: ${v}`).join('\n');
      const doCopy = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
        toast(ok ? 'Copied to clipboard!' : 'Could not copy.');
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard!'), doCopy);
      } else {
        doCopy();
      }
    } }, 'Copy summary'),
  ));
}
