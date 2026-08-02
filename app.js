/* ============================================================
   Expense Tracker — editorial-minimal SPA
   Hash routing: #dashboard (default) | #add | #history | #insights
   ============================================================ */
import { loadState, saveState, resetToBlank, exportJSON, validateState, uid, updateAllowedCategories, isValidCheckpointDate, BALANCE_METHOD_IDS } from './storage.js';
import { CATEGORIES, METHODS } from './seed.js';
import { getSyncSettings, patchSyncSettings, clearSyncSettings, getPrivacyPin, setPrivacyPin, clearPrivacyPin } from './settings.js';
import { syncPull, syncPush, syncTestConnection, syncStatus, relativeTime, notifySyncChange, subscribeSync } from './sync.js';

// ---------- state ----------
let state = loadState();
// Keep storage.js validation set in sync with seed + custom categories.
updateAllowedCategories([...CATEGORIES, ...(state.settings.customCategories || [])].map(c => c.id));
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function offsetDateKey(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const today = () => localDateKey();
const nowIso = () => new Date().toISOString();
const MAX_MUTATION_HISTORY = 1000;
function mutationTimestamp(entry) {
  const now = Date.now();
  const created = Date.parse(entry?.createdAt || '');
  const history = Array.isArray(entry?.mutationHistory) ? entry.mutationHistory : [];
  const latest = Date.parse(history.at(-1)?.at || '');
  const next = Math.max(now, Number.isFinite(created) ? created + 1 : 0, Number.isFinite(latest) ? latest + 1 : 0);
  return new Date(next).toISOString();
}
let pinUnlocked = false;
let pinOverlay = null;
let syncBootStarted = false;
let lastRenderedRoute = null;
let renderFrame = null;

function startInitSync() {
  if (syncBootStarted) return;
  syncBootStarted = true;
  initSync().finally(() => setSyncPulsing(false));
}

async function hashPin(pin, salt = '') {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const bytes = new TextEncoder().encode(`${salt === null ? '' : salt}:${String(pin)}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPinPlain(pin) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const bytes = new TextEncoder().encode(String(pin));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getPinCredential() {
  const devicePin = getPrivacyPin();
  if (devicePin.hash) return devicePin;
  const legacyHash = state?.settings?.pinHash;
  return typeof legacyHash === 'string' && /^[a-f0-9]{64}$/i.test(legacyHash)
    ? { salt: null, hash: legacyHash.toLowerCase() }
    : { salt: null, hash: null };
}

function hasPinLock() {
  return !!getPinCredential().hash;
}

function closePinOverlay() {
  if (pinOverlay) { pinOverlay.remove(); pinOverlay = null; }
}

function showPinLock() {
  if (pinUnlocked || !hasPinLock() || pinOverlay) return;
  const input = $('input', { type: 'password', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', placeholder: '••••', 'aria-label': 'PIN', style: 'width:100%;text-align:center;letter-spacing:.35em;font-size:24px;' });
  const message = $('p', { class: 'muted', style: 'font-size:13px;text-align:center;min-height:20px;margin:12px 0;' });
  const submit = async () => {
    const value = String(input.value || '').trim();
    if (!/^\d{4,6}$/.test(value)) { message.textContent = 'Enter your 4–6 digit PIN.'; input.focus(); return; }
    try {
      const saved = getPinCredential();
      const saltedMatch = saved.salt !== null && (await hashPin(value, saved.salt)) === saved.hash;
      // Older builds used plain SHA-256(pin). This also keeps the lock active
      // if a browser cannot persist the migrated device-only credential.
      const legacyMatch = saved.salt === null && (await hashPinPlain(value)) === saved.hash;
      if (!saltedMatch && !legacyMatch) {
        message.textContent = 'That PIN is not correct.';
        input.value = '';
        input.focus();
        return;
      }
      pinUnlocked = true;
      closePinOverlay();
      render();
      startInitSync();
    } catch (err) {
      message.textContent = 'PIN verification is unavailable in this browser.';
    }
  };
  const overlay = $('div', { class: 'modal-bg', style: 'z-index:10000;background:rgba(0,0,0,.82);' },
    $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Unlock cents', style: 'max-width:360px;text-align:center;' },
      $('div', { class: 'serif', style: 'font-size:32px;font-style:italic;margin-bottom:4px;' }, 'cents.'),
      $('p', { class: 'eyebrow', style: 'margin:0;' }, 'Privacy lock'),
      $('p', { class: 'serif', style: 'font-style:italic;font-size:18px;margin:20px 0 4px;' }, 'Welcome back.'),
      message,
      input,
      $('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%;margin-top:12px;', onClick: submit }, 'Unlock'),
    ),
  );
  pinOverlay = overlay;
  document.body.appendChild(overlay);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  queueMicrotask(() => input.focus());
}

function lockApp() {
  if (!hasPinLock()) { toast('Set a PIN first.'); return; }
  pinUnlocked = false;
  render();
  showPinLock();
}

function openPinSettings() {
  const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Privacy lock settings', tabindex: '-1', style: 'max-width:420px;' });
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.appendChild(modal); document.body.appendChild(bg);
  const current = hasPinLock();
  const pin = $('input', { type: 'password', inputmode: 'numeric', maxlength: '6', autocomplete: 'new-password', placeholder: current ? 'New PIN (leave blank to keep)' : '4–6 digits', 'aria-label': 'New PIN' });
  const confirm = $('input', { type: 'password', inputmode: 'numeric', maxlength: '6', autocomplete: 'new-password', placeholder: 'Repeat PIN', 'aria-label': 'Repeat PIN' });
  const status = $('p', { class: 'muted', style: 'font-size:12px;min-height:18px;' }, current ? 'A PIN protects this device when the app opens.' : 'Your PIN is stored as a one-way hash on this device. This protects casual access, not localStorage or DevTools.');
  const save = async () => {
    const value = pin.value.trim();
    if (!value && current) { close(); return; }
    if (!/^\d{4,6}$/.test(value)) { status.textContent = 'Use 4–6 digits.'; pin.focus(); return; }
    if (value !== confirm.value.trim()) { status.textContent = 'The PINs do not match.'; confirm.focus(); return; }
    try {
      if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable');
      const salt = globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
      const saved = setPrivacyPin(await hashPin(value, salt), salt);
      if (!saved) { status.textContent = 'Could not save the PIN on this device.'; return; }
      // Remove any legacy in-state fallback once the device-only credential is
      // definitely stored, so exports/sync cannot retain stale PIN material.
      if (state.settings?.pinHash) delete state.settings.pinHash;
      persist(); pinUnlocked = true; close(); toast('Privacy lock enabled.'); render();
    } catch (err) {
      status.textContent = 'PIN security is unavailable in this browser.';
    }
  };
  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;' }, $('h2', { class: 'serif', style: 'font-size:28px;font-style:italic;font-weight:400;' }, 'Privacy lock'), $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close')),
    $('p', { class: 'serif', style: 'font-style:italic;font-size:16px;' }, current ? 'Change or remove your PIN.' : 'Keep financial data private on shared devices.'),
    $('div', { style: 'display:flex;flex-direction:column;gap:12px;margin:20px 0;' }, pin, confirm),
    status,
    $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;' },
      current ? $('button', { type: 'button', class: 'btn btn-danger', onClick: () => {
        if (!clearPrivacyPin()) { toast('Could not remove the PIN from this device.'); return; }
        if (state.settings?.pinHash) delete state.settings.pinHash;
        persist();
        pinUnlocked = true;
        close();
        toast('Privacy lock removed.');
        render();
      } }, 'Remove PIN') : null,
      $('button', { type: 'button', class: 'btn btn-primary', onClick: save }, current ? 'Save PIN' : 'Enable PIN'),
    ),
  );
  queueMicrotask(() => pin.focus());
}

function persist() {
  // Track the last local edit before writing so conflict detection survives reloads.
  state.lastLocalChangeAt = new Date().toISOString();
  clearBalanceCaches();
  syncRevision++;
  saveState(state);
  scheduleSyncPush();
}

function isUsableCloudContent(content) {
  return !!content && typeof content === 'object' && !Array.isArray(content) && Array.isArray(content.entries);
}

// Device-only PIN fallback material must never leave this browser, even when
// localStorage is unavailable and the legacy hash is temporarily retained.
function cloudPayload() {
  const payload = JSON.parse(JSON.stringify(state));
  if (payload.settings && typeof payload.settings === 'object') delete payload.settings.pinHash;
  return payload;
}

function hasLocalDataToProtect() {
  const settings = state.settings || {};
  const checkpoints = settings.balanceCheckpoints || {};
  return state.entries.length > 0
    || !!state.localResetAt
    || Object.values(checkpoints).some(points => Array.isArray(points) && points.length > 0)
    || (Array.isArray(settings.recurring) && settings.recurring.length > 0)
    || (Array.isArray(settings.customCategories) && settings.customCategories.length > 0)
    || Object.values(settings.coins || {}).some(count => Number(count) > 0);
}

function confirmCloudReplacement() {
  return !hasLocalDataToProtect()
    || window.confirm('Pulling from the cloud will replace this device’s local data. Continue?');
}

function localIsFresherThanCloud(pullResult) {
  // A reset is a deletion tombstone. GitHub's Contents response does not
  // reliably include a commit timestamp, so never resurrect an older cloud
  // copy merely because that timestamp is unavailable.
  const localResetTime = state.localResetAt ? Date.parse(state.localResetAt) : NaN;
  if (Number.isFinite(localResetTime)) {
    const cloudResetTime = pullResult?.content?.localResetAt
      ? Date.parse(pullResult.content.localResetAt)
      : NaN;
    if (!Number.isFinite(cloudResetTime)) return true;
    if (localResetTime !== cloudResetTime) return localResetTime > cloudResetTime;
  }
  const localTime = state.lastLocalChangeAt ? Date.parse(state.lastLocalChangeAt) : NaN;
  const cloudTime = pullResult?.lastModifiedAt ? Date.parse(pullResult.lastModifiedAt) : NaN;
  return Number.isFinite(localTime) && Number.isFinite(cloudTime) && localTime > cloudTime;
}

// ---------- sync scheduler ----------
let pushTimer = null;
let syncInFlight = false;
// Manual pull/push operations are exclusive with automatic pushes. Revision
// checks alone cannot prevent an already-started push from writing after a pull.
let syncExclusive = false;
let syncRevision = 0;
function cancelScheduledSyncPush() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}
function scheduleSyncPush() {
  cancelScheduledSyncPush();
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  pushTimer = setTimeout(doAutoPush, 1500);
}

let sessionSyncFailed = false;
async function doAutoPush() {
  pushTimer = null;
  if (syncInFlight || syncExclusive) { scheduleSyncPush(); return; }
  syncInFlight = true;
  const revision = syncRevision;
  try {
    // Keep every operation that can throw inside the guarded region so a
    // serialization/UI failure cannot leave automatic sync permanently locked.
    const payload = cloudPayload();
    const s = getSyncSettings();
    setSyncPulsing(true);
    let r = await syncPush(payload, { sha: s.lastSha, message: 'cents: auto push' });
    // Do not pull a fresh SHA and retry the old payload: that would silently
    // overwrite changes made on another device. A later local edit will queue
    // another attempt, while a manual Push can surface a real conflict.
    if (revision !== syncRevision) {
      // A newer local mutation happened while this request was in flight. The
      // old payload may be on the server, so retain its SHA as the parent for
      // the queued push, but never mark the newer state as synced.
      if (r.ok) patchSyncSettings({ lastSha: r.sha });
      scheduleSyncPush();
      return;
    }
    if (r.ok) {
      patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
      if (sessionSyncFailed) {
        toast('✨ Cloud sync recovered.');
        sessionSyncFailed = false;
      }
    } else {
      patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
      if (!sessionSyncFailed && r.reason !== 'conflict') {
        toast('☠ Cloud sync failed: ' + (r.message || r.reason || 'error') + '. Changes saved locally.');
        sessionSyncFailed = true;
      }
    }
    notifySyncChange();
  } catch (error) {
    const message = error?.message || 'sync failed';
    patchSyncSettings({ lastError: message, lastErrorAt: new Date().toISOString() });
    if (!sessionSyncFailed) {
      toast('☠ Cloud sync failed: ' + message + '. Changes saved locally.');
      sessionSyncFailed = true;
    }
    notifySyncChange();
  } finally {
    setSyncPulsing(false);
    syncInFlight = false;
  }
}

async function initSync() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  if (syncInFlight || syncExclusive) {
    scheduleSyncPush();
    return;
  }
  syncExclusive = true;
  const pullRevision = syncRevision;
  let r;
  try {
    r = await syncPull();
  if (r.ok && isUsableCloudContent(r.content)) {
    const incomingCount = r.content.entries.length;
    const localCount = state.entries.length;
    const localEditedAt = state.lastLocalChangeAt ? Date.parse(state.lastLocalChangeAt) : null;
    const cloudEditedAt = r.lastModifiedAt ? Date.parse(r.lastModifiedAt) : null;
    // lastLocalChangeAt lives at the top of `state` (load-bearing — see persist()).
    const localIsFresher = localIsFresherThanCloud(r);

    if (localIsFresher) {
      // Cloud is stale — keep the user's local edits and push them up instead of clobbering.
      // The cloud SHA is the correct parent for the queued push, but the
      // local copy is not synced until that push succeeds.
      patchSyncSettings({ lastSha: r.sha, lastError: null, lastErrorAt: null });
      toast('Cloud is older than your local copy — pushing your changes.');
      scheduleSyncPush();
      notifySyncChange();
      return;
    }
    // A known SHA means this device already has this exact cloud revision.
    // Otherwise, never replace local entries/settings silently during boot.
    const cloudRevisionKnown = typeof r.sha === 'string' && r.sha.length > 0;
    if ((!cloudRevisionKnown || getSyncSettings().lastSha !== r.sha) && hasLocalDataToProtect() && !confirmCloudReplacement()) {
      // Do not record the rejected cloud SHA: doing so would make a later boot
      // treat the still-unmerged local copy as already reconciled.
      notifySyncChange();
      return;
    }

    if (pullRevision !== syncRevision) {
      toast('A newer local change was kept; cloud pull skipped.');
      notifySyncChange();
      return;
    }
    syncRevision++;
    state = validateState(r.content);
    clearBalanceCaches();
    saveState(state);
    updateAllowedCategories(allCategories().map(c => c.id));
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
  } else if (r.ok && !r.content) {
    // An absent cloud file is not an authoritative empty dataset. Keep local
    // data untouched and let the normal push create the first cloud revision.
    patchSyncSettings({ lastError: null, lastErrorAt: null });
    if (hasLocalDataToProtect()) {
      toast('Cloud file is empty — local data was kept and will be pushed.');
      scheduleSyncPush();
    } else {
      toast('Cloud file is empty — nothing to pull.');
    }
    notifySyncChange();
  } else if (r.ok) {
    patchSyncSettings({ lastError: 'malformed cloud data', lastErrorAt: new Date().toISOString() });
    toast('Cloud data is malformed — local data was kept.');
  } else {
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
  }
  notifySyncChange();
  } finally {
    syncExclusive = false;
  }
}

/** Set sync dot to pulsing while a push/pull is in flight. */
let _syncActive = false;
let _syncPulseId = 0;
function setSyncPulsing(active) {
  _syncActive = active;
  const icon = document.querySelector('.sync-icon');
  if (icon) {
    icon.classList.toggle('spinning', active);
    if (!active) {
      icon.classList.add('success');
      const pulseId = ++_syncPulseId;
      setTimeout(() => { if (pulseId === _syncPulseId) icon.classList.remove('success'); }, 2000);
    }
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
const METHOD_BY_ID = new Map(METHODS.map(method => [method.id, method]));
let categoryCacheState = null;
let categoryCacheCustoms = null;
let categoryCacheLength = -1;
let categoryCache = [];

function methodShort(id) {
  const method = METHOD_BY_ID.get(id);
  if (!method) return id;
  return method.label.includes(' · ') ? method.label.split(' · ')[1] : method.label;
}
function methodLabel(id) {
  return METHOD_BY_ID.get(id)?.label || id;
}

/** Merge built-in categories with user-added custom ones. */
function allCategories() {
  const customs = state.settings.customCategories || [];
  if (categoryCacheState === state && categoryCacheCustoms === customs && categoryCacheLength === customs.length) return categoryCache;
  categoryCacheState = state;
  categoryCacheCustoms = customs;
  categoryCacheLength = customs.length;
  categoryCache = [...CATEGORIES, ...customs];
  return categoryCache;
}
function categoryLabel(id) {
  return allCategories().find(category => category.id === id)?.label || id;
}

const ACCOUNT_METHOD_IDS = ['AIB', 'Revolut', 'RS'];
const GIFT_CARD_IDS = ['TG', 'LG', 'AG'];
const MAX_BALANCE = 1_000_000;
let balanceCheckpointCacheState = null;
let balanceCheckpointCache = null;
let balanceAtCacheState = null;
const balanceAtCache = new Map();

function clearBalanceCaches() {
  balanceCheckpointCacheState = null;
  balanceCheckpointCache = null;
  balanceAtCacheState = null;
  balanceAtCache.clear();
  categoryCacheState = null;
  categoryCacheCustoms = null;
  categoryCacheLength = -1;
  categoryCache = [];
}

function getBalanceCheckpoints() {
  if (balanceCheckpointCacheState === state && balanceCheckpointCache) return balanceCheckpointCache;
  const configured = state.settings.balanceCheckpoints || {};
  balanceCheckpointCache = Object.fromEntries(BALANCE_METHOD_IDS.map(id => [id, Array.isArray(configured[id]) ? configured[id] : []]));
  balanceCheckpointCacheState = state;
  return balanceCheckpointCache;
}
const EMPTY_BALANCE_CHECKPOINTS = Object.fromEntries(BALANCE_METHOD_IDS.map(id => [id, []]));
function checkpointsForEntries(entries, checkpointsByMethod) {
  return checkpointsByMethod || (entries === state.entries ? getBalanceCheckpoints() : EMPTY_BALANCE_CHECKPOINTS);
}
function checkpointFor(methodId, targetDate = today(), checkpointsByMethod = null) {
  const checkpoints = (checkpointsByMethod || EMPTY_BALANCE_CHECKPOINTS)[methodId];
  if (!Array.isArray(checkpoints)) return null;
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    if (checkpoints[index].date <= targetDate) return checkpoints[index];
  }
  return null;
}
function entryMutationTime(entry) {
  if (!entry) return NaN;
  const updated = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN;
  if (Number.isFinite(updated)) return updated;
  return entry.createdAt ? Date.parse(entry.createdAt) : NaN;
}
function entryVersionAt(entry, timestamp) {
  if (!entry || !Number.isFinite(timestamp)) return entry;
  // validateState() preserves only strictly chronological mutation history, so
  // avoid allocating and sorting this array during every balance calculation.
  const history = Array.isArray(entry.mutationHistory) ? entry.mutationHistory : [];
  const nextMutation = history.find(point => Date.parse(point.at) > timestamp);
  return nextMutation ? { ...nextMutation, createdAt: nextMutation.createdAt || entry.createdAt } : entry;
}
function versionIncludedAtCheckpoint(version, checkpointDate, checkpointTime) {
  if (!version || version.date > checkpointDate) return false;
  if (version.date < checkpointDate) return true;
  const createdTime = version.createdAt ? Date.parse(version.createdAt) : NaN;
  return !Number.isFinite(checkpointTime) || !Number.isFinite(createdTime) || createdTime <= checkpointTime;}

function entryDeltaAfterCheckpoint(entry, methodId, targetDate, checkpoint) {
  // The only caller (balanceAtForEntries) always passes a checkpoint, but guard
  // defensively so future callers get a reasonable fallback.
  if (!entry) return 0;
  if (!checkpoint) return entry.date <= targetDate ? balanceDelta(entry, methodId) : 0;
  const checkpointTime = checkpoint.at
    ? Date.parse(checkpoint.at)
    : Date.parse(`${checkpoint.date}T23:59:59.999Z`);
  const historical = entryVersionAt(entry, checkpointTime);
  const mutationTime = entryMutationTime(entry);
  const historicalCreated = historical?.createdAt ? Date.parse(historical.createdAt) : NaN;
  // Entries dated after the checkpoint are new activity. Entries already in
  // the checkpoint are neutral unless they were mutated afterwards; in that
  // case apply only the net current-vs-historical effect. This also handles
  // edits that move a transaction to another date, account, or type.
  const changedAfterCheckpoint = Number.isFinite(mutationTime) && mutationTime > checkpointTime;
  const oldEffect = changedAfterCheckpoint
    && Number.isFinite(historicalCreated) && historicalCreated <= checkpointTime
    && versionIncludedAtCheckpoint(historical, checkpoint.date, checkpointTime)
    ? balanceDelta(historical, methodId) : 0;
  const currentEffect = entry.date <= targetDate
    && (entry.date > checkpoint.date || changedAfterCheckpoint)
    ? balanceDelta(entry, methodId) : 0;
  return currentEffect - oldEffect;
}
function balanceDelta(entry, methodId) {
  if (!entry || entry.type === 'note' || entry.method !== methodId) return 0;
  if (GIFT_CARD_IDS.includes(methodId)) {
    if (entry.type === 'credit' || entry.category === 'GC') return entry.amount;
    return -entry.amount;
  }
  return entry.type === 'credit' ? entry.amount : -entry.amount;
}
function supportingTotalsDelta(entry, methodId, targetDate, checkpoint) {
  if (!entry || entry.type === 'note' || !checkpoint) return { loaded: 0, spent: 0 };
  const checkpointTime = checkpoint.at
    ? Date.parse(checkpoint.at)
    : Date.parse(`${checkpoint.date}T23:59:59.999Z`);
  const historical = entryVersionAt(entry, checkpointTime);
  const mutationTime = entryMutationTime(entry);
  const historicalCreated = historical?.createdAt ? Date.parse(historical.createdAt) : NaN;
  const changedAfterCheckpoint = Number.isFinite(mutationTime) && mutationTime > checkpointTime;
  const oldIncluded = changedAfterCheckpoint
    && Number.isFinite(historicalCreated) && historicalCreated <= checkpointTime
    && versionIncludedAtCheckpoint(historical, checkpoint.date, checkpointTime);
  const currentIncluded = entry.date <= targetDate
    && (entry.date > checkpoint.date || changedAfterCheckpoint);
  const totals = { loaded: 0, spent: 0 };
  const add = (version, sign) => {
    if (!version || version.method !== methodId) return;
    const amount = Number(version.amount) || 0;
    if (version.type === 'credit' || version.category === 'GC') totals.loaded += sign * amount;
    else if (version.type === 'expense') totals.spent += sign * amount;
  };
  if (oldIncluded) add(historical, -1);
  if (currentIncluded) add(entry, 1);
  return totals;
}
function balanceAtForEntries(entries, methodId, targetDate = today(), checkpointsByMethod = null) {
  const checkpoints = checkpointsForEntries(entries, checkpointsByMethod);
  const cacheable = entries === state.entries && checkpoints === getBalanceCheckpoints();
  const cacheKey = `${methodId}|${targetDate}`;
  if (cacheable) {
    if (balanceAtCacheState !== state) {
      balanceAtCache.clear();
      balanceAtCacheState = state;
    } else if (balanceAtCache.has(cacheKey)) {
      return balanceAtCache.get(cacheKey);
    }
  }
  const checkpoint = checkpointFor(methodId, targetDate, checkpoints);
  const startBalance = checkpoint?.balance || 0;
  // A dated checkpoint is authoritative for the balance at the moment it was
  // saved. Transactions on that same date that were created/edited afterwards
  // still apply, so reconciling today never hides a later same-day expense.
  const balance = entries.reduce((total, entry) => {
    if (!checkpoint) return total + (entry.date <= targetDate ? balanceDelta(entry, methodId) : 0);
    return total + entryDeltaAfterCheckpoint(entry, methodId, targetDate, checkpoint);
  }, startBalance);
  if (cacheable) balanceAtCache.set(cacheKey, balance);
  return balance;
}
/** Balance at the end of a date, using the latest end-of-day checkpoint. */
function balanceAt(methodId, targetDate = today()) {
  return balanceAtForEntries(state.entries, methodId, targetDate);
}
/** Book balance from the original baseline, intentionally ignoring later
 * reconciliations. This is used to explain the reconciliation variance and to
 * prefill a new checkpoint without making checkpoints depend on one another. */
function bookBalanceAt(methodId, targetDate = today(), entries = state.entries, checkpointsByMethod = null) {
  const checkpoints = checkpointsForEntries(entries, checkpointsByMethod);
  const baseline = checkpoints[methodId]
    ?.find(point => point.date === '1970-01-01')?.balance || 0;
  return entries
    .filter(entry => entry.date <= targetDate)
    .reduce((balance, entry) => balance + balanceDelta(entry, methodId), baseline);
}
function userCheckpointFor(methodId, targetDate = today()) {
  const checkpoints = getBalanceCheckpoints()[methodId];
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    const point = checkpoints[index];
    if (point.date === '1970-01-01') break;
    if (point.date <= targetDate) return point;
  }
  return null;
}
function saveBalanceCheckpoint(methodId, date, balance) {
  if (!BALANCE_METHOD_IDS.includes(methodId) || !isValidCheckpointDate(date) || date > today() || !Number.isFinite(+balance) || Math.abs(+balance) > MAX_BALANCE) return false;
  if (!state.settings.balanceCheckpoints) state.settings.balanceCheckpoints = {};
  const existing = Array.isArray(state.settings.balanceCheckpoints[methodId])
    ? state.settings.balanceCheckpoints[methodId]
    : [];
  state.settings.balanceCheckpoints[methodId] = [
    ...existing.filter(point => point.date !== date),
    { date, at: nowIso(), balance: Math.round(balance * 100) / 100 },
  ].sort((a, b) => a.date.localeCompare(b.date));
  // New edits are stored as dated reconciliation checkpoints.
  persist();
  return true;
}
function removeBalanceCheckpoint(methodId, date) {
  if (!BALANCE_METHOD_IDS.includes(methodId) || date === '1970-01-01') return false;
  const existing = state.settings.balanceCheckpoints?.[methodId];
  if (!Array.isArray(existing) || !existing.some(point => point.date === date)) return false;
  state.settings.balanceCheckpoints[methodId] = existing.filter(point => point.date !== date);
  persist();
  return true;
}
function totalAccountBalanceAt(date = today(), checkpointsByMethod = null) {
  const entries = state.entries;
  const checkpoints = checkpointsForEntries(entries, checkpointsByMethod);
  return ACCOUNT_METHOD_IDS.reduce((sum, id) => sum + balanceAtForEntries(entries, id, date, checkpoints), 0);
}

function renderBalanceEditorRow(methodId, { label = methodShort(methodId), secondary = '', editable = false } = {}) {
  const row = $('div', { class: 'balance-editor-row', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-bottom:1px solid var(--line);font-size:13px;' });
  let editing = false;
  const actualBalance = () => balanceAt(methodId, today());
  const reconciliationSummary = () => {
    const point = userCheckpointFor(methodId, today());
    if (!point) return null;
    const book = bookBalanceAt(methodId, point.date);
    return { point, difference: point.balance - book };
  };
  const draw = () => {
    row.innerHTML = '';
    if (editing) {
      const amount = $('input', { type: 'text', inputmode: 'decimal', value: actualBalance().toFixed(2), 'aria-label': `${label} actual balance`, autocomplete: 'off', style: `width:${isNarrow() ? '86px' : '104px'};padding:6px 8px;border:1px solid var(--accent);border-radius:var(--radius);text-align:right;font-size:12px;` });
      const date = $('input', { type: 'date', value: today(), max: today(), 'aria-label': `${label} reconciliation date`, style: `width:${isNarrow() ? '124px' : '138px'};padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);font-size:12px;` });
      const refreshAmountForDate = () => {
        const existing = userCheckpointFor(methodId, date.value);
        amount.value = (existing?.date === date.value ? existing.balance : bookBalanceAt(methodId, date.value)).toFixed(2);
      };
      date.addEventListener('change', refreshAmountForDate);
      const save = () => {
        const rawAmount = String(amount.value || '').trim();
        const next = rawAmount.startsWith('-') ? -parseAmount(rawAmount.slice(1)) : parseAmount(rawAmount);
        if (!Number.isFinite(next) || next < -1000000 || next > 1000000) { toast('Enter a valid actual balance.'); amount.focus(); return; }
        if (!isValidCheckpointDate(date.value) || date.value > today()) { toast('Choose today or an earlier reconciliation date.'); date.focus(); return; }
        if (!saveBalanceCheckpoint(methodId, date.value, next)) { toast('Could not save that reconciliation.'); return; }
        editing = false;
        toast(`${label} reconciled at ${fmt(next)}.`);
        render();
      };
      amount.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { editing = false; draw(); } });
      date.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { editing = false; draw(); } });
      row.append(
        $('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex:1;' },
          $('span', { style: 'font-weight:500;white-space:nowrap;' }, label),
          secondary ? $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;' }, secondary) : null,
        ),
        $('div', { class: 'balance-editor-controls balance-editor-edit-controls', style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0;' },
          $('span', { class: 'muted balance-editor-help', style: 'font-size:10px;' }, 'amount is authoritative when saved; later same-day edits and entries are applied'),
          amount, date,
          $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:5px 9px;font-size:11px;', onClick: save }, 'Save'),
          $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:5px 8px;font-size:11px;', onClick: () => { editing = false; draw(); } }, 'Cancel'),
        ),
      );
      queueMicrotask(() => amount.focus());
      return;
    }
    const balance = actualBalance();
    const summary = reconciliationSummary();
    const difference = summary?.difference || 0;
    row.append(
      $('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0;flex:1;' },
        $('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${balance >= 0 ? 'var(--positive)' : 'var(--negative)'};flex-shrink:0;` }),
        $('span', { style: 'font-weight:500;white-space:nowrap;' }, label),
        secondary ? $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;' }, secondary) : null,
        summary ? $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;' }, `reconciled ${friendlyDate(summary.point.date)}`) : null,
      ),
      $('div', { class: 'balance-editor-controls', style: 'display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:0;' },
        $('div', { style: 'text-align:right;' },
          $('div', { class: 'display-num', style: `font-size:14px;color:${balance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(balance)),
          summary && Math.abs(difference) >= 0.01 ? $('div', { class: 'muted', style: 'font-size:10px;' }, `${difference >= 0 ? '+' : ''}${fmt(difference)} vs book`) : null,
        ),
        editable ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;padding:3px 5px;', onClick: () => { editing = true; draw(); }, 'aria-label': `Reconcile ${label}` }, '✎') : null,
        editable && summary ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:10px;padding:3px 5px;color:var(--negative);', onClick: () => {
          if (!window.confirm(`Remove the ${label} reconciliation from ${friendlyDate(summary.point.date)}?`)) return;
          if (removeBalanceCheckpoint(methodId, summary.point.date)) {
            toast(`${label} reconciliation removed.`);
            render();
          }
        }, 'aria-label': `Remove ${label} reconciliation` }, 'Clear') : null,
      ),
    );
  };
  draw();
  return row;
}

const fmt = (n) => {
  if (!Number.isFinite(n)) return '€0.00';
  const sign = n < 0 ? '−' : '';
  return `${sign}€${Math.abs(n).toFixed(2)}`;
};
const monthKey = (date) => date.slice(0, 7);
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const FRIENDLY_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return MONTH_FORMATTER.format(new Date(Date.UTC(y, m - 1, 1)));
};
const friendlyDate = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  return FRIENDLY_DATE_FORMATTER.format(new Date(iso + 'T00:00:00Z'));
};

function entriesForMonth(key) {
  return state.entries.filter(e => monthKey(e.date) === key);
}
/** Aggregate spending-entry amounts by category. */
function catTotalsForEntries(entries) {
  const totals = {};
  for (const e of entries) {
    if (!isSpendingEntry(e)) continue;
    totals[e.category] = (totals[e.category] || 0) + e.amount;
  }
  return totals;
}
function isSpendingEntry(entry) {
  return entry.type === 'expense' && !entry.transferId;
}
function isIncomeEntry(entry) {
  return entry.type === 'credit' && !entry.transferId;
}
function totalForMonth(key) {
  return entriesForMonth(key).reduce((s, e) => s + (isSpendingEntry(e) ? e.amount : isIncomeEntry(e) ? -e.amount : 0), 0);
}
function parseAmount(raw) {
  if (raw == null) return NaN;
  let text = String(raw).trim().replace(/[€$£\s]/g, '');
  if (!text || !/^\d[\d.,]*$/.test(text)) return NaN;
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const integer = text.slice(0, decimalIndex).replace(/[.,]/g, '');
    const decimal = text.slice(decimalIndex + 1);
    text = `${integer}.${decimal}`;
  } else if (comma >= 0) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) text = parts.join('');
    else text = `${parts.slice(0, -1).join('')}.${parts.at(-1)}`;
  } else if (text.split('.').length - 1 > 1) {
    const parts = text.split('.');
    text = `${parts.slice(0, -1).join('')}.${parts.at(-1)}`;
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return NaN;
  const v = Number(text);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}

function thursdaysInMonth(year, month) {
  const dates = [];
  const d = new Date(Date.UTC(year, month, 1));
  // Find first Thursday (getUTCDay() 4 = Thursday) using date-only UTC math.
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCMonth() === month) {
    dates.push(utcDateKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return dates;
}

/** Historical-safe bank balance calculations use reconciliation checkpoints.
 *  All return values (balance and points) use the same end-of-day
 *  checkpoint-aware actuals so the dashboard sparkline, headline balance,
 *  and History transaction rows are always consistent. */
function computeBalance(asOfDate = today(), checkpointsByMethod = null) {
  const entries = state.entries;
  const sorted = [...entries]
    .filter(e => e.date <= asOfDate && ACCOUNT_METHOD_IDS.includes(e.method))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
  const points = [];
  const dateCache = {};
  for (const e of sorted) {
    if (points.at(-1)?.date === e.date) continue;
    const reconciled = dateCache[e.date] ?? (dateCache[e.date] = totalAccountBalanceAt(e.date, checkpointsByMethod));
    points.push({ date: e.date, balance: reconciled });
  }
  return { balance: totalAccountBalanceAt(asOfDate, checkpointsByMethod), points };
}

/** Running balance immediately after an entry, respecting dated checkpoints.
 * A row before a checkpoint on the same day is intentionally shown at the
 * reconciled checkpoint amount because the checkpoint is the authoritative
 * record for that date. Entries created after the checkpoint are applied in
 * timestamp/id order. */
function balanceForEntry(entry, entries = state.entries, checkpointsByMethod = null) {
  if (!entry || !BALANCE_METHOD_IDS.includes(entry.method)) return 0;
  const checkpoints = checkpointsForEntries(entries, checkpointsByMethod);
  const checkpoint = checkpointFor(entry.method, entry.date, checkpoints);
  const baseline = checkpoints[entry.method]?.find(point => point.date === '1970-01-01');
  const checkpointTime = checkpoint
    ? (checkpoint.at ? Date.parse(checkpoint.at) : Date.parse(`${checkpoint.date}T23:59:59.999Z`))
    : NaN;
  // Once a checkpoint exists on the entry's date, use that authoritative
  // end-of-day balance for every row on that date. Pre-checkpoint rows are
  // intentionally anchored to the checkpoint; only later same-day activity is
  // added as the row order advances.
  const useBookBalance = !checkpoint || checkpoint.date > entry.date;
  const ordered = [...entries].sort((a, b) => a.date.localeCompare(b.date)
    || ((a.createdAt || '')).localeCompare(b.createdAt || '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const targetIndex = ordered.findIndex(candidate => candidate.id === entry.id);
  if (targetIndex < 0) return 0;
  let balance = useBookBalance ? (baseline?.balance || 0) : checkpoint.balance;
  for (let index = 0; index < ordered.length; index++) {
    const candidate = ordered[index];
    if (useBookBalance) {
      if (index <= targetIndex) balance += balanceDelta(candidate, entry.method);
      continue;
    }
    const mutationTime = entryMutationTime(candidate);
    const changedAfterCheckpoint = Number.isFinite(mutationTime) && mutationTime > checkpointTime;
    const historical = entryVersionAt(candidate, checkpointTime);
    const historicalCreated = historical?.createdAt ? Date.parse(historical.createdAt) : NaN;
    const oldIncluded = changedAfterCheckpoint
      && Number.isFinite(historicalCreated) && historicalCreated <= checkpointTime
      && versionIncludedAtCheckpoint(historical, checkpoint.date, checkpointTime);
    // A historical effect must be removed even when the current row moved to a
    // later date, so inspect every entry. Current activity is capped at this row.
    const currentIncluded = index <= targetIndex
      && candidate.date <= entry.date
      && (candidate.date > checkpoint.date || changedAfterCheckpoint);
    if (currentIncluded) balance += balanceDelta(candidate, entry.method);
    if (oldIncluded) balance -= balanceDelta(historical, entry.method);
  }
  return balance;
}

/** Gift card balance: loading adds, spending subtracts, with reconciliation checkpoints. */
function computeGiftCardBalance(entries, methodId, asOfDate = today()) {
  const checkpoints = checkpointsForEntries(entries);
  const balance = balanceAtForEntries(entries, methodId, asOfDate, checkpoints);
  const checkpoint = checkpointFor(methodId, asOfDate, checkpoints);
  // Checkpoints imported from older builds have no `at`; treat those as
  // end-of-day checkpoints rather than silently dropping same-day history.
  let loaded = 0;
  let spent = 0;
  if (!checkpoint) {
    for (const entry of entries) {
      if (entry.method !== methodId || entry.date > asOfDate || entry.type === 'note') continue;
      if (entry.type === 'credit' || entry.category === 'GC') loaded += entry.amount;
      else if (entry.type === 'expense') spent += entry.amount;
    }
  } else {
    for (const entry of entries) {
      const delta = supportingTotalsDelta(entry, methodId, asOfDate, checkpoint);
      loaded += delta.loaded;
      spent += delta.spent;
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
function utcDateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function daysInMonthParts(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
function advanceRecurringDate(current, freq, dayOfMonth) {
  const [year, month, day] = current.split('-').map(Number);
  if (freq === 'weekly') {
    const d = new Date(Date.UTC(year, month - 1, day + 7));
    return utcDateKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (freq === 'monthly') {
    // 1-based month (e.g. 8 for August), advance by one.
    const rawMonth = month + 1;
    const nextYear = year + Math.floor(rawMonth / 12);
    const normalizedMonth = rawMonth % 12;
    return utcDateKey(nextYear, normalizedMonth, Math.min(Number(dayOfMonth) || day, daysInMonthParts(nextYear, normalizedMonth)));
  }
  return current;
}

function computeInitialNextDate(freq, dayOfMonth) {
  const now = new Date();
  const requestedDay = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
  if (freq === 'monthly') {
    let year = now.getFullYear(), month = now.getMonth();
    let day = Math.min(requestedDay, daysInMonthParts(year, month));
    if (new Date(year, month, day) <= now) {
      month += 1;
      year += Math.floor(month / 12);
      month %= 12;
      day = Math.min(requestedDay, daysInMonthParts(year, month));
    }
    return utcDateKey(year, month, day);
  }
  let candidate = new Date(now.getFullYear(), now.getMonth(), Math.min(requestedDay, daysInMonthParts(now.getFullYear(), now.getMonth())));
  candidate.setHours(0, 0, 0, 0);
  while (candidate <= now) candidate.setDate(candidate.getDate() + 7);
  return localDateKey(candidate);
}

function paidRecurring(rec) {
  const entry = {
    id: uid(), createdAt: nowIso(), date: rec.nextDate, type: rec.type,
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
    state.entries.push({ id: eid, createdAt: nowIso(), date: dateStr, type: 'credit', category: 'misc', details: 'Tesco pay', amount: defaultAmt, method: 'TG', note: '' });
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
      state.entries.push({ id: uid(), createdAt: nowIso(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: defaultAmt, method: 'TG', note: '' });
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
        state.entries.push({ id: uid(), createdAt: nowIso(), date: data.date, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: 'TG', note: '' });
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        toast(`Filled Tesco pay for ${friendlyDate(data.date)} — ${fmt(amt)}`);
      } else {
        for (const d of unpaidThursdays) {
          state.entries.push({ id: uid(), createdAt: nowIso(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: 'TG', note: '' });
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
  _lastAction = { undo: undoFn, label };
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
let _lastConfettiMonth = null;
function triggerConfetti() {
  const currentMonth = monthKey(today());
  if (_lastConfettiMonth === currentMonth) return;
  _lastConfettiMonth = currentMonth;
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

function previousMonthKey(key) {
  const [year, month] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function payeeHistory() {
  return [...new Set(state.entries.map(e => (e.details || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function parseNaturalLanguage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const amountMatch = raw.match(/(?:€|eur|euro)?\s*(\d+(?:[.,]\d{1,2})?)/i);
  const amount = amountMatch ? parseAmount(amountMatch[1]) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Include an amount, for example €18.50.' };

  const lower = raw.toLowerCase();
  let date = today();
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() - 1); date = localDateKey(d);
  }
  let method = 'AIB';
  if (/\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+(?:account|pot|fund)\b/.test(lower)) method = 'RS';
  else if (/\brevolut\b/.test(lower)) method = 'Revolut';
  else if (/\btesco\b/.test(lower)) method = 'TG';
  else if (/\blidl\b/.test(lower)) method = 'LG';
  else if (/\baldi\b/.test(lower)) method = 'AG';
  const isCredit = /\b(income|received|salary|pay|paid into|got)\b/.test(lower);
  const cleaned = raw
    .replace(/(?:€|eur|euro)?\s*\d+(?:[.,]\d{1,2})?/i, '')
    .replace(/\b(from|on|using|via)\s+(aib|revolut(?: savings)?|rs|tesco|lidl|aldi)\b/ig, '')
    .replace(/\b(yesterday|today)\b/ig, '')
    .replace(/\b(income|received|salary|paid into|got|spent|expense)\b/ig, '')
    .replace(/\s+/g, ' ').trim();
  const details = cleaned
    .replace(/\b(at|from|on|using|via)\s*$/i, '')
    .replace(/^\s*(at|from|on|using|via)\s+/i, '')
    .replace(/^[,.: -]+|[,.: -]+$/g, '').trim() || 'Entry';
  const guessed = parseReceiptLine(details);
  return { date, type: isCredit ? 'credit' : 'expense', amount, details, category: isCredit ? 'misc' : guessed.category, method };
}

function duplicateGroups(entries = state.entries) {
  const groups = new Map();
  const transferGroups = new Map();
  const consumed = new Set();
  for (const entry of entries) {
    if (!entry.transferId) continue;
    if (!transferGroups.has(entry.transferId)) transferGroups.set(entry.transferId, []);
    transferGroups.get(entry.transferId).push(entry);
  }
  // Treat a complete transfer pair as one logical transaction. Keep one
  // representative per pair so deleting a reported duplicate removes the pair,
  // not just one leg.
  for (const pair of transferGroups.values()) {
    if (pair.length !== 2) continue;
    const debit = pair.find(entry => entry.type === 'expense');
    const credit = pair.find(entry => entry.type === 'credit');
    if (!debit || !credit || debit.amount !== credit.amount || debit.date !== credit.date) continue;
    const methods = [debit.method, credit.method].sort().join('>');
    const key = `transfer|${debit.date}|${debit.amount}|${(debit.details || '').trim().toLowerCase()}|${methods}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(debit);
    pair.forEach(entry => consumed.add(entry.id));
  }
  for (const e of entries) {
    if (consumed.has(e.id) || e.type === 'note') continue;
    const key = `${e.date}|${e.amount}|${(e.details || '').trim().toLowerCase()}|${e.type}|${e.method}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.values()].filter(group => group.length > 1)
    .sort((a, b) => b[0].date.localeCompare(a[0].date));
}

function accountBalanceHistory() {
  const methods = METHODS.filter(m => ACCOUNT_METHOD_IDS.includes(m.id));
  const monthKeys = [...new Set([
    ...state.entries.map(e => monthKey(e.date)),
    ...methods.flatMap(m => getBalanceCheckpoints()[m.id]
      .filter(point => point.date !== '1970-01-01')
      .map(point => monthKey(point.date))),
  ])];
  const current = monthKey(today());
  if (!monthKeys.includes(current)) monthKeys.push(current);
  monthKeys.sort((a, b) => a.localeCompare(b));
  if (!monthKeys.length) return { methods, points: [] };
  const points = monthKeys.map(key => {
    const monthEnd = `${key}-${String(daysInMonth(key)).padStart(2, '0')}`;
    return {
      key,
      balances: Object.fromEntries(methods.map(method => [method.id, balanceAt(method.id, monthEnd)])),
    };
  });
  return { methods, points };
}

function spendingForecast(key = monthKey(today())) {
  const now = new Date();
  const current = entriesForMonth(key);
  const expenses = current.filter(isSpendingEntry);
  const spent = expenses.reduce((sum, e) => sum + e.amount, 0);
  const elapsed = key === monthKey(today()) ? now.getDate() : daysInMonth(key);
  const totalDays = daysInMonth(key);
  const dailyAverage = elapsed > 0 ? spent / elapsed : 0;
  const projected = spent + dailyAverage * Math.max(0, totalDays - elapsed);
  const budget = +state.settings.monthlyBudget || 0;
  const previous = entriesForMonth(previousMonthKey(key)).filter(isSpendingEntry);
  const previousDaily = previous.length ? previous.reduce((sum, e) => sum + e.amount, 0) / daysInMonth(previousMonthKey(key)) : null;
  return { spent, projected, budget, remaining: budget - projected, dailyAverage, previousDaily, elapsed, totalDays };
}

function relativeDayLabel(iso) {
  if (iso === today()) return 'Today';
  const d = new Date();
  d.setDate(d.getDate() - 1);
  if (iso === localDateKey(d)) return 'Yesterday';
  return friendlyDate(iso);
}

function accountStatus(methodId) {
  const checkpoint = userCheckpointFor(methodId, today());
  if (!checkpoint) return { label: 'Not reconciled' };
  const ageDays = Math.max(0, Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${checkpoint.date}T00:00:00Z`)) / 86400000));
  if (ageDays === 0) return { label: 'Reconciled today' };
  if (ageDays <= 7) return { label: `Reconciled ${ageDays}d ago` };
  return { label: 'Reconcile soon' };
}

