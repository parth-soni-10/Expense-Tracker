/* ============================================================
   Expense Tracker — editorial-minimal SPA
   Hash routing: #dashboard (default) | #add | #history | #insights
   ============================================================ */
import { loadState, saveState, resetToBlank, exportJSON, validateState, uid } from './storage.js';
import { CATEGORIES, METHODS } from './seed.js';
import { getSyncSettings, patchSyncSettings, clearSyncSettings } from './settings.js';
import { syncPull, syncPush, syncTestConnection, syncStatus, relativeTime, notifySyncChange, subscribeSync } from './sync.js';

// ---------- state ----------
let state = loadState();
const today = () => new Date().toISOString().slice(0, 10);

function persist() {
  saveState(state);
  // Track the last local edit so initSync can warn if the cloud is fresher.
  state.lastLocalChangeAt = new Date().toISOString();
  scheduleSyncPush();
}

// ---------- sync scheduler ----------
let pushTimer = null;
function scheduleSyncPush() {
  if (pushTimer) clearTimeout(pushTimer);
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  pushTimer = setTimeout(doAutoPush, 1500);
}

let sessionSyncFailed = false;
async function doAutoPush() {
  pushTimer = null;
  const s = getSyncSettings();
  let r = await syncPush(state, { sha: s.lastSha, message: 'cents: auto push' });
  // One retry on transient network: handles flaky mobile without nagging the user.
  // Refresh sha before retry so a concurrent push from another device will surface as 409 instead of being clobbered.
  if (!r.ok && r.reason === 'network') {
    await new Promise(res => setTimeout(res, 1000));
    const pulled = await syncPull();
    if (pulled.ok) {
      patchSyncSettings({ lastSha: pulled.sha });
      r = await syncPush(state, { sha: pulled.sha, message: 'cents: auto push (retry)' });
    }
  }
  if (r.ok) {
    patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
    // Success: if a previous sync in this session failed and we're now back, toast once and reset.
    if (sessionSyncFailed) {
      toast('✨ Cloud sync recovered.');
      sessionSyncFailed = false;
    }
  } else {
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
    // First failure in this session: toast once. Stay quiet on subsequent failures until a sync succeeds again.
    if (!sessionSyncFailed && r.reason !== 'conflict') {
      toast('☠ Cloud sync failed: ' + (r.message || r.reason || 'error') + '. Changes saved locally.');
      sessionSyncFailed = true;
    }
  }
  notifySyncChange();
}

async function initSync() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  const r = await syncPull();
  if (r.ok && r.content) {
    const incomingCount = (r.content && Array.isArray(r.content.entries)) ? r.content.entries.length : 0;
    const localCount = state.entries.length;
    const localEditedAt = state.lastLocalChangeAt ? Date.parse(state.lastLocalChangeAt) : null;
    const cloudEditedAt = r.lastModifiedAt ? (new Date(r.lastModifiedAt)).getTime() : null;
    // lastLocalChangeAt lives at the top of `state` (load-bearing — see persist()).
    const localIsFresher = localEditedAt && cloudEditedAt && localEditedAt > cloudEditedAt;

    if (localIsFresher && localCount > 0) {
      // Cloud is stale — keep the user's local edits and push them up instead of clobbering.
      patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
      toast('Cloud is older than your local copy — pushing your changes.');
      scheduleSyncPush();
      notifySyncChange();
      return;
    }

    state = validateState(r.content);
    saveState(state);
    patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
    // Tell the user honestly what just happened.
    if (incomingCount !== localCount) {
      if (localCount > 0 && localEditedAt && cloudEditedAt && cloudEditedAt > localEditedAt) {
        toast(`Cloud replaced your local copy (${localCount} → ${incomingCount} entr${incomingCount === 1 ? 'y' : 'ies'}).`);
      } else if (localCount === 0) {
        toast(`Pulled ${incomingCount} entr${incomingCount === 1 ? 'y' : 'ies'} from cloud.`);
      } else {
        toast(`Synced from cloud (${incomingCount} entr${incomingCount === 1 ? 'y' : 'ies'}).`);
      }
    } else {
      toast('In sync with cloud.');
    }
    render();
  } else if (!r.ok) {
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
  }
  notifySyncChange();
}

function renderSyncIndicator() {
  const node = document.getElementById('sync-indicator');
  if (!node) return;
  const s = getSyncSettings();
  if (!s.enabled) { node.style.display = 'none'; return; }
  node.style.display = '';
  const status = syncStatus();
  node.innerHTML = '';
  node.append($('span', { 'aria-hidden': 'true', style: `width:7px;height:7px;border-radius:50%;background:${status.state === 'ok' ? 'var(--positive)' : status.state === 'error' ? 'var(--negative)' : 'var(--muted)'};display:inline-block;flex-shrink:0;` }));
  const label = status.state === 'ok' ? status.label.replace(/^Synced /, 'synced ') : status.label;
  node.append($('span', null, label));
}

subscribeSync(renderSyncIndicator);

// ---------- utilities ----------
function methodShort(id) {
  const m = METHODS.find(x => x.id === id);
  if (!m) return id;
  return m.label.includes(' · ') ? m.label.split(' · ')[1] : m.label;
}

const fmt = (n) => {
  if (!Number.isFinite(n)) return '€0.00';
  const sign = n < 0 ? '−' : '';
  return `${sign}€${Math.abs(n).toFixed(2)}`;
};
const monthKey = (date) => date.slice(0, 7);
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};
const friendlyDate = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  return new Date(iso + 'T00:00:00').toLocaleString('en-GB', { month: 'short', day: 'numeric' });
};

function entriesForMonth(key) {
  return state.entries.filter(e => monthKey(e.date) === key);
}
function totalForMonth(key) {
  return entriesForMonth(key).reduce((s, e) => s + (e.type === 'expense' ? e.amount : -e.amount), 0);
}
function lastNinetyDays() {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  return state.entries.filter(e => new Date(e.date + 'T00:00:00') >= cutoff);
}
function parseAmount(raw) {
  if (raw == null) return NaN;
  const v = parseFloat(String(raw).replace(',', '.'));
  if (!Number.isFinite(v)) return NaN;
  return Math.round(v * 100) / 100;
}

function thursdaysInMonth(year, month) {
  const dates = [];
  const d = new Date(year, month, 1);
  // Find first Thursday (getDay() 4 = Thursday)
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
  while (d.getMonth() === month) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 7);
  }
  return dates;
}

/** Returns the all-time running balance (income adds, expenses subtract) starting from openingBalance. */
function computeBalance(entries, openingBalance = 0) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
  let balance = openingBalance;
  const byId = {};
  for (const e of sorted) {
    balance += e.type === 'credit' ? e.amount : -e.amount;
    byId[e.id] = balance;
  }
  return { balance, byId };
}

/** Returns per-method running balances (income adds, expenses subtract). */
function computeMethodBalances(entries, methods, openings) {
  const result = {};
  for (const m of methods) {
    const methodEntries = entries.filter(e => e.method === m.id);
    const sorted = [...methodEntries].sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
    let balance = (openings && openings[m.id]) || 0;
    for (const e of sorted) {
      balance += e.type === 'credit' ? e.amount : -e.amount;
    }
    result[m.id] = { label: m.label, balance };
  }
  return result;
}

// ---------- cash / coins ----------
const COINS = [
  { val: 50,   label: '€50' },
  { val: 20,   label: '€20' },
  { val: 10,   label: '€10' },
  { val: 5,    label: '€5' },
  { val: 2,    label: '€2' },
  { val: 1,    label: '€1' },
  { val: 0.50, label: '50c' },
  { val: 0.20, label: '20c' },
  { val: 0.10, label: '10c' },
  { val: 0.05, label: '5c' },
];
const COINS_DEFAULT = Object.fromEntries(COINS.map(c => [String(c.val), 0]));

function computeCashTotal(coins) {
  let total = 0;
  for (const c of COINS) total += (coins[String(c.val)] || 0) * c.val;
  return Math.round(total * 100) / 100;
}

// ---------- recurring transactions ----------
function advanceRecurringDate(current, freq, dayOfMonth) {
  const d = new Date(current + 'T00:00:00');
  if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') {
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dayOfMonth, lastDay));
  }
  return d.toISOString().slice(0, 10);
}

function computeInitialNextDate(freq, dayOfMonth) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(today.getFullYear(), today.getMonth(), dayOfMonth || 1);
  if (freq === 'monthly') {
    if (d <= today) d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dayOfMonth, lastDay));
  }
  // For weekly: advance by 7 days until the date is in the future
  if (freq === 'weekly') {
    while (d <= today) d.setDate(d.getDate() + 7);
  }
  return d.toISOString().slice(0, 10);
}

