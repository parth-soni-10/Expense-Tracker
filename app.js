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
  setSyncPulsing(true);
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
  setSyncPulsing(false);
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

/** Set sync dot to pulsing while a push/pull is in flight. */
let _syncActive = false;
function setSyncPulsing(active) {
  _syncActive = active;
  const icon = document.querySelector('.sync-icon');
  if (icon) {
    icon.classList.toggle('spinning', active);
    if (!active) icon.classList.add('success');
    setTimeout(() => { if (icon && !_syncActive) icon.classList.remove('success'); }, 2000);
  }
}

function renderSyncIndicator() {
  const node = document.getElementById('sync-indicator');
  if (!node) return;
  const s = getSyncSettings();
  if (!s.enabled) { node.style.display = 'none'; return; }
  node.style.display = '';
  const status = syncStatus();
  node.innerHTML = '';
  const cls = 'sync-icon' + (_syncActive ? ' spinning' : '') + (status.state === 'ok' ? ' success' : '');
  node.append($('span', { class: cls, 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-sync-cloud" d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline class="icon-sync-arrows" points="17 6 19 4 21 6"/><line class="icon-sync-arrows" x1="19" y1="4" x2="19" y2="10"/><polyline class="icon-sync-check" points="20 6 9 17 4 12"/></svg>' }));
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
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 7);
  }
  return dates;
}

/** Returns the all-time running balance (income adds, expenses subtract) starting from openingBalance. */
function computeBalance(entries, openingBalance = 0) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
  let balance = openingBalance;
  const byId = {};
  const points = [];
  for (const e of sorted) {
    balance += e.type === 'credit' ? e.amount : -e.amount;
    byId[e.id] = balance;
    points.push({ date: e.date, balance });
  }
  return { balance, byId, points };
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

/** Gift card balance: loading (expense + category=GC) adds, spending (expense + category≠GC) subtracts, credits add. */
const GIFT_CARD_IDS = ['TG', 'LG', 'AG'];
function computeGiftCardBalance(entries, methodId, opening = 0) {
  const methodEntries = entries.filter(e => e.method === methodId);
  const sorted = [...methodEntries].sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
  let balance = opening;
  let loaded = 0;
  let spent = 0;
  for (const e of sorted) {
    if (e.type === 'credit') {
      balance += e.amount;
    } else if (e.category === 'GC') {
      // Buying/loading the gift card — adds to balance
      balance += e.amount;
      loaded += e.amount;
    } else {
      // Spending the gift card — subtracts from balance
      balance -= e.amount;
      spent += e.amount;
    }
  }
  return { balance, loaded, spent };
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
  const oldDate = rec.nextDate;
  state.entries.push(entry);
  state.entries.sort((a, b) => a.date.localeCompare(b.date));
  // Advance nextDate
  rec.nextDate = advanceRecurringDate(rec.nextDate, rec.frequency, rec.dayOfMonth);
  persist();
  trackAction(() => {
    state.entries = state.entries.filter(e => e.id !== entry.id);
    rec.nextDate = oldDate;
    persist();
  }, `Paid ${rec.details}`);
  toast(`Paid: ${rec.details} — ${fmt(rec.amount)}`);
  render();
}

// ---------- Tesco pay helpers ----------
function fillThursday(dateStr) {
  const lastTesco = [...state.entries].reverse().find(e => e.type === 'credit' && e.method === 'TG');
  const defaultAmt = lastTesco ? lastTesco.amount : 0;
  if (defaultAmt > 0) {
    const eid = uid();
    state.entries.push({ id: eid, date: dateStr, type: 'credit', category: 'misc', details: 'Tesco pay', amount: defaultAmt, method: 'TG', note: '' });
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist();
    trackAction(() => { state.entries = state.entries.filter(e => e.id !== eid); persist(); }, `Tesco ${friendlyDate(dateStr)}`);
    toast(`Filled Tesco pay for ${friendlyDate(dateStr)} — ${fmt(defaultAmt)}`);
    render();
  } else {
    openTescoFillModal(dateStr, []);
  }
}

function autoFillAll(unpaidThursdays) {
  const lastTesco = [...state.entries].reverse().find(e => e.type === 'credit' && e.method === 'TG');
  const defaultAmt = lastTesco ? lastTesco.amount : 0;
  if (defaultAmt > 0 && unpaidThursdays.length > 0) {
    for (const d of unpaidThursdays) {
      state.entries.push({ id: uid(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: defaultAmt, method: 'TG', note: '' });
    }
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist();
    toast(`Auto-filled ${unpaidThursdays.length} Tesco pay Thursdays — ${fmt(defaultAmt)} each`);
    render();
  } else if (unpaidThursdays.length === 0) {
    toast('All Thursdays are already filled.');
  } else {
    openTescoFillModal(null, unpaidThursdays);
  }
}

function openTescoFillModal(prefillDate, unpaidThursdays) {
  const data = { amount: '', date: prefillDate };
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set Tesco pay amount', tabindex: '-1', style: 'max-width:360px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);
  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const amtInput = $('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount', autocomplete: 'off', onInput: (e) => data.amount = e.target.value });

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:22px;' }, 'Tesco pay amount'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild($('div', { style: 'margin-bottom:20px;' },
    $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, 'Amount per Thursday'),
    amtInput,
  ));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const amt = parseAmount(data.amount);
      if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); return; }
      if (data.date) {
        state.entries.push({ id: uid(), date: data.date, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: 'TG', note: '' });
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        toast(`Filled Tesco pay for ${friendlyDate(data.date)} — ${fmt(amt)}`);
      } else {
        for (const d of unpaidThursdays) {
          state.entries.push({ id: uid(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: 'TG', note: '' });
        }
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        toast(`Auto-filled ${unpaidThursdays.length} Tesco pay Thursdays — ${fmt(amt)} each`);
      }
      close();
      render();
    } }, data.date ? 'Fill' : `Fill ${unpaidThursdays.length} Thursdays`),
  ));
  queueMicrotask(() => amtInput.focus());
}

// ---------- undo system ----------
let _lastAction = null;
function trackAction(undoFn, label) {
  _lastAction = { undo: undoFn, label, ts: Date.now() };
}
function undoLastAction() {
  if (!_lastAction) return;
  _lastAction.undo();
  const lbl = _lastAction.label;
  _lastAction = null;
  toast(`Undone: ${lbl}`);
  render();
}

// ---------- confetti ----------
function triggerConfetti() {
  const colors = ['#C2410C','#F59E0B','#10B981','#3B82F6','#EC4899','#8B5CF6'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + '%';
    piece.style.animationDelay = Math.random() * 1.5 + 's';
    piece.style.animationDuration = (2 + Math.random() * 2) + 's';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.width = (5 + Math.random() * 8) + 'px';
    piece.style.height = (5 + Math.random() * 8) + 'px';
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 4000);
  }
}

// ---------- fuzzy search ----------
function fuzzyMatch(text, query) {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}
function searchEntries(entries, query, filters) {
  return entries.filter(e => {
    if (query && !fuzzyMatch(e.details + ' ' + (e.note||''), query)) return false;
    if (filters.type && filters.type !== 'all' && e.type !== filters.type) return false;
    if (filters.category && filters.category !== 'all' && e.category !== filters.category) return false;
    if (filters.method && filters.method !== 'all' && e.method !== filters.method) return false;
    return true;
  });
}