function monthComparison(key = monthKey(today())) {
  const current = entriesForMonth(key).filter(isSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const previousKey = previousMonthKey(key);
  const previous = entriesForMonth(previousKey).filter(isSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const difference = current - previous;
  const percent = previous > 0 ? Math.round((difference / previous) * 100) : null;
  return { current, previous, previousKey, difference, percent };
}

function checkpointCoversVersion(version, checkpoint) {
  if (!version || !checkpoint || checkpoint.date === '1970-01-01') return false;
  const versionTime = version.createdAt ? Date.parse(version.createdAt) : NaN;
  const checkpointTime = checkpoint.at
    ? Date.parse(checkpoint.at)
    : Date.parse(`${checkpoint.date}T23:59:59.999Z`);
  // A transaction backdated after reconciliation was not part of that
  // checkpoint, even if its transaction date is earlier than the checkpoint.
  if (Number.isFinite(versionTime) && Number.isFinite(checkpointTime) && versionTime > checkpointTime) return false;
  if (version.date < checkpoint.date) return true;
  if (version.date > checkpoint.date) return false;
  return !Number.isFinite(versionTime) || !Number.isFinite(checkpointTime) || versionTime <= checkpointTime;
}
function reconciliationProtectionFor(entry) {
  if (!entry) return null;
  const checkpoints = getBalanceCheckpoints();
  // Evaluate the version that was active when each checkpoint was saved. A
  // later edit may move the current row to another date/account; checking the
  // current row directly would over-block a deletion that is otherwise safe.
  for (const methodId of BALANCE_METHOD_IDS) {
    for (const point of checkpoints[methodId] || []) {
      if (point.date === '1970-01-01') continue;
      const checkpointTime = point.at
        ? Date.parse(point.at)
        : Date.parse(`${point.date}T23:59:59.999Z`);
      const historical = entryVersionAt(entry, checkpointTime);
      if (historical?.method === methodId && checkpointCoversVersion(historical, point)) {
        return { methodId, point };
      }
    }
  }
  return null;
}
function deletionEntriesFor(id) {
  const target = state.entries.find(e => e.id === id);
  if (!target) return [];
  return target.transferId
    ? state.entries.filter(entry => entry.transferId === target.transferId)
    : [target];
}
function deleteEntryOrTransfer(id) {
  const target = state.entries.find(e => e.id === id);
  if (!target) return false;
  const removed = deletionEntriesFor(id);
  const protection = removed.map(reconciliationProtectionFor).find(Boolean);
  if (protection) {
    toast(`Deletion blocked: ${methodShort(protection.methodId)} is reconciled through ${friendlyDate(protection.point.date)}. Remove or revise that checkpoint first.`);
    return false;
  }
  const transferId = target.transferId;
  state.entries = transferId
    ? state.entries.filter(entry => entry.transferId !== transferId)
    : state.entries.filter(entry => entry.id !== id);
  // Keep this helper safe for every caller, including transfer modals and
  // future deletion flows. Deletions must survive reload and sync.
  persist();
  return true;
}

function removeDuplicateEntry(id) {
  const target = state.entries.find(e => e.id === id);
  if (!target) return;
  if (!window.confirm(`Delete duplicate “${target.details}” for ${fmt(target.amount)}?`)) return;
  const removed = target.transferId
    ? state.entries.filter(e => e.transferId === target.transferId)
    : [target];
  const protection = removed.map(reconciliationProtectionFor).find(Boolean);
  if (protection) {
    toast(`Duplicate deletion blocked: ${methodShort(protection.methodId)} is reconciled through ${friendlyDate(protection.point.date)}.`);
    return;
  }
  const removedIds = new Set(removed.map(e => e.id));
  state.entries = state.entries.filter(e => !removedIds.has(e.id));
  persist();
  trackAction(() => { state.entries.push(...removed); state.entries.sort((a, b) => a.date.localeCompare(b.date)); persist(); }, `Restored ${target.details}`);
  toast(target.transferId ? 'Duplicate transfer pair deleted.' : 'Duplicate deleted.');
  render();
}

function uniqueEntryKey(e) {
  return `${e.date}|${e.amount}|${(e.details || '').trim().toLowerCase()}|${e.type}|${e.method}`;
}
function reviewForMonth(key) {
  // Deduplicate entries by (date|amount|details|type|method) so accidental
  // exact duplicates don't inflate the review totals.
  const uniqueByKey = (list) => {
    const seen = new Set();
    return list.filter(e => {
      const k = uniqueEntryKey(e);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const current = uniqueByKey(entriesForMonth(key));
  const previous = uniqueByKey(entriesForMonth(previousMonthKey(key)));
  const expenses = current.filter(isSpendingEntry);
  const previousExpenses = previous.filter(isSpendingEntry);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const previousTotal = previousExpenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = list => list.reduce((out, e) => { out[e.category] = (out[e.category] || 0) + e.amount; return out; }, {});
  const currentCats = byCategory(expenses), previousCats = byCategory(previousExpenses);
  const top = Object.entries(currentCats).sort((a, b) => b[1] - a[1])[0];
  const changes = Object.keys({ ...currentCats, ...previousCats }).map(id => ({ id, diff: (currentCats[id] || 0) - (previousCats[id] || 0) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const largestChange = changes.find(x => Math.abs(x.diff) >= 0.01);
  const percent = previousTotal ? Math.round(((total - previousTotal) / previousTotal) * 100) : null;
  const lines = [];
  if (top) lines.push(`Your biggest category was ${categoryLabel(top[0])} at ${fmt(top[1])}.`);
  if (percent !== null) lines.push(percent === 0 ? 'You spent the same as last month.' : `You spent ${Math.abs(percent)}% ${percent < 0 ? 'less' : 'more'} than last month.`);
  if (largestChange && largestChange.id !== top?.[0]) lines.push(`${categoryLabel(largestChange.id)} spending ${largestChange.diff >= 0 ? 'increased' : 'decreased'} by ${fmt(Math.abs(largestChange.diff))}.`);
  if (!lines.length) lines.push('Keep logging transactions and your monthly review will appear here.');
  return { lines, total, previousTotal };
}

// ---------- data health ----------
function computeDataHealth(entries) {
  if (entries.length === 0) return { score: 0, issues: ['No entries yet. Start tracking!'] };
  const issues = [];
  let score = 100;
  // Check for entries with no category / default
  const financialEntries = entries.filter(e => e.type !== 'note');
  const uncategorized = financialEntries.filter(e => isSpendingEntry(e) && e.category === 'misc').length;
  if (uncategorized > financialEntries.length * 0.3) { score -= 15; issues.push(`${uncategorized} entries are "Misc" — try categorising them.`); }
  // Large amounts
  const avg = financialEntries.length ? financialEntries.reduce((s,e) => s + e.amount, 0) / financialEntries.length : 0;
  const outliers = financialEntries.filter(e => e.amount > avg * 5).length;
  if (outliers > 0) { score -= 10; issues.push(`${outliers} entr${outliers===1?'y':'ies'} look unusually large.`); }
  // Duplicates
  const duplicateCount = duplicateGroups(entries).reduce((sum, group) => sum + group.length - 1, 0);
  if (duplicateCount > 0) { score -= 10; issues.push(`${duplicateCount} possible duplicate${duplicateCount===1?'':'s'} found.`); }
  // Gaps
  const dates = [...new Set(financialEntries.map(e => e.date))].sort((a, b) => a.localeCompare(b));
  if (dates.length >= 2) {
    let gaps = 0;
    for (let i = 1; i < dates.length; i++) {
      const d1 = new Date(dates[i-1]+'T00:00:00Z'), d2 = new Date(dates[i]+'T00:00:00Z');
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
    else if (k === 'innerHTML') el.innerHTML = v;
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
  const locked = hasPinLock() && !pinUnlocked;
  return $('header', { class: 'app-header', 'aria-label': 'App header' },
    $('div', { class: 'logo' },
      $('div', { class: 'mark' }, $('span', { class: 'mark-icon', 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6.5A7 7 0 1 0 17 17.5"/><line x1="2.5" y1="8" x2="12" y2="8"/><line x1="2.5" y1="16" x2="12" y2="16"/></svg>' })),
      $('a', { href: '#dashboard', style: 'font-family:"Instrument Serif",serif;font-style:italic;font-size:30px;letter-spacing:-0.03em;' }, 'cents.'),
    ),
    $('nav', { class: 'nav', 'aria-label': 'Primary', style: locked ? 'display:none;' : '' },
      ...ROUTES.map(r => $('a', { href: `#${r}`, class: 'nav-link', 'aria-current': r === route ? 'page' : 'false' }, titleFor(r))),
    ),
    $('div', { class: 'header-actions', style: locked ? 'display:none;' : '' },
      $('span', { id: 'sync-indicator', style: 'display:inline-flex;align-items:center;gap:7px;font-family:"Instrument Serif",serif;font-style:italic;font-size:14px;color:var(--muted);' }),      $('button', { class: 'dark-toggle', type: 'button', title: 'Toggle dark mode', 'aria-label': 'Toggle dark mode', 'aria-pressed': document.documentElement.dataset.theme === 'dark' ? 'true' : 'false', onClick: (event) => {
         const html = document.documentElement;
         const isDark = html.dataset.theme === 'dark';
         const nextTheme = isDark ? 'light' : 'dark';
         html.dataset.theme = isDark ? '' : 'dark';
         event.currentTarget.setAttribute('aria-pressed', String(!isDark));
         event.currentTarget.setAttribute('aria-label', `Switch to ${isDark ? 'dark' : 'light'} mode`);
         event.currentTarget.setAttribute('title', `Switch to ${isDark ? 'dark' : 'light'} mode`);
         try { localStorage.setItem('cents-theme', nextTheme); } catch(e) {}
       } },
        $('span', { class: 'icon-sun', 'aria-hidden': 'true', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' }),
        $('span', { class: 'icon-moon', 'aria-hidden': 'true', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' }),
      ),
      hasPinLock() ? $('button', { class: 'nav-action', onClick: lockApp, title: 'Lock app' }, 'Lock') : null,
      $('button', { class: 'nav-action', onClick: openPinSettings }, 'PIN'),
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
  const data = initial ? { ...initial } : {
    type: 'expense', date: today(), details: '', amount: '',
    method: 'AIB', category: 'gro', note: '',
  };
  if (typeof data.amount === 'number') data.amount = String(data.amount);

  // Type tabs — use role-based selectors, not firstChild/lastChild
  const tabs = $('div', { class: 'row', role: 'tablist', 'aria-label': 'Transaction type', style: `gap:${isNarrow() ? '10px' : '24px'};padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:32px;flex-wrap:wrap;` });
  const expenseTab = pillTab('Expense', 'expense', data.type === 'expense');
  const creditTab  = pillTab('Income', 'credit', data.type === 'credit');
  const transferTab = pillTab('Transfer', 'transfer', data.type === 'transfer');
  const noteTab = pillTab('Note', 'note', data.type === 'note');
  tabs.append(expenseTab, creditTab, transferTab, noteTab);
  function pillTab(label, type, active) {
    const btn = $('button', { type: 'button', class: 'pill', role: 'tab', 'data-id': label.toLowerCase(), 'aria-selected': active ? 'true' : 'false',          style: `padding:${isNarrow() ? '6px 14px' : '8px 18px'};font-size:12px;cursor:pointer;background:${active ? 'var(--accent-soft)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--muted)'};border-color:${active ? 'transparent' : 'var(--line)'};`, onClick: () => {
      data.type = type;
      if (isTransfer()) {
        data.transferFrom = data.transferFrom || 'AIB';
        data.transferTo = data.transferTo || 'Revolut';
      }
      tabs.querySelectorAll('[role=tab]').forEach(t => {
        const isActive = t.dataset.id === label.toLowerCase();
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        t.style.background = isActive ? 'var(--accent-soft)' : 'transparent';
        t.style.color = isActive ? 'var(--accent)' : 'var(--muted)';
        t.style.borderColor = isActive ? 'transparent' : 'var(--line)';
      });
      rebuildMethodOpts();
      const noteMode = data.type === 'note';
      if (noteMode) data.note = '';
      amountSection.style.display = noteMode ? 'none' : '';
      dateMethodSection.style.display = '';
      catSection.style.display = (isCredit() || isTransfer() || noteMode) ? 'none' : '';
      methodSection.style.display = (isTransfer() || noteMode) ? 'none' : '';
      transferSection.style.display = isTransfer() ? '' : 'none';
      noteFieldSection.style.display = noteMode ? 'none' : '';
      detailsLabel.textContent = noteMode ? 'Note' : 'Description';
      detailsInput.setAttribute('aria-label', noteMode ? 'Note text' : 'Transaction details');
    } }, label);
    return btn;
  }

  const amountInput = $('input', { type: 'text', inputmode: 'decimal', value: data.amount, 'aria-label': 'Amount in euros', placeholder: '0.00', autocomplete: 'off', required: true, onInput: (e) => { data.amount = e.target.value; } });

  const detailsInput = $('input', { type: 'text', value: data.details || '', 'aria-label': 'Transaction details', placeholder: 'e.g. Tesco, Leap Card', list: 'payee-list', required: true, onInput: (e) => data.details = e.target.value });

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

  // Category chips -- rebuilt from allCategories() so custom cats appear immediately.
  const catChips = $('div', { role: 'radiogroup', 'aria-label': 'Category', style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' });
  let _catAdding = false;
  function rebuildCatChips() {
    catChips.innerHTML = '';
    const all = allCategories();
    for (const c of all) {
      const btn = $('button', { type: 'button', class: 'pill pill-cat', role: 'radio', 'data-id': c.id, 'aria-checked': data.category === c.id ? 'true' : 'false', 'data-active': data.category === c.id ? 'true' : 'false', onClick: () => {
        data.category = c.id;
        catChips.querySelectorAll('[role=radio]').forEach(b => { b.setAttribute('aria-checked','false'); b.dataset.active = 'false'; });
        btn.setAttribute('aria-checked','true'); btn.dataset.active = 'true';
        _catAdding = false; rebuildCatChips();
      } }, c.label);
      catChips.appendChild(btn);
    }
    // + Add button (or inline input)
    if (!_catAdding) {
      catChips.appendChild($('button', { type: 'button', class: 'pill pill-cat', style: 'border-style:dashed;opacity:0.55;', title: 'Add custom category', onClick: () => { _catAdding = true; rebuildCatChips(); } }, '+ Add'));
    } else {
      const input = $('input', { type: 'text', placeholder: 'Category name', 'aria-label': 'New category name', autocomplete: 'off', style: 'border:1px solid var(--accent);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:4px 10px;font-size:12px;width:130px;outline:none;', onKeydown: (ev) => {
        if (ev.key === 'Escape') { _catAdding = false; rebuildCatChips(); return; }
        if (ev.key === 'Enter') confirmAdd(ev.target);
      }, onBlur: (ev) => { setTimeout(() => { if (_catAdding) { _catAdding = false; rebuildCatChips(); } }, 150); } });
      function confirmAdd(el) {
        const raw = (el.value || '').trim();
        if (!raw) { toast('Enter a category name.'); el.focus(); return; }
        // Generate a short slug id
        let id = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
        if (allCategories().some(c => c.id === id)) id = id + '-' + Date.now().toString(36).slice(-3);
        // Check duplicate label
        if (allCategories().some(c => c.label.toLowerCase() === raw.toLowerCase())) { toast('That category already exists.'); el.focus(); return; }
        if (!state.settings.customCategories) state.settings.customCategories = [];
        state.settings.customCategories.push({ id, label: raw });
        updateAllowedCategories(allCategories().map(c => c.id));
        persist();
        data.category = id;
        _catAdding = false;
        rebuildCatChips();
        toast('Added category: ' + raw);
      }
      catChips.appendChild(input);
      queueMicrotask(() => input.focus());
    }
  }
  rebuildCatChips();
  const catSection = $('div', { style: 'margin-bottom:24px;' },
    $('label', { class: 'eyebrow' }, 'Category'), catChips,
  );
  catSection.style.display = isCredit() ? 'none' : '';
  const noteInput = $('input', { type: 'text', value: data.note || '', 'aria-label': 'Optional note', placeholder: 'optional', onInput: (e) => data.note = e.target.value });
  const isNote = data.type === 'note';
  const amountSection = $('div', { style: isNote ? 'display:none;' : 'margin-bottom:24px;' },
    $('label', { class: 'eyebrow', for: 'f-amount' }, 'Amount'),
    $('div', { style: 'display:flex;align-items:baseline;gap:6px;margin-top:4px;' },
      $('span', { class: 'serif', style: `font-size:${isNarrow() ? '36px' : '60px'};color:var(--accent);`, 'aria-hidden': 'true' }, '€'),
      Object.assign(amountInput, { id: 'f-amount' }),
    ),
  );
  const dateMethodSection = $('div', { style: `display:grid;grid-template-columns:${isNarrow() ? '1fr' : '1fr 1fr'};gap:${isNarrow() ? '16px' : '24px'};margin-bottom:24px;` },
    $('div', null, $('label', { class: 'eyebrow', for: 'f-date' }, 'Date'), Object.assign(dateInput, { id: 'f-date' })),
    $('div', null, methodSection),
  );
  if (isNote) {
    catSection.style.display = 'none';
    data.note = '';
    noteInput.value = '';
  }

  const submit = () => {
    if (data.type === 'note') {      if (!isValidCheckpointDate(data.date)) {
        toast('Pick a valid date.');
        dateInput.focus();
        return;
      }
      const noteText = String(data.details || data.note || '').trim();
      if (!noteText) {
        toast('Add a note.');
        detailsInput.focus();
        return;
      }
      if (initial && Array.isArray(initial.mutationHistory) && initial.mutationHistory.length >= MAX_MUTATION_HISTORY) {
        toast('This entry has reached the maximum edit history. Duplicate it as a new entry instead.');
        return;
      }
      const mutationAt = initial ? mutationTimestamp(initial) : null;
      const previousVersion = initial ? {
        at: mutationAt,
        createdAt: initial.createdAt,
        date: initial.date,
        type: initial.type,
        category: initial.category,
        amount: Number(initial.amount),
        method: initial.method,
      } : null;
      onSubmit([{
        ...data,
        id: initial?.id || uid(),
        createdAt: initial?.createdAt || nowIso(),
        ...(mutationAt ? { updatedAt: mutationAt } : {}),
        ...(initial ? { mutationHistory: [...(Array.isArray(initial.mutationHistory) ? initial.mutationHistory : []), previousVersion] } : {}),
        type: 'note',
        category: 'misc',
        details: noteText,
        amount: 0,
        method: data.method || 'AIB',
        note: data.note?.trim() || '',
      }]);
      return;
    }
    const amt = parseAmount(data.amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); amountInput.focus(); return; }
    if (amt > 100000) { toast('Amount looks too large — double check.'); amountInput.focus(); return; }
    if (!isValidCheckpointDate(data.date)) { toast('Pick a valid date.'); dateInput.focus(); return; }
    if (!data.details.trim()) { toast('Add a description.'); detailsInput.focus(); return; }
    if (isTransfer()) {
      if (isEdit) { toast('Transfers cannot be edited here. Delete and recreate the pair.'); return; }
      if (data.transferFrom === data.transferTo) { toast('From and To cannot be the same account.'); return; }
      const pairId = uid();
      const base = { createdAt: nowIso(), date: data.date, amount: amt, details: data.details.trim(), note: data.note?.trim() || '', category: 'misc', transferId: pairId, settled: false };
      const fromEntry = { ...base, id: uid(), type: 'expense', method: data.transferFrom };
      const toEntry   = { ...base, id: uid(), type: 'credit',  method: data.transferTo };
      onSubmit([fromEntry, toEntry]);
      return;
    }
    if (initial && Array.isArray(initial.mutationHistory) && initial.mutationHistory.length >= MAX_MUTATION_HISTORY) {
      toast('This entry has reached the maximum edit history. Duplicate it as a new entry instead.');
      return;
    }
    const mutationAt = initial ? mutationTimestamp(initial) : null;
    const previousVersion = initial ? {
      at: mutationAt,
      createdAt: initial.createdAt,
      date: initial.date,
      type: initial.type,
      category: initial.category,
      amount: Number(initial.amount),
      method: initial.method,
    } : null;
    const mutationHistory = initial
      ? [...(Array.isArray(initial.mutationHistory) ? initial.mutationHistory : []), previousVersion]
      : null;
    const entry = {
      id: initial?.id || uid(),
      // Preserve the original creation moment when editing. Reconciliation
      // checkpoints use mutation history to calculate the net change.
      createdAt: initial?.createdAt || nowIso(),
      ...(mutationAt ? { updatedAt: mutationAt } : {}),
      ...(mutationHistory ? { mutationHistory } : {}),
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

  const payeeList = $('datalist', { id: 'payee-list' }, ...payeeHistory().map(payee => $('option', { value: payee })));
  let detailsLabel;
  let noteFieldSection;
  const formEl = $('div', { class: 'card', style: `padding:${isNarrow() ? '20px' : '32px'};max-width:540px;margin:0 auto;` },
    payeeList,
    tabs,
    amountSection,
    dateMethodSection,
    transferSection,
    catSection,
    $('div', { style: 'margin-bottom:24px;' },
      detailsLabel = $('label', { class: 'eyebrow' }, isNote ? 'Note' : 'Description'), Object.assign(detailsInput, { id: 'f-details', value: data.details || '' }),
    ),
    noteFieldSection = $('div', { style: isNote ? 'display:none;' : 'margin-bottom:32px;' },
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
  formEl.dataset.firstFocus = data.type === 'note' ? 'f-details' : 'f-amount';
  return formEl;
}

// ---------- dashboard ----------
/** Pull from cloud and re-render — used by both the dashboard resync button and manual sync. */
async function doResync() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) { toast('Sync is not configured.'); return; }
  if (syncInFlight || syncExclusive) { toast('A sync is already in progress.'); return; }
  syncExclusive = true;
  try {
    const prevCount = state.entries.length;
    const pullRevision = syncRevision;
    const r = await syncPull();
    if (r.ok && isUsableCloudContent(r.content)) {
      if (localIsFresherThanCloud(r)) {
        patchSyncSettings({ lastSha: r.sha, lastError: null, lastErrorAt: null });
        toast('Cloud is older than your local copy — local data was kept and will be pushed.');
        scheduleSyncPush();
        notifySyncChange();
        return;
      }
      if (!confirmCloudReplacement()) return;
      if (pullRevision !== syncRevision) {
        toast('A newer local change was kept; cloud pull skipped.');
        return;
      }
      syncRevision++;
      state = validateState(r.content);
      saveState(state);
      updateAllowedCategories(allCategories().map(c => c.id));
      patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
      const diff = state.entries.length - prevCount;
      toast(diff > 0 ? `Pulled ${diff} new entr${diff === 1 ? 'y' : 'ies'}.` : diff < 0 ? `Cloud has ${state.entries.length} entries.` : 'Already up to date.');
      notifySyncChange();
      render();
    } else if (r.ok && !r.content) {
      toast(hasLocalDataToProtect() ? 'Cloud file is empty — local data was kept. Use Push to create it.' : 'Cloud file is empty — nothing to pull.');
    } else if (r.ok) {
      toast('Pull failed: cloud data is malformed.');
    } else {
      toast('Pull failed: ' + (r.message || r.reason));
    }
  } finally {
    syncExclusive = false;
  }
}

function screenDashboard() {
  const now = new Date();
  const key = monthKey(localDateKey(now));
  const monthEntries = entriesForMonth(key);
  const budget = +state.settings.monthlyBudget || 0;
  const { balance: runningBalance, points } = computeBalance();
  let budgetSaveTimer = null;
  const commitBudget = raw => {
    const value = parseAmount(raw);
    if (!Number.isFinite(value) || value < 0) return false;
    clearTimeout(budgetSaveTimer);
    budgetSaveTimer = setTimeout(() => {
      if (value === (+state.settings.monthlyBudget || 0)) return;
      state.settings.monthlyBudget = value;
      persist();
      toast(value > 0 ? 'Budget updated.' : 'Budget cleared.');
      render();
    }, 250);
    return true;
  };

  const expensesOnly = monthEntries.filter(isSpendingEntry);
  const incomeOnly = monthEntries.filter(isIncomeEntry);
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
    .filter(entry => entry.type !== 'note')
    .sort((a, b) => b.date.localeCompare(a.date) || (a.id < b.id ? 1 : -1))
    .slice(0, 5);

  const screen = $('section', { class: 'page-section dashboard-section', 'aria-label': 'Dashboard' });
  screen.classList.add('dashboard-command-center');

  // Net worth sparkline card (if enough data) — points already computed above
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
  screen.appendChild($('div', { class: 'page-title-row dashboard-hero' },
    $('div', null,
      $('div', { class: 'eyebrow' }, monthLabel(key)),
      $('p', { class: 'dashboard-total', style: `font-size:${isTiny() ? '32px' : isNarrow() ? '42px' : '54px'};` },
        $('span', { class: 'serif' }, fmt(expenseSum)),
        $('span', { class: 'dashboard-budget', style: `font-size:${isNarrow() ? '14px' : '18px'};` }, budget ? `/ ${fmt(budget)}` : ''),
      ),
      $('p', { class: 'dashboard-context', style: `font-size:${isNarrow() ? '13px' : '15px'};gap:${isNarrow() ? '10px' : '18px'};` },
        $('span', null, 'Balance ', $('span', { class: 'display-num', style: `font-size:16px;color:${runningBalance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(runningBalance))),
        cashWidget(),
      ),
    ),
    $('div', { class: 'dashboard-actions' },
      $('label', { class: 'eyebrow', for: 'budget-input' }, 'Budget'),
      $('input', { id: 'budget-input', type: 'text', inputmode: 'decimal', value: String(budget || ''), placeholder: '—', 'aria-label': 'Monthly budget in euros', autocomplete: 'off', style: `width:${isNarrow() ? '72px' : '92px'};border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;`, onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
        e.target.style.borderColor = 'var(--line)';
        if (!commitBudget(e.target.value)) { e.target.value = String(budget || ''); toast('Enter a non-negative number.'); }
      }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      $('a', { href: '#add', class: 'btn btn-primary' },
        $('span', { class: 'btn-new-icon', style: 'margin-right:6px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line class="icon-plus-h" x1="5" y1="12" x2="19" y2="12"/><line class="icon-plus-v" x1="12" y1="5" x2="12" y2="19"/></svg>' }),
        'New entry',
      ),
      resyncBtn,
    ),
  ));

  // A compact financial pulse makes the dashboard answer the three questions
  // users ask most often: how much is spent, what is projected, and whether the
  // current pace is safe. It is display-only; all values come from existing
  // financial helpers.
  const pulse = spendingForecast(key);
  const pulseComparison = monthComparison(key);
  const pulseTone = pulse.budget && pulse.projected > pulse.budget ? 'var(--negative)' : 'var(--positive)';
  screen.appendChild($('div', { class: 'card financial-pulse', style: `padding:${isNarrow() ? '18px' : '24px'};margin-bottom:24px;` },
    $('div', { class: 'pulse-heading' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Financial pulse'),
        $('div', { class: 'serif pulse-message' }, pulse.budget
          ? (pulse.projected > pulse.budget ? 'Your current pace is above budget.' : 'You are comfortably within budget.')
          : 'Your month at a glance.'),
      ),
      $('span', { class: 'pulse-status', style: `color:${pulseTone};border-color:${pulseTone};` }, pulse.budget ? (pulse.projected > pulse.budget ? 'Needs attention' : 'On track') : 'Tracking'),
    ),
    $('div', { class: 'pulse-grid' },
      stat('Spent', fmt(pulse.spent)),
      stat('Projected', fmt(pulse.projected)),
      pulse.budget ? stat('Remaining', fmt(pulse.remaining)) : stat('Daily pace', fmt(pulse.dailyAverage)),
    ),
    pulseComparison.previous > 0 ? $('div', { class: 'pulse-footnote muted' },
      `${pulseComparison.difference <= 0 ? 'Down' : 'Up'} ${fmt(Math.abs(pulseComparison.difference))} from ${monthLabel(pulseComparison.previousKey)}.`,
    ) : null,
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
        ...((() => {
          const confettiMonth = monthKey(localDateKey(now));
          const lastMonth = window.__confettiMonth;
          const lastDay = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0)).getUTCDate();
          if (pct <= 100 && now.getDate() === lastDay && lastMonth !== confettiMonth) {
            setTimeout(triggerConfetti, 600);
            window.__confettiMonth = confettiMonth;
          }
          return [];
        })()),
      $('div', { style: `display:grid;grid-template-columns:repeat(auto-fill,minmax(${isNarrow() ? '90px' : '130px'},1fr));gap:${isNarrow() ? '12px' : '24px'};padding-top:20px;border-top:1px solid var(--line);` },
        stat('Net', fmt(totalForMonth(key))),
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

  // Spending forecast
  const forecast = spendingForecast(key);
  const forecastTone = forecast.budget && forecast.projected > forecast.budget ? 'var(--negative)' : 'var(--positive)';
  screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-bottom:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:14px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Spending forecast'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, `Based on ${forecast.elapsed} days of activity`),
      ),
      $('span', { class: 'pill', style: `border-color:transparent;color:${forecastTone};` }, forecast.budget ? (forecast.projected > forecast.budget ? 'Over budget' : 'On track') : 'Estimate'),
    ),
    $('div', { style: `display:grid;grid-template-columns:repeat(auto-fit,minmax(${isNarrow() ? '120px' : '150px'},1fr));gap:16px;` },
      stat('Current spending', fmt(forecast.spent)),
      stat('Projected total', fmt(forecast.projected)),
      forecast.budget ? stat('Projected remaining', fmt(forecast.remaining)) : stat('Daily average', fmt(forecast.dailyAverage)),
    ),
    forecast.previousDaily !== null && forecast.dailyAverage > 0 ? $('div', { class: 'serif', style: 'font-size:15px;font-style:italic;margin-top:16px;padding-top:14px;border-top:1px solid var(--line);' },
      `You are spending ${fmt(Math.abs(forecast.previousDaily - forecast.dailyAverage))} ${forecast.dailyAverage <= forecast.previousDaily ? 'less' : 'more'} per day than last month.`,
    ) : null,
  ));

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
              $('span', { style: 'font-weight:500;' }, categoryLabel(cat)),
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
              $('div', { style: `font-size:11px;color:var(--muted);${isNarrow() ? 'display:none;' : ''}` }, `${categoryLabel(e.category)} · ${methodLabel(e.method)}`),
            ),
            $('span', { class: 'display-num', style: `text-align:right;font-size:${isNarrow() ? '13px' : '15px'};color:${e.type === 'credit' ? 'var(--positive)' : 'var(--ink)'}` }, (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
            ...(isNarrow() ? [] : [$('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, e.method))]),
          ]),
        ),
  );

  grid.append(catCard, recentCard);
  screen.appendChild(grid);

  // All tracked balances share one inline reconciliation flow. A checkpoint
  // records the actual balance on a date without rewriting any transactions.
  const trackedMethods = METHODS.filter(m => ACCOUNT_METHOD_IDS.includes(m.id));
  const pendingPerMethod = {};
  for (const e of state.entries) {
    if (!e.transferId || e.settled) continue;
    pendingPerMethod[e.method] = (pendingPerMethod[e.method] || 0) + (e.type === 'credit' ? e.amount : -e.amount);
  }
  const accountsCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { style: 'margin-bottom:16px;' },
      $('div', { class: 'eyebrow' }, 'Bank account balances'),
      $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Current end-of-day balances; transaction history stays unchanged.'),
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...trackedMethods.map(method => {
        const status = accountStatus(method.id);
        const pending = pendingPerMethod[method.id] ? `${pendingPerMethod[method.id] > 0 ? '+' : ''}${fmt(pendingPerMethod[method.id])} pending` : '';
        return renderBalanceEditorRow(method.id, {
          label: methodShort(method.id),
          secondary: [status.label, pending].filter(Boolean).join(' · '),
          editable: false,
        });
      }),
    ),
  );
  screen.appendChild(accountsCard);

  const gcCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:16px;' }, 'Gift card balances'),     $('div', { class: 'muted', style: 'font-size:11px;margin:-8px 0 8px;' }, 'Current provider balances without adding a fake transaction. Totals show recorded activity, or post-reconciliation adjustments when a checkpoint exists.'),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },     ...GIFT_CARD_IDS.map(id => {
         const m = METHODS.find(x => x.id === id);
         const totals = computeGiftCardBalance(state.entries, id);
         return renderBalanceEditorRow(id, {
           label: m?.label?.includes(' · ') ? m.label.split(' · ')[1] : (m?.label || id),            secondary: totals.loaded || totals.spent
              ? `${userCheckpointFor(id, today()) ? 'net adjustments · loads' : 'recorded loads'} ${fmt(totals.loaded)} · spending ${fmt(totals.spent)}`
              : '',
           editable: false,
         });
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
            const [dy, dm, dd] = d.split('-').map(Number);
            const dt = new Date(Date.UTC(dy, dm - 1, dd));
            const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(dt);
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
  const wrapper = $('span', { style: 'position:relative;display:inline-flex;align-items:center;gap:6px;cursor:pointer;' },
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
    ...allCategories().map(c => $('option', { value: c.id }, c.label)),
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
  const c = $('section', { class: 'page-section add-flow', 'aria-label': 'New entry' });
  c.appendChild($('div', { class: 'page-title-row add-flow-heading' },
    $('div', null,
      $('div', { class: 'eyebrow' }, 'Quick capture'),
      $('h1', { class: 'page-title' }, 'New entry'),
      $('p', { class: 'muted page-lede' }, 'Start with the amount. The rest takes seconds.'),
    ),
    $('span', { class: 'pill add-flow-hint' }, '⌘ / Ctrl + N'),
  ));

  // Natural-language and structured voice entry
  const magicInput = $('textarea', { placeholder: 'Try: Spent €18.50 at Tesco from Revolut yesterday', 'aria-label': 'Natural-language entry', rows: '2', style: 'width:100%;font-size:13px;margin-bottom:8px;', onInput: (e) => {
    const parsed = parseNaturalLanguage(e.target.value);
    magicPreview.textContent = parsed?.error || (parsed ? `${parsed.type === 'credit' ? 'Income' : 'Expense'} · ${fmt(parsed.amount)} · ${parsed.details} · ${methodShort(parsed.method)} · ${friendlyDate(parsed.date)}` : '');
  } });
  const magicPreview = $('div', { class: 'muted', style: 'font-size:12px;min-height:18px;margin-bottom:10px;' });
  const addMagic = () => {
    const parsed = parseNaturalLanguage(magicInput.value);
    if (!parsed || parsed.error) { toast(parsed?.error || 'Describe an entry first.'); magicInput.focus(); return; }
    state.entries.push({ id: uid(), createdAt: nowIso(), date: parsed.date, type: parsed.type, category: parsed.category, details: parsed.details, amount: parsed.amount, method: parsed.method, note: 'Created with natural-language input' });
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist(); toast('Entry created from your description.'); location.hash = '#dashboard';
  };
  const voiceInputBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:12px;', onClick: () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { toast('Voice input is not supported in this browser.'); return; }
    const recognition = new Recognition();
    recognition.lang = 'en-IE'; recognition.interimResults = false; recognition.maxAlternatives = 1;
    voiceInputBtn.textContent = 'Listening…'; voiceInputBtn.disabled = true;
    recognition.onresult = ev => { magicInput.value = ev.results[0][0].transcript; magicInput.dispatchEvent(new Event('input')); };
    recognition.onerror = () => toast('Could not hear that. Try again.');
    recognition.onend = () => { voiceInputBtn.textContent = '🎙 Voice'; voiceInputBtn.disabled = false; };
    recognition.start();
  } }, '🎙 Voice');
  c.appendChild($('div', { class: 'card', style: `max-width:540px;margin:0 auto 20px;padding:${isNarrow() ? '18px' : '22px'};` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:6px;' }, 'Magic entry'),
    $('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px;' }, 'Describe it naturally, check the preview, then add it.'),
    magicInput,
    magicPreview,
    $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;' }, voiceInputBtn, $('button', { type: 'button', class: 'btn btn-primary', style: 'font-size:12px;', onClick: addMagic }, 'Add entry')),
  ));

  const form = formView({
    onSubmit: (entryOrEntries) => {
      const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
      for (const e of entries) state.entries.push(e);
      state.entries.sort((a, b) => a.date.localeCompare(b.date));
      persist();
      toast(entries.length > 1 ? `Saved ${entries.length} entries.` : 'Saved.');
      location.hash = '#dashboard';
    },
  });
  c.appendChild(form);
  // Focus the first field appropriate to the selected entry type. This keeps
  // note forms usable if the screen is ever opened with a note preselected.
  // The top-level renderer focuses this after the frame mounts the section.
  form.dataset.routeInitialFocus = 'true';
  return c;
}

// ---------- screens: history ----------
function screenHistory() {
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  let activeMonth = params.get('month') || monthKey(today());
  let activeCat = params.get('cat') || 'all';
  let activeMethod = params.get('method') || 'all';
  let searchQuery = params.get('q') || '';

  const months = Array.from(new Set(state.entries.map(e => monthKey(e.date))))
    .sort((a, b) => b.localeCompare(a));
  if (!months.includes(activeMonth) && months.length) activeMonth = months[0];

  const monthEntries = entriesForMonth(activeMonth);
  const filtered = searchEntries(monthEntries, searchQuery, { type: 'all', category: activeCat, method: activeMethod });
  // Sort a copy so filtering/history presentation never mutates persisted order.
  const visible = [...filtered].sort((a, b) => b.date.localeCompare(a.date)
    || ((b.createdAt || '')).localeCompare(a.createdAt || '')
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const expenseSum = monthEntries.filter(isSpendingEntry).reduce((s, e) => s + e.amount, 0);
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
    if (next.method !== undefined) {
      if (next.method === 'all') params.delete('method');
      else params.set('method', next.method);
    }
    const qs = params.toString();
    location.hash = qs ? `history?${qs}` : 'history';
  };

  const c = $('section', { class: 'page-section', 'aria-label': 'History' });

  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, monthLabel(activeMonth)),
    $('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end;' },
      monthNav('←', () => { const i = months.indexOf(activeMonth); if (i < months.length - 1) update({ month: months[i + 1] }); }, months.indexOf(activeMonth) >= months.length - 1),
      monthNav(monthKey(today()) === activeMonth ? 'Today' : 'Jump', () => update({ month: monthKey(today()) }), false),
      monthNav('→', () => { const i = months.indexOf(activeMonth); if (i > 0) update({ month: months[i - 1] }); }, months.indexOf(activeMonth) <= 0),
    ),
  ));

  const historyAccountMethods = METHODS.filter(m => ACCOUNT_METHOD_IDS.includes(m.id));
  c.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-bottom:24px;` },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Account balances'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Reconcile end-of-day actual balances by date; no transaction records are changed.'),
      ),
      $('span', { class: 'muted', style: 'font-size:11px;' }, 'AIB · Revolut · Revolut Savings'),
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...historyAccountMethods.map(method => renderBalanceEditorRow(method.id, { label: methodShort(method.id), editable: true })),
    ),
  ));
  c.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-bottom:24px;` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:4px;' }, 'Gift card balances'),
    $('div', { class: 'muted', style: 'font-size:11px;margin-bottom:8px;' }, 'The same reconciliation editor is used for every balance.'),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...GIFT_CARD_IDS.map(id => {
        const method = METHODS.find(m => m.id === id);
        const totals = computeGiftCardBalance(state.entries, id);
        return renderBalanceEditorRow(id, {
          label: method?.label?.includes(' · ') ? method.label.split(' · ')[1] : (method?.label || id),
          secondary: totals.loaded || totals.spent
            ? `${userCheckpointFor(id, today()) ? 'net adjustments · loads' : 'recorded loads'} ${fmt(totals.loaded)} · spending ${fmt(totals.spent)}`
            : '',
           editable: true,
         });
       }),
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

  const filterRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 12px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  filterRow.appendChild($('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;font-size:10px;' }, 'Category'));
  filterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': 'all', 'data-active': activeCat === 'all' ? 'true' : 'false', 'aria-pressed': activeCat === 'all' ? 'true' : 'false', onClick: () => update({ cat: 'all' }) }, `All · ${catCounts.all || 0}`));
  for (const c2 of allCategories()) {
    const count = catCounts[c2.id] || 0;
    if (count === 0 && activeCat !== c2.id) continue;
    filterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': c2.id, 'data-active': activeCat === c2.id ? 'true' : 'false', 'aria-pressed': activeCat === c2.id ? 'true' : 'false', onClick: () => update({ cat: c2.id }) }, `${c2.label} · ${count}`));
  }
  const methodCounts = {};
  for (const e of monthEntries) methodCounts[e.method] = (methodCounts[e.method] || 0) + 1;
  const methodFilterRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  methodFilterRow.appendChild($('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;font-size:10px;' }, 'Account'));
  methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': 'all', 'data-active': activeMethod === 'all' ? 'true' : 'false', 'aria-pressed': activeMethod === 'all' ? 'true' : 'false', onClick: () => update({ method: 'all' }) }, `All · ${monthEntries.length}`));
  for (const method of METHODS) {
    const count = methodCounts[method.id] || 0;
    if (count === 0 && activeMethod !== method.id) continue;
    methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': method.id, 'data-active': activeMethod === method.id ? 'true' : 'false', 'aria-pressed': activeMethod === method.id ? 'true' : 'false', onClick: () => update({ method: method.id }) }, `${methodShort(method.id)} · ${count}`));
  }
  c.appendChild(filterRow);
  c.appendChild(methodFilterRow);

  const tableWrap = $('div', { class: 'card', style: 'overflow-x:auto;' });
  if (visible.length === 0) {
    tableWrap.appendChild($('div', { class: 'empty' }, emptyIcon('receipt'), searchQuery ? ' No results for this search.' : ' Nothing here for this filter.'));
  } else {
    tableWrap.appendChild($('div', { role: 'row', style: 'display:grid;grid-template-columns:90px 1fr 110px 100px 90px 30px;gap:24px;padding:14px 24px;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);min-width:740px;' },
      $('span', { role: 'columnheader' }, 'Date'),
      $('span', { role: 'columnheader' }, 'Description'),
      $('span', { role: 'columnheader', style: 'text-align:right;' }, 'Amount'),
      $('span', { role: 'columnheader', style: 'text-align:right;', title: 'Balance immediately after this entry' }, 'After entry'),
      $('span', { role: 'columnheader' }, 'Method'),
      $('span'),
    ));

    let previousVisibleDate = null;
    for (const e of visible) {
      if (e.date !== previousVisibleDate) {
        previousVisibleDate = e.date;
        tableWrap.appendChild($('div', { class: 'history-day-header', role: 'row', style: 'display:grid;grid-template-columns:1fr;gap:8px;padding:13px 24px 8px;min-width:740px;background:var(--bg-deep);border-bottom:1px solid var(--line);' },
          $('span', { role: 'rowheader', class: 'eyebrow' }, relativeDayLabel(e.date)),
        ));
      }
      const isTransfer = !!e.transferId;
      const settledLabel = isTransfer ? (e.settled ? '✓ settled' : '● unsettled') : '';
      const settleColor = e.settled ? 'var(--positive)' : 'var(--muted)';
      const rowType = e.type === 'note' ? 'note-row' : e.type === 'credit' ? 'income-row' : 'expense-row';
      const row = $('div', { class: `history-row ${rowType}`, role: 'row', tabindex: '0', 'data-id': e.id, 'aria-label': `Edit entry ${e.details} on ${friendlyDate(e.date)}`, style: 'display:grid;grid-template-columns:90px 1fr 110px 100px 90px 30px;gap:24px;padding:14px 24px;align-items:center;border-bottom:1px solid var(--line);cursor:pointer;min-width:740px;outline:none;', onClick: () => openEdit(e.id), onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdit(e.id); } } },
        $('span', { class: 'muted', style: 'font-size:13px;' }, friendlyDate(e.date)),          $('div', null,
            $('div', { style: 'font-size:14px;display:flex;align-items:center;gap:6px;' }, e.details || '—',
              e.type === 'note' && e.audioData ? $('audio', { controls: '', preload: 'none', src: e.audioData, style: 'width:130px;height:28px;' }) : null,
            isTransfer ? $('span', { style: `font-size:10px;color:${settleColor};cursor:pointer;user-select:none;`, onClick: (ev) => {
              ev.stopPropagation();
              const newVal = !e.settled;
              for (const x of state.entries) {
                if (x.transferId === e.transferId) x.settled = newVal;
              }
              persist(); toast(newVal ? 'Transfer settled.' : 'Transfer unsettled.'); render();
            }, title: 'Click to toggle settled' }, settledLabel) : null,
          ),
          $('div', { style: 'font-size:11px;color:var(--muted);' }, categoryLabel(e.category)),
        ),
        $('span', { class: 'display-num', style: 'text-align:right;font-size:15px;color:' + (e.type === 'credit' ? 'var(--positive)' : 'var(--ink)') }, e.type === 'note' ? 'Note' : (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
        $('span', { class: 'tnum', style: 'text-align:right;font-size:13px;color:' + (balanceForEntry(e) >= 0 ? 'var(--positive)' : 'var(--negative)'), }, e.type === 'note' ? '—' : fmt(balanceForEntry(e))),
        $('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, e.method)),
        $('span', { class: 'history-actions', style: 'display:flex;justify-content:flex-end;align-items:center;gap:5px;' },
          $('button', { type: 'button', class: 'history-action-btn', title: 'Edit or delete entry', 'aria-label': `Edit or delete ${e.details || 'entry'}`, onClick: ev => { ev.stopPropagation(); openEdit(e.id); } }, 'Manage'),
        ),
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
  const defaultFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return localDateKey(d); })();
  let fromDate = isValidCheckpointDate(fromParam) ? fromParam : defaultFrom;
  let toDate = isValidCheckpointDate(toParam) ? toParam : today();
  // Keep malformed or reversed URL ranges from producing misleading totals.
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

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

  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, 'Where it goes.'),
    $('div', { style: 'display:flex;align-items:center;gap:8px;' },
      fromInput,
      $('span', { class: 'muted', style: 'font-size:13px;' }, '→'),
      toInput,
      (fromParam || toParam) ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { location.hash = 'insights'; } }, 'Reset') : null,
    ),
  ));

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

  c.appendChild($('div', { class: 'insight-narrative card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow' }, 'The short version'),
    $('p', { class: 'serif insight-narrative-text' }, recent.some(isSpendingEntry)
      ? `You spent ${fmt(insightTotal)} in this range${topCategoryEntry ? `, led by ${categoryLabel(topCategoryEntry[0])} at ${fmt(topCategoryEntry[1])}` : ''}.`
      : 'Log a few expenses and your spending story will appear here.'),
    insightPrevious > 0 ? $('div', { class: 'insight-narrative-note muted' },
      `${fmt(Math.abs(insightDelta))} ${insightDelta <= 0 ? 'less' : 'more'} than the preceding period.`,
    ) : null,
  ));

  c.appendChild($('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin-bottom:32px;' },
    statCard('Average / month', fmt(avg)),
    statCard('Top method', topMethodEntry ? `${(methodShort(topMethodEntry[0]))} · ${fmt(topMethodEntry[1])}` : '—'),
    statCard('Entries', String(recent.filter(isSpendingEntry).length)),
    statCard('Categories active', String(new Set(recent.filter(isSpendingEntry).map(e => e.category)).size)),
  ));

  // Calendar heatmap — current month
  const now = new Date();
  const heatKey = monthKey(localDateKey(now));
  const heatEntries = entriesForMonth(heatKey).filter(isSpendingEntry);
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

  const catTotals = catTotalsForEntries(recent);
  const catRows = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'By category'),
    catRows.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('coin'), ' No expenses in this range.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
          ...catRows.map(([cat, val]) => bar(categoryLabel(cat), val, maxCat, val === maxCat)),
        ),
  ));

  const methodRows = Object.entries(methodTotals).sort((a,b)=>b[1]-a[1]);
  const maxMethod = methodRows[0]?.[1] || 1;

  c.appendChild($('div', { class: 'card', style: 'padding:24px;' },
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
    const palette = ['var(--accent)', 'var(--positive)', '#8b5cf6'];
    const lines = balanceHistory.methods.map((method, index) => {
      const d = balanceHistory.points.map((point, i) => `${i ? 'L' : 'M'} ${xAt(i)} ${yAt(point.balances[method.id])}`).join(' ');
      return $('path', { d, style: `fill:none;stroke:${palette[index]};stroke-width:2;stroke-linecap:round;stroke-linejoin:round;` });
    });
    c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;overflow:hidden;' },
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
  c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:12px;' }, `Monthly review · ${monthLabel(reviewKey)} · month to date`),
    $('div', { style: 'display:flex;flex-direction:column;gap:8px;' }, ...review.lines.map(line => $('div', { class: 'serif', style: 'font-size:16px;font-style:italic;' }, line))),
  ));

  // Duplicate cleanup
  const duplicateSets = duplicateGroups();
  if (duplicateSets.length) {
    c.appendChild($('div', { class: 'card', style: 'padding:24px;margin-bottom:24px;' },
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
    ['Top category', topCat ? `${categoryLabel(topCat[0])} · ${fmt(topCat[1])}` : '—', ''],
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
  const opener = document.activeElement;
  const openerId = opener?.closest?.('[data-id]')?.dataset.id || null;
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Transfer pair', tabindex: '-1', style: 'max-width:480px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => {
    document.removeEventListener('keydown', onEsc, true);
    bg.remove();
    render();
    const restore = () => {
      const canRestoreOpener = opener?.isConnected
        && opener !== document.body
        && typeof opener.matches === 'function'
        && opener.matches('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (canRestoreOpener) {
        opener.focus({ preventScroll: true });
        return;
      }
      if (openerId) {
        [...document.querySelectorAll('[data-id]')]
          .find(node => node.dataset.id === openerId)
          ?.focus({ preventScroll: true });
      }
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore);
    else setTimeout(restore, 0);
  };
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

  modal.appendChild($('p', { class: 'serif', style: 'font-style:italic;font-size:15px;color:var(--negative);margin:16px 0 8px;' }, 'Delete this transfer pair? You can undo it from the toast.'));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: () => {
      const removed = pair.map(entry => ({ ...entry }));
      if (deleteEntryOrTransfer(e.id)) {
        trackAction(() => {
          state.entries.push(...removed);
          state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          persist();
        }, 'Restored transfer pair');
        toast('Transfer pair deleted.');
      }
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
  const openerRow = document.activeElement?.closest?.('[data-id]');
  const openerId = openerRow?.dataset.id || null;
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
      const restore = () => {
        const fresh = [...document.querySelectorAll('[data-id]')].find(node => node.dataset.id === openerId);
        fresh?.focus({ preventScroll: true });
      };
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore);
      else setTimeout(restore, 0);
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
      // Editing an ordinary entry may turn it into a transfer. Replace the
      // original atomically with the generated pair rather than silently
      // discarding the second leg.
      state.entries = state.entries.filter(x => x.id !== id);
      state.entries.push(...entries);
      state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
      persist();
      toast(entries.length > 1 ? 'Transfer updated.' : 'Updated.');
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
    const removed = e.transferId
      ? state.entries.filter(entry => entry.transferId === e.transferId).map(entry => ({ ...entry }))
      : [{ ...e }];
    if (deleteEntryOrTransfer(id)) {
      trackAction(() => {
        state.entries.push(...removed);
        state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        persist();
      }, e.transferId ? 'Restored transfer pair' : `Restored ${e.details}`);
      toast(e.transferId ? 'Transfer pair deleted.' : 'Deleted. You can undo it from the toast.');
    }
    close();
  } }, 'Confirm delete');
  const deletePanel = $('div', { style: 'display:none;margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--accent-soft);' },
    $('p', { class: 'serif', style: 'font-style:italic;font-size:17px;margin:0 0 12px;color:var(--negative);' }, 'Delete this entry? You can undo it from the toast.'),
    $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' }, cancelDeleteBtn, confirmDeleteBtn),
  );
  modal.appendChild($('div', { style: 'margin-top:24px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px;' }, deleteStage1));

  modal.appendChild(deletePanel);

  // Initial focus into the first form field
  queueMicrotask(() => {
    const first = modal.querySelector(`#${formNode.dataset.firstFocus || 'f-amount'}`)
      || modal.querySelector('input, select, button');
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
        if (syncInFlight || syncExclusive) { toast('A sync is already in progress.'); return; }
        syncExclusive = true;
        try {
        pullBtn.disabled = true; pushBtn.disabled = true;
        pullLabel.textContent = 'Pulling…';
        const pullRevision = syncRevision;
        const r = await syncPull();
        pullBtn.disabled = false; pushBtn.disabled = false;
        pullLabel.textContent = 'Pull';
        if (r.ok && r.content) {
          if (!isUsableCloudContent(r.content)) {
            pullBtn.disabled = false; pushBtn.disabled = false;
            toast('Pull failed: cloud data is malformed.');
            return;
          }
          if (localIsFresherThanCloud(r)) {
            patchSyncSettings({ lastSha: r.sha, lastError: null, lastErrorAt: null });
            toast('Cloud is older than your local copy — local data was kept and will be pushed.');
            scheduleSyncPush();
            return;
          }
          if (!confirmCloudReplacement()) {
            pullBtn.disabled = false; pushBtn.disabled = false;
            return;
          }
          if (pullRevision !== syncRevision) {
            toast('A newer local change was kept; cloud pull skipped.');
            return;
          }
          syncRevision++;
          state = validateState(r.content);
          saveState(state);
          updateAllowedCategories(allCategories().map(c => c.id));
          patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
          toast(`Pulled ${state.entries.length} entries.`);
          notifySyncChange();
          renderBody();
          render();
        } else if (r.ok && !r.content) {
          toast(hasLocalDataToProtect() ? 'Cloud file is empty — local data was kept. Use Push to create it.' : 'Cloud file is empty.');
        } else {
          patchSyncSettings({ lastError: r.message || r.reason, lastErrorAt: new Date().toISOString() });
          toast('Pull failed: ' + (r.message || r.reason));
          notifySyncChange();
          renderBody();
        }
        } finally {
          syncExclusive = false;
        }
      } }, pullLabel);

      const pushBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: async () => {
        if (syncInFlight || syncExclusive) { toast('A sync is already in progress.'); return; }
        syncExclusive = true;
        try {
        pullBtn.disabled = true; pushBtn.disabled = true;
        pushLabel.textContent = 'Pushing…';
        const pushRevision = syncRevision;
        const payload = cloudPayload();
        const currentSync = getSyncSettings();
        const r = await syncPush(payload, { sha: currentSync.lastSha, message: 'cents: manual push' });
        pullBtn.disabled = false; pushBtn.disabled = false;
        pushLabel.textContent = 'Push';
        if (pushRevision !== syncRevision) {
          if (r.ok) patchSyncSettings({ lastSha: r.sha });
          toast('A newer local change was kept; queued for sync.');
          scheduleSyncPush();
          return;
        }
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
        } finally {
          syncExclusive = false;
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
          // Stop queued automatic pushes before removing credentials. A pending
          // timer must not revive a disconnected sync if the user reconnects
          // quickly; an in-flight request is protected by revision checks.
          cancelScheduledSyncPush();
          syncRevision++;
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
  // Clear any stuck toasts left over from a previous rapid-fire call.
  host.innerHTML = '';
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

// ---------- render scheduling ----------
function captureFocusedField() {
  const active = document.activeElement;
  const main = document.getElementById('app');
  // Never restore focus from a modal or another surface outside the app mount.
  // Those surfaces own their focus while the underlying app is rebuilt.
  if (!active || !main || !main.contains(active) || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return null;
  return {
    id: active.id || '',
    ariaLabel: active.getAttribute('aria-label') || '',
    type: active.getAttribute('type') || '',
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
  };
}

function restoreFocusedField(snapshot) {
  if (!snapshot) return;
  const main = document.getElementById('app');
  if (!main) return;
  const fields = main.querySelectorAll('input, textarea, select');
  const field = [...fields].find(candidate =>
    (snapshot.id && candidate.id === snapshot.id)
    || (snapshot.ariaLabel && candidate.getAttribute('aria-label') === snapshot.ariaLabel
      && (!snapshot.type || candidate.getAttribute('type') === snapshot.type))
  );
  if (!field) return;
  field.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && typeof field.setSelectionRange === 'function') {
    const end = snapshot.selectionEnd ?? snapshot.selectionStart;
    const length = field.value?.length ?? 0;
    field.setSelectionRange(Math.min(snapshot.selectionStart, length), Math.min(end, length));
  }
}

// ---------- top-level render ----------
function render() {
  if (renderFrame !== null) return;
  const flush = () => {
    renderFrame = null;
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
  };
  if (typeof window.requestAnimationFrame === 'function') renderFrame = window.requestAnimationFrame(flush);
  else renderFrame = window.setTimeout(flush, 0);
}

function _render() {
  const main = document.getElementById('app');
  if (!main) return;
  const focusedField = captureFocusedField();
    // Init dark mode + season on first render — dark is the default
  if (!document.documentElement.dataset.themeInit) {
    document.documentElement.dataset.themeInit = '1';
    try {
      const saved = localStorage.getItem('cents-theme');
      document.documentElement.dataset.theme = saved === 'light' ? '' : 'dark';
    } catch(e) {}
    setSeason();
  }
  // Keep the app mount completely empty while locked. The PIN overlay is
  // deliberately mounted before the first render, so a refresh never paints
  // financial UI behind it or briefly exposes the header/navigation.
  const locked = hasPinLock() && !pinUnlocked;
  const scrollY = window.scrollY;
  main.innerHTML = '';
  main.toggleAttribute('aria-hidden', locked);
  if (locked) return;
  main.removeAttribute('aria-hidden');
  main.appendChild(renderHeader());

  const route = currentRoute();
  const shouldAnimateScreen = route !== lastRenderedRoute;
  lastRenderedRoute = route;
  const screen = $('main', { class: `shell screen${shouldAnimateScreen ? '' : ' screen-static'}`, id: 'screen' });
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

  // Focus the Add form only when navigation created it. Same-route renders
  // restore the user's existing field/caret instead, so typing never jumps.
  if (shouldAnimateScreen && route === 'add') {
    const form = main.querySelector('[data-route-initial-focus="true"]');
    const target = form?.querySelector(`#${form.dataset.firstFocus || 'f-amount'}`);
    target?.focus({ preventScroll: true });
  }

  main.appendChild($('footer', { style: 'max-width:980px;margin:0 auto;padding:32px 28px 64px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;border-top:1px solid var(--line);' },
    $('span', null, String(state.entries.length), ' entries \u00b7 stored locally'),
    $('span', { style: 'display:flex;justify-content:flex-end;flex-wrap:wrap;gap:0 8px;align-items:center;' },
      $('button', { type: 'button', class: 'footer-action danger', onClick: function() {
        if (this.textContent === 'Reset') { this.textContent = 'Confirm reset'; return; }
        syncRevision++;
        state = resetToBlank();
        clearBalanceCaches();
        scheduleSyncPush();
        render();
        toast('All entries cleared.');
        this.textContent = 'Reset';
      } }, 'Reset'),
      $('button', { type: 'button', class: 'footer-action', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) }, '↑ Top'),
    ),
  ));

  window.scrollTo(0, scrollY);
  // Rebuilding a same-route screen should not make typing/searching lose focus
  // or move the caret. Newly opened forms still manage their own initial focus.
  if (!shouldAnimateScreen) restoreFocusedField(focusedField);

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

window.addEventListener('DOMContentLoaded', () => {
  // Create the gate before rendering the app mount. A configured PIN must be
  // the first interactive surface on every full page load.
  const locked = hasPinLock();
  if (locked) showPinLock();
  render();
  if (!locked) startInitSync();
});

// Expose tiny global for DevTools tinkering
window.__cents = {
  resetToBlank, render, toast,
  initSync, scheduleSyncPush, doAutoPush,
  renderSyncIndicator, openSyncSettings,
  syncPull, syncPush,
};