function paidRecurring(rec) {
  const entry = {
    id: uid(), date: rec.nextDate, type: rec.type,
    category: rec.category || 'misc', details: rec.details,
    amount: rec.amount, method: rec.method, note: rec.note || '',
  };
  state.entries.push(entry);
  state.entries.sort((a, b) => a.date.localeCompare(b.date));
  // Advance nextDate
  rec.nextDate = advanceRecurringDate(rec.nextDate, rec.frequency, rec.dayOfMonth);
  persist();
  toast(`Paid: ${rec.details} — ${fmt(rec.amount)}`);
  render();
}

// ---------- router ----------
const ROUTES = ['dashboard', 'add', 'history', 'insights'];
function currentRoute() {
  const r = (location.hash || '#dashboard').slice(1).split('?')[0];
  return ROUTES.includes(r) ? r : 'dashboard';
}
window.addEventListener('hashchange', render);

// ---------- DOM helpers ----------
function $(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  // Default `= {}` only applies to `undefined`. The codebase explicitly passes
  // `null` for "no attributes needed" in many places (e.g. `$('div', null, …)`);
  // without this fallback, Object.entries(null) throws and aborts the entire render.
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'data' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else if (v === false || v == null) {}
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function renderHeader() {
  const route = currentRoute();
  return $('header', { class: 'app-header', 'aria-label': 'App header' },
    $('div', { class: 'logo' },
      $('div', { class: 'mark' }, '€'),
      $('a', { href: '#dashboard', style: 'font-family:"Instrument Serif",serif;font-style:italic;font-size:30px;letter-spacing:-0.03em;' }, 'cents.'),
    ),
    $('nav', { class: 'nav', 'aria-label': 'Primary' },
      ...ROUTES.map(r => $('a', { href: `#${r}`, class: 'nav-link', 'aria-current': r === route ? 'page' : 'false' }, titleFor(r))),
    ),
    $('div', { class: 'header-actions' },
      $('span', { id: 'sync-indicator', style: 'display:inline-flex;align-items:center;gap:7px;font-family:"Instrument Serif",serif;font-style:italic;font-size:14px;color:var(--muted);' }),
      $('button', { class: 'nav-action', onClick: openSyncSettings }, 'Sync'),
      $('button', { class: 'nav-action', onClick: () => { exportJSON(state); toast('Exported.'); } }, 'Export'),
    ),
  );
  queueMicrotask(renderSyncIndicator);
}

function titleFor(r) {
  return ({ dashboard: 'Dashboard', add: 'New entry', history: 'History', insights: 'Insights' })[r];
}

// ---------- shared form ----------
function formView({ initial = null, onSubmit }) {
  const isEdit = !!initial;
  const data = initial ?? {
    type: 'expense', date: today(), details: '', amount: '',
    method: 'AIB', category: 'gro', note: '',
  };
  if (typeof data.amount === 'number') data.amount = String(data.amount);

  // Type tabs — use role-based selectors, not firstChild/lastChild
  const tabs = $('div', { class: 'row', role: 'tablist', 'aria-label': 'Transaction type', style: 'gap:32px;padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:32px;' });
  const expenseTab = pillTab('Expense', 'expense', data.type === 'expense');
  const creditTab  = pillTab('Income', 'credit', data.type === 'credit');
  const transferTab = pillTab('Transfer', 'transfer', data.type === 'transfer');
  tabs.append(expenseTab, creditTab, transferTab);
  function pillTab(label, type, active) {
    const btn = $('button', { type: 'button', class: 'pill', role: 'tab', 'data-id': label.toLowerCase(), 'aria-selected': active ? 'true' : 'false', style: `padding:8px 18px;font-size:12px;cursor:pointer;background:${active ? 'var(--accent-soft)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--muted)'};border-color:${active ? 'transparent' : 'var(--line)'};`, onClick: () => {
      data.type = type;
      tabs.querySelectorAll('[role=tab]').forEach(t => {
        const isActive = t.dataset.id === label.toLowerCase();
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        t.style.background = isActive ? 'var(--accent-soft)' : 'transparent';
        t.style.color = isActive ? 'var(--accent)' : 'var(--muted)';
        t.style.borderColor = isActive ? 'transparent' : 'var(--line)';
      });
      rebuildMethodOpts();
      catSection.style.display = (isCredit() || isTransfer()) ? 'none' : '';
      methodSection.style.display = isTransfer() ? 'none' : '';
      transferSection.style.display = isTransfer() ? '' : 'none';
    } }, label);
    return btn;
  }

  const amountInput = $('input', { type: 'text', inputmode: 'decimal', value: data.amount, 'aria-label': 'Amount in euros', placeholder: '0.00', autocomplete: 'off', required: true, onInput: (e) => { data.amount = e.target.value; } });

  const detailsInput = $('input', { type: 'text', value: data.details || '', 'aria-label': 'Transaction details', placeholder: 'e.g. Tesco, Leap Card', required: true, onInput: (e) => data.details = e.target.value });

  const dateInput = $('input', { type: 'date', value: data.date, 'aria-label': 'Date', required: true, onInput: (e) => data.date = e.target.value });

  const creditMethods = METHODS.filter(m => m.id === 'AIB' || m.id === 'Revolut' || m.id === 'RS');
  const isCredit = () => data.type === 'credit';
  const isTransfer = () => data.type === 'transfer';
  // Ensure transfer defaults exist
  if (isTransfer()) { data.transferFrom = data.transferFrom || 'AIB'; data.transferTo = data.transferTo || 'Revolut'; }

  const methodLabel = $('label', { class: 'eyebrow', for: 'f-method' }, 'Method');
  const methodOpts = () => (isCredit() ? creditMethods : METHODS);
  const methodSel = $('select', { 'aria-label': 'Payment method', id: 'f-method', onChange: (e) => data.method = e.target.value });
  const methodSection = $('div');
  function rebuildMethodOpts() {
    methodLabel.textContent = isCredit() ? 'Income sent to' : 'Method';
    methodSel.innerHTML = '';
    for (const m of methodOpts()) {
      methodSel.appendChild($('option', { value: m.id, selected: data.method === m.id ? '' : null }, m.label));
    }
    const valid = methodOpts().find(m => m.id === data.method);
    if (!valid) { data.method = methodOpts()[0].id; methodSel.value = data.method; }
  }
  rebuildMethodOpts();
  methodSection.append(methodLabel, methodSel);

  // Transfer From / To dropdowns
  const transferFromSel = $('select', { 'aria-label': 'From account', onChange: (e) => data.transferFrom = e.target.value });
  const transferToSel = $('select', { 'aria-label': 'To account', onChange: (e) => data.transferTo = e.target.value });
  function rebuildTransferOpts() {
    transferFromSel.innerHTML = '';
    transferToSel.innerHTML = '';
    for (const m of METHODS) {
      transferFromSel.appendChild($('option', { value: m.id, selected: data.transferFrom === m.id ? '' : null }, m.label));
      transferToSel.appendChild($('option', { value: m.id, selected: data.transferTo === m.id ? '' : null }, m.label));
    }
  }
  rebuildTransferOpts();
  const transferSection = $('div', { style: 'display:none;' },
    $('div', null, $('label', { class: 'eyebrow', for: 'f-transfer-from' }, 'From'), Object.assign(transferFromSel, { id: 'f-transfer-from' })),
    $('div', null, $('label', { class: 'eyebrow', for: 'f-transfer-to' }, 'To'), Object.assign(transferToSel, { id: 'f-transfer-to' })),
  );

  const catChips = $('div', { role: 'radiogroup', 'aria-label': 'Category', style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' },
    ...CATEGORIES.map(c => {
      const btn = $('button', { type: 'button', class: 'pill pill-cat', role: 'radio', 'data-id': c.id, 'aria-checked': data.category === c.id ? 'true' : 'false', 'data-active': data.category === c.id ? 'true' : 'false', onClick: () => {
        data.category = c.id;
        catChips.querySelectorAll('[role=radio]').forEach(b => { b.setAttribute('aria-checked','false'); b.dataset.active = 'false'; });
        btn.setAttribute('aria-checked','true'); btn.dataset.active = 'true';
      } }, c.label);
      return btn;
    }),
  );
  const catSection = $('div', { style: 'margin-bottom:24px;' },
    $('label', { class: 'eyebrow' }, 'Category'), catChips,
  );
  catSection.style.display = isCredit() ? 'none' : '';

  const noteInput = $('input', { type: 'text', value: data.note || '', 'aria-label': 'Optional note', placeholder: 'optional', onInput: (e) => data.note = e.target.value });

  const submit = () => {
    const amt = parseAmount(data.amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); amountInput.focus(); return; }
    if (amt > 100000) { toast('Amount looks too large — double check.'); amountInput.focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) { toast('Pick a valid date.'); dateInput.focus(); return; }
    if (!data.details.trim()) { toast('Add a description.'); detailsInput.focus(); return; }
    if (isTransfer()) {
      if (data.transferFrom === data.transferTo) { toast('From and To cannot be the same account.'); return; }
      const pairId = uid();
      const base = { date: data.date, amount: amt, details: data.details.trim(), note: data.note?.trim() || '', category: 'misc', transferId: pairId, settled: false };
      const fromEntry = { ...base, id: uid(), type: 'expense', method: data.transferFrom };
      const toEntry   = { ...base, id: uid(), type: 'credit',  method: data.transferTo };
      onSubmit([fromEntry, toEntry]);
      return;
    }
    const entry = {
      id: initial?.id || uid(),
      date: data.date,
      type: data.type,
      category: data.type === 'credit' ? 'misc' : data.category,
      details: data.details.trim(),
      amount: amt,
      method: data.method,
      note: data.note?.trim() || '',
    };
    onSubmit([entry]);
  };

  const formEl = $('div', { class: 'card', style: 'padding:32px;max-width:540px;margin:0 auto;' },
    tabs,
    $('div', { style: 'margin-bottom:24px;' },
      $('label', { class: 'eyebrow', for: 'f-amount' }, 'Amount'),
      $('div', { style: 'display:flex;align-items:baseline;gap:6px;margin-top:4px;' },
        $('span', { class: 'serif', style: 'font-size:60px;color:var(--accent);', 'aria-hidden': 'true' }, '€'),
        Object.assign(amountInput, { id: 'f-amount' }),
      ),
    ),
    $('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;' },
      $('div', null, $('label', { class: 'eyebrow', for: 'f-date' }, 'Date'), Object.assign(dateInput, { id: 'f-date' })),
      $('div', null, methodSection),
    ),
    transferSection,
    catSection,
    $('div', { style: 'margin-bottom:24px;' },
      $('label', { class: 'eyebrow', for: 'f-details' }, 'Description'), Object.assign(detailsInput, { id: 'f-details' }),
    ),
    $('div', { style: 'margin-bottom:32px;' },
      $('label', { class: 'eyebrow', for: 'f-note' }, 'Note'), Object.assign(noteInput, { id: 'f-note' }),
    ),
    $('div', { style: 'display:flex;gap:12px;justify-content:flex-end;padding-top:24px;border-top:1px solid var(--line);' },
      $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => location.hash = '#dashboard' }, 'Cancel'),
      $('button', { type: 'button', class: 'btn btn-primary', onClick: submit }, isEdit ? 'Save changes' : 'Save entry'),
    ),
  );

  // First focusable input id for focus management
  formEl.dataset.firstFocus = 'f-amount';
  return formEl;
}