// ---------- receipt parser ----------
function parseReceiptLine(line) {
  const s = line.trim();
  if (!s) return null;
  // Match: €amount description   or   amount description   or   description €amount
  const m1 = s.match(/^[€$]?([\d,.]+)\s+(.+)/);
  const m2 = s.match(/(.+)\s+[€$]([\d,.]+)$/);
  let amt = null, desc = '';
  if (m1) { amt = parseAmount(m1[1]); desc = m1[2]; }
  else if (m2) { amt = parseAmount(m2[2]); desc = m2[1]; }
  else { desc = s; }
  // Guess category from keywords
  let cat = 'misc';
  const d = desc.toLowerCase();
  if (/grocer|tesco|lidl|aldi|supervalu|dunnes/i.test(d)) cat = 'gro';
  else if (/bus|train|luas|dart|leap|taxi|uber|petrol|diesel/i.test(d)) cat = 'travel';
  else if (/rent|lease/i.test(d)) cat = 'rent';
  else if (/gift.?card|voucher/i.test(d)) cat = 'GC';
  return { details: desc || s, amount: amt || 0, category: cat };
}

// ---------- data health ----------
function computeDataHealth(entries) {
  if (entries.length === 0) return { score: 0, issues: ['No entries yet. Start tracking!'] };
  const issues = [];
  let score = 100;
  // Check for entries with no category / default
  const uncategorized = entries.filter(e => e.type === 'expense' && e.category === 'misc').length;
  if (uncategorized > entries.length * 0.3) { score -= 15; issues.push(`${uncategorized} entries are "Misc" — try categorising them.`); }
  // Large amounts
  const avg = entries.reduce((s,e) => s + e.amount, 0) / entries.length;
  const outliers = entries.filter(e => e.amount > avg * 5).length;
  if (outliers > 0) { score -= 10; issues.push(`${outliers} entr${outliers===1?'y':'ies'} look unusually large.`); }
  // Duplicates
  const seen = new Set();
  let dups = 0;
  for (const e of entries) {
    const key = `${e.date}|${e.amount}|${e.details}`;
    if (seen.has(key)) dups++;
    else seen.add(key);
  }
  if (dups > 0) { score -= 10; issues.push(`${dups} possible duplicate${dups===1?'':'s'} found.`); }
  // Gaps
  const dates = [...new Set(entries.map(e => e.date))].sort();
  if (dates.length >= 2) {
    let gaps = 0;
    for (let i = 1; i < dates.length; i++) {
      const d1 = new Date(dates[i-1]+'T00:00:00'), d2 = new Date(dates[i]+'T00:00:00');
      if ((d2 - d1) / 86400000 > 7) gaps++;
    }
    if (gaps > 0) { score -= 10; issues.push(`${gaps} tracking gap${gaps===1?'':'s'} > 7 days.`); }
  }
  return { score: Math.max(0, score), issues };
}

// ---------- season detection ----------
function setSeason() {
  const m = new Date().getMonth();
  const seasons = ['winter','winter','spring','spring','spring','summer','summer','summer','autumn','autumn','autumn','winter'];
  document.documentElement.dataset.season = seasons[m];
}

