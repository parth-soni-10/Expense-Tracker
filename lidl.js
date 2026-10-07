/**
 * Lidl Plus pull (the TRY): relay -> receipts -> one expense entry per receipt.
 *
 * Lidl's API sends no CORS headers (OPTIONS answers 405 - measured), so the
 * browser talks to a LOCAL relay instead: `python lidl-spike.py serve`, which
 * keeps the refresh token on the user's machine and hands this module only
 * normalized receipts { id, date, total, store, count, parsed }.
 *
 * Three rules carry the pull, each one a way the ledger or the gift card could
 * be corrupted by an automatic writer (same shape as the Tesco pay recorder's):
 *   1. BOUNDED - only receipts dated inside LIDL_WINDOW_DAYS up to today are
 *      ever created; an absent/again-broken relay must read as "pull nothing",
 *      never "pull everything this account has ever bought".
 *   2. NEVER RESURRECT - a ticket whose imported mark points at an entry that
 *      is no longer in the ledger is a line the user deleted; it is never
 *      written again. A ticket with no mark whose amount already sits in the
 *      ledger that day is the user's own line - it wins, and nothing is added.
 *   3. NEVER ROUND - an amount that is not exact to 2dp is dropped, not
 *      cleaned (the project-wide money rule; imported money is never silently
 *      rounded).
 *
 * The entry is `type: 'expense'`, `method: 'LG'` (the Lidl gift card): one
 * entry moves both figures the pull is supposed to move - the expense ledger
 * AND the gift-card balance, because balanceDelta() counts an expense on a
 * gift-card method as money leaving the card. Nothing top-level touches the
 * DOM or storage, so Node can import this file for tests directly.
 */

const LIDL_RELAY = 'http://127.0.0.1:8787';
export const LIDL_WINDOW_DAYS = 35;
export const LIDL_METHOD = 'LG';
export const LIDL_CATEGORY = 'gro';
const IMPORTED_KEY = 'cents:lidl-imported';

const p2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** Today as a local YYYY-MM-DD string (the ledger's own date shape). */
export function todayStr(now = new Date()) {
  return iso(now);
}

/** The oldest date the pull may create an entry for: today minus the window. */
export function windowStart(today) {
  const [y, m, d] = String(today).split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1);
  return iso(new Date(t - LIDL_WINDOW_DAYS * 86400000));
}

/** Exact to 2dp or not a valid amount - dropped, never rounded. */
export function amountOk(a) {
  return Number.isFinite(a) && Math.round(a * 100) / 100 === a;
}

/** One normalized receipt -> the entry shape, or null if it cannot be one. */
export function receiptToEntry(r, today) {
  if (!r || !r.parsed || !r.id || !r.date || !amountOk(r.total)) return null;
  if (!(r.date <= today) || !(r.date >= windowStart(today))) return null;
  return {
    date: r.date,
    type: 'expense',
    category: LIDL_CATEGORY,
    details: r.store ? `Lidl · ${r.store}` : 'Lidl',
    amount: r.total,
    method: LIDL_METHOD,
    note: 'Pulled from Lidl Plus',
  };
}

/**
 * Receipts -> entries to commit, with the skip reasons counted.
 * `imported` is { [ticketId]: { entryId } } from device-local storage;
 * `existing` is the ledger. Returns { entries, marks, skipped } where marks
 * pairs each new entry with its ticket id - written ONLY after the commit
 * lands, so a cancelled duplicate confirm leaves the ticket pullable again.
 */
export function ticketsToEntries(tickets, { today, existing = [], imported = {} } = {}) {
  const skipped = { shape: 0, window: 0, imported: 0, deleted: 0, blocked: 0, amount: 0 };
  const entries = [];
  const marks = [];
  // The user's own lines, consumed multiset-wise: two receipts for the same
  // amount on one day must not both hide behind a single manual entry.
  const taken = new Set();
  for (const r of Array.isArray(tickets) ? tickets : []) {
    if (!r || !r.parsed || !r.id || !r.date) { skipped.shape++; continue; }
    const mark = imported[r.id];
    if (mark && mark.entryId) {
      if (existing.some(e => e && e.id === mark.entryId)) { skipped.imported++; continue; }
      skipped.deleted++; continue; // the line is gone: the user deleted it, never again
    }
    if (r.date > today || r.date < windowStart(today)) { skipped.window++; continue; }
    if (!amountOk(r.total)) { skipped.amount++; continue; }
    const twin = existing.find((e, i) => e && !taken.has(i)
      && e.type === 'expense' && e.date === r.date && e.amount === r.total);
    if (twin) { taken.add(existing.indexOf(twin)); skipped.blocked++; continue; }
    const entry = { id: `lidl-${r.id}`, ...receiptToEntry(r, today) };
    if (!entry.id || !entry.date) { skipped.shape++; continue; }
    entries.push(entry);
    marks.push({ ticketId: r.id, entryId: entry.id });
  }
  return { entries, marks, skipped };
}

function readImported() {
  try {
    const raw = JSON.parse(localStorage.getItem(IMPORTED_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeImported(map) {
  try { localStorage.setItem(IMPORTED_KEY, JSON.stringify(map)); } catch { /* quota: pull again next open */ }
}

async function relayJson(path) {
  const res = await fetch(`${LIDL_RELAY}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return res.json();
}

/**
 * The pull itself. `commit` is app.js's commitAdded (the ONE duplicate gate),
 * `notify` its toast; both are handed in so this file stays importable anywhere.
 * Silent when idle or unreachable - it runs on every open, and an app that
 * nags when there is nothing to say is an app people disable.
 */
export async function pullLidl({ state, commit, notify, manual = false } = {}) {
  const say = msg => { if (manual && typeof notify === 'function') notify(msg); };
  if (!state || !Array.isArray(state.entries) || typeof localStorage === 'undefined') return null;
  let status;
  try { status = await relayJson('/status'); }
  catch { say('Lidl relay is not running. Start it: python lidl-spike.py serve'); return null; }
  let tickets;
  try { tickets = (await relayJson('/tickets')).tickets || []; }
  catch { say('The Lidl relay could not reach Lidl Plus. Try again in a moment.'); return null; }
  if (status && status.mode === 'real' && !tickets.length) { say('No receipts on Lidl Plus.'); return null; }
  const today = todayStr();
  const imported = readImported();
  const { entries, marks, skipped } = ticketsToEntries(tickets, { today, existing: state.entries, imported });
  if (!entries.length) {
    const parts = Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
    say(parts.length ? `No new Lidl receipts (${parts.join(', ')}).` : 'No new Lidl receipts.');
    return { entries: 0, skipped };
  }
  if (typeof commit !== 'function') return { entries: entries.length, skipped, uncommitted: true };
  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  commit(entries, `Lidl ${entries.length === 1 ? 'receipt' : `${entries.length} receipts`}`, () => {
    // Only now - the entries are in the ledger (a cancelled confirm never
    // marks, so that ticket is pulled again next open).
    const map = readImported();
    for (const m of marks) map[m.ticketId] = { entryId: m.entryId };
    writeImported(map);
    if (typeof notify === 'function') {
      notify(`Pulled ${entries.length} Lidl ${entries.length === 1 ? 'receipt' : 'receipts'} (${total.toFixed(2)} EUR) - gift card updated.`);
    }
  });
  return { entries: entries.length, skipped };
}

let autoRan = false;
/** Once per page open - this is what runs on boot behind the lock. */
export function autoPullLidl(opts = {}) {
  if (autoRan) return Promise.resolve(null);
  autoRan = true;
  return pullLidl(opts).catch(() => null);
}