// ---------- dashboard ----------
/** Pull from cloud and re-render — used by both the dashboard resync button and manual sync. */
async function doResync() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) { toast('Sync is not configured.'); return; }
  const prevCount = state.entries.length;
  const r = await syncPull();
  if (r.ok && r.content) {
    state = validateState(r.content);
    saveState(state);
    patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
    const diff = state.entries.length - prevCount;
    toast(diff > 0 ? `Pulled ${diff} new entr${diff === 1 ? 'y' : 'ies'}.` : diff < 0 ? `Cloud has ${state.entries.length} entries.` : 'Already up to date.');
    notifySyncChange();
    render();
  } else if (r.ok && !r.content) {
    toast('Cloud file is empty — nothing to pull.');
  } else {
    toast('Pull failed: ' + (r.message || r.reason));
  }
}

function screenDashboard() {
  const now = new Date();
  const key = monthKey(now.toISOString().slice(0, 10));
  const monthEntries = entriesForMonth(key);
  const net = totalForMonth(key);
  const budget = +state.settings.monthlyBudget || 0;
  const openingBalance = +state.settings.openingBalance || 0;
  const { balance: runningBalance } = computeBalance(state.entries, openingBalance);

  const expensesOnly = monthEntries.filter(e => e.type === 'expense');
  const incomeOnly = monthEntries.filter(e => e.type === 'credit');
  const catTotals = {};
  for (const e of expensesOnly) {
    catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
  }
  const cats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const expenseSum = expensesOnly.reduce((s, e) => s + e.amount, 0);
  const incomeSum = incomeOnly.reduce((s, e) => s + e.amount, 0);
  const pct = budget ? Math.min(100, (expenseSum / budget) * 100) : 0;

  // Recent 5 — stable order: date desc, then id desc as tiebreaker
  const recent = [...state.entries]
    .sort((a, b) => b.date.localeCompare(a.date) || (a.id < b.id ? 1 : -1))
    .slice(0, 5);

  const screen = $('section', { 'aria-label': 'Dashboard' });

  // Resync button — only shown when sync is configured
  const syncS = getSyncSettings();
  const resyncBtn = (syncS.enabled && syncS.endpoint && syncS.password)
    ? $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:13px;gap:6px;', onClick: () => doResync() },
        $('span', { style: 'font-size:15px;', 'aria-hidden': 'true' }, '↻'),
        'Resync',
      )
    : null;

  // Hero
  screen.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:36px;flex-wrap:wrap;gap:16px;' },
    $('div', null,
      $('div', { class: 'eyebrow' }, monthLabel(key)),
      $('p', { style: 'font-size:54px;line-height:1;margin:8px 0 0;' },
        $('span', { class: 'serif' }, fmt(net)),
        $('span', { style: 'font-family:DM Sans,system-ui,sans-serif;font-style:normal;font-size:18px;color:var(--muted);margin-left:8px;' }, budget ? `/ ${fmt(budget)}` : ''),
      ),
      $('p', { style: 'font-size:15px;color:var(--muted);margin:6px 0 0;display:flex;align-items:center;gap:18px;' },
        $('span', null, 'Balance ', $('span', { class: 'display-num', style: `font-size:16px;color:${runningBalance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(runningBalance))),
        cashWidget(),
      ),
    ),
    $('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' },
      $('label', { class: 'eyebrow', for: 'balance-input' }, 'Opening'),
      $('input', { id: 'balance-input', type: 'text', inputmode: 'decimal', value: String(openingBalance || ''), placeholder: '—', 'aria-label': 'Opening bank balance in euros', autocomplete: 'off', style: 'width:92px;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;', onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
        e.target.style.borderColor = 'var(--line)';
        const v = parseAmount(e.target.value);
        if (!Number.isFinite(v)) { e.target.value = String(openingBalance || ''); toast('Enter a valid number.'); return; }
        if (v !== openingBalance) {
          state.settings.openingBalance = v; persist(); render();
          toast('Opening balance updated.');
        }
      }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      $('label', { class: 'eyebrow', for: 'budget-input' }, 'Budget'),
      $('input', { id: 'budget-input', type: 'text', inputmode: 'decimal', value: String(budget || ''), placeholder: '—', 'aria-label': 'Monthly budget in euros', autocomplete: 'off', style: 'width:92px;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;', onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
        e.target.style.borderColor = 'var(--line)';
        const v = parseAmount(e.target.value);
        if (!Number.isFinite(v) || v < 0) { e.target.value = String(budget || ''); toast('Enter a non-negative number.'); return; }
        if (v !== budget) {
          state.settings.monthlyBudget = v; persist(); render();
          toast(v > 0 ? 'Budget updated.' : 'Budget cleared.');
        }
      }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      $('a', { href: '#add', class: 'btn btn-primary' }, '+ New entry'),
      resyncBtn,
    ),
  ));

  // Budget bar card
  if (budget > 0) {
    screen.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:32px;' },
      $('div', { class: 'row between' },
        $('span', { class: 'eyebrow' }, 'Spent of budget'),
        $('span', { class: 'serif', style: 'font-size:22px;' }, `${pct.toFixed(1)}%`),
      ),
      $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;margin:14px 0 20px;' },
        $('div', { style: `height:100%;width:${pct}%;background:${pct > 90 ? 'var(--negative)' : 'var(--accent)'};transition:width .4s ease;` }),
      ),
      $('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:24px;padding-top:20px;border-top:1px solid var(--line);' },
        stat('Net', fmt(net)),
        stat('Spent', fmt(expenseSum)),
        stat('Income', fmt(incomeSum)),
        stat('Balance', fmt(runningBalance)),
        stat('Avg / day', fmt(expenseSum / Math.max(now.getDate(), 1))),
        stat('Month elapsed', Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100) + '%'),
      ),
    ));
  }

  // Recurring transactions — always show card so "+ New" is accessible
  const allRecurring = state.settings.recurring || [];
  const recurring = allRecurring.filter(r => r.nextDate <= key + '-31');
  const recCard = $('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, `Recurring · ${allRecurring.length}`),
      $('button', { type: 'button', style: 'font-size:11px;color:var(--accent);cursor:pointer;background:none;border:none;padding:0;', onClick: () => openNewRecurring() }, '+ New'),
    ),
    recurring.length === 0
      ? $('div', { class: 'muted', style: 'font-size:13px;font-style:italic;' }, allRecurring.length ? 'No items due this month.' : 'No recurring items yet. Add your rent, subscriptions, or paydays.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
        ...recurring.map(r => {
          const isOverdue = r.nextDate <= today();
          return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
            $('div', { style: 'display:flex;align-items:center;gap:10px;flex:1;min-width:0;' },
              $('button', { type: 'button', style: 'width:20px;height:20px;border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0;flex-shrink:0;', onClick: () => {
                state.settings.recurring = state.settings.recurring.filter(x => x.id !== r.id);
                persist(); toast(`Removed recurring "${r.details}".`); render();
              }, title: 'Remove recurring' }, '×'),
              $('span', { style: `display:inline-block;width:7px;height:7px;border-radius:50%;background:${isOverdue ? 'var(--negative)' : 'var(--muted)'};flex-shrink:0;` }),
              $('span', { style: 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, r.details),
              $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;flex-shrink:0;' }, r.method),
              $('span', { class: 'muted', style: 'font-size:11px;flex-shrink:0;' }, friendlyDate(r.nextDate)),
            ),
            $('div', { style: 'display:flex;align-items:center;gap:10px;flex-shrink:0;' },
              $('span', { class: 'display-num', style: `font-size:13px;color:${r.type === 'credit' ? 'var(--positive)' : 'var(--ink)'};` }, (r.type === 'credit' ? '+' : '') + fmt(r.amount)),
              $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:4px 12px;font-size:11px;', onClick: () => paidRecurring(r) }, 'Paid'),
            ),
          );
        }),
      ),
  );
  screen.appendChild(recCard);

  // Category breakdown + recent
  const grid = $('div', { class: 'dashboard-grid', style: 'display:grid;grid-template-columns:1fr;gap:24px;align-items:start;' });
  // Responsive: 2-col on >=760px (set inline because we want it to ship without extra CSS)
  if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1000px)').matches) {
    grid.style.gridTemplateColumns = 'minmax(0, 2fr) minmax(0, 3fr)';
  }

  const catCard = $('div', { class: 'card', style: 'padding:24px;' },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'By category'),
      $('span', { class: 'muted', style: 'font-size:11px;' }, 'this month'),
    ),
    cats.length === 0
      ? $('div', { class: 'empty' }, 'Nothing logged yet.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:14px;' },
          ...cats.map(([cat, val]) => $('div', null,
            $('div', { class: 'row between', style: 'font-size:13px;margin-bottom:6px;' },
              $('span', { style: 'font-weight:500;' }, CATEGORIES.find(c => c.id === cat)?.label || cat),
              $('span', { class: 'tnum' }, fmt(val)),
            ),
            $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;' },
              $('div', { style: `height:100%;width:${(val / cats[0][1]) * 100}%;background:var(--ink);` }),
            ),
          )),
        ),
  );

  const recentCard = $('div', { class: 'card', style: 'padding:24px;overflow-x:auto;' },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Recent'),
      $('a', { href: '#history', class: 'btn-link' }, 'See all →'),
    ),
    recent.length === 0
      ? $('div', { class: 'empty' }, 'No entries yet.')
      : $('div', { style: 'display:grid;grid-template-columns:90px 1fr 110px 90px;gap:12px 24px;font-size:14px;min-width:520px;' },
          ...recent.flatMap(e => [
            $('span', { class: 'muted', style: 'font-size:12px;' }, friendlyDate(e.date)),
            $('div', null,
              $('div', { style: 'font-weight:500;' }, e.details || '—'),
              $('div', { style: 'font-size:11px;color:var(--muted);' }, `${CATEGORIES.find(c => c.id === e.category)?.label || e.category} · ${METHODS.find(m => m.id === e.method)?.label || e.method}`),
            ),
            $('span', { class: 'display-num', style: 'text-align:right;font-size:15px;color:' + (e.type === 'credit' ? 'var(--positive)' : 'var(--ink)') }, (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
            $('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, e.method)),
          ]),
        ),
  );

  grid.append(catCard, recentCard);
  screen.appendChild(grid);

  // Per-account running balances — Revolut + gift cards only (AIB covered by main Balance)
  const trackedMethods = METHODS.filter(m => m.id !== 'AIB');
  const accountOpenings = state.settings.accountOpenings || {};
  const methodBalances = computeMethodBalances(state.entries, trackedMethods, accountOpenings);
  // Compute unsettled pending per method
  const pendingPerMethod = {};
  for (const e of state.entries) {
    if (!e.transferId || e.settled) continue;
    pendingPerMethod[e.method] = (pendingPerMethod[e.method] || 0) + (e.type === 'credit' ? e.amount : -e.amount);
  }
  const activeMethods = Object.entries(methodBalances).filter(([, v]) => v.balance !== 0);
  if (activeMethods.length > 0) {
    const accountsCard = $('div', { class: 'card', style: 'padding:24px;margin-top:24px;' },
      $('div', { class: 'eyebrow', style: 'margin-bottom:16px;' }, 'Per-account balances'),
      $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
        ...activeMethods.map(([id, v]) => {
          const pending = pendingPerMethod[id] || 0;
          return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
            $('div', { style: 'display:flex;align-items:center;gap:10px;' },
              $('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${v.balance >= 0 ? 'var(--positive)' : 'var(--negative)'};flex-shrink:0;` }),
              $('span', { style: 'font-weight:500;' }, methodShort(id)),
              pending !== 0 ? $('span', { style: `font-size:10px;color:var(--muted);` }, `(${pending > 0 ? '+' : ''}${fmt(pending)} pending)`) : null,
            ),
            $('span', { class: 'display-num', style: `font-size:14px;color:${v.balance >= 0 ? 'var(--positive)' : 'var(--negative)'};cursor:pointer;border-bottom:1px dashed transparent;transition:border-color .15s;`, onClick: () => openAccountBalanceEditor(id, v.label, v.balance, accountOpenings[id] || 0) },
              $('span', { style: 'font-size:10px;margin-left:3px;opacity:0.5;', 'aria-hidden': 'true' }, '✎'),
              fmt(v.balance),
            ),
          );
        }),
      ),
    );
    screen.appendChild(accountsCard);
  }

  // Tesco pay — Thursdays tracker
  const thursdays = thursdaysInMonth(now.getFullYear(), now.getMonth());
  const incomeByDate = {};
  for (const e of incomeOnly) { incomeByDate[e.date] = (incomeByDate[e.date] || 0) + e.amount; }
  const todayStr = now.toISOString().slice(0, 10);

  const payCard = $('div', { class: 'card', style: 'padding:24px;margin-top:24px;' },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Tesco pay · Thursdays'),
      $('span', { class: 'muted', style: 'font-size:11px;' }, `${thursdays.filter(d => !!incomeByDate[d]).length}/${thursdays.length} paid`),
    ),
    thursdays.length === 0
      ? $('div', { class: 'empty' }, 'No Thursdays this month.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:4px;' },
          ...thursdays.map(d => {
            const paid = incomeByDate[d] != null;
            const isPast = d < todayStr;
            const isToday = d === todayStr;
            const isFuture = d > todayStr;
            const dt = new Date(d + 'T00:00:00');
            const dayName = dt.toLocaleString('en-GB', { weekday: 'short' });
            const dayNum = dt.getDate();
            const statusColor = paid ? 'var(--positive)' : isFuture ? 'var(--muted)' : 'var(--negative)';
            return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
              $('div', { style: 'display:flex;align-items:center;gap:12px;' },
                $('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;` }),
                $('span', { style: 'font-weight:500;' }, `${dayName} ${dayNum}`),
                isToday ? $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;padding:2px 8px;' }, 'today') : null,
              ),
              $('span', { class: 'display-num', style: `font-size:14px;color:${paid ? 'var(--positive)' : 'var(--muted)'};` },
                paid ? `+${fmt(incomeByDate[d])}` : (isPast ? '—' : '—'),
              ),
            );
          }),
        ),
  );
  screen.appendChild(payCard);

  return screen;
}