// ---------- router ----------
const ROUTES = ['dashboard', 'add', 'history', 'insights'];
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < 640;
const isTiny = () => typeof window !== 'undefined' && window.innerWidth < 480;
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
      $('div', { class: 'mark' }, $('span', { class: 'mark-icon', 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7c-2.5-1.7-5.7-1.7-8 0"/><path d="M17 12c-2.5-1.7-5.7-1.7-8 0"/><path d="M17 17c-2.5-1.7-5.7-1.7-8 0"/><line x1="6" y1="5" x2="6" y2="19"/></svg>' })),
      $('a', { href: '#dashboard', style: 'font-family:"Instrument Serif",serif;font-style:italic;font-size:30px;letter-spacing:-0.03em;' }, 'cents.'),
    ),
    $('nav', { class: 'nav', 'aria-label': 'Primary' },
      ...ROUTES.map(r => $('a', { href: `#${r}`, class: 'nav-link', 'aria-current': r === route ? 'page' : 'false' }, titleFor(r))),
    ),
    $('div', { class: 'header-actions' },
      $('span', { id: 'sync-indicator', style: 'display:inline-flex;align-items:center;gap:7px;font-family:"Instrument Serif",serif;font-style:italic;font-size:14px;color:var(--muted);' }),
      $('button', { class: 'dark-toggle', title: 'Toggle dark mode', 'aria-label': 'Toggle dark mode', onClick: () => {
        const html = document.documentElement;
        const isDark = html.dataset.theme === 'dark';
        html.dataset.theme = isDark ? '' : 'dark';
        try { localStorage.setItem('cents-theme', isDark ? 'light' : 'dark'); } catch(e) {}
      } },
        $('span', { class: 'icon-sun', 'aria-hidden': 'true', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' }),
        $('span', { class: 'icon-moon', 'aria-hidden': 'true', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' }),
      ),
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
  const tabs = $('div', { class: 'row', role: 'tablist', 'aria-label': 'Transaction type', style: `gap:${isNarrow() ? '16px' : '32px'};padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:32px;` });
  const expenseTab = pillTab('Expense', 'expense', data.type === 'expense');
  const creditTab  = pillTab('Income', 'credit', data.type === 'credit');
  const transferTab = pillTab('Transfer', 'transfer', data.type === 'transfer');
  tabs.append(expenseTab, creditTab, transferTab);
  function pillTab(label, type, active) {
    const btn = $('button', { type: 'button', class: 'pill', role: 'tab', 'data-id': label.toLowerCase(), 'aria-selected': active ? 'true' : 'false',          style: `padding:${isNarrow() ? '6px 14px' : '8px 18px'};font-size:12px;cursor:pointer;background:${active ? 'var(--accent-soft)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--muted)'};border-color:${active ? 'transparent' : 'var(--line)'};`, onClick: () => {
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

  const formEl = $('div', { class: 'card', style: `padding:${isNarrow() ? '20px' : '32px'};max-width:540px;margin:0 auto;` },
    tabs,
    $('div', { style: 'margin-bottom:24px;' },
      $('label', { class: 'eyebrow', for: 'f-amount' }, 'Amount'),
      $('div', { style: 'display:flex;align-items:baseline;gap:6px;margin-top:4px;' },
        $('span', { class: 'serif', style: `font-size:${isNarrow() ? '36px' : '60px'};color:var(--accent);`, 'aria-hidden': 'true' }, '€'),
        Object.assign(amountInput, { id: 'f-amount' }),
      ),
    ),
    $('div', { style: `display:grid;grid-template-columns:${isNarrow() ? '1fr' : '1fr 1fr'};gap:${isNarrow() ? '16px' : '24px'};margin-bottom:24px;` },
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
      $('button', { type: 'button', class: 'btn btn-primary', onClick: (ev) => {
        const icon = ev.currentTarget.querySelector('.btn-save-icon');
        if (icon) { icon.classList.add('saved'); setTimeout(() => { if (icon) icon.classList.remove('saved'); }, 800); }
        submit();
      } },
        $('span', { class: 'btn-save-icon', style: 'margin-right:6px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-save-line" d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke-dasharray="60" stroke-dashoffset="0"/><polyline class="icon-save-line" points="17 21 17 13 7 13 7 21" stroke-dasharray="20" stroke-dashoffset="0"/><polyline class="icon-save-line" points="7 3 7 8 15 8" stroke-dasharray="15" stroke-dashoffset="0"/><polyline class="icon-check" points="20 6 9 17 4 12"/></svg>' }),
        isEdit ? 'Save changes' : 'Save entry',
      ),
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

  // Net worth sparkline card (if enough data)
  const { points } = computeBalance(state.entries, openingBalance);
  if (points.length >= 2) {
    const last30 = points.slice(-30);
    const vals = last30.map(p => p.balance);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const isUp = vals[vals.length - 1] >= vals[0];
    const sparkH = 40, sparkW = 300;
    const step = sparkW / (vals.length - 1);
    const pathD = vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${sparkH - ((v - mn) / rng) * (sparkH - 4) - 2}`).join(' ');
    const areaD = pathD + ` L ${(vals.length - 1) * step} ${sparkH} L 0 ${sparkH} Z`;
    const lastVal = vals[vals.length - 1];
    screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '14px 18px' : '18px 24px'};margin-bottom:24px;display:flex;align-items:center;gap:16px;` },
      $('svg', { viewBox: `0 0 ${sparkW} ${sparkH}`, style: 'flex:1;min-width:120px;height:40px;', 'aria-label': 'Net worth trend' },
        $('path', { d: areaD, style: `fill:${isUp ? 'var(--positive)' : 'var(--negative)'};opacity:0.1;` }),
        $('path', { d: pathD, style: `fill:none;stroke:${isUp ? 'var(--positive)' : 'var(--negative)'};stroke-width:1.5;stroke-linecap:round;` }),
      ),
      $('div', { style: 'text-align:right;flex-shrink:0;' },
        $('div', { class: 'eyebrow', style: 'font-size:10px;' }, 'Net worth'),
        $('div', { class: 'display-num', style: `font-size:${isNarrow() ? '16px' : '18px'};color:${lastVal >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(lastVal)),
      ),
    ));
  }

  // Resync button — only shown when sync is configured
  const syncS = getSyncSettings();
  const resyncBtn = (syncS.enabled && syncS.endpoint && syncS.password)
    ? $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:13px;gap:6px;', onClick: () => doResync() },
        $('span', { style: 'font-size:15px;', 'aria-hidden': 'true' }, '↻'),
        'Resync',
      )
    : null;

  // Hero
  screen.appendChild($('div', { style: `display:flex;justify-content:space-between;align-items:${isNarrow() ? 'flex-start' : 'flex-end'};margin-bottom:${isNarrow() ? '24px' : '36px'};flex-wrap:wrap;gap:${isNarrow() ? '10px' : '16px'};` },
    $('div', null,
      $('div', { class: 'eyebrow' }, monthLabel(key)),
      $('p', { style: `font-size:${isTiny() ? '32px' : isNarrow() ? '42px' : '54px'};line-height:1;margin:8px 0 0;` },
        $('span', { class: 'serif' }, fmt(expenseSum)),
        $('span', { style: `font-family:DM Sans,system-ui,sans-serif;font-style:normal;font-size:${isNarrow() ? '14px' : '18px'};color:var(--muted);margin-left:8px;` }, budget ? `/ ${fmt(budget)}` : ''),
      ),
      $('p', { style: `font-size:${isNarrow() ? '13px' : '15px'};color:var(--muted);margin:6px 0 0;display:flex;align-items:center;gap:${isNarrow() ? '10px' : '18px'};flex-wrap:wrap;` },
        $('span', null, 'Balance ', $('span', { class: 'display-num', style: `font-size:16px;color:${runningBalance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(runningBalance))),
        cashWidget(),
      ),
    ),
    $('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' },
      $('label', { class: 'eyebrow', for: 'balance-input' }, 'Opening'),
      $('input', { id: 'balance-input', type: 'text', inputmode: 'decimal', value: String(openingBalance || ''), placeholder: '—', 'aria-label': 'Opening bank balance in euros', autocomplete: 'off', style: `width:${isNarrow() ? '72px' : '92px'};border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;`, onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
        e.target.style.borderColor = 'var(--line)';
        const v = parseAmount(e.target.value);
        if (!Number.isFinite(v)) { e.target.value = String(openingBalance || ''); toast('Enter a valid number.'); return; }
        if (v !== openingBalance) {
          state.settings.openingBalance = v; persist(); render();
          toast('Opening balance updated.');
        }
      }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      $('label', { class: 'eyebrow', for: 'budget-input' }, 'Budget'),
      $('input', { id: 'budget-input', type: 'text', inputmode: 'decimal', value: String(budget || ''), placeholder: '—', 'aria-label': 'Monthly budget in euros', autocomplete: 'off', style: `width:${isNarrow() ? '72px' : '92px'};border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;`, onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
        e.target.style.borderColor = 'var(--line)';
        const v = parseAmount(e.target.value);
        if (!Number.isFinite(v) || v < 0) { e.target.value = String(budget || ''); toast('Enter a non-negative number.'); return; }
        if (v !== budget) {
          state.settings.monthlyBudget = v; persist(); render();
          toast(v > 0 ? 'Budget updated.' : 'Budget cleared.');
        }
      }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      $('a', { href: '#add', class: 'btn btn-primary' },
        $('span', { class: 'btn-new-icon', style: 'margin-right:6px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line class="icon-plus-h" x1="5" y1="12" x2="19" y2="12"/><line class="icon-plus-v" x1="12" y1="5" x2="12" y2="19"/></svg>' }),
        'New entry',
      ),
      resyncBtn,
    ),
  ));

  // Budget bar card
  if (budget > 0) {
    screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-bottom:${isNarrow() ? '22px' : '32px'};` },
      $('div', { class: 'row between' },
        $('span', { class: 'eyebrow' }, 'Spent of budget'),
        $('span', { class: 'serif budget-pct-anim', style: 'font-size:22px;' }, `${pct.toFixed(1)}%`),
      ),
      $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;margin:14px 0 20px;' },
        $('div', { class: 'budget-bar-fill', style: `height:100%;width:${pct}%;background-image:${pct > 90 ? 'linear-gradient(90deg, var(--negative), #dc2626, var(--negative))' : 'linear-gradient(90deg, var(--accent), #ea580c, var(--accent))'};transition:width .5s cubic-bezier(0.2,0.8,0.2,1);border-radius:99px;box-shadow:0 0 12px ${pct > 90 ? 'rgba(185,28,28,0.2)' : 'var(--accent-glow)'};` }),
      ),
        // Confetti on last day of month if under budget (once per session)
        ...((() => { if (pct <= 100 && now.getDate() === new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() && !window.__confettiFired) { setTimeout(triggerConfetti, 600); window.__confettiFired = true; } return []; })()),
      $('div', { style: `display:grid;grid-template-columns:repeat(auto-fill,minmax(${isNarrow() ? '90px' : '130px'},1fr));gap:${isNarrow() ? '12px' : '24px'};padding-top:20px;border-top:1px solid var(--line);` },
        stat('Net', fmt(net)),
        stat('Spent', fmt(expenseSum)),
        stat('Income', fmt(incomeSum)),
        stat('Balance', fmt(runningBalance)),
        stat('Avg / day', fmt(expenseSum / Math.max(now.getDate(), 1))),
        stat('Month elapsed', Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100) + '%'),
        ...(budget && expenseSum > 0 ? [stat('Burn rate', (() => {
          const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
          const dailyAvg = expenseSum / Math.max(now.getDate(), 1);
          const projected = expenseSum + dailyAvg * daysLeft;
          const pctProj = Math.round((projected / budget) * 100);
          return pctProj > 100 ? `⚠ ${pctProj}%` : `${pctProj}%`;
        })())] : []),
      ),
    ));
  }

  // Recurring transactions — always show card so "+ New" is accessible
  const allRecurring = state.settings.recurring || [];
  const recurring = allRecurring.filter(r => r.nextDate <= key + '-31');
  const recCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-bottom:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, `Recurring · ${allRecurring.length}`),
      $('button', { type: 'button', style: 'font-size:11px;color:var(--accent);cursor:pointer;background:none;border:none;padding:0;', onClick: () => openNewRecurring() }, '+ New'),
    ),
    recurring.length === 0
      ? $('div', { class: 'muted', style: 'font-size:13px;font-style:italic;' }, allRecurring.length ? 'No items due this month.' : 'No recurring items yet. Add your rent, subscriptions, or paydays.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
        ...recurring.map(r => {
          const isOverdue = r.nextDate <= today();
          return $('div', { 'data-rec-id': r.id, class: 'rec-row', style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;transition:all .3s;' },
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
              $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:4px 12px;font-size:11px;', onClick: (ev) => {
        const rowEl = ev.target.closest('[data-rec-id]');
        if (rowEl) { rowEl.classList.add('paid-anim'); setTimeout(() => paidRecurring(r), 500); }
        else paidRecurring(r);
      } }, $('span', { class: 'btn-paid-icon', style: 'margin-right:5px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><polyline class="icon-paid-check" points="9 12 11 14 15 10"/></svg>' }), 'Paid'),
            ),
          );
        }),
      ),
  );
  screen.appendChild(recCard);

  // Category breakdown + recent
  const grid = $('div', { class: 'dashboard-grid', style: 'display:grid;grid-template-columns:1fr;gap:24px;align-items:start;' });
  // Responsive: 2-col on >=760px (set inline because we want it to ship without extra CSS)
  if (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches) {
    grid.style.gridTemplateColumns = 'minmax(0, 2fr) minmax(0, 3fr)';
  }

  const catCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'By category'),
      $('span', { class: 'muted', style: 'font-size:11px;' }, 'this month'),
    ),
    cats.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('receipt'), ' Nothing logged yet.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:14px;' },
          ...cats.map(([cat, val]) => $('div', null,
            $('div', { class: 'row between', style: 'font-size:13px;margin-bottom:6px;' },
              $('span', { style: 'font-weight:500;' }, CATEGORIES.find(c => c.id === cat)?.label || cat),
              $('span', { class: 'tnum' }, fmt(val)),
            ),
            $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;' },
              $('div', { style: `height:100%;width:${(val / cats[0][1]) * 100}%;background:${catBarGradient(cat)};border-radius:99px;transition:width .5s cubic-bezier(0.2,0.8,0.2,1);` }),
            ),
          )),
        ),
  );

  const recentCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};overflow-x:auto;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Recent'),
      $('a', { href: '#history', class: 'btn-link' }, 'See all →'),
    ),
    recent.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('chart'), ' No entries yet.')
      : $('div', { style: `display:grid;grid-template-columns:${isNarrow() ? '75px 1fr 80px' : '90px 1fr 110px 90px'};gap:${isNarrow() ? '8px 12px' : '12px 24px'};font-size:${isNarrow() ? '12px' : '14px'};${isNarrow() ? '' : 'min-width:520px;'}` },
          ...recent.flatMap(e => [
            $('span', { class: 'muted', style: 'font-size:12px;' }, friendlyDate(e.date)),
            $('div', null,
              $('div', { style: 'font-weight:500;' }, e.details || '—'),
              $('div', { style: `font-size:11px;color:var(--muted);${isNarrow() ? 'display:none;' : ''}` }, `${CATEGORIES.find(c => c.id === e.category)?.label || e.category} · ${METHODS.find(m => m.id === e.method)?.label || e.method}`),
            ),
            $('span', { class: 'display-num', style: `text-align:right;font-size:${isNarrow() ? '13px' : '15px'};color:${e.type === 'credit' ? 'var(--positive)' : 'var(--ink)'}` }, (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
            ...(isNarrow() ? [] : [$('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, e.method))]),
          ]),
        ),
  );

  grid.append(catCard, recentCard);
  screen.appendChild(grid);

  // Per-account running balances — bank / Revolut (exclude AIB and gift cards)
  const trackedMethods = METHODS.filter(m => m.id !== 'AIB' && !GIFT_CARD_IDS.includes(m.id));
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
    const accountsCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
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

  // Gift card balances — always show
  const gcOpenings = state.settings.giftCardOpenings || {};
  const giftCardBalances = GIFT_CARD_IDS.map(id => {
    const m = METHODS.find(x => x.id === id);
    const { balance, loaded, spent } = computeGiftCardBalance(state.entries, id, gcOpenings[id] || 0);
    return { id, label: m ? m.label : id, balance, loaded, spent, opening: gcOpenings[id] || 0 };
  });
  const gcCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:16px;' }, 'Gift card balances'),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...giftCardBalances.map(gc => {
        const label = gc.label.includes(' · ') ? gc.label.split(' · ')[1] : gc.label;
        const totalVol = gc.loaded + gc.spent || 1;
        const spentPct = Math.min(100, (gc.spent / totalVol) * 100);
        return $('div', { style: 'display:flex;flex-direction:column;padding:12px 14px;border-bottom:1px solid var(--line);gap:6px;' },
          $('div', { style: 'display:flex;align-items:center;justify-content:space-between;font-size:13px;' },
            $('div', { style: 'display:flex;align-items:center;gap:10px;flex:1;min-width:0;' },
              $('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${gc.balance > 0 ? 'var(--positive)' : gc.balance < 0 ? 'var(--negative)' : 'var(--muted)'};flex-shrink:0;` }),
              $('span', { style: 'font-weight:500;flex-shrink:0;' }, label),
            ),
            $('div', { style: 'display:flex;align-items:center;gap:8px;flex-shrink:0;' },
              $('span', { class: 'display-num', style: `font-size:14px;color:${gc.balance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(gc.balance)),
              $('button', { type: 'button', style: 'font-size:10px;color:var(--accent);cursor:pointer;background:none;border:none;padding:2px 6px;', onClick: () => openGiftCardBalanceEditor(gc) }, '✎'),
            ),
          ),
          // Mini progress bar: loaded vs spent
          gc.loaded > 0 || gc.spent > 0 ? $('div', { style: 'display:flex;align-items:center;gap:8px;' },
            $('div', { class: 'gc-progress-track' },
              $('div', { class: 'gc-progress-fill', style: `width:${spentPct}%;background-image:linear-gradient(90deg,${spentPct > 75 ? '#ff453a,#dc2626' : 'var(--accent),#ea580c'});` }),
            ),
            $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;flex-shrink:0;' }, `${fmt(gc.spent)} / ${fmt(gc.loaded + gc.spent)}`),
          ) : null,
        );
      }),
    ),
  );
  screen.appendChild(gcCard);

  // Tesco pay — Thursdays tracker
  const thursdays = thursdaysInMonth(now.getFullYear(), now.getMonth());
  // Look across ALL entries (not just this month) so Thursdays match regardless of when entered
  const incomeByDate = {};
  for (const e of state.entries.filter(x => x.type === 'credit')) { incomeByDate[e.date] = (incomeByDate[e.date] || 0) + e.amount; }
  // Build local today string the same way thursdaysInMonth does (no UTC shift)
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const unpaidThursdays = thursdays.filter(d => !incomeByDate[d] && d <= todayStr);

  const payCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Tesco pay · Thursdays'),
      $('div', { style: 'display:flex;align-items:center;gap:10px;' },
        $('span', { class: 'muted', style: 'font-size:11px;' }, `${thursdays.filter(d => !!incomeByDate[d]).length}/${thursdays.length} paid`),
        unpaidThursdays.length > 0 ? $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:4px 12px;font-size:11px;', onClick: () => autoFillAll(unpaidThursdays) }, `Auto-fill (${unpaidThursdays.length})`) : null,
      ),
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
            const canFill = !paid && (isPast || isToday);
            return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
              $('div', { style: 'display:flex;align-items:center;gap:12px;' },
                $('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;` }),
                $('span', { style: 'font-weight:500;' }, `${dayName} ${dayNum}`),
                isToday ? $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;padding:2px 8px;' }, 'today') : null,
              ),
              $('div', { style: 'display:flex;align-items:center;gap:8px;' },
                $('span', { class: 'display-num', style: `font-size:14px;color:${paid ? 'var(--positive)' : 'var(--muted)'};` },
                  paid ? `+${fmt(incomeByDate[d])}` : '—',
                ),
                canFill ? $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:3px 10px;font-size:10px;', onClick: () => fillThursday(d) }, 'Fill') : null,
              ),
            );
          }),
        ),
  );
  screen.appendChild(payCard);

  return screen;
}

function catBarGradient(catId) {
  const map = {
    gro: 'linear-gradient(90deg, #15803D, #22c55e)',
    travel: 'linear-gradient(90deg, #1E40AF, #3B82F6)',
    rent: 'linear-gradient(90deg, #7C3AED, #A78BFA)',
    GC: 'linear-gradient(90deg, #C2410C, #F97316)',
    misc: 'linear-gradient(90deg, #6B6B6B, #9CA3AF)',
  };
  return map[catId] || 'linear-gradient(90deg, var(--ink), var(--muted))';
}

/** Inline SVG icons for empty states. Returns an HTML string suitable for innerHTML. */
function emptySVG(kind) {
  const icons = {
    receipt: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="4" width="24" height="32" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="14" y1="12" x2="26" y2="12" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="18" x2="22" y2="18" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="24" x2="24" y2="24" stroke="currentColor" stroke-width="1.2"/></svg>',
    chart: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="22" width="7" height="14" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="16" y="12" width="7" height="24" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="26" y="6" width="7" height="30" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
    coin: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="14" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="20" r="10" stroke="currentColor" stroke-width="1.2"/><text x="20" y="24" text-anchor="middle" font-family="Instrument Serif,serif" font-style="italic" font-size="12" fill="currentColor">€</text></svg>',
  };
  return icons[kind] || '';
}

/** Create an empty-state icon span with the SVG rendered via innerHTML. */
function emptyIcon(kind) {
  const span = $('span', { class: 'empty-icon', style: 'display:block;margin:0 auto 12px;opacity:0.3;' });
  span.innerHTML = emptySVG(kind);
  return span;
}

function stat(label, value) {
  return $('div', null,
    $('div', { class: 'eyebrow' }, label),
    $('div', { class: 'display-num', style: `font-size:${isNarrow() ? '18px' : '22px'};margin-top:4px;` }, value),
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

  const tip = $('div', { style: `position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:10px;padding:12px 16px;background:var(--ink);color:var(--bg);border-radius:10px;font-size:12px;line-height:1.7;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,0.18);display:${hasAny ? '' : 'none'};` },
    ...(hasAny ? tipLines.map(l => $('div', null, l)) : []),
    hasAny ? $('div', { style: 'margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,0.15);font-weight:600;' }, `Total: ${fmt(total)}`) : null,
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
    const btn = $('button', { type: 'button', style: `flex:1;padding:8px 0;font-size:12px;cursor:pointer;border:none;background:${active ? 'var(--ink)' : 'transparent'};color:${active ? 'var(--bg)' : 'var(--muted)'};transition:background .15s;`, onClick: function() {
      data.type = type;
      if (activeTypeBtn) { activeTypeBtn.style.background = 'transparent'; activeTypeBtn.style.color = 'var(--muted)'; }
      this.style.background = 'var(--ink)'; this.style.color = 'var(--bg)';
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

// ---------- modal: gift card balance editor ----------
function openGiftCardBalanceEditor(gc) {
  const label = gc.label.includes(' · ') ? gc.label.split(' · ')[1] : gc.label;
  let val = gc.opening;

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit ${label} balance`, tabindex: '-1', style: 'max-width:400px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const input = $('input', { type: 'text', inputmode: 'decimal', value: String(val || ''), placeholder: '0.00', 'aria-label': 'Opening balance', autocomplete: 'off', style: 'width:100%;' });

  const computed = gc.balance - gc.opening;
  const displayTotal = $('span', { class: 'display-num', style: 'font-size:18px;' }, fmt(val + computed));

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:26px;' }, label),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));

  modal.appendChild($('div', { style: 'margin-bottom:16px;' },
    $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, 'Starting balance'),
    input,
    $('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;' }, 'Set the balance that was already on the card before you started tracking.'),
  ));

  const openingPreview = $('span', { class: 'tnum' }, fmt(val));
  modal.appendChild($('div', { style: 'display:flex;flex-direction:column;gap:6px;padding:12px;background:var(--accent-soft);border-radius:8px;margin-bottom:16px;' },
    $('div', { style: 'display:flex;justify-content:space-between;font-size:12px;' },
      $('span', { class: 'muted' }, `Loaded (${fmt(gc.loaded)}) – spent (${fmt(gc.spent)})`),
      $('span', { class: 'tnum' }, fmt(computed)),
    ),
    $('div', { style: 'display:flex;justify-content:space-between;font-size:12px;' },
      $('span', { class: 'muted' }, 'Starting balance'),
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
      if (!state.settings.giftCardOpenings) state.settings.giftCardOpenings = {};
      state.settings.giftCardOpenings[gc.id] = val;
      persist();
      toast(`${label} starting balance updated.`);
      close();
    } }, 'Save'),
  ));

  queueMicrotask(() => input.focus());
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

  // Quick-add receipt parser section
  const qTextarea = $('textarea', { placeholder: 'Quick-add: paste receipt lines…\ne.g. €12.50 Tesco groceries\n5.00 bus fare', 'aria-label': 'Quick-add receipt', rows: '2', style: 'width:100%;max-width:540px;margin:0 auto 16px;display:block;font-size:13px;', onInput: (e) => {
    const text = e.target.value;
    if (text.includes('\n')) {
      qPreview.innerHTML = '';
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parsed = parseReceiptLine(line);
        if (parsed) {
          qPreview.appendChild($('div', { class: 'receipt-line', style: 'display:flex;justify-content:space-between;padding:4px 0;font-size:12px;' },
            $('span', null, parsed.details, $('span', { class: 'pill pill-cat', style: 'margin-left:6px;font-size:10px;padding:1px 6px;' }, CATEGORIES.find(c=>c.id===parsed.category)?.label||parsed.category)),
            $('span', { class: 'tnum' }, parsed.amount > 0 ? fmt(parsed.amount) : '—'),
          ));
        }
      }
      qPreview.style.display = qPreview.children.length ? '' : 'none';
    }
  } });
  const qPreview = $('div', { class: 'receipt-preview', style: 'display:none;' });
  const qActions = $('div', { style: 'max-width:540px;margin:0 auto 16px;display:none;gap:8px;justify-content:flex-end;' },
    $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:12px;', onClick: () => { qTextarea.value = ''; qPreview.innerHTML = ''; qPreview.style.display = 'none'; qActions.style.display = 'none'; } }, 'Clear'),
    $('button', { type: 'button', class: 'btn btn-primary', style: 'font-size:12px;', onClick: () => {
      const lines = qTextarea.value.split('\n').filter(l => l.trim());
      let added = 0;
      for (const line of lines) {
        const parsed = parseReceiptLine(line);
        if (parsed && parsed.amount > 0) {
          state.entries.push({ id: uid(), date: today(), type: 'expense', category: parsed.category, details: parsed.details, amount: parsed.amount, method: 'AIB', note: '' });
          added++;
        }
      }
      if (added > 0) {
        state.entries.sort((a,b) => a.date.localeCompare(b.date));
        persist();
        toast(`Added ${added} entries.`);
        location.hash = '#dashboard';
      } else {
        toast('No valid entries found. Try "€amount description" format.');
      }
    } }, `Add entries`),
  );
  // Show actions when preview has content
  const qObserver = new MutationObserver(() => {
    if (qPreview.children.length > 0) qActions.style.display = 'flex';
    else qActions.style.display = 'none';
  });
  qObserver.observe(qPreview, { childList: true });

  c.appendChild($('div', { style: 'max-width:540px;margin:0 auto;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:6px;cursor:pointer;display:flex;align-items:center;gap:4px;', onClick: (e) => {
      const wrap = e.target.closest('.quick-add-wrap');
      if (wrap) { const body = wrap.querySelector('.quick-add-body'); body.style.display = body.style.display === 'none' ? '' : 'none'; }
    } }, '⚡ Quick-add (paste receipt)'),
    $('div', { class: 'quick-add-wrap' }, $('div', { class: 'quick-add-body' }, qTextarea, qPreview, qActions)),
  ));

  // Audio note button
  let mediaRecorder, audioChunks;
  const audioBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:12px;display:flex;align-items:center;gap:4px;', onClick: async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      audioBtn.innerHTML = '🎤 Record note…';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const note = prompt('Label for this audio note:', 'Voice note ' + friendlyDate(today()));
        if (note) {
          state.entries.push({ id: uid(), date: today(), type: 'expense', category: 'misc', details: note, amount: 0, method: 'AIB', note: `🎙 Audio note: ${url}` });
          persist();
          toast('Audio note saved.');
          render();
        }
      };
      mediaRecorder.start();
      audioBtn.innerHTML = '⏹ Stop recording';
    } catch(err) {
      toast('Microphone access denied.');
    }
  } }, '🎤 Record note…');
  c.appendChild($('div', { style: 'max-width:540px;margin:0 auto 24px;text-align:right;' }, audioBtn));

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
  let searchQuery = params.get('q') || '';

  const months = Array.from(new Set(state.entries.map(e => monthKey(e.date)))).sort().reverse();
  if (!months.includes(activeMonth) && months.length) activeMonth = months[0];

  const monthEntries = entriesForMonth(activeMonth);
  const filtered = searchEntries(monthEntries, searchQuery, { type: 'all', category: activeCat, method: 'all' });
  const visible = filtered.sort((a, b) => b.date.localeCompare(a.date));
  const expenseSum = monthEntries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const openingBalance = +state.settings.openingBalance || 0;
  const { byId: balanceById } = computeBalance(state.entries, openingBalance);

  const update = (next = {}) => {
    if (next.month !== undefined) params.set('month', next.month);
    if (next.cat !== undefined) {
      if (next.cat === 'all') params.delete('cat');
      else params.set('cat', next.cat);
    }
    if (next.q !== undefined) {
      if (next.q) params.set('q', next.q);
      else params.delete('q');
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

  // Search bar
  const searchInput = $('input', { type: 'text', value: searchQuery, placeholder: 'Search descriptions, notes…', 'aria-label': 'Search entries', autocomplete: 'off', style: 'width:100%;max-width:320px;', onInput: (e) => {
    // Debounced update
    clearTimeout(searchInput._timer);
    searchInput._timer = setTimeout(() => update({ q: e.target.value }), 250);
  } });
  c.appendChild($('div', { style: 'margin-bottom:16px;' },
    $('div', { style: 'display:flex;gap:8px;align-items:center;' },
      $('span', { style: 'font-size:16px;color:var(--muted);', 'aria-hidden': 'true' }, '🔍'),
      searchInput,
      searchQuery ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { searchInput.value = ''; update({ q: '' }); } }, 'Clear') : null,
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
    tableWrap.appendChild($('div', { class: 'empty' }, emptyIcon('receipt'), searchQuery ? ' No results for this search.' : ' Nothing here for this filter.'));
  } else {
    tableWrap.appendChild($('div', { role: 'row', style: 'display:grid;grid-template-columns:90px 1fr 110px 100px 90px 30px;gap:24px;padding:14px 24px;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);min-width:740px;' },
      $('span', { role: 'columnheader' }, 'Date'),
      $('span', { role: 'columnheader' }, 'Description'),
      $('span', { role: 'columnheader', style: 'text-align:right;' }, 'Amount'),
      $('span', { role: 'columnheader', style: 'text-align:right;' }, 'Balance'),
      $('span', { role: 'columnheader' }, 'Method'),
      $('span'),
    ));

    for (const e of visible) {
      const isTransfer = !!e.transferId;
      const settledLabel = isTransfer ? (e.settled ? '✓ settled' : '● unsettled') : '';
      const settleColor = e.settled ? 'var(--positive)' : 'var(--muted)';
      const rowType = e.type === 'credit' ? 'income-row' : 'expense-row';
      const row = $('div', { class: `history-row ${rowType}`, role: 'row', tabindex: '0', 'data-id': e.id, 'aria-label': `Edit entry ${e.details} on ${friendlyDate(e.date)}`, style: 'display:grid;grid-template-columns:90px 1fr 110px 100px 90px 30px;gap:24px;padding:14px 24px;align-items:center;border-bottom:1px solid var(--line);cursor:pointer;min-width:740px;outline:none;', onClick: () => openEdit(e.id), onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdit(e.id); } } },
        $('span', { class: 'muted', style: 'font-size:13px;' }, friendlyDate(e.date)),
        $('div', null,
          $('div', { style: 'font-size:14px;display:flex;align-items:center;gap:6px;' }, e.details || '—',
            isTransfer ? $('span', { style: `font-size:10px;color:${settleColor};cursor:pointer;user-select:none;`, onClick: (ev) => {
              ev.stopPropagation();
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
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  const fromParam = params.get('from') || '';
  const toParam = params.get('to') || '';
  const fromDate = fromParam || (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().slice(0,10); })();
  const toDate = toParam || today();

  const rangeEntries = state.entries.filter(e => e.date >= fromDate && e.date <= toDate);
  const recent = rangeEntries;

  const c = $('section', { 'aria-label': 'Insights' });

  // Date range picker
  const fromInput = $('input', { type: 'date', value: fromDate, 'aria-label': 'From date', style: 'width:auto;font-size:13px;', onChange: (e) => {
    params.set('from', e.target.value); location.hash = 'insights?' + params.toString();
  } });
  const toInput = $('input', { type: 'date', value: toDate, 'aria-label': 'To date', style: 'width:auto;font-size:13px;', onChange: (e) => {
    params.set('to', e.target.value); location.hash = 'insights?' + params.toString();
  } });

  c.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:24px;flex-wrap:wrap;gap:12px;' },
    $('h1', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:34px;' }, 'Where it goes.'),
    $('div', { style: 'display:flex;align-items:center;gap:8px;' },
      fromInput,
      $('span', { class: 'muted', style: 'font-size:13px;' }, '→'),
      toInput,
      (fromParam || toParam) ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { location.hash = 'insights'; } }, 'Reset') : null,
    ),
  ));

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

  // Calendar heatmap — current month
  const now = new Date();
  const heatKey = monthKey(now.toISOString().slice(0, 10));
  const heatEntries = entriesForMonth(heatKey).filter(e => e.type === 'expense');
  const heatByDay = {};
  for (const e of heatEntries) heatByDay[e.date] = (heatByDay[e.date] || 0) + e.amount;
  const maxDay = Math.max(1, ...Object.values(heatByDay));
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const firstDow = new Date(now.getFullYear(), now.getMonth(), 1).getDay(); // 0=Sun
  // Mon-start: shift Sun→6, Mon→0 … Sat→5
  const monAdjusted = (firstDow + 6) % 7;
  
  const heatCells = [];
  for (let i = 0; i < monAdjusted; i++) heatCells.push($('div')); // empty leading cells
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const val = heatByDay[ds] || 0;
    const intensity = maxDay > 0 ? val / maxDay : 0;
    const color = intensity === 0 ? 'var(--line)' :
      intensity < 0.25 ? 'color-mix(in srgb, var(--accent) 30%, var(--bg))' :
      intensity < 0.5 ? 'color-mix(in srgb, var(--accent) 55%, var(--bg))' :
      intensity < 0.75 ? 'color-mix(in srgb, var(--accent) 75%, var(--bg))' : 'var(--accent)';
    const tip = val > 0 ? `${fmt(val)}` : '';
    heatCells.push($('div', { class: 'heat-cell-wrap', style: 'position:relative;' },
      tip ? $('div', { class: 'heat-tip' }, tip) : null,
      $('div', { class: 'heat-cell', title: tip, style: `border-radius:3px;aspect-ratio:1;background:${color};cursor:default;font-size:9px;display:flex;align-items:center;justify-content:center;${val === 0 ? 'opacity:0.5;' : ''}${ds === today() ? 'box-shadow:0 0 0 1.5px var(--ink);' : ''}` },
        val > 0 ? $('span', { style: 'color:var(--ink);font-weight:600;font-size:8px;' }, String(d)) : null,
      ),
    ));
  }

  c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:12px;' }, `Spending heatmap · ${monthLabel(heatKey)}`),
    $('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:3px;' },
      ...['M','T','W','T','F','S','S'].map(l => $('div', { style: 'text-align:center;font-size:10px;color:var(--muted);padding-bottom:4px;' }, l)),
      ...heatCells,
    ),
    $('div', { style: 'margin-top:8px;font-size:10px;color:var(--muted);display:flex;align-items:center;gap:4px;' },
      $('span', null, 'Less'),
      ...[0, 0.25, 0.5, 0.75, 1].map(i => $('span', { style: `display:inline-block;width:12px;height:12px;border-radius:2px;background:${i===0?'var(--line)':`color-mix(in srgb, var(--accent) ${i*100}%, var(--bg))`};` })),
      $('span', null, 'More'),
    ),
  ));

  const catTotals = {};
  for (const e of recent.filter(e => e.type === 'expense')) catTotals[e.category] = (catTotals[e.category]||0) + e.amount;
  const catRows = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'By category'),
    catRows.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('coin'), ' No expenses in this range.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
          ...catRows.map(([cat, val]) => bar(CATEGORIES.find(c=>c.id===cat)?.label || cat, val, maxCat, val === maxCat)),
        ),
  ));

  const methodRows = Object.entries(methodTotals).sort((a,b)=>b[1]-a[1]);
  const maxMethod = methodRows[0]?.[1] || 1;

  c.appendChild($('div', { class: 'card', style: 'padding:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'Payment mix'),
    methodRows.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('coin'), ' No expenses in this range.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
          ...methodRows.map(([m, val]) => bar(METHODS.find(x=>x.id===m)?.label || m, val, maxMethod, val === maxMethod)),
        ),
  ));

  // Data health card
  const health = computeDataHealth(state.entries);
  const healthColor = health.score >= 80 ? 'var(--positive)' : health.score >= 50 ? 'var(--accent)' : 'var(--negative)';
  c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
      $('div', { class: 'eyebrow' }, 'Data health'),
      $('span', { class: 'display-num', style: `font-size:22px;color:${healthColor};` }, `${health.score}%`),
    ),
    health.issues.length === 0
      ? $('div', { class: 'empty', style: 'padding:8px 0;' }, 'Your data looks clean! ✨')
      : $('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          ...health.issues.map(issue => $('div', { style: 'font-size:13px;padding:6px 0;border-bottom:1px solid var(--line);' }, '· ', issue)),
        ),
  ));

  // Year-in-review button
  c.appendChild($('div', { style: 'text-align:center;padding:16px 0;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: openYearInReview }, '📊 Year in review'),
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
      $('div', { style: `height:100%;width:${(value/max)*100}%;background:${isMax ? 'linear-gradient(90deg, var(--accent), #ea580c, var(--accent))' : 'linear-gradient(90deg, var(--ink), var(--muted))'};border-radius:99px;transition:width .5s cubic-bezier(0.2,0.8,0.2,1);` }),
    ),
  );
}

// ---------- modal: year in review ----------
function openYearInReview() {
  const now = new Date();
  const year = now.getFullYear();
  const yearEntries = state.entries.filter(e => e.date >= `${year}-01-01` && e.date <= `${year}-12-31`);
  const expOnly = yearEntries.filter(e => e.type === 'expense');
  const incOnly = yearEntries.filter(e => e.type === 'credit');
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
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;' },
    $('h2', { style: 'font-family:"Instrument Serif",serif;font-style:italic;font-weight:400;font-size:28px;' }, `Your ${year} in review`),
    $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close'),
  ));

  const rows = [
    ['Total earned', fmt(totalEarned), 'var(--positive)'],
    ['Total spent', fmt(totalSpent), 'var(--ink)'],
    ['Net', fmt(totalEarned - totalSpent), (totalEarned - totalSpent) >= 0 ? 'var(--positive)' : 'var(--negative)'],
    ['Entries logged', String(yearEntries.length), ''],
    ['Top category', topCat ? `${CATEGORIES.find(c=>c.id===topCat[0])?.label||topCat[0]} · ${fmt(topCat[1])}` : '—', ''],
    ['Best month', bestMonth ? `${monthLabel(bestMonth[0])} · ${fmt(bestMonth[1])}` : '—', ''],
    ['Toughest month', worstMonth ? `${monthLabel(worstMonth[0])} · ${fmt(worstMonth[1])}` : '—', ''],
    ['Busiest day', busiestDay ? `${friendlyDate(busiestDay[0])} — ${busiestDay[1].count} entries, ${fmt(busiestDay[1].total)}` : '—', ''],
  ];
  for (const [label, value, color] of rows) {
    modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px;' },
      $('span', { class: 'muted' }, label),
      $('span', { class: 'display-num', style: color ? `color:${color};font-size:16px;` : 'font-size:16px;' }, value),
    ));
  }

  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Close'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const text = rows.map(([l,v]) => `${l}: ${v}`).join('\n');
      navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard!'), () => toast('Could not copy.'));
    } }, 'Copy summary'),
  ));
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
function toast(text, undoFn, undoLabel) {
  let host = document.querySelector('.toast-host');
  if (!host) { host = $('div', { class: 'toast-host' }); document.body.appendChild(host); }
  const children = [text];
  // If explicit undoFn passed, use it; otherwise auto-detect _lastAction
  const effectiveUndo = undoFn || (_lastAction ? (() => undoLastAction()) : null);
  const effectiveLabel = undoLabel || (_lastAction ? 'Undo' : '');
  if (effectiveUndo) {
    children.push($('button', { type: 'button', class: 'toast-undo', onClick: () => { effectiveUndo(); t.remove(); } }, effectiveLabel));
  }
  const t = $('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, ...children);
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
    var isDark = document.documentElement.dataset.theme === 'dark';
    var c = {
      bg: isDark ? '#1a1a1c' : '#FAF8F3',
      card: isDark ? '#2c2c2e' : '#fff',
      line: isDark ? '#3a3a3c' : '#e4e0d6',
      ink: isDark ? '#e8e4dd' : '#1a1a1a',
      muted: isDark ? '#8e8e93' : '#6d6457',
      soft: isDark ? '#2d2019' : '#fff5f0',
      softBorder: isDark ? '#4a3020' : '#f4d7c8',
      kbdBg: isDark ? '#2c2c2e' : '#f4f0e7',
      shadow: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.06)',
    };
    mount.innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;background:' + c.bg + ';font-family:DM Sans,system-ui,sans-serif;z-index:9999;">' +
        '<div style="max-width:560px;padding:32px 36px;border:1px solid ' + c.line + ';border-radius:16px;background:' + c.card + ';line-height:1.55;font-size:14px;box-shadow:0 8px 32px ' + c.shadow + ';">' +
          '<div style="font-family:&quot;Instrument Serif&quot;,Georgia,serif;font-style:italic;font-size:22px;color:' + c.ink + ';">cents.</div>' +
          '<h1 style="font-family:&quot;Instrument Serif&quot;,Georgia,serif;font-style:italic;font-weight:400;font-size:28px;margin:4px 0 8px;">Render crashed.</h1>' +
          '<div style="margin:12px 0 16px;padding:10px 12px;background:' + c.soft + ';border:1px solid ' + c.softBorder + ';border-radius:8px;font-size:12px;">' +
            '<span style="font-style:italic;color:' + c.muted + ';font-family:&quot;Instrument Serif&quot;,Georgia,serif;">Error</span>' +
            '<code style="display:block;margin-top:4px;font-size:11px;word-break:break-word;white-space:pre-wrap;line-height:1.4;">' + errText + '</code>' +
          '</div>' +
          '<ol style="padding-left:22px;margin:12px 0 0;"><li>Copy the error above.</li><li>Hard refresh — <kbd style="background:' + c.kbdBg + ';padding:1px 6px;border-radius:4px;border:1px solid ' + c.line + ';font-family:ui-monospace,monospace;font-size:12px;">Ctrl</kbd>+<kbd style="background:' + c.kbdBg + ';padding:1px 6px;border-radius:4px;border:1px solid ' + c.line + ';font-family:ui-monospace,monospace;font-size:12px;">Shift</kbd>+<kbd style="background:' + c.kbdBg + ';padding:1px 6px;border-radius:4px;border:1px solid ' + c.line + ';font-family:ui-monospace,monospace;font-size:12px;">R</kbd></li></ol>' +
        '</div>' +
      '</div>';
    // Also log so we can see it in DevTools
    console.error('Render crashed:', e);
  }
}

function _render() {
  const main = document.getElementById('app');
  if (!main) return;
  // Init dark mode + season on first render — dark is the default
  if (!document.documentElement.dataset.themeInit) {
    document.documentElement.dataset.themeInit = '1';
    try {
      const saved = localStorage.getItem('cents-theme');
      document.documentElement.dataset.theme = saved === 'light' ? '' : 'dark';
    } catch(e) {}
    setSeason();
  }
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

  // Bottom tab bar on mobile
  const route2 = currentRoute();
  const tabIconSVG = (id) => {
    const icons = {
      dashboard: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
      add: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>' },
      history: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>' },
      insights: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="3" width="4" height="18"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z"/></svg>' },
    };
    const set = icons[id] || icons.dashboard;
    return $('span', { class: 'bottom-tab-icon', 'aria-hidden': 'true' },
      $('span', { class: 'tab-icon-outline', innerHTML: set.outline }),
      $('span', { class: 'tab-icon-filled', innerHTML: set.filled }),
    );
  };
  const tabItems = [
    { id: 'dashboard', label: 'Home' },
    { id: 'add', label: 'Add' },
    { id: 'history', label: 'History' },
    { id: 'insights', label: 'Insights' },
  ];
  main.appendChild($('nav', { class: 'bottom-tab-bar', 'aria-label': 'Mobile navigation' },
    ...tabItems.map(t => $('a', { href: `#${t.id}`, class: 'bottom-tab', 'aria-current': t.id === route2 ? 'page' : 'false' },
      tabIconSVG(t.id),
      $('span', null, t.label),
    )),
  ));

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

  // Sticky header setup — add sticky class + scroll listener on first render
  if (!window.__stickyInit) {
    window.__stickyInit = true;
    const hdr = document.querySelector('.app-header');
  // Sticky header — re-query on every scroll event since header is rebuilt on render
  window.__stickyInit = true;
  let lastScroll = 0;
  window.addEventListener('scroll', () => {
    if (window.innerWidth < 640) return;
    const hdr = document.querySelector('.app-header');
    if (!hdr) return;
    if (!hdr.classList.contains('is-sticky')) hdr.classList.add('is-sticky');
    const now = window.scrollY;
    if (now > 80 && now > lastScroll) hdr.classList.add('head-hidden');
    else hdr.classList.remove('head-hidden');
    lastScroll = now;
  }, { passive: true });
  }
}

window.addEventListener('DOMContentLoaded', () => { render();  initSync().finally(() => setSyncPulsing(false));
});

// Expose tiny global for DevTools tinkering
window.__cents = {
  resetToBlank, render, toast,
  initSync, scheduleSyncPush, doAutoPush,
  renderSyncIndicator, openSyncSettings,
  syncPull, syncPush,
};
