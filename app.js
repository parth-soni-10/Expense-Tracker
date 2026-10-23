/* ============================================================
   Expense Tracker - editorial-minimal SPA
   Hash routing: #dashboard (default) | #add | #history | #balances | #insights
   ============================================================ */
import { loadState, saveState, resetToBlank, exportJSON, exportEntriesCsv, validateState, uid, updateAllowedCategories, updateAllowedMethods, isValidCheckpointDate, BALANCE_METHOD_IDS, saveUndoJournal, loadUndoJournal, clearUndoJournal, popUndoJournal, dropUndoJournal, UNDO_STACK_MAX, takeStorageNotice, loadStateFor, patchProfileSettings, parseBackup, parseEntriesCsv, CSV_REFUSAL, foreignWriteNeeded, readStateText, unreadableBackup, MAX_BACKUP_BYTES, downloadText } from './storage.js';
import { CATEGORIES, METHODS, TABS, HIDEABLE_TABS } from './seed.js';
import { getSyncSettings, patchSyncSettings, clearSyncSettings, getPrivacyPin, setPrivacyPin, clearPrivacyPin, getBiometricCredential, setBiometricCredential, clearBiometricCredential, DEFAULT_SYNC_ENDPOINT, isDefaultSyncEndpoint } from './settings.js';
import { syncPull, syncPush, syncTestConnection, syncStatus, syncCheckMirror, mirrorStatus, relativeTime, notifySyncChange, subscribeSync, syncIssueSetupToken, syncExchangeSetupToken, syncIssueProfileInvite, syncPushProfilePolicy } from './sync.js';
import { mergeStates } from './sync-merge.js';
import { listProfiles, activeProfile, createProfile, renameProfile, deleteProfile, setActiveProfileId, getActiveProfileId, hasSessionChoice, nsKey, profileEnvName, isAdminProfile, setProfileIcon } from './profiles.js';
// The Tesco Pay ENGINE only: what the dashboard's Tesco line needs. The screen,
// the roster reader, the photo pipeline and the workbook importer live in
// tesco.js and are fetched on the first visit to #tesco (see tescoScreen()).
import { monthSummary, holidayBalance, TESCO_RATE_DEFAULTS, TESCO_PAY_METHOD, weekStartOf, shiftPay, r2, isoLocal, receivedByPayDate, tescoPayLedgerWrites, tescoPayWriteWindow } from './tesco-pay.js';

// ---------- optional UI libraries (vendor/*) ----------
// Every integration below degrades gracefully: if a vendor file fails to
// load or is missing, the app falls back to its native behaviour. All of
// them — SweetAlert2 included — are fetched lazily on first use so the
// boot critical path stays light (just styles.css + this module).
const _fpInstances = new Set();    // flatpickr instances
const _tippyInstances = new Set(); // tippy.js instances
const _sortables = new Set();      // sortablejs instances
let _chipSortLast = 0;             // guards the click that ends a chip drag

// Fetch a vendored script (and/or stylesheet) exactly once. Resolves when the
// global it defines becomes available, rejects on network failure - callers
// always degrade gracefully.
const _vendorCache = new Map();
function loadVendor(name, { js, css } = {}) {
  if (!_vendorCache.has(name)) {
    _vendorCache.set(name, new Promise((resolve, reject) => {
      // Wait for EVERY requested asset (a lib's JS plus its optional CSS)
      // before resolving - settling on whichever loads first could resolve
      // while the JS global is still undefined, and the caller's one-shot
      // .then would then never wire the widget.
      let pending = 0;
      const done = () => { pending -= 1; if (pending <= 0) resolve(); };
      const fail = (asset) => reject(new Error('vendor asset failed: ' + asset));
      if (css) {
        pending += 1;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = css;
        link.onload = done;
        link.onerror = () => fail(css);
        document.head.appendChild(link);
      }
      if (js) {
        pending += 1;
        const s = document.createElement('script');
        s.src = js;
        s.async = true;
        s.onload = done;
        s.onerror = () => fail(js);
        document.head.appendChild(s);
      }
      if (pending === 0) resolve();
    }));
  }
  return _vendorCache.get(name);
}

// Destroy every vendored-widget instance before a re-render replaces the DOM.
function libCleanup() {
  for (const inst of _fpInstances) { try { inst.destroy(); } catch (e) {} }
  _fpInstances.clear();
  for (const inst of _tippyInstances) { try { inst.destroy(); } catch (e) {} }
  _tippyInstances.clear();
  for (const s of _sortables) { try { s.destroy(); } catch (e) {} }
  _sortables.clear();
}

// Themed confirm() replacement. Resolves true/false; falls back to the native
// synchronous confirm() only if SweetAlert2 genuinely fails to load.
// SweetAlert2 is lazy-loaded off the boot path: the first destructive action
// may beat the 49 KB script's download, so this waits for it (a few hundred
// ms cold, instant once the service worker has it cached) rather than showing
// a jarring native dialog for that one call.
async function swalConfirm({ title, text, confirmButtonText = 'Yes', cancelButtonText = 'Cancel', danger = false } = {}) {
  if (typeof Swal === 'undefined') {
    try {
      await loadVendor('swal2', { js: 'vendor/sweetalert2.min.js' });
    } catch (e) {
      return window.confirm(text || title);
    }
    if (typeof Swal === 'undefined') return window.confirm(text || title);
  }
  const result = await Swal.fire({
    title,
    text: text || undefined,
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText,
    buttonsStyling: false,
    customClass: {
      popup: 'swal-popup',
      title: 'swal-title',
      htmlContainer: 'swal-html',
      confirmButton: 'swal-confirm' + (danger ? ' swal-danger' : ''),
      cancelButton: 'swal-cancel',
    },
  });
  return result.isConfirmed;
}

// Themed date picker. Falls back to the native <input type="date">. The
// element's own "change" listeners still fire, so existing handlers keep
// working with or without the library. flatpickr is fetched on first use;
// the input is usable with the native picker meanwhile and is enhanced in
// place once the library arrives (re-rendered elements are skipped).
function wireFlatpickr(el, opts = {}) {
  if (!el) return null;
  if (typeof flatpickr !== 'undefined') return _wireFlatpickrNow(el, opts);
  loadVendor('flatpickr', { js: 'vendor/flatpickr.min.js', css: 'vendor/flatpickr.min.css' })
    .then(() => { if (el.isConnected) _wireFlatpickrNow(el, opts); })
    .catch(() => {});
  return null;
}

function _wireFlatpickrNow(el, { defaultDate, onChange } = {}) {
  if (!el || typeof flatpickr === 'undefined') return null;
  if (el._fp) { try { el._fp.destroy(); } catch (e) {} el._fp = null; }
  const inst = flatpickr(el, {
    dateFormat: 'Y-m-d',
    defaultDate: defaultDate || el.value || today(),
    allowInput: false,
    disableMobile: true,
    onChange: (selectedDates, dateStr) => {
      el.value = dateStr;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (onChange) onChange(dateStr, selectedDates);
    },
  });
  el._fp = inst;
  _fpInstances.add(inst);
  return inst;
}

// Chart popups via tippy.js delegation: the heat map's per-day popups, and the
// insights charts' per-mark figures — which are the only way to read a number off
// a chart, since a bar is a shape rather than a table cell. Falls back to the
// existing .heat-tip hover popups when tippy is unavailable. tippy + Popper are
// fetched lazily on first use; the CSS-only fallback covers the interim.
//
// One instance per scope, because `delegate` takes a single selector and the
// scopes are unrelated cards. Two attributes are served: `data-chart-tip` on a
// chart mark, and `data-tip` on a heat cell, which predates it. `has-tippy` on
// the scope is what suppresses the CSS-only fallback.
function wireChartTips(scopeEl, selector) {
  if (!scopeEl || typeof selector !== 'string') return;
  // A warm load wires the scope before it is mounted, which is fine: the
  // listeners are bound to the element itself and fire once it is in the tree.
  if (typeof tippy !== 'undefined' && typeof Popper !== 'undefined') return _wireChartTipsNow(scopeEl, selector);
  // The tippy bundle reads window.Popper, so load Popper first, then tippy.
  const popperReady = typeof Popper !== 'undefined'
    ? Promise.resolve()
    : loadVendor('popper', { js: 'vendor/popper.min.js' });
  popperReady
    .then(() => loadVendor('tippy', { js: 'vendor/tippy-bundle.umd.min.js' }))
    // On the cold path the screen is mounted by the time the library lands, so a
    // scope a re-render has since thrown away is skipped rather than wired blind.
    .then(() => { if (scopeEl.isConnected) _wireChartTipsNow(scopeEl, selector); })
    .catch(() => {});
}

function _wireChartTipsNow(scopeEl, selector) {
  if (!scopeEl || typeof tippy === 'undefined' || typeof Popper === 'undefined') return;
  scopeEl.classList.add('has-tippy'); // suppress the CSS-only .heat-tip fallback
  const inst = tippy(scopeEl, {
    delegate: selector,
    content: ref => ref.dataset.chartTip || ref.dataset.tip,
    allowHTML: false,
    theme: 'cents',
    placement: 'top',
    arrow: false,
    delay: [120, 40],
    duration: [160, 90],
    animation: 'none',
    appendTo: document.body,
    onShow(instance) { return !!(instance.reference.dataset.chartTip || instance.reference.dataset.tip); },
  });
  _tippyInstances.add(inst);
}

// Drag-to-reorder custom category chips (Add/Edit form). Built-in seed
// categories keep their fixed order; custom categories reorder around them.
// SortableJS is fetched lazily on first use; chips just aren't draggable
// until it arrives (or if it fails).
function wireChipSortable(containerEl) {
  if (!containerEl) return;
  if (typeof Sortable !== 'undefined') return _wireChipSortableNow(containerEl);
  loadVendor('sortable', { js: 'vendor/Sortable.min.js' })
    .then(() => { if (containerEl.isConnected) _wireChipSortableNow(containerEl); })
    .catch(() => {});
}

function _wireChipSortableNow(containerEl) {
  if (!containerEl || typeof Sortable === 'undefined') return;
  if (containerEl._sortable) { try { containerEl._sortable.destroy(); } catch (e) {} containerEl._sortable = null; }
  if (containerEl.querySelectorAll('[data-custom]').length < 2) return;
  const sortable = Sortable.create(containerEl, {
    animation: 160,
    ghostClass: 'sort-ghost',
    chosenClass: 'sort-chosen',
    onStart() { _chipSortLast = performance.now(); },
    onEnd() {
      _chipSortLast = performance.now();
      const customs = state.settings.customCategories || [];
      if (customs.length < 2) return;
      const customIds = new Set(customs.map(c => c.id));
      const byId = new Map(customs.map(c => [c.id, c]));
      const ordered = Array.from(containerEl.querySelectorAll('[data-custom]'))
        .map(b => b.dataset.id)
        .filter(id => customIds.has(id));
      if (ordered.length !== customs.length) return;
      const next = ordered.map(id => byId.get(id));
      if (next.some((c, i) => c !== customs[i])) {
        state.settings.customCategories = next;
        persist();
        toast('Category order saved.');
      }
    },
  });
  containerEl._sortable = sortable;
  _sortables.add(sortable);
}// ---------- state ----------

let state = loadState();

// One-time boot migration: the retired `settled` transfer flag is no longer
// part of the data model. validateState drops it during load, and this write
// back makes the next load start from the cleaned state too - so stored data,
// not just memory, reflects the removal (and any settled-dependent display
// recalculates naturally, since nothing reads the flag anymore).
if (state.entries.some(e => 'settled' in e)) {
  state = validateState(state);
  saveState(state);
}

// Keep storage.js validation sets in sync with seed + the user's own. Both
// matter for the same reason: validateEntry DROPS a row whose category or
// method id is unknown to storage.js, so a set that lags the document deletes
// the entries that used the missing id on the next load.
updateAllowedCategories([...CATEGORIES, ...(state.settings.customCategories || [])].map(c => c.id));
updateAllowedMethods(everyMethod().map(m => m.id));
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
// A boot-time sync setup link cannot toast while the PIN overlay is up
// (it sits above the toast layer), so the message is queued and shown the
// moment the device is unlocked.
let pendingSetupLinkToast = null;

// Warnings raised while an overlay still covers the toast layer (an unreadable
// stored document, a failed save). Queueing them is what stops the app from
// telling someone their data is fine when it could not be written.
const deferredNotices = [];
let saveFailureNotified = false;
const overlayVisible = () => !!pinOverlay || !!document.querySelector('.modal-bg');
function raiseNotice(text) {
  if (overlayVisible()) deferredNotices.push(text);
  else toast(text);
}
function flushNotices() {
  // Same guard as raising: a queued notice must not be toasted behind an
  // overlay either, or it silently expires before the user can see it.
  if (overlayVisible()) return;
  while (deferredNotices.length) toast(deferredNotices.shift());
}
// A parsed but not-yet-confirmed sync setup link (see applySetupLinkIfPresent).
// Stashed at boot, applied only after the user confirms post-unlock.
let pendingSetupLink = null;
let syncBootStarted = false;
// Which route the last render drew. A route CHANGE scrolls to the top and takes
// the initial focus the new screen asks for; a same-route re-render keeps them.
// It is not about animation: nothing animates on either path (see styles.css).
let lastRenderedRoute = null;
// A render lands on the next animation frame — that one frame is the whole of the
// deferral a route change pays. Nothing is handed to the browser to animate and
// nothing is waited on. See renderRoute().
let renderFrame = null;

function startInitSync() {
  if (syncBootStarted) return;
  syncBootStarted = true;
  initSync().finally(() => setSyncPulsing(false));
  startSyncPolling();
}

// Personal PINs are stored as PBKDF2-SHA256 (310k iterations) with a per-
// device random salt. The salt still lives next to the hash in device storage
// (the lock is casual-access protection), but the work factor makes offline
// cracking of a leaked hash impractical instead of instant.
const PBKDF2_ITERATIONS = 310_000;
async function hashPin(pin, salt = '') {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(String(salt === null ? '' : salt)), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Legacy salted SHA-256 derivation, kept only to verify hashes written before
// the PBKDF2 upgrade. A successful legacy check re-saves with PBKDF2.
async function hashPinLegacy(pin, salt = '') {
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

// There is no built-in PIN, and no shipped credential of any kind. A device is
// locked only when a PIN exists on it: the device-only hash in settings.js, or
// — for a document written before that storage existed — the legacy in-state
// hash. No PIN means NO LOCK, which is the whole of the rule: nothing in the
// source can open somebody's ledger, and there is no default whose advice
// ("set your own PIN") the app has to keep repeating.
function getPinCredential() {
  const devicePin = getPrivacyPin();
  if (devicePin.hash) return devicePin;
  const legacyHash = state?.settings?.pinHash;
  if (typeof legacyHash === 'string' && /^[a-f0-9]{64}$/i.test(legacyHash)) {
    return { salt: null, hash: legacyHash.toLowerCase(), kdf: null };
  }
  return null;
}

/** Is this device locked? Only while it holds a credential to check.
 *
 *  Cached for the session, because this is read on every render AND on every
 *  interaction — resetIdleLock is bound to pointerdown, keydown, wheel and
 *  touchstart — and each uncached answer is a localStorage read plus a JSON
 *  parse. Only three things can change it: a PIN being set, a PIN being removed,
 *  and a profile switch (the credential is namespaced per profile), and each of
 *  those clears the cache where it happens. */
let pinLockCache = null;
function hasPinLock() {
  if (pinLockCache === null) pinLockCache = !!getPinCredential();
  return pinLockCache;
}
function forgetPinLock() { pinLockCache = null; }

// ---------- Biometric unlock (fingerprint / Face ID) ----------
// Uses the Web Authentication API with the platform authenticator, so on
// mobile the OS fingerprint / Face ID prompt does the verification. The
// credential ID is device-only (settings.js) and never leaves localStorage,
// like the PIN hash. Where no platform authenticator exists (desktop without
// Touch ID / Windows Hello, plain-HTTP contexts) the PIN stays the only path
// and these helpers simply no-op.
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64URL_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '';
    out += i + 2 < bytes.length ? B64URL_ALPHABET[b2 & 63] : '';
  }
  return out;
}
function b64urlDecode(str) {
  const out = [];
  let buf = 0, bits = 0;
  for (const c of String(str)) {
    const v = B64URL_ALPHABET.indexOf(c);
    if (v === -1) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}
// Biometric unlock is a mobile-only convenience: the OS fingerprint / Face ID
// prompt is the natural unlock on phones, but on desktops (Windows Hello,
// Touch ID) it would surface a button nobody asked for there - so the whole
// biometric surface is gated behind this check.
function isMobileDevice() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}
let _bioSupported = null;
function biometricSupported() {
  if (_bioSupported !== null) return _bioSupported;
  _bioSupported = (async () => {
    try {
      return Boolean(
        isMobileDevice() &&
        globalThis.isSecureContext &&
        typeof window.PublicKeyCredential === 'function' &&
        typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function' &&
        await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      );
    } catch { return false; }
  })();
  return _bioSupported;
}
function biometricLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'Face ID';
  if (/Android/i.test(ua)) return 'fingerprint';
  if (/Macintosh/i.test(ua)) return 'Touch ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  return 'biometrics';
}
function hasBiometricCredential() {
  return !!getBiometricCredential();
}
async function registerBiometric() {
  if (!await biometricSupported()) return { ok: false, reason: 'unsupported' };
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const user = new Uint8Array(16);
    crypto.getRandomValues(user);
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { id: location.hostname, name: 'cents.' },
        user: { id: user, name: 'cents-device', displayName: 'cents.' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 60000,
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        attestation: 'none',
      },
    });
    if (!cred || !cred.rawId) return { ok: false, reason: 'failed' };
    if (!setBiometricCredential(b64urlEncode(new Uint8Array(cred.rawId)))) return { ok: false, reason: 'failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'NotAllowedError' ? 'cancelled' : 'failed' };
  }
}
async function unlockWithBiometric() {
  const stored = getBiometricCredential();
  if (!stored) return { ok: false, reason: 'none' };
  if (!await biometricSupported()) return { ok: false, reason: 'unsupported' };
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: b64urlDecode(stored.credentialId) }],
        userVerification: 'required',
      },
    });
    return { ok: true };
  } catch (err) {
    // NotAllowedError = user cancelled or the OS credential was removed.
    return { ok: false, reason: err && err.name === 'NotAllowedError' ? 'cancelled' : 'failed' };
  }
}

function closePinOverlay() {
  if (pinOverlay) { pinOverlay.remove(); pinOverlay = null; }
}

// The post-unlock sequence shared by the PIN path and the biometric path:
// sync boot and the persisted-undo offer both wait until the lock is open.
function completeUnlock() {
  pinUnlocked = true;
  pinFailures.length = 0;   // a correct PIN is the end of a guessing run
  closePinOverlay();
  render();
  startInitSync();
  offerPersistedUndo();
  flushNotices();
  resetIdleLock();
  if (pendingSetupLinkToast) {
    toast(pendingSetupLinkToast);
    pendingSetupLinkToast = null;
  }
  if (pendingSetupLink) queueMicrotask(confirmPendingSetupLink);
}

// ---------- device PIN throttle ----------
// The lock is casual-access protection, not a vault — but "casual" is not
// "none": an unlocked phone handed to someone else is a guessing machine
// without this, and every PIN now belongs to one device only. Same shape as the server's failureThrottle
// (netlify/functions/lib/auth.mjs): a SLIDING window of failures, after which
// the door stops answering until the oldest one ages out. In-memory on
// purpose — a counter in localStorage is a counter the guesser can delete, and
// a reload is the obvious workaround either way.
const PIN_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
const PIN_THROTTLE_MAX = 15;
const pinFailures = [];   // timestamps, oldest first

/** Seconds until the door answers again, 0 while it still does. The window
 *  slides: the lock lifts when the OLDEST failure in it ages out. */
function pinThrottleRemaining(now = Date.now()) {
  const cutoff = now - PIN_THROTTLE_WINDOW_MS;
  while (pinFailures.length && pinFailures[0] < cutoff) pinFailures.shift();
  if (pinFailures.length < PIN_THROTTLE_MAX) return 0;
  return Math.max(1, Math.ceil((pinFailures[0] + PIN_THROTTLE_WINDOW_MS - now) / 1000));
}

function pinFailure() { pinFailures.push(Date.now()); }

function showPinLock() {
  // A caller that does not check first still cannot invent a lock: with no
  // credential there is nothing to ask for, and an overlay would be a door with
  // no lock behind it.
  if (pinUnlocked || pinOverlay || !hasPinLock()) return;
  const label = biometricLabel();
  // new-password (not off): tells desktop browsers this is not a credential
  // field, so the phone-registered passkey/fingerprint credential synced into
  // Chrome/Safari autofill never gets offered on the website - the website is
  // PIN-only, biometrics stay mobile.
  const input = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'PIN', 'aria-label': 'PIN', style: 'width:100%;text-align:center;letter-spacing:.35em;font-size:24px;' });
  const message = $('p', { class: 'muted', style: 'font-size:13px;text-align:center;min-height:20px;margin:12px 0;' }, 'Enter your PIN.');
  // Verify a candidate PIN against the stored credential. Returns true on match.
  const verifyPin = async (value) => {
    const saved = getPinCredential();
    if (!saved) return false;
    try {
      if (saved.salt !== null) {
        if (saved.kdf === 'pbkdf2') {
          return (await hashPin(value, saved.salt)) === saved.hash;
        }
        // Legacy salted SHA-256 (pre-upgrade). Verify, then silently upgrade
        // the stored credential to PBKDF2 with a fresh salt.
        const legacyOk = (await hashPinLegacy(value, saved.salt)) === saved.hash;
        if (legacyOk) {
          try {
            const freshSalt = globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
            setPrivacyPin(await hashPin(value, freshSalt), freshSalt, 'pbkdf2');
          } catch (err) { /* keep the legacy credential; verification still succeeds */ }
        }
        return legacyOk;
      } else if (globalThis.crypto?.subtle) {
        // Plain SHA-256 path: a legacy unsalted hash, which a document could
        // still carry. Nothing writes one any more.
        return (await hashPinPlain(value)) === saved.hash;
      } else {
        // No Web Crypto (plain-HTTP context): a credential that needs it cannot
        // be checked at all. The message below says so rather than pretending
        // the PIN was wrong.
        return false;
      }
    } catch (err) {
      return false;
    }
  };
  const submit = async () => {
    const value = String(input.value || '').trim();
    if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) { message.textContent = 'Use 4-20 letters or numbers.'; input.focus(); return; }
    // Checked BEFORE hashing: while the door is shut, answering is the point.
    // PBKDF2 already costs ~a third of a second an attempt, which is a throttle
    // of its own — this one is what stays after a reload, and what says why.
    const wait = pinThrottleRemaining();
    if (wait > 0) {
      message.textContent = `Too many attempts. Try again in ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, '0')}.`;
      input.value = '';
      return;
    }
    if (!(await verifyPin(value))) {
      pinFailure();
      const left = pinThrottleRemaining();
      if (left > 0) {
        message.textContent = `Too many attempts. Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
        input.value = '';
        return;
      }
      message.textContent = globalThis.crypto?.subtle
        ? 'That PIN is not correct.'
        : 'PIN verification needs a secure (HTTPS) connection on this device.';
      input.value = '';
      input.focus();
      return;
    }
    completeUnlock();
  };
  // Biometric surface (filled in once the platform-authenticator check
  // resolves) and the PIN surface. On phones with a registered credential the
  // fingerprint / Face ID button is the primary unlock and the PIN input stays
  // hidden behind a "Use PIN instead" toggle; everywhere else the PIN shows
  // first, exactly as before.
  const bioArea = $('div', null);
  const pinArea = $('div', { style: 'display:none;' },
    input,
    $('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%;margin-top:12px;', onClick: submit }, 'Unlock'),
  );
  let bioBusy = false;
  const attemptBio = (auto) => {
    if (bioBusy) return;
    bioBusy = true;
    message.textContent = 'Touch ' + label + ' when prompted.';
    unlockWithBiometric().then(res => {
      bioBusy = false;
      if (!pinOverlay) return;
      if (res.ok) {
        completeUnlock();
      } else if (auto) {
        // The automatic prompt can be suppressed by the browser when there is
        // no user gesture yet (some Android builds) - keep the door open.
        message.textContent = 'Tap ' + label + ' to unlock, or use your PIN.';
      } else {
        // The PIN input lives behind the "Use PIN instead" toggle here.
        message.textContent = res.reason === 'cancelled'
          ? 'Fingerprint cancelled - tap again or use your PIN.'
          : 'Fingerprint unavailable - use your PIN.';
      }
    });
  };
  const showPin = () => {
    bioArea.style.display = 'none';
    pinArea.style.display = '';
    message.textContent = 'Enter your PIN.';
    queueMicrotask(() => input.focus());
  };
  const showBio = () => {
    bioArea.style.display = '';
    pinArea.style.display = 'none';
    attemptBio(false);
  };
  // The locked view is the whole page while it is up: `_render()` empties #app
  // and returns before it mounts anything, so the landmark and the heading have
  // to come from here. Measured on 15 Oct 2026 as the one view with no `main`
  // and no `h1` in the accessibility tree — the dialog's own aria-label is not a
  // heading, and a reader that navigates by landmark had nothing to land on.
  // <main> for the view, and the wordmark promoted from a div to the <h1>.
  const overlay = $('main', { class: 'modal-bg pin-lock-bg', style: 'z-index:10000;background:rgba(0,0,0,.82);' },
    $('div', { class: 'modal pin-lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Unlock cents', style: 'max-width:360px;text-align:center;' },
      $('h1', { class: 'serif', style: 'font-size:32px;font-weight:400;margin:0 0 4px;' }, 'cents.'),
      $('p', { class: 'eyebrow', style: 'margin:0;' }, 'Privacy lock'),
      $('p', { class: 'serif', style: 'font-size:18px;margin:20px 0 4px;' }, 'Welcome back.'),
      message,
      bioArea,
      pinArea,
    ),
  );
  pinOverlay = overlay;
  document.body.appendChild(overlay);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  // Auto-unlock the moment the typed PIN matches the stored one, so the user
  // never has to press Enter after the final character.
  input.addEventListener('input', async () => {
    const value = String(input.value || '').trim();
    if (value.length < 4 || !/^[a-zA-Z0-9]+$/.test(value)) return;
    if (await verifyPin(value)) {
      if (pinOverlay && !pinUnlocked) completeUnlock();
    }
  });
  biometricSupported().then(ok => {
    if (!pinOverlay) return;
    if (!ok) {
      // No platform authenticator on this device (desktop, plain HTTP):
      // the PIN is the only path, shown as before.
      pinArea.style.display = '';
      queueMicrotask(() => input.focus());
      return;
    }
    if (!hasBiometricCredential()) {
      // Phone with no credential registered yet: PIN first, offer enrollment.
      pinArea.style.display = '';
      queueMicrotask(() => input.focus());
      bioArea.append($('button', { type: 'button', class: 'btn-link', style: 'margin:14px 0 6px;', onClick: () => {
        message.textContent = 'Enable ' + label + '? Verify with ' + label + ' when prompted.';
        registerBiometric().then(res => {
          if (!pinOverlay) return;
          if (res.ok) {
            completeUnlock();
            toast('Fingerprint unlock enabled.');
          } else if (res.reason === 'cancelled') {
            message.textContent = 'Not enabled - use your PIN.';
            input.focus();
          } else {
            message.textContent = 'Fingerprint is not available on this device - use your PIN.';
            input.focus();
          }
        });
      } }, 'Enable ' + label + ' unlock'));
      return;
    }
    // Phone with a registered credential: biometrics is the primary unlock.
    // The PIN input stays hidden until the user asks for it.
    bioArea.append(
      $('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%;', onClick: () => attemptBio(false) }, 'Unlock with ' + label),
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'width:100%;margin-top:10px;', onClick: showPin }, 'Use PIN instead'),
    );
    pinArea.append($('button', { type: 'button', class: 'btn btn-ghost', style: 'width:100%;margin-top:10px;', onClick: showBio }, 'Use ' + label + ' instead'));
    message.textContent = 'Touch ' + label + ' when prompted.';
    // Fire the OS prompt automatically once the lock screen has painted.
    // iOS 16+ allows one gesture-free credentials.get per page load, so the
    // fingerprint / Face ID prompt appears without any tap; on browsers that
    // suppress it the button above is the graceful fallback.
    setTimeout(() => { if (pinOverlay && !pinUnlocked) attemptBio(true); }, 350);
  });
}

// ---------- first-run onboarding ----------
// A short three-step setup shown on a genuinely fresh install (no entries, no
// checkpoints, no PIN). It offers a PIN, a monthly budget, and one main account
// with its opening balance — but every step, the PIN included, can be skipped,
// and skipping the PIN leaves the app unlocked rather than a built-in
// credential holding it shut. Onboarding is marked complete either way; it
// never blocks access.
function needsOnboarding() {
  if (state.settings.onboarded) return false;
  if (state.entries.length > 0) return false;
  if (hasPinLock()) return false;
  return !Object.values(state.settings.balanceCheckpoints || {}).some(points => Array.isArray(points) && points.length > 0);
}

function showOnboarding() {
  if (pinUnlocked || pinOverlay) return;
  pinUnlocked = true; // the dashboard renders behind the overlay; no lock screen on first boot
  resetIdleLock();

  // No inline outline:none — the stylesheet's :focus-visible ring is the focus
  // indicator, and an inline reset would outrank it (it is still the border
  // colour that shifts on mouse focus).
  const inputStyle = 'width:100%;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:12px 14px;font-size:15px;transition:border-color .15s;box-sizing:border-box;';
  const focusRing = (e) => { e.target.style.borderColor = 'var(--accent)'; };
  const field = (label, input) => $('div', { style: 'margin-bottom:14px;' },
    $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:6px;' }, label),
    input,
  );

  const titleEl = $('h1', { style: 'font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0 0 6px;' });
  const subEl = $('p', { class: 'muted', style: 'font-size:13px;line-height:1.5;margin:0 0 20px;min-height:20px;' });
  const bodyEl = $('div', { style: 'margin-bottom:22px;' });
  const primaryEl = $('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%;' });
  const skipEl = $('button', { type: 'button', class: 'btn-link', style: 'margin-top:12px;width:100%;text-align:center;' });
  const dotsEl = $('div', { class: 'onboarding-dots', style: 'display:flex;gap:6px;justify-content:center;margin-bottom:20px;', 'aria-hidden': 'true' });

  const card = $('div', { class: 'modal onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set up cents', style: 'max-width:420px;' },
    $('div', { class: 'serif', style: 'font-size:30px;margin-bottom:2px;' }, 'cents.'),
    $('p', { class: 'eyebrow', style: 'margin:0 0 16px;' }, 'Set up'),
    dotsEl,
    titleEl, subEl, bodyEl, primaryEl, skipEl,
  );
  const overlay = $('div', { class: 'modal-bg onboarding-bg', style: 'z-index:10001;background:rgba(0,0,0,.82);' }, card);

  let step = 0;
  const setDots = () => {
    dotsEl.replaceChildren();
    ['PIN', 'Budget', 'Account'].forEach((label, i) => {
      dotsEl.append($('span', {
        class: 'onboarding-dot' + (i === step ? ' active' : ''),
        style: `width:${i === step ? '20px' : '6px'};height:6px;border-radius:999px;background:${i === step ? 'var(--accent)' : 'var(--muted)'};transition:all .2s;opacity:${i === step ? '1' : '.35'};`,
      }));
    });
  };

  const advance = () => { step += 1; draw(); };
  const finish = () => {
    state.settings.onboarded = true;
    persist();
    overlay.remove();
    pinOverlay = null;
    render();
    startInitSync();
    // Skipping the PIN step is a real choice with a visible consequence — no
    // PIN means no lock — so the toast names it once, where it can be read,
    // instead of leaving the user to discover it on the next reload.
    toast(hasPinLock()
      ? 'cents. is ready. Add an expense any time.'
      : 'cents. is ready. No PIN is set, so cents. opens without a lock \u2014 set one any time in \u2630 \u2192 Privacy & security.');
    flushNotices();
    if (pendingSetupLinkToast) { toast(pendingSetupLinkToast); pendingSetupLinkToast = null; }
    if (pendingSetupLink) queueMicrotask(confirmPendingSetupLink);
  };
  const draw = () => {
    setDots();
    if (step === 0) {
      titleEl.textContent = 'Choose your PIN';
      subEl.textContent = 'Locks cents. on this device. Any 4-20 letters or numbers — or skip to leave it open.';
      const pin = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'PIN', 'aria-label': 'New PIN', style: inputStyle, onFocus: focusRing });
      const confirm = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'Repeat PIN', 'aria-label': 'Repeat PIN', style: inputStyle, onFocus: focusRing });
      bodyEl.replaceChildren(field('New PIN', pin), field('Repeat PIN', confirm));
      primaryEl.textContent = 'Continue';
      // Skipping leaves NO PIN, and therefore no lock. There is no default to
      // fall back to, which is why the button says what it does rather than
      // naming a credential the app used to ship.
      skipEl.textContent = 'Skip — no lock';
      primaryEl.onclick = async () => {
        const value = pin.value.trim();
        if (!value) { subEl.textContent = 'Choose a PIN, or tap "Skip — no lock".'; pin.focus(); return; }
        if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) { subEl.textContent = 'Use 4-20 letters or numbers.'; pin.focus(); return; }
        if (value !== confirm.value.trim()) { subEl.textContent = 'The PINs do not match.'; confirm.focus(); return; }
        try {
          if (!globalThis.crypto?.getRandomValues) throw new Error('no crypto');
          const salt = globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
          if (!setPrivacyPin(await hashPin(value, salt), salt, 'pbkdf2')) { subEl.textContent = 'Could not save the PIN on this device.'; return; }
          forgetPinLock();
          if (state.settings?.pinHash) delete state.settings.pinHash;
          advance();
        } catch {
          subEl.textContent = 'PIN security is unavailable in this browser - you can skip the PIN.';
        }
      };
      skipEl.onclick = advance;
      queueMicrotask(() => pin.focus());
    } else if (step === 1) {
      titleEl.textContent = 'Monthly budget';
      subEl.textContent = 'A soft limit to measure your spending against.';
      const currency = state.settings.currency || '€';
      const budget = $('input', { type: 'text', inputmode: 'decimal', placeholder: String(+state.settings.monthlyBudget || ''), 'aria-label': 'Monthly budget', autocomplete: 'off', style: inputStyle, onFocus: focusRing });
      bodyEl.replaceChildren(field('Budget per month', $('div', { style: 'position:relative;' },
        $('span', { style: `position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:15px;color:var(--muted);` }, currency),
        budget,
      )));
      // Keep the input's own padding, add left room for the currency prefix.
      budget.style.paddingLeft = '34px';
      primaryEl.textContent = 'Continue';
      skipEl.textContent = 'Skip';
      primaryEl.onclick = () => {
        const value = parseFloat(budget.value);
        if (Number.isFinite(value) && value >= 0) {
          state.settings.monthlyBudget = Math.min(value, 1_000_000);
          persist();
        }
        advance();
      };
      skipEl.onclick = advance;
      budget.addEventListener('keydown', e => { if (e.key === 'Enter') primaryEl.onclick(); });
      queueMicrotask(() => budget.focus());
    } else {
      titleEl.textContent = 'Your main account';
      subEl.textContent = 'Where most of your money lives. Set its current balance to reconcile against.';
      const select = $('select', { 'aria-label': 'Main account', 'data-glide': true, 'data-glide-menu-width': '200', style: inputStyle });
      ACCOUNT_METHOD_IDS.forEach(id => select.append($('option', { value: id }, methodLabel(id))));
      const balance = $('input', { type: 'text', inputmode: 'decimal', placeholder: 'Current balance', 'aria-label': 'Current balance', autocomplete: 'off', style: inputStyle, onFocus: focusRing });
      bodyEl.replaceChildren(field('Account', select), field('Current balance', balance));
      primaryEl.textContent = 'Done';
      skipEl.textContent = 'Skip for now';
      primaryEl.onclick = () => {
        const value = parseFloat(balance.value);
        if (Number.isFinite(value)) saveBalanceCheckpoint(select.value, today(), value);
        finish();
      };
      skipEl.onclick = finish;
      balance.addEventListener('keydown', e => { if (e.key === 'Enter') primaryEl.onclick(); });
      queueMicrotask(() => balance.focus());
    }
  };

  document.body.appendChild(overlay);
  draw();
}

function lockApp() {
  // With no PIN there is no lock to take back: a caller that asked anyway (the
  // menu row is hidden, but the undo/back paths are not the only callers) must
  // leave the session as it is rather than marking it locked behind a screen
  // that will never ask for anything.
  if (!hasPinLock()) return;
  pinUnlocked = false;
  render();
  showPinLock();
}

// ---------- re-locking: idle and the app switcher ----------
// The lock is the whole of this app's access control — localStorage has no
// session and no server to challenge a request — so "unlocked" has to be a
// state the app can take back by itself: a phone set down mid-screen, an
// app-switcher swipe, a tab left behind for the afternoon. Two rules, in one
// place because they share one door:
//
//  1. Untouched for IDLE_LOCK_MS → locked again. This is the ONLY time-based
//     lock, and it is about absence rather than about where the window is:
//     five minutes without a keystroke or a tap locks the app whether that
//     five minutes was spent in front of you or in a background tab.
//  2. The moment the document hides, an opaque cover goes over it. The
//     app-switcher snapshot is taken WHILE hidden, so a cover that waited for
//     the return would be one screenshot too late; it also cannot be a blur
//     (nothing here may re-sample the page behind it, see styles.css), so it
//     paints the app's own surface instead.
//
// There used to be a third: hidden for HIDDEN_LOCK_MS (30s) → locked on the way
// back, measured on RETURN because a hidden tab's timers are throttled past any
// useful resolution. It was removed on 16 Oct 2026 because it charged the PIN
// for every glance at another tab, and a tab switch is not an absence. Nothing
// about the exposure it was covering went away: the cover is still painted the
// instant the window hides, and a real absence still ends in the lock screen via
// rule 1, which runs while hidden too (the timer is armed on the last genuine
// interaction and fires on its own).
const IDLE_LOCK_MS = 5 * 60 * 1000;
let idleTimer = null;

/** Restart the idle clock. Called on every interaction while unlocked; a call
 *  while locked arms nothing, so the lock screen cannot keep itself awake. */
function resetIdleLock() {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  // A session with no PIN is never "unlocked" in the sense that matters here:
  // there is nothing to re-lock, and arming a timer that calls lockApp() would
  // leave pinUnlocked false with no overlay to explain it.
  if (!pinUnlocked || !hasPinLock()) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pinUnlocked) lockApp();
  }, IDLE_LOCK_MS);
}

let privacyCover = null;
function showPrivacyCover() {
  if (privacyCover) return;
  // Fixed and above everything, opaque, and inert to input: a click that lands
  // the instant the app returns must reach the app rather than the cover.
  privacyCover = $('div', {
    id: 'privacy-cover',
    'aria-hidden': 'true',
    style: 'position:fixed;inset:0;z-index:100000;background:var(--bg, #101210);display:flex;align-items:center;justify-content:center;pointer-events:none;',
  }, $('span', { style: 'font-family:"Space Grotesk",sans-serif;font-size:20px;letter-spacing:-0.02em;color:var(--muted, #8C928A);' }, 'cents.'));
  document.body.appendChild(privacyCover);
}
function hidePrivacyCover() {
  if (!privacyCover) return;
  privacyCover.remove();
  privacyCover = null;
}

// Interaction only restarts a clock — never unlocks, never touches state.
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  document.addEventListener(ev, resetIdleLock, { passive: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (pinUnlocked) showPrivacyCover();
    return;
  }
  // Coming back is what an unlock is: the cover comes off and the idle clock
  // restarts. Deliberately no lockApp() here — the tab you just left is the
  // same unlocked session you come back to, and only rule 1 ends one.
  hidePrivacyCover();
  resetIdleLock();
});

// ================= Profiles (Netflix-style) =================
// Profiles are device-local spaces with separate entries, balances, PINs and
// cloud files. The gate below decides what the user meets first: a single
// profile boots straight into the classic flow (lock or onboarding); a tab
// that has already answered "who's tracking?" lands on that profile's lock;
// a fresh visit with several profiles meets the picker. "Who are you?" then
// "PIN?" — in that order, so nobody is ever asked for a PIN before an identity.

/** "sam-p" -> "Sam P" — the display name to offer for an adopted profile. */
function profileNameFromId(id) {
  const words = String(id).split('-').filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Profile';
}

function initialOf(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

// ---------- profile pictures ----------
// Inline SVG glyphs on a colour derived from the profile id: no image files, so
// there is nothing extra to fetch before the picker can paint and nothing for
// the service worker to cache-bust. Like the name, the choice lives on the
// device registry (profiles.js) — it is picked before unlock and never syncs.
const AVATAR_ART = {
  cat: '<path d="M5.5 9.5V4l3.6 3M18.5 9.5V4l-3.6 3"/><circle cx="12" cy="13" r="6.2"/><path d="M9.6 12.4v.02M14.4 12.4v.02M10.2 16c1.1.7 2.5.7 3.6 0M5.8 13.5H3.2M20.8 13.5h-2.6"/>',
  dog: '<circle cx="12" cy="12.5" r="6.2"/><path d="M6.2 7.4C4.2 7.6 3 9.2 3 11.2s1.2 3.2 3.2 3.4M17.8 7.4c2 .2 3.2 1.8 3.2 3.8s-1.2 3.2-3.2 3.4"/><circle cx="12" cy="15" r="1.8"/><path d="M12 17v2.2"/>',
  bear: '<circle cx="7.2" cy="6.8" r="2.6"/><circle cx="16.8" cy="6.8" r="2.6"/><circle cx="12" cy="13.4" r="6.4"/><circle cx="12" cy="15" r="2.4"/><path d="M10.4 11.4v.02M13.6 11.4v.02"/>',
  fox: '<path d="M4.6 5.2l3.3 4.5M19.4 5.2l-3.3 4.5"/><path d="M12 20.6c3.6 0 6.5-2.9 6.5-6.5S15.6 6.2 12 6.2 5.5 10.2 5.5 14.1 8.4 20.6 12 20.6z"/><path d="M9.7 12.8v.02M14.3 12.8v.02M12 16.6l1.6-1.3H10.4z"/>',
  robot: '<path d="M12 2.8v3"/><rect x="4.8" y="5.8" width="14.4" height="12.4" rx="3"/><path d="M2.6 10.8v3M21.4 10.8v3M9.5 10.8v.02M14.5 10.8v.02M9.8 14.8h4.4"/>',
  ghost: '<path d="M6 20.4V11.6a6 6 0 0112 0v8.8l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4z"/><path d="M10 11.2v.02M14 11.2v.02"/>',
  rocket: '<path d="M12 2.8c2.6 1.9 3.8 5.1 3.8 8.5l2.4 3.2-2.8.4-.9 3.1-2.5-1.7-2.5 1.7-.9-3.1-2.8-.4 2.4-3.2c0-3.4 1.2-6.6 3.8-8.5z"/><circle cx="12" cy="9.6" r="1.7"/>',
  star: '<path d="M12 3.4l2.7 5.5 6 .9-4.35 4.24L17.4 20l-5.4-2.85L6.6 20l1.05-5.96L3.3 9.8l6-.9z"/>',
  heart: '<path d="M12 20.4S4.6 15.8 4.6 10.9A4.1 4.1 0 0112 8.2a4.1 4.1 0 017.4 2.7c0 4.9-7.4 9.5-7.4 9.5z"/>',
  bolt: '<path d="M13.4 2.6L5.4 13.2h5.6L10.6 21.4l8-10.6h-5.6z"/>',
  moon: '<path d="M20.4 14.6A8.6 8.6 0 019.4 3.6a8.6 8.6 0 1011 11z"/>',
  football: '<circle cx="12" cy="12" r="8.2"/><path d="M12 8.4l3.2 2.3-1.2 3.7h-4L8.8 10.7z"/>',
  gamepad: '<rect x="2.4" y="7.6" width="19.2" height="9.4" rx="4.4"/><path d="M7.4 10.4v3.6M5.6 12.2h3.6M15.8 11.6v.02M18 14v.02"/>',
  music: '<path d="M9.4 17.6V6.4l8.6-2v11.2"/><circle cx="6.8" cy="17.8" r="2.6"/><circle cx="15.4" cy="15.6" r="2.6"/>',
  pizza: '<path d="M12 20.6L4.4 6.2a16 16 0 0115.2 0z"/><circle cx="12" cy="11" r="1"/><circle cx="9.4" cy="15.4" r="1"/><circle cx="14.6" cy="15.4" r="1"/>',
  crown: '<path d="M3.6 17.6L2.6 7.4l5 3.4L12 5.4l4.4 5.4 5-3.4-1 10.2z"/><path d="M4.6 20.4h14.8"/>',
  smile: '<circle cx="12" cy="12" r="8.2"/><path d="M8.6 13.6a4.6 4.6 0 006.8 0M9.6 9.6v.02M14.4 9.6v.02"/>',
  flower: '<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="6" r="2.4"/><circle cx="17.2" cy="9.8" r="2.4"/><circle cx="15.2" cy="15.8" r="2.4"/><circle cx="8.8" cy="15.8" r="2.4"/><circle cx="6.8" cy="9.8" r="2.4"/>',
};
// Eight background hues, all dark enough to carry a white glyph in either
// theme. Which one a profile gets is derived from its id, so the colour is
// stable across devices and changing the picture never changes the colour.
const AVATAR_COLORS = ['#35B877', '#4C7DF0', '#B8862B', '#C2547A', '#7C5CE0', '#2E8C9E', '#B5543A', '#5E8C3F'];
function avatarColor(profileId) {
  let hash = 0;
  for (const ch of String(profileId)) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function avatarGlyph(icon) {
  const art = AVATAR_ART[icon];
  return art ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${art}</svg>` : null;
}
/** One avatar box for a profile, wearing the profile-derived colour so that
 *  picking a picture never changes it. `icon` is explicit because the picker
 *  draws every choice for one profile.
 *
 *  A glyph that is missing for any reason falls back to the initial, because
 *  `$` silently skips a non-string `innerHTML` (it will not write the word
 *  "undefined" into an element) and what a missed lookup leaves behind is a
 *  blank disc. Every avatar in the app is built here so no surface can. */
function avatarBox(profile, icon, sizeStyle = '') {
  const art = avatarGlyph(icon);
  const box = { class: 'profile-avatar', 'aria-hidden': 'true',
    style: `${sizeStyle}background:${avatarColor(profile?.id)};color:#fff;` };
  return art ? $('span', { ...box, innerHTML: art }) : $('span', box, initialOf(profile?.name));
}

/** The avatar for a profile at a fixed size, for the chip, the tiles and the
 *  admin rows. */
function profileAvatar(profile, px = 34) {
  return avatarBox(profile, profile?.icon,
    `width:${px}px;height:${px}px;font-size:${Math.max(9, Math.round(px * 0.38))}px;`);
}

/** Pick a picture for one profile. The admin can do this for anyone; a user's
 *  own entry point is the picker, which only ever edits the active profile. */
function openAvatarPicker(profile, onPicked = null) {
  if (document.querySelector('.avatar-mgr-bg')) return;
  const bg = $('div', { class: 'modal-bg avatar-mgr-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Picture for ${profile.name}`, style: 'max-width:440px;' });
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = ev => { if (ev.key === 'Escape' && isTopModal(bg)) { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const pick = (icon) => {
    const r = setProfileIcon(profile.id, icon);
    if (r.error) { toast(r.error); return; }
    close();
    toast(icon ? `Picture updated for ${profile.name}.` : `${profile.name} shows their initial again.`);
    render();
    if (onPicked) onPicked();
  };

  // The initial is the selection whenever no picture is drawn — including an id
  // this build does not know (it would otherwise show nothing selected).
  const showing = avatarGlyph(profile.icon) ? profile.icon : null;
  const grid = $('div', { class: 'avatar-grid', role: 'group', 'aria-label': 'Pictures' });
  grid.append($('button', {
    type: 'button', class: 'avatar-choice' + (showing ? '' : ' on'),
    'aria-label': `Initial for ${profile.name}`, 'aria-pressed': String(!showing),
    onClick: () => pick(null),
  }, avatarBox(profile, null)));
  for (const id of Object.keys(AVATAR_ART)) {
    const on = showing === id;
    grid.append($('button', {
      type: 'button', class: 'avatar-choice' + (on ? ' on' : ''),
      'aria-label': id, 'aria-pressed': String(on), onClick: () => pick(id),
    }, avatarBox(profile, id)));
  }

  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;' },
      $('h2', { class: 'serif', style: 'font-size:24px;font-weight:400;' }, 'Choose a picture'),
      $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close')),
    $('p', { class: 'muted', style: 'font-size:12px;line-height:1.5;' }, `Shown next to ${profile.name} on this device.`),
    grid,
  );
  bg.appendChild(modal);
  stackModal(bg);
  grid.querySelector('.avatar-choice')?.focus();
}

/** Toggle one tab for one user. The setting is written into the TARGET's own
 *  document (patching it preserves their entries), so it syncs with their data
 *  rather than living only on this device. The dashboard is not in
 *  HIDEABLE_TABS, so a user can never be left with an empty nav. */
function setProfileTab(profile, route, visible, isCurrent, redraw) {
  const current = isCurrent ? enabledTabs() : loadStateFor(profile.id).settings.enabledTabs;
  const next = TABS.filter(id => (id === route ? visible : current.includes(id)));
  if (isCurrent) {
    state.settings.enabledTabs = next;
    persist();
    render();
    redraw();
    return;
  }
  if (!patchProfileSettings(profile.id, { enabledTabs: next })) {
    toast('Could not save that change on this device.');
    return;
  }
  toast(`${titleFor(route)} ${visible ? 'shown to' : 'hidden from'} ${profile.name}.`);
  redraw();
  sendTabPolicy(profile, next);
}

// ---------- inviting someone to their own account ----------
/** Why an invite could not be minted, in the terms of the screen the owner
 *  would go and fix it on. The server's own message already names the exact
 *  env var for a missing account credential, so it is passed through. */
function inviteFailure(r) {
  if (r.reason === 'not_configured') return 'Turn on Cloud sync first (\u2630 \u2192 Cloud sync) - an invite is minted with the owner\u2019s password.';
  if (r.reason === 'invalid_endpoint') return 'Cloud sync points somewhere without the invite function - check the URL.';
  if (r.reason === 'auth') return 'The password in Cloud sync is not the owner\u2019s password - invites need APP_PASSWORD.';
  if (r.reason === 'network') return 'Could not reach the server - check your connection.';
  return r.message || 'Could not create that invite.';
}

/** Mint and show a single-use invite link for one account. The link carries
 *  the account's current tab policy, so what is set here is what that person
 *  gets on their phone the moment they open it. */
async function openInviteDialog(profile, tabs) {
  toast(`Creating an invite for ${profile.name}\u2026`);
  const r = await syncIssueProfileInvite(profile.id, tabs);
  if (!r.ok) { toast(inviteFailure(r)); return; }
  const link = `${location.origin}${location.pathname}?centsSync=${encodeURIComponent(r.token)}`;
  const field = $('input', {
    type: 'text', readonly: true, value: link, 'aria-label': `Invite link for ${profile.name}`,
    style: 'width:100%;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:ui-monospace,monospace;padding:10px 12px;font-size:11px;box-sizing:border-box;',
  });
  const note = $('p', { class: 'muted', style: 'font-size:12px;min-height:16px;margin:8px 0 0;' });
  const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Invite ${profile.name}`, style: 'max-width:460px;' });
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = ev => { if (ev.key === 'Escape' && isTopModal(bg)) { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      note.textContent = 'Link copied. Send it to them directly.';
    } catch {
      field.select();
      note.textContent = 'Press Ctrl/Cmd+C to copy the selected link.';
    }
  };

  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;' },
      $('h2', { class: 'serif', style: 'font-size:24px;font-weight:400;' }, `Invite ${profile.name}`),
      $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close')),
    $('p', { class: 'muted', style: 'font-size:12px;line-height:1.5;' },
      `Opening this on their phone adds the \u201c${profile.id}\u201d account there, with its own password, and switches to it. Their entries stay on their device and in their own cloud copy - this device keeps only the account itself.`),
    field,
    $('p', { class: 'muted', style: 'font-size:12px;line-height:1.5;margin:10px 0 0;' },
      (r.expiresInDays ? `Single use, expires in ${r.expiresInDays} days. ` : 'Single use. ')
      + (r.tabs?.length ? `Carries these tabs: ${r.tabs.map(titleFor).join(', ')}.` : 'No tab restriction is set for them yet.')),
    $('div', { style: 'display:flex;gap:8px;margin-top:16px;' },
      $('button', { type: 'button', class: 'btn btn-primary', style: 'flex:1;', onClick: copy }, 'Copy link'),
      $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Done')),
    note,
  );
  bg.appendChild(modal);
  stackModal(bg);
  field.focus();
  field.select();
}

/** Send an account's tab policy to its own cloud file, so the phone that person
 *  actually uses picks it up on its next sync. Reports what happened rather
 *  than claiming success: an account that has never synced has no document to
 *  carry a policy, and its next invite link carries one instead. */
async function sendTabPolicy(profile, tabs) {
  const r = await syncPushProfilePolicy(profile.id, tabs);
  if (r.ok && r.applied) { toast(`Tab settings sent to ${profile.name}'s device.`); return; }
  if (r.ok && r.pending) { toast(`${profile.name} has not synced yet - the next invite link carries these tabs.`); return; }
  // No cloud in use at all: there is nothing to send, and the local copy is
  // the whole story.
  if (r.reason === 'not_configured' || r.reason === 'invalid_endpoint') return;
  toast(`Saved here. Not sent to ${profile.name} yet${r.message ? ` - ${r.message}` : '.'}`);
}

/** Name dialog for create/rename. window.prompt is unreliable inside an
 *  installed mobile web app, so this is the app's own modal (and Enter works). */
function askProfileName(title, initial = '') {
  return new Promise(resolve => {
    let settled = false;
    const input = $('input', {
      type: 'text', maxlength: '24', value: initial, autocomplete: 'off',
      'aria-label': 'Profile name', placeholder: 'Name',
      style: 'width:100%;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;',
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      bg.remove();
      resolve(value == null ? null : String(value).trim());
    };
    const form = $('form', { onSubmit: (ev) => { ev.preventDefault(); finish(input.value); }, style: 'display:flex;flex-direction:column;gap:14px;' },
      $('h2', { class: 'serif', style: 'font-size:24px;font-weight:400;margin:0;' }, title),
      input,
      $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;' },
        $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => finish(null) }, 'Cancel'),
        $('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')),
    );
    const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) finish(null); } },
      $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: 'max-width:400px;' }, form));
    const onKey = (ev) => { if (ev.key === 'Escape' && isTopModal(bg)) { ev.preventDefault(); finish(null); } };
    document.addEventListener('keydown', onKey, true);
    stackModal(bg);
    input.focus();
    input.select();
  });
}

/** Switch to another profile in this same tab — the boot sequence minus the
 *  document reload.
 *
 *  The app resolves exactly ONE profile into module-level state at boot, so a
 *  switch re-resolves the few things that are read once: the document itself,
 *  the allowed-category set derived from it, the PIN session and the sync
 *  boot. Everything else — the undo journal, balances, budgets, the
 *  tab policy — already reads through the active profile's namespace on
 *  demand, so it follows the switch for free. The new profile opens on its own
 *  lock, which is also where its cloud copy is pulled from.
 *
 *  In-flight cloud answers are the one real hazard a reload never had: sync.js
 *  stamps each response with the profile it spoke for, and staleResponse()
 *  drops anything that arrives for the profile we just left. */
function switchToProfile(id) {
  if (id === (getActiveProfileId() || 'personal')) return;
  if (!setActiveProfileId(id)) { toast('That profile could not be opened.'); return; }
  loadProfileIntoApp();
}

/** Re-resolve the active profile into the running app — the part of boot that
 *  the persisted registry cannot defer. */
function loadProfileIntoApp() {
  // Whatever this was triggered from — the picker, the Admin panel, the menu —
  // goes away with it, exactly as a reload would have cleared it. Toasts too:
  // they are mounted on document.body, outside the mount that gets rebuilt, and
  // an Undo toast captured the live undo closure of the profile being left —
  // tapping it after a switch would write that profile's entries into this one.
  closeAppMenu();
  closePinOverlay();
  for (const el of document.querySelectorAll('.modal-bg, .swal2-container, .toast-host')) el.remove();
  cancelScheduledSyncPush();
  stopSyncPolling();
  state = loadState();
  updateAllowedCategories([...CATEGORIES, ...(state.settings.customCategories || [])].map(c => c.id));
  updateAllowedMethods(everyMethod().map(m => m.id));
  clearBalanceCaches();
  // The privacy credential is namespaced by profile, so the next profile's lock
  // state is a different answer to the same question.
  forgetPinLock();
  pinUnlocked = false;
  // In-memory state that belongs to the profile we are leaving. `_undoStack`
  // is the important one: it holds live closures over the previous profile's
  // entries, and lastUndoDescriptor() prefers it over the journal — so leaving
  // it set would offer to undo one person's entry inside another's document.
  _undoStack = [];
  lastRenderedRoute = null;
  rejectedRevision = null;
  syncRevision = 0;
  syncBootStarted = false;   // this profile needs its own boot sync
  sessionSyncFailed = false;
  render();
  showProfileEntry();
  window.scrollTo({ top: 0 });
}

/** The surface the active profile opens on: first-run setup, its lock — or,
 *  with no PIN on the device, nothing at all, straight into the session. */
function showProfileEntry() {
  if (needsOnboarding()) showOnboarding();
  else if (hasPinLock()) showPinLock();
  else completeUnlock();
}

function showProfilePicker({ cancellable = false } = {}) {
  if (document.querySelector('.profile-picker-bg')) return;
  const profiles = listProfiles();
  const active = getActiveProfileId();

  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = ev => { if (ev.key === 'Escape' && cancellable) { ev.preventDefault(); close(); } };

  const grid = $('div', { class: 'profile-grid', role: 'list' });
  for (const p of profiles) {
    grid.append($('button', {
      type: 'button', class: 'profile-tile' + (p.id === active ? ' current' : ''), role: 'listitem',
      'aria-label': `Open ${p.name}`, onClick: () => {
        if (p.id !== active) { switchToProfile(p.id); return; }
        // Re-opening the current profile → its lock (data is already loaded).
        close();
        showProfileEntry();
      },
    },
      profileAvatar(p, 64),
      $('span', { class: 'profile-name' }, p.name),
      p.id === active ? $('span', { class: 'profile-current-tag' }, 'Current') : null,
    ));
  }

  const card = $('div', { class: 'modal profile-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a profile', style: 'max-width:420px;text-align:center;' },
    $('div', { class: 'serif', style: 'font-size:30px;margin-bottom:2px;' }, 'cents.'),
    $('p', { class: 'eyebrow', style: 'margin:0 0 18px;' }, 'Who\'s tracking?'),
    grid,
    // Your own picture. Anyone may change theirs; the admin can change anyone's
    // from the Admin panel.
    $('button', { type: 'button', class: 'btn-link', style: 'margin-top:18px;width:100%;text-align:center;', onClick: () => {
      const current = activeProfile();
      openAvatarPicker(current, () => {
        // Redraw the picker in place so the tile shows the new picture.
        document.querySelector('.profile-picker-bg')?.remove();
        showProfilePicker({ cancellable });
      });
    } }, 'Change picture'),
    // Managing users is the owner's job: a user opening this picker only picks.
    isAdminProfile(getActiveProfileId()) ? $('button', { type: 'button', class: 'btn-link', style: 'margin-top:12px;width:100%;text-align:center;', onClick: () => {
      close();
      openAdminPanel(() => {
        // Redraw in place so adds/renames/deletes are reflected without a
        // reload. Only dropping to a single profile needs a real reboot.
        document.querySelector('.profile-picker-bg')?.remove();
        if (listProfiles().length > 1) showProfilePicker({ cancellable });
        // Down to one profile there is nothing to pick, so this is the lock
        // again — without the setup-link pass boot would also have done.
        else { render(); showProfileEntry(); }
      });
    } }, 'Manage users') : null,
  );
  const bg = $('div', { class: 'modal-bg profile-picker-bg', style: 'z-index:10002;background:rgba(0,0,0,.82);' }, card);
  // A picker that cannot be cancelled is not something the back gesture may
  // dismiss: the owner still has to choose. Opting out means it never gets a
  // history entry, so back keeps its ordinary meaning here.
  if (!cancellable) bg.dataset.noBack = 'true';
  if (cancellable) {
    bg.addEventListener('click', ev => { if (ev.target === bg) close(); });
    document.addEventListener('keydown', onKey, true);
  }
  document.body.appendChild(bg);
  bg.querySelector('.profile-tile')?.focus();
}

// Boot gate: stash any setup link first (it configures a profile after
// unlock), then several profiles meet the picker, one profile goes straight
// to its lock/onboarding.
function showProfileGate() {
  applySetupLinkIfPresent();
  if (listProfiles().length > 1 && !hasSessionChoice()) { showProfilePicker({ cancellable: false }); return; }
  // The three states a device can be in, and the third is the one this gate
  // used to have no branch for: a PIN exists (lock it), no PIN but a first run
  // (onboard it), or neither — in which case the session opens now, because the
  // work that waits behind a lock has nothing to wait for.
  if (needsOnboarding()) { showOnboarding(); return; }
  if (hasPinLock()) { showPinLock(); return; }
  completeUnlock();
}

// ---------- admin panel: the people you share cents. with, and their tabs ----------
// Only the owner's profile ("personal" - the one whose password is the site's
// APP_PASSWORD) can open this. Everyone else could otherwise un-hide their own
// tabs or delete the studio's owner. Two things it decides: who has an account,
// and which tabs each of them may open. Tabs live in the PERSON's own document,
// so a restriction travels with their data to their own device instead of
// existing only here.
//
// Honest scope: a UI policy, not a security boundary. Hiding a tab keeps the app
// tidy for the person using it, it does not keep a determined one out — and
// anyone holding a device reads everything on it.
function openAdminPanel(onChanged = null) {
  if (!isAdminProfile(getActiveProfileId())) { toast('Only the owner can manage users.'); return; }
  if (document.querySelector('.profile-mgr-bg')) return;
  const bg = $('div', { class: 'modal-bg profile-mgr-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Admin', tabindex: '-1', style: 'max-width:480px;' });
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); if (onChanged) onChanged(); };
  const onKey = ev => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.appendChild(modal); stackModal(bg);

  const draw = () => {
    const profiles = listProfiles();
    const active = getActiveProfileId();
    const rows = $('div', { style: 'display:flex;flex-direction:column;gap:8px;margin:18px 0;' });
    for (const p of profiles) {
      const isCurrent = p.id === active;
      const owner = isAdminProfile(p.id);
      const tabs = isCurrent ? enabledTabs() : loadStateFor(p.id).settings.enabledTabs;
      // The cloud credential is named, not implied: a second profile syncs only
      // once its own env var exists, and this is where the user finds out.
      const note = [
        owner ? 'Owner' : null,
        isCurrent ? 'open now' : null,
        owner ? null : `Cloud password: ${profileEnvName(p.id)}`,
      ].filter(Boolean).join(' · ');

      const chips = $('div', { class: 'admin-tabs', role: 'group', 'aria-label': `Tabs ${p.name} can open` });
      for (const route of HIDEABLE_TABS) {
        const on = tabs.includes(route);
        chips.append($('button', {
          type: 'button', class: 'admin-tab' + (on ? ' on' : ''), 'aria-pressed': String(on),
          'aria-label': `${titleFor(route)} for ${p.name}: ${on ? 'shown' : 'hidden'}`,
          onClick: () => setProfileTab(p, route, !on, isCurrent, draw),
        }, titleFor(route)));
      }

      rows.append($('div', { class: 'admin-card' },
        $('div', { class: 'profile-row', style: 'border:none;padding:0;' },
          profileAvatar(p, 34),
          $('span', { class: 'profile-row-main' },
            $('span', { class: 'profile-row-name' }, p.name),
            note ? $('span', { class: 'profile-row-note' }, note) : null),
          $('span', { class: 'profile-row-actions' },
            !isCurrent ? $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => switchToProfile(p.id) }, 'Open') : null,
            // An invite is how this person gets their account onto their own
            // phone. The owner profile has no invite: it is this device.
            !owner ? $('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': `Invite ${p.name}`, onClick: () => openInviteDialog(p, tabs) }, 'Invite') : null,
            $('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': `Picture for ${p.name}`, onClick: () => openAvatarPicker(p, draw) }, 'Picture'),
            $('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': `Rename ${p.name}`, onClick: async () => {
              const name = await askProfileName('Rename profile', p.name);
              if (name == null) return;
              const r = renameProfile(p.id, name);
              if (r.error) { toast(r.error); return; }
              draw();
            } }, 'Rename'),
            // The owner profile is not deletable: it holds the site password
            // and the base cloud file, and removing it would leave nobody able
            // to open this panel again.
            !owner ? $('button', { type: 'button', class: 'btn btn-danger', 'aria-label': `Delete ${p.name}`, onClick: async () => {
              const confirmed = await swalConfirm({
                title: `Delete ${p.name}?`,
                text: 'Every entry, balance, PIN and setting stored on this device for that profile is removed. A copy already synced to the cloud is not touched.',
                confirmButtonText: 'Delete', danger: true,
              });
              if (!confirmed) return;
              const r = deleteProfile(p.id);
              if (r.error) { toast(r.error); return; }
              // Deleting the profile you are using moves the active id to the
              // owner, so the running app has to be re-resolved for it.
              if (isCurrent) { loadProfileIntoApp(); return; }
              draw();
            } }, 'Delete') : null),
        ),
        $('div', { class: 'admin-tabs-label' }, 'Tabs'),
        chips,
      ));
    }

    modal.replaceChildren(
      $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;' },
        $('h2', { class: 'serif', style: 'font-size:28px;font-weight:400;' }, 'Admin'),
        $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close')),
      $('p', { class: 'muted', style: 'font-size:12px;line-height:1.5;' },
        'People you share cents. with. Everyone opens their own account on their own phone and sees only their own entries, balances and PIN. A tab you switch off is hidden for that person everywhere their profile goes, on every device they sync it to.'),
      $('p', { class: 'muted', style: 'font-size:12px;line-height:1.5;' },
        'To put an account on someone else\'s phone, tap Invite and send them the link. It is single-use and expires, and whoever holds it can read and write that account\'s data — so send it to them directly.'),
      rows,
      $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;' },
        $('button', { type: 'button', class: 'btn btn-primary', onClick: async () => {
          const name = await askProfileName('New profile name');
          if (name == null) return;
          const r = createProfile(name);
          if (r.error) { toast(r.error); return; }
          toast(r.profile.id === 'personal'
            ? `Profile "${r.profile.name}" created.`
            : `Profile "${r.profile.name}" created. To sync it, set ${profileEnvName(r.profile.id)} as a secret on the Worker.`);
          draw();
        } }, 'Add profile')),
    );
  };
  draw();
  modal.focus();
}

// Only the topmost modal may respond to Escape. Stacked modals (e.g. the
// recurring manager opening the new-recurring editor on top of it) each
// register a document-level capture listener, so without this guard one
// Escape would close every modal at once.
function isTopModal(bg) {
  const bgs = document.querySelectorAll('.modal-bg');
  return bgs.length > 0 && bgs[bgs.length - 1] === bg;
}

// Append a modal so that it paints above the one it was opened from. Equal
// z-indexes fall back to DOM order, which works only while every modal shares
// the same z-index — and three do not on purpose: the lock, onboarding and the
// profile picker sit above the app (10000-10002). A modal opened from one of
// those would land underneath it and read as a dead button (the picker's own
// "Change picture" did exactly that), so each new modal is lifted one step
// above the topmost open one.
function stackModal(bg) {
  const top = [...document.querySelectorAll('.modal-bg')].pop();
  const above = Number.parseInt(top ? getComputedStyle(top).zIndex : '', 10);
  if (Number.isFinite(above)) bg.style.zIndex = String(above + 1);
  document.body.appendChild(bg);
}

/* ── Android's back gesture closes a sheet ──
   Every sheet here is a `.modal-bg` (nineteen call sites) or the menu's
   `.menu-backdrop`, and each one owns its own `close()` closure. Rather than
   thread a history hook through twenty call sites, ONE observer watches the
   body for a sheet appearing and pushes a history entry for it — the same
   shape as wireModalFocusTrap() below, and for the same reason: a sheet added
   later is covered without anyone remembering to ask.

   A popstate then closes the top one through the convention every sheet
   already implements — Escape (each modal guards it with isTopModal, so only
   the topmost answers) with a click on the backdrop as the fallback — so back
   does exactly what Escape does, and the new behaviour cannot drift from the
   old one.

   Four rules, each a way this goes wrong:
   1. The lock is never closable by back. `.pin-lock-bg` is a `.modal-bg` like
      any other, and honouring back there would let a stray press dismiss the
      lock screen.
   2. Onboarding is exempt too: a stray press mid-setup must not walk the user
      out of a half-filled first run (it has a visible Skip button for that).
   3. A sheet can opt out with `data-no-back`, and then it pushes no entry at
      all, so back keeps exactly its old meaning. The profile picker sets it
      when it is not cancellable — an owner who must choose an account cannot
      press their way out of it.
   4. A sheet that closes ITSELF (Save, Cancel, a backdrop tap) gives its entry
      back, and only when that entry is still the top of the stack. The
      deferral to a later task is what makes that check meaningful: the menu's
      own rows close it AND navigate, so by the time the task runs the browser
      has pushed the navigation entry and ours is no longer on top — popping
      then would undo the navigation the user just asked for.

   The known limit: an entry left under such a navigation is still on the
   stack, so the FIRST back press is spent dismissing it (it pops to a URL that
   is already the current one, so nothing visible happens) and the second
   leaves the app. */
const BACK_SURFACE_SELECTOR = '.modal-bg, .menu-backdrop';
function backExempt(el) {
  return el.classList.contains('pin-lock-bg')
    || el.classList.contains('onboarding-bg')
    || el.dataset.noBack === 'true';
}
/** Sheets that own a history entry, in DOM order — the last is the topmost. */
const backSurfaces = () => [...document.querySelectorAll(`${BACK_SURFACE_SELECTOR}[data-back-entry]`)];
let backDepth = 0; // our entries currently on the history stack
let backMine = 0;  // pops this file caused itself, to be ignored

function pushBackEntry(el) {
  el.dataset.backEntry = '1';
  backDepth++;
  try { history.pushState({ centsSurface: true }, ''); }
  catch { backDepth--; delete el.dataset.backEntry; } // no history API: no gesture
}

/** Close the topmost sheet the way a person would. Both exits are the sheet's
 *  own, so nothing here needs to know how any particular sheet shuts. */
function closeTopBackSurface() {
  const top = backSurfaces().pop();
  if (!top) return false;
  top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (top.isConnected) top.click(); // the backdrop's own onClick
  return true;
}

/** Give a self-closed sheet's entry back — but only if it is still on top, and
 *  on a later task, because the same click may have navigated (see rule 4). */
function returnBackEntry() {
  setTimeout(() => {
    if (backDepth <= 0 || !history.state?.centsSurface) return;
    backDepth--;
    backMine++;
    history.back();
  }, 0);
}

function wireBackGesture() {
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const el of [node, ...node.querySelectorAll(BACK_SURFACE_SELECTOR)]) {
          if (!el.matches?.(BACK_SURFACE_SELECTOR) || backExempt(el) || el.dataset.backEntry) continue;
          pushBackEntry(el);
        }
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        // A sheet can be removed as part of a larger subtree, so every entry it
        // held has to be given back — one return per marked element, not per
        // removed node.
        if (node.dataset.backEntry) returnBackEntry();
        for (let i = node.querySelectorAll('[data-back-entry]').length; i > 0; i--) returnBackEntry();
      }
    }
  }).observe(document.body, { childList: true });
  // A sheet already open when this is installed (the onboarding overlay mounts
  // during boot) still owns its entry.
  for (const el of document.querySelectorAll(BACK_SURFACE_SELECTOR)) {
    if (!backExempt(el) && !el.dataset.backEntry) pushBackEntry(el);
  }
}

window.addEventListener('popstate', () => {
  if (backMine > 0) { backMine--; return; }
  if (backDepth <= 0) return;
  backDepth--;
  if (!closeTopBackSurface()) backDepth++; // nothing to close: not our press to spend
});

/* ── text shared into the app from the share sheet ──
   manifest.json registers a share_target, so another app's Share → cents.
   arrives as a query on this URL (?title=…&text=…&url=…), ahead of the #add
   fragment the target names. It is PUT IN the Quick entry, never saved: the
   text is whatever the other app chose to send ("€18.50 at Tesco 12/09"), and
   the parser plus its live preview is what turns that into an entry the user
   can read and confirm first. Consumed once, in the Add screen, because the
   app may still be locked when it arrives — the screen does not exist until it
   is unlocked — and because a reload must not prefill it a second time. */
let pendingShare = null;
function readSharedText() {
  let text = '';
  try {
    const params = new URLSearchParams(location.search);
    text = ['title', 'text', 'url'].map(key => params.get(key)).filter(Boolean).join(' ').trim();
  } catch { /* no URL API: nothing was shared */ }
  if (!text) return;
  pendingShare = text;
  // The query is not part of this app's address — dropping it is what stops a
  // reload prefilling the same share again.
  try { history.replaceState(history.state, '', location.pathname + location.hash); } catch {}
}

// ---------- modal focus trap (focus-trap + tabbable) ----------
// Every modal in the app is a `.modal-bg` appended to document.body — app.js's own
// and tesco.js's, which go through stackModal — and focus is the one thing none of
// them handled: the only 'Tab' handling in the app is the app menu's, so in every
// other modal Tab walked straight out of the dialog and into the page behind it.
//
// The trap therefore follows the DOM rather than the twenty call sites: one
// observer activates focus-trap on the TOPMOST `.modal-bg` (stacked modals keep
// their order — the recurring manager's editor sits over it) and releases it when
// that element leaves the document, so a modal added later is trapped by
// construction instead of by remembering. The app menu is not a `.modal-bg` and
// keeps its own, already-working, Tab handling.
//
// Escape is left to the modals (each already handles it, and only the topmost may
// act — isTopModal), and clicks are left alone (the backdrop IS inside the trap's
// container, so clicking it still closes the modal). If focus-trap cannot be
// fetched the modal is exactly what it was before: focusable, Escape-able, and
// merely untrapped — the same graceful direction as every other vendored widget.
const _modalTraps = new Map();   // .modal-bg → its focus-trap instance
let _trapSyncQueued = false;
function _trapTop() {
  const bgs = [...document.querySelectorAll('.modal-bg')];
  return bgs[bgs.length - 1] || null;
}
function syncModalFocusTrap() {
  _trapSyncQueued = false;
  const top = _trapTop();
  // Released first, and for both reasons: a trap whose modal has left the document
  // (its own close() removed it) would otherwise stay on focus-trap's stack, and a
  // modal that is no longer on top hands focus to the one above it.
  for (const [bg, trap] of [..._modalTraps]) {
    if (bg === top && bg.isConnected) continue;
    _modalTraps.delete(bg);
    try { trap.deactivate(); } catch { /* already gone */ }
  }
  if (!top) return;
  const live = _modalTraps.get(top);
  if (live) {
    if (!live.active) { try { live.activate(); } catch { /* ignore */ } }
    return;
  }
  if (typeof focusTrap === 'undefined') {
    // First modal of the session: fetch tabbable THEN focus-trap (the UMD reads
    // window.tabbable as it loads, so the order is load-bearing — the same trap
    // popper → tippy has), then trap the modal that is open by then.
    loadVendor('tabbable', { js: 'vendor/tabbable.umd.min.js' })
      .then(() => loadVendor('focus-trap', { js: 'vendor/focus-trap.umd.min.js' }))
      .then(syncModalFocusTrap)
      .catch(() => {});
    return;
  }
  try {
    const trap = focusTrap.createFocusTrap(top, {
      // Escape runs the modal's own handler (which knows whether it is the topmost
      // one); clicking outside the container is not a thing that can happen here
      // (the container is the full-screen backdrop) and must not deactivate it.
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      // Tabbing from the last control cycles to the first, and back.
      returnFocusOnDeactivate: true,
      fallbackFocus: () => top.querySelector('.modal') || top,
      tabbableOptions: { displayCheck: 'none' },
    });
    _modalTraps.set(top, trap);
    trap.activate();
  } catch { /* a trap that cannot be built must not break the modal */ }
}
function wireModalFocusTrap() {
  const queue = () => { if (_trapSyncQueued) return; _trapSyncQueued = true; queueMicrotask(syncModalFocusTrap); };
  new MutationObserver(queue).observe(document.body, { childList: true });
  queue();
}

function openPinSettings() {
  const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Privacy lock settings', tabindex: '-1', style: 'max-width:420px;' });
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.appendChild(modal); document.body.appendChild(bg);
  const hadPin = hasPinLock();
  const pin = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: hadPin ? 'New PIN (leave blank to keep)' : 'Your PIN', 'aria-label': 'New PIN' });
  const confirm = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'Repeat PIN', 'aria-label': 'Repeat PIN' });
  const status = $('p', { class: 'muted', style: 'font-size:12px;min-height:18px;' }, hadPin ? 'Your PIN is stored as a one-way hash on this device. This protects casual access, not localStorage or DevTools.' : 'No PIN is set, so cents. opens without a lock on this device. Set one here to lock it.');
  const save = async () => {
    const value = pin.value.trim();
    // Blank keeps the PIN that is already there — and with none there is nothing
    // to keep, so the field has to be filled before the app can lock at all.
    if (!value) {
      if (hadPin) { close(); return; }
      status.textContent = 'Enter a PIN to lock the app.';
      pin.focus();
      return;
    }
    if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) { status.textContent = 'Use 4-20 letters or numbers.'; pin.focus(); return; }
    if (value !== confirm.value.trim()) { status.textContent = 'The PINs do not match.'; confirm.focus(); return; }
    try {
      if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable');
      const salt = globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
      const saved = setPrivacyPin(await hashPin(value, salt), salt, 'pbkdf2');
      if (!saved) { status.textContent = 'Could not save the PIN on this device.'; return; }
      forgetPinLock();
      // Remove any legacy in-state fallback once the device-only credential is
      // definitely stored, so exports/sync cannot retain stale PIN material.
      if (state.settings?.pinHash) delete state.settings.pinHash;
      persist(); pinUnlocked = true; resetIdleLock(); close();
      toast(hadPin ? 'PIN changed.' : 'PIN set - cents. locks on this device from now on.');
      render();
    } catch (err) {
      status.textContent = 'PIN security is unavailable in this browser.';
    }
  };
  // Biometric row - hidden until the platform-authenticator check resolves.
  const bioRow = $('div', { style: 'display:none;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line);' });
  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;' }, $('h2', { class: 'serif', style: 'font-size:28px;font-weight:400;' }, 'Privacy lock'), $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close')),
    $('p', { class: 'serif', style: 'font-size:16px;' }, hadPin ? 'Change or remove your PIN.' : 'Set a PIN to lock cents. on this device.'),
    $('div', { style: 'display:flex;flex-direction:column;gap:12px;margin:20px 0;' }, pin, confirm),
    status,
    bioRow,
    $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;' },
      // There is no default to reset TO. Removing the PIN is the way back to an
      // unlocked app, and it is the only thing that should ever remove a
      // credential — so a fingerprint registered behind it goes too.
      hadPin ? $('button', { type: 'button', class: 'btn btn-danger', onClick: () => {
        if (!clearPrivacyPin()) { toast('Could not remove the PIN on this device.'); return; }
        forgetPinLock();
        clearBiometricCredential();
        if (state.settings?.pinHash) delete state.settings.pinHash;
        persist();
        pinUnlocked = true;
        resetIdleLock();
        close();
        toast('PIN removed - cents. opens without a lock on this device.');
        render();
      } }, 'Remove PIN') : null,
      $('button', { type: 'button', class: 'btn btn-primary', onClick: save }, hadPin ? 'Save PIN' : 'Set PIN'),
    ),
  );
  queueMicrotask(() => pin.focus());
  biometricSupported().then(ok => {
    if (!ok || !bg.isConnected) return;
    bioRow.style.display = 'flex';
    const fill = () => {
      const cred = hasBiometricCredential();
      const label = biometricLabel();
      bioRow.replaceChildren();
      bioRow.append(
        $('span', { style: 'font-size:13px;color:var(--muted);' }, cred
          ? 'Fingerprint unlock is on for this device.'
          : 'Unlock with ' + label + ' instead of the PIN.'),
        $('button', { type: 'button', class: cred ? 'btn btn-danger' : 'btn btn-ghost', style: 'padding:6px 12px;font-size:12px;', onClick: () => {
          if (cred) {
            if (clearBiometricCredential()) { toast('Fingerprint unlock disabled.'); fill(); }
            else { toast('Could not disable fingerprint unlock.'); }
          } else {
            registerBiometric().then(res => {
              if (!bg.isConnected) return;
              if (res.ok) { toast('Fingerprint unlock enabled.'); fill(); }
              else if (res.reason === 'cancelled') { toast('Fingerprint not enabled - you can try again.'); }
              else { toast('Fingerprint is not available on this device.'); }
            });
          }
        } }, cred ? 'Disable' : 'Enable'),
      );
    };
    fill();
  });
}

let persistFlushQueued = false;
let persistDirtyAgain = false;
function persist() {
  // Track the last local edit before writing so conflict detection survives reloads.
  state.lastLocalChangeAt = new Date().toISOString();
  // If cash entries auto-follow the balance, recompute the coin breakdown so
  // the home cash widget reflects cash payments - runs before saveState so the
  // fresh coins are persisted with this same revision.
  ensureCashCoins();
  clearBalanceCaches();
  syncRevision++;
  const writeNow = () => {
    // A rejected write (storage full, or blocked entirely) means the change the
    // user just made is not on disk. Say so once, rather than letting a reload
    // silently reveal that it never saved.
    if (saveState(state) === false && !saveFailureNotified) {
      saveFailureNotified = true;
      raiseNotice('Could not save to this device - storage may be full. Export a backup from the menu under Data.');
    }
  };
  // The first write of a tick lands synchronously — anything reading storage
  // right after persist() still sees this change (the contract saveState makes
  // and test-integrity pins). Further persist()s in the SAME tick — a save that
  // writes entries and settings as two steps — coalesce into one trailing write
  // of the final document, instead of re-stringifying the whole thing per step.
  // The microtask runs before any event, navigation or paint, so no reload can
  // interleave the window, and a crash can lose at most an already-redundant
  // intermediate write.
  writeNow();
  if (persistFlushQueued) { persistDirtyAgain = true; }
  else {
    persistFlushQueued = true;
    queueMicrotask(() => {
      persistFlushQueued = false;
      if (persistDirtyAgain) { persistDirtyAgain = false; writeNow(); }
    });
  }
  scheduleSyncPush();
}

// ---------- the Tesco Pay screen is fetched on first visit ----------
// tesco.js holds the screen, the roster-photo reader, the pixel pipeline and the
// workbook importer: ~240 KB of the 770 KB a boot used to pull, parsed on the
// lock screen for a session that may never open the tab. The engine the
// dashboard reads is tesco-pay.js, which app.js imports statically (~21 KB of
// arithmetic), so the tab's figures stay on the dashboard either way.
//
// The switch in _render() asks for the module; a cold miss draws a placeholder
// and the import's own `render()` (the app's one render path) replaces it. A
// failure is reported and re-armed, so a later visit retries instead of leaving
// a screen that never loads.
let _tescoModule = null;       // the module once it has loaded
let _tescoLoading = false;     // an import is in flight

/** The Tesco module, or null while its import runs — which it starts. */
function tescoScreen() {
  if (_tescoModule) return _tescoModule;
  if (!_tescoLoading) {
    _tescoLoading = true;
    import('./tesco.js')
      // Re-render only when the reader is actually on Tesco. A warm-up from
      // pointing at (or tabbing to) the nav link happens on every screen, and an
      // unconditional render there rebuilds the page under the reader's focus
      // and throws the focused node away.
      .then(mod => { _tescoModule = mod; if (currentRoute() === 'tesco') render(); })
      .catch(err => {
        _tescoLoading = false;
        console.warn('cents: the Tesco Pay screen could not be loaded', err);
        toast('The Tesco Pay screen could not be loaded.');
      });
  }
  return null;
}

// Intent warm-up: pointing at (or tabbing to) a Tesco link starts the fetch, so
// a click on the tab is usually already there. Delegated, because every screen
// rebuilds its own nav — and it is the same call the route switch makes.
function warmTescoScreen(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('a[href="#tesco"]') : null;
  if (el) void tescoScreen();
}
document.addEventListener('pointerover', warmTescoScreen);
document.addEventListener('focusin', warmTescoScreen);

/** Drawn between asking for the module and having it. */
function tescoLoadingCard() {
  const c = $('section', { class: 'page-section', 'aria-label': 'Tesco Pay' });
  c.appendChild($('div', { class: 'page-title-row' }, $('h1', { class: 'page-title' }, 'Tesco Pay')));
  c.appendChild($('div', { class: 'card', style: 'padding:22px;' },
    $('p', { style: 'margin:0;color:var(--muted);font-size:13px;' }, 'Opening Tesco Pay\u2026')));
  return c;
}

// ---------- restoring a backup ----------
// Export has always existed; reading a file back did not, which made "Export
// data" a one-way door — including the notice a full quota raises, which tells
// the user to export a backup it could never open again. A restore is a MERGE
// (mergeStates, the same union the cloud path uses), so it can only ever add:
// the newest version of each entry wins, tombstones still hold, and nothing
// already on this device is deleted. storage.js owns the rules for reading the
// file (parseBackup) so they are pinned in scripts/test-integrity.mjs rather
// than checked by hand.
let restoreInput = null;

/** Why a file was refused, in the words a user can act on. */
const BACKUP_REFUSAL = {
  empty: 'That file is empty.',
  'too-large': 'That file is far too large to be one of this app\u2019s backups.',
  unreadable: 'That file is not valid JSON - it may be truncated. Try another copy.',
  'not-a-backup': 'That file is not a cents. backup: it has no list of entries.',
};

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one file-picking path, shared by Restore and the quarantined copy. */
function openRestorePicker() {
  if (!restoreInput) {
    restoreInput = $('input', { type: 'file', accept: '.json,application/json', class: 'restore-file', 'aria-label': 'Choose a backup file', style: 'display:none;' });
    restoreInput.addEventListener('change', () => {
      const file = restoreInput.files && restoreInput.files[0];
      // Clear the value so picking the same file twice in a row fires again.
      restoreInput.value = '';
      if (file) void restoreFromFile(file);
    });
    document.body.appendChild(restoreInput);
  }
  restoreInput.click();
}

async function restoreFromFile(file) {
  if (file.size > MAX_BACKUP_BYTES) { toast(BACKUP_REFUSAL['too-large']); return; }
  let text;
  try {
    text = await file.text();
  } catch {
    toast('That file could not be read.');
    return;
  }
  await restoreFromText(text, file.name || 'that file');
}

/**
 * Merge a validated backup document into this device's document.
 *
 * `source` is only ever used in the wording. The undo is one step and reverts
 * the WHOLE document to what it was a moment ago (a merge touches settings and
 * the Tesco tables, not just entries, so an entry-only journal would be the
 * wrong shape) — it is therefore session-scoped, and clearing the reload-safe
 * journal is deliberate: the older journal describes a different action.
 */
async function applyRestore(backupState, source) {
  const before = JSON.parse(JSON.stringify(state));
  const merged = validateState(mergeStates(state, backupState));
  const added = merged.entries.length - state.entries.length;
  const addedShifts = (merged.tesco?.shifts?.length || 0) - (state.tesco?.shifts?.length || 0);
  if (!added && !addedShifts && JSON.stringify(merged.settings) === JSON.stringify(state.settings)) {
    toast('Nothing to restore: this device already has everything in that file.');
    return;
  }
  state = merged;
  // The merge keeps this device's cash settings whenever its own timestamp is
  // newer than the file's, which is the ordinary case for a restore — and that
  // is exactly how a restored ledger ends up with entries on Cash and a €0.00
  // balance. Re-anchor from the file before anything is written.
  adoptBackupCash(backupState);
  persist();
  render();
  // Every journal record describes the document this restore has just replaced:
  // left in place, undoing one later would re-add entries from the OLD ledger
  // over the restored one. The restore's own undo is session-scoped (a
  // whole-document snapshot, deliberately not serialisable), so the reload-safe
  // stack is emptied rather than added to.
  clearUndoJournal();
  trackAction(() => { state = validateState(before); persist(); render(); }, 'restore from backup');
  const parts = [];
  if (added > 0) parts.push(`${added} ${added === 1 ? 'entry' : 'entries'}`);
  if (addedShifts > 0) parts.push(`${addedShifts} ${addedShifts === 1 ? 'shift' : 'shifts'}`);
  toast(`Restored ${parts.length ? parts.join(' and ') : 'settings'} from ${source}.`);
}

let restoreConfirmOpen = false;

async function restoreFromText(text, source) {
  const verdict = parseBackup(text);
  if (!verdict.ok) { toast(BACKUP_REFUSAL[verdict.reason] || 'That file could not be read as a backup.'); return; }
  if (!verdict.kept) {
    toast(verdict.dropped
      ? `That backup has ${verdict.dropped} entries and none of them could be read.`
      : 'That backup is empty.');
    return;
  }
  if (restoreConfirmOpen) return;   // a second pick while the dialog is up
  restoreConfirmOpen = true;
  let ok = false;
  try {
    ok = await swalConfirm({
      title: 'Restore this backup?',
      text: `Merge ${verdict.kept} ${verdict.kept === 1 ? 'entry' : 'entries'} from ${source}? Nothing on this device is deleted - the newest version of each entry wins.`
        + (verdict.dropped ? ` (${verdict.dropped} unreadable ${verdict.dropped === 1 ? 'entry was' : 'entries were'} skipped.)` : ''),
      confirmButtonText: 'Restore',
    });
  } finally {
    restoreConfirmOpen = false;
  }
  if (!ok) return;
  await applyRestore(verdict.state, source);
}

// ---------- the spreadsheet, read back ----------
// The counterpart to Export CSV. Same shape as the restore path on purpose:
// one file picker, a parse that never throws and explains itself, one confirm,
// and then applyRestore()'s whole-document undo — a CSV merge is the same
// "merge and let Undo take it back" promise a .json restore makes.
let csvInput = null;
let csvConfirmOpen = false;

function openCsvPicker() {
  if (!csvInput) {
    csvInput = $('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'restore-file', 'aria-label': 'Choose a CSV file', style: 'display:none;' });
    csvInput.addEventListener('change', () => {
      const file = csvInput.files && csvInput.files[0];
      // Clear the value so picking the same file twice in a row fires again.
      csvInput.value = '';
      if (file) void importCsvFromFile(file);
    });
    document.body.appendChild(csvInput);
  }
  csvInput.click();
}

/** The label → id mirrors of categoryLabel/methodLabel. entriesCsv() is handed
 *  the forward pair at export time; these are the same rules asked the other
 *  way, against the SAME tables (allCategories()/everyMethod()), so a custom
 *  category named "Groceries" on this device resolves to the id it was
 *  exported from and a label that matches nothing is left for validateEntry
 *  to judge (it passes the raw cell through as an id — a hand-edited file that
 *  already carries ids round trips too). */
function csvCategoryId(label) {
  const want = String(label).trim().toLowerCase();
  return allCategories().find(category => String(category.label).trim().toLowerCase() === want)?.id || null;
}
function csvMethodId(label) {
  const want = String(label).trim().toLowerCase();
  return everyMethod().find(method => String(method.label).trim().toLowerCase() === want)?.id || null;
}

async function importCsvFromFile(file) {
  if (file.size > MAX_BACKUP_BYTES) { toast(CSV_REFUSAL['too-large']); return; }
  let text;
  try {
    text = await file.text();
  } catch {
    toast('That file could not be read.');
    return;
  }
  await importCsvFromText(text, file.name || 'that file');
}

async function importCsvFromText(text, source) {
  const verdict = parseEntriesCsv(text, { category: csvCategoryId, method: csvMethodId }, state.entries);
  if (!verdict.ok) { toast(CSV_REFUSAL[verdict.reason] || 'That file could not be read as a CSV.'); return; }
  if (!verdict.kept) {
    toast(verdict.duplicates && !verdict.dropped
      ? `${verdict.duplicates === 1 ? 'That row is' : `Those ${verdict.duplicates} rows are`} already in your ledger.`
      : verdict.dropped
        ? `That CSV has ${verdict.dropped} ${verdict.dropped === 1 ? 'row' : 'rows'} and none of them could be read.`
        : 'That CSV has no rows under its header.');
    return;
  }
  if (csvConfirmOpen) return;   // a second pick while the dialog is up
  csvConfirmOpen = true;
  let ok = false;
  try {
    ok = await swalConfirm({
      title: 'Import this CSV?',
      text: `Merge ${verdict.kept} ${verdict.kept === 1 ? 'entry' : 'entries'} from ${source}? Nothing on this device is deleted - imported rows are added to what is already here.`
        + (verdict.dropped ? ` (${verdict.dropped} unreadable ${verdict.dropped === 1 ? 'row was' : 'rows were'} skipped.)` : '')
        + (verdict.duplicates ? ` (${verdict.duplicates} ${verdict.duplicates === 1 ? 'row' : 'rows'} already in your ledger.)` : ''),
      confirmButtonText: 'Import',
    });
  } finally {
    csvConfirmOpen = false;
  }
  if (!ok) return;
  await applyRestore({ entries: verdict.entries }, source);
}

// A document that could not be parsed is parked under a quarantine key by
// loadState rather than dropped, and until now nothing could reach it: the
// notice named a storage key at a user who has no way to open one. Offer the
// copy back — as a restore when it can be read at all, and as a download when
// it cannot, because those bytes are the only copy of that ledger.
async function recoverQuarantine() {
  const raw = unreadableBackup();
  if (!raw) { toast('There is no unreadable copy stored on this device.'); return; }
  const verdict = parseBackup(raw);
  if (verdict.ok && verdict.kept) {
    const ok = await swalConfirm({
      title: 'Restore the kept copy?',
      text: `A copy of a document this app could not read is still on this device. It holds ${verdict.kept} ${verdict.kept === 1 ? 'entry' : 'entries'}. Merge it in, or cancel and keep it where it is.`,
      confirmButtonText: 'Merge it in',
    });
    if (!ok) return;
    await applyRestore(verdict.state, 'the kept copy');
    return;
  }
  const ok = await swalConfirm({
    title: 'Download the kept copy?',
    text: 'This copy cannot be read as a document, so it cannot be merged. It can be downloaded, which is the only way to keep it - a backup taken before it was damaged may still open.',
    confirmButtonText: 'Download',
  });
  if (!ok) return;
  downloadText(`cents-unreadable-${today()}.json`, raw, 'application/json');
  toast('Downloaded the kept copy.');
}

// ---------- durable storage ----------
// The document lives in localStorage, which browsers may evict under storage
// pressure — for a local-first ledger that is the whole of the user's data. A
// "persistent" origin is granted without a prompt to a site the user engages
// with, and the call is a no-op once granted, so it is asked for on every boot.
// Failure is silent by design: the app works either way.
async function requestDurableStorage() {
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return;
    if (await navigator.storage.persisted()) return;
    await navigator.storage.persist();
  } catch { /* unsupported, or refused */ }
}

/** "1.2 MB · persistent" for the Data menu: the document's own size (localStorage
 *  keeps UTF-16, so two bytes a character) and whether the browser has promised
 *  to keep it. */
async function storageFootprint() {
  const chars = (readStateText() || '').length;
  let durable = false;
  try { durable = !!(navigator.storage && await navigator.storage.persisted()); } catch { /* not supported */ }
  return `${formatBytes(chars * 2)} \u00b7 ${durable ? 'persistent' : 'best-effort'}`;
}

// ---------- the GitHub mirror's gap ----------
// A save commits to the cloud store first and the GitHub copy is written after
// it, so a save can succeed with the repo still holding an older document — and
// until now nothing said so: the failure was logged on the server, and the
// sentence that described it never reached a screen. The proxy now compares the
// two after every save (the record's version against the repo blob's own bytes)
// and records the verdict with the document, so the app's half is to say it out
// loud: a toast the moment a gap appears or clears, and the Data menu's own line,
// which asks for a fresh comparison whenever that menu is opened.
function noteMirrorVerdict(verdict) {
  if (!verdict || typeof verdict.state !== 'string') return;
  const before = mirrorStatus(getSyncSettings().mirror);
  const now = mirrorStatus(verdict);
  patchSyncSettings({ mirror: verdict });
  // One toast per transition, never per poll: a gap that lasts an hour is one
  // thing to say once, and from then on the Data menu's line is what carries it.
  if (now.gap && !before.gap) {
    // Longer than a plain notice: this one is a fact about where the user's data
    // is, and it is the only time it is said before the Data menu repeats it.
    toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));text-align:left;' },
      iconSpan('alert'), `GitHub mirror: ${now.label} - ${now.notice}`), null, null, 8000);
  } else if (!now.gap && before.gap) {
    toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;' },
      iconSpan('sparkle'), 'The GitHub copy of your data is up to date again.'));
  }
}

/** The Data menu's mirror line: a label, the verdict, and the sentence that
 *  explains it. Built once per menu level, then filled in place. */
function mirrorRowEl() {
  const value = $('span', { class: 'display-num', style: 'font-size:12px;' }, 'Checking\u2026');
  const note = $('span', { class: 'menu-info-note' });
  const row = $('div', { class: 'menu-info mirror-line' },
    $('span', { class: 'muted', style: 'font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;' }, 'GitHub mirror'),
    value,
    note,
  );
  return { row, value, note };
}

function paintMirrorRow(parts, status) {
  parts.value.textContent = status.known ? status.label : 'Checking\u2026';
  parts.note.textContent = status.known ? status.detail : 'Asking the cloud for the last comparison.';
  parts.row.classList.toggle('gap', !!status.gap);
}

/**
 * Fill the Data menu's mirror line: what the device last saw, then the live
 * comparison, which is what makes the line describe the state NOW rather than
 * the state at the last save — a save is answered before its mirror write lands,
 * so the recorded verdict can be minutes older than what a reader is worried
 * about.
 *
 * A comparison that could not run leaves the last verdict on screen and says it
 * could not be refreshed. The one thing this must never do is stay quiet in a
 * way that reads as "fine": 'pending' is not a pass, so a check taken inside the
 * window where a save is still being mirrored is asked once more rather than
 * left there as the final word.
 */
async function refreshMirrorRow(parts) {
  const cached = mirrorStatus(getSyncSettings().mirror);
  paintMirrorRow(parts, cached);
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) {
    // No cloud copy at all: that is not a mirror that is failing, and saying so
    // either way would be an alarm about a feature this device never turned on.
    parts.value.textContent = 'No cloud copy';
    parts.note.textContent = 'Cloud sync is off on this device, so there is nothing in the cloud to mirror.';
    parts.row.classList.remove('gap');
    return;
  }
  let r = await syncCheckMirror();
  if (!r.ok) {
    if (!parts.row.isConnected) return;
    const why = r.message || r.reason || 'unreachable';
    parts.note.textContent = cached.known
      ? `${cached.detail} (Could not compare just now: ${why}.)`
      : `Could not compare the two copies just now: ${why}.`;
    return;
  }
  // A save's mirror write is given one more moment: `pending` means the check
  // that owed this version an answer has not landed yet.
  if (r.mirror.state === 'pending') {
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (!parts.row.isConnected) return;
    const again = await syncCheckMirror();
    if (again.ok) r = again;
    if (!parts.row.isConnected) return;
  }
  noteMirrorVerdict(r.mirror);
  paintMirrorRow(parts, mirrorStatus(r.mirror));
}

// ---------- a second tab is a second copy of the document ----------
// Every tab holds the whole document in memory and every save writes ALL of it
// back, so the tab that writes second erases the entry the other one just added
// — there is no per-entry write to collide safely. A storage event is the
// browser saying another tab wrote; the tab that still holds something the
// writer did not merges the two documents and writes the union back.
// foreignWriteNeeded() is what stops the two writing at each other forever:
// after one round trip neither side has anything the other lacks, so nobody
// writes again. The document is re-read from storage rather than taken from
// ev.newValue, because the event is a notification, not a snapshot (and
// newValue is null when a key is removed).
let foreignWriteTimer = 0;

function reconcileForeignWrite() {
  foreignWriteTimer = 0;
  const raw = readStateText();
  if (!raw) return;
  let incoming;
  try { incoming = JSON.parse(raw); } catch { return; }
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.entries)) return;
  const merged = validateState(mergeStates(state, incoming));
  const needed = foreignWriteNeeded(merged, incoming);
  // Adopt either way: the other tab's document is part of ours now. Only write
  // when this tab holds something the other does not.
  state = merged;
  if (needed) persist();
  render();
  if (!hasPinLock() || pinUnlocked) toast('Updated from another tab.');
}

window.addEventListener('storage', (ev) => {
  if (!ev || ev.key !== nsKey('state')) return;
  clearTimeout(foreignWriteTimer);
  foreignWriteTimer = setTimeout(reconcileForeignWrite, 120);
});

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
    || Object.values(settings.coins || {}).some(count => Number(count) > 0)
    || Number(settings.tescoVouchers || 0) > 0;
}

// ---------- merge-based reconciliation ----------
// Every pull path (boot, poll, manual, conflict recovery) funnels through
// applyReconcile. Merging never discards data: entries are unioned (newest
// version wins per entry), deletion tombstones are honored, and a newer
// reset on either side wins wholesale.

// Delete tombstones: an id stays here until every device has merged, so a
// deleted entry can never resurrect from another device's older copy.
const MAX_TOMBSTONES = 4000;
function tombstoneIds(ids) {
  const settings = state.settings || (state.settings = {});
  const list = Array.isArray(settings.deletedEntryIds) ? settings.deletedEntryIds : [];
  const set = new Set(list);
  let changed = false;
  for (const id of ids) { if (id && !set.has(id)) { set.add(id); changed = true; } }
  if (changed) {
    const capped = [...set];
    if (capped.length > MAX_TOMBSTONES) capped.splice(0, capped.length - MAX_TOMBSTONES);
    settings.deletedEntryIds = capped;
  }
}
function untombstoneIds(ids) {
  const settings = state.settings;
  if (!settings || !Array.isArray(settings.deletedEntryIds)) return;
  const set = new Set(settings.deletedEntryIds);
  let changed = false;
  for (const id of ids) { if (id && set.delete(id)) changed = true; }
  if (changed) settings.deletedEntryIds = [...set];
}

// Whose reset is newer? A reset is a deliberate "start over" - the newer
// reset wins wholesale and the other side's pre-reset data is discarded.
function resetWinnerOver(cloudContent) {
  const localReset = state.localResetAt ? Date.parse(state.localResetAt) : NaN;
  const cloudReset = cloudContent?.localResetAt ? Date.parse(cloudContent.localResetAt) : NaN;
  const hasLocal = Number.isFinite(localReset);
  const hasCloud = Number.isFinite(cloudReset);
  if (hasLocal && !hasCloud) return 'local';
  if (!hasLocal && hasCloud) return 'cloud';
  if (hasLocal && hasCloud) return localReset === cloudReset ? 'tie' : (localReset > cloudReset ? 'local' : 'cloud');
  return 'none';
}

function adoptState(raw) {
  state = validateState(raw);
  clearBalanceCaches();
  saveState(state);
  updateAllowedCategories(allCategories().map(c => c.id));
  updateAllowedMethods(everyMethod().map(m => m.id));
}

// A cloud response that arrives after the user switched profiles belongs to
// the profile we left (sync.js stamps each pull with the one it spoke for).
// Applying it would copy one person's file into another's document, or write
// one profile's SHA into another's sync settings, so every apply point checks
// this first.
function staleResponse(r) {
  return !!r && !!r.profile && r.profile !== (getActiveProfileId() || 'personal');
}

// Fold a pull result into local state. Never discards data. Returns
// 'adopted' (cloud merged in), 'pushed' (local kept, push queued),
// 'error' (nothing changed).
async function applyReconcile(r, { quiet = false, boot = false } = {}) {
  if (staleResponse(r)) return 'stale';
  if (!r.ok) {
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
    notifySyncChange();
    return 'error';
  }
  // Every pull carries the gap verdict the last save recorded, so a save made on
  // another device — or on this one, in a tab that has since been closed — still
  // reaches a screen here. Nothing is measured on this path: the verdict rode
  // along with the document the pull already fetched.
  if (r.mirror) noteMirrorVerdict(r.mirror);
  if (!r.content) {
    // No cloud file yet - first sync. Keep local; a push creates the file.
    markSyncOk({ lastError: null, lastErrorAt: null });
    if (hasLocalDataToProtect()) {
      if (!quiet) toast('First sync - pushing your data to the cloud.');
      scheduleSyncPush();
    }
    notifySyncChange();
    return 'pushed';
  }
  if (!isUsableCloudContent(r.content)) {
    patchSyncSettings({ lastError: 'malformed cloud data', lastErrorAt: new Date().toISOString() });
    if (!quiet) toast('Cloud data is malformed - local data was kept.');
    notifySyncChange();
    return 'error';
  }
  const winner = resetWinnerOver(r.content);
  if (winner === 'local') {
    // This device reset more recently than the cloud - keep local and push it
    // over the cloud (merging would resurrect the entries the reset cleared).
    markSyncOk({ lastSha: r.sha, lastError: null, lastErrorAt: null });
    if (!quiet) toast('A reset happened on this device after the cloud copy - local data kept.');
    scheduleSyncPush();
    notifySyncChange();
    return 'pushed';
  }
  // 'tie' (identical reset marker) falls through to the merge below - both
  // sides are post-reset, so unioning can only add genuinely new entries, and
  // skipping would silently hide them on this device.
  if (winner === 'cloud') {
    adoptState(r.content);
    markSyncOk({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
    if (!quiet) toast('A reset happened on another device - this device now matches the cloud.');
    notifySyncChange();
    render();
    return 'adopted';
  }
  // Normal merge: union entries, newest version wins per entry, tombstones honored.
  const prevCount = state.entries.length;
  const merged = mergeStates(cloudPayload(), r.content);
  adoptState(merged);
  const diff = state.entries.length - prevCount;
  markSyncOk({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
  if (!quiet) {
    if (diff > 0) toast(`Synced ${diff} new entr${diff === 1 ? 'y' : 'ies'} from another device.`);
    else if (diff < 0) toast(`Removed ${-diff} entr${diff === -1 ? 'y' : 'ies'} deleted on another device.`);
    else if (boot && prevCount === 0) toast(state.entries.length ? `Welcome back - pulled ${state.entries.length} entr${state.entries.length === 1 ? 'y' : 'ies'} from the cloud.` : 'Cloud is empty - nothing to pull.');
    else toast('In sync with the cloud.');
  }
  notifySyncChange();
  render();
  return 'adopted';
}

// ---------- sync setup links ----------
// A new device can adopt sync without typing the app password. The link
// carries a signed, expiring setup TOKEN minted by the Worker — never
// the raw password — so the credential does not land in access logs, browser
// history, or any intermediary. The handler below only STASHES the parsed
// link at boot; nothing is applied until the user confirms after unlock, and
// the endpoint is whitelisted to this site's own function path (or the
// endpoint this device already trusts), so a crafted link cannot redirect the
// user's data to a stranger's server.
function parseSetupLink(raw) {
  const decoded = decodeURIComponent(raw);
  let endpoint = null;
  let secret = decoded;
  // endpoint|secret is only meaningful when the part before the pipe looks
  // like a real endpoint; otherwise the whole string is the secret, so a
  // secret that itself contains '|' round-trips unharmed.
  const separator = decoded.indexOf('|');
  if (separator >= 0) {
    const possibleEndpoint = decoded.slice(0, separator);
    const looksLikeEndpoint = possibleEndpoint === ''
      || /^\/(?!\/)/.test(possibleEndpoint)
      || /^https:\/\//i.test(possibleEndpoint)
      || /^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(possibleEndpoint);
    if (looksLikeEndpoint) {
      endpoint = possibleEndpoint || null;
      secret = decoded.slice(separator + 1);
    }
  }
  if (!secret) return { error: 'invalid' };
  // New-style links carry an encrypted token with a fixed structure:
  // t2.<16-char iv>.<ciphertext>.<22-char tag> (base64url segments). The
  // exact segment lengths make it effectively impossible for a real password
  // to be mistaken for a token. Legacy 't1.' tokens can no longer be redeemed
  // (the HMAC format is gone), so they fall through to the password shape.
  // Legacy links carrying a raw password still work, but must be ≥ 8 chars.
  const isToken = /^t2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{22}$/.test(secret);
  if (!isToken && !/^[\x21-\x7E]{8,}$/.test(secret)) return { error: 'invalid' };
  return { endpoint, secret, isToken };
}

function applySetupLinkIfPresent() {
  let raw = new URLSearchParams(location.search).get('centsSync');
  if (!raw) {
    // A link can arrive before the user is logged in on a shared device.
    // The stashed link is kept in sessionStorage and re-parsed after unlock.
    try { raw = sessionStorage.getItem('cents-pending-setup'); } catch { raw = null; }
    if (!raw) return;
    try { sessionStorage.removeItem('cents-pending-setup'); } catch { /* ignore */ }
  }
  // Never leave a credential (or a garbage link) sitting in the address bar.
  try { history.replaceState(null, '', location.pathname + location.hash); } catch {}
  try { sessionStorage.setItem('cents-pending-setup', raw); } catch { /* session unavailable */ }
  const current = getSyncSettings();
  const parsed = parseSetupLink(raw);
  if (parsed.error) {
    pendingSetupLinkToast = 'That sync link is not valid.';
    return;
  }
  let endpoint = parsed.endpoint;
  if (endpoint === null || endpoint === '') endpoint = current.endpoint || DEFAULT_SYNC_ENDPOINT;
  // Whitelist: only this site's own function path, or the endpoint this
  // device already trusts, may be adopted from a link. An arbitrary foreign
  // endpoint in a link is the exfiltration vector and is rejected outright.
  const isOwnSite = /^\/(?!\/)/.test(endpoint);
  const matchesCurrent = !!current.endpoint && endpoint === current.endpoint;
  if (!isOwnSite && !matchesCurrent) {
    pendingSetupLinkToast = 'That sync link points to a different server and was ignored.';
    return;
  }
  pendingSetupLink = { endpoint, secret: parsed.secret, isToken: parsed.isToken };
}

// Ask the user before applying a stashed setup link. Runs after unlock (or
// after onboarding) so the confirm dialog is interactive. Tokens are redeemed
// for the real password over TLS here; the raw password never appears in a URL.
async function confirmPendingSetupLink() {
  const pending = pendingSetupLink;
  if (!pending) return;
  pendingSetupLink = null;
  // The link is now in flight (or consumed): drop the cross-reload stash so
  // it cannot re-apply after a later reload.
  try { sessionStorage.removeItem('cents-pending-setup'); } catch { /* ignore */ }
  const endpointLabel = isDefaultSyncEndpoint(pending.endpoint)
    ? 'this site'
    : pending.endpoint;
  let secret = pending.secret;
  let linkProfileId = null;
  let linkTabs = null;
  if (pending.isToken) {
    const r = await syncExchangeSetupToken(pending.secret, pending.endpoint);
    if (!r.ok) {
      if (r.reason === 'expired') {
        toast('That sync link has expired or already been used - generate a new one from Sync settings.');
        return;
      }
      if (r.reason === 'auth' && /^[\x21-\x7E]{8,}$/.test(pending.secret)) {
        // The server says the secret is not a valid token — most likely a
        // password that merely looked token-shaped (or a dead legacy link).
        // If it also matches the password shape, treat it as a password
        // rather than failing; the confirm dialog still gates it.
        secret = pending.secret;
      } else {
        toast('That sync link could not be redeemed' + (r.message ? `: ${r.message}` : '') + '. Open it again when you are online.');
        return;
      }
    } else {
      secret = r.password;
      linkProfileId = r.profileId;
      linkTabs = r.tabs || null;
    }
  }
  // A link minted on another device names the profile it belongs to. If this
  // device does not have that profile, adopt it — same id, so the same cloud
  // file — rather than pointing the active profile at someone else's data.
  if (linkProfileId && linkProfileId !== getActiveProfileId()) {
    const label = profileNameFromId(linkProfileId);
    const adopt = await swalConfirm({
      title: `Add profile "${label}"?`,
      text: `This link belongs to the "${linkProfileId}" profile. This device will add it, switch to it and sync it - anyone with the link can read and write that profile's data.`,
      confirmButtonText: 'Add profile',
      cancelButtonText: 'Cancel',
    });
    if (!adopt) { toast('Sync link ignored.'); return; }
    const created = createProfile(label, { id: linkProfileId });
    if (created.error) { toast(created.error); return; }
    if (!setActiveProfileId(linkProfileId)) { toast('That profile could not be opened.'); return; }
    // Written AFTER the switch, so the password lands on the adopted profile.
    // The link carries the tab policy the owner set for this account, applied
    // here so the account arrives configured rather than wide open.
    if (linkTabs?.length) patchProfileSettings(linkProfileId, { enabledTabs: linkTabs });
    patchSyncSettings({ endpoint: pending.endpoint, password: secret, enabled: true, lastError: null, lastErrorAt: null });
    loadProfileIntoApp(); // resolves the adopted profile and pulls its cloud copy on unlock
    return;
  }
  const ok = await swalConfirm({
    title: 'Enable cloud sync?',
    text: `This link configures sync to ${endpointLabel}. Anyone with the link can read and write your synced data. Allow it?`,
    confirmButtonText: 'Enable',
    cancelButtonText: 'Cancel',
  });
  if (!ok) { toast('Sync link ignored.'); return; }
  patchSyncSettings({ endpoint: pending.endpoint, password: secret, enabled: true, lastError: null, lastErrorAt: null });
  pendingSetupLinkToast = 'Cloud sync configured from link.';
  notifySyncChange();
  // Boot's startInitSync already ran with the pre-link settings; kick the
  // reconciliation loop so data flows both ways now that sync is enabled.
  startSyncPolling();
  silentSyncPoll();
  toast(pendingSetupLinkToast);
  pendingSetupLinkToast = null;
  render();
}

// ---------- sync scheduler ----------
let pushTimer = null;
let syncInFlight = false;
// Manual pull/push operations are exclusive with automatic pushes. Revision
// checks alone cannot prevent an already-started push from writing after a pull.
let syncExclusive = false;
let syncRevision = 0;
// The revision whose push the server REFUSED ('rejected' — too large, or
// failing validation). Those exact bytes can never be accepted, so automatic
// triggers skip that revision; any real change bumps syncRevision and re-arms.
let rejectedRevision = null;
// A rejected push is NOT settled by a pull succeeding: the cloud copy is still
// missing or older, and the pull says nothing about the push. Every "pull went
// fine" marker goes through here so the banner keeps saying so until a push
// actually lands, or the payload changes and a fresh attempt is made.
function markSyncOk(patch) {
  if (rejectedRevision === syncRevision) return;
  patchSyncSettings(patch);
}
function cancelScheduledSyncPush() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}
// delayMs: edits use the short debounce; a FAILED auto-push waits longer so a
// flaky server isn't hammered every 1.5s while it is down.
// `force` is for a push the user asked for by hand — the one case where
// re-sending a payload the server already refused is a request, not a loop.
function scheduleSyncPush(delayMs = 1500, force = false) {
  cancelScheduledSyncPush();
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  // Every automatic trigger (a poll, a tab becoming visible, a save) funnels
  // through here, so the refused-payload skip belongs here rather than at one
  // call site. On a phone, switching apps fires visibility changes constantly —
  // each one used to re-push bytes the server had already turned down.
  if (!force && rejectedRevision === syncRevision) return;
  pushTimer = setTimeout(doAutoPush, delayMs);
}

let sessionSyncFailed = false;
async function doPushNow(message) {
  pushTimer = null;
  if (syncInFlight || syncExclusive) { scheduleSyncPush(); return; }
  syncInFlight = true;
  const revision = syncRevision;
  try {
    // Keep every operation that can throw inside the guarded region so a
    // serialization/UI failure cannot leave automatic sync permanently locked.
    const payload = cloudPayload();
    const s = getSyncSettings();
    const profile = getActiveProfileId() || 'personal';
    setSyncPulsing(true);
    let r = await syncPush(payload, { sha: s.lastSha, message });
    // Those bytes went to the profile we spoken for above; if a switch happened
    // while the request was in flight, none of the bookkeeping below describes
    // the profile that is active now.
    if (profile !== (getActiveProfileId() || 'personal')) return;
    if (r.ok) {
      // Only a deployment that could compare the two before answering hands a
      // verdict back here (see lib/cloud.mjs); on the real one it arrives with
      // the next pull, or when the Data menu asks.
      if (r.mirror) noteMirrorVerdict(r.mirror);
      rejectedRevision = null;
      if (revision !== syncRevision) {
        // A newer local mutation happened while this request was in flight. The
        // old payload may be on the server, so retain its SHA as the parent for
        // the queued push, but never mark the newer state as synced.
        patchSyncSettings({ lastSha: r.sha });
        scheduleSyncPush();
        return;
      }
      patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
      if (sessionSyncFailed) {
        toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;' }, iconSpan('sparkle'), 'Cloud sync recovered.'));
        sessionSyncFailed = false;
      }
      notifySyncChange();
      return;
    }
    // The cloud moved underneath us (409 sha conflict, or GitHub refused a
    // sha-less write to an existing file) - pull, merge, and retry instead of
    // deadlocking or clobbering the other device's changes.
    if (r.reason === 'conflict') {
      syncInFlight = false;
      await resolveConflictAndPush();
      return;
    }
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
    if (!sessionSyncFailed) {
      toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));' }, iconSpan('alert'), 'Cloud sync failed: ' + sentence(r.message || r.reason || 'error') + ' Changes saved locally.'));
      sessionSyncFailed = true;
    }
    // Transient failures (offline, server hiccup) retry themselves after a
    // pause. A 'rejected' payload never does: the server refused those exact
    // bytes - too large, or failing validation - so only the message can help.
    if (r.reason === 'http' || r.reason === 'network') scheduleSyncPush(15000);
    rejectedRevision = r.reason === 'rejected' ? syncRevision : null;
    notifySyncChange();
  } catch (error) {
    const message = error?.message || 'sync failed';
    patchSyncSettings({ lastError: message, lastErrorAt: new Date().toISOString() });
    if (!sessionSyncFailed) {
      toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));' }, iconSpan('alert'), 'Cloud sync failed: ' + sentence(message) + ' Changes saved locally.'));
      sessionSyncFailed = true;
    }
    notifySyncChange();
  } finally {
    setSyncPulsing(false);
    syncInFlight = false;
  }
}
/**
 * A failure message, ending in exactly one full stop.
 *
 * The sync failures this feeds carry their own punctuation — the 401 sentence
 * names what was refused and the action that fixes it — so appending one more
 * turned it into "…Re-enter it in Cloud sync.. Changes saved locally.", which
 * reads as a mistake in the very message asking to be trusted.
 */
function sentence(text) {
  const trimmed = String(text || '').trim();
  return /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.';
}

function doAutoPush() { return doPushNow('cents: auto push'); }

// Conflict recovery: pull, merge into local, push the merged result back.
async function resolveConflictAndPush() {
  if (syncExclusive) { scheduleSyncPush(); return; }
  syncExclusive = true;
  try {
    const r = await syncPull();
    if (staleResponse(r)) return;
    if (!r.ok) {
      patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
      if (!sessionSyncFailed) {
        toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));' }, iconSpan('alert'), 'Cloud sync failed: ' + sentence(r.message || r.reason || 'error') + ' Changes saved locally.'));
        sessionSyncFailed = true;
      }
      notifySyncChange();
      return;
    }
    if (!r.content) {
      // Cloud file vanished or was never created - push ours fresh.
      const push = await syncPush(cloudPayload(), { sha: null, message: 'cents: auto push' });
      if (push.ok) patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: push.sha, lastError: null, lastErrorAt: null });
      notifySyncChange();
      return;
    }
    if (!isUsableCloudContent(r.content)) {
      patchSyncSettings({ lastError: 'malformed cloud data', lastErrorAt: new Date().toISOString() });
      notifySyncChange();
      return;
    }
    const winner = resetWinnerOver(r.content);
    if (winner === 'cloud') {
      adoptState(r.content);
      patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
      toast('A reset happened on another device - this device now matches the cloud.');
      notifySyncChange();
      render();
      return;
    }
    if (winner === 'local') {
      // This device reset more recently than the cloud - keep local and push
      // it over the cloud. Merging here would resurrect the entries the reset
      // cleared (the reset side has none, the union would keep the old cloud
      // entries), so never merge in this branch. A 'tie' (equal reset marker)
      // falls through to the merge below: both sides are post-reset, so the
      // union only adds genuinely new entries.
      markSyncOk({ lastSha: r.sha, lastError: null, lastErrorAt: null });
      const push = await syncPush(cloudPayload(), { sha: r.sha, message: 'cents: auto push' });
      if (push.ok) patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: push.sha, lastError: null, lastErrorAt: null });
      else {
        // Record it before retrying: a refused payload is not retried at all,
        // so this message is the only way the user hears about it.
        patchSyncSettings({ lastError: push.message || push.reason || 'error', lastErrorAt: new Date().toISOString() });
        scheduleSyncPush(); // transient failures (conflict, http, network) retry - bounded
      }
      notifySyncChange();
      return;
    }
    // Merge, adopt, and push the merged truth back to the cloud.
    const prevCount = state.entries.length;
    const merged = mergeStates(cloudPayload(), r.content);
    adoptState(merged);
    const diff = state.entries.length - prevCount;
    const pushRevision = syncRevision;
    const push = await syncPush(cloudPayload(), { sha: r.sha, message: 'cents: auto merge' });
    if (push.ok) {
      if (pushRevision !== syncRevision) {
        // Newer local edits landed mid-flight and rode along in cloudPayload();
        // keep the SHA and queue one more push to mark them synced.
        patchSyncSettings({ lastSha: push.sha, lastError: null, lastErrorAt: null });
        scheduleSyncPush();
      } else {
        patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: push.sha, lastError: null, lastErrorAt: null });
        toast(diff > 0 ? `Merged changes from another device (${diff} new entr${diff === 1 ? 'y' : 'ies'}).` : 'Merged changes from another device - nothing lost.');
        sessionSyncFailed = false;
      }
    } else if (push.reason === 'conflict' || push.reason === 'http') {
      // Raced again - don't loop forever. Retried after a pause, so a flapping
      // cloud isn't hammered and a server-refused payload never loops at all.
      patchSyncSettings({ lastError: 'conflict - will retry automatically', lastErrorAt: new Date().toISOString() });
      scheduleSyncPush(15000);
    } else {
      patchSyncSettings({ lastError: push.message || push.reason || 'error', lastErrorAt: new Date().toISOString() });
    }
    notifySyncChange();
    render();
  } finally {
    syncExclusive = false;
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
  try {
    const r = await syncPull();
    await applyReconcile(r, { boot: true });
  } finally {
    syncExclusive = false;
  }
}

// ---------- background reconciliation ----------
// Polls the cloud every 30s and re-syncs when the tab regains focus, so a
// change made on another device appears here without a reload or manual pull.
let syncPollTimer = null;
function startSyncPolling() {
  stopSyncPolling();
  syncPollTimer = setInterval(silentSyncPoll, 30000);
}
function stopSyncPolling() {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
}
// True while the user is focused in a form field inside the app mount.
// Adopting + re-rendering then would destroy the in-progress draft (render
// restores focus, not the typed value), so polls defer until focus leaves.
// Note: covers INPUT/TEXTAREA/SELECT; the app uses real inputs everywhere, so
// contenteditable drafts (tagName DIV) would not be protected if ever added.
function isTypingInApp() {
  const active = document.activeElement;
  if (!active || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false;
  const main = document.getElementById('app');
  return !main || main.contains(active);
}

async function silentSyncPoll() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  if (syncInFlight || syncExclusive) return;
  // Never rebuild the UI mid-typing - the next poll picks the change up.
  if (isTypingInApp()) return;
  syncExclusive = true;
  try {
    const r = await syncPull();
    if (!r.ok) {
      // Transient network blips shouldn't spam the header. Record the error
      // only when a successful sync has never happened, so a fresh setup
      // still gets feedback while it's being configured.
      if (!getSyncSettings().lastSyncAt) {
        patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
      }
      notifySyncChange();
      return;
    }
    if (!r.content) {
      if (hasLocalDataToProtect()) scheduleSyncPush();
      markSyncOk({ lastError: null, lastErrorAt: null });
      notifySyncChange();
      return;
    }
    if (!isUsableCloudContent(r.content)) {
      patchSyncSettings({ lastError: 'malformed cloud data', lastErrorAt: new Date().toISOString() });
      notifySyncChange();
      return;
    }
    // Only adopt when the cloud revision actually differs from what we last
    // saw - merging an identical revision would still rebuild the UI.
    if (getSyncSettings().lastSha !== r.sha) {
      await applyReconcile(r, { quiet: true });
    } else {
      markSyncOk({ lastError: null, lastErrorAt: null });
      notifySyncChange();
    }
  } finally {
    syncExclusive = false;
  }
}

let _tabVisibleTimer = null;
function onTabVisible() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) return;
  // Debounce so a focus storm (focus + visibilitychange) only pulls once.
  if (_tabVisibleTimer) return;
  _tabVisibleTimer = setTimeout(() => {
    _tabVisibleTimer = null;
    silentSyncPoll();
    scheduleSyncPush();
  }, 400);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onTabVisible();
});
window.addEventListener('focus', onTabVisible);

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
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  node.innerHTML = '';
  const status = syncStatus();
  const cls = 'sync-icon' + (_syncActive ? ' spinning' : '') + (offline ? ' offline' : status.state === 'ok' ? ' success' : '');
  node.append($('span', { class: cls, 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="icon-sync-cloud" d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline class="icon-sync-arrows" points="17 6 19 4 21 6"/><line class="icon-sync-arrows" x1="19" y1="4" x2="19" y2="10"/><polyline class="icon-sync-check" points="20 6 9 17 4 12"/></svg>' }));
  const label = offline
    ? 'Offline · saved locally'
    : (status.state === 'ok' ? status.label.replace(/^Synced /, 'synced ') : status.label);
  node.append($('span', null, label));
}

// Re-render the indicator and surface a one-time notice on connectivity
// changes, so the "saved locally, will sync later" promise is explicit.
window.addEventListener('online', () => { notifySyncChange(); toast('Back online - changes will sync.'); });
window.addEventListener('offline', () => { notifySyncChange(); toast('Offline - changes stay saved locally until you reconnect.'); });

subscribeSync(renderSyncIndicator);

// ---------- utilities ----------

/** Every payment method this document knows: the built-ins then the user's own
 *  (settings.customMethods, the add/remove manager in the menu). A method the
 *  user removed from the pickers is still in here on purpose — history has to
 *  be able to name it, and validateEntry keeps accepting it. allMethods() is
 *  what a picker is offered. */
function everyMethod() {
  return [...METHODS, ...(state.settings.customMethods || [])];
}
function methodById(id) {
  return everyMethod().find(method => method.id === id) || null;
}
/** The methods a picker offers: everyMethod() minus the ones the user took out
 *  of the pickers (settings.methodHidden). */
function allMethods() {
  const hidden = state.settings.methodHidden || {};
  return everyMethod().filter(method => hidden[method.id] !== true);
}
/** Ids for a picker whose current value is `selected`. A method removed from
 *  the pickers still has to be OFFERED for the entry that was recorded with it,
 *  or opening that entry and saving would quietly move it to another account.
 *  `base` is what the picker would offer otherwise (allMethods(), or the three
 *  credit accounts for an income entry). */
function methodPickerIds(selected, base = allMethods()) {
  const ids = base.map(method => method.id);
  if (selected && !ids.includes(selected)) ids.push(selected);
  return ids;
}
function methodShort(id) {
  const method = methodById(id);
  if (!method) return id;
  return method.label.includes(' · ') ? method.label.split(' · ')[1] : method.label;
}
function methodLabel(id) {
  return methodById(id)?.label || id;
}

/** Merge built-in categories with user-added custom ones. */
function allCategories() {
  return [...CATEGORIES, ...(state.settings.customCategories || [])];
}
function categoryLabel(id) {
  return allCategories().find(category => category.id === id)?.label || id;
}

const ACCOUNT_METHOD_IDS = ['AIB', 'Revolut', 'RS'];
const GIFT_CARD_IDS = ['TG', 'LG', 'AG'];
// Revolut Savings is excluded from the monthly budget: moving money into (or
// spending out of) savings is not "spending", so no transaction on this
// account counts toward the month's spent/income/net figures.
const BUDGET_EXCLUDED_METHOD_IDS = ['RS'];
// Account groups: a parent "account" that aggregates several sub-accounts.
// The parent holds no entries of its own; its balance is the sum of its members.
const ACCOUNT_GROUPS = [
  { id: 'revolut', label: 'Revolut', members: ['Revolut', 'RS'] },
];
/** Resolve a History "Account" filter value that refers to a whole group. */
function accountGroupForKey(key) {
  return ACCOUNT_GROUPS.find(group => `group:${group.id}` === key) || null;
}
/** Populate a <select> with standalone methods and account-group optgroups. */
function appendMethodOptions(select, ids, selectedId) {
  select.innerHTML = '';
  const groups = ACCOUNT_GROUPS.filter(group => ids.some(id => group.members.includes(id)));
  const groupedIds = new Set(groups.flatMap(group => group.members));
  for (const id of ids) {
    if (groupedIds.has(id)) continue;
    select.appendChild($('option', { value: id, selected: selectedId === id ? '' : null }, methodLabel(id)));
  }
  for (const group of groups) {
    const optgroup = $('optgroup', { label: group.label });
    for (const id of group.members) {
      if (ids.includes(id)) optgroup.appendChild($('option', { value: id, selected: selectedId === id ? '' : null }, methodLabel(id)));
    }
    select.appendChild(optgroup);
  }
  if (ids.length && !ids.includes(selectedId)) select.value = ids[0];
}
const MAX_BALANCE = 1_000_000;

// The History screen asks for a running balance per row. Three passes keep that
// linear rather than per-row quadratic, and they are the only caches left on
// this path. All three are keyed to the live `state.entries` array, so they
// cannot outlive the data they describe; anything that mutates the array in
// place instead of replacing it calls clearBalanceCaches() (see below).

// One sort and one id→index map per dataset, instead of re-sorting the whole
// ledger once per row.
let sortedViewCache = null;
function sortedView() {
  if (sortedViewCache && sortedViewCache.source === state.entries) return sortedViewCache;
  const ordered = [...state.entries].sort((a, b) => a.date.localeCompare(b.date)
    || ((a.createdAt || '')).localeCompare(b.createdAt || '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sortedViewCache = { source: state.entries, ordered, index: new Map(ordered.map((e, i) => [e.id, i])) };
  return sortedViewCache;
}

// One-pass running balance per method for the book-balance path. Rows before
// (or without) a reconciliation checkpoint anchor to the book baseline, and
// each row's "after this entry" balance is just the cumulative delta sum up to
// that row. Computing that as a single O(n) pass per state (instead of the
// O(n) per-row walk balanceForEntry used to do) is what keeps the History
// screen fast once an account grows past a few hundred entries — the per-row
// walk made the whole screen quadratic.
let runningBalanceState = null;
let runningBalanceMap = null; // Map: entryId -> balance after this entry (book path)

function liveRunningBalances() {
  if (runningBalanceState === state.entries && runningBalanceMap) return runningBalanceMap;
  runningBalanceState = state.entries;
  const checkpoints = getBalanceCheckpoints();
  const map = new Map();
  const totals = new Map(); // methodId -> running total, seeded with the book baseline
  const ordered = sortedView().ordered;
  for (const entry of ordered) {
    if (entry.type === 'note' || !BALANCE_METHOD_IDS.includes(entry.method)) continue;
    const methodId = entry.method;
    if (!totals.has(methodId)) {
      const baseline = checkpoints[methodId]?.find(p => p.date === '1970-01-01')?.balance || 0;
      totals.set(methodId, baseline);
    }
    totals.set(methodId, totals.get(methodId) + balanceDelta(entry, methodId));
    map.set(entry.id, totals.get(methodId));
  }
  runningBalanceMap = map;
  return map;
}

// Per-checkpoint running balance pass. Rows at/after a reconciliation
// checkpoint anchor to checkpoint.balance plus post-checkpoint activity; the
// per-candidate terms (changedAfterCheckpoint, oldIncluded) depend only on the
// candidate and the checkpoint, not on the row, so one O(n) walk per
// (method, checkpoint) replaces the old per-row O(n) loop that made History
// quadratic whenever a month had many rows after a reconcile.
//
// Two quirks of the original per-row loop are preserved exactly: (1) the
// current-activity sum is capped at the row's own index (candidates sort by
// date, so the loop's extra date cap is implied), and (2) the oldIncluded
// subtraction is applied to EVERY row, even ones before the mutated entry's
// index - so it is a constant per (method, checkpoint) subtracted from every
// row, computed in a separate pass.
let cpRunCacheState = null;
const cpRunCache = new Map(); // `${method}|${checkpointDate}` -> Map(entryId -> balance)

function checkpointRunningBalances(methodId, checkpoint) {
  const key = methodId + '|' + checkpoint.date;
  if (cpRunCacheState === state) {
    const hit = cpRunCache.get(key);
    if (hit) return hit;
  } else {
    cpRunCacheState = state;
    cpRunCache.clear();
  }
  const cpTime = checkpoint.at
    ? Date.parse(checkpoint.at)
    : Date.parse(`${checkpoint.date}T23:59:59.999Z`);
  const ordered = sortedView().ordered;
  // Pass 1: the constant historical-effect subtraction applied to every row.
  let oldTotal = 0;
  for (const candidate of ordered) {
    const mutationTime = entryMutationTime(candidate);
    if (Number.isFinite(mutationTime) && mutationTime > cpTime) {
      const historical = entryVersionAt(candidate, cpTime);
      const historicalCreated = historical?.createdAt ? Date.parse(historical.createdAt) : NaN;
      if (Number.isFinite(historicalCreated) && historicalCreated <= cpTime
        && versionIncludedAtCheckpoint(historical, checkpoint.date, cpTime)) {
        oldTotal += balanceDelta(historical, methodId);
      }
    }
  }
  // Pass 2: running current-activity sum, indexed by candidate position.
  const map = new Map();
  let run = checkpoint.balance;
  for (const candidate of ordered) {
    const mutationTime = entryMutationTime(candidate);
    const changedAfterCheckpoint = Number.isFinite(mutationTime) && mutationTime > cpTime;
    if (candidate.date > checkpoint.date || changedAfterCheckpoint) {
      run += balanceDelta(candidate, methodId);
    }
    if (candidate.method === methodId) map.set(candidate.id, run - oldTotal);
  }
  cpRunCache.set(key, map);
  return map;
}

function clearBalanceCaches() {
  sortedViewCache = null;
  runningBalanceState = null;
  runningBalanceMap = null;
  cpRunCacheState = null;
  cpRunCache.clear();
  // The search index is keyed to the same "the data changed" tick as these.
  bumpSearchIndex();
}

/** The reconciliation checkpoints, normalized to one array per balance method.
 *  Reading it is a handful of array references, so it is not worth caching. */
function getBalanceCheckpoints() {
  const configured = state.settings.balanceCheckpoints || {};
  return Object.fromEntries(BALANCE_METHOD_IDS.map(id => [id, Array.isArray(configured[id]) ? configured[id] : []]));
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
    if (!version || version.method !== methodId || isBalanceAdjustmentEntry(version)) return;
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
  const checkpoint = checkpointFor(methodId, targetDate, checkpoints);
  const startBalance = checkpoint?.balance || 0;
  // A dated checkpoint is authoritative for the balance at the moment it was
  // saved. Transactions on that same date that were created/edited afterwards
  // still apply, so reconciling today never hides a later same-day expense.
  const balance = entries.reduce((total, entry) => {
    if (!checkpoint) return total + (entry.date <= targetDate ? balanceDelta(entry, methodId) : 0);
    return total + entryDeltaAfterCheckpoint(entry, methodId, targetDate, checkpoint);
  }, startBalance);
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
  if (!BALANCE_METHOD_IDS.includes(methodId) || date === '1970-01-01') return null;
  const existing = state.settings.balanceCheckpoints?.[methodId];
  if (!Array.isArray(existing)) return null;
  const removed = existing.find(point => point.date === date);
  if (!removed) return null;
  state.settings.balanceCheckpoints[methodId] = existing.filter(point => point.date !== date);
  persist();
  return removed;
}
function totalAccountBalanceAt(date = today(), checkpointsByMethod = null) {
  const entries = state.entries;
  const checkpoints = checkpointsForEntries(entries, checkpointsByMethod);
  return ACCOUNT_METHOD_IDS.reduce((sum, id) => sum + balanceAtForEntries(entries, id, date, checkpoints), 0);
}

/** Reconcile every balance method to its current value in one tap, as a
 *  single undoable batch. Snapshot the prior checkpoints so Undo restores all
 *  of them exactly as they were. */
function reconcileAll() {
  const date = today();
  const prev = JSON.parse(JSON.stringify(getBalanceCheckpoints()));
  state.settings.balanceCheckpoints = state.settings.balanceCheckpoints || {};
  for (const id of BALANCE_METHOD_IDS) {
    const balance = balanceAt(id, date);
    const existing = Array.isArray(state.settings.balanceCheckpoints[id])
      ? state.settings.balanceCheckpoints[id].filter(point => point.date !== date)
      : [];
    state.settings.balanceCheckpoints[id] = [
      ...existing,
      { date, at: nowIso(), balance: Math.round(balance * 100) / 100 },
    ].sort((a, b) => a.date.localeCompare(b.date));
  }
  clearBalanceCaches();
  persist();
  trackAction(() => {
    state.settings.balanceCheckpoints = prev;
    clearBalanceCaches();
    persist();
  }, 'Reconcile all balances');
  toast(`Reconciled ${BALANCE_METHOD_IDS.length} balances to their current values.`);
  render();
}

function renderBalanceEditorRow(methodId, { label = methodShort(methodId), secondary = '', secondaryHint = '', editable = false, canLoad = false, indent = false, startInLoad = false } = {}) {
  const row = $('div', { class: 'balance-editor-row', style: `display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;${indent ? `padding-left:${isNarrow() ? '26px' : '32px'};` : ''}border-bottom:1px solid var(--line);font-size:13px;` });
  let editing = false;
  let editMode = 'reconcile'; // 'reconcile' | 'load'
  const isGiftCard = GIFT_CARD_IDS.includes(methodId);
  // Deep-link support: #balances?load=<card> lands a row straight in its load
  // editor, so the dashboard's low-balance alert is one tap from a top-up.
  if (startInLoad && (isGiftCard || canLoad)) { editing = true; editMode = 'load'; }
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
      // ---- Load money mode (top-up credit entry) ----
      if (editMode === 'load') {
        let loadDirection = 'in'; // 'in' = load/top-up, 'out' = withdraw/spend
        const outLabel = isGiftCard ? 'Spend' : 'Withdraw';
        const loadAmount = $('input', { type: 'text', inputmode: 'decimal', value: '', placeholder: '0.00', 'aria-label': `${label} load amount`, autocomplete: 'off', style: `width:${isNarrow() ? '86px' : '104px'};padding:6px 8px;border:1px solid var(--accent);border-radius:var(--radius);text-align:right;font-size:12px;transition:border-color .15s,color .15s;` });
        const loadDate = $('input', { type: 'date', value: today(), max: today(), 'aria-label': `${label} load date`, style: `width:${isNarrow() ? '124px' : '138px'};padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);font-size:12px;` });
        // Explicit direction toggle so money-out isn't hidden behind a leading '-'.
        const dirIn = $('button', { type: 'button', class: 'pill', role: 'tab', 'aria-selected': 'true', 'aria-label': `Load onto ${label}`, style: 'height:24px;padding:0 10px;font-size:10px;border-radius:6px;cursor:pointer;', onClick: () => { loadDirection = 'in'; syncDirection(); } }, 'Load');
        const dirOut = $('button', { type: 'button', class: 'pill', role: 'tab', 'aria-selected': 'false', 'aria-label': `${outLabel} from ${label}`, style: 'height:24px;padding:0 10px;font-size:10px;border-radius:6px;cursor:pointer;', onClick: () => { loadDirection = 'out'; syncDirection(); } }, outLabel);
        const saveBtn = $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:5px 9px;font-size:11px;', onClick: loadSave }, iconSpan('plus', 'sm'), 'Load');
        function loadSave() {
          const raw = String(loadAmount.value).trim();
          const isDebit = loadDirection === 'out';
          const amt = parseAmount(raw);
          if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); loadAmount.focus(); return; }
          if (!isValidCheckpointDate(loadDate.value) || loadDate.value > today()) { toast('Choose today or an earlier date.'); loadDate.focus(); return; }
          const eid = uid();
          const cardName = methodShort(methodId);
          // Direction is carried by `type`, and amounts stay positive.
          const kind = isDebit ? (isGiftCard ? 'spend' : 'withdrawal') : 'load';
          const loadEntry = {
            id: eid, createdAt: nowIso(), date: loadDate.value,
            type: isDebit ? 'expense' : 'credit', category: 'misc',
            details: `${cardName} ${kind}`, amount: amt, method: methodId, note: ''
          };
          state.entries.push(loadEntry);
          state.entries.sort((a, b) => a.date.localeCompare(b.date));
          persist();
          trackAction(() => { state.entries = state.entries.filter(e => e.id !== eid); tombstoneIds([eid]); persist(); }, `${cardName} ${kind} ${fmt(amt)}`, [loadEntry]);
          editing = false;
          toast(isDebit ? `Removed ${fmt(amt)} from ${cardName}.` : `Loaded ${fmt(amt)} onto ${cardName}.`);
          render();
        }
        // Keep pills, field color, and the action button in sync with the
        // chosen direction.
        function syncDirection() {
          const out = loadDirection === 'out';
          dirIn.setAttribute('aria-selected', out ? 'false' : 'true');
          dirIn.style.background = out ? 'transparent' : 'var(--accent-soft)';
          dirIn.style.color = out ? 'var(--muted)' : 'var(--accent)';
          dirIn.style.borderColor = out ? 'var(--line)' : 'transparent';
          dirOut.setAttribute('aria-selected', out ? 'true' : 'false');
          dirOut.style.background = out ? 'color-mix(in srgb, var(--negative) 9%, transparent)' : 'transparent';
          dirOut.style.color = out ? 'var(--negative)' : 'var(--muted)';
          dirOut.style.borderColor = out ? 'transparent' : 'var(--line)';
          loadAmount.style.borderColor = out ? 'var(--negative)' : 'var(--accent)';
          loadAmount.style.color = out ? 'var(--negative)' : 'var(--ink)';
          // The action button matches the input: solid red when money is going
          // out, back to the emerald primary when loading in.
          saveBtn.style.background = out ? 'var(--negative)' : '';
          saveBtn.style.color = out ? '#FFFFFF' : '';
          saveBtn.style.boxShadow = out ? '0 10px 34px -10px rgba(185,28,28,0.4)' : '';
          saveBtn.innerHTML = '';
          saveBtn.append(iconSpan(out ? 'minus' : 'plus', 'sm'), $('span', {}, out ? outLabel : 'Load'));
        }
        // A leading '-' remains a shorthand for money-out: flip the toggle and
        // strip the sign so the field keeps a clean positive amount.
        const syncLoadSign = () => {
          const raw = String(loadAmount.value);
          if (raw.startsWith('-')) {
            loadDirection = 'out';
            loadAmount.value = raw.replace(/^-+/, '');
          }
          syncDirection();
        };
        loadAmount.addEventListener('input', syncLoadSign);
        loadAmount.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); loadSave(); } if (ev.key === 'Escape') { editing = false; draw(); } });
        loadDate.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); loadSave(); } if (ev.key === 'Escape') { editing = false; draw(); } });
        syncDirection();
        row.append(
          $('div', { style: 'flex:1 1 100%;display:flex;flex-direction:column;gap:8px;min-width:0;' },
            $('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;min-width:0;' },
              $('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;' },
                $('span', { style: 'font-weight:500;white-space:nowrap;' }, label),
                $('div', { role: 'tablist', 'aria-label': 'Money direction', style: 'display:inline-flex;align-items:center;gap:4px;' }, dirIn, dirOut),
              ),
              $('div', { class: 'balance-editor-controls balance-editor-edit-controls', style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0;' },
                loadAmount, loadDate, saveBtn,
                $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:5px 8px;font-size:11px;', onClick: () => { editing = false; draw(); } }, 'Cancel'),
              ),
            ),
            $('div', { class: 'muted balance-editor-help', style: 'font-size:10px;line-height:1.35;' }, isGiftCard ? 'Tops up this card, or records spend against it.' : 'Adds money to this account, or withdraws from it.'),
          ),
        );
        queueMicrotask(() => loadAmount.focus());
        return;
      }
      // ---- Reconcile mode ----
      const amount = $('input', { type: 'text', inputmode: 'decimal', value: actualBalance().toFixed(2), 'aria-label': `${label} actual balance`, autocomplete: 'off', style: `width:${isNarrow() ? '86px' : '104px'};padding:6px 8px;border:1px solid var(--accent);border-radius:var(--radius);text-align:right;font-size:12px;` });
      const date = $('input', { type: 'date', value: today(), max: today(), 'aria-label': `${label} reconciliation date`, style: `width:${isNarrow() ? '124px' : '138px'};padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);font-size:12px;` });
      const help = $('div', { class: 'muted balance-editor-help', style: 'font-size:10px;line-height:1.35;' }, 'Amount is authoritative when saved. Later same-day edits and entries still apply.');
      const refreshAmountForDate = () => {
        const existing = userCheckpointFor(methodId, date.value);
        amount.value = (existing?.date === date.value ? existing.balance : bookBalanceAt(methodId, date.value)).toFixed(2);
      };
      function save() {
        const rawAmount = String(amount.value || '').trim();
        const next = rawAmount.startsWith('-') ? -parseAmount(rawAmount.slice(1)) : parseAmount(rawAmount);
        if (!Number.isFinite(next) || next < -1000000 || next > 1000000) { toast('Enter a valid actual balance.'); amount.focus(); return; }
        if (!isValidCheckpointDate(date.value) || date.value > today()) { toast('Choose today or an earlier reconciliation date.'); date.focus(); return; }
        const prevPoints = (getBalanceCheckpoints()[methodId] || []).map(p => ({ ...p }));
        if (!saveBalanceCheckpoint(methodId, date.value, next)) { toast('Could not save that reconciliation.'); return; }
        // Reconcile is undoable like every other write: undo restores the
        // checkpoints exactly as they were before this save.
        trackAction(() => {
          state.settings.balanceCheckpoints[methodId] = prevPoints;
          clearBalanceCaches();
          persist();
        }, `${label} reconciliation`);
        editing = false;
        toast(`${label} reconciled at ${fmt(next)}.`);
        render();
      }
      const saveBtn = $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:5px 9px;font-size:11px;', onClick: save }, 'Save');
      // One-tap confirm: while the amount still matches the book balance, the
      // single primary action is "Confirm (€X)" - recording it marks the
      // account reconciled without any editing.
      const syncConfirmLabel = () => {
        const raw = String(amount.value || '').trim();
        const val = raw.startsWith('-') ? -parseAmount(raw.slice(1)) : parseAmount(raw);
        const book = bookBalanceAt(methodId, date.value);
        const unchanged = Number.isFinite(val) && Math.abs(val - book) < 0.005;
        saveBtn.textContent = unchanged ? `Confirm (${fmt(book)})` : 'Save';
        help.textContent = unchanged
          ? 'Matches the book balance - one tap confirms the reconciliation.'
          : 'Amount is authoritative when saved. Later same-day edits and entries still apply.';
      };
      date.addEventListener('change', () => { refreshAmountForDate(); syncConfirmLabel(); });
      amount.addEventListener('input', syncConfirmLabel);
      amount.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { editing = false; draw(); } });
      date.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { editing = false; draw(); } });
      syncConfirmLabel();
      row.append(
        $('div', { style: 'flex:1 1 100%;display:flex;flex-direction:column;gap:8px;min-width:0;' },
          $('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;min-width:0;' },
            $('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;' },
              $('span', { style: 'font-weight:500;white-space:nowrap;' }, label),
              secondary ? $('span', { class: 'muted balance-row-meta' }, secondary) : null,
              isGiftCard ? $('span', { style: 'font-size:10px;background:var(--accent-soft);color:var(--accent);padding:2px 7px;border-radius:var(--radius);' }, 'Reconcile') : null,
            ),
            $('div', { class: 'balance-editor-controls balance-editor-edit-controls', style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0;' },
              amount, date, saveBtn,
              $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:5px 8px;font-size:11px;', onClick: () => { editing = false; draw(); } }, 'Cancel'),
            ),
          ),
          help,
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
        secondary ? $('span', { class: 'muted balance-row-meta', title: secondaryHint || null }, secondary) : null,
        summary ? $('span', { class: 'muted balance-row-meta' }, `reconciled ${friendlyDate(summary.point.date)}`) : null,
      ),
      $('div', { class: 'balance-editor-controls', style: 'display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:0;' },
        $('div', { style: 'text-align:right;' },
          $('div', { class: 'display-num', style: `font-size:14px;color:${balance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(balance)),
          summary && Math.abs(difference) >= 0.01
            ? $('div', { style: 'margin-top:2px;' }, $('span', { class: `signed-chip ${difference >= 0 ? 'is-positive' : 'is-negative'}`, style: 'font-size:10px;font-weight:700;padding:2px 9px;' }, `${difference >= 0 ? '+' : ''}${fmt(difference)} vs book`))
            : null,
        ),
        // Sizing lives in .balance-row-actions, not inline: an inline padding
        // outranks the mobile rule, and these had stayed 22×19 there.
        editable && (isGiftCard || canLoad) ? $('span', { class: 'balance-row-actions' },
          $('button', { type: 'button', class: 'btn-link', onClick: () => { editMode = 'load'; editing = true; draw(); }, 'aria-label': `Load ${label}` }, iconSpan('plus', 'sm'), 'Load'),
          $('button', { type: 'button', class: 'btn-link', onClick: () => { editMode = 'reconcile'; editing = true; draw(); }, 'aria-label': `Reconcile ${label}` }, iconSpan('pencil', 'sm')),
          isGiftCard ? $('button', { type: 'button', class: 'btn-link', onClick: () => openGiftCardHistoryModal(methodId), 'aria-label': `${label} history` }, iconSpan('clipboard', 'sm')) : null,
        ) : editable ? $('button', { type: 'button', class: 'btn-link', onClick: () => { editing = true; draw(); }, 'aria-label': `Reconcile ${label}` }, iconSpan('pencil', 'sm')) : null,
        editable && summary ? $('button', { type: 'button', class: 'btn-link', style: 'color:var(--negative);', onClick: async () => {
          if (!(await swalConfirm({ title: 'Remove reconciliation?', text: `Remove the ${label} reconciliation from ${friendlyDate(summary.point.date)}?`, confirmButtonText: 'Remove', danger: true }))) return;
          const removed = removeBalanceCheckpoint(methodId, summary.point.date);
          if (removed) {
            trackAction(() => {
              state.settings.balanceCheckpoints[methodId] = [
                ...(state.settings.balanceCheckpoints?.[methodId] || []).filter(point => point.date !== removed.date),
                removed,
              ].sort((a, b) => a.date.localeCompare(b.date));
              persist();
            }, `Removed ${label} reconciliation`, null, [{ methodId, point: { ...removed } }]);
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

/** Ordered account rows for the balance UIs: standalone accounts first, then
 *  each group as a total header plus its indented sub-account rows. */
function renderAccountBalanceRows({ editable = false, secondaryFor = () => '', secondaryHintFor = null } = {}) {
  const rows = [];
  const groupedIds = new Set(ACCOUNT_GROUPS.flatMap(group => group.members));
  // The hint has to explain whatever the meta line SAYS: the dashboard uses it
  // for reconciliation status, Balances for the forward projection, and a title
  // that describes the other one is worse than no title at all.
  const hintFor = (id) => (secondaryHintFor ? secondaryHintFor(id) : accountStatus(id).hint);
  for (const id of ACCOUNT_METHOD_IDS) {
    if (groupedIds.has(id)) continue;
    rows.push(renderBalanceEditorRow(id, { label: methodShort(id), secondary: secondaryFor(id), secondaryHint: hintFor(id), editable, canLoad: true }));
  }
  for (const group of ACCOUNT_GROUPS) {
    const total = group.members.reduce((sum, id) => sum + balanceAt(id), 0);
    rows.push($('div', { class: 'balance-editor-row account-group-row', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-bottom:1px solid var(--line);font-size:13px;background:var(--accent-soft);' },
      $('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0;flex:1;' },
        $('span', { style: 'font-weight:600;white-space:nowrap;' }, group.label),
        $('span', { style: 'font-size:10px;background:var(--accent-soft);color:var(--accent);padding:2px 7px;border-radius:var(--radius);border:1px solid var(--line);' }, 'Total'),
      ),
      $('div', { style: 'text-align:right;' },
        $('div', { class: 'display-num', style: `font-size:14px;color:${total >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(total)),
      ),
    ));
    for (const id of group.members) {
      rows.push(renderBalanceEditorRow(id, { label: methodShort(id), secondary: secondaryFor(id), secondaryHint: hintFor(id), editable, canLoad: true, indent: true }));
    }
  }
  return rows;
}

const fmt = (n) => {
  if (!Number.isFinite(n)) return '€0.00';
  const sign = n < 0 ? '−' : '';
  return `${sign}€${Math.abs(n).toFixed(2)}`;
};


// Render-time motion preference. Read once: the donut draw-in is the one
// animation left, and it falls back to the final frame when it is set.
const _reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Fill a headline figure, counting to it when it has changed.
 *
 * The count is a display and nothing more: the last frame writes the formatted
 * target, so a figure can never come to rest on a rounded-up intermediate. Each
 * figure remembers the value it was last painted with under `key`, and that
 * memory is what makes the motion mean something:
 *   · a changed figure counts from where the reader last saw it, so going back to
 *     the home screen after adding an entry shows the total moving to meet it;
 *   · a re-render that changed nothing — every keystroke repaints the screen —
 *     writes the number and does not move at all;
 *   · a figure that has never been painted arrives already at its value, because
 *     counting up from zero on first sight is decoration, not information.
 * Reduced motion (and a non-browser) gets the number, instantly.
 */
const _figureValues = new Map();
const _figureFrames = new Map();
function paintFigure(el, key, value, format = fmt) {
  if (!el || !Number.isFinite(value)) return;
  const prev = _figureValues.get(key);
  _figureValues.set(key, value);
  const cancel = _figureFrames.get(key);
  if (cancel) { cancel(); _figureFrames.delete(key); }
  const settle = () => { el.textContent = format(value); };
  if (_reduceMotion || !Number.isFinite(prev) || prev === value || typeof requestAnimationFrame !== 'function') {
    settle();
    return;
  }
  const from = prev, span = value - from, started = performance.now(), dur = 420;
  let raf = 0;
  const step = () => {
    const k = Math.min(1, (performance.now() - started) / dur);
    // easeOutCubic — leaves the mark quickly and arrives without overshoot,
    // which is the same 'calm and quick' the CSS timing tokens carry.
    el.textContent = format(from + span * (1 - Math.pow(1 - k, 3)));
    if (k < 1) raf = requestAnimationFrame(step);
    else { _figureFrames.delete(key); settle(); }
  };
  raf = requestAnimationFrame(step);
  _figureFrames.set(key, () => cancelAnimationFrame(raf));
}

// Whole days from today until an ISO date; negative = in the past.
function daysUntil(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return Infinity;
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
}

const monthKey = (date) => date.slice(0, 7);
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const FRIENDLY_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// Built once: constructing a DateTimeFormat costs more than using one, and the
// Thursday rows below format one per row per render.
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return MONTH_FORMATTER.format(new Date(Date.UTC(y, m - 1, 1)));
};
const friendlyDate = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '-';
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
/** Manual Load/Withdraw balance adjustments move money between tracked
 *  balances rather than representing real spending or income. The balance
 *  editor records them with a deterministic "<method> load|withdrawal|spend"
 *  description, so both new and legacy entries are recognised without a
 *  schema change. */
function isBalanceAdjustmentEntry(entry) {
  if (!entry || typeof entry.details !== 'string') return false;
  // Compared case-insensitively: the balance editor writes "Aldi withdrawal"
  // and the quick field title-cases the same phrase to "Aldi Withdrawal", and
  // both describe the same adjustment - one of them must not count as spending.
  const details = entry.details.trim().toLowerCase();
  const short = methodShort(entry.method).toLowerCase();
  return details === `${short} load`
    || details === `${short} withdrawal`
    || details === `${short} spend`;
}
function isSpendingEntry(entry) {
  return entry.type === 'expense' && !entry.transferId && !isBalanceAdjustmentEntry(entry);
}
/** Spending that counts against the monthly budget (excludes savings). */
function isBudgetExcluded(entry) {
  // Explicit per-transaction override; legacy entries remain included.
  return entry?.budgetExcluded === true;
}
function isBudgetSpendingEntry(entry) {
  return isSpendingEntry(entry) && !isBudgetExcluded(entry) && !BUDGET_EXCLUDED_METHOD_IDS.includes(entry.method);
}
function isIncomeEntry(entry) {
  return entry.type === 'credit' && !entry.transferId && !isBalanceAdjustmentEntry(entry);
}
/** Income that counts toward the month's figures (excludes savings). */
function isBudgetIncomeEntry(entry) {
  return isIncomeEntry(entry) && !isBudgetExcluded(entry) && !BUDGET_EXCLUDED_METHOD_IDS.includes(entry.method);
}
function totalForMonth(key) {
  return entriesForMonth(key).reduce((s, e) => s + (isBudgetSpendingEntry(e) ? e.amount : isBudgetIncomeEntry(e) ? -e.amount : 0), 0);
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
  // The dashboard sparkline only reads the last 30 points, and each distinct
  // date costs an O(n) totalAccountBalanceAt walk, so computing every
  // historical date made the whole screen quadratic as the account grew.
  // Walk the sorted list once, collect the 30 most recent distinct dates, and
  // compute balances only for those - identical output, O(n) total.
  const points = [];
  for (let index = sorted.length - 1; index >= 0 && points.length < 30; index--) {
    const e = sorted[index];
    if (points.at(-1)?.date === e.date) continue;
    points.push({ date: e.date, balance: totalAccountBalanceAt(e.date, checkpointsByMethod) });
  }
  points.reverse();
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
  // When walking live state (the History path), reuse the memoized sort and a
  // Map lookup instead of sorting the full dataset once per row.
  const usingLiveState = entries === state.entries && !checkpointsByMethod;
  if (useBookBalance && usingLiveState) {
    // Fast path: the precomputed one-pass running balance covers every row
    // before any reconciliation checkpoint. Equivalent to the cumulative
    // book-balance sum below, but O(1) per row instead of O(n).
    const running = liveRunningBalances();
    const value = running.get(entry.id);
    if (value !== undefined) return value;
  }
  if (!useBookBalance && usingLiveState) {
    // Fast path: rows at/after a reconciliation checkpoint read from the
    // one-pass per-checkpoint running balance instead of re-walking the whole
    // dataset once per row.
    const cpMap = checkpointRunningBalances(entry.method, checkpoint);
    const value = cpMap.get(entry.id);
    if (value !== undefined) return value;
  }
  const sorted = usingLiveState ? sortedView() : null;
  const ordered = sorted
    ? sorted.ordered
    : [...entries].sort((a, b) => a.date.localeCompare(b.date)
      || ((a.createdAt || '')).localeCompare(b.createdAt || '')
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const targetIndex = sorted
    ? (sorted.index.get(entry.id) ?? -1)
    : ordered.findIndex(candidate => candidate.id === entry.id);
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
      if (entry.method !== methodId || entry.date > asOfDate || entry.type === 'note' || isBalanceAdjustmentEntry(entry)) continue;
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

/** Gift card transaction history modal - shows every load, spend, and
 * reconciliation checkpoint for a single card with running balances. */
function openGiftCardHistoryModal(methodId) {
  const cardName = methodShort(methodId);
  const totals = computeGiftCardBalance(state.entries, methodId);
  const isNarrowView = isNarrow();

  // Gather entries + checkpoints, sorted by date then id
  const cardEntries = state.entries
    .filter(e => e.method === methodId && e.type !== 'note')
    .sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
  const checkpoints = (getBalanceCheckpoints()[methodId] || [])
    .filter(cp => cp.date !== '1970-01-01');

  // Build entry lookup map for fast id-based access in the balance walk
  const entryById = new Map(cardEntries.map(e => [e.id, e]));
  const sortedCheckpoints = [...checkpoints].sort((a, b) => a.date.localeCompare(b.date));

  // Build timeline: merge entries + checkpoints, sorted by date (entries before checks on same date)
  const rawTimeline = [];
  for (const entry of cardEntries) {
    const isLoad = entry.type === 'credit' || entry.category === 'GC';
    rawTimeline.push({
      kind: 'entry',
      date: entry.date,
      id: entry.id,
      details: entry.details || '',
      isLoad,
      amount: isLoad ? entry.amount : -entry.amount,
      entryAmount: entry.amount,
    });
  }
  for (const cp of sortedCheckpoints) {
    rawTimeline.push({ kind: 'checkpoint', date: cp.date, balance: cp.balance });
  }
  rawTimeline.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'checkpoint' ? 1 : -1));

  // Walk forward, applying balanceDelta per entry and resetting at checkpoints
  const timeline = [];
  let running = 0;
  for (const item of rawTimeline) {
    if (item.kind === 'checkpoint') {
      running = item.balance;
      timeline.push({ ...item });
    } else {
      const entry = entryById.get(item.id);
      running += balanceDelta(entry, methodId);
      timeline.push({ ...item, runningBalance: running });
    }
  }

  // Build modal
  const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${cardName} history`, tabindex: '-1', style: `max-width:${isNarrowView ? '100%' : '540px'};max-height:85vh;overflow-y:auto;` });
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.appendChild(modal);
  document.body.appendChild(bg);

  // Header
  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:24px;' }, `${cardName}`),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));

  // Summary card
  const summaryGrid = $('div', { style: `display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:16px;background:var(--card);border-radius:var(--radius);margin-bottom:20px;` });
  const summaryStat = (label, value, color) => $('div', { style: 'text-align:center;' },
    $('div', { class: 'eyebrow' }, label),
    $('div', { class: 'display-num', style: `font-size:16px;margin-top:4px;color:${color || 'inherit'};` }, value),
  );
  summaryGrid.appendChild(summaryStat('Balance', fmt(totals.balance), totals.balance >= 0 ? 'var(--positive)' : 'var(--negative)'));
  summaryGrid.appendChild(summaryStat('Loaded', fmt(totals.loaded), 'var(--positive)'));
  summaryGrid.appendChild(summaryStat('Spent', fmt(totals.spent), 'var(--negative)'));
  modal.appendChild(summaryGrid);

  // Timeline header
  modal.appendChild($('div', { class: 'eyebrow', style: 'margin-bottom:12px;' }, 'Transaction history'));

  if (timeline.length === 0) {
    modal.appendChild($('p', { class: 'muted', style: 'font-size:13px;text-align:center;padding:24px;' }, 'No transactions yet.'));
    return;
  }

  // Timeline rows - newest first
  const list = $('div', { style: 'display:flex;flex-direction:column;gap:1px;' });
  const sortedTimeline = [...timeline].reverse();

  for (const item of sortedTimeline) {
    if (item.kind === 'checkpoint') {
      list.appendChild($('div', { style: `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:var(--accent-soft);border-radius:var(--radius);font-size:12px;` },
        $('div', { style: 'display:flex;align-items:center;gap:8px;' },
          $('span', { style: 'font-size:11px;font-weight:500;' }, friendlyDate(item.date)),
          $('span', { style: 'font-size:10px;background:var(--accent);color:#fff;padding:1px 6px;border-radius:10px;' }, 'Reconciled'),
        ),
        $('span', { class: 'display-num', style: 'font-size:13px;font-weight:500;' }, fmt(item.balance)),
      ));
    } else {
      const sign = item.isLoad ? '+' : '−';
      const color = item.isLoad ? 'var(--positive)' : 'var(--negative)';
      list.appendChild($('div', { style: `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;` },
        $('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0;flex:1;' },
          $('span', { style: 'font-size:11px;color:var(--muted);white-space:nowrap;' }, friendlyDate(item.date)),
          $('div', { style: 'min-width:0;' },
            $('div', { style: 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, item.details || '-'),
            $('div', { class: 'display-num', style: `font-size:11px;color:${color};` }, `${sign}${fmt(item.entryAmount)}`),
          ),
        ),
        $('div', { class: 'display-num', style: `font-size:12px;text-align:right;color:${item.runningBalance >= 0 ? 'inherit' : 'var(--negative)'};` }, fmt(item.runningBalance)),
      ));
    }
  }
  modal.appendChild(list);

  queueMicrotask(() => modal.focus());
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

/** Fewest-piece coin breakdown of a euro amount across the known denominations
 *  (largest first). Used to auto-redistribute the coin counter whenever a cash
 *  entry moves the balance - the "calculator" that recombines denominations.
 *  Only non-zero denominations are emitted so a derived breakdown never
 *  clutters storage with zero-count keys. */
function coinsForAmount(rawTotal) {
  const out = {};
  let remaining = Math.max(0, Math.round((Number(rawTotal) || 0) * 100) / 100);
  for (const c of COINS) {
    if (remaining <= 0) break;
    const valCents = Math.round(c.val * 100);
    const budgetCents = Math.round(remaining * 100);
    if (budgetCents < valCents) continue;
    const count = Math.floor(budgetCents / valCents);
    if (count > 0) out[String(c.val)] = count;
    remaining = Math.round((remaining - count * c.val) * 100) / 100;
  }
  return out;
}

/** Euro held in the current physical coin counter. */
function cashTotalFromCoins() {
  return computeCashTotal({ ...COINS_DEFAULT, ...(state.settings.coins || {}) });
}

// Net euro move to cash from one entry (credit adds, expense subtracts).
function cashDeltaOf(entry) {
  if (!entry || entry.type === 'note' || entry.method !== 'Cash' || entry.type === 'transfer') return 0;
  return entry.type === 'credit' ? Number(entry.amount) || 0 : -(Number(entry.amount) || 0);
}

/** Net euro move to cash from every cash-tagged entry (credit adds, expense
 *  subtracts) - the running ledger on top of the reconciled base. */
function sumCashDeltas() {
  let sum = 0;
  for (const e of state.entries) sum += cashDeltaOf(e);
  return sum;
}

/** Current cash on hand.
 *  - While the coin counter is operator-maintained (`coinsManual` true - the
 *    user counted their coins), the balance IS the coin total.
 *  - After cash entries start auto-following (`coinsManual` false), the balance
 *    is the anchored `cashBase` plus the running cash-entry delta, and the coins
 *    are re-derived to the fewest-coin breakdown of that balance. */
function cashBalance() {
  if (state.settings.coinsManual !== false) return cashTotalFromCoins();
  const base = Number.isFinite(+state.settings.cashBase) ? Number(state.settings.cashBase) : cashTotalFromCoins();
  return Math.round((base + sumCashDeltas()) * 100) / 100;
}

/** Keep the coin-counter denominations in step with the cash balance. Runs on
 *  every persist. It only rewrites while coins follow entries (`coinsManual`
 *  is false), and leaves the user's exact counts alone while they are
 *  operator-maintained. */
function ensureCashCoins() {
  if (state.settings.coinsManual !== false) return;
  const derived = coinsForAmount(cashBalance());
  if (JSON.stringify(derived) !== JSON.stringify(state.settings.coins || {})) {
    state.settings.coins = derived;
  }
}

/** The coin counter hands over to the calculator: anchor `cashBase` so the cash
 *  balance equals the counted coins at the moment *before* the change being
 *  made, then let the ledger carry it. `appliedDelta` is the signed cash delta
 *  of that change (negative when paying cash, positive when deleting a payment);
 *  subtracting it is what makes the payment itself move the balance, instead of
 *  being swallowed by its own anchor. */
function cashAutoFollow(appliedDelta = 0) {
  if (state.settings.coinsManual === false) return;
  state.settings.cashBase = Math.round((cashTotalFromCoins() - (sumCashDeltas() - appliedDelta)) * 100) / 100;
  state.settings.coinsManual = false;
}

/** Cash as an ARBITRARY settings object + entry list reports it — the same two
 *  rules cashBalance() applies to the live document, read off a document that
 *  is not the live one (a backup being restored). Pure: no state, no writes. */
function cashFigureOf(settings, entries) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const coins = computeCashTotal({ ...COINS_DEFAULT, ...(s.coins || {}) });
  if (s.coinsManual !== false) return Math.round(coins * 100) / 100;
  const base = Number.isFinite(+s.cashBase) ? Number(s.cashBase) : coins;
  let delta = 0;
  for (const e of Array.isArray(entries) ? entries : []) delta += cashDeltaOf(e);
  return Math.round((base + delta) * 100) / 100;
}

/**
 * Give a freshly merged document its cash figure back.
 *
 * mergeSettings picks scalars by timestamp, so restoring an older export used
 * to adopt its ENTRIES while keeping THIS device's untouched coin counter —
 * and the Cash line then read €0.00 underneath a ledger full of cash spending.
 * Cash follows the file when the file is the side that actually has a number,
 * shifted by whatever cash entries this device holds that the file does not.
 * With no figure anywhere, the ledger itself is the anchor: switch to
 * auto-follow over the merged cash deltas rather than showing an empty counter
 * above a full history.
 *
 * Returns true when it wrote, so a caller (or a test) can see the effect.
 */
function adoptBackupCash(backup) {
  if (cashBalance() !== 0) return false;          // this device already has a figure
  const bSet = backup && typeof backup === 'object' ? backup.settings : null;
  const bEntries = backup && Array.isArray(backup.entries) ? backup.entries : [];
  const fileCash = cashFigureOf(bSet, bEntries);
  const fileDelta = bEntries.reduce((sum, e) => sum + cashDeltaOf(e), 0);
  const hasFileFigure = !!bSet && (fileCash !== 0 || bSet.coinsManual === false || Object.keys(bSet.coins || {}).length > 0);
  if (hasFileFigure) {
    const target = Math.round((fileCash + (sumCashDeltas() - fileDelta)) * 100) / 100;
    if (bSet.coinsManual === false) {
      state.settings.cashBase = Math.round((target - sumCashDeltas()) * 100) / 100;
      state.settings.coinsManual = false;
    } else {
      state.settings.coinsManual = true;
      state.settings.coins = coinsForAmount(target);
    }
    return true;
  }
  if (state.entries.some(e => e.method === 'Cash')) {
    cashAutoFollow(sumCashDeltas());
    return true;
  }
  return false;
}

// ---------- Tesco paper vouchers ----------
// The euro amount of Tesco paper vouchers on hand. Deliberately kept out of
// every balance — it is a reminder of value held as paper, not money.
const VOUCHER_NOTICE_AT = 5;
function voucherAmount() {
  const n = Number(state.settings.tescoVouchers);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

// ---------- recurring transactions ----------
function utcDateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function daysInMonthParts(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
/** Days a day-anchored cadence steps. Anything not in here is month-anchored
 *  (monthly/yearly) and lands on a day of a month instead. */
const FREQUENCY_STEPS = { daily: 1, weekly: 7, fortnightly: 14 };

function advanceRecurringDate(current, freq, dayOfMonth) {
  const [year, month, day] = current.split('-').map(Number);
  const step = FREQUENCY_STEPS[freq];
  if (step) {
    const d = new Date(Date.UTC(year, month - 1, day + step));
    return utcDateKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (freq === 'yearly') {
    // The same date a year on, clamped to the month it lands in: a 29 February
    // schedule has to reach 28 February rather than skip a year.
    const targetYear = year + 1;
    const monthIndex = month - 1;
    return utcDateKey(targetYear, monthIndex, Math.min(Number(dayOfMonth) || day, daysInMonthParts(targetYear, monthIndex)));
  }
  if (freq === 'monthly') {
    // `month` from the ISO split is 1-based (8 = August). Advance by one
    // month, then convert back to utcDateKey's 0-based index. The old code
    // passed the 1-based value straight through, so every monthly advance
    // skipped a month (Aug → Oct instead of Sep).
    const rawMonth = month + 1;
    const nextYear = year + Math.floor(rawMonth / 12);
    const normalized1Based = rawMonth % 12 || 12;
    const monthIndex = normalized1Based - 1;
    return utcDateKey(nextYear, monthIndex, Math.min(Number(dayOfMonth) || day, daysInMonthParts(nextYear, monthIndex)));
  }
  return current;
}

/** Human form of a schedule: the day-anchored cadences are just the cadence,
 *  the month-anchored ones carry the day they land on ("Monthly · 1st"). */
function frequencyLabel(freq, dayOfMonth) {
  if (freq === 'monthly' || freq === 'yearly') {
    const day = Number(dayOfMonth) || 1;
    return `${freq === 'monthly' ? 'Monthly' : 'Yearly'} · ${day}${ordinal(day)}`;
  }
  return { daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly' }[freq] || 'Weekly';
}

/** How far a `while (nextDate <= …)` walk may go before it gives up. A daily
 *  schedule paid six months late needs ~180 steps; a monthly one needs one. An
 *  unbounded guard is how a stalled schedule turns into a hung tab. */
const advanceBudget = (freq) => (freq === 'daily' ? 400 : 48);

function computeInitialNextDate(freq, dayOfMonth) {
  const now = new Date();
  const requestedDay = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
  const step = FREQUENCY_STEPS[freq];
  if (step) {
    // Day-anchored: walk the cadence forward from this month's requested day
    // until it stands in the future.
    let candidate = new Date(now.getFullYear(), now.getMonth(), Math.min(requestedDay, daysInMonthParts(now.getFullYear(), now.getMonth())));
    candidate.setHours(0, 0, 0, 0);
    while (candidate <= now) candidate.setDate(candidate.getDate() + step);
    return localDateKey(candidate);
  }
  // Month-anchored: this month's day (monthly), or the same date next year
  // (yearly) — either way the next one on or after now.
  const spanMonths = freq === 'yearly' ? 12 : 1;
  let year = now.getFullYear(), month = now.getMonth();
  let day = Math.min(requestedDay, daysInMonthParts(year, month));
  if (new Date(year, month, day) <= now) {
    month += spanMonths;
    year += Math.floor(month / 12);
    month %= 12;
    day = Math.min(requestedDay, daysInMonthParts(year, month));
  }
  return utcDateKey(year, month, day);
}

/**
 * A charge worth putting on the schedule, found in the ledger itself.
 *
 * Three occurrences of the same description at the same amount, spread at
 * least five days apart and regular enough to read as a cadence rather than a
 * coincidence — two gaps have to agree within a few days of each other, or
 * "rent + a one-off + rent" would look monthly. A rule that already covers the
 * description and amount silences it (whatever account it was written for),
 * and so does the reader's own "Not now".
 *
 * Returns `{ key, entry, count, frequency, dayOfMonth }` — the entry is the
 * most recent one, which is what carries the description, amount, account and
 * category the new rule copies.
 */
function recurringSuggestion() {
  const pair = (details, amount) => `${String(details || '').trim().toLowerCase()}|${Math.round((Number(amount) || 0) * 100)}`;
  const rules = Array.isArray(state.settings.recurring) ? state.settings.recurring : [];
  const taken = new Set(rules.map(r => pair(r.details, r.amount)));
  const groups = new Map();
  for (const e of state.entries) {
    if (!e || (e.type !== 'expense' && e.type !== 'credit')) continue;
    const key = pair(e.details, e.amount);
    if (key === '|' || taken.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const candidates = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    const dates = list.map(e => e.date).sort();
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)) / 86400000));
    }
    if (gaps.some(g => g < 5)) continue;              // a habit, not a bill
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (Math.max(...gaps) - Math.min(...gaps) > Math.max(3, Math.round(median * 0.5))) continue;
    // Which cadence the gaps describe. Anything that is neither a supported
    // cadence nor within a month of one is left alone rather than filed under
    // the nearest fit: a quarterly bill suggested as yearly would be wrong by
    // nine months, and wrong schedules are worse than no suggestion.
    let frequency;
    if (median <= 45) frequency = median <= 10 ? 'weekly' : median <= 20 ? 'fortnightly' : 'monthly';
    else if (median >= 330 && median <= 400) frequency = 'yearly';
    else continue;
    const last = list.reduce((a, b) => (a.date > b.date ? a : b));
    candidates.push({ key, entry: last, count: list.length, frequency, median, dayOfMonth: Number(last.date.slice(8, 10)) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.count - a.count || (b.entry.date > a.entry.date ? 1 : -1));
  return candidates[0];
}

/** The suggestion as a card, or null: silent when there is no pattern, when
 *  one is already scheduled, and once the reader has said "Not now". */
function recurringSuggestionCard() {
  const s = recurringSuggestion();
  if (!s) return null;
  const dismissedKey = `rec-suggest:${s.key}`;
  if (alertDismissed(dismissedKey)) return null;
  const cadence = {
    daily: 'every day',
    weekly: 'every week',
    fortnightly: 'every two weeks',
    monthly: `every month on the ${ordinal(s.dayOfMonth)}`,
    yearly: 'every year',
  }[s.frequency] || `every month on the ${ordinal(s.dayOfMonth)}`;
  const add = () => {
    const rec = {
      id: 'rec_' + uid(),
      type: s.entry.type,
      details: s.entry.details,
      amount: s.entry.amount,
      method: s.entry.method,
      category: s.entry.category,
      frequency: s.frequency,
      dayOfMonth: s.dayOfMonth,
      nextDate: computeInitialNextDate(s.frequency, s.dayOfMonth),
      note: '',
    };
    if (!state.settings.recurring) state.settings.recurring = [];
    state.settings.recurring.push(rec);
    trackAction(() => {
      state.settings.recurring = state.settings.recurring.filter(r => r.id !== rec.id);
      persist();
    }, `Added recurring \u201c${rec.details}\u201d`);
    persist();
    setAlertDismissed(dismissedKey, true);
    toast(`Recurring \u201c${rec.details}\u201d added \u2014 next: ${friendlyDate(rec.nextDate)}.`);
    render();
  };
  return $('div', { class: 'card', style: `padding:${isNarrow() ? '16px' : '20px'};margin-bottom:24px;` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:6px;' }, 'Looks like a pattern'),
    $('div', { style: 'font-size:13px;line-height:1.5;' },
      $('span', { style: 'font-weight:600;' }, s.entry.details || 'That charge'),
      ` \u00b7 ${fmt(s.entry.amount)} \u00b7 ${methodShort(s.entry.method)} \u2014 ${s.count} entries, about ${cadence}.`,
    ),
    $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;' },
      $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { setAlertDismissed(dismissedKey, true); render(); } }, 'Not now'),
      $('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Add to recurring'),
    ),
  );
}

function paidRecurring(rec) {
  // The Paid button commits the pending occurrence. Same code path as the
  // upcoming-strip "Add now" button, just without a custom date.
  return payRecurringOn(rec, rec.nextDate);
}

/** Log an entry for a recurring item on a specific date, advancing nextDate
 *  only when that occurrence was the pending one. Undo removes the entry and
 *  restores nextDate. */
function payRecurringOn(rec, dateStr) {
  const entry = {
    id: uid(), createdAt: nowIso(), date: dateStr, type: rec.type,
    category: rec.category || 'misc', details: rec.details,
    amount: rec.amount, method: rec.method, note: rec.note || '',
  };
  const oldDate = rec.nextDate;
  state.entries.push(entry);
  state.entries.sort((a, b) => a.date.localeCompare(b.date));
  // Advance the schedule past the paid date so the same logical charge can
  // never be paid twice - whether this is the pending occurrence or an early
  // pre-pay from the upcoming strip. ISO dates compare correctly as strings.
  let guard = 0;
  while (rec.nextDate <= dateStr && guard++ < advanceBudget(rec.frequency)) {
    rec.nextDate = advanceRecurringDate(rec.nextDate, rec.frequency, rec.dayOfMonth);
  }
  if (entry.method === 'Cash') cashAutoFollow(cashDeltaOf(entry));
  persist();
  trackAction(() => {
    state.entries = state.entries.filter(e => e.id !== entry.id);
    tombstoneIds([entry.id]);
    rec.nextDate = oldDate;
    persist();
  }, `Paid ${rec.details}`, [entry]);
  toast(`Paid: ${rec.details} - ${fmt(rec.amount)}`);
  render();
}

/** Skip the next occurrence without logging an entry; undo restores the date. */
function skipRecurring(rec, dateStr = rec.nextDate) {
  const oldDate = rec.nextDate;
  let guard = 0;
  while (rec.nextDate <= dateStr && guard++ < advanceBudget(rec.frequency)) {
    rec.nextDate = advanceRecurringDate(rec.nextDate, rec.frequency, rec.dayOfMonth);
  }
  persist();
  trackAction(() => { rec.nextDate = oldDate; persist(); }, `Skipped ${rec.details}`);
  toast(`Skipped: ${rec.details} - next ${friendlyDate(rec.nextDate)}`);
  render();
}

/** Next occurrences of a recurring item within a horizon (default 30 days),
 *  earliest first. `limit` is how many the CALLER needs: the upcoming strip
 *  reads six, while a projection over the horizon has to count every one of
 *  them — a daily bill capped at six would project a fifth of itself. */
function upcomingOccurrences(rec, horizonDays = 30, limit = 6) {
  const out = [];
  let date = rec.nextDate;
  // The slowest cadence is daily at a step a day, so horizon + 1 walks always
  // reach past the horizon; anything beyond that means the schedule cannot
  // advance (an unknown frequency, a date that does not move) and would spin.
  let guard = 0;
  const budget = horizonDays + 2;
  while (guard++ <= budget) {
    const d = daysUntil(date);
    if (d > horizonDays) break;
    if (d >= 0) out.push(date);
    if (out.length >= limit) break;
    date = advanceRecurringDate(date, rec.frequency, rec.dayOfMonth);
  }
  return out.slice(0, limit);
}

/**
 * What this account looks like in `horizonDays` if every scheduled item on it
 * lands — the recurring list is per method, so a forward projection is per
 * account, and "already committed against this card" is the number that makes
 * a balance readable. Income counts as well as bills (a payday is a projection
 * exactly as much as a bill is), ordinary spending does not: a run-rate is
 * already said elsewhere on screen, and a forward figure that pretended the
 * shopping stops would be worse than no figure at all.
 *
 * Returns null when nothing is scheduled on the account — absence is the
 * answer, not €0.00.
 */
function accountProjection(methodId, horizonDays = 30) {
  const list = (state.settings.recurring || []).filter(r => r && r.method === methodId);
  if (!list.length) return null;
  let net = 0, count = 0;
  for (const r of list) {
    const dates = upcomingOccurrences(r, horizonDays, Infinity);
    if (!dates.length) continue;
    const each = Number(r.amount) * (r.type === 'credit' ? 1 : -1);
    net += each * dates.length;
    count += dates.length;
  }
  if (!count) return null;
  return { amount: Math.round(net * 100) / 100, count, horizonDays };
}

/** The projection as one line of meta text, or '' when there is none. It
 *  names where the account ENDS UP rather than only the change: the row
 *  already prints today's balance to its right, so the pair reads as now →
 *  then. The base is the balance AT THE HORIZON, not at today — an entry
 *  already recorded for a future day (a pre-pay, a payday logged early) is a
 *  fact about that horizon and would otherwise be missing from it — plus every
 *  scheduled item that has not been paid off the schedule yet. Kept short
 *  deliberately: the meta line is 10px nowrap on desktop. */
function accountProjectionText(methodId, horizonDays = 30) {
  const p = accountProjection(methodId, horizonDays);
  if (!p) return '';
  const at = balanceAt(methodId, offsetDateKey(today(), horizonDays));
  const after = Math.round((at + p.amount) * 100) / 100;
  return `projected ${fmt(after)} in ${p.horizonDays}d · ${p.count} due`;
}

// ---------- Tesco pay helpers ----------
// The figure the tracker repeated before it could read Tesco Pay: the last Tesco
// pay entry's amount, used only for a Thursday the tab has no recorded week for.
// It finds them by their own label, not by method: the method is where the money
// landed (`TESCO_PAY_METHOD`, the bank), and a ledger that already holds lines
// written when it was the card must keep counting as the fallback, or the amount
// would silently drop to zero for everyone who filled a Thursday before the fix.
/**
 * The dashboard's Tesco card, on demand: re-derive the month and put the tab's
 * recorded pay into the ledger in the same tap.
 *
 * The card itself is computed from `state` on every render, so what a refresh
 * adds is the second half — the Balances lines — plus a repaint that does not
 * depend on a navigation happening in between (the tab's payslip fields settle
 * on a timer, so the last edit is not always followed by a render of its own).
 * Recording is recordTescoPayToLedger, the same call a Tesco commit makes: the
 * two cannot disagree about when a week becomes money, its window and its rules
 * are unchanged, and its undo is one named step. Nothing here writes anything
 * for a week with no recorded figure — that is an estimate, and an estimate in
 * the ledger is a number the user never watches arrive.
 */
function refreshTescoPay() {
  const ledger = recordTescoPayToLedger();
  if (ledger) {
    trackAction(ledger.undo, 'Tesco pay to Balances');
    toast(`${ledger.note} Refreshed from Tesco Pay.`, ledger.undo, 'Undo');
  } else {
    toast('Tesco Pay is in step — no recorded pay is missing from Balances.');
  }
  render();
}

function lastTescoPayAmount() {
  const lastTesco = [...state.entries].reverse().find(e => e.type === 'credit' && e.details === 'Tesco pay' && !isBalanceAdjustmentEntry(e));
  return lastTesco ? lastTesco.amount : 0;
}

/** Tesco Pay's own received figure for every pay date it has one for, keyed by
 *  the Thursday the money lands — `payDateOf` of a week's Sunday, which is the
 *  date the ledger's entry carries, so a Thursday's entry and the tab's Received
 *  for that week are one figure rather than two opinions about one payment.
 *  A week with nothing recorded is absent on purpose: `receivedByPayDate` will
 *  not hand the ledger an estimate to write down as income. */
function tescoReceivedByDate() {
  const t = state.tesco || {};
  const rates = { ...TESCO_RATE_DEFAULTS, ...(state.settings.tescoRates || {}) };
  return receivedByPayDate(t.shifts || [], t.payslips || [], rates, today());
}

/** What a ledger reconciliation did, in words, for the toast that announces it.
 *  One line for the common case (a recording, so money arrived) and a count when
 *  a first run catches up several weeks at once. */
function tescoPayNote(created, updated) {
  const parts = [];
  if (created.length === 1) parts.push(`added ${fmt(created[0].amount)}`);
  else if (created.length) parts.push(`added ${created.length} weeks`);
  if (updated.length === 1) parts.push(`updated ${fmt(updated[0].amount)}`);
  else if (updated.length) parts.push(`updated ${updated.length} lines`);
  const words = parts.join(' and ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} to Balances.`;
}

/** The ledger's side of a Tesco recording, so the money reaches Balances without
 *  anyone pressing Fill. The rules — create only where the ledger is silent,
 *  follow the recorded figure while the line is still the one this app wrote,
 *  and never bring a deleted line back — live in tesco-pay.js's
 *  `tescoPayLedgerWrites` and are pinned in scripts/test-tesco.mjs. What is here
 *  is the write itself: one entry per pay date, `Tesco pay` on
 *  `TESCO_PAY_METHOD` (the bank the payslip pays into — see the constant's own
 *  note in tesco-pay.js for why it is not the Tesco card) and category misc,
 *  exactly the shape Fill has always written, plus the settings
 *  record of what was written (settings.tescoPayLedger, validated in storage.js
 *  and merged per date in sync-merge.js).
 *
 *  Answers `{ undo, note }` for the caller to fold into its own action — a Tesco
 *  commit makes it ONE undo step, and a payslip typed into the card makes it its
 *  own — or null when the recording told the ledger nothing new. Nothing here
 *  calls trackAction: the caller owns that, and two actions must not be stacked. */
function recordTescoPayToLedger() {
  const t = state.tesco || {};
  const rates = { ...TESCO_RATE_DEFAULTS, ...(state.settings.tescoRates || {}) };
  const recorded = receivedByPayDate(t.shifts || [], t.payslips || [], rates, today());
  const marks = state.settings.tescoPayLedger || {};
  // The window a CREATE may fall in - this month, up to today - which is the set
  // of Thursdays the tracker card below lists and offers to fill. Older pay dates
  // are history the user manages with Fill, and an unbounded catch-up here is
  // what turned a hand-managed balance into a year of back pay in one recording.
  const plan = tescoPayLedgerWrites(recorded, state.entries, marks, tescoPayWriteWindow(today()));
  if (!plan.create.length && !plan.update.length) return null;
  const wasMarks = { ...marks };
  const wasAmounts = [];
  const nextMarks = { ...marks };
  const created = [];
  for (const write of plan.create) {
    const entry = {
      id: uid(), createdAt: nowIso(), date: write.date, type: 'credit',
      category: 'misc', details: 'Tesco pay', amount: write.amount, method: TESCO_PAY_METHOD, note: '',
    };
    state.entries.push(entry);
    created.push(entry);
    nextMarks[write.date] = { id: entry.id, amount: write.amount };
  }
  const updated = [];
  for (const write of plan.update) {
    const entry = state.entries.find(e => e.id === write.id);
    if (!entry) continue;
    wasAmounts.push([entry.id, entry.amount]);
    entry.amount = write.amount;
    updated.push(entry);
    nextMarks[write.date] = { id: write.id, amount: write.amount };
  }
  state.settings.tescoPayLedger = nextMarks;
  state.entries.sort((a, b) => a.date.localeCompare(b.date));
  persist();
  const undo = () => {
    const gone = new Set(created.map(e => e.id));
    state.entries = state.entries.filter(e => !gone.has(e.id));
    for (const [id, amount] of wasAmounts) {
      const entry = state.entries.find(e => e.id === id);
      if (entry) entry.amount = amount;
    }
    // The record goes back with the line it describes, or undoing and recording
    // again would look like a deletion and write nothing.
    state.settings.tescoPayLedger = wasMarks;
    tombstoneIds([...gone]);
    persist();
  };
  return { undo, note: tescoPayNote(created, updated) };
}

/** The lines THIS app wrote that are still in the ledger: the ids its own record
 *  (settings.tescoPayLedger) holds. The record is what makes the repair exact -
 *  it names the lines rather than hunting for entries that look like the
 *  recorder's work, so a line the user filled by hand is never mistaken for one. */
function appWrittenTescoLines() {
  const marks = state.settings.tescoPayLedger || {};
  // `by: 'fill'` marks are the USER's own lines (withTescoFillMark). This list
  // is what the repair removes and what the menu row counts, and both promise
  // "not by you" — so a fill the user made has to stay out of it even though it
  // is in the very same record.
  const ids = new Set(Object.values(marks)
    .filter(m => m && m.by !== 'fill')
    .map(m => m.id)
    .filter(Boolean));
  return state.entries.filter(e => ids.has(e.id));
}

/** Take back every line the automatic recorder wrote, in one undoable step.
 *  The marks are KEPT and only the entries go, which is the whole of the
 *  repair: a mark whose line is missing reads as "the user deleted this", so not
 *  one of them can be written again at the next recording. Deleting the marks as
 *  well would hand the whole catch-up straight back. */
function removeAppWrittenTescoLines() {
  const removed = appWrittenTescoLines();
  if (!removed.length) { toast('No Tesco pay lines written by this app are left.'); return; }
  const ids = new Set(removed.map(e => e.id));
  state.entries = state.entries.filter(e => !ids.has(e.id));
  tombstoneIds([...ids]);
  persist();
  const undo = () => {
    state.entries.push(...removed);
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    untombstoneIds(removed.map(e => e.id));
    persist();
  };
  trackAction(undo, `Remove ${removed.length} automatic Tesco pay line${removed.length > 1 ? 's' : ''}`, removed);
  render();
  const total = r2(removed.reduce((sum, e) => sum + e.amount, 0));
  toast(`Removed ${removed.length} automatic Tesco pay line${removed.length > 1 ? 's' : ''} - ${fmt(total)}. Your own fills are untouched.`, undo, 'Undo');
}

/** What a manual Fill leaves in the record of "who wrote this pay date":
 *  `by: 'fill'`, which tescoPayLedgerWrites reads as *the user's own line* —
 *  it will neither create over that date nor move the figure typed into it.
 *
 *  The mark is what makes deleting one's OWN fill stick. Without it the date
 *  looks simply unfilled, and inside the write window the next Tesco commit
 *  would put the money straight back: the recorder could tell "the line I wrote
 *  was deleted" (its own mark) from "there was never a line" only for its own
 *  lines, so a fill the user removed in History came back on the next shift
 *  they added. Only the recorder writes marks, which is why the tag needs to
 *  exist at all — the repair action counts recorder lines and must never touch
 *  the user's.
 *
 *  Returns a NEW record; `marks` is the baseline to build from, which is
 *  exactly what the caller's undo puts back. */
function withTescoFillMark(marks, dateStr, id, amount) {
  return { ...(marks || {}), [dateStr]: { id, amount, by: 'fill' } };
}

function fillThursday(dateStr) {
  // Tesco Pay's figure for the week paid on this Thursday beats repeating the
  // last one — that is the whole point of the tracker: the entry records what
  // landed, and the tab already knows it.
  const fromTesco = tescoReceivedByDate()[dateStr];
  const amt = fromTesco ? fromTesco.amount : lastTescoPayAmount();
  if (amt > 0) {
    const eid = uid();
    const tescoEntry = { id: eid, createdAt: nowIso(), date: dateStr, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: TESCO_PAY_METHOD, note: '' };
    const wasMarks = { ...(state.settings.tescoPayLedger || {}) };
    state.entries.push(tescoEntry);
    state.settings.tescoPayLedger = withTescoFillMark(wasMarks, dateStr, eid, amt);
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist();
    trackAction(() => {
      state.entries = state.entries.filter(e => e.id !== eid);
      tombstoneIds([eid]);
      state.settings.tescoPayLedger = wasMarks;
      persist();
    }, `Tesco ${friendlyDate(dateStr)}`, [tescoEntry]);
    toast(`Filled Tesco pay for ${friendlyDate(dateStr)} - ${fmt(amt)}`);
    render();
  } else {
    openTescoFillModal(dateStr, []);
  }
}

function autoFillAll(unpaidThursdays) {
  const fromTesco = tescoReceivedByDate();
  const fallbackAmt = lastTescoPayAmount();
  const amountFor = d => (fromTesco[d] ? fromTesco[d].amount : fallbackAmt);
  // Per Thursday, not one figure for all of them: Tesco Pay knows some of these
  // weeks and not others, and the ones it knows are filled with what that week
  // actually brought rather than with whatever the last entry happened to be.
  const fillable = unpaidThursdays.filter(d => amountFor(d) > 0);
  const unknown = unpaidThursdays.filter(d => !(amountFor(d) > 0));
  if (!fillable.length) {
    if (!unpaidThursdays.length) { toast('All Thursdays are already filled.'); return; }
    // Nothing to read and no previous figure to repeat: ask, as before.
    openTescoFillModal(null, unknown);
    return;
  }
  const created = [];
  const wasMarks = { ...(state.settings.tescoPayLedger || {}) };
  let nextMarks = wasMarks;
  const createdEntries = fillable.map(d => {
    const entry = { id: uid(), createdAt: nowIso(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amountFor(d), method: TESCO_PAY_METHOD, note: '' };
    created.push(entry.id);
    nextMarks = withTescoFillMark(nextMarks, d, entry.id, entry.amount);
    state.entries.push(entry);
    return entry;
  });
  state.settings.tescoPayLedger = nextMarks;
  state.entries.sort((a, b) => a.date.localeCompare(b.date));
  persist();
  trackAction(() => {
    state.entries = state.entries.filter(e => !created.includes(e.id));
    tombstoneIds(created);
    state.settings.tescoPayLedger = wasMarks;
    persist();
  }, `Auto-fill ${fillable.length} Tesco pay Thursdays`, createdEntries);
  const total = fillable.reduce((sum, d) => sum + amountFor(d), 0);
  toast(`Auto-filled ${fillable.length} Tesco pay Thursdays - ${fmt(total)}${unknown.length ? ` (${unknown.length} left to fill)` : ''}`);
  render();
}

function openTescoFillModal(prefillDate, unpaidThursdays) {
  const data = { amount: '', date: prefillDate };
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set Tesco pay amount', tabindex: '-1', style: 'max-width:360px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);
  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const amtInput = $('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount', autocomplete: 'off', onInput: (e) => data.amount = e.target.value });

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:22px;' }, 'Tesco pay amount'),
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
      const created = [];
      const createdEntries = [];
      const wasMarks = { ...(state.settings.tescoPayLedger || {}) };
      let nextMarks = wasMarks;
      if (data.date) {
        const entry = { id: uid(), createdAt: nowIso(), date: data.date, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: TESCO_PAY_METHOD, note: '' };
        created.push(entry.id);
        createdEntries.push(entry);
        nextMarks = withTescoFillMark(nextMarks, data.date, entry.id, entry.amount);
        state.entries.push(entry);
        state.settings.tescoPayLedger = nextMarks;
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        trackAction(() => {
          state.entries = state.entries.filter(e => !created.includes(e.id));
          state.settings.tescoPayLedger = wasMarks;
          persist();
        }, `Filled Tesco pay ${friendlyDate(data.date)}`, createdEntries);
        toast(`Filled Tesco pay for ${friendlyDate(data.date)} - ${fmt(amt)}`);
      } else {
        for (const d of unpaidThursdays) {
          const entry = { id: uid(), createdAt: nowIso(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: TESCO_PAY_METHOD, note: '' };
          created.push(entry.id);
          createdEntries.push(entry);
          nextMarks = withTescoFillMark(nextMarks, d, entry.id, entry.amount);
          state.entries.push(entry);
        }
        state.settings.tescoPayLedger = nextMarks;
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        trackAction(() => {
          state.entries = state.entries.filter(e => !created.includes(e.id));
          state.settings.tescoPayLedger = wasMarks;
          persist();
        }, `Auto-fill ${unpaidThursdays.length} Tesco pay Thursdays`, createdEntries);
        toast(`Auto-filled ${unpaidThursdays.length} Tesco pay Thursdays - ${fmt(amt)} each`);
      }
      close();
      render();
    } }, data.date ? 'Fill' : `Fill ${unpaidThursdays.length} Thursdays`),
  ));
  queueMicrotask(() => amtInput.focus());
}

// ---------- undo system ----------
// A STACK of undo slots: the live closures for the last UNDO_STACK_MAX
// actions, newest first, and the journal in storage.js is their reload-safe
// serialisation — same order, same cap, one record per serialisable action.
// The toast captures the slot at creation time so a later action can't re-wire
// an earlier Undo button; the persistent undo button always reverts the latest.
let _undoStack = [];
function trackAction(undoFn, label, journalEntries, journalCheckpoints) {
  const hasEntries = Array.isArray(journalEntries) && journalEntries.length;
  const hasCheckpoints = Array.isArray(journalCheckpoints) && journalCheckpoints.length;
  const serialisable = !!(hasEntries || hasCheckpoints);
  _undoStack.unshift({ undo: undoFn, label, serialisable });
  if (_undoStack.length > UNDO_STACK_MAX) _undoStack.length = UNDO_STACK_MAX;
  if (serialisable) {
    saveUndoJournal({
      label,
      at: nowIso(),
      entries: hasEntries ? journalEntries.map(e => ({ ...e })) : [],
      checkpoints: hasCheckpoints ? journalCheckpoints.map(c => ({ methodId: c.methodId, point: { ...c.point } })) : [],
    });
  }
  // An action that cannot be serialised no longer WIPES the reload-safe record
  // of the action before it: every journal record restores itself, so the
  // older record is still true after a reload even though this one is not.
}

// Entries/checkpoints from a journal that are still missing from live state.
function missingJournalData(journal) {
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const checkpoints = Array.isArray(journal.checkpoints) ? journal.checkpoints : [];
  return {
    entries: entries.filter(j => j && !state.entries.some(e => e.id === j.id)),
    checkpoints: checkpoints.filter(c =>
      c && c.methodId && c.point
      && !(state.settings.balanceCheckpoints?.[c.methodId] || []).some(point => point.date === c.point.date)
    ),
  };
}

// Restore the entries/checkpoints captured in a reload-safe journal. Shared by
// the boot offer and the persistent undo button. Returns true if anything was
// actually re-added (false when the data already exists again).
function restoreUndoJournal(journal) {
  const missing = missingJournalData(journal);
  if (missing.entries.length) {
    state.entries.push(...missing.entries);
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    untombstoneIds(missing.entries.map(e => e.id));
  }
  for (const c of missing.checkpoints) {
    state.settings.balanceCheckpoints[c.methodId] = [
      ...(state.settings.balanceCheckpoints[c.methodId] || []).filter(point => point.date !== c.point.date),
      c.point,
    ].sort((a, b) => a.date.localeCompare(b.date));
  }
  if (missing.entries.length || missing.checkpoints.length) persist();
  return !!(missing.entries.length || missing.checkpoints.length);
}

// The most recent undoable action: the live in-memory stack first, then the
// reload-safe journal (so undo still works after a reload). A journal record
// whose data is already back in the document is SPENT — dropped, and the next
// one offered — rather than ending the search, or one stale record would hide
// every action behind it.
function lastUndoDescriptor() {
  if (_undoStack.length) return _undoStack[0];
  for (;;) {
    const journal = loadUndoJournal();
    if (!journal || !(journal.entries?.length || journal.checkpoints?.length)) return null;
    const missing = missingJournalData(journal);
    if (!missing.entries.length && !missing.checkpoints.length) { popUndoJournal(); continue; }
    return {
      label: journal.label || 'that change',
      serialisable: true,
      fromJournal: true,
      journal,
      undo: () => { restoreUndoJournal(journal); },
    };
  }
}

/** Undo one slot and retire it: out of the live stack when it is still the
 *  head, and its journal record spent with it. The head check matters — a
 *  toast's Undo can outlive the action it captured, and popping then would
 *  spend the record of a NEWER action that nothing has undone. */
function undoAction(action) {
  if (!action) return;
  action.undo();
  const wasHead = _undoStack[0] === action;
  if (wasHead) _undoStack.shift();
  if (action.fromJournal) dropUndoJournal(action.journal);
  else if (wasHead && action.serialisable) popUndoJournal();
  toast(`Undone: ${action.label}`);
  render();
}

// Revert the most recent action and retire it from the stack.
function performUndo() {
  undoAction(lastUndoDescriptor());
}

// Persistent undo control, rendered on every screen while an action is
// reversible. Hidden entirely when there is nothing to undo.
function renderUndoFab() {
  const action = lastUndoDescriptor();
  if (!action) return null;
  return $('button', {
    type: 'button',
    class: 'undo-fab',
    title: `Undo: ${action.label}`,
    'aria-label': `Undo last action: ${action.label}`,
    onClick: performUndo,
  },
    iconSpan('undo', '', 'color:var(--accent)'),
    $('span', { class: 'undo-fab-label' }, 'Undo'),
    $('span', { class: 'undo-fab-action', 'aria-hidden': 'true' }, action.label),
  );
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
// ---------- search: Fuse.js, with the local matcher as the floor ----------
// A query runs over what a person actually types — the description, the note, the
// category and account they show under, and the amount as it is printed — and it
// forgives the near-misses a hand-typed query has ("sainsburys", "cofee", letters
// in the wrong order), which the subsequence matcher cannot. Fuse is fetched when a
// search field is first used (23 KB, and most sessions never search) and this file's
// rule holds: a vendored widget never blocks the thing it decorates, so until it
// lands — or if it cannot be fetched at all — the local matcher keeps the field live.
// The result order is Fuse's own score order: a search is read as a ranking, with
// the closest match first under the field. With no query nothing is reordered.
function localSearch(entries, query) {
  return entries.filter(e => fuzzyMatch(
    [e.details, e.note, categoryLabel(e.category), methodShort(e.method), fmt(e.amount)].join(' '), query));
}
// The index is built once per DATA VERSION, not once per keystroke: every
// mutation clears the balance caches, which bumps this counter — so the index
// can never answer for changed entries, while typing (which changes no data)
// reuses the index it already has. `bumpSearchIndex` is called from
// clearBalanceCaches; the pair lives here because the ranker and its cache are
// one unit (scripts/test-ui-libs.mjs lifts this slice whole).
let fuseVersion = 0;
let fuseCache = { version: -1, fuse: null };
function bumpSearchIndex() { fuseVersion += 1; fuseCache = { version: -1, fuse: null }; }
function rankEntries(entries, query) {
  if (typeof Fuse !== 'undefined') {
    try {
      if (!fuseCache.fuse || fuseCache.version !== fuseVersion) {
        const docs = entries.map(e => ({
          entry: e,
          details: e.details || '',
          note: e.note || '',
          categoryLabel: categoryLabel(e.category),
          methodLabel: methodShort(e.method),
          amountText: fmt(e.amount),
        }));
        fuseCache = {
          version: fuseVersion,
          fuse: new Fuse(docs, {
            keys: [
              { name: 'details', weight: 0.5 },
              { name: 'note', weight: 0.25 },
              { name: 'categoryLabel', weight: 0.12 },
              { name: 'methodLabel', weight: 0.08 },
              { name: 'amountText', weight: 0.05 },
            ],
            // 0.3, measured rather than guessed (scripts/test-ui-libs.mjs runs these
            // against the vendored build): it is the loosest setting at which an amount
            // typed in full ("12.40") returns that row and not also €61.50, while "cofee",
            // "electricty", a category, an account and a note all still match. At 0.4 the
            // amount query picks up strangers — the price of a ranking that forgives too
            // much. A transposed word ("trian") is not promised either way; no threshold
            // here matches it.
            threshold: 0.3,
            ignoreLocation: true,    // the match is not expected near the start
            minMatchCharLength: 2,
            includeScore: true,
          }),
        };
      }
      return fuseCache.fuse.search(query).map(r => r.item.entry);
    } catch { /* fall through to the local matcher */ }
  }
  return localSearch(entries, query);
}
// Start fetching the ranker as soon as a search field is touched, so the first
// query of a session is ranked rather than merely matched. Cheap and idempotent:
// loadVendor caches by name and the type check short-circuits every later call.
function ensureSearchLib() {
  if (typeof Fuse !== 'undefined') return;
  loadVendor('fuse', { js: 'vendor/fuse.min.js' }).catch(() => {});
}
function searchEntries(entries, query, filters) {
  if (query) ensureSearchLib();
  const matched = query ? rankEntries(entries, query) : entries;
  return matched.filter(e => {
    if (filters.type && filters.type !== 'all' && e.type !== filters.type) return false;
    if (filters.category && filters.category !== 'all' && e.category !== filters.category) return false;
    if (filters.method && filters.method !== 'all' && e.method !== filters.method) return false;
    return true;
  });
}

// ---------- duplicate nudge ----------
// Same day, same amount, same type and a matching description almost certainly
// means the entry was logged twice. Returns the existing entry, or null.
function findPotentialDuplicate(entry) {
  if (!entry || entry.type === 'note' || entry.type === 'transfer') return null;
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const amt = Math.round(entry.amount * 100);
  return state.entries.find(e =>
    e.type === entry.type &&
    e.date === entry.date &&
    Math.round(e.amount * 100) === amt &&
    norm(e.details) === norm(entry.details)
  ) || null;
}

function openDuplicateConfirm(entry, dup, onConfirm) {
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Possible duplicate', tabindex: '-1', style: 'max-width:400px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);
  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);
  modal.appendChild($('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:24px;margin-bottom:8px;' }, 'Possible duplicate'));
  modal.appendChild($('p', { class: 'muted', style: 'font-size:13px;line-height:1.5;margin-bottom:20px;' },
    `You already have “${dup.details}” - ${fmt(dup.amount)} on ${friendlyDate(dup.date)}. Add this one anyway?`));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => { close(); onConfirm(); } }, 'Add anyway'),
  ));
  queueMicrotask(() => modal.querySelector('button')?.focus());
}

// ---------- receipt parser ----------
/**
 * A description, to a category id. The keyword table for EVERY path that has
 * to guess — the receipt parser, the natural-language entry, and the bank
 * statement importer (which takes it as a dependency rather than keeping a
 * second copy that could drift from this one).
 *
 * "gift.?card|voucher" is checked FIRST so that a "Tesco/Lidl/Aldi gift card"
 * reads as a gift-card purchase (GC) rather than groceries - the store name
 * otherwise masks the gift-card keyword. That matters: for a gift-card method,
 * a GC-category load raises the card's balance, while a plain grocery expense
 * would be counted as spending.
 */
function categoryFromDescription(desc) {
  const d = String(desc || '').toLowerCase();
  if (/gift.?card|voucher/i.test(d)) return 'GC';
  if (/grocer|tesco|lidl|aldi|supervalu|dunnes|spar|centra|m&s|marks|supermarket|shop|market/i.test(d)) return 'gro';
  if (/bus|train|luas|dart|leap|taxi|uber|petrol|diesel|fuel|parking|toll|flight|ferry/i.test(d)) return 'travel';
  if (/rent|lease|mortgage|deposit|landlord/i.test(d)) return 'rent';
  return 'misc';
}

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
  return { details: desc || s, amount: amt || 0, category: categoryFromDescription(desc) };
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

function parseNaturalLanguage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // Money is stored in cents, so a third decimal is refused rather than
  // truncated: the number on the ledger has to be the number that was typed.
  const overPrecise = overPreciseAmount(raw);
  if (overPrecise) return { error: `${overPrecise} has more decimals than euros have cents - round it to two places first.` };
  const lower = raw.toLowerCase();

  // ---- Date: today, yesterday, "N days ago", weekday names ----
  let date = today();
  if (/\byesterday\b|last night/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() - 1); date = localDateKey(d);
  } else {
    const daysAgo = lower.match(/(\d+)\s+days?\s+ago/);
    if (daysAgo) {
      const d = new Date(); d.setDate(d.getDate() - Math.min(365, +daysAgo[1])); date = localDateKey(d);
    } else {
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      for (let i = 0; i < 7; i++) {
        if (new RegExp(`\\b(?:last|this)?\\s*${dayNames[i]}\\b`).test(lower)) {
          const d = new Date();
          let diff = (d.getDay() - i + 7) % 7;
          if (diff === 0) diff = 7; // "monday" on a Monday means last week
          d.setDate(d.getDate() - diff);
          date = localDateKey(d);
          break;
        }
      }
    }
  }

  // ---- Amount: multiplier first ("2 × 4.50" = 9.00), then scored candidates ----
  let amount = NaN;
  let amountText = '';
  const mult = raw.match(/(\d+(?:[.,]\d{1,2})?)\s*[x×@]\s*(?:€|£|\$|euros?\b|eur\b)?\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (mult) {
    const qty = parseAmount(mult[1]);
    const price = parseAmount(mult[2]);
    if (Number.isFinite(qty) && Number.isFinite(price) && qty > 0 && qty <= 1000 && price > 0) {
      amount = Math.round(qty * price * 100) / 100;
      amountText = mult[0];
    }
  }
  if (!Number.isFinite(amount)) {
    // Score every number: currency-tagged / verb-tagged / decimal / trailing
    // numbers win; quantity counts ("2 coffees", "2x") lose.
    // Currency words are word-bounded so "euro" never matches the prefix of
    // a word like "eurovision" (which would otherwise swallow it as text).
    // Grouped thousands are captured whole ("1,200", "1,234.56") so a comma
    // used as a thousands separator is never mistaken for a decimal point,
    // which used to read "rent 1,200" as €1.20.
    const numRe = /(?:€|£|\$|euros?\b|eur\b)?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|£|\$|euros?\b|eur\b)?/gi;
    const candidates = [];
    let m;
    while ((m = numRe.exec(raw)) !== null) {
      const value = parseAmount(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const before = raw.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
      let score = 0;
      // Currency must be adjacent (symbol or a whole "euro(s)" word), so the
      // bonus never fires on a prefix like the "euro" in "Eurovision".
      if (/[€£$]/.test(m[0]) || /\beuros?\b/.test(m[0])) score += 100;          // currency adjacent
      if (/\b(?:spent|paid|cost|costs|bought|worth|for|at|total|amount|came to|just|only|about|around|approx)\s*$/.test(before)) score += 60; // spending verb before
      if (/[.,]\d{1,2}$/.test(m[1])) score += 30;                                // decimals → price-like
      if (/^(?:st|nd|rd|th)\b/.test(after)) continue;                           // ordinal "1st" → date, never an amount
      if (/^\s*(?:x|×|things|items|coffees|drinks|people|days|times|tickets?|kg|g|ml|litres?|l|pints|bottles|each|per|apiece|of)\b/.test(after)) score -= 80; // quantity count
      if (m.index + m[0].length >= raw.length - 1) score += 10;                  // trailing number is often the total
      candidates.push({ value, score, index: m.index, text: m[0] });
    }
    if (candidates.length) {
      // Best score wins; on ties prefer the LAST number (the trailing total).
      candidates.sort((a, b) => b.score - a.score || b.index - a.index);
      amount = candidates[0].value;
      amountText = candidates[0].text;
    }
  }
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Include an amount, for example €18.50.' };

  // ---- Method ----
  // A gift-card purchase can name the card's brand AND the payment method used
  // to fund it ("bought a Tesco giftcard worth 24 euros using Revolut"). In that
  // case the money moves from the payment method into the card - a transfer,
  // so the payment account is debited AND the card balance is loaded. When no
  // separate payment method is named, fall back to a single method.
  const detectBrand = () => {
    if (/\b(?:tesco|tesco'?s)\b/.test(lower)) return 'TG';
    if (/\b(?:lidl|lidl'?s)\b/.test(lower)) return 'LG';
    if (/\b(?:aldi|aldi'?s)\b/.test(lower)) return 'AG';
    return null;
  };
  // Which tracked method a fragment of the sentence names ("...from Revolut",
  // "...to Aldi"). Same vocabulary as the source detector, plus the cards - an
  // explicit transfer can land on a gift card just as a load can.
  const detectMethodIn = (fragment) => {
    if (/\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+(?:account|pot|fund)\b|\bfrom\s+savings\b/.test(fragment)) return 'RS';
    if (/\brevolut\b/.test(fragment)) return 'Revolut';
    if (/\baib\b|\bbank\b|current account/.test(fragment)) return 'AIB';
    if (/\bcash\b|notes|wallet|pocket/.test(fragment)) return 'Cash';
    if (/\b(?:tesco|tesco'?s)\b/.test(fragment)) return 'TG';
    if (/\b(?:lidl|lidl'?s)\b/.test(fragment)) return 'LG';
    if (/\b(?:aldi|aldi'?s)\b/.test(fragment)) return 'AG';
    return null;
  };
  // A gift-card load's funding source is an *account* (a card never funds a
  // card), so this stays brand-free - "bought a Tesco giftcard worth 24 euros"
  // must fall back to the primary account, not read Tesco as its own source.
  const detectSource = () => {
    if (/\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+(?:account|pot|fund)\b|\bfrom\s+savings\b/.test(lower)) return 'RS';
    if (/\brevolut\b/.test(lower)) return 'Revolut';
    if (/\baib\b|\bbank\b|current account/.test(lower)) return 'AIB';
    if (/\bcash\b|notes|wallet|pocket/.test(lower)) return 'Cash';
    return null;
  };
  const brand = detectBrand();
  const source = detectSource();
  // Only a genuine gift-card/voucher purchase should become a transfer into the
  // card - a plain "at Tesco from Revolut" expense must stay a single entry.
  // Accept natural ways of describing a card top-up: users may say "gift card",
  // "GC", "voucher", "put money on Tesco", or "top up Tesco".
  // A bare gift-card LOAD - "tesco load 20", "lidl loaded", "loaded 20 on aldi"
  // - moves money ONTO the card from some other payment method. The load verb
  // sitting next to the brand (either order) carries the intent, so it fires
  // even when the sentence never says "gift card" - and must not swallow
  // shopping phrasing ("top up my phone at Tesco" stays an expense).
  const isCardLoad = !!brand && (
    /\b(?:tesco|lidl|aldi)(?:'s)?\s+(?:card\s+|gc\s+|gift\s*card\s+)?(?:load(?:ed|s|ing)?|top\s*ups?|topped(?:\s*up)?|reload(?:ed|s|ing)?|recharge(?:d|s)?)\b(?!\s*(?:of|with)\b)/.test(lower)
    || /\b(?:load(?:ed|s|ing)?|top\s*ups?|topped(?:\s*up)?|reload(?:ed|s|ing)?|recharge(?:d|s)?)\s+(?:money\s+|funds\s+|[€$£]?\s*\d+(?:[.,]\d{1,2})?\s+)?(?:on|to|into|onto|in|up)?\s*(?:my\s+|the\s+)?(?:tesco|lidl|aldi)\b/.test(lower));
  const isGiftCardPurchase = isCardLoad
    || /gift.?card|\bgc\b|voucher|(?:put|add|load|top\s*up|topped\s*up|loaded)\s+(?:money\s+)?(?:on|to|into)\s+(?:my\s+)?(?:tesco|lidl|aldi)\b/i.test(lower)
    || /\b(?:top\s*up|top\s+up|add|load|put)\s+(?:my\s+)?(?:tesco|lidl|aldi)\b/i.test(lower)
    || /(?:tesco|lidl|aldi)\b.{0,24}\b(?:gift.?card|\bgc\b|voucher)\b/i.test(lower)
    || /\b(?:tesco|lidl|aldi)(?:'s)?\s+(?:card|voucher)\b/i.test(lower);
  // A load is by definition funded from elsewhere; when no account is named,
  // default to the primary account so the transfer pair is well-formed. The
  // same default applies to any gift-card purchase ("put 20 on my aldi gift
  // card") - money must come from somewhere, and a bare card-side expense
  // would credit the card with no matching debit.
  const fundingSource = source || (isGiftCardPurchase && brand ? 'AIB' : null);
  const isTransferToCard = isGiftCardPurchase && !!brand && !!fundingSource && fundingSource !== brand;
  let method = source || brand || 'AIB';

  // Only unambiguous income signals - bare "pay" or "got" is far too common
  // in expense phrasing ("pay the rent", "got petrol") to imply income.
  const isCredit = /\b(income|received|salary|paid into|got paid|paycheck|payday|wage|refund|dividend)\b/.test(lower);

  // ---- Description: strip values, then classify the leftover words ----
  // Phase 1 removes everything that is provably not descriptive (amount,
  // currency, dates, numbers, payment channels, verbs, articles). Phase 2
  // classifies the survivors: prepositions only survive mid-string (word on
  // both sides), duplicate words collapse, and content words are title-cased
  // - so "Spent €18.50 at Tesco from Revolut yesterday" → "Tesco" while
  // "pint of Guinness" keeps its meaning.
  const details = cleanQuickDescription(raw, amountText);
  const guessed = parseReceiptLine(details);
  // An explicit transfer between two tracked methods - "transfer 50 from AIB
  // to Revolut". Requiring both ends (and a transfer verb) keeps shopping
  // phrasing out: "rent 850 from AIB" has no destination and stays an expense.
  if (/\b(?:transfer(?:red|ring|s)?|moved?|sent)\b/.test(lower)) {
    const toPart = lower.match(/\b(?:to|into|onto)\s+([^,;]+)$/);
    const from = detectSource();
    const to = toPart ? detectMethodIn(toPart[1]) : null;
    if (from && to && from !== to) {
      return { date, type: 'transfer', transfer: { from, to }, amount, details, category: 'misc', method: to };
    }
  }
  if (isTransferToCard) {
    // Move the value from the payment account into the gift card. `method` is
    // kept (the card) so the preview/chips render; addQuick uses `transfer`
    // to build the two-leg transfer pair.
    return { date, type: 'transfer', transfer: { from: fundingSource, to: brand }, amount, details, category: 'GC', method: brand };
  }
  // Mixed payment: “10 cash 14 revolut” etc. - two or more payment methods each
  // next to their own amount. The slices become grouped single-method legs, and
  // the group total is the sum of the slices.
  const splices = tryParseSplitSlices(lower);
  if (splices && splices.length >= 2) {
    const splitTotal = Math.round(splices.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;
    // Drop the split methods themselves out of the description, otherwise a
    // split names the paying accounts too ("Pepper 0.49: 0.17 Aldi, 0.32
    // revolut" → "Pepper"). Amounts are already stripped by the cleaner.
    const methodWords = {
      Cash: /\b(?:cash|notes|wallet)\b/gi, RS: /\b(?:revolut\s+savings|\brs\b|savings\s+account)\b/gi,
      Revolut: /\brevolut\b/gi, AIB: /\b(?:aib|bank|current\s+account)\b/gi,
      AG: /\b(?:aldi|aldi'?s)\b/gi, LG: /\b(?:lidl|lidl'?s)\b/gi, TG: /\b(?:tesco|tesco'?s)\b/gi,
    };
    let cleanRaw = raw;
    for (const s of splices) { const mv = methodWords[s.method]; if (mv) cleanRaw = cleanRaw.replace(mv, ' '); }
    const splitDetails = cleanQuickDescription(cleanRaw, '') || 'Entry';
    return {
      date, type: isCredit ? 'credit' : 'expense', amount: splitTotal, details: splitDetails,
      category: isCredit ? 'misc' : guessed.category, method: splices[0].method, split: splices,
    };
  }
  return { date, type: isCredit ? 'credit' : 'expense', amount, details, category: isCredit ? 'misc' : guessed.category, method };
}

// ── Quick-entry description cleaner ──
// Two-phase best-effort cleaner: strip provable value-noise first (amount,
// currency, dates, ordinals, numbers, units, payment channels, verbs,
// articles), then keep the meaningful words - prepositions only when they sit
// between two content words, no consecutive duplicates, title-cased.
const QUICK_STOP = new Set([
  'the', 'a', 'an', 'i', 'my', 'our', 'some', 'any', 'just', 'only',
  'about', 'around', 'approx', 'approximately', 'am', 'pm',
  'income', 'received', 'salary', 'paid', 'got', 'paycheck', 'wage', 'wages',
  'refund', 'dividend', 'spent', 'expense', 'expenses', 'bought', 'cost',
  'costs', 'worth', 'total', 'amount', 'came',
]);
// Functional prepositions: pure glue that only survives between two content
// words ("pint of Guinness"). They never start a description on their own.
const QUICK_PREPS = new Set([
  'at', 'from', 'on', 'using', 'via', 'with', 'for', 'in', 'to', 'of', 'by',
  'per', 'each',
]);
// Positional words that double as the first word of real brand names
// ("In & Out", "On The Run", "The Point"). They are preserved at the start of
// a description when what follows looks like a proper noun (capitalised).
const QUICK_BRAND_START = new Set(['the', 'a', 'an', 'in', 'on']);
// Connectors that join two words of a name ("Fish & Chips", "Bar and Grill").
const QUICK_CONNECTORS = new Set(['&', 'and']);
const QUICK_EDGE_PUNCT = /^[,.;:!?()[\]"'\-—-]+|[,.;:!?()[\]"'\-—-]+$/g;
// Prepositions and connectors stay lowercase mid-description ("Pint of Guinness").
const QUICK_LOWERCASE = new Set([...QUICK_PREPS, 'and']);
function isContentToken(t) {
  return !!t && /[a-z0-9]/i.test(t) && !QUICK_CONNECTORS.has(t.toLowerCase())
    && !QUICK_STOP.has(t.toLowerCase()) && !QUICK_PREPS.has(t.toLowerCase());
}
function cleanQuickDescription(raw, amountText) {
  let s = String(raw || '')
    .replace(amountText ? amountText : '', ' ')
    .replace(/[€£$]/g, ' ')
    .replace(/\b(?:euro|euros|eur)\b/ig, ' ')
    // Whole date phrases BEFORE standalone numbers, or "3 days ago" → "days ago".
    .replace(/\b(?:\d+\s+days?\s+ago|(?:last|this)\s+(?:night|morning|afternoon|evening|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|today|tonight|yesterday|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/ig, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\b/ig, ' ')                                  // ordinals
    .replace(/\b\d+(?:[.,]\d{1,2})?\s*(?:kg|g|ml|litres?|l|pcs)\b/ig, ' ')  // measurement units ("2kg") - but NOT countable nouns like "3 pints", whose noun stays
    .replace(/\b\d+(?:[.,]\d{1,2})?\b/g, ' ')                                  // remaining numbers
    .replace(/\b(?:x|×|@)\s*\d+(?:[.,]\d{1,2})?\b/ig, ' ')                    // "x2"
    .replace(/\b\d+(?:[.,]\d{1,2})?\s*[x×@]\b/ig, ' ')                        // "2x"
    .replace(/\b(aib|revolut(?: savings)?|\brs\b|bank|current account|cash|notes|wallet|pocket)\b/ig, ' ') // payment channels
    .replace(/[()[]"']+/g, ' ');                                             // brackets/quotes

  const tokens = s.split(/\s+/).filter(Boolean);
  const kept = [];
  // Still at the head of the description (no content word kept yet) - the only
  // place a brand-start "In"/"On"/"The" may legitimately appear.
  const atHead = () => !kept.some(isContentToken);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(QUICK_EDGE_PUNCT, '');
    const low = t.toLowerCase();

    // Connector: keep when it visibly joins two words ("Fish & Chips",
    // "Bar and Grill"), drop when it dangles ("Dinner &", "& Sons").
    // Checked before the symbol filter so "&" survives. The left neighbour
    // must actually be the last KEPT word - a dropped stop word ("bought &
    // sold") must not let a leading "&" through.
    if (t && QUICK_CONNECTORS.has(low)) {
      const left = tokens[i - 1]?.replace(QUICK_EDGE_PUNCT, '');
      const right = tokens[i + 1]?.replace(QUICK_EDGE_PUNCT, '');
      if (kept.length && kept[kept.length - 1] === left
        && right && /[a-z0-9]/i.test(right)) kept.push(t);
      continue;
    }
    if (!t || !/[a-z0-9]/i.test(t)) continue;                                   // pure-symbol tokens

    if (QUICK_STOP.has(low)) {
      // Verbs and filler always drop. Articles keep their place only when they
      // precede a capitalised proper noun - "The Point", even mid-description
      // ("coffee at The Point") - never for a generic noun ("the rent" →
      // "rent", because "rent" is lowercase).
      const next = nextContentToken(tokens, i);
      if (QUICK_BRAND_START.has(low) && next && /[A-Z]/.test(next.charAt(0))) {
        kept.push(t);
      }
      continue;
    }

    if (QUICK_PREPS.has(low)) {
      // Prepositions survive mid-string between two content words, or at the
      // head of a proper-noun name ("In & Out") - but plain glue like
      // "at Tesco" / "from Revolut" is dropped.
      const prevContent = kept.length > 0 && isContentToken(kept[kept.length - 1]);
      const next = nextContentToken(tokens, i);
      const brandStart = atHead() && QUICK_BRAND_START.has(low) && next && /[A-Z]/.test(next.charAt(0));
      if ((prevContent && next) || brandStart) kept.push(t);
      continue;
    }

    if (kept.length && kept[kept.length - 1].toLowerCase() === low) continue;  // de-dupe
    kept.push(t);
  }

  let details = kept.join(' ')
    .replace(/\s*([,;:.])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .replace(QUICK_EDGE_PUNCT, '')
    .trim();
  if (!details) return 'Entry';
  // Title-case content words; keep prepositions/"and" lowercase mid-string, and
  // never mangle all-caps brands ("M&S", "IKEA", "B&Q").
  return details.split(' ').map((w, idx) => {
    if (idx > 0 && QUICK_LOWERCASE.has(w.toLowerCase())) return w.toLowerCase();
    if (!/[a-z]/.test(w)) return w;                                             // all-caps token stays untouched
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}
/** Best-effort split-payment detector: finds every payment-method keyword with
 *  an amount immediately before/after it. Returns sampled slices (method +
 *  amount) when two or more distinct methods are found - a strong signal the
 *  line is a mixed payment rather than a single-method entry. */
function tryParseSplitSlices(lower) {
  const rules = [
    { re: /\b(?:cash|notes|wallet)\b/g, method: 'Cash' },
    { re: /\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+account\b|\bfrom\s+savings\b/g, method: 'RS' },
    { re: /\brevolut\b/g, method: 'Revolut' },
    { re: /\baib\b|\bbank\b|\bcurrent\s+account\b/g, method: 'AIB' },
    { re: /\b(?:aldi|aldi'?s)\b/g, method: 'AG' },
    { re: /\b(?:lidl|lidl'?s)\b/g, method: 'LG' },
    { re: /\b(?:tesco|tesco'?s)\b/g, method: 'TG' },
  ];
  // An amount is claimed by ONE method only. Without this, a single number
  // sitting between two method words is read twice — “aldi 12.40 cash” gave Aldi
  // the number after it and Cash the number before it, turning €12.40 into a
  // €24.80 split. A genuine split names a separate amount per method
  // (“10 cash, 14 revolut”), so claiming spans costs nothing real.
  const usedSpans = [];
  const overlaps = (s, e) => usedSpans.some(([a, b]) => s < b && e > a);
  const found = [];
  for (const rule of rules) {
    const rx = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = rx.exec(lower)) !== null) {
      const beforeStart = Math.max(0, m.index - 60);
      const before = lower.slice(beforeStart, m.index);
      const afterStart = m.index + m[0].length;
      const after = lower.slice(afterStart, afterStart + 60);
      // Amount immediately before (allowing a currency symbol either side) is
      // the stronger signal - “10 cash” → cash:10, else an amount right after.
      const numBefore = /(\d+(?:[.,]\d{1,2})?)\s*[€£$]?\s*$/.exec(before);
      const numAfter = /^\s*[€£$]?\s*(\d+(?:[.,]\d{1,2})?)\b/.exec(after);
      const span = numBefore
        ? [beforeStart + numBefore.index, beforeStart + numBefore.index + numBefore[1].length]
        : (numAfter ? [afterStart + numAfter.index + numAfter[0].indexOf(numAfter[1]), afterStart + numAfter.index + numAfter[0].indexOf(numAfter[1]) + numAfter[1].length] : null);
      rx.lastIndex = m.index + m[0].length;
      if (!span || overlaps(span[0], span[1])) continue;
      const amt = parseAmount(numBefore ? numBefore[1] : numAfter[1]);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      usedSpans.push(span);
      found.push({ method: rule.method, amount: amt });
    }
  }
  // One slice per method (first mention wins), requires at least two methods.
  const byMethod = new Map();
  for (const slice of found) if (!byMethod.has(slice.method)) byMethod.set(slice.method, slice);
  const slices = [...byMethod.values()];
  return slices.length >= 2 ? slices : null;
}

function nextContentToken(tokens, from) {
  for (let j = from + 1; j < tokens.length; j++) {
    const nt = tokens[j].replace(QUICK_EDGE_PUNCT, '');
    if (nt && isContentToken(nt)) return nt;
  }
  return null;
}

/** The first euro-looking token in `raw` that carries more decimals than money
 *  has. Amounts are stored in cents, so a third decimal is not a rounding
 *  detail - it is a typo, and the parser used to TRUNCATE it silently ("lidl
 *  4.477" was read as 4.47) while the storage validator would drop the row it
 *  produced. Callers refuse the line instead. Thousands grouping is not a
 *  fraction: "1,200" and "1,200.50" pass, and a date ("12.07.2026") is never
 *  money. A dot with three digits stays a decimal, which is how parseAmount
 *  itself reads "1.200" - the comma is the thousands separator here. */
function overPreciseAmount(raw) {
  for (const token of String(raw || '').match(/\d[\d.,]*/g) || []) {
    const text = token.replace(/[.,]+$/, '');
    if (/^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$/.test(text)) continue;       // a date, not money
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) continue;   // 1,200 / 1,200.50
    if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(text)) continue;             // 1.200.000
    const cut = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
    if (cut < 0) continue;                                           // whole euros
    if (/^\d{3,}$/.test(text.slice(cut + 1))) return text;
  }
  return null;
}

/** The ledger rows a parsed quick entry becomes. Pure, so the two-leg transfer,
 *  the N-leg split and the single entry are asserted directly (see
 *  scripts/test-parity-money.mjs) instead of only being reachable through the
 *  Add screen's DOM: the parser decides what was said, this decides what the
 *  ledger receives, and the two halves are checked apart. */
function quickEntryLegs(parsed) {
  if (!parsed || parsed.error) return [];
  const note = 'Created with natural-language input';
  if (parsed.type === 'transfer') {
    // Funding a gift card with a payment account is a two-leg transfer: the
    // payment account is debited and the card is credited, sharing one id.
    const transferId = uid();
    const base = { createdAt: nowIso(), date: parsed.date, category: 'misc', details: parsed.details, amount: parsed.amount, note, transferId };
    return [
      { ...base, id: uid(), type: 'expense', method: parsed.transfer.from },
      { ...base, id: uid(), type: 'credit', method: parsed.transfer.to },
    ];
  }
  if (parsed.split && parsed.split.length >= 2) {
    // Mixing payment methods produces grouped single-method legs sharing a
    // splitId; they render as one row in history and budget sums them once.
    const splitId = uid();
    const createdAt = nowIso();
    return parsed.split.map(s => ({
      id: uid(), createdAt, date: parsed.date, type: parsed.type,
      category: parsed.category, details: parsed.details, amount: s.amount,
      method: s.method, note, splitId,
    }));
  }
  return [{ id: uid(), createdAt: nowIso(), date: parsed.date, type: parsed.type, category: parsed.category, details: parsed.details, amount: parsed.amount, method: parsed.method, note }];
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

/**
 * The identity of a recurring schedule as a line on the ledger.
 *
 * Entries carry no "I came from a schedule" flag, and payRecurringOn writes the
 * schedule's own type/details/amount/method/category verbatim — so that tuple
 * IS the flag. Matched case- and space-insensitively on details, the way the
 * duplicate detector reads them.
 */
function recurringEntryKey(x) {
  return [
    String(x?.type || ''),
    String(x?.details || '').trim().toLowerCase(),
    Math.round((Number(x?.amount) || 0) * 100),
    String(x?.method || ''),
    String(x?.category || ''),
  ].join('|');
}
function recurringKeySet() {
  const list = state.settings.recurring;
  return Array.isArray(list) && list.length ? new Set(list.map(recurringEntryKey)) : null;
}
function isFixedCostEntry(entry, keys) {
  return !!keys && keys.has(recurringEntryKey(entry));
}

// A projection needs a month behind it, not a weekend. Before this many days
// the average is one or two events extrapolated over thirty, and a single
// fixed charge on the 1st made week one read as "projected €5590, remaining
// −€4490".
const PROJECTION_MIN_DAYS = 7;
const PROJECTION_MIN_ENTRIES = 3;

function spendingForecast(key = monthKey(today())) {
  const now = new Date();
  const current = entriesForMonth(key);
  const expenses = current.filter(isBudgetSpendingEntry);
  const spent = expenses.reduce((sum, e) => sum + e.amount, 0);
  const elapsed = key === monthKey(today()) ? now.getDate() : daysInMonth(key);
  const totalDays = daysInMonth(key);
  // The run-rate is VARIABLE spending. A rent a schedule puts on the ledger is
  // the same euros every month, so dividing it by the days elapsed turns day 6
  // into "you burn €850 a day" — the fixed charge is spent, never projected.
  const keys = recurringKeySet();
  const variable = keys ? expenses.filter(e => !isFixedCostEntry(e, keys)) : expenses;
  const variableSpent = variable.reduce((sum, e) => sum + e.amount, 0);
  const dailyAverage = elapsed > 0 ? variableSpent / elapsed : 0;
  const ready = elapsed >= PROJECTION_MIN_DAYS && variable.length >= PROJECTION_MIN_ENTRIES;
  const projected = ready ? spent + dailyAverage * Math.max(0, totalDays - elapsed) : null;
  const budget = +state.settings.monthlyBudget || 0;
  const previous = entriesForMonth(previousMonthKey(key)).filter(isBudgetSpendingEntry);
  const previousDaily = previous.length ? previous.reduce((sum, e) => sum + e.amount, 0) / daysInMonth(previousMonthKey(key)) : null;
  return {
    spent, projected, projectedReady: ready, budget,
    remaining: projected === null ? null : budget - projected,
    dailyAverage, previousDaily, elapsed, totalDays,
  };
}

function accountStatus(methodId) {
  const checkpoint = userCheckpointFor(methodId, today());
  // On a ledger with nothing in it, "Not reconciled" reads as a fault rather
  // than as a step not taken yet.
  if (!checkpoint) return {
    label: state.entries.length ? 'Not reconciled' : 'Set a balance',
    hint: 'No end-of-day balance has been saved for this account. Reconcile it once and the app can tell your book balance from the real one.',
  };
  const ageDays = Math.max(0, Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${checkpoint.date}T00:00:00Z`)) / 86400000));
  const hint = 'Days since this account\u2019s balance was checked against the real one.';
  if (ageDays === 0) return { label: 'Reconciled today', hint };
  if (ageDays <= 7) return { label: `Reconciled ${ageDays}d ago`, hint };
  return { label: 'Reconcile soon', hint };
}

function monthComparison(key = monthKey(today())) {
  const current = entriesForMonth(key).filter(isBudgetSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const previousKey = previousMonthKey(key);
  const previous = entriesForMonth(previousKey).filter(isBudgetSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  // Month-to-date against a COMPLETE previous month is a comparison that can
  // only flatter: on the 6th, spending as usual read as "down 78%". The
  // previous month is prorated to the same number of elapsed days, and every
  // figure below is judged against that fair half.
  const elapsed = key === monthKey(today()) ? new Date().getDate() : daysInMonth(key);
  const proratedPrevious = previous > 0
    ? Math.round(previous * (elapsed / daysInMonth(previousKey)) * 100) / 100
    : 0;
  const difference = Math.round((current - proratedPrevious) * 100) / 100;
  const percent = proratedPrevious > 0 ? Math.round((difference / proratedPrevious) * 100) : null;
  return { current, previous, proratedPrevious, previousKey, difference, percent };
}

function computeRunway(balance, key = monthKey(today())) {
  // Callers already hold the running balance (screenDashboard computes it once
  // at the top), so accept it rather than re-running a full balance pass.
  const forecast = spendingForecast(key);
  const dailyAvg = forecast.dailyAverage;
  const daysLeft = Math.max(0, forecast.totalDays - forecast.elapsed);
  const projectedEnd = balance - dailyAvg * daysLeft;
  const daysToZero = balance > 0 && dailyAvg > 0 ? Math.floor(balance / dailyAvg) : null;
  return { balance, dailyAvg, projectedEnd, daysToZero };
}

function computeMilestones() {
  const budget = +state.settings.monthlyBudget || 0;
  let monthsUnderBudget = 0;
  if (budget > 0) {
    for (const key of new Set(state.entries.map(e => monthKey(e.date)))) {
      const spent = entriesForMonth(key).filter(isBudgetSpendingEntry).reduce((s, e) => s + e.amount, 0);
      if (spent > 0 && spent <= budget) monthsUnderBudget++;
    }
  }
  return { monthsUnderBudget, entryCount: state.entries.length };
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
async function deleteEntryOrTransfer(id) {
  const target = state.entries.find(e => e.id === id);
  if (!target) return false;
  const removed = deletionEntriesFor(id);
  // Reconciliation no longer hard-blocks deletion: it warns first, so a
  // mistaken checkpoint can always be worked around. Deleting inside a
  // reconciled period makes balances before the checkpoint drift from the
  // reconciled figure — the confirm exists so that consequence is a choice,
  // not a surprise. The delete itself stays fully undoable.
  const protection = removed.map(reconciliationProtectionFor).find(Boolean);
  if (protection) {
    const ok = await swalConfirm({
      title: 'Entry is inside a reconciled period',
      text: `${methodShort(protection.methodId)} is reconciled through ${friendlyDate(protection.point.date)}, and this ${removed.length > 1 ? 'transfer pair is part of' : 'entry is part of'} that checkpoint. Delete anyway? Balances before that date will drift from the reconciled figure. You can undo this.`,
      confirmButtonText: 'Delete anyway',
      danger: true,
    });
    if (!ok) return false;
  }
  const transferId = target.transferId;
  state.entries = transferId
    ? state.entries.filter(entry => entry.transferId !== transferId)
    : state.entries.filter(entry => entry.id !== id);
  // Tombstone the removed ids so the deletion also propagates to other
  // devices through the cloud merge.
  tombstoneIds(removed.map(e => e.id));
  persist();
  // Repaint immediately: persist() already cleared the balance caches, and
  // render() coalesces frames so the caller's own render becomes a no-op.
  render();
  // The displayed balance is pinned to the latest reconciliation: deleting an
  // entry inside a reconciled period rewrites the book history but leaves the
  // shown number exactly where the checkpoint put it. Say so, or the delete
  // looks like it did nothing.
  if (protection) toast(`${methodShort(protection.methodId)} stays at its reconciled balance until you reconcile again.`);
  return true;
}

async function removeDuplicateEntry(id) {
  const target = state.entries.find(e => e.id === id);
  if (!target) return;
  if (!(await swalConfirm({ title: 'Delete duplicate?', text: `Delete duplicate “${target.details}” for ${fmt(target.amount)}?`, confirmButtonText: 'Delete', danger: true }))) return;
  const removed = target.transferId
    ? state.entries.filter(e => e.transferId === target.transferId)
    : [target];
  const protection = removed.map(reconciliationProtectionFor).find(Boolean);
  if (protection) {
    const ok = await swalConfirm({
      title: 'Duplicate is inside a reconciled period',
      text: `${methodShort(protection.methodId)} is reconciled through ${friendlyDate(protection.point.date)}, and this duplicate is part of that checkpoint. Delete anyway? Balances before that date will drift from the reconciled figure.`,
      confirmButtonText: 'Delete anyway',
      danger: true,
    });
    if (!ok) return;
  }
  const removedIds = new Set(removed.map(e => e.id));
  state.entries = state.entries.filter(e => !removedIds.has(e.id));
  tombstoneIds([...removedIds]);
  persist();
  render();
  trackAction(() => { state.entries.push(...removed); state.entries.sort((a, b) => a.date.localeCompare(b.date)); untombstoneIds(removed.map(e => e.id)); persist(); }, `Deleted ${target.details}`, removed);
  toast(target.transferId ? 'Duplicate transfer pair deleted.' : 'Duplicate deleted.');
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
  // Same fair comparison as monthComparison(): a month that is still running
  // is measured against the same fraction of the month before it, so week one
  // stops reporting "you spent 78% less than last month".
  const elapsed = key === monthKey(today()) ? new Date().getDate() : daysInMonth(key);
  const partial = key === monthKey(today()) && elapsed < daysInMonth(key);
  const proratedPrevious = previousTotal > 0
    ? Math.round(previousTotal * (elapsed / daysInMonth(previousMonthKey(key))) * 100) / 100
    : 0;
  const percent = proratedPrevious ? Math.round(((total - proratedPrevious) / proratedPrevious) * 100) : null;
  const lines = [];
  if (top) lines.push(`Your biggest category was ${categoryLabel(top[0])} at ${fmt(top[1])}.`);
  if (percent !== null) {
    const cmp = partial ? 'last month to date' : 'last month';
    lines.push(percent === 0 ? `You spent the same as ${cmp}.` : `You spent ${Math.abs(percent)}% ${percent < 0 ? 'less' : 'more'} than ${cmp}.`);
  }
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
  if (uncategorized > financialEntries.length * 0.3) { score -= 15; issues.push(`${uncategorized} entries are "Misc" - try categorising them.`); }
  // Large amounts - judged against SPENDING, and never against income or a
  // scheduled bill: a €2,400 payday is not an anomaly in a ledger of coffees,
  // and until now every payday scored the account down 10 points.
  const recKeys = recurringKeySet();
  const outlierPool = financialEntries.filter(e => isSpendingEntry(e) && !isFixedCostEntry(e, recKeys));
  const avg = outlierPool.length ? outlierPool.reduce((s, e) => s + e.amount, 0) / outlierPool.length : 0;
  const outliers = outlierPool.length >= 3 && avg > 0 ? outlierPool.filter(e => e.amount > avg * 5).length : 0;
  if (outliers > 0) { score -= 10; issues.push(`${outliers} entr${outliers===1?'y':'ies'} ${outliers===1?'looks':'look'} unusually large.`); }
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

// ---------- router ----------
const ROUTES = TABS;
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < 640;
// The layout is decided at render — isNarrow() feeds inline sizes, and the
// History table only adopts its swipe rows in the stacked layout. A phone turned
// on its side crosses the 640px line without a navigation, so the crossing has
// to repaint; otherwise the wide table stays inside the kit's narrow wrapper,
// which clips the columns the card is meant to scroll to.
let narrowAtLastRender = isNarrow();
window.addEventListener('resize', () => {
  if (isNarrow() === narrowAtLastRender) return;
  narrowAtLastRender = isNarrow();
  render();
}, { passive: true });
const isTiny = () => typeof window !== 'undefined' && window.innerWidth < 480;
// Which tabs THIS profile may open. The admin (see openAdminPanel) sets it per
// user in that user's own document, so the setting travels with their data.
function enabledTabs() {
  const list = state?.settings?.enabledTabs;
  return Array.isArray(list) ? list : ROUTES;
}
function tabVisible(route) {
  // The dashboard is never hidden (storage forces it back in): it is where the
  // app lands and the only screen that reaches every other one.
  return route === 'dashboard' || enabledTabs().includes(route);
}
function currentRoute() {
  const r = (location.hash || '#dashboard').slice(1).split('?')[0];
  if (ROUTES.includes(r) && tabVisible(r)) return r;
  // A hidden tab is unreachable by URL too: a bookmark or a stale link must not
  // be a way around the admin's setting. Landing on the dashboard keeps the app
  // coherent instead of rendering a screen with no nav entry back to it.
  if (ROUTES.includes(r)) {
    try { history.replaceState(null, '', location.pathname + '#dashboard'); } catch { /* history unavailable */ }
  }
  return 'dashboard';
}
window.addEventListener('hashchange', renderRoute);

// ---------- DOM helpers ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'circle', 'path', 'line', 'rect', 'polyline', 'polygon', 'g', 'text', 'tspan', 'defs', 'use', 'marker', 'ellipse', 'linearGradient', 'stop']);
function $(tag, attrs = {}, ...children) {
  // SVG elements MUST be created in the SVG namespace via createElementNS;
  // document.createElement('circle') yields a plain HTML element that never
  // renders. This one-line distinction is why every chart draws correctly.
  const el = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  // Default `= {}` only applies to `undefined`. The codebase explicitly passes
  // `null` for "no attributes needed" in many places (e.g. `$('div', null, …)`);
  // without this fallback, Object.entries(null) throws and aborts the entire render.
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'data' && typeof v === 'object') Object.assign(el.dataset, v);
    // Only ever markup. `el.innerHTML = undefined` writes the STRING
    // "undefined" into the element, so an icon lookup that misses (e.g. a
    // route with no entry in the menu's icon map) used to render the literal
    // word next to the label instead of failing quietly. Markup is the only
    // thing this key is for; anything else is a miss and means "no content".
    else if (k === 'innerHTML') { if (typeof v === 'string') el.innerHTML = v; }
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function toggleDarkMode() {
  const html = document.documentElement;
  const wasDark = html.dataset.theme === 'dark';
  html.dataset.theme = wasDark ? '' : 'dark';
  try { localStorage.setItem('cents-theme', wasDark ? 'light' : 'dark'); } catch (e) {}
}

function renderHeader() {
  const route = currentRoute();
  const locked = hasPinLock() && !pinUnlocked;
  return $('header', { class: 'app-header', 'aria-label': 'App header' },
    $('div', { class: 'logo' },
      $('div', { class: 'mark' }, $('span', { class: 'mark-icon', 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 6.5A7 7 0 1 0 17 17.5"/><line x1="2.5" y1="8" x2="12" y2="8"/><line x1="2.5" y1="16" x2="12" y2="16"/></svg>' })),
      $('a', { href: '#dashboard', class: 'logo-wordmark', style: 'font-family:"Space Grotesk",sans-serif;font-size:30px;letter-spacing:-0.03em;' }, 'cents.'),
    ),
    $('nav', { class: 'nav', 'aria-label': 'Primary', style: locked ? 'display:none;' : '' },
      ...ROUTES.filter(tabVisible).map(r => $('a', { href: `#${r}`, class: 'nav-link', 'aria-current': r === route ? 'page' : null },
        $('span', { class: 'nav-link-icon', 'aria-hidden': 'true', innerHTML: MENU_ICONS[{ dashboard: 'home', add: 'plus', history: 'clock', balances: 'wallet', tesco: 'briefcase', insights: 'chart' }[r]] || MENU_ICONS.home }),
        titleFor(r))),
    ),
    $('div', { class: 'header-actions', style: locked ? 'display:none;' : '' },
      // Profile chip: quick "who am I" + tap to switch. Hidden with a single
      // profile to keep the header clean for solo users.
      listProfiles().length > 1 ? $('button', { type: 'button', class: 'profile-chip', title: 'Switch profile', 'aria-label': `Switch profile (current: ${activeProfile().name})`, onClick: () => showProfilePicker({ cancellable: true }) },
        profileAvatar(activeProfile(), 22),
        $('span', { class: 'profile-chip-name' }, activeProfile().name)) : null,
      $('span', { id: 'sync-indicator', style: 'display:inline-flex;align-items:center;gap:7px;font-family:"Space Grotesk",sans-serif;font-size:14px;color:var(--muted);' }),
      // The owner's way in to the people they share with. It sits in the header
      // rather than only in the menu, because it is the thing an owner reaches
      // for after signing in — and the menu row below stays for discoverability.
      isAdminProfile(getActiveProfileId()) && listProfiles().length > 1 ? $('button', {
        type: 'button', class: 'admin-trigger', title: 'Admin - people and tabs', 'aria-label': 'Admin - people and tabs',
        onClick: () => openAdminPanel(),
      },
        // ICONS, not MENU_ICONS: the person glyph is one of the extras ICONS
        // adds, and `$` skips a non-string `innerHTML` — so reading the smaller
        // map left this circle with no icon inside it at all.
        $('span', { 'aria-hidden': 'true', innerHTML: ICONS.user }),
        // Wide enough screens get the word, so the button doesn't read as a
        // second profile chip sitting next to the real one.
        $('span', { class: 'admin-trigger-label', 'aria-hidden': 'true' }, 'Admin')) : null,
      $('button', { class: 'dark-switch', type: 'button', role: 'switch', title: 'Dark mode', 'aria-label': 'Dark mode', 'aria-checked': document.documentElement.dataset.theme === 'dark' ? 'true' : 'false', 'data-squish-switch': '', 'data-ss-bare': '', 'data-ss-size': 'sm', onClick: (event) => {
         toggleDarkMode();
         const dark = document.documentElement.dataset.theme === 'dark';
         event.currentTarget.setAttribute('aria-checked', String(dark));
         event.currentTarget.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
       } }),
      $('button', { type: 'button', class: 'menu-trigger', title: 'Menu', 'aria-label': 'Open menu', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: toggleAppMenu },
        $('span', { class: 'menu-trigger-icon icon-burger', 'aria-hidden': 'true', innerHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>' }),
        $('span', { class: 'menu-trigger-icon icon-close', 'aria-hidden': 'true', innerHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' }),
      ),
    ),
  );
}

function titleFor(r) {
  return ({ dashboard: 'Dashboard', add: 'New entry', history: 'History', balances: 'Balances', tesco: 'Tesco Pay', insights: 'Insights' })[r];
}

// ---------- animated drill-down menu ----------
// Hamburger opens a springy, blur-backed panel (drawer on desktop, bottom
// sheet on mobile). Rows with chevrons drill into submenus; each level
// slides with a bounce while rows stagger in. Escape/back chevron pops back.
let appMenu = null;   // { backdrop, panel, track, stack }

const MENU_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8.5" x2="12" y2="15.5"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-6M22 20H2"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h12"/><path d="M20 7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7"/><rect x="16" y="11" width="4" height="5" rx="1"/></svg>',
  appearance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/><path d="M3 12.5h18"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.6" cy="10" r="1.7"/><path d="M3.5 17l5-4.6 4.2 3.8 3.1-2.4 4.7 4"/></svg>',
};

// Full stroke-icon set - Lucide-style 24px grid, currentColor, 1.9 stroke.
// Extends MENU_ICONS so menus, pills, buttons, toasts and headers share one
// visual language (replaces the scattered emoji glyphs).
const ICONS = {
  ...MENU_ICONS,
  // Plain plus for tiny buttons - the menu's circled plus reads as a record
  // button at 12px.
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  medal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  'arrow-up': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  'arrow-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  'chevron-left': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
  'chevron-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',
  'check-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z"/></svg>',
};

/** Return the SVG markup for a named icon ('' when unknown). */
function iconSVG(name) {
  return ICONS[name] || '';
}

/** A decorative icon span. Optional extra class(es) and inline style. */
function iconSpan(name, cls = '', style) {
  const s = $('span', { class: `icon${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
  if (style) s.setAttribute('style', style);
  s.innerHTML = iconSVG(name);
  return s;
}

function menuRowEl({ icon, label, note = null, cls = '', onClick = null, chevron = false, active = false, danger = false, check = false }) {
  return $('button', { type: 'button', class: 'menu-row' + (active ? ' active' : '') + (danger ? ' danger' : '') + (cls ? ' ' + cls : ''), onClick },
    // ICONS is the full set (`{ ...MENU_ICONS, …extras }`); looking a name up in
    // the smaller map silently swapped in the home glyph for the extras.
    $('span', { class: 'menu-row-icon', 'aria-hidden': 'true', innerHTML: ICONS[icon] || ICONS.home }),
    note ? $('span', { class: 'menu-row-main' }, $('span', { class: 'menu-row-label' }, label), $('span', { class: 'menu-row-note' }, note))
      : $('span', { class: 'menu-row-label' }, label),
    check ? $('span', { class: 'menu-row-check', 'aria-hidden': 'true', innerHTML: MENU_ICONS.check }) : null,
    chevron ? $('span', { class: 'menu-row-chevron', 'aria-hidden': 'true', innerHTML: MENU_ICONS.chevron }) : null,
  );
}

// A static info row (status display, not clickable).
function menuInfoRow(label, value) {
  return $('div', { class: 'menu-info' },
    $('span', { class: 'muted', style: 'font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;' }, label),
    $('span', { class: 'display-num', style: 'font-size:12px;' }, value),
  );
}

function buildMenuLevel(id) {
  const level = $('div', { class: 'menu-level', 'data-level': id });
  const title = { root: 'Menu', appearance: 'Appearance', privacy: 'Privacy & security', sync: 'Cloud sync', data: 'Data' }[id] || 'Menu';
  const head = $('div', { class: 'menu-head' });
  if (id !== 'root') {
    head.append($('button', { type: 'button', class: 'menu-back', 'aria-label': 'Back', onClick: menuBack, innerHTML: MENU_ICONS.back }));
  }
  head.append($('span', { class: 'menu-head-title serif' }, title));
  if (id === 'root') {
    head.append($('button', { type: 'button', class: 'menu-close', 'aria-label': 'Close menu', onClick: closeAppMenu, innerHTML: MENU_ICONS.close }));
  } else {
    head.append($('span', { class: 'menu-head-spacer' }));
  }
  level.append(head);

  const list = $('div', { class: 'menu-list' });
  if (id === 'root') {
    const route = currentRoute();
    // The owner's way in to the people they share with sits at the very top of
    // the sidebar: it is the one thing an owner reaches for after signing in,
    // and as a row further down the list it was easy to miss.
    const owner = isAdminProfile(getActiveProfileId());
    if (owner) {
      list.append(menuRowEl({ icon: 'user', cls: 'admin-row', label: 'Admin', note: 'People & tab access', chevron: true, onClick: () => { closeAppMenu(); openAdminPanel(); } }));
      list.append($('div', { class: 'menu-sep' }));
    }
    ROUTES.filter(tabVisible).forEach(r => list.append($('a', { href: `#${r}`, class: 'menu-row' + (r === route ? ' active' : ''), 'aria-current': r === route ? 'page' : null, onClick: closeAppMenu },
      $('span', { class: 'menu-row-icon', 'aria-hidden': 'true', innerHTML: MENU_ICONS[{ dashboard: 'home', add: 'plus', history: 'clock', balances: 'wallet', tesco: 'briefcase', insights: 'chart' }[r]] || MENU_ICONS.home }),
      $('span', { class: 'menu-row-label' }, titleFor(r)),
    )));
    list.append($('div', { class: 'menu-sep' }));
    list.append(menuRowEl({ icon: 'clock', label: 'Recurring & bills', onClick: () => { closeAppMenu(); openRecurringManager(); } }));
    // Beside "Recurring & bills" because it is the same kind of thing: a list the
    // user owns and keeps, rather than a setting.
    list.append(menuRowEl({ icon: 'wallet', label: 'Payment methods', note: 'Add or remove how you pay', onClick: () => { closeAppMenu(); openMethodManager(); } }));
    if (canInstallApp()) {
      list.append(menuRowEl({ icon: 'download', label: 'Install app', onClick: () => { closeAppMenu(); promptInstall(); } }));
    }
    // For everyone else the picker is only a way to switch accounts.
    if (!owner) {
      list.append(menuRowEl({ icon: 'user', label: 'Switch profile', chevron: true, onClick: () => { closeAppMenu(); showProfilePicker({ cancellable: true }); } }));
    }
    // Your own picture, wherever you are — the lock-screen picker is the only
    // other way in, and it is behind the lock.
    list.append(menuRowEl({ icon: 'photo', label: 'Profile picture', onClick: () => { closeAppMenu(); openAvatarPicker(activeProfile()); } }));
    list.append(menuRowEl({ icon: 'appearance', label: 'Appearance', chevron: true, onClick: () => menuDrill('appearance') }));
    list.append(menuRowEl({ icon: 'lock', label: 'Privacy & security', chevron: true, onClick: () => menuDrill('privacy') }));
    list.append(menuRowEl({ icon: 'cloud', label: 'Cloud sync', chevron: true, onClick: () => menuDrill('sync') }));
    list.append(menuRowEl({ icon: 'data', label: 'Data', chevron: true, onClick: () => menuDrill('data') }));
  } else if (id === 'appearance') {
    const dark = document.documentElement.dataset.theme === 'dark';
    const setTheme = (wantDark) => {
      if (dark !== wantDark) { toggleDarkMode(); }
      menuRefreshLevel('appearance');
    };
    list.append(menuRowEl({ icon: 'appearance', label: 'Dark', active: dark, check: dark, onClick: () => setTheme(true) }));
    list.append(menuRowEl({ icon: 'appearance', label: 'Light', active: !dark, check: !dark, onClick: () => setTheme(false) }));
  } else if (id === 'privacy') {
    list.append(menuInfoRow('Privacy lock', hasPinLock() ? 'On' : 'Off'));
    list.append(menuRowEl({ icon: 'lock', label: hasPinLock() ? 'Change PIN' : 'Set PIN', onClick: () => { closeAppMenu(); openPinSettings(); } }));
    // Nothing to lock with when no PIN is set: the row would be a button that
    // changes nothing, and the state it names would be a lie.
    if (hasPinLock()) list.append(menuRowEl({ icon: 'lock', label: 'Lock app now', onClick: () => { closeAppMenu(); lockApp(); } }));
  } else if (id === 'sync') {
    const s = getSyncSettings();
    const st = syncStatus();
    list.append(menuInfoRow('Status', s.enabled ? st.label : 'Off'));
    list.append(menuRowEl({ icon: 'cloud', label: 'Sync settings', onClick: () => { closeAppMenu(); openSyncSettings(); } }));
    if (s.enabled && s.endpoint && s.password) {
      list.append(menuRowEl({ icon: 'cloud', label: 'Sync now', onClick: () => { scheduleSyncPush(1500, true); toast('Syncing…'); menuRefreshLevel('sync'); } }));
    }
  } else if (id === 'data') {
    list.append(menuInfoRow('Entries', String(state.entries.length)));
    // Filled in when the async storage probe answers; if the menu was closed
    // (or rebuilt) in the meantime the node is gone and this is skipped.
    const storageRow = menuInfoRow('On this device', '\u2026');
    list.append(storageRow);
    void storageFootprint().then(text => {
      if (storageRow.isConnected) storageRow.lastElementChild.textContent = text;
    });
    // Sits with the storage lines because it answers the same question — where
    // the data is — and because this is the one screen a person opens when they
    // are wondering exactly that. The line re-checks on open (see
    // refreshMirrorRow), so it cannot be a verdict from days ago.
    const mirror = mirrorRowEl();
    list.append(mirror.row);
    void refreshMirrorRow(mirror);
    list.append(menuRowEl({ icon: 'data', label: 'Export data', onClick: () => { closeAppMenu(); exportJSON(state); toast('Exported.'); } }));
    // The same ledger as a spreadsheet. The labels are resolved by this file's
    // own categoryLabel/methodLabel, so the file a user opens names a category
    // the way the screen does — including their custom ones.
    list.append(menuRowEl({ icon: 'download', label: 'Export CSV', note: 'One row per entry, for a spreadsheet', onClick: () => {
      closeAppMenu();
      exportEntriesCsv(state, { category: categoryLabel, method: methodLabel });
      toast('Exported CSV.');
    } }));
    // The export's counterpart. Same merge-and-Undo promise as Restore from
    // backup: parseEntriesCsv() reads the file back (labels resolved to ids by
    // csvCategoryId/csvMethodId, rows already in the ledger skipped) and
    // applyRestore() does the merge as one undoable step.
    list.append(menuRowEl({ icon: 'download', label: 'Import CSV', note: 'Merges a .csv export back in', onClick: () => { closeAppMenu(); openCsvPicker(); } }));
    // A bank's own export, which shares nothing with the format above: the
    // mapper is one screen that makes a file SHAPE readable, and it lives in
    // its own module so a boot never parses it (the menu is the only door).
    list.append(menuRowEl({ icon: 'download', label: 'Import bank statement', note: 'Date, description and amount — mapped once', onClick: () => { closeAppMenu(); openBankImport(); } }));
    list.append(menuRowEl({ icon: 'download', label: 'Restore from backup', note: 'Merges a .json export back in', onClick: () => { closeAppMenu(); openRestorePicker(); } }));
    // Only offered when there IS one: a document loadState could not parse is
    // parked under a quarantine key, and until now nothing could reach it.
    if (unreadableBackup()) {
      list.append(menuRowEl({ icon: 'alert', label: 'Recover unreadable copy', note: 'Kept from a document that would not open', onClick: () => { closeAppMenu(); void recoverQuarantine(); } }));
    }
    // Offered only while such lines exist: the recorder's first run could catch
    // up every recorded pay date at once, and the balance a user had been
    // keeping by hand should be theirs to take back in one step.
    const writtenByApp = appWrittenTescoLines();
    if (writtenByApp.length) {
      list.append(menuRowEl({ icon: 'alert', label: 'Remove automatic Tesco pay lines', note: `${writtenByApp.length} written by the recorder, not by you`, onClick: () => { closeAppMenu(); removeAppWrittenTescoLines(); } }));
    }
    list.append(menuRowEl({ icon: 'data', label: 'Reset all data', danger: true, onClick: async () => {
      closeAppMenu();
      // A slide, not a button: this is the one action in the app that erases
      // everything, and a gesture that can only finish deliberately is a
      // stronger guard than a Confirm that sits under the thumb.
      if (!(await SlideCommit.ask({
        title: 'Reset all data?',
        text: 'This clears every entry, balance checkpoint, and setting on this device. Continue?',
        label: 'Slide to reset',
        busy: 'Resetting\u2026',
        done: 'Reset',
        doneText: 'Every entry cleared.',
      }))) return;
      // One destructive action, one undo step — and the journal carries the
      // whole ledger, because unlike an entry deletion there is no per-item
      // shape to serialise. Written BEFORE the reset (the tombstone it writes
      // is the first thing a crash could land on) and superseded only by the
      // undo itself.
      const before = JSON.parse(JSON.stringify(state));
      const journalEntries = state.entries.map(e => ({ ...e }));
      const journalCheckpoints = Object.entries(state.settings.balanceCheckpoints || {})
        .flatMap(([methodId, points]) => (Array.isArray(points) ? points : [])
          .map(point => ({ methodId, point: { ...point } })));
      syncRevision++;
      state = resetToBlank();
      clearBalanceCaches();
      scheduleSyncPush();
      trackAction(() => { state = validateState(before); persist(); clearBalanceCaches(); render(); }, 'reset all data', journalEntries, journalCheckpoints);
      render();
      toast(journalEntries.length || journalCheckpoints.length
        ? `All data cleared \u2014 ${journalEntries.length} entr${journalEntries.length === 1 ? 'y' : 'ies'} can be brought back with Undo.`
        : 'All data cleared.');
    } }));
  }
  level.append(list);
  return level;
}

function openAppMenu() {
  if (appMenu || (hasPinLock() && !pinUnlocked)) return;
  const trigger = document.querySelector('.menu-trigger');
  const backdrop = $('div', { class: 'menu-backdrop', onClick: ev => { if (ev.target === backdrop) closeAppMenu(); } });
  const panel = $('div', { class: 'menu-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu' });
  const track = $('div', { class: 'menu-track' });
  panel.append(track);
  backdrop.append(panel);
  document.body.appendChild(backdrop);
  appMenu = { backdrop, panel, track, stack: [] };
  document.documentElement.classList.add('menu-open');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  menuDrill('root');
  document.addEventListener('keydown', onMenuKey, true);
  queueMicrotask(() => { const target = panel.querySelector('.menu-row.active') || panel.querySelector('.menu-row, .menu-back'); if (target) target.focus({ preventScroll: true }); });
}

function closeAppMenu() {
  if (!appMenu) return;
  const { backdrop, panel } = appMenu;
  appMenu = null;
  document.removeEventListener('keydown', onMenuKey, true);
  document.documentElement.classList.remove('menu-open');
  const trigger = document.querySelector('.menu-trigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  backdrop.classList.add('closing');
  panel.classList.add('closing');
  // 160ms: the closing animations are 0.11s (menuPanelOut / menuSheetOut) and
  // this has to outlast them — removing the panel mid-animation is what would
  // make the menu vanish instead of leave — but not by much, since the window is
  // also how long a stale backdrop can sit in the DOM if the user reopens fast.
  setTimeout(() => backdrop.remove(), 160);
  if (trigger) queueMicrotask(() => trigger.focus({ preventScroll: true }));
}

function toggleAppMenu() {
  if (appMenu) closeAppMenu();
  else openAppMenu();
}

// Any route change (nav rows, bottom tab bar, logo click) dismisses the menu.
window.addEventListener('hashchange', () => closeAppMenu());

function onMenuKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (appMenu && appMenu.stack.length > 1) menuBack();
    else closeAppMenu();
  } else if (ev.key === 'Backspace' && appMenu && appMenu.stack.length > 1) {
    ev.preventDefault();
    menuBack();
  } else if (ev.key === 'Tab' && appMenu) {
    // Trap focus inside the dialog, mirroring the existing modal pattern.
    const focusables = Array.from(appMenu.panel.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }
}

function menuDrill(id) {
  if (!appMenu) return;
  const { track, stack } = appMenu;
  const old = track.querySelector('.menu-level');
  const level = buildMenuLevel(id);
  if (old) {
    old.classList.add('out-left');
    level.classList.add('in-right');
  }
  track.append(level);
  if (stack[stack.length - 1] !== id) stack.push(id);
  // No class to apply here any more. This used to arm the per-row entrance
  // synchronously (so the stagger never showed a blank frame); the rows now
  // arrive with the level, and the level's own slide is the only motion left.
  if (old) setTimeout(() => { if (old.parentNode === track) old.remove(); }, 160);
}

function menuBack() {
  if (!appMenu || appMenu.stack.length <= 1) return;
  appMenu.stack.pop();
  const prevId = appMenu.stack[appMenu.stack.length - 1];
  const { track } = appMenu;
  const current = track.querySelector('.menu-level:last-child');
  if (!current) return;
  const prev = buildMenuLevel(prevId);
  current.classList.add('out-right');
  track.insertBefore(prev, current);
  prev.classList.add('in-left');
  requestAnimationFrame(() => {
    // Keep keyboard/screen-reader users anchored after the level swap.
    const target = prev.querySelector('.menu-back') || prev.querySelector('.menu-row');
    if (target) target.focus({ preventScroll: true });
  });
  setTimeout(() => current.remove(), 160);
}

function menuRefreshLevel(id) {
  if (!appMenu) return;
  const { track, stack } = appMenu;
  const levels = Array.from(track.querySelectorAll('.menu-level'));
  const current = levels[levels.length - 1];
  if (!current || current.dataset.level !== id) return;
  const fresh = buildMenuLevel(id);
  fresh.classList.add('in-right');
  track.replaceChild(fresh, current);
  if (stack[stack.length - 1] !== id) stack.push(id);
}


// ---------- shared form ----------
function formView({ initial = null, onSubmit, onCancel }) {
  const isEdit = !!initial;
  const data = initial ? { ...initial } : {
    type: 'expense', date: today(), details: '', amount: '',
    method: 'AIB', category: 'gro', note: '',
  };
  if (typeof data.amount === 'number') data.amount = String(data.amount);

  // Type tabs - use role-based selectors, not firstChild/lastChild
  const tabs = $('div', { class: 'row', role: 'tablist', 'aria-label': 'Transaction type', style: `gap:${isNarrow() ? '10px' : '24px'};padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:32px;flex-wrap:wrap;` });
  const expenseTab = pillTab('Expense', 'expense', data.type === 'expense');
  const creditTab  = pillTab('Income', 'credit', data.type === 'credit');
  const transferTab = pillTab('Transfer', 'transfer', data.type === 'transfer');
  const noteTab = pillTab('Note', 'note', data.type === 'note');
  tabs.append(expenseTab, creditTab, transferTab, noteTab);
  function pillTab(label, type, active) {
    const btn = $('button', { type: 'button', class: 'pill', role: 'tab', 'data-id': label.toLowerCase(), 'aria-selected': active ? 'true' : 'false',          style: `height:28px;padding:0 12px;font-size:13px;line-height:16px;font-weight:500;border-radius:6px;cursor:pointer;background:${active ? 'var(--accent-soft)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--muted)'};border-color:${active ? 'transparent' : 'var(--line)'};`, onClick: () => {
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
      syncSplit();
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

  const detailsInput = $('input', { type: 'text', value: data.details || '', 'aria-label': 'Transaction details', placeholder: 'e.g. Tesco, Leap Card', autocomplete: 'off', required: true, onInput: (e) => data.details = e.target.value });

  const dateInput = $('input', { type: 'date', value: data.date, 'aria-label': 'Date', required: true, onInput: (e) => data.date = e.target.value });
  wireFlatpickr(dateInput, { defaultDate: data.date, onChange: (dateStr) => { data.date = dateStr; } });

  const creditMethods = METHODS.filter(m => m.id === 'AIB' || m.id === 'Revolut' || m.id === 'RS');
  const isCredit = () => data.type === 'credit';
  const isTransfer = () => data.type === 'transfer';
  // Ensure transfer defaults exist
  if (isTransfer()) { data.transferFrom = data.transferFrom || 'AIB'; data.transferTo = data.transferTo || 'Revolut'; }

  // Named methodLabelEl so it doesn't shadow the global methodLabel(id) helper.
  const methodLabelEl = $('label', { class: 'eyebrow', for: 'f-method' }, 'Method');
  const methodOpts = () => (isCredit() ? creditMethods : allMethods());
  const methodSel = $('select', { 'aria-label': 'Payment method', id: 'f-method', 'data-glide': true, 'data-glide-menu-width': '220', onChange: (e) => data.method = e.target.value });
  const methodSection = $('div');
  function rebuildMethodOpts() {
    methodLabelEl.textContent = isCredit() ? 'Income sent to' : 'Method';
    // The line below is a silent reassignment, and that is correct for a NEW
    // entry (option 1 is what an unfilled form should say) but destructive for
    // one being edited: the reset would move the money to an account the user
    // never chose the moment they pressed Save. So an existing entry keeps its
    // own method in the list, even when it was removed from the pickers since,
    // or is not one of the credit accounts.
    const ids = initial ? methodPickerIds(data.method, methodOpts()) : methodOpts().map(m => m.id);
    appendMethodOptions(methodSel, ids, data.method);
    if (!ids.includes(data.method)) { data.method = ids[0]; }
  }
  rebuildMethodOpts();

  // Split-payment creation: pay one total across several methods. When active,
  // the single Method select is replaced by a list of (method, amount) rows.
  let splitOn = false;
  const splitRows = [];
  const SLICE_METHODS = allMethods().map(m => m.id);
  const splitToggle = $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;margin-top:8px;min-height:24px;', onClick: () => {
    splitOn = !splitOn;
    if (splitOn && splitRows.length === 0) {
      splitRows.push({ method: data.method || 'AIB', amount: String(data.amount || '') });
      splitRows.push({ method: (data.method === 'Cash' || data.method === 'AIB') ? 'Revolut' : 'Cash', amount: '' });
      redrawSplit();
    }
    syncSplit();
    if (splitOn) splitWrap.querySelector('input')?.focus();
  } }, 'Split across methods');
  const splitWrap = $('div', { style: 'display:none;margin-top:8px;' });
  function redrawSplit() {
    splitWrap.innerHTML = '';
    splitRows.forEach((r, i) => {
      // Numbered per row: every slice used to share one aria-label, which is an
      // addressed identity here, not a caption (see the convention in CLAUDE.md).
      const sel = $('select', { 'aria-label': `Split method ${i + 1}`, 'data-glide': true, 'data-glide-size': 'sm', 'data-glide-menu-width': '170' });
      appendMethodOptions(sel, SLICE_METHODS, r.method);
      sel.value = r.method;
      sel.onchange = () => { r.method = sel.value; };
      const amt = $('input', { type: 'text', inputmode: 'decimal', value: r.amount, 'aria-label': `Slice amount ${i + 1}`, placeholder: 'slice €', autocomplete: 'off', style: 'width:106px;text-align:right;' });
      amt.oninput = () => { r.amount = amt.value; };
      const rm = $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;', 'aria-label': `Remove slice ${i + 1}`, onClick: () => { if (splitRows.length > 1) { splitRows.splice(i, 1); redrawSplit(); } } }, '×');
      splitWrap.appendChild($('div', { class: 'split-leg', style: 'display:flex;align-items:center;gap:6px;margin-bottom:8px;' }, sel, amt, splitRows.length > 1 ? rm : $('span', {})));
    });
    const add = $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;', onClick: () => { splitRows.push({ method: 'Cash', amount: '' }); redrawSplit(); } }, '+ Add slice');
    splitWrap.appendChild($('div', { style: 'text-align:right;' }, add));
  }
  function syncSplit() {
    const noteMode = data.type === 'note';
    const transferMode = data.type === 'transfer';
    if (noteMode || transferMode) splitOn = false;
    const active = splitOn && !noteMode && !transferMode;
    splitWrap.style.display = active ? 'block' : 'none';
    methodSel.style.display = splitOn ? 'none' : '';
    splitToggle.style.display = (noteMode || transferMode) ? 'none' : '';
    splitToggle.textContent = splitOn && splitRows.length >= 2 ? 'Use a single method' : 'Split across methods';
  }
  methodSection.append(methodLabelEl, methodSel, splitToggle, splitWrap);

  // Transfer From / To dropdowns
  const transferFromSel = $('select', { 'aria-label': 'From account', 'data-glide': true, 'data-glide-menu-width': '220', onChange: (e) => data.transferFrom = e.target.value });
  const transferToSel = $('select', { 'aria-label': 'To account', 'data-glide': true, 'data-glide-menu-width': '220', onChange: (e) => data.transferTo = e.target.value });
  function rebuildTransferOpts() {
    const fromIds = methodPickerIds(data.transferFrom);
    const toIds = methodPickerIds(data.transferTo);
    appendMethodOptions(transferFromSel, fromIds, data.transferFrom);
    appendMethodOptions(transferToSel, toIds, data.transferTo);
    if (!fromIds.includes(data.transferFrom)) data.transferFrom = fromIds[0];
    if (!toIds.includes(data.transferTo)) data.transferTo = toIds[0];
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
    const customIds = new Set((state.settings.customCategories || []).map(c => c.id));
    for (const c of all) {
      const btn = $('button', { type: 'button', class: 'pill pill-cat', role: 'radio', 'data-id': c.id, 'data-custom': customIds.has(c.id) ? true : null, 'aria-checked': data.category === c.id ? 'true' : 'false', 'data-active': data.category === c.id ? 'true' : 'false', onClick: () => {
        if (performance.now() - _chipSortLast < 400) return; // ignore the click that ends a drag
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
      const input = $('input', { type: 'text', placeholder: 'Category name', 'aria-label': 'New category name', autocomplete: 'off', style: 'border:1px solid var(--accent);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:4px 10px;font-size:12px;width:130px;', onKeydown: (ev) => {
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
    wireChipSortable(catChips);
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
    const overPrecise = overPreciseAmount(data.amount);
    if (overPrecise) { toast(`${overPrecise} has more decimals than euros have cents - round it to two places first.`); amountInput.focus(); return; }
    const amt = parseAmount(data.amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); amountInput.focus(); return; }
    if (amt > 100000) { toast('Amount looks too large - double check.'); amountInput.focus(); return; }
    if (!isValidCheckpointDate(data.date)) { toast('Pick a valid date.'); dateInput.focus(); return; }
    if (!data.details.trim()) { toast('Add a description.'); detailsInput.focus(); return; }
    if (isTransfer()) {
      if (isEdit) { toast('Transfers cannot be edited here. Delete and recreate the pair.'); return; }
      if (data.transferFrom === data.transferTo) { toast('From and To cannot be the same account.'); return; }
      const pairId = uid();
      const base = { createdAt: nowIso(), date: data.date, amount: amt, details: data.details.trim(), note: data.note?.trim() || '', category: 'misc', transferId: pairId };
      const fromEntry = { ...base, id: uid(), type: 'expense', method: data.transferFrom };
      const toEntry   = { ...base, id: uid(), type: 'credit',  method: data.transferTo };
      if (data.transferFrom === 'Cash' || data.transferTo === 'Cash') cashAutoFollow();
      onSubmit([fromEntry, toEntry]);
      return;
    }
    if (splitOn && splitRows.length >= 2) {
      const slices = splitRows.map(r => ({ method: r.method, amount: parseAmount(r.amount) }));
      // A slice is entered by hand like any other amount, so it is held to the
      // same cent rule instead of arriving pre-rounded.
      const overPreciseSlice = splitRows.map(r => overPreciseAmount(r.amount)).find(Boolean);
      if (overPreciseSlice) { toast(`${overPreciseSlice} has more decimals than euros have cents - round it to two places first.`); return; }
      if (slices.some(s => !Number.isFinite(s.amount) || s.amount <= 0)) { toast('Enter a positive slice amount for every split line.'); return; }
      const sum = Math.round(slices.reduce((a, s) => a + s.amount, 0) * 100) / 100;
      if (Math.abs(sum - amt) > 0.001) { toast(`Slices total ${fmt(sum)} but the entry amount is ${fmt(amt)} - make them match.`); return; }
      const splitId = uid();
      const createdAt = nowIso();
      const category = data.type === 'credit' ? 'misc' : data.category;
      const legs = slices.map(s => ({
        id: uid(), createdAt, date: data.date, type: data.type, category,
        details: data.details.trim(), amount: s.amount, method: s.method,
        note: data.note?.trim() || '', splitId,
      }));
      if (legs.some(l => l.method === 'Cash')) cashAutoFollow();
      onSubmit(legs);
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
      // The flag lives ON the entry, and this object is rebuilt from the
      // fields rather than spread from `initial` — so before the row's own
      // toggle moved here, saving an excluded entry silently put it back in
      // the budget.
      ...(data.budgetExcluded ? { budgetExcluded: true } : {}),
    };
    // No duplicate gate here: commitAdded() is the ONE check on this screen,
    // and a second one below the first would ask the same question twice —
    // confirm once at submit and the committed path confirms again for the
    // same row. The edit sheet never reaches commitAdded as an addition, so
    // its "already have this" check stays where it is (in commitAdded).
    onSubmit([entry]);
  };

  let detailsLabel;
  let noteFieldSection;
  // "Exclude from budget" is a property of a stored entry, so it belongs to
  // the surface that owns that entry: the edit sheet. On the row it was a
  // second control competing with the row's own labels (106px of button in a
  // grid whose middle track is the one that gives), and it lived nowhere else.
  const budgetRow = isEdit && data.type !== 'note'
    ? $('label', { style: 'display:flex;align-items:center;gap:9px;font-size:13px;margin-bottom:18px;cursor:pointer;color:var(--muted);' },
        $('input', { type: 'checkbox', checked: !!data.budgetExcluded, onChange: (ev) => { data.budgetExcluded = ev.target.checked; } }),
        $('span', null, 'Exclude from budget calculations'),
      )
    : null;
  const formEl = $('div', { class: 'card', style: `padding:${isNarrow() ? '20px 16px' : '32px 16px'};max-width:540px;margin:0 auto;` },
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
    budgetRow,
    $('div', { style: 'display:flex;gap:12px;justify-content:flex-end;padding-top:24px;border-top:1px solid var(--line);' },
      $('button', { type: 'button', class: 'btn btn-ghost', onClick: onCancel || (() => location.hash = '#dashboard') }, 'Cancel'),
      $('button', { type: 'button', class: 'btn btn-primary', onClick: (ev) => {
        const icon = ev.currentTarget.querySelector('.btn-save-icon');
        if (icon) { icon.classList.add('saved'); setTimeout(() => { if (icon) icon.classList.remove('saved'); }, 800); }
        submit();
      } },
        $('span', { class: 'btn-save-icon', style: 'margin-right:6px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="icon-save-line" d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke-dasharray="60" stroke-dashoffset="0"/><polyline class="icon-save-line" points="17 21 17 13 7 13 7 21" stroke-dasharray="20" stroke-dashoffset="0"/><polyline class="icon-save-line" points="7 3 7 8 15 8" stroke-dasharray="15" stroke-dashoffset="0"/><polyline class="icon-check" points="20 6 9 17 4 12"/></svg>' }),
        isEdit ? 'Save changes' : 'Save entry',
      ),
    ),
  );

  // First focusable input id for focus management
  formEl.dataset.firstFocus = data.type === 'note' ? 'f-details' : 'f-amount';
  return formEl;
}

// ---------- dashboard ----------
/** Pull from cloud and re-render - used by both the dashboard resync button and manual sync. */
async function doResync() {
  const s = getSyncSettings();
  if (!s.enabled || !s.endpoint || !s.password) { toast('Sync is not configured.'); return; }
  if (syncInFlight || syncExclusive) { toast('A sync is already in progress.'); return; }
  syncExclusive = true;
  try {
    const r = await syncPull();
    if (!r.ok) {
      toast('Pull failed: ' + (r.message || r.reason));
      patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
      notifySyncChange();
      return;
    }
    if (!r.content) {
      if (hasLocalDataToProtect()) { toast('Cloud file is empty - local data was kept and will be pushed.'); scheduleSyncPush(1500, true); }
      else toast('Cloud file is empty - nothing to pull.');
      return;
    }
    await applyReconcile(r, {});
  } finally {
    syncExclusive = false;
  }
}

/**
 * Which of this month's pay Thursdays the Tesco tracker card may claim, and
 * what is recorded against each — the gate that keeps a €2,400 salary on the
 * 1st from being read as "1/5 paid" (and from being copied into the other
 * Thursdays by Auto-fill). See the card for why each rule exists.
 *
 * Returns `{ shown, byDate }`: `shown` is whether the card has anything to
 * track at all, `byDate` the income it recognises as Tesco pay.
 */
function tescoThursdayIncome(thursdays, payDateAmounts) {
  const recordedIds = new Set(Object.values(payDateAmounts || {}).map(m => m && m.id).filter(Boolean));
  const hasTescoShifts = !!((state.tesco && state.tesco.shifts) || []).length;
  const namesTesco = (e) => /tesco/i.test(String(e.details || '')) || /tesco/i.test(String(e.note || ''));
  const shown = hasTescoShifts || Object.keys(payDateAmounts || {}).length > 0
    || state.entries.some(e => isIncomeEntry(e) && namesTesco(e));
  const isTescoPay = (e) => recordedIds.has(e.id) || namesTesco(e)
    || (hasTescoShifts && thursdays.includes(e.date));
  const byDate = {};
  if (shown) {
    // Look across ALL entries (not just this month) so a Thursday matches
    // regardless of when it was entered.
    for (const e of state.entries) {
      if (!isIncomeEntry(e) || !isTescoPay(e)) continue;
      byDate[e.date] = (byDate[e.date] || 0) + e.amount;
    }
  }
  return { shown, byDate };
}

/* ── Month in numbers ──
   The four figures this screen has nowhere else to put. The pulse reads the
   MONTH — average, projection, burn — so a heavy week is invisible inside it,
   and the three questions a home screen actually gets asked (biggest buy, what
   did I keep, did I spend nothing today) were answered nowhere at all.
   Every value arrives already formatted: a raw float at 22px is how a figure
   outgrows its own cell. */
function monthNumbersCard(key, now) {
  const monthRows = entriesForMonth(key);
  const spends = monthRows.filter(isSpendingEntry);
  const income = monthRows.filter(isIncomeEntry).reduce((sum, e) => sum + e.amount, 0);
  const spent = spends.reduce((sum, e) => sum + e.amount, 0);

  // The last seven days against the seven before them — a month's average
  // cannot show this, and it is the pace the budget bar is really reacting to.
  const day = today();
  const sumBetween = (from, to) => state.entries
    .filter(e => isSpendingEntry(e) && e.date >= from && e.date <= to)
    .reduce((sum, e) => sum + e.amount, 0);
  const weekNow = sumBetween(offsetDateKey(day, -6), day);
  const weekBefore = sumBetween(offsetDateKey(day, -13), offsetDateKey(day, -7));
  const delta = weekBefore > 0 ? Math.round(((weekNow - weekBefore) / weekBefore) * 100) : null;
  // Spending up is the bad direction, so it takes the bad colour — the same
  // rule the pulse uses for its own figures.
  const paceColor = delta === null || delta === 0 ? ''
    : delta > 0 ? 'var(--negative)' : 'var(--positive)';
  const paceText = weekNow === 0 && weekBefore === 0 ? 'nothing spent in either week'
    : weekBefore === 0 ? 'nothing in the seven days before'
    : delta === 0 ? 'level with the week before'
    : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs the week before`;

  const biggest = spends.length
    ? spends.reduce((a, b) => (b.amount > a.amount ? b : a))
    : null;

  const rate = income > 0 ? Math.round(((income - spent) / income) * 100) : null;
  const elapsed = Math.max(1, now.getDate());
  const daysSpent = new Set(spends.filter(e => e.date <= day).map(e => e.date)).size;
  const noSpendDays = Math.max(0, elapsed - daysSpent);

  const cell = (label, value, sub, color, hint) => $('div', { style: 'min-width:0;' },
    stat(label, value, color, hint),
    sub ? $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;line-height:1.35;overflow-wrap:anywhere;' }, sub) : null,
  );

  return $('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Month in numbers'),
      // The one link this card carries goes where the rest of the numbers live,
      // and stays out of the way on a profile whose admin hid the Insights tab.
      tabVisible('insights')
        ? $('a', { href: '#insights', class: 'muted', style: 'font-size:11px;text-decoration:none;' }, 'Full picture in Insights →')
        : null,
    ),
    // auto-fit, not a fixed count: the card is a half-width column when the row
    // it lands in has a partner and a full-width strip when it closes one, and
    // the cells have to fill whichever it is (132px is the narrowest track a
    // phone's 2-up still fits inside).
    $('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:16px 18px;' },
      cell('This week', fmt(weekNow), paceText, paceColor || null,
        'Everything spent in the last seven days, today included.'),
      cell('Biggest buy', biggest ? fmt(biggest.amount) : '\u00b7',
        biggest ? `${biggest.details || categoryLabel(biggest.category)} · ${friendlyDate(biggest.date)}`
          : spends.length ? '' : 'nothing spent yet',
        biggest ? 'var(--negative)' : null,
        'The largest single expense this month.'),
      cell('Savings rate', rate === null ? '\u00b7' : `${rate}%`,
        income > 0 ? `${fmt(spent)} of ${fmt(income)} in` : 'no income recorded this month',
        rate === null ? null : rate >= 0 ? 'var(--positive)' : 'var(--negative)',
        'Share of this month\u2019s income that was not spent.'),
      cell('No-spend days', monthRows.length ? `${noSpendDays} of ${elapsed}` : '\u00b7',
        monthRows.length ? 'days this month with nothing spent' : 'nothing logged yet',
        null,
        'Days this month on which nothing at all was spent.'),
    ),
  );
}

/**
 * Above 1080px the dashboard is a two-column grid and DOM order IS reading
 * order, so a run of column cards with an ODD count ends with one card alone
 * and a whole column beside it — measured at 1440px, 462px of empty page next
 * to the Upcoming card, and again beside Bank account balances on a fresh
 * ledger. A card that spans both columns ends a run (the hero, the pulse, any
 * alert, the category/recent grid); every run left odd hands its LAST card the
 * full row, which is what the layout already does with a lone hero. Class-only,
 * so it is a no-op below 1080px where there is one column to fill.
 */
function closeOddDashboardRows(screen) {
  const spans = el => el.classList.contains('dashboard-hero')
    || el.classList.contains('financial-pulse')
    || el.classList.contains('dashboard-full')
    || el.classList.contains('dashboard-grid')
    || el.getAttribute('role') === 'alert';
  let run = [];
  const flush = () => {
    if (run.length % 2 === 1) run[run.length - 1].classList.add('dashboard-full');
    run = [];
  };
  for (const child of Array.from(screen.children)) {
    if (spans(child)) flush(); else run.push(child);
  }
  flush();
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

  const expensesOnly = monthEntries.filter(isBudgetSpendingEntry);
  const incomeOnly = monthEntries.filter(isBudgetIncomeEntry);
  const catTotals = {};
  for (const e of expensesOnly) {
    catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
  }
  const cats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const expenseSum = expensesOnly.reduce((s, e) => s + e.amount, 0);
  const incomeSum = incomeOnly.reduce((s, e) => s + e.amount, 0);
  const pct = budget ? Math.min(100, (expenseSum / budget) * 100) : 0;
  // Top-overspend nudge: when a single category dominates the month's spend,
  // surface it as a constraint rather than just a bar on the chart.
  const topShare = expenseSum > 0 && cats.length ? Math.round((cats[0][1] / expenseSum) * 100) : 0;

  // Recent 5 - stable order: date desc, then id desc as tiebreaker
  const recent = [...state.entries]
    .filter(entry => entry.type !== 'note')
    .sort((a, b) => b.date.localeCompare(a.date) || (a.id < b.id ? 1 : -1))
    .slice(0, 5);

  const screen = $('section', { class: 'page-section dashboard-section', 'aria-label': 'Dashboard' });

  // Net worth sparkline card (if enough data) - points already computed above.
  // A point is the balance at an ENTRY's date, so the last one equals today's
  // total only when the last account entry IS today. A reconciliation recorded
  // after the last entry - the normal reconcile-then-wait window - changes
  // every balance on screen but not that point, so the card kept showing the
  // pre-reconcile BOOK value (inflated whenever the actual was lower, which is
  // the reason one reconciles) while the hero and the Balances screen showed
  // the truth; it only self-healed on the next transaction. The figure is
  // today's checkpoint-aware total, and the trend gets a final point at today
  // so the line lands on the number it labels and the up/down colour judges
  // the real direction.
  if (points.length >= 2) {
    const trend = points.at(-1).date < today()
      ? [...points, { date: today(), balance: runningBalance }]
      : points;
    const last30 = trend.slice(-30);
    const vals = last30.map(p => p.balance);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const isUp = vals[vals.length - 1] >= vals[0];
    const sparkH = 40, sparkW = 300;
    const step = sparkW / (vals.length - 1);
    const pathD = vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${sparkH - ((v - mn) / rng) * (sparkH - 4) - 2}`).join(' ');
    const areaD = pathD + ` L ${(vals.length - 1) * step} ${sparkH} L 0 ${sparkH} Z`;
    const lastVal = runningBalance;
    const netWorthEl = $('div', { class: 'display-num', style: `font-size:${isNarrow() ? '16px' : '18px'};color:${lastVal >= 0 ? 'var(--positive)' : 'var(--negative)'};` });
    paintFigure(netWorthEl, 'dashboard-net-worth', lastVal);
    // Read as one card header: the figure it labels on the left, the trend
    // beside it. The sparkline's own width is capped because its viewBox is 300
    // wide — stretched into a full-width shell the default `meet` scaling kept
    // the 300px line centred in a 1,200px box, and that letterboxing is the dead
    // space this card used to be. Below 640px the same flex box stacks, so the
    // trend sits under the figure at the card's own width (a phone's width is
    // the viewBox's, so nothing is letterboxed there at all).
    screen.appendChild($('div', { class: 'card dashboard-full net-worth-strip', style: `padding:${isNarrow() ? '14px 16px' : '18px 16px'};margin-bottom:24px;` },
      $('div', { class: 'net-worth-head' },
        $('div', { class: 'eyebrow' }, 'Net worth'),
        netWorthEl,
      ),
      $('svg', { viewBox: `0 0 ${sparkW} ${sparkH}`, class: 'net-worth-spark', 'aria-label': 'Net worth trend' },
        $('path', { d: areaD, style: `fill:${isUp ? 'var(--positive)' : 'var(--negative)'};opacity:0.1;` }),
        $('path', { d: pathD, style: `fill:none;stroke:${isUp ? 'var(--positive)' : 'var(--negative)'};stroke-width:1.5;stroke-linecap:round;` }),
      ),
    ));
  }

  // Resync button - only shown when sync is configured
  const syncS = getSyncSettings();
  const resyncBtn = (syncS.enabled && syncS.endpoint && syncS.password)
    ? $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:13px;gap:6px;', onClick: () => doResync() },
        iconSpan('refresh'),
        'Resync',
      )
    : null;

  // Hero - the monthly total and the balance
  // Both hero figures count when they change (see paintFigure): the month's total
  // and the running balance are the two numbers the whole screen is about, and
  // the moment they change is the moment the reader comes back to look at them.
  const heroTotalEl = $('span', { class: 'serif' });
  paintFigure(heroTotalEl, 'dashboard-month-total', expenseSum);
  const heroBalanceEl = $('span', { class: 'display-num', style: `font-size:13px;color:${runningBalance >= 0 ? 'var(--positive)' : 'var(--negative)'};` });
  paintFigure(heroBalanceEl, 'dashboard-balance', runningBalance);
  screen.appendChild($('div', { class: 'page-title-row dashboard-hero' },
    $('div', null,
      $('div', { class: 'eyebrow' }, monthLabel(key)),
      $('p', { class: 'dashboard-total', style: `font-size:${isTiny() ? '32px' : isNarrow() ? '42px' : '54px'};` },
        heroTotalEl,
        $('span', { class: 'dashboard-budget', style: `font-size:${isNarrow() ? '14px' : '18px'};` }, budget ? `/ ${fmt(budget)}` : ''),
      ),
      $('p', { class: 'dashboard-context', style: `font-size:${isNarrow() ? '13px' : '15px'};gap:${isNarrow() ? '10px' : '18px'};` },
        $('span', null, 'Balance '), $('span', { class: `signed-chip ${runningBalance >= 0 ? 'is-positive' : 'is-negative'}` }, heroBalanceEl),
        cashWidget(),
        voucherWidget(),
      ),
    ),
    $('div', { class: 'dashboard-actions' },
      $('label', { class: 'eyebrow', for: 'budget-input' }, 'Budget'),
      $('input', { id: 'budget-input', type: 'text', inputmode: 'decimal', value: String(budget || ''), placeholder: '-', 'aria-label': 'Monthly budget in euros', autocomplete: 'off', style: `width:${isNarrow() ? '72px' : '92px'};border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;`, onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
        e.target.style.borderColor = 'var(--line)';
        if (!commitBudget(e.target.value)) { e.target.value = String(budget || ''); toast('Enter a non-negative number.'); }
      }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      tabVisible('add') ? $('a', { href: '#add', class: 'btn btn-primary' },
        $('span', { class: 'btn-new-icon', style: 'margin-right:6px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line class="icon-plus-h" x1="5" y1="12" x2="19" y2="12"/><line class="icon-plus-v" x1="12" y1="5" x2="12" y2="19"/></svg>' }),
        'New entry',
      ) : null,
      resyncBtn,
    ),
  ));

  // Gift-card low-balance notice - when a Tesco/Lidl card's current balance
  // drops below €5 it shows here on the home screen with a tap-through to the
  // Balances screen to top it up. Swipe it away on touch like a phone
  // notification; it re-arms once the card is topped back up.
  // Only a card that has actually been used can be "running low": a brand-new
  // account legitimately sits at €0.00, and alerting on every untouched card
  // would greet a fresh install with two warnings about money it never had.
  const giftCardUsed = (id) => state.entries.some(e => e.method === id)
    || (state.settings.balanceCheckpoints?.[id] || []).length > 0;
  const lowGiftCards = ['TG', 'LG']
    .map(id => ({ id, label: methodShort(id), balance: computeGiftCardBalance(state.entries, id).balance }))
    .filter(card => giftCardUsed(card.id));
  for (const card of lowGiftCards) {
    if (card.balance >= 5) setAlertDismissed(`gift-low:${card.id}`, false);
  }
  const lowGiftVisible = lowGiftCards.filter(card => card.balance < 5 && !alertDismissed(`gift-low:${card.id}`));
  if (lowGiftVisible.length) {
    const giftCard = $('div', { class: 'card', role: 'alert', style: `padding:${isNarrow() ? '14px 16px' : '16px'};margin-bottom:24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid color-mix(in srgb, var(--negative) 35%, transparent);background:color-mix(in srgb, var(--negative) 8%, transparent);` },
      iconSpan('alert', 'md'),
      $('div', { style: 'flex:1;min-width:0;' },
        $('div', { style: 'font-weight:600;font-size:13px;' },
          lowGiftVisible.some(c => c.balance > 0) || !lowGiftVisible.some(c => c.balance <= 0)
            ? 'Gift card running low'
            : 'Gift card over its balance'),
        $('div', { class: 'muted', style: 'font-size:12px;margin-top:2px;' },
          lowGiftVisible.map(card => card.balance > 0
            ? `${card.label} has ${fmt(card.balance)} left`
            : `${card.label} is ${fmt(Math.abs(card.balance))} over its balance`).join(' · '),
        ),
      ),
      // One tap per card lands straight in that card's pre-focused load
      // editor on Balances - the whole top-up flow is two taps from home.
      // The top-up flow lives on the Balances tab, so the buttons go with it.
      ...(tabVisible('balances') ? lowGiftVisible.map(card =>
        $('a', { href: `#balances?load=${card.id}`, class: 'btn btn-ghost', style: 'padding:6px 14px;font-size:12px;flex-shrink:0;' }, `Top up ${card.label}`)) : []),
    );
    screen.appendChild(giftCard);
    attachSwipeDismiss(giftCard, () => {
      const ids = lowGiftVisible.map(c => `gift-low:${c.id}`);
      ids.forEach(id => setAlertDismissed(id, true));
      toast('Notification dismissed', () => { ids.forEach(id => setAlertDismissed(id, false)); render(); }, 'Undo');
    });
  }

  // Tesco paper vouchers notice - when the amount sits above the threshold it
  // stays visible on the home screen (plus the one-time toast when it crossed
  // in the editor). Purely informational: vouchers never touch the balance.
  // Swipeable like the gift-card notice; re-arms once the tally drops.
  const voucherTally = voucherAmount();
  if (voucherTally <= VOUCHER_NOTICE_AT) setAlertDismissed('voucher-notice', false);
  if (voucherTally > VOUCHER_NOTICE_AT && !alertDismissed('voucher-notice')) {
    const voucherCard = $('div', { class: 'card', role: 'alert', style: `padding:${isNarrow() ? '14px 16px' : '16px'};margin-bottom:24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid color-mix(in srgb, var(--accent) 40%, transparent);background:color-mix(in srgb, var(--accent) 8%, transparent);` },
      iconSpan('alert', 'md'),
      $('div', { style: 'flex:1;min-width:0;' },
        $('div', { style: 'font-weight:600;font-size:13px;' }, 'Tesco paper vouchers piling up'),
        $('div', { class: 'muted', style: 'font-size:12px;margin-top:2px;' }, `You have ${fmt(voucherTally)} of vouchers - that's above the ${fmt(VOUCHER_NOTICE_AT)} limit.`),
      ),
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 14px;font-size:12px;flex-shrink:0;', onClick: () => openVoucherEditor() }, 'Update'),
    );
    screen.appendChild(voucherCard);
    attachSwipeDismiss(voucherCard, () => {
      setAlertDismissed('voucher-notice', true);
      toast('Notification dismissed', () => { setAlertDismissed('voucher-notice', false); render(); }, 'Undo');
    });
  }

  // Milestone chips - personality that rewards consistency.
  const ms = computeMilestones();
  const chips = [];
  if (ms.entryCount > 0) chips.push($('span', { class: 'pill', title: 'Total entries logged' }, iconSpan('book', 'sm'), `${ms.entryCount} entr${ms.entryCount === 1 ? 'y' : 'ies'} logged`));
  if (ms.monthsUnderBudget >= 1) chips.push($('span', { class: 'pill', title: 'Months where spending stayed within budget' }, iconSpan('medal', 'sm'), `${ms.monthsUnderBudget} month${ms.monthsUnderBudget === 1 ? '' : 's'} under budget`));
  if (chips.length) screen.appendChild($('div', { class: 'dashboard-full', style: 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;' }, ...chips));

  // Pulse - the single "how am I doing?" glance: headline number, key figures,
  // and a tap-through to Insights for the full picture.
  screen.appendChild(dashboardPulse(key, expenseSum, runningBalance));

  // A pattern the ledger has already proven, offered once. It sits directly
  // under the pulse because it is the one thing on this screen that changes
  // the NEXT month rather than describing this one.
  const patternCard = recurringSuggestionCard();
  if (patternCard) screen.appendChild(patternCard);

  // Budget bar card
  if (budget > 0) {
    screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:${isNarrow() ? '22px' : '32px'};` },
      $('div', { class: 'row between' },
        $('span', { class: 'eyebrow' }, 'Spent of budget'),
        $('span', { class: 'serif', style: 'font-size:22px;' }, `${pct.toFixed(1)}%`),
      ),
      $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;margin:14px 0 20px;' },
        $('div', { class: 'budget-bar-fill', style: `height:100%;width:${pct}%;background:${pct > 90 ? 'var(--negative)' : 'var(--accent)'};transition:width .5s cubic-bezier(0.2,0.8,0.2,1);border-radius:99px;` }),
      ),
      // The Pulse block already carries Spent/Projected/Remaining/Avg-day/Burn;
      // keep only what it doesn't, as one compact line instead of a stat grid.
      $('div', { style: `display:flex;flex-wrap:wrap;gap:4px 20px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);` },
        $('span', null, 'Income ', $('span', { style: 'color:var(--positive);font-weight:600;' }, fmt(incomeSum))),
        $('span', null, 'Net ', $('span', { style: 'color:var(--ink);' }, fmt(totalForMonth(key)))),
        $('span', null, 'Month elapsed ', $('span', { style: 'color:var(--ink);' }, Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100) + '%')),
      ),
    ));
  }

  // Tesco Pay - the pay-month snapshot from the #tesco tab, one tap away.
  // Only rendered once there are shifts, so it never clutters the dashboard
  // for anyone who isn't on a Tesco rota.
  const tescoShifts = (state.tesco && state.tesco.shifts) || [];
  if (tescoShifts.length && tabVisible('tesco')) {
    const tescoRates = { ...TESCO_RATE_DEFAULTS, ...(state.settings.tescoRates || {}) };
    // Both figures are nets (see monthSummary): what the month's hours should pay
    // after tax, and what the bank has paid in so far. The words match the tab's
    // own stat card, because they are the same three figures.
    const tescoMonth = monthSummary(tescoShifts, (state.tesco && state.tesco.payslips) || [], tescoRates, now.getFullYear(), now.getMonth(), isoLocal(now));
    // The holiday balance the tab's card computes, from the same engine and the
    // same stored tables — so the dashboard cannot disagree with the screen it
    // links to about a figure the user reads off a payslip. Only once a balance
    // is set up: an unconfigured document has nothing to show, not a 0.00h that
    // would read as "no holiday earned".
    const tescoHoliday = holidayBalance(tescoShifts, state.settings.tescoHoliday, tescoRates, isoLocal(now));
    // The card is a link and a control, so it is a div holding both: a button
    // inside an anchor is invalid HTML and its click would navigate instead of
    // running. The whole left side is still one tap to the tab.
    screen.appendChild($('div', { class: 'card', style: 'display:flex;align-items:center;gap:12px;margin-bottom:24px;' },
      $('a', { href: '#tesco', style: 'display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-decoration:none;color:inherit;' },
        iconSpan('briefcase', 'md'),
        $('div', { style: 'flex:1;min-width:0;' },
          $('div', { style: 'font-weight:600;font-size:13px;' }, 'Tesco Pay'),
          $('div', { class: 'muted', style: 'font-size:12px;margin-top:2px;' },
            `${tescoMonth.hours}h this month · ${fmt(tescoMonth.anticipated)} anticipated (est. net) · ${fmt(tescoMonth.received)} received`,
            tescoHoliday.configured ? ` · ${Number(tescoHoliday.outstanding).toFixed(2)}h holiday` : ''),
        ),
        $('span', { class: 'muted', style: 'font-size:11px;' }, 'Open →'),
      ),
      // Refresh re-derives this line from the tab's own tables and runs the
      // ledger recording, so a week that was recorded over there is money in
      // Balances without waiting for another Tesco edit.
      $('button', {
        type: 'button', class: 'btn btn-ghost',
        style: 'font-size:11px;padding:4px 10px;gap:5px;flex-shrink:0;',
        'aria-label': 'Refresh Tesco Pay',
        title: 'Recompute this card from Tesco Pay, and write any recorded pay to Balances',
        onClick: refreshTescoPay,
      }, iconSpan('refresh', 'sm'), 'Refresh'),
    ));
  }

  // Recurring transactions - always show card so "+ New" is accessible
  const allRecurring = state.settings.recurring || [];
  const recurring = allRecurring.filter(r => r.nextDate <= key + '-31');
  const dueSoonCount = allRecurring.filter(r => {
    const d = daysUntil(r.nextDate);
    return d >= 0 && d <= 7;
  }).length;
  // Compact "due this week" strip: everything due within 7 days (including
  // overdue) as one-tap mark-paid chips, each undoable.
  const dueThisWeek = allRecurring.filter(r => daysUntil(r.nextDate) <= 7);
  const recCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('div', { style: 'display:flex;align-items:center;gap:10px;' },
        $('span', { class: 'eyebrow' }, `Recurring · ${allRecurring.length}`),
        dueSoonCount > 0 ? $('span', { class: 'pill', style: 'border-color:var(--accent);color:var(--accent);font-size:10px;' }, `⏰ ${dueSoonCount} due soon`) : null,
      ),
      $('div', { style: 'display:flex;align-items:center;gap:12px;' },
        allRecurring.length > 0 ? $('button', { type: 'button', style: 'font-size:11px;color:var(--muted);cursor:pointer;background:none;border:none;padding:0;text-decoration:underline;text-underline-offset:2px;', onClick: () => openRecurringManager() }, 'Manage all') : null,
        // 44×24 hit area (WCAG 2.2 AA target size) without moving the visual
        // baseline: padding plus a matching negative margin keeps the text
        // where it sat while the tappable box grows around it.
        $('button', { type: 'button', style: 'font-size:11px;color:var(--accent);cursor:pointer;background:none;border:none;padding:5px 6px;margin:-5px -6px;min-height:24px;display:inline-flex;align-items:center;border-radius:6px;', onClick: () => openNewRecurring() }, '+ New'),
      ),
    ),
    dueThisWeek.length > 0 ? $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;' },
      ...dueThisWeek.slice(0, 5).map(r => {
        const d = daysUntil(r.nextDate);
        const overdue = d < 0;
        const label = overdue ? 'overdue' : d === 0 ? 'today' : `in ${d}d`;
        return $('button', { type: 'button', class: 'pill', title: `Mark "${r.details}" as paid`, 'aria-label': `Mark ${r.details} as paid (${label})`, style: `border-color:${overdue ? 'var(--negative)' : 'var(--accent)'};color:${overdue ? 'var(--negative)' : 'var(--accent)'};font-size:10px;cursor:pointer;background:transparent;`, onClick: () => paidRecurring(r) },
          iconSpan('check-circle', 'sm'),
          `${r.details} · ${label}`,
        );
      }),
      dueThisWeek.length > 5 ? $('span', { class: 'muted', style: 'font-size:10px;align-self:center;' }, `+${dueThisWeek.length - 5} more`) : null,
    ) : null,
    recurring.length === 0
      ? $('div', { class: 'muted', style: 'font-size:13px;' }, allRecurring.length ? 'No items due this month. See all in Manage all.' : 'No recurring items yet. Add your rent, subscriptions, or paydays.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
        ...recurring.map(r => {
          const isOverdue = r.nextDate <= today();
          const daysAway = daysUntil(r.nextDate);
          const isDueSoon = !isOverdue && daysAway >= 0 && daysAway <= 7;
          return $('div', { 'data-rec-id': r.id, class: 'rec-row', style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
            $('div', { style: 'display:flex;align-items:center;gap:10px;flex:1;min-width:0;' },
              $('button', { type: 'button', style: 'width:20px;height:20px;border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;line-height:1;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;', onClick: () => openNewRecurring(r), title: 'Edit recurring', 'aria-label': `Edit ${r.details}` }, iconSpan('pencil', 'sm')),
              $('button', { type: 'button', style: 'width:20px;height:20px;border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0;flex-shrink:0;', onClick: () => {
                const removed = state.settings.recurring.filter(x => x.id === r.id);
                state.settings.recurring = state.settings.recurring.filter(x => x.id !== r.id);
                trackAction(() => { state.settings.recurring.push(...removed); persist(); }, `Removed recurring "${r.details}"`);
                persist(); toast(`Removed recurring "${r.details}".`); render();
              }, title: 'Remove recurring' }, '×'),
              $('span', { style: `display:inline-block;width:7px;height:7px;border-radius:50%;background:${isOverdue ? 'var(--negative)' : isDueSoon ? 'var(--accent)' : 'var(--muted)'};flex-shrink:0;box-shadow:${isDueSoon ? '0 0 0 3px var(--accent-fade)' : 'none'};` }),
              $('span', { style: 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, r.details),
              $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;flex-shrink:0;' }, methodShort(r.method)),
              $('span', { class: 'muted', style: 'font-size:11px;flex-shrink:0;' }, friendlyDate(r.nextDate)),
              isDueSoon ? $('span', { class: 'pill', style: 'border-color:var(--accent);color:var(--accent);font-size:10px;flex-shrink:0;' }, daysAway === 0 ? 'today' : `in ${daysAway}d`) : null,
            ),
            $('div', { style: 'display:flex;align-items:center;gap:10px;flex-shrink:0;' },
              $('span', { class: 'display-num', style: `font-size:13px;color:${r.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};` }, (r.type === 'credit' ? '+' : '') + fmt(r.amount)),
              $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:4px 12px;font-size:11px;', onClick: (ev) => {
        const rowEl = ev.target.closest('[data-rec-id]');
        if (rowEl) { rowEl.classList.add('paid-anim'); setTimeout(() => paidRecurring(r), 500); }
        else paidRecurring(r);
      } }, $('span', { class: 'btn-paid-icon', style: 'margin-right:5px;', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><polyline class="icon-paid-check" points="9 12 11 14 15 10"/></svg>' }), 'Paid'),
            ),
          );
        }),
      ),
  );
  screen.appendChild(recCard);

  // Upcoming strip - the next 30 days of scheduled recurring charges, each
  // payable one-tap without waiting for the due date.
  const upcoming = [];
  for (const r of allRecurring) for (const date of upcomingOccurrences(r)) upcoming.push({ rec: r, date });
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) {
    screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
      $('div', { class: 'row between', style: 'margin-bottom:8px;' },
        $('span', { class: 'eyebrow' }, 'Upcoming · next 30 days'),
        $('span', { class: 'muted', style: 'font-size:11px;' }, 'Pre-pay a scheduled charge any day it falls due.'),
      ),
      $('div', { style: 'display:flex;flex-direction:column;' },
        ...upcoming.slice(0, 6).map(item => $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
          $('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0;flex:1;' },
            $('span', { style: 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, item.rec.details),
            $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;flex-shrink:0;' }, item.rec.method),
            $('span', { class: 'muted', style: 'font-size:11px;flex-shrink:0;' }, friendlyDate(item.date)),
          ),
          $('div', { style: 'display:flex;align-items:center;gap:10px;flex-shrink:0;' },
            $('span', { class: 'display-num', style: `font-size:13px;color:${item.rec.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};` }, (item.rec.type === 'credit' ? '+' : '') + fmt(item.rec.amount)),
            $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:4px 12px;font-size:11px;', onClick: () => skipRecurring(item.rec, item.date) }, 'Skip'),
            $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:4px 12px;font-size:11px;', onClick: () => payRecurringOn(item.rec, item.date) }, 'Add now'),
          ),
        )),
      ),
      upcoming.length > 6 ? $('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;' }, `…and ${upcoming.length - 6} more in the next 30 days.`) : null,
    ));
  }

  // Category breakdown + recent
  const grid = $('div', { class: 'dashboard-grid' });
  // Responsive: 2-col on >=760px (set inline because we want it to ship without extra CSS)
  if (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches) {
    grid.style.gridTemplateColumns = 'minmax(0, 2fr) minmax(0, 3fr)';
  }

  // Per-category budget targets: optional monthly caps per category, edited
  // inline in this card. When a target is set, the bar fills toward the target
  // (turning red when over) instead of toward the top category.
  const catTargets = state.settings.categoryBudgets || (state.settings.categoryBudgets = {});
  const overBudgetCat = cats
    .map(([cat, val]) => ({ cat, val, target: +catTargets[cat] || 0 }))
    .filter(c => c.target > 0 && c.val > c.target)
    .sort((a, b) => (b.val - b.target) - (a.val - a.target))[0];
  const catCallout = overBudgetCat
    ? $('div', { style: 'display:flex;align-items:center;gap:7px;font-size:12px;margin-bottom:14px;color:var(--negative);' },
        iconSpan('alert', 'sm'),
        $('span', null, `${categoryLabel(overBudgetCat.cat)} is ${fmt(overBudgetCat.val - overBudgetCat.target)} over its ${fmt(overBudgetCat.target)} target.`),
      )
    : (topShare >= 50 && Object.keys(catTargets).length === 0
        ? $('div', { style: 'display:flex;align-items:center;gap:7px;font-size:12px;margin-bottom:14px;color:var(--negative);' },
            iconSpan('alert', 'sm'),
            $('span', null, `${categoryLabel(cats[0][0])} is ${topShare}% of this month's spend.`),
          )
        : null);
  const catRow = (cat, val) => {
    const target = +catTargets[cat] || 0;
    const over = target > 0 && val > target;
    const rightEl = $('div', { style: 'display:flex;align-items:center;gap:8px;' });
    const barEl = $('div', { style: 'height:100%;border-radius:99px;transition:width .5s cubic-bezier(0.2,0.8,0.2,1);' });
    const paintBar = () => {
      barEl.style.width = (target > 0 ? Math.min(100, (val / target) * 100) : cats[0][1] > 0 ? (val / cats[0][1]) * 100 : 0) + '%';
      barEl.style.background = over ? 'var(--negative)' : catBarGradient(cat);
    };
    const startEdit = () => {
      const input = $('input', { type: 'text', inputmode: 'decimal', value: target ? String(target) : '', 'aria-label': `Monthly target for ${categoryLabel(cat)}`, autocomplete: 'off', style: 'width:62px;border:1px solid var(--accent);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:3px 8px;font-size:12px;text-align:right;' });
      const commit = raw => {
        const v = parseAmount(raw);
        if (!Number.isFinite(v) || v < 0) { toast('Enter a non-negative number.'); paintDisplay(); return; }
        if (v === 0) delete catTargets[cat]; else catTargets[cat] = Math.min(Math.round(v * 100) / 100, 1_000_000);
        persist();
        toast(v === 0 ? `Target cleared for ${categoryLabel(cat)}.` : `Target set for ${categoryLabel(cat)}.`);
        render();
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') { input.onblur = null; paintDisplay(); }
      };
      input.onblur = () => commit(input.value);
      rightEl.replaceChildren(
        input,
        target > 0 ? $('button', { type: 'button', title: 'Clear this category\'s target', style: 'border:none;background:none;color:var(--negative);font-size:10px;cursor:pointer;padding:0;', onMouseDown: (e) => { e.preventDefault(); input.onblur = null; delete catTargets[cat]; persist(); toast(`Target cleared for ${categoryLabel(cat)}.`); render(); } }, 'Clear') : null,
      );
      input.focus();
      input.select();
    };
    const paintDisplay = () => {
      rightEl.replaceChildren(
        $('span', { class: 'tnum' }, fmt(val)),
        target > 0
          ? $('button', { type: 'button', title: 'Edit this category\'s monthly target', 'aria-label': `Edit target for ${categoryLabel(cat)}`, style: `border:1px solid ${over ? 'var(--negative)' : 'var(--line)'};border-radius:99px;background:transparent;color:${over ? 'var(--negative)' : 'var(--muted)'};font-size:10px;padding:2px 8px;cursor:pointer;`, onClick: startEdit },
              `${Math.round((val / target) * 100)}% of ${fmt(target)}`,
            )
          : $('button', { type: 'button', title: 'Set a monthly target for this category', 'aria-label': `Set target for ${categoryLabel(cat)}`, style: 'border:1px dashed var(--line);border-radius:99px;background:transparent;color:var(--muted);font-size:10px;padding:2px 8px;cursor:pointer;', onClick: startEdit },
              '+ target',
            ),
      );
      paintBar();
    };
    paintDisplay();
    return $('div', null,
      $('div', { class: 'row between', style: 'font-size:13px;margin-bottom:6px;' },
        $('span', { style: 'font-weight:500;' }, categoryLabel(cat)),
        rightEl,
      ),
      $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;' }, barEl),
    );
  };

  const catCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'By category'),
      $('span', { class: 'muted', style: 'font-size:11px;' }, 'this month'),
    ),
    catCallout,
    cats.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('receipt'), ' Nothing logged yet.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:14px;' },
          ...cats.map(([cat, val]) => catRow(cat, val)),
        ),
  );

  const recentCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};overflow-x:auto;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Recent'),
      tabVisible('history') ? $('a', { href: '#history', class: 'btn-link' }, 'See all ', iconSpan('arrow-right', 'sm')) : null,
    ),
    recent.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('chart'), ' No entries yet.')
      : $('div', { style: `display:grid;grid-template-columns:${isNarrow() ? '75px 1fr 80px' : '90px 1fr 110px 150px'};gap:${isNarrow() ? '8px 12px' : '12px 24px'};font-size:${isNarrow() ? '12px' : '14px'};${isNarrow() ? '' : 'min-width:580px;'}` },
          ...recent.flatMap(e => [
            $('span', { class: 'muted', style: 'font-size:12px;' }, friendlyDate(e.date)),
            $('div', null,
              $('div', { style: 'font-weight:500;' }, e.details || '-'),
              $('div', { style: `font-size:11px;color:var(--muted);${isNarrow() ? 'display:none;' : ''}` }, `${categoryLabel(e.category)} · ${methodLabel(e.method)}`),
            ),
            $('span', { class: 'display-num', style: `text-align:right;font-size:${isNarrow() ? '13px' : '15px'};color:${e.type === 'credit' ? 'var(--positive)' : 'var(--negative)'}` }, (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
            ...(isNarrow() ? [] : [$('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, methodShort(e.method)))]),
          ]),
        ),
  );

  grid.append(catCard, recentCard);
  screen.appendChild(grid);

  // All tracked balances share one inline reconciliation flow. A checkpoint
  // records the actual balance on a date without rewriting any transactions.
  const secondaryFor = (id) => accountStatus(id).label;
  const accountsCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Bank account balances'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Current end-of-day balances; transaction history stays unchanged.'),
      ),
      tabVisible('balances') ? $('a', { href: '#balances', class: 'btn-link', style: 'font-size:12px;' }, 'Manage ', iconSpan('arrow-right', 'sm')) : null,
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...renderAccountBalanceRows({ secondaryFor }),
    ),
  );
  screen.appendChild(accountsCard);

  // Only a gift card with a history or a reconciliation earns a row here: three
  // untouched €0.00 cards were the first thing a fresh install showed. The
  // Balances screen keeps every card, editable, so nothing is unreachable.
  const activeGiftCards = GIFT_CARD_IDS.filter(id => giftCardUsed(id));
  if (activeGiftCards.length) {
    const gcCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
      $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px;' },
        $('div', null,
          $('div', { class: 'eyebrow' }, 'Gift card balances'),
          $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Current provider balances without adding a fake transaction. Totals show recorded activity, or post-reconciliation adjustments when a checkpoint exists.'),
        ),
        tabVisible('balances') ? $('a', { href: '#balances', class: 'btn-link', style: 'font-size:12px;' }, 'Manage ', iconSpan('arrow-right', 'sm')) : null,
      ),
      $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },     ...activeGiftCards.map(id => {
         const m = methodById(id);
         const totals = computeGiftCardBalance(state.entries, id);
         return renderBalanceEditorRow(id, {
           label: m?.label?.includes(' · ') ? m.label.split(' · ')[1] : (m?.label || id),            secondary: totals.loaded || totals.spent
              ? `${userCheckpointFor(id, today()) ? 'net adjustments · loads' : 'recorded loads'} ${fmt(totals.loaded)} · spending ${fmt(totals.spent)}`
              : '',
           secondaryHint: 'Loads are what went ON the card, spending what came off it. After a reconciliation the figure is your adjustments plus those loads.',
           editable: false,
         });
       }),
      ),
    );
    screen.appendChild(gcCard);
  }

  // Tesco pay - Thursdays tracker.
  //
  // This card is titled "Tesco pay", so only Tesco pay may fill it. It used to
  // sum EVERY income entry by date, which made a €2,400 salary on the 1st read
  // as "1/5 paid" and sent Auto-fill copying it into the remaining Thursdays.
  // The rules live in tescoThursdayIncome() so the card is one call: a line
  // this app recorded always counts; other income counts only when the Tesco
  // tab has shifts (or names Tesco) to explain why it belongs here; with
  // neither signal there is nothing to track and the card is not shown at all
  // — which is also what keeps a fresh ledger from greeting a new user with
  // "0/5 paid" and an Auto-fill button.
  const thursdays = thursdaysInMonth(now.getFullYear(), now.getMonth());
  // Build local today string the same way thursdaysInMonth does (no UTC shift)
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // What Tesco Pay recorded for each pay date: the key IS the date the entry
  // carries — a week's Sunday + 11, the Thursday it lands.
  const payDateAmounts = tescoReceivedByDate();
  const payTracker = tescoThursdayIncome(thursdays, payDateAmounts);
  const incomeByDate = payTracker.byDate;
  const unpaidThursdays = thursdays.filter(d => !incomeByDate[d] && d <= todayStr);
  const paidTotal = thursdays.reduce((sum, d) => sum + (incomeByDate[d] || 0), 0);

  const payCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Tesco pay · Thursdays'),
      $('div', { style: 'display:flex;align-items:center;gap:10px;' },
        $('span', { class: 'muted', style: 'font-size:11px;' }, `${thursdays.filter(d => !!incomeByDate[d]).length}/${thursdays.length} paid`),
        unpaidThursdays.length > 0 ? $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:4px 12px;font-size:11px;', title: 'Fill each unpaid Thursday with what Tesco Pay recorded for the week that was paid on it, and with the last amount where it has nothing', onClick: () => autoFillAll(unpaidThursdays) }, `Auto-fill (${unpaidThursdays.length})`) : null,
      ),
    ),
    thursdays.length === 0
      ? $('div', { class: 'empty' }, 'No Thursdays this month.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:4px;' },
          $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;font-weight:600;' },
            $('span', { class: 'eyebrow', style: 'margin:0;' }, 'Total'),
            $('span', { class: 'display-num', style: 'font-size:16px;color:var(--positive);' }, `+${fmt(paidTotal)}`),
          ),
          ...thursdays.map(d => {
            const paid = incomeByDate[d] != null;
            const isPast = d < todayStr;
            const isToday = d === todayStr;
            const isFuture = d > todayStr;
            const [dy, dm, dd] = d.split('-').map(Number);
            const dt = new Date(Date.UTC(dy, dm - 1, dd));
            const dayName = WEEKDAY_FORMATTER.format(dt);
            const dayNum = dt.getDate();
            const statusColor = paid ? 'var(--positive)' : isFuture ? 'var(--muted)' : 'var(--negative)';
            const canFill = !paid && (isPast || isToday);
            // The line this card is counting for the day, when it is one it wrote.
            // A paid Thursday used to print its figure and nothing else, so a
            // wrong amount — the reason anyone opens this card on pay day — could
            // only be fixed in History by finding the row there. Anything that
            // merely lands on a Thursday (a salary, a refund) is not Tesco pay and
            // stays out of reach: the card offers to fix what it recognises.
            const payLine = paid
              ? state.entries.find(e => e.date === d && e.type === 'credit' && e.details === 'Tesco pay')
              : null;
            return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;' },
              $('div', { style: 'display:flex;align-items:center;gap:12px;' },
                $('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;` }),
                $('span', { style: 'font-weight:500;' }, `${dayName} ${dayNum}`),
                isToday ? $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;padding:2px 8px;' }, 'today') : null,
              ),
              $('div', { style: 'display:flex;align-items:center;gap:8px;' },
                $('span', { class: 'display-num', style: `font-size:14px;color:${paid ? 'var(--positive)' : 'var(--muted)'};` },
                  paid ? `+${fmt(incomeByDate[d])}` : '-',
                ),
                // What Fill will use, shown before it is used: Tesco Pay's figure
                // for the week this Thursday pays, when it has one to read.
                canFill && payDateAmounts[d] ? $('span', {
                  class: 'muted', style: 'font-size:11px;',
                  title: payDateAmounts[d].source === 'bank'
                    ? 'Tesco Pay: the final bank pay recorded for the week that was paid on this Thursday'
                    : "Tesco Pay: that week's gross minus the tax its payslips withheld",
                }, fmt(payDateAmounts[d].amount)) : null,
                canFill ? $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:3px 10px;font-size:10px;min-height:24px;', onClick: () => fillThursday(d) }, 'Fill') : null,
                // Editing goes through the ledger's own editor, so the line is
                // changed where every other entry is changed (one undo step, the
                // duplicate gate, the tombstones and a sync revision included).
                payLine ? $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:3px 10px;font-size:10px;min-height:24px;', 'aria-label': `Edit Tesco pay for ${friendlyDate(d)}`, title: 'Edit this Tesco pay line', onClick: () => openEdit(payLine.id) }, 'Edit') : null,
              ),
            );
          }),
        ),
  );
  if (payTracker.shown && tabVisible('tesco')) screen.appendChild(payCard);

  // The four numbers, LAST on purpose: they are the card that closes the final
  // row, so the pairings above resolve first and this one fills what is left —
  // with a partner on a full ledger, full width when it would otherwise sit
  // alone. closeOddDashboardRows is the backstop for every other run.
  screen.appendChild(monthNumbersCard(key, now));
  closeOddDashboardRows(screen);

  return screen;
}

function catBarGradient(catId) {
  const map = {
    gro: 'var(--accent)',
    travel: 'color-mix(in srgb, var(--accent) 72%, var(--ink))',
    rent: 'color-mix(in srgb, var(--accent) 50%, var(--bg))',
    GC: 'color-mix(in srgb, var(--accent) 30%, var(--bg))',
    misc: 'var(--muted)',
  };
  return map[catId] || 'var(--bar-soft)';
}

/** Inline SVG icons for empty states. Returns an HTML string suitable for innerHTML. */
function emptySVG(kind) {
  const icons = {
    receipt: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="8" y="4" width="24" height="32" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="14" y1="12" x2="26" y2="12" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="18" x2="22" y2="18" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="24" x2="24" y2="24" stroke="currentColor" stroke-width="1.2"/></svg>',
    chart: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="6" y="22" width="7" height="14" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="16" y="12" width="7" height="24" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="26" y="6" width="7" height="30" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
    coin: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="20" cy="20" r="14" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="20" r="10" stroke="currentColor" stroke-width="1.2"/><text x="20" y="24" text-anchor="middle" font-family="Space Grotesk,sans-serif" font-size="12" fill="currentColor">€</text></svg>',
  };
  return icons[kind] || '';
}

/** Create an empty-state icon span with the SVG rendered via innerHTML. */
function emptyIcon(kind) {
  const span = $('span', { class: 'empty-icon', style: 'display:block;margin:0 auto 12px;opacity:0.3;' });
  span.innerHTML = emptySVG(kind);
  return span;
}

function emptyStateCard({ icon = 'receipt', title, blurb, actionLabel = null, actionHref = null }) {
  return $('div', { class: 'card empty-state', style: 'padding:48px 16px;text-align:center;' },
    emptyIcon(icon),
    $('div', { class: 'serif', style: 'font-size:22px;margin-bottom:6px;' }, title),
    $('div', { class: 'muted', style: 'font-size:13px;margin:0 auto 18px;max-width:360px;line-height:1.5;' }, blurb),
    actionLabel && actionHref ? $('a', { href: actionHref, class: 'btn btn-primary' }, actionLabel) : null,
  );
}

function stat(label, value, color, hint) {
  return $('div', null,
    $('div', { class: 'eyebrow', title: hint || null, style: hint ? 'cursor:help;' : null },
      label,
      // The marker is decorative and the sentence lives in the title, so a
      // reader hears the term and not "info circle".
      hint ? $('span', { 'aria-hidden': 'true', style: 'margin-left:4px;opacity:.65;' }, '\u24d8') : null,
    ),
    $('div', { class: 'display-num', style: `font-size:${isNarrow() ? '18px' : '22px'};margin-top:4px;${color ? `color:${color};` : ''}` }, value),
  );
}

// ---------- cash widget ----------
// The one active window-scroll handler that hides the cash breakdown tooltip
// on scroll; re-renders swap it out instead of stacking duplicates.
let cashTipScrollHandler = null;
function cashWidget() {
  const coins = { ...COINS_DEFAULT, ...(state.settings.coins || {}) };
  const total = computeCashTotal(coins);
  const tipLines = COINS.filter(c => coins[String(c.val)] > 0).map(c =>
    `${coins[String(c.val)]} × ${c.label} = ${fmt(coins[String(c.val)] * c.val)}`
  );
  const hasAny = tipLines.length > 0;

  let tipTimeout;
  const wrapper = $('span', { style: 'position:relative;display:inline-flex;align-items:center;gap:6px;cursor:pointer;' },
    $('span', { style: 'font-family:"Space Grotesk",sans-serif;' }, 'Cash '),
    $('span', { class: 'display-num', style: `font-size:16px;color:${total > 0 ? 'var(--accent)' : 'var(--muted)'};` }, fmt(total)),
  );

  // The breakdown tooltip is body-attached and fixed-positioned so the hero's
  // overflow:hidden can't clip it, and aligned to the widget's edges instead
  // of centered over the card (where it covered the balance number).
  const oldTip = document.querySelector('.cash-tip');
  if (oldTip) {
    clearTimeout(tipTimeout);
    if (cashTipScrollHandler) {
      window.removeEventListener('scroll', cashTipScrollHandler);
      cashTipScrollHandler = null;
    }
    oldTip.remove();
  }
  if (hasAny) {
    const tip = $('div', { class: 'cash-tip', style: 'position:fixed;padding:12px 16px;background:var(--ink);color:var(--bg);border-radius:10px;font-size:12px;line-height:1.7;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s;z-index:200;box-shadow:0 4px 16px rgba(0,0,0,0.18);' },
      ...tipLines.map(l => $('div', null, l)),
      $('div', { style: 'margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.22);font-weight:600;' }, `Total: ${fmt(total)}`),
    );
    document.body.appendChild(tip);
    const positionTip = () => {
      const r = wrapper.getBoundingClientRect();
      const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
      // Right edge of the tip aligns with the right edge of the widget, but
      // never let it drift off either side of the viewport (a nowrap tip can
      // be wider than the space left of the widget on narrow screens).
      const left = Math.max(8, Math.min(Math.round(r.right - tipW), window.innerWidth - tipW - 8));
      tip.style.left = `${left}px`;
      // Prefer opening below; flip above when there isn't room on screen.
      const below = r.bottom + 8;
      tip.style.top = `${below + tipH <= window.innerHeight - 8 ? below : Math.max(8, r.top - tipH - 8)}px`;
    };
    const showTip = () => { positionTip(); tip.style.opacity = '1'; };
    const hideTip = () => { tip.style.opacity = '0'; };
    wrapper.addEventListener('mouseenter', () => { clearTimeout(tipTimeout); showTip(); });
    wrapper.addEventListener('mouseleave', () => { tipTimeout = setTimeout(hideTip, 150); });
    // Scrolling moves the widget away from under the cursor - never leave the
    // tip floating at a stale position. The handler is module-level so a
    // re-render removes the previous one instead of stacking duplicates.
    cashTipScrollHandler = () => { if (tip.style.opacity === '1') hideTip(); };
    window.addEventListener('scroll', cashTipScrollHandler, { passive: true });
  }

  wrapper.addEventListener('click', () => openCashEditor());

  return wrapper;
}

/** Tesco paper vouchers widget - the euro amount on hand next to Cash. Click
 *  to edit. It never feeds into any balance; over the notice threshold it
 *  turns red and a persistent alert card appears on the dashboard. */
function voucherWidget() {
  const amount = voucherAmount();
  // Present at €0.00, not hidden by it. It used to vanish when the tally was
  // zero — on a phone that left no sign the feature existed at all (the pill is
  // the only place this figure appears on the dashboard), and "not there" read
  // as "not supported" rather than "nothing recorded". A muted €0.00 says which
  // of the two it is, and stays the way into the editor.
  const over = amount > VOUCHER_NOTICE_AT;
  const wrapper = $('span', { style: 'position:relative;display:inline-flex;align-items:center;gap:6px;cursor:pointer;', title: 'Tesco paper vouchers - click to edit' },
    $('span', { style: 'font-family:"Space Grotesk",sans-serif;' }, 'Vouchers '),
    $('span', { class: 'display-num', style: `font-size:16px;color:${over ? 'var(--negative)' : 'var(--muted)'};` }, fmt(amount)),
  );
  wrapper.addEventListener('click', () => openVoucherEditor());
  return wrapper;
}

// ---------- modal: manage all recurring ----------
// The dashboard card only lists rules whose next occurrence falls within the
// current month; this modal lists every rule regardless of when it is next
// due, sorted by next occurrence, with edit/remove/new in one place.
// ---------- modal: payment methods ----------
// Add, remove and restore the methods every picker offers. Two rules make this
// safe to use freely, and both exist because the alternative loses money data:
//   1. A built-in cannot be deleted, only hidden. The Balances screen keys a
//      row, a checkpoint series and the account math to 'AIB'/'Revolut'/'RS',
//      the gift-card totals to 'TG'/'LG'/'AG' and the budget filters to 'RS',
//      so removing one would leave those features pointing at nothing.
//   2. Removing anything is a tombstone (settings.methodHidden), never a
//      deletion. validateEntry DROPS an entry whose method storage.js does not
//      know, so a delete that really removed the id would delete that entry the
//      next time the document loaded — and the list a cloud merge unions by id
//      would resurrect it anyway. A tombstone keeps the id valid, keeps history
//      named, and travels both ways (see storage.js / sync-merge.js).
function openMethodManager() {
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Payment methods', tabindex: '-1', style: 'max-width:520px;display:flex;flex-direction:column;max-height:88vh;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  // How many records name each method — entries, plus a recurring bill, which
  // names one too and would lose its selection if the method went away. This is
  // what the row uses to say whether removing it touches anything.
  const usage = new Map();
  const bump = (id) => usage.set(id, (usage.get(id) || 0) + 1);
  for (const entry of state.entries) bump(entry.method);
  for (const rec of (state.settings.recurring || [])) bump(rec.method);
  const usageText = (id) => {
    const n = usage.get(id) || 0;
    return n === 0 ? 'not used yet' : `used by ${n} record${n === 1 ? '' : 's'}`;
  };
  const isBase = (id) => METHODS.some(m => m.id === id);
  const isRemoved = (id) => (state.settings.methodHidden || {})[id] === true;

  const nameInput = $('input', { type: 'text', placeholder: 'e.g. Credit Union, Apple Pay', 'aria-label': 'New method name', autocomplete: 'off', maxlength: '40', style: 'flex:1;min-width:0;' });
  const addError = $('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;min-height:14px;' }, '');
  function addMethod() {
    const raw = nameInput.value.trim();
    if (!raw) { addError.textContent = 'Enter a name for the method.'; nameInput.focus(); return; }
    if (everyMethod().some(m => m.label.toLowerCase() === raw.toLowerCase())) {
      addError.textContent = 'That method already exists.';
      nameInput.focus();
      return;
    }
    addError.textContent = '';
    let id = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'method';
    if (everyMethod().some(m => m.id.toLowerCase() === id.toLowerCase())) id = `${id}-${uid().slice(-3)}`;
    if (!state.settings.customMethods) state.settings.customMethods = [];
    state.settings.customMethods.push({ id, label: raw });
    // Offered immediately: a name the user just typed is not something a stale
    // flag for the same slug gets to keep out of the pickers. Written as an
    // explicit false for the reason setRemoved() gives.
    if (state.settings.methodHidden?.[id]) {
      state.settings.methodHidden = { ...state.settings.methodHidden, [id]: false };
    }
    updateAllowedMethods(everyMethod().map(m => m.id));
    trackAction(() => { state.settings.customMethods = state.settings.customMethods.filter(m => m.id !== id); persist(); }, `Added method "${raw}"`);
    persist();
    nameInput.value = '';
    toast(`Added method "${raw}".`);
    refresh();
  }
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addMethod(); }
  });

  function setRemoved(id, removed) {
    const before = { ...(state.settings.methodHidden || {}) };
    // `false`, never a deleted key: the cloud merge is a per-key spread, which
    // can overwrite a key but cannot remove one, so a restore written as an
    // absence would lose to the other device's `true` on every sync and the
    // method would come back hidden on its own (see normalizeMethodHidden).
    state.settings.methodHidden = { ...before, [id]: removed };
    // Nothing about which ids are VALID changes here (a removed method stays
    // valid so its history survives), but a stale id in the allowed set is the
    // one way storage.js could accept something it should not.
    updateAllowedMethods(everyMethod().map(m => m.id));
    persist();
    refresh();
    return before;
  }

  const rowFor = (method) => {
    const removed = isRemoved(method.id);
    const n = usage.get(method.id) || 0;
    const verb = removed ? 'Restore' : (isBase(method.id) ? 'Hide' : 'Delete');
    return $('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background-color:color-mix(in srgb, var(--card) 92%, transparent);' },
      $('div', { style: `min-width:0;flex:1;${removed ? 'opacity:0.6;' : ''}` },
        $('div', { style: 'font-size:13px;font-weight:500;line-height:1.35;overflow-wrap:anywhere;' }, method.label),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:2px;overflow-wrap:anywhere;' },
          `${isBase(method.id) ? 'Built-in' : 'Your own'} · ${usageText(method.id)}`),
      ),
      $('button', { type: 'button', class: 'btn-link', 'aria-label': `${verb} ${method.label}`, style: `font-size:12px;min-height:32px;flex-shrink:0;${removed || isBase(method.id) ? '' : 'color:var(--negative);'}`, onClick: () => {
        const before = setRemoved(method.id, !removed);
        if (removed) {
          trackAction(() => { state.settings.methodHidden = before; persist(); }, `Restored method "${method.label}"`);
          toast(`Restored "${method.label}".`);
        } else {
          trackAction(() => { state.settings.methodHidden = before; persist(); }, `Removed method "${method.label}"`);
          // Say what a delete of a used method actually does, at the moment it
          // is asked for: the records keep it, only the pickers lose it.
          toast(n === 0 ? `Deleted "${method.label}".`
            : `Removed "${method.label}" from the pickers — ${n} record${n === 1 ? '' : 's'} still name it.`);
        }
      } }, verb));
  };

  const listEl = $('div', { style: 'overflow-y:auto;flex:1;min-height:0;margin:0 -4px;padding:0 4px;display:flex;flex-direction:column;gap:8px;' });
  const refresh = () => {
    listEl.textContent = '';
    const offered = everyMethod().filter(m => !isRemoved(m.id));
    const removed = everyMethod().filter(m => isRemoved(m.id));
    for (const method of offered) listEl.appendChild(rowFor(method));
    if (removed.length) {
      listEl.appendChild($('div', { class: 'eyebrow', style: 'margin-top:10px;' }, 'Removed from the pickers'));
      for (const method of removed) listEl.appendChild(rowFor(method));
    }
    // Keep the page beneath the modal in step: the pickers it just changed are
    // re-rendered by close(), but the undo chip is drawn now.
    const fabHost = document.querySelector('main');
    const oldFab = fabHost ? fabHost.querySelector('.undo-fab') : null;
    const newFab = renderUndoFab();
    if (newFab) { if (oldFab) oldFab.replaceWith(newFab); else if (fabHost) fabHost.appendChild(newFab); }
    else if (oldFab) oldFab.remove();
  };

  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;' },
      $('div', null,
        $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:24px;margin:0;' }, 'Payment methods'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;line-height:1.45;' },
          'What the entry form offers. Removing one only takes it out of the pickers — records you already saved keep it.'),
      ),
      $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
    ),
    $('div', { style: 'display:flex;gap:8px;align-items:center;' }, nameInput,
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'flex-shrink:0;', onClick: addMethod }, 'Add')),
    addError,
    listEl,
  );
  refresh();
  // The add field is the reason this modal is opened; focus it so a method can
  // be typed without a second tap.
  queueMicrotask(() => { if (nameInput.isConnected) nameInput.focus(); });
}

function openRecurringManager() {
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Manage recurring transactions', tabindex: '-1', style: 'max-width:560px;display:flex;flex-direction:column;max-height:88vh;' });
  // Re-render the list whenever any nested editor modal closes, so edits/adds
  // made through the manager are reflected immediately.
  const refreshManager = () => refresh();
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const listEl = $('div', { style: 'overflow-y:auto;flex:1;min-height:0;margin:0 -4px;padding:0 4px;' });
  const emptyState = () => $('div', { class: 'muted', style: 'font-size:13px;padding:24px 4px;text-align:center;' },
    'No recurring transactions yet. Add rent, subscriptions, or paydays.',
  );

  const freqLabel = (r) => frequencyLabel(r.frequency, r.dayOfMonth);
  const rowFor = (r) => {
    const d = daysUntil(r.nextDate);
    const overdue = d < 0;
    const dueSoon = !overdue && d <= 7;
    const narrow = isNarrow();
    return $('div', { style: `display:flex;flex-direction:${narrow ? 'column' : 'row'};align-items:${narrow ? 'stretch' : 'center'};justify-content:space-between;gap:${narrow ? '12px' : '10px'};padding:${narrow ? '14px' : '12px 14px'};border:1px solid var(--line);border-radius:10px;margin-bottom:${narrow ? '10px' : '8px'};background-color:color-mix(in srgb, var(--card) 92%, transparent);` },
      $('div', { style: `display:flex;align-items:${narrow ? 'flex-start' : 'center'};gap:${narrow ? '8px' : '4px'};min-width:0;flex:1;` },
        $('span', { style: `display:inline-block;width:7px;height:7px;border-radius:50%;background:${overdue ? 'var(--negative)' : dueSoon ? 'var(--accent)' : 'var(--muted)'};flex-shrink:0;margin-top:${narrow ? '6px' : '0'};` }),
        $('div', { style: 'min-width:0;flex:1;' },
          $('div', { style: `font-weight:500;font-size:${narrow ? '14px' : '13px'};line-height:1.35;${narrow ? '' : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'}` }, r.details),
          $('div', { class: 'muted', style: `font-size:11px;margin-top:${narrow ? '4px' : '2px'};line-height:1.45;${narrow ? '' : 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'}` },
            `${r.method} · ${freqLabel(r)} · next ${friendlyDate(r.nextDate)}${overdue ? ` (${Math.abs(d)}d overdue)` : d === 0 ? ' (today)' : dueSoon ? ` (in ${d}d)` : ''}`,
          ),
        ),
      ),
      $('div', { style: `display:flex;align-items:center;gap:8px;flex-shrink:0;${narrow ? 'padding-left:15px;' : ''}` },
        $('span', { class: 'display-num', style: `font-size:${narrow ? '15px' : '13px'};color:${r.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};${narrow ? 'flex:1 1 auto;text-align:left;' : ''}` }, (r.type === 'credit' ? '+' : '') + fmt(r.amount)),
        $('button', { type: 'button', 'aria-label': `Edit ${r.details}`, title: 'Edit', style: `width:${narrow ? '34px' : '28px'};height:${narrow ? '34px' : '28px'};border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;`, onClick: (ev) => { ev.stopPropagation(); openNewRecurring(r, refreshManager); } }, iconSpan('pencil', 'sm')),
        $('button', { type: 'button', 'aria-label': `Remove ${r.details}`, title: 'Remove', style: `width:${narrow ? '34px' : '28px'};height:${narrow ? '34px' : '28px'};border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:${narrow ? '17px' : '15px'};line-height:1;flex-shrink:0;`, onClick: (ev) => {
          ev.stopPropagation();
          const removed = state.settings.recurring.filter(x => x.id === r.id);
          state.settings.recurring = state.settings.recurring.filter(x => x.id !== r.id);
          trackAction(() => { state.settings.recurring.push(...removed); persist(); }, `Removed recurring "${r.details}"`);
          persist(); toast(`Removed recurring "${r.details}".`);
          refresh();
        } }, '×'),
      ),
    );
  };

  const refresh = () => {
    const list = [...(state.settings.recurring || [])].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
    listEl.textContent = '';
    if (list.length === 0) listEl.appendChild(emptyState());
    else for (const r of list) listEl.appendChild(rowFor(r));
    countEl.textContent = String(list.length);
    // Keep the persistent undo button in sync on the page beneath the modal
    // (remove/edit here update the undo slot without a full re-render).
    const fabHost = document.querySelector('main');
    const oldFab = fabHost ? fabHost.querySelector('.undo-fab') : null;
    const newFab = renderUndoFab();
    if (newFab) { if (oldFab) oldFab.replaceWith(newFab); else if (fabHost) fabHost.appendChild(newFab); }
    else if (oldFab) oldFab.remove();
  };

  const countEl = $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;flex-shrink:0;' });

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-shrink:0;' },
    $('div', { style: 'display:flex;align-items:center;gap:10px;' },
      $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, 'Recurring'),
      countEl,
    ),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild(listEl);
  modal.appendChild($('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);flex-shrink:0;' },
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => { openNewRecurring(null, refreshManager); } }, '+ New recurring'),
  ));

  refresh();
  queueMicrotask(() => modal.focus());
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ---------- modal: new recurring ----------
function openNewRecurring(existing = null, onClosed = null) {
  const data = existing
    ? { type: existing.type, details: existing.details, amount: String(existing.amount), method: existing.method, category: existing.category, frequency: existing.frequency, dayOfMonth: existing.dayOfMonth, note: existing.note || '' }
    : { type: 'expense', details: '', amount: '', method: 'AIB', category: 'gro', frequency: 'monthly', dayOfMonth: 1, note: '' };

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': existing ? 'Edit recurring transaction' : 'New recurring transaction', tabindex: '-1', style: 'max-width:480px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); if (onClosed) onClosed(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
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
  // data-glide turns these into GlideSelect chips; the <select> is still the
  // control the sheet reads, which is why its onChange above stays untouched.
  const methodSel = $('select', { 'aria-label': 'Method', 'data-glide': true, 'data-glide-menu-width': '240', onChange: (e) => data.method = e.target.value },
    ...methodPickerIds(data.method).map(id => $('option', { value: id }, methodLabel(id))),
  );
  const catSel = $('select', { 'aria-label': 'Category', 'data-glide': true, 'data-glide-menu-width': '240', onChange: (e) => data.category = e.target.value },
    ...allCategories().map(c => $('option', { value: c.id }, c.label)),
  );
  const catRow = $('div', { style: 'margin-bottom:14px;' },
    $('label', { class: 'eyebrow', style: 'display:block;margin-bottom:4px;' }, 'Category'),
    catSel,
  );
  const freqSel = $('select', { 'aria-label': 'Frequency', 'data-glide': true, 'data-glide-menu-width': '180', onChange: (e) => { data.frequency = e.target.value; dayLabel.textContent = freqDayLabel(e.target.value); } },
    $('option', { value: 'monthly', selected: '' }, 'Monthly'),
    $('option', { value: 'weekly' }, 'Weekly'),
    $('option', { value: 'fortnightly' }, 'Fortnightly'),
    $('option', { value: 'yearly' }, 'Yearly'),
    $('option', { value: 'daily' }, 'Daily'),
  );
  // Month-anchored schedules land ON a day of the month; day-anchored ones
  // start on a day and then step. The row stays for both — a daily bill still
  // needs to know which day its run starts from — but it says which it means.
  const freqDayLabel = (freq) => (freq === 'monthly' || freq === 'yearly') ? 'Day of month' : 'Start day';
  const dayLabel = $('span', null, 'Day of month');
  const daySel = $('select', { 'aria-label': 'Day', 'data-glide': true, 'data-glide-menu-width': '120', onChange: (e) => data.dayOfMonth = +e.target.value },
    ...Array.from({ length: 31 }, (_, i) => $('option', { value: i + 1 }, String(i + 1))),
  );
  const noteInput = $('input', { type: 'text', placeholder: 'optional', 'aria-label': 'Note', onInput: (e) => data.note = e.target.value });

  // Prefill for edit mode
  if (existing) {
    amtInput.value = data.amount;
    descInput.value = data.details;
    methodSel.value = data.method;
    catSel.value = data.category;
    freqSel.value = data.frequency;
    daySel.value = String(data.dayOfMonth);
    noteInput.value = data.note || '';
    dayLabel.textContent = freqDayLabel(data.frequency);
    catRow.style.display = data.type === 'credit' ? 'none' : '';
  }

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, existing ? 'Edit recurring' : 'New recurring'),
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
        id: existing?.id || 'rec_' + uid(),
        type: data.type,
        details: data.details.trim(),
        amount: amt,
        method: data.method,
        category: data.category,
        frequency: data.frequency,
        dayOfMonth: data.dayOfMonth,
        nextDate: (existing && existing.frequency === data.frequency && existing.dayOfMonth === data.dayOfMonth)
          ? existing.nextDate
          : computeInitialNextDate(data.frequency, data.dayOfMonth),
        note: data.note?.trim() || '',
      };
      if (!state.settings.recurring) state.settings.recurring = [];
      if (existing) {
        const idx = state.settings.recurring.findIndex(r => r.id === existing.id);
        if (idx === -1) { toast('That recurring item no longer exists.'); close(); return; }
        const prev = { ...state.settings.recurring[idx] };
        state.settings.recurring[idx] = rec;
        trackAction(() => {
          state.settings.recurring = state.settings.recurring.map(r => r.id === existing.id ? prev : r);
          persist();
        }, `Edited recurring "${rec.details}"`);
        persist();
        toast(`Recurring "${rec.details}" updated.`);
      } else {
        state.settings.recurring.push(rec);
        trackAction(() => {
          state.settings.recurring = state.settings.recurring.filter(r => r.id !== rec.id);
          persist();
        }, `Removed recurring "${rec.details}"`);
        persist();
        toast(`Recurring "${rec.details}" added - next: ${friendlyDate(rec.nextDate)}`);
      }
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
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const totalEl = $('span', { class: 'display-num', style: 'font-size:22px;' }, fmt(computeCashTotal(coins)));
  // The one repaint for the whole breakdown: every row's count and subtotal, the
  // total, and whether there is anything left for Clear all to clear. Three
  // places used to be refreshed ad hoc (each row updated the total itself), so a
  // control that moves every row at once had nowhere to say so.
  const rowRefreshers = [];
  const repaint = () => {
    for (const fn of rowRefreshers) fn();
    totalEl.textContent = fmt(computeCashTotal(coins));
    clearAll.disabled = COINS.every(c => !coins[String(c.val)]);
  };
  const rows = COINS.map(c => {
    const key = String(c.val);
    const countEl = $('span', { style: 'min-width:24px;text-align:center;font-weight:500;' }, String(coins[key]));
    // Per-row subtotal must live in a node we can refresh - computing it once
    // at render froze every row at €0.00 while only the total updated.
    const subEl = $('span', { class: 'muted', style: 'font-size:12px;width:55px;text-align:right;' }, fmt(coins[key] * c.val));
    rowRefreshers.push(() => {
      countEl.textContent = String(coins[key]);
      subEl.textContent = fmt(coins[key] * c.val);
    });
    const decr = $('button', { type: 'button', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center;', 'aria-label': `One fewer ${c.label}`, onClick: () => {
      if (coins[key] > 0) { coins[key]--; repaint(); }
    } }, '−');
    const incr = $('button', { type: 'button', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center;', 'aria-label': `One more ${c.label}`, onClick: () => {
      coins[key]++; repaint();
    } }, '+');
    return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);' },
      $('span', { style: 'font-size:14px;font-weight:500;width:50px;' }, c.label),
      $('div', { style: 'display:flex;align-items:center;gap:10px;' }, decr, countEl, incr),
      subEl,
    );
  });

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, 'Cash breakdown'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  const coinList = $('div', { style: 'display:flex;flex-direction:column;margin-bottom:12px;' }, ...rows);
  modal.appendChild(coinList);
  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid var(--line);' },
    $('span', { class: 'eyebrow' }, 'Total'),
    totalEl,
  ));
  // Clearing every count is a draft action like the steppers: it moves the rows
  // and the total, and Save is still what writes a zero to the document. "Clear"
  // rather than "Reset", because a reset could be read as restoring a count.
  const clearAll = $('button', { type: 'button', class: 'btn btn-ghost', style: 'margin-right:auto;', 'aria-label': 'Clear every coin count', onClick: () => {
    // Disabling it once the last count goes is the honest state (there is
    // nothing left to clear), but a focused button that becomes disabled drops
    // the caret to the document — the keyboard's next Tab would restart from
    // the top of the modal. So the coin list takes the focus instead.
    const hadFocus = document.activeElement === clearAll;
    for (const c of COINS) coins[String(c.val)] = 0;
    repaint();
    if (hadFocus) coinList.querySelector('button')?.focus();
  } }, 'Clear all');
  repaint();

  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:18px;' },
    clearAll,
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const total = computeCashTotal(coins);
      // What the document said before this count. A count is a guess about cash
      // on hand, and Clear all is one tap away from wiping it — so the save is
      // taken back from the toast that confirms it, which is the moment the user
      // sees the figure the hero now reads.
      const before = {
        coins: { ...(state.settings.coins || {}) },
        cashBase: state.settings.cashBase,
        coinsManual: state.settings.coinsManual,
      };
      const beforeCounts = { ...COINS_DEFAULT, ...before.coins };
      const countsChanged = COINS.some(c =>
        (Number(coins[String(c.val)]) || 0) !== (Number(beforeCounts[String(c.val)]) || 0));
      state.settings.coins = { ...coins };
      // Reconcile: pin the stored cash base so the home cash balance equals the
      // freshly counted coins, and stop auto-redistributing until the next cash
      // payment (which hands the calculator back control).
      state.settings.cashBase = Math.round((total - sumCashDeltas()) * 100) / 100;
      state.settings.coinsManual = true;
      persist();
      const undo = () => {
        state.settings.coins = { ...before.coins };
        state.settings.cashBase = before.cashBase;
        state.settings.coinsManual = before.coinsManual;
        persist();
        render();
      };
      // No Undo on a save that changed no count — a button that puts back what is
      // already there is noise on a toast that is only saying "saved".
      if (countsChanged) toast('Cash counts saved.', undo, 'Undo');
      else toast('Cash counts saved.');
      close();
    } }, 'Save'),
  ));

  queueMicrotask(() => modal.querySelector('button')?.focus());
}

// ---------- modal: Tesco paper vouchers ----------
// An amount editor (editable input + ±€1 steppers - paper vouchers carry a
// euro value). Saving never touches any balance; the only side effect is a
// toast when the amount crosses above VOUCHER_NOTICE_AT.
function openVoucherEditor() {
  let amount = voucherAmount();

  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tesco paper vouchers', tabindex: '-1', style: 'max-width:420px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const input = $('input', { type: 'text', inputmode: 'decimal', value: amount ? amount.toFixed(2) : '', 'aria-label': 'Voucher amount in euros', autocomplete: 'off', style: 'width:110px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:16px;text-align:center;padding:8px 10px;transition:border-color .15s;', onFocus: (e) => e.target.select(), onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
  const warnEl = $('div', { style: 'font-size:12px;color:var(--negative);text-align:center;', hidden: amount <= VOUCHER_NOTICE_AT }, `You have ${fmt(amount)} of vouchers - that's above the ${fmt(VOUCHER_NOTICE_AT)} limit.`);
  const refresh = () => {
    warnEl.hidden = amount <= VOUCHER_NOTICE_AT;
    warnEl.textContent = `You have ${fmt(amount)} of vouchers - that's above the ${fmt(VOUCHER_NOTICE_AT)} limit.`;
  };
  const step = (delta) => {
    const prev = amount;
    amount = Math.max(0, Math.round((amount + delta) * 100) / 100);
    input.value = amount ? amount.toFixed(2) : '';
    refresh();
    // Notify the moment the amount crosses above the threshold.
    if (prev <= VOUCHER_NOTICE_AT && amount > VOUCHER_NOTICE_AT) {
      toast(`Heads up: you now have ${fmt(amount)} of Tesco paper vouchers.`);
    }
  };
  const decr = $('button', { type: 'button', style: 'width:36px;height:36px;border:1px solid var(--line);border-radius:8px;background:transparent;cursor:pointer;font-size:16px;display:inline-flex;align-items:center;justify-content:center;', 'aria-label': 'Less voucher value', onClick: () => step(-1) }, '−');
  const incr = $('button', { type: 'button', style: 'width:36px;height:36px;border:1px solid var(--line);border-radius:8px;background:transparent;cursor:pointer;font-size:16px;display:inline-flex;align-items:center;justify-content:center;', 'aria-label': 'More voucher value', onClick: () => step(1) }, '+');

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, 'Tesco paper vouchers'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild($('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-bottom:12px;' },
    $('div', { class: 'muted', style: 'font-size:12px;line-height:1.5;' }, 'Total euro value of paper vouchers on hand. This is only a reminder - it never affects your balance.'),
    $('div', { style: 'display:flex;align-items:center;justify-content:center;gap:14px;padding:16px 0;' }, decr, input, incr),
    warnEl,
  ));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const parsed = Math.round(Number(input.value) * 100) / 100;
      if (!Number.isFinite(parsed) || parsed < 0) { toast('Enter a non-negative amount.'); return; }
      state.settings.tescoVouchers = parsed;
      persist();
      toast('Tesco voucher amount saved.');
      close();
    } }, 'Save'),
  ));

  queueMicrotask(() => input.focus());
}

// Every entry that leaves the Add screen goes through here, and so does every
// line the bank statement import writes — a writer that did not choose its own
// entries gets exactly the duplicate gate, undo slot and tombstones a hand
// entry gets. The slot
// removes exactly the legs that were created and tombstones them, so a later
// cloud merge can't restore them. cashAutoFollow may re-anchor the cash base
// while adding, so its previous values ride along. No journal: undoing an
// addition is a live-session action, and a reload already has the entries.
const commitAdded = (entries, label, onDone) => {
  const commit = () => {
    const prevCashBase = state.settings.cashBase;
    const prevCoinsManual = state.settings.coinsManual;
    state.entries.push(...entries);
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    if (entries.some(e => e.method === 'Cash')) cashAutoFollow(entries.reduce((sum, e) => sum + cashDeltaOf(e), 0));
    const ids = entries.map(e => e.id);
    trackAction(() => {
      state.entries = state.entries.filter(e => !ids.includes(e.id));
      tombstoneIds(ids);
      state.settings.cashBase = prevCashBase;
      state.settings.coinsManual = prevCoinsManual;
      persist();
    }, label);
    persist();
    if (onDone) onDone();
  };
  // ONE check for every way onto the ledger — quick entry, split legs,
  // transfers, the structured form, and the bank import — so a duplicate
  // cannot slip in simply because a different button created it. Cancel leaves
  // nothing written (the commit has not started), and the confirm runs before
  // the caller's toast/navigation through onDone.
  const hit = entries.map(e => [e, findPotentialDuplicate(e)]).find(([, dup]) => dup);
  if (hit) openDuplicateConfirm(hit[0], hit[1], commit);
  else commit();
};

// ---------- the bank's own CSV ----------
// Deferred like every screen: the mapping rules, the preview and the mapper UI
// are ~15 KB that a boot which may only show the lock should never parse. The
// modal opens first and asks for the file from inside it, because a page can
// neither see nor dismiss the OS file dialog — which is also what makes this
// surface auditable (it is declared in a11y-harness.html's MODAL_OPENERS).
async function openBankImport() {
  try {
    const mod = await import('./bank-import.js');
    mod.openBankImport({
      $, iconSpan, toast, fmt, friendlyDate, swalConfirm, isTopModal,
      methods: allMethods().map(m => ({ id: m.id, label: m.label })),
      guessCategory: categoryFromDescription,
      uid, nowIso, commitAdded, render,
      existingEntries: () => state.entries,
    });
  } catch (err) {
    console.warn('Bank statement import could not be loaded:', err);
    toast('The bank statement importer could not be loaded.');
  }
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
  ));

  if (state.entries.length === 0) {
    c.appendChild($('div', { class: 'card', style: 'max-width:540px;margin:0 auto 20px;padding:20px 16px;text-align:center;' },
      $('div', { class: 'serif', style: 'font-size:19px;' }, 'You’re starting fresh.'),
      $('div', { class: 'muted', style: 'font-size:12px;margin-top:4px;' }, 'Every tracker begins with one entry. Add your first one below - the quick field understands plain English.'),
    ));
  }

  // Natural-language and structured voice entry. The preview is a live parse:
  // a gentle on-ramp hint when empty, the parser's guidance when it can't find
  // an amount, and the fully resolved entry the moment it can.
  const quickPreview = $('div', { class: 'muted', style: 'font-size:12px;min-height:18px;margin-bottom:10px;' });
  // Live detection chips - each part of the grammar lights up the moment the
  // parser resolves it, so the input teaches itself as you type.
  const detectRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;' });
  const detectParts = ['Amount', 'Category', 'Account', 'Date'].map(name => {
    const el = $('span', { class: 'quick-detect-chip', 'aria-hidden': 'true', style: 'display:inline-flex;align-items:center;gap:5px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted);transition:border-color .15s,color .15s,background .15s;' }, name);
    detectRow.append(el);
    return { name, el };
  });
  const syncDetectChips = (parsed) => {
    const ok = {
      Amount: !!(parsed && Number.isFinite(parsed.amount) && parsed.amount > 0),
      Category: !!(parsed && parsed.category),
      Account: !!(parsed && parsed.method),
      Date: !!(parsed && parsed.date),
    };
    for (const d of detectParts) {
      const good = ok[d.name];
      d.el.style.color = good ? 'var(--accent)' : 'var(--muted)';
      d.el.style.borderColor = good ? 'var(--accent)' : 'var(--line)';
      d.el.style.background = good ? 'var(--accent-soft)' : 'transparent';
      d.el.innerHTML = '';
      d.el.append(good ? iconSpan('check-circle', 'sm') : $('span', { 'aria-hidden': 'true', style: 'font-size:9px;line-height:1;' }, '·'), $('span', {}, ' ' + d.name));
    }
  };
  const renderQuickPreview = (text) => {
    const parsed = parseNaturalLanguage(text);
    if (!String(text || '').trim()) {
      quickPreview.textContent = 'Start with an amount - the preview fills in as you type.';
      quickPreview.style.color = '';
      syncDetectChips(null);
      return;
    }
    if (parsed?.error) {
      quickPreview.textContent = parsed.error;
      quickPreview.style.color = 'var(--negative)';
      syncDetectChips(null);
      return;
    }
    quickPreview.style.color = '';
    syncDetectChips(parsed);
    quickPreview.textContent = parsed
      ? (parsed.type === 'transfer'
        ? `Transfer · ${methodShort(parsed.transfer.from)} → ${methodShort(parsed.transfer.to)} · ${fmt(parsed.amount)} · ${parsed.details} · ${friendlyDate(parsed.date)}`
        : (parsed.split && parsed.split.length >= 2
          ? `${parsed.type === 'credit' ? 'Income' : 'Expense'} · ${fmt(parsed.amount)} · ${parsed.details} · ${categoryLabel(parsed.category)} · split ${parsed.split.map(s => `${fmt(s.amount)} ${methodShort(s.method)}`).join(' + ')} · ${friendlyDate(parsed.date)}`
          : `${parsed.type === 'credit' ? 'Income' : 'Expense'} · ${fmt(parsed.amount)} · ${parsed.details} · ${categoryLabel(parsed.category)} · ${methodShort(parsed.method)} · ${friendlyDate(parsed.date)}`))
      : '';
  };
  const quickInput = $('textarea', { id: 'f-quick', placeholder: 'Try: Spent €18.50 at Tesco from Revolut yesterday', 'aria-label': 'Natural-language entry', rows: '2', style: 'width:100%;font-size:13px;margin-bottom:8px;', onInput: (e) => renderQuickPreview(e.target.value) });
  const quickExamples = [
    { label: 'coffee 3.50 cash', hint: 'paid in cash' },
    { label: 'groceries 24: 10 cash, 14 revolut', hint: 'split payment' },
    { label: 'tesco shop 6: 2 aldi, 4 revolut', hint: 'split across a gift card and an account' },
    { label: 'tesco load 20 from revolut', hint: 'top up a gift card' },
    { label: 'rent 850 from AIB', hint: 'a bill from an account' },
  ];

  const quickChips = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;' },
    ...quickExamples.map(ex => $('button', { type: 'button', class: 'quick-chip', 'aria-label': `Example: ${ex.label} (${ex.hint})`, onClick: () => {
      quickInput.value = ex.label;
      renderQuickPreview(quickInput.value);
      quickInput.focus();
    } }, ex.label)),
  );
  // A line shared into the app (share_target) lands here, once: the screen may
  // not have existed when it arrived (the app can be locked at that point), and
  // `pendingShare` is cleared as it is consumed so no re-render can prefill it
  // twice. Nothing is stored — the preview names what the line will become and
  // the user still presses Add.
  if (pendingShare) {
    const shared = pendingShare;
    pendingShare = null;
    quickInput.value = shared;
    renderQuickPreview(shared);
    queueMicrotask(() => { if (quickInput.isConnected) quickInput.focus(); });
    toast('Shared into the quick entry — check the preview, then Add.');
  }
  const addQuick = () => {
    const parsed = parseNaturalLanguage(quickInput.value);
    if (!parsed || parsed.error) { toast(parsed?.error || 'Describe an entry first.'); quickInput.focus(); return; }
    const legs = quickEntryLegs(parsed);
    const isTransfer = parsed.type === 'transfer';
    const isSplit = legs.length > 1 && !isTransfer;
    const single = legs.length === 1 ? legs[0] : null;
    if (single?.method === 'Cash') cashAutoFollow();
    const label = isTransfer ? `${parsed.details} transfer`
      : isSplit ? `${parsed.details} split payment`
      : (single.details || 'entry');
    commitAdded(legs, label, () => {
      toast(isTransfer ? 'Gift card loaded - transfer created from your description.'
        : isSplit ? 'Split payment created from your description.'
        : 'Entry created from your description.');
      location.hash = '#dashboard';
    });
  };
  const restoreVoiceLabel = () => { voiceInputBtn.textContent = ''; voiceInputBtn.append(iconSpan('mic', 'sm'), ' Voice'); };
  const voiceInputBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:12px;', onClick: () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { toast('Voice input is not supported in this browser.'); return; }
    const recognition = new Recognition();
    recognition.lang = 'en-IE'; recognition.interimResults = false; recognition.maxAlternatives = 1;
    voiceInputBtn.textContent = 'Listening…'; voiceInputBtn.disabled = true;
    recognition.onresult = ev => { quickInput.value = ev.results[0][0].transcript; quickInput.dispatchEvent(new Event('input')); };
    recognition.onerror = () => toast('Could not hear that. Try again.');
    recognition.onend = () => { restoreVoiceLabel(); voiceInputBtn.disabled = false; };
    recognition.start();
  } }, iconSpan('mic', 'sm'), ' Voice');
  const quickCard = $('div', { class: 'card', style: `max-width:540px;margin:0 auto 20px;padding:${isNarrow() ? '18px 16px' : '22px 16px'};` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:6px;' }, 'Quick entry'),
    $('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px;' }, 'Describe it naturally, check the preview, then add it.'),
    quickChips,
    quickInput,
    detectRow,
    quickPreview,
    $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;' }, voiceInputBtn, $('button', { type: 'button', class: 'btn btn-primary', style: 'font-size:12px;', onClick: addQuick }, 'Add entry')),
  );
  // The screen the route focuses while the structured form is folded away.
  quickCard.dataset.routeInitialFocus = 'true';
  quickCard.dataset.firstFocus = 'f-quick';
  c.appendChild(quickCard);

  const form = formView({
    onSubmit: (entryOrEntries) => {
      const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
      const label = entries.length > 1 ? `${entries.length} entries` : (entries[0].details || 'entry');
      commitAdded(entries, label, () => {
        toast(entries.length > 1 ? `Saved ${entries.length} entries.` : 'Saved.');
        location.hash = '#dashboard';
      });
    },
  });
  // Two full forms stacked made #add read as two screens. Quick entry is the
  // surface; the structured form is the same component, one tap down, folded
  // out of the tab order and out of the audit until it is asked for. Nothing
  // is discarded on the way - the fold only hides it.
  const structured = $('div', { id: 'add-structured', style: 'display:none;' }, form);
  const moreBtn = $('button', {
    type: 'button', class: 'btn btn-ghost',
    style: 'display:block;max-width:540px;width:100%;margin:0 auto 20px;font-size:12px;',
    'aria-expanded': 'false', 'aria-controls': 'add-structured',
    onClick: () => {
      const open = structured.style.display !== 'none';
      structured.style.display = open ? 'none' : '';
      moreBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
      moreBtn.textContent = open ? 'More options' : 'Fewer options';
      if (!open) {
        const first = form.querySelector(`#${form.dataset.firstFocus || 'f-amount'}`);
        if (first) first.focus({ preventScroll: true });
      }
    },
  }, 'More options');
  c.appendChild(moreBtn);
  c.appendChild(structured);
  return c;
}

// ---------- screens: history ----------
function screenHistory() {
  if (state.entries.length === 0) {
    const emptyC = $('section', { class: 'page-section', 'aria-label': 'History' });
    emptyC.appendChild($('div', { class: 'page-title-row' }, $('h1', { class: 'page-title' }, 'History')));
    emptyC.appendChild(emptyStateCard({ icon: 'receipt', title: 'Nothing logged yet', blurb: 'Your history will appear here as you track expenses and income.', actionLabel: 'Add your first entry', actionHref: '#add' }));
    return emptyC;
  }
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  let activeMonth = params.get('month') || monthKey(today());
  let activeDay = params.get('day') || null;
  if (activeDay && !/^\d{4}-\d{2}-\d{2}$/.test(activeDay)) activeDay = null;
  let activeCat = params.get('cat') || 'all';
  let activeMethod = params.get('method') || 'all';
  let searchQuery = params.get('q') || '';
  // Type, order and an arbitrary date range live in the hash on the same
  // terms as month/day/cat: a link carries them and the back gesture undoes
  // them. The type value is checked against the four types the ledger holds,
  // and the range is only a range when BOTH ends are real dates — normalised
  // here (from <= to) rather than in the filter, where a reversed pair would
  // silently mean "nothing matches".
  const TYPE_FILTERS = ['all', 'expense', 'credit', 'transfer', 'note'];
  const activeType = TYPE_FILTERS.includes(params.get('type')) ? params.get('type') : 'all';
  const orderAsc = params.get('order') === 'asc';
  const dateKeyOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  let rangeFrom = params.get('from') || '';
  let rangeTo = params.get('to') || '';
  if (!dateKeyOk(rangeFrom) || !dateKeyOk(rangeTo)) { rangeFrom = ''; rangeTo = ''; }
  else if (rangeFrom > rangeTo) { const swap = rangeFrom; rangeFrom = rangeTo; rangeTo = swap; }
  const inRange = !!rangeFrom;

  const months = Array.from(new Set(state.entries.map(e => monthKey(e.date))))
    .sort((a, b) => b.localeCompare(a));
  // A stale URL month falls back to the newest month with entries, but the
  // current month is always honoured even when it's still empty ("Jump").
  if (!months.includes(activeMonth) && months.length && activeMonth !== monthKey(today())) activeMonth = months[0];

  const monthEntries = entriesForMonth(activeMonth);
  // The frame the pills count and the sum reads: the month, or the whole
  // custom range once both ends are set. A range REPLACES the month — the
  // calendar and month nav step aside — so the screen never has two frames
  // at once and every count answers "of what I'm looking at".
  const rangeEntries = inRange ? state.entries.filter(e => e.date >= rangeFrom && e.date <= rangeTo) : null;
  const frameEntries = inRange ? rangeEntries : monthEntries;
  const activeMethodGroup = accountGroupForKey(activeMethod);
  // With a query the search reads ALL entries, not just the visible frame: a
  // query while sitting on the wrong month used to find nothing. The frame
  // stays the frame (title, calendar, expense sum); only the results widen.
  const searchScope = searchQuery ? state.entries : frameEntries;
  const filtered = searchEntries(searchScope, searchQuery, { type: activeType, category: activeCat, method: activeMethodGroup ? 'all' : activeMethod })
    .filter(e => !activeMethodGroup || activeMethodGroup.members.includes(e.method));
  // Sort a copy so filtering/history presentation never mutates persisted order.
  // A query is read as a ranking and keeps the ranker's order (closest match first,
  // under the field); with the field empty the frame reads newest-first as usual
  // — or oldest-first once the order toggle has been flipped.
  const newestFirst = (a, b) => b.date.localeCompare(a.date)
    || ((b.createdAt || '')).localeCompare(a.createdAt || '')
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const oldestFirst = (a, b) => a.date.localeCompare(b.date)
    || ((a.createdAt || '')).localeCompare(b.createdAt || '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let visible = searchQuery ? [...filtered] : [...filtered].sort(orderAsc ? oldestFirst : newestFirst);
  if (activeDay && !inRange) visible = visible.filter(e => e.date === activeDay);
  const expenseSum = frameEntries.filter(isSpendingEntry).reduce((s, e) => s + e.amount, 0);
  const update = (next = {}) => {
    if (next.month !== undefined) { params.set('month', next.month); params.delete('day'); }
    if (next.day !== undefined) {
      if (next.day) params.set('day', next.day);
      else params.delete('day');
    }
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
    if (next.type !== undefined) {
      if (next.type === 'all') params.delete('type');
      else params.set('type', next.type);
    }
    if (next.order !== undefined) {
      if (next.order === 'asc') params.set('order', 'asc');
      else params.delete('order');
    }
    if (next.range !== undefined) {
      if (!next.range) {
        params.delete('from');
        params.delete('to');
        params.delete('day');
      } else {
        // Normalise on write too, so the stored pair is always ordered and a
        // reversed pick cannot leave a hash the read side keeps fixing up.
        const { from, to } = next.range;
        const lo = from <= to ? from : to;
        const hi = from <= to ? to : from;
        if (dateKeyOk(lo) && dateKeyOk(hi)) {
          params.set('from', lo);
          params.set('to', hi);
          params.delete('day');
        }
      }
    }
    const qs = params.toString();
    location.hash = qs ? `history?${qs}` : 'history';
  };

  const c = $('section', { class: 'page-section', 'aria-label': 'History' });

  const navRight = $('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end;' });
  if (inRange) {
    // A range is its own frame: the month's own nav steps aside rather than
    // silently applying a month on top of a range.
    navRight.appendChild(monthNav('Month view', () => update({ range: null }), false));
  } else {
    navRight.appendChild(monthNav(iconSpan('chevron-left', 'md'), () => { const i = months.indexOf(activeMonth); if (i < months.length - 1) update({ month: months[i + 1] }); }, months.indexOf(activeMonth) >= months.length - 1, 'Previous month'));
    navRight.appendChild(monthNav(monthKey(today()) === activeMonth ? 'Today' : 'Jump', () => update({ month: monthKey(today()) }), false));
    navRight.appendChild(monthNav(iconSpan('chevron-right', 'md'), () => { const i = months.indexOf(activeMonth); if (i > 0) update({ month: months[i - 1] }); }, months.indexOf(activeMonth) <= 0, 'Next month'));
    // "Range" opens the month as a range ending today; the From/To inputs
    // that appear with it are what make it span months afterwards.
    navRight.appendChild(monthNav('Range', () => update({ range: { from: `${activeMonth}-01`, to: today() } }), false));
  }
  // A query has an order of its own — closest match first — so the toggle
  // stands aside there rather than pretending to sort the ranking.
  if (!searchQuery) navRight.appendChild(monthNav(orderAsc ? 'Oldest first' : 'Newest first', () => update({ order: orderAsc ? 'desc' : 'asc' }), false));
  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, inRange ? `${friendlyDate(rangeFrom)} – ${friendlyDate(rangeTo)}` : monthLabel(activeMonth)),
    navRight,
  ));

  if (!inRange) c.appendChild(calendarCard(activeMonth, activeDay, (ds) => update({ day: activeDay === ds ? '' : ds })));

  // Search bar
  const searchInput = $('input', { type: 'text', value: searchQuery, placeholder: 'Search descriptions, notes…', 'aria-label': 'Search entries', autocomplete: 'off', style: 'width:100%;max-width:320px;', onFocus: () => ensureSearchLib(), onInput: (e) => {
    // Debounced update
    clearTimeout(searchInput._timer);
    searchInput._timer = setTimeout(() => update({ q: e.target.value }), 250);
  } });
  c.appendChild($('div', { class: 'no-print', style: 'margin-bottom:16px;' },
    $('div', { style: 'display:flex;gap:8px;align-items:center;' },
      $('span', { style: 'color:var(--muted);', 'aria-hidden': 'true' }, iconSpan('search')),
      searchInput,
      searchQuery ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { searchInput.value = ''; update({ q: '' }); } }, 'Clear') : null,
    ),
  ));

  // The range's own controls. Both inputs are visible (not one hidden behind
  // the other): a range is two dates, and each edit re-writes the hash, so the
  // back gesture steps through them like any other filter.
  if (inRange) {
    const inputStyle = 'font:inherit;background:transparent;color:inherit;border:1px solid var(--line);border-radius:8px;padding:7px 10px;';
    c.appendChild($('div', { class: 'no-print', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px;' },
      $('span', { class: 'eyebrow' }, 'Range'),
      $('label', { style: 'font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;' }, 'From',
        $('input', { type: 'date', value: rangeFrom, 'aria-label': 'Range from', style: inputStyle, onChange: (e) => update({ range: { from: e.target.value || rangeFrom, to: rangeTo } }) })),
      $('label', { style: 'font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;' }, 'To',
        $('input', { type: 'date', value: rangeTo, 'aria-label': 'Range to', style: inputStyle, onChange: (e) => update({ range: { from: rangeFrom, to: e.target.value || rangeTo } }) })),
      $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => update({ range: null }) }, 'Clear'),
    ));
  }

  const catCounts = {};
  for (const e of frameEntries) catCounts[e.category] = (catCounts[e.category] || 0) + 1;
  catCounts.all = frameEntries.length;

  const filterRow = $('div', { class: 'no-print', style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 12px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  // The category row is a single-choice group: let Jelly Radio carry the
  // spring, the roving tab stop and the arrow keys; the pills keep their skin.
  filterRow.setAttribute('data-jelly-radio', '');
  filterRow.setAttribute('data-jelly-bare', '');
  filterRow.setAttribute('data-jelly-size', 'sm');
  filterRow.setAttribute('data-jelly-radius', '999');
  filterRow.setAttribute('data-jelly-swell', '0.08');
  filterRow.setAttribute('data-jelly-barge', '2');
  filterRow.setAttribute('data-jelly-shrink', '0.03');
  filterRow.appendChild($('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;' }, 'Category'));
  filterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': 'all', 'data-active': activeCat === 'all' ? 'true' : 'false', 'aria-pressed': activeCat === 'all' ? 'true' : 'false', onClick: () => update({ cat: 'all' }) }, `All · ${catCounts.all || 0}`));
  for (const c2 of allCategories()) {
    const count = catCounts[c2.id] || 0;
    if (count === 0 && activeCat !== c2.id) continue;
    filterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': c2.id, 'data-active': activeCat === c2.id ? 'true' : 'false', 'aria-pressed': activeCat === c2.id ? 'true' : 'false', onClick: () => update({ cat: c2.id }) }, `${c2.label} · ${count}`));
  }
  const methodCounts = {};
  for (const e of frameEntries) methodCounts[e.method] = (methodCounts[e.method] || 0) + 1;
  const methodFilterRow = $('div', { class: 'no-print', style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  methodFilterRow.appendChild($('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;font-size:10px;' }, 'Account'));
  methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': 'all', 'data-active': activeMethod === 'all' ? 'true' : 'false', 'aria-pressed': activeMethod === 'all' ? 'true' : 'false', onClick: () => update({ method: 'all' }) }, `All · ${frameEntries.length}`));
  for (const group of ACCOUNT_GROUPS) {
    const key = `group:${group.id}`;
    const count = group.members.reduce((sum, id) => sum + (methodCounts[id] || 0), 0);
    if (count === 0 && activeMethod !== key) continue;
    methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': key, 'data-active': activeMethod === key ? 'true' : 'false', 'aria-pressed': activeMethod === key ? 'true' : 'false', onClick: () => update({ method: key }) }, `${group.label} · ${count}`));
  }
  for (const method of everyMethod()) {
    const count = methodCounts[method.id] || 0;
    if (count === 0 && activeMethod !== method.id) continue;
    methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': method.id, 'data-active': activeMethod === method.id ? 'true' : 'false', 'aria-pressed': activeMethod === method.id ? 'true' : 'false', onClick: () => update({ method: method.id }) }, `${methodShort(method.id)} · ${count}`));
  }
  c.appendChild(filterRow);
  c.appendChild(methodFilterRow);

  // Type: the filter the function always had and the screen never asked for.
  // Counts read the frame (month or range) like every other pill row, and the
  // row only offers types that actually occur — a pill with 0 on it reads as
  // a broken filter rather than an empty one.
  const typeCounts = { all: frameEntries.length, expense: 0, credit: 0, transfer: 0, note: 0 };
  for (const e of frameEntries) if (typeCounts[e.type] !== undefined) typeCounts[e.type] += 1;
  const typeFilterRow = $('div', { class: 'no-print', style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  // The type row is the second single-choice group in History, so it takes
  // Rubber Segment: the thumb stretches across the gap before it lands on the
  // new type, instead of springing like the category row above it. The pills
  // keep their skin; the chosen one drops its own fill so the accent thumb
  // shows through (see the rule in styles.css). The row is rebuilt on every
  // filter change, so the key lets the new instance remember the old seat and
  // animate from it.
  typeFilterRow.setAttribute('data-rubber-segment', '');
  typeFilterRow.setAttribute('role', 'group');
  typeFilterRow.setAttribute('aria-label', 'Filter history by type');
  typeFilterRow.setAttribute('data-rs-key', 'history-type');
  typeFilterRow.setAttribute('data-rs-size', 'sm');
  typeFilterRow.setAttribute('data-rs-inset', '0');
  typeFilterRow.setAttribute('data-rs-radius', '6');
  typeFilterRow.setAttribute('data-rs-stretch', '80');
  typeFilterRow.setAttribute('data-rs-squash', '2');
  typeFilterRow.appendChild($('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;font-size:10px;' }, 'Type'));
  const TYPE_PILLS = [['all', 'All'], ['expense', 'Spending'], ['credit', 'Income'], ['transfer', 'Transfers'], ['note', 'Notes']];
  for (const [value, label] of TYPE_PILLS) {
    const count = typeCounts[value] || 0;
    if (count === 0 && activeType !== value) continue;
    typeFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': value, 'data-active': activeType === value ? 'true' : 'false', 'aria-pressed': activeType === value ? 'true' : 'false', onClick: () => update({ type: value }) }, `${label} · ${count}`));
  }
  c.appendChild(typeFilterRow);

  // The view's own actions. "Export view" writes exactly what is on screen —
  // in the order it is on screen, ranking included — while the full-ledger
  // CSV stays in the Data menu; Print is the year-in-review pattern pointed
  // at this screen (the class is what the @media print block keys on).
  const toolsRow = $('div', { class: 'no-print', style: 'display:flex;gap:8px;flex-wrap:wrap;padding:0 0 14px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', style: 'height:28px;padding:0 12px;font-size:12px;', onClick: () => {
      exportEntriesCsv(state, { category: categoryLabel, method: methodLabel }, { entries: visible });
    } }, `Export view · ${visible.length}`),
    $('button', { type: 'button', class: 'btn btn-ghost', style: 'height:28px;padding:0 12px;font-size:12px;', onClick: () => {
      document.body.classList.add('printing-history');
      const done = () => { document.body.classList.remove('printing-history'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      // Some embedded webviews never fire afterprint; the class is harmless
      // there, but a delayed sweep keeps the page from staying hidden.
      setTimeout(done, 30000);
      window.print();
    } }, 'Print'),
  );
  c.appendChild(toolsRow);

  // Bulk selection - checkboxes in the header and each row, plus a toolbar.
  const selected = new Set();
  const bulkBar = $('div', { class: 'bulk-bar no-print', style: 'display:none;margin-bottom:12px;padding:10px 16px;border:1px solid var(--accent);border-radius:var(--radius);background:var(--accent-soft);align-items:center;justify-content:space-between;gap:12px;' },
    $('span', { class: 'bulk-count', style: 'font-size:13px;font-weight:500;' }, ''),
    $('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' },
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 12px;font-size:12px;', onClick: () => { selected.clear(); syncBulkBar(); tableWrap.querySelectorAll('input[data-bulk]').forEach(cb => cb.checked = false); } }, 'Clear'),
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 12px;font-size:12px;', onClick: bulkChangeCategory }, 'Category'),
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 12px;font-size:12px;', onClick: bulkChangeMethod }, 'Account'),
      $('button', { type: 'button', class: 'btn btn-danger', style: 'padding:6px 12px;font-size:12px;', onClick: bulkDeleteSelected }, 'Delete selected'),
    ),
  );
  c.appendChild(bulkBar);
  function syncBulkBar() {
    const n = selected.size;
    bulkBar.style.display = n ? 'flex' : 'none';
    bulkBar.querySelector('.bulk-count').textContent = n ? `${n} selected` : '';
  }
  async function bulkDeleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    const affected = [];
    const protectedIds = [];
    const seen = new Set();
    let protectedOldest = null;
    const addAll = (list) => { for (const e of list) { if (!seen.has(e.id)) { seen.add(e.id); affected.push(e); } } };
    for (const id of ids) {
      const removed = deletionEntriesFor(id);
      const protection = removed.map(reconciliationProtectionFor).find(Boolean);
      if (protection) {
        protectedIds.push(...removed.map(e => e.id));
        if (!protectedOldest || protection.point.date < protectedOldest) protectedOldest = protection.point.date;
        continue;
      }
      addAll(removed);
    }
    // Deleting inside a reconciled period is allowed on explicit confirm: the
    // balance drift it causes is a known, undoable trade-off, not a wall.
    if (protectedIds.length && affected.length) {
      const includeProtected = await swalConfirm({
        title: `${protectedIds.length} selected ${protectedIds.length === 1 ? 'entry is' : 'entries are'} inside a reconciled period`,
        text: `AIB is reconciled through ${friendlyDate(protectedOldest)}. Include them in the deletion anyway? Balances before that date will drift from the reconciled figure. You can undo this.`,
        confirmButtonText: 'Delete everything',
        cancelButtonText: 'Delete the rest only',
        danger: true,
      });
      if (includeProtected) {
        const protectedSet = new Set(protectedIds);
        addAll(state.entries.filter(e => protectedSet.has(e.id)));
      }
    } else if (protectedIds.length && !affected.length) {
      const deleteProtected = await swalConfirm({
        title: `All ${protectedIds.length} selected ${protectedIds.length === 1 ? 'entry is' : 'entries are'} inside a reconciled period`,
        text: `AIB is reconciled through ${friendlyDate(protectedOldest)}. Delete them anyway? Balances before that date will drift from the reconciled figure. You can undo this.`,
        confirmButtonText: 'Delete anyway',
        danger: true,
      });
      if (deleteProtected) {
        const protectedSet = new Set(protectedIds);
        addAll(state.entries.filter(e => protectedSet.has(e.id)));
      }
    }
    if (!affected.length) {
      toast('Nothing was deleted.');
      selected.clear(); syncBulkBar(); render();
      return;
    }
    const removedCopy = affected.map(e => ({ ...e }));
    const removeIds = new Set(removedCopy.map(e => e.id));
    state.entries = state.entries.filter(e => !removeIds.has(e.id));
    tombstoneIds([...removeIds]);
    persist();
    trackAction(() => {
      state.entries.push(...removedCopy);
      state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      untombstoneIds(removedCopy.map(e => e.id));
      persist();
    }, `Deleted ${removedCopy.length} entr${removedCopy.length === 1 ? 'y' : 'ies'}`, removedCopy);
    toast(`Deleted ${removedCopy.length} entr${removedCopy.length === 1 ? 'y' : 'ies'}.`);
    selected.clear();
    render();
  }

  function bulkChangeCategory() {
    const ids = [...selected];
    if (!ids.length) return;
    openBulkPickerModal({
      title: `Category for ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}`,
      options: allCategories().map(c => ({ id: c.id, label: c.label })),
      onPick: (value) => applyBulkField(ids, 'category', value),
    });
  }
  function bulkChangeMethod() {
    const ids = [...selected];
    if (!ids.length) return;
    openBulkPickerModal({
      title: `Account for ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}`,
      options: allMethods().map(m => ({ id: m.id, label: m.label })),
      onPick: (value) => applyBulkField(ids, 'method', value),
    });
  }
  function applyBulkField(ids, field, value) {
    const idSet = new Set(ids);
    const before = state.entries.filter(e => idSet.has(e.id)).map(e => ({ ...e }));
    // Transfer legs share a pair id - changing one leg's account would split
    // the transfer, so those are skipped for account moves.
    const applicable = field === 'method' ? before.filter(e => !e.transferId) : before;
    if (!applicable.length) { toast('None of those entries can be changed that way.'); selected.clear(); syncBulkBar(); render(); return; }
    const changed = new Set(applicable.map(e => e.id));
    for (const e of state.entries) if (changed.has(e.id)) e[field] = value;
    persist();
    const verb = field === 'category' ? 'Categorised' : 'Moved';
    trackAction(() => {
      for (const prev of before) {
        const cur = state.entries.find(e => e.id === prev.id);
        if (cur) cur[field] = prev[field];
      }
      persist();
    }, `${verb} ${applicable.length} entr${applicable.length === 1 ? 'y' : 'ies'}`, applicable);
    toast(`${verb} ${applicable.length} entr${applicable.length === 1 ? 'y' : 'ies'}.`);
    selected.clear();
    render();
  }
  function openBulkPickerModal({ title, options, onPick }) {
    const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
    const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1', style: 'max-width:400px;' });
    const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); };
    const onEsc = ev => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
    document.addEventListener('keydown', onEsc, true);
    bg.appendChild(modal);
    document.body.appendChild(bg);
    modal.append(
      $('h2', { class: 'serif', style: 'font-size:20px;margin:0 0 4px;' }, title),
      $('div', { class: 'muted', style: 'font-size:12px;margin-bottom:16px;' }, 'Applies to every selected entry - undoable.'),
      $('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;' },
        ...options.map(o => $('button', { type: 'button', class: 'pill pill-cat', 'data-active': 'false', onClick: () => { onPick(o.id); close(); } }, o.label)),
      ),
      $('div', { style: 'display:flex;justify-content:flex-end;margin-top:16px;' }, $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel')),
    );
    queueMicrotask(() => modal.focus());
  }

  const tableWrap = $('div', { class: 'card history-table', style: 'overflow-x:auto;padding:0;' });
  if (visible.length === 0) {
    tableWrap.appendChild($('div', { class: 'empty' }, emptyIcon('receipt'), searchQuery ? ' No results for this search.' : activeDay ? ` No entries on ${friendlyDate(activeDay)}.` : ' Nothing here for this filter.'));
  } else {
    tableWrap.appendChild($('div', { role: 'row', class: 'history-head-row' },
      $('span', { role: 'columnheader' }, $('input', { type: 'checkbox', 'data-bulk': '', 'aria-label': 'Select all visible', title: 'Select all visible', onChange: (ev) => {
        selected.clear();
        if (ev.target.checked) for (const e of visible) selected.add(e.id);
        tableWrap.querySelectorAll('input[data-bulk]').forEach(cb => { if (cb !== ev.target) cb.checked = ev.target.checked; });
        syncBulkBar();
      } })),
      $('span', { role: 'columnheader' }, 'Date'),
      $('span', { role: 'columnheader' }, 'Description'),
      $('span', { role: 'columnheader', style: 'text-align:right;' }, 'Amount'),
      $('span', { role: 'columnheader', style: 'text-align:right;', title: 'Balance immediately after this entry' }, 'After entry'),
      $('span', { role: 'columnheader' }, 'Method'),
      $('span', { role: 'columnheader', class: 'sr-only' }, 'Actions'),
    ));

    // Split-payment legs sharing a splitId render as one grouped row so a mixed
    // payment reads as a single transaction instead of N duplicate-looking rows.
    const splitCounts = new Map();
    for (const e of visible) if (e.splitId) splitCounts.set(e.splitId, (splitCounts.get(e.splitId) || 0) + 1);
    const splitGroups = new Map();
    const display = [];
    for (const e of visible) {
      const key = e.splitId && splitCounts.get(e.splitId) > 1 ? e.splitId : null;
      if (!key) { display.push({ type: 'e', e }); continue; }
      if (!splitGroups.has(key)) { splitGroups.set(key, []); display.push({ type: 'g', id: key, first: e }); }
      splitGroups.get(key).push(e);
    }

    for (const item of display) {
      const isGroup = item.type === 'g';
      const legs = isGroup ? splitGroups.get(item.id) : [item.e];
      const e = legs[0];
      const isNote = e.type === 'note';
      const isCredit = e.type === 'credit';
      const totalAmount = isGroup ? Math.round(legs.reduce((sum, l) => sum + l.amount, 0) * 100) / 100 : e.amount;
      const rowBalance = balanceForEntry(legs[0]);
      const rowType = isNote ? 'note-row' : isCredit ? 'income-row' : 'expense-row';
      const openRow = () => {
        if (isGroup) {
          const grp = state.entries.filter(x => x.splitId === item.id);
          if (grp.length >= 2) openSplitEditor(grp); else openEdit(legs[0].id);
        } else openEdit(e.id);
      };
      const selectAll = isGroup ? legs.map(l => l.id) : [e.id];
      // Every control in this row is addressed by this string, so it has to name
      // the row and not just the entry: a bank-to-bank transfer writes two rows
      // with the same details and the same date, and the static 'Toggle budget
      // inclusion' repeated that on *every* row of the screen. The amount and the
      // method are what the two legs of a transfer differ by, so they carry the
      // distinction (and the sign: the money left one account and reached the other).
      const rowLabel = `${e.details || (isNote ? 'note' : 'entry')} \u00b7 ${friendlyDate(e.date)} \u00b7 ${isGroup ? 'split' : methodShort(e.method)} \u00b7 ${(isCredit ? '+' : '') + fmt(totalAmount)}`;
      // The row's inline action is Edit; touch gets Delete from the swipe pane.
      // (A kebab once offered Duplicate and Exclude from the row too. It is gone
      // — excluding from the budget is the editor's checkbox — and the two
      // handlers it was the only caller of went with it.)
      // Delete from the swipe pane. The same tombstone + undo path the editor's
      // confirm uses, so a gesture cannot destroy anything Undo cannot bring
      // back. Split groups and transfers are never swipe rows (see `swipeable`):
      // their delete is a pair or a group, and that choice belongs in the editor
      // they open into.
      const deleteRow = async () => {
        if (isGroup) { openRow(); return; }
        const removed = deletionEntriesFor(e.id).map(entry => ({ ...entry }));
        if (!(await deleteEntryOrTransfer(e.id))) return;
        trackAction(() => {
          state.entries.push(...removed);
          state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          untombstoneIds(removed.map(entry => entry.id));
          persist();
        }, `Deleted ${e.details || 'entry'}`, removed);
        toast('Deleted. Undo it any time with the Undo button.');
      };
      // The gesture is the phone's, not the desk's: the wide table keeps its
      // visible Edit button and its sideways scroll, and only the stacked
      // layout gets a row that slides aside to reveal Delete.
      const swipeable = isNarrow() && !isGroup && !e.transferId;
      const row = $('div', { class: `history-row ${rowType}`, role: 'row', tabindex: '0', ...(swipeable ? { 'data-swipe-row': '', 'data-swipe-label': 'Entry actions', 'data-swipe-full': 'off' } : null), 'data-id': isGroup ? item.id : e.id, 'aria-label': `${isGroup ? 'Edit split payment for' : 'Edit entry'} ${rowLabel}`, onClick: (ev) => { if (ev.target.closest('input[data-bulk]')) return; openRow(); }, onKeydown: (ev) => { if (ev.target.closest('input')) return; if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRow(); } } },
        $('span', { role: 'cell', class: 'history-cell-check' }, $('input', { type: 'checkbox', 'data-bulk': '', checked: selectAll.every(id => selected.has(id)) ? true : null, 'aria-label': `Select ${rowLabel}`, onClick: (ev) => ev.stopPropagation(), onChange: (ev) => {
          for (const id of selectAll) { if (ev.target.checked) selected.add(id); else selected.delete(id); }
          syncBulkBar();
        } })),
        $('span', { role: 'cell', class: 'muted history-date' }, friendlyDate(e.date)),          $('div', { role: 'cell', class: 'history-details-wrap' },
            $('div', { class: 'history-details' }, e.details || '-',            e.type === 'note' && e.audioData ? $('audio', { controls: '', preload: 'none', src: e.audioData, class: 'history-audio' }) : null,
          ),
          $('div', { class: 'history-category' }, categoryLabel(e.category)),
        ),
        $('span', { role: 'cell', class: `display-num history-amount${isCredit ? ' is-credit' : ''}` }, isNote ? 'Note' : (isCredit ? '+' : '') + fmt(totalAmount)),
        $('span', { role: 'cell', class: `tnum history-balance${rowBalance >= 0 ? ' is-positive' : ' is-negative'}` }, isNote ? '-' : fmt(rowBalance)),
        $('span', { role: 'cell', class: 'history-method-wrap' }, ...(isGroup
          ? legs.map(l => $('button', { type: 'button', class: 'pill split-leg', title: 'Edit this slice', 'aria-label': `Edit ${fmt(l.amount)} ${methodShort(l.method)} slice`, onClick: ev => { ev.stopPropagation(); openLegEditor(l); } }, `${fmt(l.amount)} ${methodShort(l.method)}`))
          : [$('span', { class: 'pill history-method' }, methodShort(e.method))])),
        $('span', { role: 'cell', class: 'history-actions' },
          $('button', { type: 'button', class: 'history-action-btn', title: isGroup ? 'Edit or delete split payment' : 'Edit or delete entry', 'aria-label': (isGroup ? `Edit or delete split ${rowLabel}` : `Edit or delete ${rowLabel}`), onClick: ev => { ev.stopPropagation(); openRow(); } }, 'Edit'),
          swipeable ? $('button', { type: 'button', class: 'history-swipe-delete', 'data-swipe-action': '', 'data-swipe-label': 'Delete', 'data-swipe-tone': 'danger', 'aria-label': `Delete ${rowLabel}`, onClick: ev => { ev.stopPropagation(); void deleteRow(); } }, 'Delete') : null,
        ),
      );

      tableWrap.appendChild(row);
    }
  }
  c.appendChild(tableWrap);

  const histSumEl = $('span', { class: 'display-num', style: 'font-size:30px;' }, fmt(expenseSum));
  c.appendChild($('div', { class: 'summary-row' },
    $('span', { class: 'eyebrow' }, inRange ? 'Range sum · expenses' : 'Monthly sum · expenses'),
    histSumEl,
  ));

  return c;
}

function calendarCard(activeMonth, activeDay, onDayChange) {
  const [y, m] = activeMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monAdjusted = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const byDay = {};
  for (const e of entriesForMonth(activeMonth)) if (isSpendingEntry(e)) byDay[e.date] = (byDay[e.date] || 0) + e.amount;
  const maxDay = Math.max(1, ...Object.values(byDay));
  const cells = [];
  for (let i = 0; i < monAdjusted; i++) cells.push($('div', { class: 'cal-cell cal-empty' }));
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const val = byDay[ds] || 0;
    const size = val ? 4 + Math.round((val / maxDay) * 8) : 0;
    cells.push($('button', { type: 'button', class: 'cal-cell cal-day', ...(ds === activeDay ? { 'data-selected': '' } : null), ...(ds === today() ? { 'data-today': '' } : null), 'aria-label': `${friendlyDate(ds)}${val ? `, spent ${fmt(val)}` : ''}`, title: val ? `${friendlyDate(ds)} · ${fmt(val)}` : friendlyDate(ds), onClick: () => onDayChange(ds) },
      $('span', { class: 'cal-num' }, String(d)),
      val ? $('span', { class: 'cal-dot', style: `width:${size}px;height:${size}px;` }) : null,
    ));
  }
  // The card's own content is one centred column (`.cal-inner`): the History
  // route widens the shell to 1,780px for the table below, and a month grid that
  // tracked that width was 1,083px tall with 184px cells. Capping only the grid
  // would leave its header at the card's far left and the grid in the middle —
  // an alignment nobody asked for — so the header, the grid and the legend move
  // together. A phone's width is under the cap, so nothing changes there.
  return $('div', { class: 'card cal-card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'cal-inner' },
    $('div', { class: 'row between', style: 'margin-bottom:14px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Calendar'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, activeDay ? `Showing ${friendlyDate(activeDay)}.` : 'Tap a day to filter the entries below.'),
      ),
      activeDay ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => onDayChange('') }, 'Clear') : null,
    ),
    $('div', { class: 'cal-grid' },
      ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(l => $('div', { class: 'cal-dow' }, l)),
      ...cells,
    ),
    $('div', { class: 'cal-legend' },
      $('span', null, 'Less'), ...[0.2, 0.4, 0.6, 0.8, 1].map(p => $('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${heatColor(p)};opacity:0.85;` })), $('span', null, 'More'),
    ),
    ),
  );
}

// A month-navigation button. `label` is what is shown; when it is an icon rather
// than text it carries no accessible name of its own — the icon span is
// aria-hidden — so the caller passes `ariaLabel` for it. An icon-only button
// without one reads as "button, dimmed" to a screen reader and nothing else,
// which is how the History chevrons shipped (a11y-harness.html reports it per
// surface). aria-label is an ADDRESSED IDENTITY in this app — restoreFocusedField
// looks fields up by it and the harness probes by it — so each one is unique.
function monthNav(label, onClick, disabled, ariaLabel = null) {
  const node = $('button', { type: 'button', class: 'btn btn-ghost', disabled: disabled ? '' : null, style: 'height:28px;padding:0 12px;font-size:13px;line-height:16px;font-weight:500;border-radius:6px;', onClick }, label);
  if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
  return node;
}

// ---------- screens: balances ----------
// Reconcile end-of-day actual balances by date; no transaction records are
// changed. All tracked balances share one inline reconciliation flow.
function screenBalances() {
  const c = $('section', { class: 'page-section', 'aria-label': 'Balances' });
  // The dashboard's low-balance alert links here as #balances?load=<card>.
  // Land that card's row straight into its load editor, then strip the param
  // so saving/cancelling (which re-render) doesn't re-open the editor.
  const loadParam = new URLSearchParams((location.hash.split('?')[1]) || '').get('load');
  const autoLoadId = GIFT_CARD_IDS.includes(loadParam) ? loadParam : null;
  if (autoLoadId) { try { history.replaceState(null, '', location.pathname + '#balances'); } catch {} }

  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, 'Balances'),
    $('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end;' },
      tabVisible('history') ? $('a', { href: '#history', class: 'btn btn-ghost', style: 'padding:8px 14px;font-size:12px;' }, 'Transaction history') : null,
      $('button', { type: 'button', class: 'btn btn-primary', style: 'padding:8px 14px;font-size:12px;', onClick: reconcileAll }, 'Reconcile all'),
    ),
  ));

  c.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Account balances'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Reconcile end-of-day actual balances by date; no transaction records are changed.'),
      ),
      $('span', { class: 'muted', style: 'font-size:11px;' }, 'AIB · Revolut (Main + Savings)'),
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      // Each account's own forward projection: the schedule carries the method
      // it lands on, so every row can say where this card ends up if the next
      // 30 days of recurring income and bills all land. Ordinary spending is
      // deliberately not projected — the run-rate says that elsewhere, and a
      // forward figure that pretended the shopping stops would be worse than
      // none. No schedule on an account means no line at all.
      ...renderAccountBalanceRows({
        editable: true,
        secondaryFor: (id) => accountProjectionText(id),
        secondaryHintFor: () => 'Where this account lands in 30 days: its balance on that date — entries already recorded for a future day included — plus every recurring item scheduled on it in between, if each one lands. Ordinary spending is not projected here.',
      }),
    ),
  ));

  c.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:4px;' }, 'Gift card balances'),
    $('div', { class: 'muted', style: 'font-size:11px;margin-bottom:8px;' }, 'The same reconciliation editor is used for every balance.'),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...GIFT_CARD_IDS.map(id => {
        const method = methodById(id);
        const totals = computeGiftCardBalance(state.entries, id);
        return renderBalanceEditorRow(id, {
          label: method?.label?.includes(' · ') ? method.label.split(' · ')[1] : (method?.label || id),
          secondary: totals.loaded || totals.spent
            ? `${userCheckpointFor(id, today()) ? 'net adjustments · loads' : 'recorded loads'} ${fmt(totals.loaded)} · spending ${fmt(totals.spent)}`
            : '',
          secondaryHint: 'Loads are what went ON the card, spending what came off it. After a reconciliation the figure is your adjustments plus those loads.',
          editable: true,
          startInLoad: id === autoLoadId,
        });
      }),
    ),
  ));

  // Paper vouchers. The dashboard's hero carries the one-line pill (and it now
  // shows at €0.00 too); this is the fuller view — what the figure is, and what
  // it deliberately never counts towards.
  const vouchers = voucherAmount();
  c.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' },
      $('div', { style: 'min-width:0;' },
        $('div', { class: 'eyebrow' }, 'Paper vouchers'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Tesco paper vouchers on hand. Never counted as money in any balance.'),
      ),
      $('div', { style: 'display:flex;align-items:center;gap:10px;flex-shrink:0;' },
        $('span', { class: 'display-num', style: `font-size:16px;color:${vouchers > 0 ? 'var(--accent)' : 'var(--muted)'};` }, fmt(vouchers)),
        $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 14px;font-size:12px;', 'aria-label': 'Edit paper vouchers', onClick: () => openVoucherEditor() }, 'Edit'),
      ),
    ),
  ));

  return c;
}

// ---------- screens: insights ----------
// Day digits sit on the tinted cell, which is darkest at the top bucket in
// light mode but brightest in dark mode, so the ink has to follow the theme:
// page ink reads as dark-on-dark up there in one theme and white-on-bright in
// the other. Every other bucket is a mid-tint where --ink always works.
function heatDigitInk(pct) {
  if (pct < 0.75) return 'var(--ink)';
  return document.documentElement.dataset.theme === 'dark' ? 'var(--bg)' : '#FFFFFF';
}

// Heatmap cells tint --accent into --bg. Browsers without color-mix() support
// get a manual blend so the cells never render transparent.
function heatColor(pct) {
  if (window.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red 50%, blue)')) {
    return `color-mix(in srgb, var(--accent) ${Math.round(pct * 100)}%, var(--bg))`;
  }
  const cs = getComputedStyle(document.documentElement);
  const parseHex = (raw) => {
    const m = (raw || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const accent = parseHex(cs.getPropertyValue('--accent'));
  const bg = parseHex(cs.getPropertyValue('--bg'));
  if (!accent || !bg) return 'var(--accent)';
  // Blend from bg toward accent so pct=0.3 means "30% accent / 70% bg",
  // matching the color-mix() path above.
  const mix = bg.map((v, i) => Math.round(v + (accent[i] - v) * pct));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

// ---------- Insights (deferred) ----------
// The Insights screen, its chart cluster and the Year in review modal are
// ~39 KB of drawing code that a session may never open, so they live in
// insights.js and are fetched on the first visit to #insights — the same
// shape as tescoScreen(), including the warm-up, because a screen that takes
// a frame to arrive should already be there when the tab is clicked. The
// module reaches back for the shell through the exports at the end of this
// file rather than through a context object: it is one module graph, and a
// live binding on `state` is what keeps it reading the current document.
let _insightsModule = null;
let _insightsPromise = null;
function insightsReady() {
  if (_insightsModule) return Promise.resolve(_insightsModule);
  if (!_insightsPromise) {
    _insightsPromise = import('./insights.js')
      .then(mod => {
        _insightsModule = mod;
        // Same rule as the Tesco warm-up: importing on intent must not rebuild a
        // screen the reader is not on (it drops focus and the DOM marks).
        if (currentRoute() === 'insights') render();
        return mod;
      })
      .catch(err => {
        _insightsPromise = null;
        console.warn('cents: the Insights screen could not be loaded', err);
        toast('The Insights screen could not be loaded.');
        throw err;
      });
  }
  return _insightsPromise;
}

/** The module, or null while it is still coming — the route draws its own
 *  placeholder in that case (see insightsLoadingCard). */
function insightsScreen() {
  if (_insightsModule) return _insightsModule;
  void insightsReady().catch(() => {});
  return null;
}

// Intent warm-up: pointing at (or tabbing to) an Insights link starts the
// fetch, so a click on the tab is usually already there. Delegated, because
// every screen rebuilds its own nav — and it is the same call the route
// switch makes.
function warmInsightsScreen(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('a[href="#insights"]') : null;
  if (el) void insightsReady().catch(() => {});
}
document.addEventListener('pointerover', warmInsightsScreen);
document.addEventListener('focusin', warmInsightsScreen);

/** Drawn between asking for the module and having it. */
function insightsLoadingCard() {
  const c = $('section', { class: 'page-section', 'aria-label': 'Insights' });
  c.appendChild($('div', { class: 'page-title-row' }, $('h1', { class: 'page-title' }, 'Insights')));
  c.appendChild($('div', { class: 'card', style: 'padding:22px;' },
    $('p', { style: 'margin:0;color:var(--muted);font-size:13px;' }, 'Opening Insights\u2026')));
  return c;
}

// ---------- modal: transfer delete ----------
/** Delete-only modal for transfer pairs - editing is not allowed. */
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
  const onEsc = (ev) => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, 'Transfer pair'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  modal.appendChild($('p', { class: 'serif', style: 'font-size:17px;margin:0 0 16px;' }, 'Transfers cannot be edited. Delete and recreate the pair.'));

  for (const p of pair) {
    modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;' },
      $('span', null, $('span', { class: 'pill', style: 'border-color:transparent;margin-right:8px;' }, methodShort(p.method)), p.details, ' · ', friendlyDate(p.date)),
      $('span', { class: 'display-num', style: `color:${p.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};` }, (p.type === 'credit' ? '+' : '') + fmt(p.amount)),
    ));
  }

  modal.appendChild($('p', { class: 'serif', style: 'font-size:15px;color:var(--negative);margin:16px 0 8px;' }, 'Delete this transfer pair? You can undo it with the Undo button.'));
  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
    $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: async () => {
      const removed = pair.map(entry => ({ ...entry }));
      if (await deleteEntryOrTransfer(e.id)) {
        trackAction(() => {
          state.entries.push(...removed);
          state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          untombstoneIds(removed.map(e => e.id));
          persist();
        }, 'Deleted transfer pair', removed);
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

  // Split-payment legs are edited together as one group.
  if (e.splitId) {
    const grp = state.entries.filter(x => x.splitId === e.splitId);
    if (grp.length >= 2) { openSplitEditor(grp); return; }
  }

  // Transfer entries can't be edited - show a delete-only modal
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
    if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); return; }
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

  // Edit form (no delete button inside formView - we'll put it as a two-stage below)
  let formNode;
  const formContainer = $('div');
  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, 'Edit entry'),
    $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
  ));
  formNode = formView({
    initial: e,
    onCancel: close,
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
  const confirmDeleteBtn = $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: async () => {
    const removed = e.transferId
      ? state.entries.filter(entry => entry.transferId === e.transferId).map(entry => ({ ...entry }))
      : [{ ...e }];
    if (await deleteEntryOrTransfer(id)) {
      trackAction(() => {
        state.entries.push(...removed);
        state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        untombstoneIds(removed.map(e => e.id));
        persist();
      }, e.transferId ? 'Deleted transfer pair' : `Deleted ${e.details}`, removed);
      toast(e.transferId ? 'Transfer pair deleted.' : 'Deleted. Undo it any time with the Undo button.');
    }
    close();
  } }, 'Confirm delete');
  const deletePanel = $('div', { style: 'display:none;margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--accent-soft);' },
    $('p', { class: 'serif', style: 'font-size:17px;margin:0 0 12px;color:var(--negative);' }, 'Delete this entry? You can undo it with the Undo button.'),
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

// ---------- modal: single split leg editor ----------
// Tap one slice's pill in History to adjust just that leg's amount or method
// without opening the whole group editor. Updates one entry, tracked as one
// undoable action (re-ranks coins when Cash is involved).
function openLegEditor(leg) {
  const splitId = leg.splitId;
  const isCredit = leg.type === 'credit';

  const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit split slice', tabindex: '-1', style: 'max-width:400px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = ev => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const sel = $('select', { 'aria-label': 'Slice method', 'data-glide': true, 'data-glide-menu-width': '240', style: 'width:100%;' });
  appendMethodOptions(sel, methodPickerIds(leg.method), leg.method);
  sel.value = leg.method;
  const amt = $('input', { type: 'text', inputmode: 'decimal', value: String(leg.amount), 'aria-label': 'Slice amount', autocomplete: 'off', style: 'width:100%;text-align:right;' });

  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' },
      $('div', null,
        $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:24px;margin:0;' }, 'Edit slice'),
        $('div', { class: 'muted', style: 'font-size:11px;' }, 'Adjust just this part of the split. Undoable.'),
      ),
      $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
    ),
    $('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;' },
      $('div', null, $('label', { class: 'eyebrow', for: 'leg-method' }, 'Method'), Object.assign(sel, { id: 'leg-method' })),
      $('div', null, $('label', { class: 'eyebrow', for: 'leg-amount' }, isCredit ? 'Amount (in)' : 'Amount (out)'), Object.assign(amt, { id: 'leg-amount' })),
    ),
    $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px;' },
      $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
      $('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save'),
    ),
  );

  function save() {
    const amount = parseAmount(amt.value);
    if (!Number.isFinite(amount) || amount <= 0) { toast('Enter a positive slice amount.'); return; }
    const current = state.entries.find(x => x.id === leg.id && x.splitId === splitId);
    if (!current) { close(); return; }
    const before = { ...current };
    current.method = sel.value;
    current.amount = Math.round(amount * 100) / 100;
    if (current.method === 'Cash' || before.method === 'Cash') cashAutoFollow(cashDeltaOf(current) - cashDeltaOf(before));
    persist();
    trackAction(() => {
      const back = state.entries.find(x => x.id === current.id && x.splitId === splitId);
      if (back) Object.assign(back, before);
      persist();
    }, 'Edited split slice', current);
    toast('Slice updated.');
    close();
  }
}

// ---------- modal: split payment editor ----------
// Edit every single-method leg of a split as one group. Adding/removing slices
// rebuilds the group; every mutation keeps single method per leg so balances,
// history and undo behave like ordinary entries.
function openSplitEditor(legs) {
  const splitId = legs[0].splitId;
  const type = legs[0].type || 'expense';
  const isCredit = type === 'credit';
  let rows = legs.map(l => ({ id: l.id, method: l.method, amount: String(l.amount) }));

  const bg = $('div', { class: 'modal-bg', onClick: ev => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Split payment', tabindex: '-1', style: 'max-width:480px;' });
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = ev => { if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const detailsInput = $('input', { type: 'text', value: legs[0].details || '', 'aria-label': 'Description', autocomplete: 'off', style: 'width:100%;' });
  const dateInput = $('input', { type: 'date', value: legs[0].date, 'aria-label': 'Date', style: 'width:100%;' });
  wireFlatpickr(dateInput, { defaultDate: legs[0].date });

  const totalEl = $('span', { class: 'display-num', style: 'font-size:22px;' }, '');
  // Same flag the single-entry edit sheet carries, applied to every leg: the
  // row used to hold the only control for it, and a group's legs move together.
  const budgetInput = $('input', { type: 'checkbox', checked: legs.every(l => l.budgetExcluded === true), 'aria-label': 'Exclude this split payment from budget calculations' });
  const listWrap = $('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:8px;' });
  function updateTotal() {
    let t = 0;
    for (const r of rows) { const a = parseAmount(r.amount); if (Number.isFinite(a) && a > 0) t += a; }
    totalEl.textContent = fmt(Math.round(t * 100) / 100);
  }
  function redraw() {
    listWrap.innerHTML = '';
    rows.forEach((r, i) => {
      // Numbered per row, like the quick-capture split above: two slices must not
      // answer to one aria-label.
      const sel = $('select', { 'aria-label': `Split method ${i + 1}`, 'data-glide': true, 'data-glide-size': 'sm', 'data-glide-menu-width': '170', onchange: () => { r.method = sel.value; } });
      appendMethodOptions(sel, methodPickerIds(r.method), r.method);
      sel.value = r.method;
      const amt = $('input', { type: 'text', inputmode: 'decimal', value: r.amount, 'aria-label': `Slice amount ${i + 1}`, autocomplete: 'off', style: 'width:110px;text-align:right;', oninput: (ev) => { r.amount = ev.target.value; updateTotal(); } });
      const rm = $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:5px 9px;font-size:11px;', 'aria-label': `Remove slice ${i + 1}`, onClick: () => { if (rows.length <= 1) return; rows = rows.filter(x => x !== r); redraw(); updateTotal(); } }, 'Remove');
      listWrap.appendChild($('div', { class: 'split-leg', style: 'display:flex;align-items:center;gap:8px;min-width:0;' }, sel, amt, rows.length > 1 ? rm : null));
    });
  }
  redraw();

  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' },
      $('div', null,
        $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:24px;margin:0;' }, isCredit ? 'Split income' : 'Split payment'),
        $('div', { class: 'muted', style: 'font-size:11px;' }, 'Pay across several methods at once. Undoable.'),
      ),
      $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
    ),
    $('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;' },
      $('div', null, $('label', { class: 'eyebrow', for: 'fs-details' }, 'Description'), Object.assign(detailsInput, { id: 'fs-details' })),
      $('div', null, $('label', { class: 'eyebrow', for: 'fs-date' }, 'Date'), Object.assign(dateInput, { id: 'fs-date' })),
    ),
    $('label', { class: 'eyebrow', style: 'display:block;margin-top:16px;' }, 'Split'),
    listWrap,
    $('div', null, $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:12px;', onClick: () => { rows.push({ method: rows.some(r => r.method === 'AIB') ? 'Cash' : 'AIB', amount: '' }); redraw(); } }, '+ Add slice')),
    $('label', { style: 'display:flex;align-items:center;gap:9px;font-size:13px;margin-top:14px;cursor:pointer;color:var(--muted);' }, budgetInput, $('span', null, 'Exclude this payment from budget calculations')),
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);' }, $('span', { class: 'eyebrow' }, 'Total'), totalEl),
    $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;' },
      $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Cancel'),
      $('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save changes'),
    ),
  );

  function save() {
    const parsed = rows.map(r => ({ ...r, amount: parseAmount(r.amount) }));
    if (parsed.some(r => !Number.isFinite(r.amount) || r.amount <= 0)) { toast('Enter a positive slice amount for every slice.'); return; }
    if (!isValidCheckpointDate(dateInput.value)) { toast('Pick a valid date.'); return; }
    const details = detailsInput.value.trim();
    if (!details) { toast('Add a description.'); detailsInput.focus(); return; }
    const before = state.entries.filter(x => x.splitId === splitId).map(x => ({ ...x }));
    const createdAt = legs[0].createdAt || nowIso();
    const note = legs[0].note || '';
    const category = legs[0].category || 'misc';
    // Replace the whole group: surviving rows are rebuilt, and rows removed in
    // the editor are genuinely deleted (they used to survive with their
    // splitId intact, silently keeping their balance effect forever).
    const newLegs = parsed.map(r => {
      const existing = state.entries.find(x => x.id === r.id && x.splitId === splitId);
      const leg = existing
        ? { ...existing, method: r.method, amount: Math.round(r.amount * 100) / 100, details, date: dateInput.value }
        : { id: uid(), createdAt, date: dateInput.value, type, category, details, amount: Math.round(r.amount * 100) / 100, method: r.method, note, splitId };
      // One switch for the whole group — it is one payment, so it is either in
      // the budget or out of it, whatever each leg's old flag happened to say.
      if (budgetInput.checked) leg.budgetExcluded = true; else delete leg.budgetExcluded;
      return leg;
    });
    const removedLegs = before.filter(b => !newLegs.some(l => l.id === b.id));
    state.entries = state.entries
      .filter(x => x.splitId !== splitId)
      .concat(newLegs);
    if (removedLegs.length) tombstoneIds(removedLegs.map(x => x.id));
    state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (newLegs.some(l => l.method === 'Cash') || removedLegs.some(l => l.method === 'Cash')) cashAutoFollow(newLegs.reduce((sum, l) => sum + cashDeltaOf(l), 0) - before.reduce((sum, l) => sum + cashDeltaOf(l), 0));
    persist();
    trackAction(() => {
      state.entries = state.entries.filter(x => x.splitId !== splitId).concat(before);
      state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (removedLegs.length) untombstoneIds(removedLegs.map(x => x.id));
      persist();
    }, 'Edited split payment', newLegs);
    toast('Split payment updated.');
    close();
  }

  // Two-stage delete of the whole group
  const delStage1 = $('button', { type: 'button', class: 'btn btn-danger', onClick: () => { delPanel.style.display = ''; delStage1.style.display = 'none'; confirmDel.focus(); } }, 'Delete split');
  const cancelDel = $('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { delPanel.style.display = 'none'; delStage1.style.display = ''; delStage1.focus(); } }, 'Cancel');
  const confirmDel = $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: () => {
    const removed = state.entries.filter(x => x.splitId === splitId).map(x => ({ ...x }));
    state.entries = state.entries.filter(x => x.splitId !== splitId);
    tombstoneIds(removed.map(x => x.id));
    persist();
    trackAction(() => {
      state.entries.push(...removed);
      state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      untombstoneIds(removed.map(x => x.id));
      persist();
    }, 'Deleted split payment', removed);
    toast('Split payment deleted.');
    close();
  } }, 'Confirm delete');
  const delPanel = $('div', { style: 'display:none;margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--accent-soft);' },
    $('p', { class: 'serif', style: 'font-size:16px;margin:0 0 12px;color:var(--negative);' }, 'Delete this split payment? You can undo it.'),
    $('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' }, cancelDel, confirmDel),
  );
  modal.appendChild($('div', { style: 'margin-top:24px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px;' }, delStage1));
  modal.appendChild(delPanel);

  updateTotal();
  queueMicrotask(() => modal.querySelector('input, select')?.focus());
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
    if (ev.key === 'Escape') { if (!isTopModal(bg)) return; ev.preventDefault(); close(); return; }
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
      $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:28px;' }, 'Sync'),
      $('button', { type: 'button', class: 'btn-link', onClick: close, 'aria-label': 'Close' }, 'Close'),
    ));

    modal.appendChild($('p', { class: 'serif', style: 'color:var(--ink);margin:0 0 8px;font-size:17px;' },
      s.enabled
        ? (s.lastError ? 'Connection issue.' : status.label + '.')
        : 'Sync is off. Paste your password and save.',
    ));
    if (s.lastError) {
      modal.appendChild($('p', { style: 'font-size:13px;color:var(--negative);margin:0 0 18px;font-family:"Space Grotesk",sans-serif;' }, 'Last error: ', s.lastError));
    }

    // Endpoint + password form
    const endpointInput = $('input', { type: 'text', value: s.endpoint, 'aria-label': 'Sync endpoint URL', placeholder: DEFAULT_SYNC_ENDPOINT, autocomplete: 'off' });
    const passwordInput = $('input', { type: 'password', value: s.password || '', 'aria-label': 'App password', placeholder: 'the password you set on the Worker', autocomplete: 'new-password' });

    const saveBtnLabel = $('span', null, 'Save & test');
    const saveBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: async () => {
      const newEndpoint = (endpointInput.value || '').trim();
      const typedPassword = passwordInput.value || '';
      // Trimmed here as well as on load, exactly as the endpoint beside it always
      // was: a paste that carries a trailing space can never match — the server
      // compares bytes — and the field is a password field, so the difference is
      // invisible while it is being re-saved faithfully.
      const newPassword = typedPassword.trim();
      // Refuse weak passwords up front: the same credential gates the cloud
      // copy, and the proxy no longer accepts short ones.
      if (newPassword && newPassword.length < 8) {
        toast('The app password must be at least 8 characters.');
        queueMicrotask(() => modal.querySelector('#sync-password')?.focus());
        return;
      }
      saveBtn.disabled = true;
      saveBtnLabel.textContent = 'Testing…';
      const r = await syncTestConnection(newEndpoint, newPassword);
      saveBtn.disabled = false;
      saveBtnLabel.textContent = 'Save & test';
      if (r.ok) {
        patchSyncSettings({ endpoint: newEndpoint, password: newPassword, enabled: true, lastError: null, lastErrorAt: null });
        // Start background reconciliation immediately so data flows both ways
        // as soon as the connection is established.
        startSyncPolling();
        silentSyncPoll();
        // Say so when the stored value is not quite what was typed: silently
        // keeping a different string than the one on screen is how the next
        // "the password is right and it still fails" starts.
        toast(newPassword === typedPassword ? 'Connected.' : 'Connected. Saved without the space at the end — a password is compared exactly.');
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
        const r = await syncPull();
        pullBtn.disabled = false; pushBtn.disabled = false;
        pullLabel.textContent = 'Pull';
        // Merge-based: unions local and cloud, never wholesale-replaces.
        await applyReconcile(r, {});
        renderBody();
        } finally {
          syncExclusive = false;
        }
      } }, pullLabel);

      const pushBtn = $('button', { type: 'button', class: 'btn btn-primary', onClick: async () => {
        if (syncInFlight || syncExclusive) { toast('A sync is already in progress.'); return; }
        pullBtn.disabled = true; pushBtn.disabled = true;
        pushLabel.textContent = 'Pushing…';
        // doPushNow handles conflict recovery itself (pull, merge, retry).
        await doPushNow('cents: manual push');
        pullBtn.disabled = false; pushBtn.disabled = false;
        pushLabel.textContent = 'Push';
        renderBody();
      } }, pushLabel);

      modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;padding-top:18px;border-top:1px solid var(--line);' }, pullBtn, pushBtn));

      if (s.lastSyncAt) {
        modal.appendChild($('p', { class: 'serif', style: 'color:var(--muted);font-size:15px;margin-top:14px;' },
          `Last sync ${relativeTime(s.lastSyncAt)}.`,
        ));
      }
      if (s.repoLabel) {
        modal.appendChild($('p', { class: 'muted', style: 'font-size:12px;margin-top:4px;font-family:"IBM Plex Mono",Menlo,monospace;' }, 'Repo: ', s.repoLabel));
      }

      // One-tap onboarding for other devices: a link that configures sync
      // without typing the password. The link carries a signed, expiring
      // setup token minted on demand by the Worker — never the raw
      // password — so nothing secret sits in the address bar or access logs.
      if (s.password) {
        const linkInput = $('input', { type: 'text', readonly: true, value: '', placeholder: 'Tap Copy to generate a link', 'aria-label': 'Sync setup link', style: 'font-size:11px;font-family:"IBM Plex Mono",Menlo,monospace;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius);width:100%;min-width:0;color:var(--muted);background:var(--bg-deep);' });
        const copyBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 10px;font-size:11px;flex-shrink:0;', onClick: async () => {
          if (copyBtn.disabled) return;
          copyBtn.disabled = true;
          const originalLabel = copyBtn.textContent;
          copyBtn.textContent = 'Generating…';
          let link = null;
          try {
            const r = await syncIssueSetupToken();
            if (r.ok) {
              const isDefaultEndpoint = isDefaultSyncEndpoint(s.endpoint);
              // The token from the proxy already carries its own 't2.' prefix.
              const payload = isDefaultEndpoint ? r.token : `${s.endpoint}|${r.token}`;
              link = `${location.origin}${location.pathname}?centsSync=${encodeURIComponent(payload)}`;
            } else {
              toast('Could not create a setup link' + (r.message ? `: ${r.message}` : '') + '.');
            }
          } finally {
            copyBtn.disabled = false;
            copyBtn.textContent = originalLabel;
          }
          if (!link) return;
          linkInput.value = link;
          // Race the clipboard against a short timeout: a browser that
          // neither grants nor rejects the write (permission hang) must
          // still produce feedback, with the link pre-selected so a manual
          // copy is one tap away either way.
          let copied = false;
          try {
            await Promise.race([
              navigator.clipboard.writeText(link),
              new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 900)),
            ]);
            copied = true;
          } catch { copied = false; }
          linkInput.select();
          toast(copied
            ? 'Setup link copied - open it on your other device. It works once and expires after 30 days.'
            : 'Copy the link above to use on your other device.');
        } }, 'Copy');
        modal.appendChild($('div', { style: 'margin-top:24px;padding-top:18px;border-top:1px solid var(--line);' },
          $('div', { class: 'eyebrow' }, 'Add another device'),
          $('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 10px;' }, 'Open this link on your other device and sync starts automatically - no password to type. Each link works once, so generate a fresh one per device. Anyone with an unused link can read and write your synced data, so keep it private. Links expire after 30 days.'),
          $('div', { style: 'display:flex;gap:8px;align-items:center;' }, linkInput, copyBtn),
        ));
      }

      modal.appendChild($('div', { style: 'margin-top:24px;padding-top:18px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;' },
        $('span', { class: 'muted', style: 'font-size:12px;font-family:"Space Grotesk",sans-serif;' }, 'Disconnect to wipe sync settings from this device.'),
        $('button', { type: 'button', class: 'btn btn-danger', onClick: () => {
          // Stop queued automatic pushes before removing credentials. A pending
          // timer must not revive a disconnected sync if the user reconnects
          // quickly; an in-flight request is protected by revision checks.
          cancelScheduledSyncPush();
          stopSyncPolling();
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

/** Pulse - the dashboard's single "how am I doing?" block.
    It merges the old morning digest, cash runway, financial pulse and spending
    forecast cards into one glance: a headline number, the key figures, and a
    tap-through to Insights for the full picture. */
/**
 * The dashboard's Pulse for a ledger with nothing in it.
 *
 * Every figure on the real pulse is zero on day one, and painting zeros as
 * status is what made a fresh install look like an emergency: a red "watch
 * out", "0/5 paid", empty gift cards, "Vouchers €0.00". A new user gets the
 * three things that actually start the app instead, in the order they matter.
 */
function getStartedCard() {
  const hasCheckpoint = Object.values(state.settings.balanceCheckpoints || {})
    .some(points => Array.isArray(points) && points.length > 0);
  const hasRecurring = Array.isArray(state.settings.recurring) && state.settings.recurring.length > 0;
  const step = (index, text, hint, action) => $('div', {
    style: 'display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--line);',
  },
    $('span', {
      'aria-hidden': 'true',
      style: `width:22px;height:22px;flex-shrink:0;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;border:1px solid var(--line);color:var(--muted);`,
    }, String(index)),
    $('div', { style: 'flex:1;min-width:0;' },
      $('div', { style: 'font-size:13px;font-weight:600;' }, text),
      $('div', { class: 'muted', style: 'font-size:12px;margin-top:1px;' }, hint),
    ),
    action || null,
  );
  return $('div', { class: 'card financial-pulse', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'pulse-heading' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Pulse'),
        $('div', { style: 'display:flex;align-items:baseline;gap:8px;margin-top:6px;' },
          $('span', { class: 'serif', style: `font-size:${isNarrow() ? '24px' : '28px'};line-height:1.1;color:var(--muted);` }, 'Getting started'),
        ),
        $('div', { class: 'muted', style: 'font-size:13px;margin-top:4px;' }, 'Three things and this screen fills itself in.'),
      ),
      $('span', { class: 'pulse-status', style: 'color:var(--muted);border-color:var(--muted);' }, 'New'),
    ),
    step(1, 'Add your first entry', 'Quick entry takes an amount and a note.',
      tabVisible('add') ? $('a', { href: '#add', class: 'btn btn-primary', style: 'padding:7px 14px;font-size:12px;flex-shrink:0;' }, 'Add entry') : null),
    step(2, 'Set your main balance', hasCheckpoint ? 'Reconciled - edit it any time.' : 'What is actually in the account today.',
      tabVisible('balances') ? $('a', { href: '#balances', class: 'btn btn-ghost', style: 'padding:7px 14px;font-size:12px;flex-shrink:0;' }, hasCheckpoint ? 'Edit' : 'Set balance') : null),
    step(3, 'Add a recurring bill', hasRecurring ? 'Rent and subscriptions are on the list.' : 'Rent, subscriptions - the charges that arrive on schedule.',
      $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:7px 14px;font-size:12px;flex-shrink:0;', onClick: () => openRecurringManager() }, hasRecurring ? 'Edit' : 'Add a bill')),
  );
}

function dashboardPulse(key, expenseSum, runningBalance) {
  const t = today();
  const todays = state.entries.filter(e => e.date === t && e.type !== 'note');
  const spentToday = todays.filter(isBudgetSpendingEntry).reduce((s, e) => s + e.amount, 0);
  const earnedToday = todays.filter(isBudgetIncomeEntry).reduce((s, e) => s + e.amount, 0);
  const todaySummary = todays.length
    ? `${todays.length} entr${todays.length === 1 ? 'y' : 'ies'}${spentToday ? ' · −' + fmt(spentToday) : ''}${earnedToday ? ' · +' + fmt(earnedToday) : ''}`
    : 'nothing yet';

  // Nothing recorded yet: the checklist, never the alarm below.
  if (!state.entries.length) return getStartedCard();

  const items = [];
  for (const r of state.settings.recurring || []) for (const date of upcomingOccurrences(r)) items.push({ rec: r, date });
  items.sort((a, b) => a.date.localeCompare(b.date));
  const next = items[0] || null;

  const runway = computeRunway(runningBalance);
  const forecast = spendingForecast(key);
  const comparison = monthComparison(key);
  // Safe to spend today: what's left of the budget divided by the days left
  // in the month. The one number that changes daily behaviour.
  const monthBudget = +state.settings.monthlyBudget || 0;
  const nowP = new Date();
  const daysLeftInMonth = Math.max(1, new Date(nowP.getFullYear(), nowP.getMonth() + 1, 0).getDate() - nowP.getDate() + 1);
  const remainingBudget = Math.max(0, monthBudget - expenseSum);
  const safeToday = monthBudget ? remainingBudget / daysLeftInMonth : null;

  // One headline: the single most important number, plus a plain sentence.
  let headline, caption, message, tone, status;
  if (runningBalance <= 0) {
    headline = fmt(0); caption = 'balance';
    message = 'Your balance is at or below zero.';
    tone = 'var(--negative)'; status = 'Watch out';
  } else if (runway.dailyAvg > 0 && runway.daysToZero !== null && runway.daysToZero <= 30) {
    headline = `${Math.max(1, runway.daysToZero)} days`; caption = 'to €0';
    message = 'At your current pace.';
    tone = 'var(--negative)'; status = 'Watch out';
  } else if (forecast.projectedReady && forecast.budget && forecast.projected > forecast.budget) {
    headline = `${Math.round((forecast.projected / forecast.budget) * 100)}%`; caption = 'of budget';
    message = `Projected ${fmt(forecast.projected)} against ${fmt(forecast.budget)}.`;
    tone = 'var(--negative)'; status = 'Over budget';
  } else if (forecast.budget && forecast.projectedReady) {
    headline = fmt(Math.max(0, forecast.remaining)); caption = 'left this month';
    message = 'You are comfortably within budget.';
    tone = 'var(--positive)'; status = 'On track';
  } else {
    headline = fmt(runningBalance); caption = 'balance';
    message = forecast.budget ? 'Projection starts after a week of entries.' : 'Set a monthly budget to see your pace.';
    tone = 'var(--muted)'; status = 'Tracking';
  }

  // Work this week, at a glance: the hours a rota has put in and the gross pay
  // they earn. Summed over the same Sunday→Saturday pay week the Tesco tab
  // uses, so this pill and that tab's week card always agree.
  let tescoWeek = null;
  if (((state.tesco && state.tesco.shifts) || []).length) {
    const rates = { ...TESCO_RATE_DEFAULTS, ...(state.settings.tescoRates || {}) };
    const weekStart = weekStartOf(t);
    let hours = 0, pay = 0;
    for (const s of state.tesco.shifts) {
      if (weekStartOf(s.date) !== weekStart) continue;
      const p = shiftPay(s, rates);
      if (p) { hours += p.hours; pay += p.gross; }
    }
    tescoWeek = stat('Tesco week', `${r2(hours)}h · ${fmt(r2(pay))}`,
      hours > 0 ? 'var(--positive)' : '');
  }

  return $('div', { class: 'card financial-pulse', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'pulse-heading' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Pulse'),
        $('div', { style: 'display:flex;align-items:baseline;gap:8px;margin-top:6px;' },
          $('span', { class: 'serif', style: `font-size:${isNarrow() ? '24px' : '28px'};line-height:1.1;color:${tone};` }, headline),
          $('span', { class: 'muted', style: 'font-size:13px;' }, caption),
        ),
        $('div', { class: 'muted', style: 'font-size:13px;margin-top:4px;' }, message),
      ),
      $('span', { class: 'pulse-status', style: `color:${tone};border-color:${tone};` }, status),
    ),
    $('div', { class: 'pulse-grid' },
      stat('Runway', runway.dailyAvg > 0 && runway.daysToZero !== null ? `${runway.daysToZero} days` : '-', null, 'Days until today\u2019s balance runs out at your current daily pace. Fixed charges like rent are spent, not repeated.'),
      stat('Spent', fmt(forecast.spent), 'var(--negative)', 'Everything this month that counts against your budget.'),
      stat('Projected', forecast.projected === null ? '\u00b7' : fmt(forecast.projected), 'var(--negative)', 'Where the month lands at your current pace. Shown once there is a week of entries to read.'),
      forecast.budget && forecast.projectedReady ? stat('Remaining', fmt(forecast.remaining)) : stat('Balance', fmt(runningBalance)),
      monthBudget ? stat('Safe today', fmt(safeToday), remainingBudget <= 0 ? 'var(--negative)' : '', 'What is left of this month\u2019s budget, shared over the days left in it.') : null,
      stat('Avg / day', fmt(forecast.dailyAverage), 'var(--negative)', 'This month\u2019s variable spending divided by the days elapsed \u2014 fixed bills left out.'),
      monthBudget && expenseSum > 0 && forecast.projectedReady ? stat('Burn rate', (() => {
        const pctProj = Math.round((forecast.projected / monthBudget) * 100);
        return pctProj > 100 ? $('span', { style: 'display:inline-flex;align-items:center;gap:5px;' }, iconSpan('alert', 'md'), `${pctProj}%`) : `${pctProj}%`;
      })(), null, 'This month projected at your current pace, as a share of your budget.') : null,
      tescoWeek,
    ),
    $('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 20px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);' },
      $('span', null, 'Today ', $('span', { style: 'color:var(--ink);' }, todaySummary)),
      $('span', null, 'Next due ', $('span', { style: 'color:var(--ink);' }, next ? `${next.rec.details}${daysUntil(next.date) === 0 ? ' today' : ` in ${daysUntil(next.date)}d`}` : '-')),
    ),
    comparison.proratedPrevious > 0 ? $('div', { class: 'pulse-footnote muted' },
      `${comparison.difference <= 0 ? 'Down' : 'Up'} ${fmt(Math.abs(comparison.difference))} vs ${monthLabel(comparison.previousKey)} to date.`,
    ) : null,
    tabVisible('insights') ? $('a', { href: '#insights', class: 'btn-link', style: 'margin-top:10px;font-size:13px;' }, 'See details ', iconSpan('arrow-right', 'sm')) : null,
  );
}

// ---------- toast ----------
// Toasts stack instead of replacing each other, so a later action can't wipe
// out an earlier toast's Undo button. The undo action is snapshotted at
// creation time (not looked up when clicked), and the stack is capped so a
// rapid burst can't pile up forever.
const MAX_TOASTS = 3;
// durationMs is optional and only for a notice that has to be read rather than
// glimpsed (see the mirror gap's own toast): everything else keeps the defaults,
// which is what keeps a toast from becoming a banner nobody dismisses.
function toast(text, undoFn, undoLabel, durationMs) {
  let host = document.querySelector('.toast-host');
  if (!host) { host = $('div', { class: 'toast-host' }); document.body.appendChild(host); }
  // Snapshot the undo at creation: an explicit undoFn wins, otherwise capture
  // the currently-tracked action so an old toast never undoes a newer one.
  const tracked = _undoStack[0];
  const runUndo = undoFn || (tracked ? () => undoAction(tracked) : null);
  const children = [text];
  if (runUndo) {
    children.push($('button', { type: 'button', class: 'toast-undo', onClick: () => { runUndo(); t.remove(); } }, undoLabel || (runUndo ? 'Undo' : '')));
  }
  const t = $('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, ...children);
  host.appendChild(t);
  while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();
  // Toasts carrying an Undo button stay long enough to read and act on;
  // plain notifications dismiss quickly.
  setTimeout(() => t.remove(), durationMs || (runUndo ? 5000 : 2200));
}

// ── Swipe-to-dismiss (Android-style) ─────────────────────────────────────────
// Any home-screen notification card can be swiped away horizontally. The page
// keeps vertical scrolling (touch-action: pan-y); only a horizontal drag moves
// the card. A drag past ~a third of the card's width animates it off-screen and
// fires onDismiss once; anything less springs back. Taps on the card's own
// links/buttons still work - only a real dismissal suppresses the click it
// would otherwise trigger.
function attachSwipeDismiss(el, onDismiss) {
  el.style.touchAction = 'pan-y';
  let startX = 0, startY = 0, dx = 0, dragging = false, dismissed = false, activePointerId = null;
  const threshold = () => Math.max(90, el.offsetWidth * 0.32);
  const setX = (x, animate) => {
    el.style.transition = animate ? 'transform .3s cubic-bezier(0.2,0.8,0.2,1), opacity .3s ease' : 'none';
    el.style.transform = `translateX(${x}px)`;
    el.style.opacity = String(Math.max(0, 1 - Math.abs(x) / (el.offsetWidth * 1.3)));
  };
  const springBack = () => {
    setX(0, true);
    setTimeout(() => { el.style.opacity = ''; dx = 0; dragging = false; }, 300);
  };
  const resetInline = () => {
    el.style.transition = 'none';
    el.style.transform = '';
    el.style.opacity = '';
    dx = 0; dragging = false;
  };
  const cleanup = () => {
    activePointerId = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', cancel, true);
  };
  const cancel = () => { resetInline(); cleanup(); };
  const onMove = e => {
    if (e.pointerId !== activePointerId) return;
    const curX = e.clientX - startX, curY = e.clientY - startY;
    if (!dragging) {
      // Not a horizontal drag yet - let taps and vertical scroll through.
      if (Math.abs(curX) < 6 || Math.abs(curY) > Math.abs(curX)) return;
      dragging = true;
    }
    dx = curX;
    setX(dx, false);
  };
  const release = () => {
    if (!dragging) { cleanup(); return; }
    dragging = false;
    if (Math.abs(dx) > threshold()) {
      dismissed = true;
      setX((el.offsetWidth + 60) * (dx >= 0 ? 1 : -1), true);
      setTimeout(() => { if (el.parentNode) el.remove(); onDismiss(); }, 280);
    } else {
      springBack();
    }
    cleanup();
  };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY; dx = 0; dragging = false; dismissed = false;
    // Track on window during the drag: the finger can leave the card, and this
    // keeps working even when the browser hasn't granted implicit capture.
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
  });
  // A real swipe ending on the card's link/button must not activate it.
  el.addEventListener('click', e => {
    if (dismissed) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// Notification dismissals are device-local (like a phone's notification shade)
// and never sync. An alert
// stays dismissed while its condition holds and re-arms automatically once the
// condition clears, so a genuinely new event notifies again.
const ALERT_DISMISS_KEY = () => nsKey('alerts');
function readAlertDismissals() {
  try { return JSON.parse(localStorage.getItem(ALERT_DISMISS_KEY())) || {}; } catch { return {}; }
}
function alertDismissed(id) {
  return !!readAlertDismissals()[id];
}
function setAlertDismissed(id, dismissed) {
  const map = readAlertDismissals();
  if (dismissed) map[id] = true; else delete map[id];
  try { localStorage.setItem(ALERT_DISMISS_KEY(), JSON.stringify(map)); } catch {}
}

// ---------- the Tesco tab's folded cards ----------
// tesco.js decides WHAT is folded and asks for nothing else: browser storage is
// off limits there (check-image-hygiene pins that the roster-photo module
// never touches localStorage), and this choice is a view preference anyway —
// device-local, never part of the synced document.
const TESCO_FOLD_PREFIX = 'cents:tesco-fold:';
function foldGet(id, fallback) {
  try {
    const raw = localStorage.getItem(TESCO_FOLD_PREFIX + id);
    if (raw !== null) return raw === '1';
  } catch { /* storage unavailable: fall back to the default */ }
  return fallback;
}
function foldSet(id, open) {
  try { localStorage.setItem(TESCO_FOLD_PREFIX + id, open ? '1' : '0'); } catch { /* ignore */ }
}

// Offer the persisted undo journal after a reload. The toast is transient, but
// the journal is kept until it is actually undone (or superseded) so the
// persistent Undo button keeps offering it after the toast expires.
function offerPersistedUndo() {
  // Walk spent records off the front first: one whose data is already back in
  // the document must not go on hiding the action behind it on every reload.
  let journal = loadUndoJournal();
  while (journal && (journal.entries?.length || journal.checkpoints?.length)) {
    const missing = missingJournalData(journal);
    if (missing.entries.length || missing.checkpoints.length) break;
    popUndoJournal();
    journal = loadUndoJournal();
  }
  if (!journal || !(journal.entries?.length || journal.checkpoints?.length)) return;
  toast(`You can undo “${journal.label || 'that change'}” from before your last reload.`, () => {
    restoreUndoJournal(journal);
    toast(`Undone: ${journal.label || 'that change'}`);
    dropUndoJournal(journal);
    render();
  }, 'Undo');
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
  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    renderFrame = null;
    libCleanup(); // destroy stale vendor-widget instances (flatpickr / tippy / sortable) before re-render
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
      bg: isDark ? '#101210' : '#F5F5F2',
      card: isDark ? '#171A17' : '#FFFFFF',
      line: isDark ? '#272B26' : '#E3E3DC',
      ink: isDark ? '#E8EBE5' : '#161712',
      muted: isDark ? '#8C928A' : '#6E6E67',
      soft: isDark ? '#1C2A20' : '#E9F2EC',
      softBorder: isDark ? '#2E3D33' : '#BFD6C9',
      kbdBg: isDark ? '#161916' : '#ECECE7',
      shadow: isDark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.08)',
    };
    mount.innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;background:' + c.bg + ';font-family:&quot;Space Grotesk&quot;,system-ui,sans-serif;z-index:9999;">' +
        '<div style="max-width:560px;padding:32px 36px;border:1px solid ' + c.line + ';border-radius:16px;background:' + c.card + ';line-height:1.55;font-size:14px;box-shadow:0 8px 32px ' + c.shadow + ';">' +
          '<div style="font-family:&quot;Space Grotesk&quot;,system-ui,sans-serif;font-size:22px;color:' + c.ink + ';">cents.</div>' +
          '<h1 style="font-family:&quot;Space Grotesk&quot;,system-ui,sans-serif;font-weight:600;font-size:28px;margin:4px 0 8px;">Render crashed.</h1>' +
          '<div style="margin:12px 0 16px;padding:10px 12px;background:' + c.soft + ';border:1px solid ' + c.softBorder + ';border-radius:8px;font-size:12px;">' +
            '<span style="color:' + c.muted + ';font-family:&quot;Space Grotesk&quot;,system-ui,sans-serif;">Error</span>' +
            '<code style="display:block;margin-top:4px;font-size:11px;word-break:break-word;white-space:pre-wrap;line-height:1.4;">' + errText + '</code>' +
          '</div>' +
          '<ol style="padding-left:22px;margin:12px 0 0;"><li>Copy the error above.</li><li>Hard refresh - <kbd style="background:' + c.kbdBg + ';padding:1px 6px;border-radius:4px;border:1px solid ' + c.line + ';font-family:ui-monospace,monospace;font-size:12px;">Ctrl</kbd>+<kbd style="background:' + c.kbdBg + ';padding:1px 6px;border-radius:4px;border:1px solid ' + c.line + ';font-family:ui-monospace,monospace;font-size:12px;">Shift</kbd>+<kbd style="background:' + c.kbdBg + ';padding:1px 6px;border-radius:4px;border:1px solid ' + c.line + ';font-family:ui-monospace,monospace;font-size:12px;">R</kbd></li></ol>' +
        '</div>' +
      '</div>';
      // Also log so we can see it in DevTools
      console.error('Render crashed:', e);
    }
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flush);
  // Watchdog: rAF can be throttled or blocked outright (occluded iframe,
  // background tab, embedded webview), which would silently freeze every
  // subsequent navigation since render only ever flushed on the animation
  // frame. Keep a short timer as a guaranteed flush - whichever fires first
  // wins, and the `flushed` guard keeps it idempotent.
  renderFrame = window.setTimeout(flush, 24);
}

/**
 * A route change, and it goes straight through: one render, on the next frame.
 *
 * This used to hand the change to the View Transitions API, which cross-faded
 * the old screen up and out over 180/220ms. That was the stutter. A transition
 * costs MORE than its animation: the browser will not call the update callback
 * until it has captured the old state, and capturing needs a compositor frame,
 * so a document that cannot produce one waits out the whole fallback budget
 * before drawing the next screen at all. Measured on a webview that was not
 * compositing: every tab switch took ~270ms, ~250 of them the budget, against
 * ~20ms for the same navigation with no transition. It was slow where the API
 * could not be used and animated everywhere else, and the fix for both is the
 * same one: do the render and be done.
 *
 * The entrance animations that used to carry a route change are gone with it.
 * Nothing here is deferred, animated, or awaited, and the screen is never
 * captured mid-swap, so what a tab switch costs is the render itself.
 */
function renderRoute() {
  render();
}

function _render() {
  const main = document.getElementById('app');
  if (!main) return;
  const focusedField = captureFocusedField();
    // Init the theme on first render - light is the default
  if (!document.documentElement.dataset.themeInit) {
    document.documentElement.dataset.themeInit = '1';
    try {
      const saved = localStorage.getItem('cents-theme');
      document.documentElement.dataset.theme = saved === 'dark' ? 'dark' : '';
    } catch(e) {}
  }
  // Keep the app mount completely empty while locked. The PIN overlay is
  // deliberately mounted before the first render, so a refresh never paints
  // financial UI behind it or briefly exposes the header/navigation.
  const locked = hasPinLock() && !pinUnlocked;
  const scrollY = window.scrollY;
  main.innerHTML = '';
  // inert (not aria-hidden): if focus ever lands inside the locked mount the
  // browser would otherwise warn about hiding a focused element, and inert
  // additionally blocks programmatic focus from re-entering it.
  main.toggleAttribute('inert', locked);
  if (locked) return;
  main.removeAttribute('inert');
  main.appendChild(renderHeader());
  // The header carries the sync indicator, so repaint it once its node is in
  // the document — a route change would otherwise blank it until the next event.
  renderSyncIndicator();

  const route = currentRoute();
  // The History table gets the full window width on desktop (>=1024px) so all
  // columns fit without horizontal scrolling; every other route keeps the
  // 980px reading column. The attribute drives .shell/.history-row overrides
  // and the footer width in styles.css.
  if (route === 'history' && window.matchMedia && window.matchMedia('(min-width: 1024px)').matches) {
    document.body.setAttribute('data-wide', '');
  } else {
    document.body.removeAttribute('data-wide');
  }
  // Whether this render is a route change or a repaint of the screen already up.
  // It no longer decides an animation — a route change animates nothing — only
  // where the page sits and who holds focus once it has drawn.
  const routeChanged = route !== lastRenderedRoute;
  lastRenderedRoute = route;
  const screen = $('main', { class: 'shell screen', id: 'screen', tabindex: '-1' });
  // Each route needs a heading: the pages label their sections with .eyebrow
  // text, so the document otherwise had no outline to navigate by. Visually
  // hidden, and it doubles as the skip link's landing target.
  screen.appendChild($('h1', { class: 'sr-only' }, titleFor(route)));
  switch (route) {
    case 'add':      screen.appendChild(screenAdd()); break;
    case 'history':  screen.appendChild(screenHistory()); break;
    case 'balances': screen.appendChild(screenBalances()); break;
    case 'tesco': {
      const tesco = tescoScreen();
      if (tesco) {
        screen.appendChild(tesco.screenTesco({
          // loadVendor is handed over too: the workbook import in the Tesco data
          // card is the one thing in tesco.js that fetches a library of its own
          // (SheetJS).
          getState: () => state, $, iconSpan, toast, persist, render, trackAction, swalConfirm, fmt, stackModal, isTopModal, loadVendor,
          // Which of its cards are folded, read and written by app.js (see
          // foldGet): tesco.js itself never touches browser storage.
          foldGet, foldSet,
          // The ledger's half of a Tesco commit: recording a week's pay writes
          // its Balances entry in the same undo step (see the function above).
          recordTescoPayToLedger,
        }));
      } else {
        screen.appendChild(tescoLoadingCard());
      }
      break;
    }
    case 'insights': {
      const insights = insightsScreen();
      screen.appendChild(insights ? insights.screenInsights() : insightsLoadingCard());
      break;
    }
    default:         screen.appendChild(screenDashboard());
  }
  main.appendChild(screen);

  // Bottom tab bar on mobile
  const route2 = currentRoute();
  const tabIconSVG = (id) => {
    const icons = {
      dashboard: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
      add: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>' },
      history: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>' },
      insights: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="3" width="4" height="18"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z"/></svg>' },
      balances: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h12"/><path d="M20 7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7"/><rect x="16" y="11" width="4" height="5" rx="1"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M4 4h14a3 3 0 0 1 3 3v1h-4.5a2.5 2.5 0 0 0 0 5H21v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 1-2.2A3 3 0 0 1 4 4z"/><rect x="14" y="10" width="4" height="2" rx="1"/></svg>' },
      tesco: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/><path d="M3 12.5h18"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M9 4h6a3 3 0 0 1 2.83 2H8.5A2.5 2.5 0 0 0 6 8.5V19H5a2 2 0 0 1-2-2V6.5A1.5 1.5 0 0 1 4.5 5H6a3 3 0 0 1 3-1z"/><rect x="7" y="8" width="14" height="12" rx="2"/></svg>' },
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
    { id: 'balances', label: 'Balances' },
    { id: 'tesco', label: 'Tesco' },
    { id: 'insights', label: 'Insights' },
  ].filter(t => tabVisible(t.id));
  main.appendChild($('nav', { class: 'bottom-tab-bar', 'aria-label': 'Mobile navigation' },
    ...tabItems.map(t => $('a', { href: `#${t.id}`, class: 'bottom-tab', 'aria-current': t.id === route2 ? 'page' : null },
      tabIconSVG(t.id),
      $('span', null, t.label),
    )),
  ));

  // Focus the Add form only when navigation created it. Same-route renders
  // restore the user's existing field/caret instead, so typing never jumps.
  if (routeChanged && route === 'add') {
    const form = main.querySelector('[data-route-initial-focus="true"]');
    const target = form?.querySelector(`#${form.dataset.firstFocus || 'f-amount'}`);
    target?.focus({ preventScroll: true });
  }

  main.appendChild($('footer', { style: 'max-width:var(--shell-max,980px);margin:0 auto;padding:32px 28px 64px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;border-top:1px solid var(--line);' },
    $('span', null, String(state.entries.length), ` entr${state.entries.length === 1 ? 'y' : 'ies'} \u00b7 `, getSyncSettings().enabled ? 'cloud-synced' : 'stored locally'),
    $('span', { style: 'display:flex;justify-content:flex-end;flex-wrap:wrap;gap:0 8px;align-items:center;' },
      $('button', { type: 'button', class: 'footer-action', onClick: () => {
        const startY = window.scrollY;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Some embedded webviews have smooth scrolling disabled and silently
        // ignore the options form of scrollTo; jump instantly when nothing
        // started moving.
        setTimeout(() => { if (window.scrollY === startY && startY > 0) window.scrollTo(0, 0); }, 80);
      } }, iconSpan('arrow-up', 'sm'), 'Top'),
    ),
  ));

  // Persistent undo button (fixed position; hidden when nothing is reversible).
  const undoFab = renderUndoFab();
  if (undoFab) main.appendChild(undoFab);

  // Route changes should land at the top of the page; only same-route
  // re-renders restore the user's scroll position.
  window.scrollTo(0, routeChanged ? 0 : scrollY);
  // Rebuilding a same-route screen should not make typing/searching lose focus
  // or move the caret. Newly opened forms still manage their own initial focus.
  if (!routeChanged) restoreFocusedField(focusedField);

  // Sticky header - register the scroll listener once. The header is rebuilt on
  // every render, so the cached element is refreshed here on each render. The
  // handler is rAF-throttled and only touches the DOM when the state changes.
  if (!window.__stickyInit) {
    window.__stickyInit = true;
    let lastScroll = 0;
    let rafId = null;
    const applySticky = () => {
      rafId = null;
      const hdr = window.__stickyHdr;
      if (!hdr || !hdr.isConnected) return;
      // Idempotent: classList.toggle with a boolean is a DOM no-op when the
      // class already matches, so this still only touches the DOM on change.
      // is-sticky is always ensured - the header is rebuilt on every render
      // and the fresh element never has it.
      if (!hdr.classList.contains('is-sticky')) hdr.classList.add('is-sticky');
      const now = window.scrollY;
      hdr.classList.toggle('head-hidden', now > 80 && now > lastScroll);
      lastScroll = now;
    };
    window.addEventListener('scroll', () => {
      const hdr = window.__stickyHdr;
      if (!hdr || !hdr.isConnected) {
        window.__stickyHdr = document.querySelector('.app-header');
        if (!window.__stickyHdr) return;
        if (!window.__stickyHdr.classList.contains('is-sticky')) window.__stickyHdr.classList.add('is-sticky');
      }
      if (rafId === null) rafId = requestAnimationFrame(applySticky);
    }, { passive: true });
  }
  // Refresh the cached element - the header is rebuilt on every render.
  window.__stickyHdr = document.querySelector('.app-header');
}

// ---- PWA install prompt ----
// Chrome/Edge fire `beforeinstallprompt` once the site is installable. We
// capture it so the in-app "Install app" menu row can trigger the native
// prompt directly (the browser's own install menu stays available too).
let deferredInstallPrompt = null;

function isStandaloneApp() {
  return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true);
}

function canInstallApp() {
  return !!deferredInstallPrompt && !isStandaloneApp();
}

async function promptInstall() {
  if (!deferredInstallPrompt) return;
  const evt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  evt.prompt();
  const choice = await evt.userChoice;
  if (choice && choice.outcome === 'accepted') toast('App installing…');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  toast('App installed.');
});

window.addEventListener('DOMContentLoaded', () => {
  // Tell the inline boot splash to step aside the moment the app is in
  // control - the lock/onboarding overlays mount on <body>, not #app, so
  // "mount has children" can't be the signal. Set before anything renders.
  window.__centsBooted = true;
  // Focus follows every modal, from the moment the first one opens (see
  // syncModalFocusTrap) — installed at boot rather than by each modal, so a modal
  // added later is trapped without remembering to ask.
  wireModalFocusTrap();
  // Android's back gesture closes the top sheet, and a line shared into the app
  // is handed to the Add screen. Both are installed here rather than by the
  // sheets themselves, for the reason the focus trap is: a surface added later
  // is covered without anyone remembering to ask.
  wireBackGesture();
  readSharedText();
  // Ask the browser to keep this origin's storage. A no-op once granted (and
  // silent when the browser has no such API): the ledger is the whole of the
  // app's data, so "best-effort" storage is the one thing worth asking for.
  void requestDurableStorage();
  // ── OTA update flow ──────────────────────────────────────────────
  // A redeploy swaps the served index.html; the service worker notices the
  // changed document and asks open, controlled tabs to reload so they leave
  // the old build behind without waiting for a manual refresh. Reloads are
  // skipped while the user is mid-typing or has an overlay open — those tabs
  // get an "Update ready" toast instead, so the update lands on the next
  // refocus/idle moment rather than being silently deferred forever.
  let updateToastShownAt = 0;
  function isBusyWithWork() {
    return (typeof isTypingInApp === 'function' && isTypingInApp())
      || !!(document.activeElement && /input|textarea|select/i.test(document.activeElement.tagName))
      || !!document.body.querySelector('.modal-bg');
  }
  function handleNewBuildMessage() {
    try {
      if (!document.hidden && !isBusyWithWork()) {
        location.reload();
        return;
      }
      const now = Date.now();
      if (now - updateToastShownAt > 15000) {
        updateToastShownAt = now;
        toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;' }, iconSpan('cloud', 'sm'), 'Update ready — refresh to get the latest version.'));
      }
    } catch (e) {}
  }
  if ('serviceWorker' in navigator) {
    try {
      if (navigator.serviceWorker.addEventListener) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          try {
            if (ev.data && ev.data.type === 'centsNewBuild') handleNewBuildMessage();
          } catch (e) {}
        });
      }
      // Ask the worker to re-diff index.html when the tab comes back into
      // use, plus a slow periodic sweep while visible. PWAs opened from a
      // home-screen icon can run for days without a navigation, so without
      // this a long-lived phone session never sees a redeploy.
      let lastUpdateCheck = 0;
      function askWorkerToCheckForUpdate() {
        if (!navigator.serviceWorker.controller) return;
        lastUpdateCheck = Date.now();
        navigator.serviceWorker.controller.postMessage({ type: 'centsCheckUpdate' });
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > 30000) {
          askWorkerToCheckForUpdate();
        }
      });
      setInterval(() => {
        if (!document.hidden && Date.now() - lastUpdateCheck > 30000) askWorkerToCheckForUpdate();
      }, 60000);
    } catch (e) {}
  }
  // Lock background scroll while any modal (or the pin-lock/onboarding
  // overlay) is open. Each overlay appends a .modal-bg to <body> and removes
  // it on close, so one observer keeps the class in sync without per-modal
  // bookkeeping. SweetAlert2 confirm dialogs (.swal2-container) are covered
  // too - its own body.swal2-shown rule hits the same overflow-propagation
  // trap. The class goes on <html>, not <body>: body already has
  // overflow-x: hidden, which stops its overflow from propagating to the
  // viewport, so a body-level lock never takes effect (mirrors the menu).
  new MutationObserver(() => {
    const open = !!document.body.querySelector('.modal-bg')
      || !!document.body.querySelector('.swal2-container');
    document.documentElement.classList.toggle('modal-open', open);
  }).observe(document.body, { childList: true });
  // Boot: the PIN lock (or first-run onboarding) resolves first. Cloud sync
  // and the persisted-undo offer still start after unlock.
  // First tab stop: moves focus into the screen instead of leaving a keyboard
  // user to tab through the whole header on every navigation.
  const skipLink = document.getElementById('skip-to-main');
  if (skipLink) {
    skipLink.addEventListener('click', () => {
      const target = document.getElementById('screen');
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
  }
  showProfileGate();
  render();
  // Anything the storage layer could not do (an unreadable document) is
  // reported once the UI is up; raiseNotice defers it behind any overlay.
  const storageNotice = takeStorageNotice();
  if (storageNotice) raiseNotice(storageNotice);
  flushNotices();
});

// What the deferred Insights module reaches back for (see the top of
// insights.js). Exported rather than passed in a context object: these are
// plain hoisted declarations, so the circular reference is resolved at link
// time and every binding — `state` especially — stays live.
export {
  $, state, today, fmt, friendlyDate, monthKey, monthLabel, offsetDateKey,
  persist, toast, iconSpan, isTopModal, methodLabel, methodShort, categoryLabel,
  entriesForMonth, catTotalsForEntries, emptyIcon, emptyStateCard,
  heatColor, heatDigitInk, stat, accountBalanceHistory, computeDataHealth,
  duplicateGroups, removeDuplicateEntry, reviewForMonth, wireChartTips,
  wireFlatpickr, isSpendingEntry, isIncomeEntry, isBudgetSpendingEntry,
  isBudgetIncomeEntry,
};

// Expose tiny global for DevTools tinkering
window.__cents = {
  resetToBlank, render, toast,
  initSync, scheduleSyncPush, doAutoPush,
  renderSyncIndicator, openSyncSettings,
  syncPull, syncPush,
  registerBiometric, unlockWithBiometric,
};