function stat(label, value) {
  return $('div', null,
    $('div', { class: 'eyebrow' }, label),
    $('div', { class: 'display-num', style: 'font-size:22px;margin-top:4px;' }, value),
  );
}

// ---------- cash widget ----------
function cashWidget() {
  const coins = { ...COINS_DEFAULT, ...(state.settings.coins || {}) };
  const total = computeCashTotal(coins);
  const tipLines = COINS.filter(c => coins[String(c.val)] > 0).map(c =>
    `${coins[String(c.val)]} × ${c.label} = ${fmt(coins[String(c.val)] * c.val)}`
  );
  const hasAny = tipLines.length > 0;

  let tipTimeout;
  const wrapper = $('span', { style: 'position:relative;display:inline-flex;align-items:center;cursor:pointer;' },
    $('span', { style: 'font-family:"Instrument Serif",serif;font-style:italic;' }, 'Cash '),
    $('span', { class: 'display-num', style: `font-size:16px;color:${total > 0 ? 'var(--accent)' : 'var(--muted)'};` }, fmt(total)),
  );

  const tip = $('div', { style: `position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:10px;padding:12px 16px;background:var(--ink);color:#fff;border-radius:10px;font-size:12px;line-height:1.7;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,0.18);display:${hasAny ? '' : 'none'};` },
    ...(hasAny ? tipLines.map(l => $('div', null, l)) : []),
    hasAny ? $('div', { style: 'margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.2);font-weight:600;' }, `Total: ${fmt(total)}`) : null,
  );
  wrapper.appendChild(tip);

  wrapper.addEventListener('mouseenter', () => { clearTimeout(tipTimeout); tip.style.opacity = '1'; });
  wrapper.addEventListener('mouseleave', () => { tipTimeout = setTimeout(() => tip.style.opacity = '0', 150); });
  wrapper.addEventListener('click', () => openCashEditor());

  return wrapper;
}

// ---------- modal: new recurring ----------
function openNewRecurring() {
  const data = { type: 'expense', details: '', amount: '', method: 'AIB', category: 'gro', frequency: 'monthly', dayOfMonth: 1, note: '' };

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New recurring transaction', tabindex: '-1', style: 'max-width:480px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const typeTabs = $('div', { style: 'display:flex;gap:0;margin-bottom:20px;border:1px solid var(--line);border-radius:8px;overflow:hidden;' });
  let activeTypeBtn;
  function typeBtn(label, type) {
    const active = data.type === type;
    const btn = $('button', { type: 'button', style: `flex:1;padding:8px 0;font-size:12px;cursor:pointer;border:none;background:${active ? 'var(--ink)' : 'transparent'};color:${active ? '#fff' : 'var(--muted)'};transition:background .15s;`, onClick: function() {
      data.type = type;
      if (activeTypeBtn) { activeTypeBtn.style.background = 'transparent'; activeTypeBtn.style.color = 'var(--muted)'; }
      this.style.background = 'var(--ink)'; this.style.color = '#fff';
      activeTypeBtn = this;
      catRow.style.display = data.type === 'credit' ? 'none' : '';
    } }, label);
    if (active) activeTypeBtn = btn;
    return btn;
  }
  typeTabs.append(typeBtn('Expense', 'expense'), typeBtn('Income', 'credit'));

  const amtInput = $('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount', onInput: (e) => data.amount = e.target.value });
  const descInput = $('input', { type: 'text', placeholder: 'e.g. Rent, Netflix', 'aria-label': 'Description', onInput: (e) => data.details = e.target.value });
  const methodSel = $('select', { 'aria-label': 'Method', onChange: (e) => data.method = e.target.value },
    ...METHODS.map(m => $('option', { value: m.id }, m.label)),
  );
  const catSel = $('select', { 'aria-label': 'Category', onChange: (e) => data.category = e.target.value },
    ...CATEGORIES.map(c => $('option', { value: c.id }, c.label)),
  );
  const catRow = $('div', { style: 'margin-bottom:14px;' },
    $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, 'Category'),
    catSel,
  );
  const freqSel = $('select', { 'aria-label': 'Frequency', onChange: (e) => { data.frequency = e.target.value; dayLabel.textContent = e.target.value === 'monthly' ? 'Day of month' : 'Start day'; } },
    $('option', { value: 'monthly', selected: '' }, 'Monthly'),
    $('option', { value: 'weekly' }, 'Weekly'),
  );
  const dayLabel = $('span', null, 'Day of month');
  const daySel = $('select', { 'aria-label': 'Day', onChange: (e) => data.dayOfMonth = +e.target.value },
    ...Array.from({ length: 31 }, (_, i) => $('option', { value: i + 1 }, String(i + 1))),
  );
  const noteInput = $('input', { type: 'text', placeholder: 'optional', 'aria-label': 'Note', onInput: (e) => data.note = e.target.value });

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:26px;' }, 'New recurring'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild(typeTabs);

  const fields = [
    ['Amount', amtInput],
    ['Description', descInput],
    ['Method', methodSel],
    ['Frequency', freqSel],
    [dayLabel, daySel],
    ['Note', noteInput],
  ];
  for (const [label, el] of fields) {
    modal.appendChild($('div', { style: 'margin-bottom:14px;' },
      $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, label),
      el,
    ));
  }
  modal.appendChild(catRow);

  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid var(--line);' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const amt = parseAmount(data.amount);
      if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); return; }
      if (!data.details.trim()) { toast('Add a description.'); return; }
      const rec = {
        id: 'rec_' + uid(),
        type: data.type,
        details: data.details.trim(),
        amount: amt,
        method: data.method,
        category: data.category,
        frequency: data.frequency,
        dayOfMonth: data.dayOfMonth,
        nextDate: computeInitialNextDate(data.frequency, data.dayOfMonth),
        note: data.note?.trim() || '',
      };
      if (!state.settings.recurring) state.settings.recurring = [];
      state.settings.recurring.push(rec);
      persist();
      toast(`Recurring "${rec.details}" added — next: ${friendlyDate(rec.nextDate)}`);
      close();
      render();
    } }, 'Save'),
  ));

  queueMicrotask(() => amtInput.focus());
}

// ---------- modal: account balance editor ----------
function openAccountBalanceEditor(methodId, label, currentBalance, opening) {
  const name = label.includes(' · ') ? label.split(' · ')[1] : label;
  let val = opening;

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit ${name} balance`, tabindex: '-1', style: 'max-width:400px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const input = $('input', { type: 'text', inputmode: 'decimal', value: String(val || ''), placeholder: '0.00', 'aria-label': 'Opening balance', autocomplete: 'off', style: 'width:100%;' });

  const computed = currentBalance - opening;
  const displayTotal = $('span', { class: 'display-num', style: 'font-size:18px;' }, fmt(val + computed));

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:26px;' }, name),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));

  modal.appendChild($('div', { style: 'margin-bottom:16px;' },
    $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, 'Opening balance'),
    input,
    $('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;' }, 'Set what this account held before you started tracking.'),
  ));

  const openingPreview = $('span', { class: 'tnum' }, fmt(val));
  modal.appendChild($('div', { style: 'display:flex;flex-direction:column;gap:6px;padding:12px;background:var(--accent-soft);border-radius:8px;margin-bottom:16px;' },
    $('div', { style: 'display:flex;justify-content:space-between;font-size:12px;' },
      $('span', { class: 'muted' }, 'Transaction total'),
      $('span', { class: 'tnum' }, fmt(computed)),
    ),
    $('div', { style: 'display:flex;justify-content:space-between;font-size:12px;' },
      $('span', { class: 'muted' }, 'Opening balance'),
      openingPreview,
    ),
    $('div', { style: 'display:flex;justify-content:space-between;font-size:14px;font-weight:600;padding-top:6px;border-top:1px solid var(--line);' },
      $('span', null, 'Current balance'),
      displayTotal,
    ),
  ));

  input.addEventListener('input', () => {
    val = parseAmount(input.value) || 0;
    openingPreview.textContent = fmt(val);
    displayTotal.textContent = fmt(val + computed);
  });

  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      if (!state.settings.accountOpenings) state.settings.accountOpenings = {};
      state.settings.accountOpenings[methodId] = val;
      persist();
      toast(`${name} opening balance updated.`);
      close();
    } }, 'Save'),
  ));

  queueMicrotask(() => input.focus());
}

// ---------- modal: cash editor ----------
function openCashEditor() {
  const coins = { ...COINS_DEFAULT, ...(state.settings.coins || {}) };

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Cash breakdown', tabindex: '-1', style: 'max-width:420px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const totalEl = $('span', { class: 'display-num', style: 'font-size:22px;' }, fmt(computeCashTotal(coins)));
  const rows = COINS.map(c => {
    const key = String(c.val);
    const countEl = $('span', { style: 'min-width:24px;text-align:center;font-weight:500;' }, String(coins[key]));
    const decr = $('button', { type: 'button', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center;', onClick: () => {
      if (coins[key] > 0) { coins[key]--; countEl.textContent = String(coins[key]); totalEl.textContent = fmt(computeCashTotal(coins)); }
    } }, '−');
    const incr = $('button', { type: 'button', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center;', onClick: () => {
      coins[key]++; countEl.textContent = String(coins[key]); totalEl.textContent = fmt(computeCashTotal(coins));
    } }, '+');
    return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);' },
      $('span', { style: 'font-size:14px;font-weight:500;width:50px;' }, c.label),
      $('div', { style: 'display:flex;align-items:center;gap:10px;' }, decr, countEl, incr),
      $('span', { class: 'muted', style: 'font-size:12px;width:55px;text-align:right;' }, fmt(coins[key] * c.val)),
    );
  });

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:26px;' }, 'Cash breakdown'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild($('div', { style: 'display:flex;flex-direction:column;margin-bottom:12px;' }, ...rows));
  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid var(--line);' },
    $('span', { class: 'eyebrow' }, 'Total'),
    totalEl,
  ));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      state.settings.coins = { ...coins };
      persist();
      toast('Cash counts saved.');
      close();
    } }, 'Save'),
  ));

  queueMicrotask(() => modal.querySelector('button')?.focus());
}

// ---------- screens: add ----------
function screenAdd() {
  const c = $('section', { 'aria-label': 'New entry' });
  c.appendChild($('div', { style: 'margin-bottom:24px;' },
    $('h1', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:34px;' }, 'New entry'),
  ));
  c.appendChild(formView({
    onSubmit: (entryOrEntries) => {
      const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
      for (const e of entries) state.entries.push(e);
      state.entries.sort((a, b) => a.date.localeCompare(b.date));
      persist();
      toast(entries.length > 1 ? `Saved ${entries.length} entries.` : 'Saved.');
      location.hash = '#dashboard';
    },
  }));
  // Autofocus the amount field on screen mount
  queueMicrotask(() => document.getElementById('f-amount')?.focus());
  return c;
}

// ---------- screens: history ----------
function screenHistory() {
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  let activeMonth = params.get('month') || monthKey(today());
  let activeCat = params.get('cat') || 'all';

  const months = Array.from(new Set(state.entries.map(e => monthKey(e.date)))).sort().reverse();
  if (!months.includes(activeMonth) && months.length) activeMonth = months[0];

  const monthEntries = entriesForMonth(activeMonth);
  const visible = activeCat === 'all' ? monthEntries : monthEntries.filter(e => e.category === activeCat);
  const expenseSum = monthEntries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const openingBalance = +state.settings.openingBalance || 0;
  const { byId: balanceById } = computeBalance(state.entries, openingBalance);

  const update = (next = {}) => {
    if (next.month) params.set('month', next.month);
    if (next.cat !== undefined) {
      if (next.cat === 'all') params.delete('cat');
      else params.set('cat', next.cat);
    }
    const qs = params.toString();
    location.hash = qs ? `history?${qs}` : 'history';
  };

  const c = $('section', { 'aria-label': 'History' });

  c.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:24px;flex-wrap:wrap;gap:12px;' },
    $('h1', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:34px;' }, monthLabel(activeMonth)),
    $('div', { class: 'row', style: 'gap:8px;' },
      monthNav('←', () => { const i = months.indexOf(activeMonth); if (i < months.length - 1) update({ month: months[i + 1] }); }, months.indexOf(activeMonth) >= months.length - 1),
      monthNav(monthKey(today()) === activeMonth ? 'Today' : 'Jump', () => update({ month: monthKey(today()) }), false),
      monthNav('→', () => { const i = months.indexOf(activeMonth); if (i > 0) update({ month: months[i - 1] }); }, months.indexOf(activeMonth) <= 0),
    ),
  ));

  const catCounts = {};
  for (const e of monthEntries) catCounts[e.category] = (catCounts[e.category] || 0) + 1;
  catCounts.all = monthEntries.length;

  const filterRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  filterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': 'all', 'data-active': activeCat === 'all' ? 'true' : 'false', 'aria-pressed': activeCat === 'all' ? 'true' : 'false', onClick: () => update({ cat: 'all' }) }, `All · ${catCounts.all || 0}`));
  for (const c2 of CATEGORIES) {
    const count = catCounts[c2.id] || 0;
    if (count === 0 && activeCat !== c2.id) continue;
    filterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': c2.id, 'data-active': activeCat === c2.id ? 'true' : 'false', 'aria-pressed': activeCat === c2.id ? 'true' : 'false', onClick: () => update({ cat: c2.id }) }, `${c2.label} · ${count}`));
  }
  c.appendChild(filterRow);

  const tableWrap = $('div', { class: 'card', style: 'overflow-x:auto;' });
  if (visible.length === 0) {
    tableWrap.appendChild($('div', { class: 'empty' }, 'Nothing here for this filter.'));
  } else {
    tableWrap.appendChild($('div', { role: 'row', style: 'display:grid;grid-template-columns:90px 1fr 110px 100px 90px 30px;gap:24px;padding:14px 24px;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);min-width:740px;' },
      $('span', { role: 'columnheader' }, 'Date'),
      $('span', { role: 'columnheader' }, 'Description'),
      $('span', { role: 'columnheader', style: 'text-align:right;' }, 'Amount'),
      $('span', { role: 'columnheader', style: 'text-align:right;' }, 'Balance'),
      $('span', { role: 'columnheader' }, 'Method'),
      $('span'),
    ));

    for (const e of visible.sort((a, b) => b.date.localeCompare(a.date))) {
      const isTransfer = !!e.transferId;
      const settledLabel = isTransfer ? (e.settled ? '✓ settled' : '● unsettled') : '';
      const settleColor = e.settled ? 'var(--positive)' : 'var(--muted)';
      const row = $('div', { role: 'row', tabindex: '0', 'data-id': e.id, 'aria-label': `Edit entry ${e.details} on ${friendlyDate(e.date)}`, style: 'display:grid;grid-template-columns:90px 1fr 110px 100px 90px 30px;gap:24px;padding:14px 24px;align-items:center;border-bottom:1px solid var(--line);cursor:pointer;min-width:740px;transition:background .15s;outline:none;', onClick: () => openEdit(e.id), onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdit(e.id); } } },
        $('span', { class: 'muted', style: 'font-size:13px;' }, friendlyDate(e.date)),
        $('div', null,
          $('div', { style: 'font-size:14px;display:flex;align-items:center;gap:6px;' }, e.details || '—',
            isTransfer ? $('span', { style: `font-size:10px;color:${settleColor};cursor:pointer;user-select:none;`, onClick: (ev) => {
              ev.stopPropagation();
              // Toggle settled on both linked entries
              const newVal = !e.settled;
              for (const x of state.entries) {
                if (x.transferId === e.transferId) x.settled = newVal;
              }
              persist(); toast(newVal ? 'Transfer settled.' : 'Transfer unsettled.'); render();
            }, title: 'Click to toggle settled' }, settledLabel) : null,
          ),
          $('div', { style: 'font-size:11px;color:var(--muted);' }, CATEGORIES.find(c2 => c2.id === e.category)?.label || e.category),
        ),
        $('span', { class: 'display-num', style: 'text-align:right;font-size:15px;color:' + (e.type === 'credit' ? 'var(--positive)' : 'var(--ink)') }, (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
        $('span', { class: 'tnum', style: 'text-align:right;font-size:13px;color:' + ((balanceById[e.id] || 0) >= 0 ? 'var(--positive)' : 'var(--negative)') }, fmt(balanceById[e.id] || 0)),
        $('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, e.method)),
        $('span', { style: 'color:var(--muted);font-size:14px;text-align:right;' }, '›'),
      );
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-deep)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('focus', () => { row.style.background = 'var(--bg-deep)'; });
      row.addEventListener('blur', () => { row.style.background = ''; });
      tableWrap.appendChild(row);
    }
  }
  c.appendChild(tableWrap);

  c.appendChild($('div', { class: 'summary-row' },
    $('span', { class: 'eyebrow' }, 'Monthly sum · expenses'),
    $('span', { class: 'display-num', style: 'font-size:30px;' }, fmt(expenseSum)),
  ));

  return c;
}

function monthNav(label, onClick, disabled) {
  return $('button', { type: 'button', class: 'btn btn-ghost', disabled: disabled ? '' : null, style: 'padding:6px 12px;font-size:13px;', onClick }, label);
}

// ---------- screens: insights ----------
function screenInsights() {
  const c = $('section', { 'aria-label': 'Insights' });
  c.appendChild($('div', { style: 'margin-bottom:24px;' },
    $('h1', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:34px;' }, 'Where it goes.'),
    $('p', { class: 'muted', style: 'margin-top:6px;font-size:14px;max-width:520px;' }, 'A 90-day look at where your money has been going.'),
  ));

  const recent = lastNinetyDays();
  const months = {};
  for (const e of recent.filter(e => e.type === 'expense')) {
    const k = monthKey(e.date);
    months[k] = (months[k] || 0) + e.amount;
  }
  const monthList = Object.entries(months).sort(([a],[b]) => a.localeCompare(b));
  const avg = monthList.length ? monthList.reduce((s, [,v]) => s+v, 0) / monthList.length : 0;

  const methodTotals = {};
  for (const e of recent.filter(e => e.type === 'expense')) methodTotals[e.method] = (methodTotals[e.method] || 0) + e.amount;
  const topMethodEntry = Object.entries(methodTotals).sort((a,b) => b[1]-a[1])[0];

  c.appendChild($('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin-bottom:32px;' },
    statCard('Average / month', fmt(avg)),
    statCard('Top method', topMethodEntry ? `${(methodShort(topMethodEntry[0]))} · ${fmt(topMethodEntry[1])}` : '—'),
    statCard('Entries', String(recent.filter(e => e.type === 'expense').length)),
    statCard('Categories active', String(new Set(recent.filter(e => e.type === 'expense').map(e => e.category)).size)),
  ));

  const catTotals = {};
  for (const e of recent.filter(e => e.type === 'expense')) catTotals[e.category] = (catTotals[e.category]||0) + e.amount;
  const catRows = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'By category · 90 days'),
    catRows.length === 0
      ? $('div', { class: 'empty' }, 'No expenses in the last 90 days.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
          ...catRows.map(([cat, val]) => bar(CATEGORIES.find(c=>c.id===cat)?.label || cat, val, maxCat, val === maxCat)),
        ),
  ));

  const methodRows = Object.entries(methodTotals).sort((a,b)=>b[1]-a[1]);
  const maxMethod = methodRows[0]?.[1] || 1;

  c.appendChild($('div', { class: 'card', style: 'padding:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'Payment mix · 90 days'),
    methodRows.length === 0
      ? $('div', { class: 'empty' }, 'No expenses in the last 90 days.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
          ...methodRows.map(([m, val]) => bar(METHODS.find(x=>x.id===m)?.label || m, val, maxMethod, val === maxMethod)),
        ),
  ));

  return c;
}
function statCard(label, value) {
  return $('div', { class: 'card', style: 'padding:20px;' },
    $('div', { class: 'eyebrow' }, label),
    $('div', { class: 'display-num', style: 'font-size:30px;margin-top:8px;' }, value),
  );
}
function bar(label, value, max, isMax) {
  return $('div', null,
    $('div', { class: 'row between', style: 'font-size:13px;margin-bottom:8px;' },
      $('span', null, label),
      $('span', { class: 'display-num', style: 'font-size:14px;' }, fmt(value)),
    ),
    $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;' },
      $('div', { style: `height:100%;width:${(value/max)*100}%;background:${isMax ? 'var(--accent)' : 'var(--ink)'};` }),
    ),
  );
}

// ---------- modal: transfer delete ----------
/** Delete-only modal for transfer pairs — editing is not allowed. */
function openTransferDelete(e) {
  const pair = state.entries.filter(x => x.transferId === e.transferId);
  const other = pair.find(x => x.id !== e.id);

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Transfer pair', tabindex: '-1', style: 'max-width:480px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:26px;' }, 'Transfer pair'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild($('p', { class: 'serif', style: 'font-style:italic;font-size:17px;margin:0 0 16px;' }, 'Transfers cannot be edited. Delete and recreate the pair.'));

  for (const p of pair) {
    modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;' },
      $('span', null, $('span', { class: 'pill', style: 'border-color:transparent;margin-right:8px;' }, methodShort(p.method)), p.details, ' · ', friendlyDate(p.date)),
      $('span', { class: 'display-num', style: `color:${p.type === 'credit' ? 'var(--positive)' : 'var(--ink)'};` }, (p.type === 'credit' ? '+' : '') + fmt(p.amount)),
    ));
  }

  modal.appendChild($('p', { class: 'serif', style: 'font-style:italic;font-size:15px;color:var(--negative);margin:16px 0 8px;' }, 'Delete this transfer pair? This cannot be undone.'));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: () => {
      state.entries = state.entries.filter(x => x.transferId !== e.transferId);
      persist();
      toast('Transfer pair deleted.');
      close();
    } }, 'Delete pair'),
  ));

  queueMicrotask(() => modal.querySelector('button')?.focus());
}

// ---------- modal: edit entry ----------
function openEdit(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;

  // Transfer entries can't be edited — show a delete-only modal
  if (e.transferId) {
    openTransferDelete(e);
    return;
  }

  // Capture the row id we opened from so we can restore focus to the
  // freshly-rendered row after `render()` rebuilds the DOM.
  const openerId = (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id) || null;
  const openerHadFocus = openerId != null;

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit entry', tabindex: '-1' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    bg.remove();
    render();
    if (openerHadFocus) {
      queueMicrotask(() => {
        const fresh = document.querySelector(`[data-id="${CSS.escape(openerId)}"]`);
        fresh?.focus();
      });
    }
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key === 'Tab') {
      const focusables = Array.from(modal.querySelectorAll('input, select, button, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);

  // Edit form (no delete button inside formView — we'll put it as a two-stage below)
  let formNode;
  const formContainer = $('div');
  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:26px;' }, 'Edit entry'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  formNode = formView({
    initial: e,
    onSubmit: (entryOrEntries) => {
      const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
      const updated = entries[0];
      const idx = state.entries.findIndex(x => x.id === id);
      state.entries[idx] = updated;
      persist();
      toast('Updated.');
      close();
    },
  });
  formContainer.appendChild(formNode);
  modal.appendChild(formContainer);

  // Two-stage delete (replaces native confirm)
  const deleteStage1 = $('button', { type: 'button', class: 'btn btn-danger', onClick: () => {
    // Reveal confirm panel
    deletePanel.style.display = '';
    deleteStage1.style.display = 'none';
    confirmDeleteBtn.focus();
  } }, 'Delete entry');
  const cancelDeleteBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => {
    deletePanel.style.display = 'none';
    deleteStage1.style.display = '';
    deleteStage1.focus();
  } }, 'Cancel');
  const confirmDeleteBtn = $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: () => {
    // If this entry is part of a transfer pair, delete its sibling too.
    if (e.transferId) {
      state.entries = state.entries.filter(x => x.transferId !== e.transferId);
    } else {
      state.entries = state.entries.filter(x => x.id !== id);
    }
    persist();
    toast('Deleted.');
    close();
  } }, 'Confirm delete');
  const deletePanel = $('div', { style: 'display:none;margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--accent-soft);' },
    $('p', { class: 'serif', style: 'font-style:italic;font-size:17px;margin:0 0 12px;color:var(--negative);' }, 'Delete this entry? This cannot be undone.'),
    $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' }, cancelDeleteBtn, confirmDeleteBtn),
  );
  modal.appendChild($('div', { style: 'margin-top:24px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px;' }, deleteStage1));

  modal.appendChild(deletePanel);

  // Initial focus into the first form field
  queueMicrotask(() => {
    const first = modal.querySelector('input, select, button');
    if (first) first.focus();
  });
}

// ---------- modal: sync settings ----------
function openSyncSettings() {
  const opener = document.activeElement;
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sync settings', tabindex: '-1', style: 'max-width:580px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    bg.remove();
    renderSyncIndicator();
    if (opener && typeof opener.focus === 'function') opener.focus();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key === 'Tab') {
      const focusables = Array.from(modal.querySelectorAll('input, select, button, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);

  const renderBody = () => {
    modal.innerHTML = '';
    const s = getSyncSettings();
    const status = syncStatus();

    modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' },
      $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:28px;' }, 'Sync'),
      $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
    ));

    modal.appendChild($('p', { class: 'serif', style: 'font-style:italic;color:var(--ink);margin:0 0 8px;font-size:17px;' },
      s.enabled
        ? (s.lastError ? 'Connection issue.' : status.label + '.')
        : 'Sync is off. Paste your password and save.',
    ));
    if (s.lastError) {
      modal.appendChild($('p', { style: 'font-size:13px;color:var(--negative);margin:0 0 18px;font-family:"Instrument Serif",serif;font-style:italic;' }, 'Last error: ', s.lastError));
    }

    // Endpoint + password form
    const endpointInput = $('input', { type: 'text', value: s.endpoint, 'aria-label': 'Sync endpoint URL', placeholder: '/.netlify/functions/sync', autocomplete: 'off' });
    const passwordInput = $('input', { type: 'password', value: s.password || '', 'aria-label': 'App password', placeholder: 'the password you set in Netlify', autocomplete: 'new-password' });

    const saveBtnLabel = $('span', null, 'Save & test');
    const saveBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: async () => {
      const newEndpoint = (endpointInput.value || '').trim();
      const newPassword = passwordInput.value || '';
      saveBtn.disabled = true;
      saveBtnLabel.textContent = 'Testing…';
      const r = await syncTestConnection(newEndpoint, newPassword);
      saveBtn.disabled = false;
      saveBtnLabel.textContent = 'Save & test';
      if (r.ok) {
        patchSyncSettings({ endpoint: newEndpoint, password: newPassword, enabled: true, lastError: null, lastErrorAt: null });
        toast('Connected.');
        notifySyncChange();
        renderBody();
        render();
      } else {
        patchSyncSettings({ endpoint: newEndpoint, password: newPassword, enabled: false, lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
        toast('Connection failed: ' + (r.message || r.reason || 'error'));
        notifySyncChange();
        renderBody();
        // Refocus the password field so the user can fix and retry without hunting.
        queueMicrotask(() => modal.querySelector('#sync-password')?.focus());
      }
    } }, saveBtnLabel);

    modal.appendChild($('div', { style: 'display:flex;flex-direction:column;gap:24px;margin-top:18px;margin-bottom:20px;' },
      $('div', null,
        $('label', { class: 'eyebrow', for: 'sync-endpoint' }, 'Endpoint'),
        Object.assign(endpointInput, { id: 'sync-endpoint' }),
      ),
      $('div', null,
        $('label', { class: 'eyebrow', for: 'sync-password' }, 'App password'),
        $('div', { style: 'position:relative;' },
          Object.assign(passwordInput, { id: 'sync-password' }),
          $('button', { type: 'button', class: 'btn-link', 'aria-label': 'Toggle password visibility', style: 'position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;padding:2px 6px;color:var(--muted);', onClick: function() {
            const isHidden = passwordInput.type === 'password';
            passwordInput.type = isHidden ? 'text' : 'password';
            this.textContent = isHidden ? 'hide' : 'show';
          } }, 'show'),
        ),
      ),
      $('div', { style: 'display:flex;justify-content:flex-end;' }, saveBtn),
    ));

    if (s.enabled) {
      // Pull / Push actions row
      const pullLabel = $('span', null, 'Pull');
      const pushLabel = $('span', null, 'Push');
      const pullBtn = $('button', { type: 'button', class: 'btn btn-ghost', onClick: async () => {
        pullBtn.disabled = true; pushBtn.disabled = true;
        pullLabel.textContent = 'Pulling…';
        const r = await syncPull();
        pullBtn.disabled = false; pushBtn.disabled = false;
        pullLabel.textContent = 'Pull';
        if (r.ok && r.content) {
          state = validateState(r.content);
          saveState(state);
          patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
          toast(`Pulled ${state.entries.length} entries.`);
          notifySyncChange();
          renderBody();
          render();
        } else if (r.ok && !r.content) {
          toast('Cloud file is empty.');
        } else {
          patchSyncSettings({ lastError: r.message || r.reason, lastErrorAt: new Date().toISOString() });
          toast('Pull failed: ' + (r.message || r.reason));
          notifySyncChange();
          renderBody();
        }
      } }, pullLabel);

      const pushBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: async () => {
        pullBtn.disabled = true; pushBtn.disabled = true;
        pushLabel.textContent = 'Pushing…';
        const r = await syncPush(state, { sha: s.lastSha, message: 'cents: manual push' });
        pullBtn.disabled = false; pushBtn.disabled = false;
        pushLabel.textContent = 'Push';
        if (r.ok) {
          patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
          toast('Pushed to cloud.');
          notifySyncChange();
          renderBody();
        } else if (r.reason === 'conflict') {
          patchSyncSettings({ lastError: 'conflict \u2014 pull first', lastErrorAt: new Date().toISOString() });
          toast('Conflict \u2014 cloud changed. Pull first.');
          notifySyncChange();
          renderBody();
        } else {
          patchSyncSettings({ lastError: r.message || r.reason, lastErrorAt: new Date().toISOString() });
          toast('Push failed: ' + (r.message || r.reason));
          notifySyncChange();
          renderBody();
        }
      } }, pushLabel);

      modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;padding-top:18px;border-top:1px solid var(--line);' }, pullBtn, pushBtn));

      if (s.lastSyncAt) {
        modal.appendChild($('p', { class: 'serif', style: 'font-style:italic;color:var(--muted);font-size:15px;margin-top:14px;' },
          `Last sync ${relativeTime(s.lastSyncAt)}.`,
        ));
      }
      if (s.repoLabel) {
        modal.appendChild($('p', { class: 'muted', style: 'font-size:12px;margin-top:4px;font-family:"JetBrains Mono",Menlo,monospace;' }, 'Repo: ', s.repoLabel));
      }

      modal.appendChild($('div', { style: 'margin-top:24px;padding-top:18px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;' },
        $('span', { class: 'muted', style: 'font-size:12px;font-family:"Instrument Serif",serif;font-style:italic;' }, 'Disconnect to wipe sync settings from this device.'),
        $('button', { type: 'button', class: 'btn btn-danger', onClick: () => {
          clearSyncSettings();
          toast('Sync disabled.');
          notifySyncChange();
          close();
        } }, 'Disconnect'),
      ));
    }
  };

  renderBody();
  queueMicrotask(() => modal.querySelector('input')?.focus());
}

// ---------- toast ----------
let toastTimer;
function toast(text) {
  let host = document.querySelector('.toast-host');
  if (!host) { host = $('div', { class: 'toast-host' }); document.body.appendChild(host); }
  const t = $('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, text);
  host.appendChild(t);
  toastTimer && clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.remove(); }, 2200);
}

// ---------- top-level render ----------
function render() {
  try {
    _render();
  } catch (e) {
    // Error boundary: if anything in the render pipeline throws,
    // show the error ON THE PAGE so we can see it without DevTools.
    var mount = document.getElementById('app');
    if (!mount) return;
    // Escape error text for safe HTML injection.
    var errText = String(e.stack || e.message || e).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    mount.innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;background:#FAF8F3;font-family:DM Sans,system-ui,sans-serif;z-index:9999;">' +
        '<div style="max-width:560px;padding:32px 36px;border:1px solid #e4e0d6;border-radius:16px;background:#fff;line-height:1.55;font-size:14px;box-shadow:0 8px 32px rgba(0,0,0,0.06);">' +
          '<div style="font-family:&quot;Instrument Serif&quot;,Georgia,serif;font-style:italic;font-size:22px;color:#1a1a1a;">cents.</div>' +
          '<h1 style="font-family:&quot;Instrument Serif&quot;,Georgia,serif;font-style:italic;font-weight:400;font-size:28px;margin:4px 0 8px;">Render crashed.</h1>' +
          '<div style="margin:12px 0 16px;padding:10px 12px;background:#fff5f0;border:1px solid #f4d7c8;border-radius:8px;font-size:12px;">' +
            '<span style="font-style:italic;color:#6d6457;font-family:&quot;Instrument Serif&quot;,Georgia,serif;">Error</span>' +
            '<code style="display:block;margin-top:4px;font-size:11px;word-break:break-word;white-space:pre-wrap;line-height:1.4;">' + errText + '</code>' +
          '</div>' +
          '<ol style="padding-left:22px;margin:12px 0 0;"><li>Copy the error above.</li><li>Hard refresh — <kbd style="background:#f4f0e7;padding:1px 6px;border-radius:4px;border:1px solid #e4e0d6;font-family:ui-monospace,monospace;font-size:12px;">Ctrl</kbd>+<kbd style="background:#f4f0e7;padding:1px 6px;border-radius:4px;border:1px solid #e4e0d6;font-family:ui-monospace,monospace;font-size:12px;">Shift</kbd>+<kbd style="background:#f4f0e7;padding:1px 6px;border-radius:4px;border:1px solid #e4e0d6;font-family:ui-monospace,monospace;font-size:12px;">R</kbd></li></ol>' +
        '</div>' +
      '</div>';
    // Also log so we can see it in DevTools
    console.error('Render crashed:', e);
  }
}

function _render() {
  const main = document.getElementById('app');
  if (!main) return;
  // Save scroll to restore after re-render
  const scrollY = window.scrollY;
  main.innerHTML = '';
  main.appendChild(renderHeader());

  const screen = $('main', { class: 'shell screen', id: 'screen' });
  const route = currentRoute();
  switch (route) {
    case 'add':      screen.appendChild(screenAdd()); break;
    case 'history':  screen.appendChild(screenHistory()); break;
    case 'insights': screen.appendChild(screenInsights()); break;
    default:         screen.appendChild(screenDashboard());
  }
  main.appendChild(screen);

  main.appendChild($('footer', { style: 'max-width:980px;margin:0 auto;padding:32px 28px 64px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;border-top:1px solid var(--line);' },
    $('span', null, String(state.entries.length), ' entries \u00b7 stored locally'),
    $('span', { style: 'display:flex;justify-content:flex-end;flex-wrap:wrap;gap:0 8px;align-items:center;' },
      $('button', { type: 'button', class: 'footer-action danger', onClick: function() {
        if (this.textContent === 'Reset') { this.textContent = 'Confirm reset'; return; }
        resetToBlank(); render(); toast('All entries cleared.');
        this.textContent = 'Reset';
      } }, 'Reset'),
      $('button', { type: 'button', class: 'footer-action', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) }, '↑ Top'),
    ),
  ));

  window.scrollTo(0, scrollY);
}

window.addEventListener('DOMContentLoaded', () => { render(); initSync(); });

// Expose tiny global for DevTools tinkering
window.__cents = {
  resetToBlank, render, toast,
  initSync, scheduleSyncPush, doAutoPush,
  renderSyncIndicator, openSyncSettings,
  syncPull, syncPush,
};
