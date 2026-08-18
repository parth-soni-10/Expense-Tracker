/* ============================================================
   Expense Tracker - editorial-minimal SPA
   Hash routing: #dashboard (default) | #add | #history | #balances | #insights
   ============================================================ */
import { loadState, saveState, resetToBlank, exportJSON, validateState, uid, updateAllowedCategories, isValidCheckpointDate, BALANCE_METHOD_IDS, saveUndoJournal, loadUndoJournal, clearUndoJournal } from './storage.js';
import { CATEGORIES, METHODS } from './seed.js';
import { getSyncSettings, patchSyncSettings, clearSyncSettings, getPrivacyPin, setPrivacyPin, clearPrivacyPin, getBiometricCredential, setBiometricCredential, clearBiometricCredential } from './settings.js';
import { syncPull, syncPush, syncTestConnection, syncStatus, relativeTime, notifySyncChange, subscribeSync } from './sync.js';
import { mergeStates } from './sync-merge.js';

// ---------- optional UI libraries (vendor/*) ----------
// Every integration below degrades gracefully: if a vendor file fails to
// load or is missing, the app falls back to its native behaviour. Only
// SweetAlert2 (confirm dialogs, used by every destructive action) is loaded
// eagerly; the rest are fetched lazily on first use so the initial load
// stays light.
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
// synchronous confirm() when SweetAlert2 is unavailable.
function swalConfirm({ title, text, confirmButtonText = 'Yes', cancelButtonText = 'Cancel', danger = false } = {}) {
  if (typeof Swal === 'undefined') return Promise.resolve(window.confirm(text || title));
  return Swal.fire({
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
  }).then(result => result.isConfirmed);
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

// Rich heatmap tooltips via tippy.js delegation. Falls back to the existing
// .heat-tip hover popups when tippy is unavailable. tippy + Popper are
// fetched lazily on first use; the CSS-only fallback covers the interim.
function wireHeatTippy(gridEl) {
  if (!gridEl) return;
  if (typeof tippy !== 'undefined' && typeof Popper !== 'undefined') return _wireHeatTippyNow(gridEl);
  // The tippy bundle reads window.Popper, so load Popper first, then tippy.
  const popperReady = typeof Popper !== 'undefined'
    ? Promise.resolve()
    : loadVendor('popper', { js: 'vendor/popper.min.js' });
  popperReady
    .then(() => loadVendor('tippy', { js: 'vendor/tippy-bundle.umd.min.js' }))
    .then(() => { if (gridEl.isConnected) _wireHeatTippyNow(gridEl); })
    .catch(() => {});
}

function _wireHeatTippyNow(gridEl) {
  if (!gridEl || typeof tippy === 'undefined' || typeof Popper === 'undefined') return;
  gridEl.classList.add('has-tippy'); // suppress the CSS-only .heat-tip fallback
  const inst = tippy(gridEl, {
    delegate: '.heat-cell[data-tip]',
    content: ref => ref.dataset.tip,
    allowHTML: false,
    theme: 'cents',
    placement: 'top',
    arrow: false,
    delay: [120, 40],
    duration: [160, 90],
    animation: 'none',
    appendTo: document.body,
    onShow(instance) { return !!instance.reference.dataset.tip; },
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
}

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
// A boot-time sync setup link cannot toast while the PIN overlay is up
// (it sits above the toast layer), so the message is queued and shown the
// moment the device is unlocked.
let pendingSetupLinkToast = null;
let syncBootStarted = false;
let lastRenderedRoute = null;
let renderFrame = null;

function startInitSync() {
  if (syncBootStarted) return;
  syncBootStarted = true;
  initSync().finally(() => setSyncPulsing(false));
  startSyncPolling();
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

// Site-wide default credential. Every device boots locked and unlocks with
// this built-in PIN ("100901") until a personal PIN is saved on that device.
// It is a plain SHA-256 like the legacy device-hash path, so verification
// needs no salt. By design this is casual-access protection - the default is
// visible in the shipped source.
const DEFAULT_PIN_HASH = '3bc83f9bf0224554bd08d03d598a4c44d7eda855bbf034131e48d1dba72d5d7d'; // SHA-256("100901")
const DEFAULT_PIN_PLAIN = '100901'; // used only when Web Crypto is unavailable (plain-HTTP contexts)

function getPinCredential() {
  const devicePin = getPrivacyPin();
  if (devicePin.hash) return { ...devicePin, isDefault: false };
  const legacyHash = state?.settings?.pinHash;
  if (typeof legacyHash === 'string' && /^[a-f0-9]{64}$/i.test(legacyHash)) {
    return { salt: null, hash: legacyHash.toLowerCase(), isDefault: false };
  }
  return { salt: null, hash: DEFAULT_PIN_HASH, isDefault: true };
}

function hasPinLock() {
  // The privacy lock is always on: every device opens locked, using the
  // built-in "100901" PIN until a personal PIN is set there.
  return true;
}
function hasCustomPin() {
  return !getPinCredential().isDefault;
}

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
  closePinOverlay();
  render();
  startInitSync();
  offerPersistedUndo();
  if (pendingSetupLinkToast) {
    toast(pendingSetupLinkToast);
    pendingSetupLinkToast = null;
  }
}

function showPinLock() {
  if (pinUnlocked || pinOverlay) return;
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
    try {
      if (saved.salt !== null) {
        return (await hashPin(value, saved.salt)) === saved.hash;
      } else if (globalThis.crypto?.subtle) {
        // Plain SHA-256 path (legacy hashes and the built-in default).
        return (await hashPinPlain(value)) === saved.hash;
      } else {
        // No Web Crypto (plain-HTTP context): the built-in default credential
        // is casual protection, so verify it by direct comparison. Personal
        // salted hashes cannot be checked without Web Crypto.
        return saved.isDefault && value === DEFAULT_PIN_PLAIN;
      }
    } catch (err) {
      return false;
    }
  };
  const submit = async () => {
    const value = String(input.value || '').trim();
    if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) { message.textContent = 'Use 4-20 letters or numbers.'; input.focus(); return; }
    if (!(await verifyPin(value))) {
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
  const overlay = $('div', { class: 'modal-bg pin-lock-bg', style: 'z-index:10000;background:rgba(0,0,0,.82);' },
    $('div', { class: 'modal pin-lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Unlock cents', style: 'max-width:360px;text-align:center;' },
      $('div', { class: 'serif', style: 'font-size:32px;margin-bottom:4px;' }, 'cents.'),
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
// checkpoints, no personal PIN). It replaces the old "boot locked with the
// default 100901 PIN and land on a dense dashboard" experience: choose a PIN,
// set a monthly budget, and pick one main account with its opening balance.
// Every step can be skipped, so the flow never blocks access - the app's
// existing defaults stay in place and onboarding is marked complete either way.
function needsOnboarding() {
  if (state.settings.onboarded) return false;
  if (state.entries.length > 0) return false;
  if (hasCustomPin()) return false;
  return !Object.values(state.settings.balanceCheckpoints || {}).some(points => Array.isArray(points) && points.length > 0);
}

function showOnboarding() {
  if (pinUnlocked || pinOverlay) return;
  pinUnlocked = true; // the dashboard renders behind the overlay; no lock screen on first boot

  const inputStyle = 'width:100%;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;padding:12px 14px;font-size:15px;outline:none;transition:border-color .15s;box-sizing:border-box;';
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
    toast('cents. is ready. Add an expense any time.');
  };
  const skip = () => { if (step === 2) finish(); else advance(); };

  const draw = () => {
    setDots();
    if (step === 0) {
      titleEl.textContent = 'Choose your PIN';
      subEl.textContent = 'Locks cents. on this device. Any 4-20 letters or numbers.';
      const pin = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'PIN', 'aria-label': 'New PIN', style: inputStyle, onFocus: focusRing });
      const confirm = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'Repeat PIN', 'aria-label': 'Repeat PIN', style: inputStyle, onFocus: focusRing });
      bodyEl.replaceChildren(field('New PIN', pin), field('Repeat PIN', confirm));
      primaryEl.textContent = 'Continue';
      skipEl.textContent = 'Keep the default PIN';
      primaryEl.onclick = async () => {
        const value = pin.value.trim();
        if (!value) { subEl.textContent = 'Choose a PIN, or tap "Keep the default PIN".'; pin.focus(); return; }
        if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) { subEl.textContent = 'Use 4-20 letters or numbers.'; pin.focus(); return; }
        if (value !== confirm.value.trim()) { subEl.textContent = 'The PINs do not match.'; confirm.focus(); return; }
        try {
          if (!globalThis.crypto?.getRandomValues) throw new Error('no crypto');
          const salt = globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
          if (!setPrivacyPin(await hashPin(value, salt), salt)) { subEl.textContent = 'Could not save the PIN on this device.'; return; }
          if (state.settings?.pinHash) delete state.settings.pinHash;
          advance();
        } catch {
          subEl.textContent = 'PIN security is unavailable in this browser - you can keep the default.';
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
      const select = $('select', { 'aria-label': 'Main account', style: inputStyle });
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
  const custom = hasCustomPin();
  const pin = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: custom ? 'New PIN (leave blank to keep)' : 'Your PIN', 'aria-label': 'New PIN' });
  const confirm = $('input', { type: 'password', maxlength: '20', autocomplete: 'new-password', placeholder: 'Repeat PIN', 'aria-label': 'Repeat PIN' });
  const status = $('p', { class: 'muted', style: 'font-size:12px;min-height:18px;' }, custom ? 'Your PIN is stored as a one-way hash on this device. This protects casual access, not localStorage or DevTools.' : 'The default PIN is 100901 and works on every device. Set a personal PIN here to replace it on this device.');
  const save = async () => {
    const value = pin.value.trim();
    if (!value && custom) { close(); return; }
    if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) { status.textContent = 'Use 4-20 letters or numbers.'; pin.focus(); return; }
    if (value !== confirm.value.trim()) { status.textContent = 'The PINs do not match.'; confirm.focus(); return; }
    try {
      if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable');
      const salt = globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
      const saved = setPrivacyPin(await hashPin(value, salt), salt);
      if (!saved) { status.textContent = 'Could not save the PIN on this device.'; return; }
      // Remove any legacy in-state fallback once the device-only credential is
      // definitely stored, so exports/sync cannot retain stale PIN material.
      if (state.settings?.pinHash) delete state.settings.pinHash;
      persist(); pinUnlocked = true; close(); toast(custom ? 'PIN changed.' : 'Personal PIN set - the default no longer unlocks this device.'); render();
    } catch (err) {
      status.textContent = 'PIN security is unavailable in this browser.';
    }
  };
  // Biometric row - hidden until the platform-authenticator check resolves.
  const bioRow = $('div', { style: 'display:none;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line);' });
  modal.append(
    $('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;' }, $('h2', { class: 'serif', style: 'font-size:28px;font-weight:400;' }, 'Privacy lock'), $('button', { type: 'button', class: 'btn-link', onClick: close }, 'Close')),
    $('p', { class: 'serif', style: 'font-size:16px;' }, custom ? 'Change or reset your PIN.' : 'The app locks on every device by default.'),
    $('div', { style: 'display:flex;flex-direction:column;gap:12px;margin:20px 0;' }, pin, confirm),
    status,
    bioRow,
    $('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;' },
      custom ? $('button', { type: 'button', class: 'btn btn-danger', onClick: () => {
        if (!clearPrivacyPin()) { toast('Could not reset the PIN on this device.'); return; }
        if (state.settings?.pinHash) delete state.settings.pinHash;
        persist();
        pinUnlocked = true;
        close();
        toast('Reset to the default PIN (100901).');
        render();
      } }, 'Reset to default PIN') : null,
      $('button', { type: 'button', class: 'btn btn-primary', onClick: save }, custom ? 'Save PIN' : 'Set PIN'),
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
}

// Fold a pull result into local state. Never discards data. Returns
// 'adopted' (cloud merged in), 'pushed' (local kept, push queued),
// 'error' (nothing changed).
async function applyReconcile(r, { quiet = false, boot = false } = {}) {
  if (!r.ok) {
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
    notifySyncChange();
    return 'error';
  }
  if (!r.content) {
    // No cloud file yet - first sync. Keep local; a push creates the file.
    patchSyncSettings({ lastError: null, lastErrorAt: null });
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
    patchSyncSettings({ lastSha: r.sha, lastError: null, lastErrorAt: null });
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
    patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
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
  patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: r.sha, lastError: null, lastErrorAt: null });
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
// A new device can adopt sync without typing the app password: open a link
// like ?centsSync=<password> (or <endpoint>|<password> for non-default
// proxies) and this handler configures + enables sync automatically, then
// strips the credential from the URL bar. The password only gates the Netlify
// proxy; the GitHub PAT never leaves the server.
function syncSetupPayload() {
  const s = getSyncSettings();
  if (!s.password) return null;
  const isDefaultEndpoint = !s.endpoint || s.endpoint === '/.netlify/functions/sync';
  return encodeURIComponent(isDefaultEndpoint ? s.password : `${s.endpoint}|${s.password}`);
}
function syncSetupLink() {
  const payload = syncSetupPayload();
  if (!payload) return null;
  return `${location.origin}${location.pathname}?centsSync=${payload}`;
}
function applySetupLinkIfPresent() {
  const raw = new URLSearchParams(location.search).get('centsSync');
  if (!raw) return;
  const decoded = decodeURIComponent(raw);
  const current = getSyncSettings();
  let endpoint = current.endpoint;
  let password = decoded;
  // endpoint|password is only meaningful when the part before the pipe looks
  // like a real endpoint; otherwise the whole string is the password, so a
  // password that itself contains '|' round-trips unharmed.
  const separator = decoded.indexOf('|');
  const possibleEndpoint = separator >= 0 ? decoded.slice(0, separator) : '';
  const looksLikeEndpoint = possibleEndpoint === ''
    || /^\/(?!\/)/.test(possibleEndpoint)
    || /^https:\/\//i.test(possibleEndpoint)
    || /^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(possibleEndpoint);
  if (separator >= 0 && looksLikeEndpoint) {
    endpoint = possibleEndpoint || endpoint;
    password = decoded.slice(separator + 1);
  }
  const safeEndpoint = endpoint === ''
    || /^\/(?!\/)/.test(endpoint)
    || /^https:\/\//i.test(endpoint)
    || /^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(endpoint);
  // Never leave a credential (or a garbage link) sitting in the address bar.
  try { history.replaceState(null, '', location.pathname + location.hash); } catch {}
  if (!password || !safeEndpoint) {
    pendingSetupLinkToast = 'That sync link is not valid.';
    return;
  }
  patchSyncSettings({ endpoint, password, enabled: true, lastError: null, lastErrorAt: null });
  pendingSetupLinkToast = 'Cloud sync configured from link.';
  notifySyncChange();
  // Sync itself begins after unlock (startInitSync in showPinLock), so a
  // locked device still pulls the cloud copy as soon as it's opened.
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
    setSyncPulsing(true);
    let r = await syncPush(payload, { sha: s.lastSha, message });
    if (r.ok) {
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
    if (r.reason === 'conflict' || r.reason === 'http') {
      syncInFlight = false;
      await resolveConflictAndPush();
      return;
    }
    patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
    if (!sessionSyncFailed) {
      toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));' }, iconSpan('alert'), 'Cloud sync failed: ' + (r.message || r.reason || 'error') + '. Changes saved locally.'));
      sessionSyncFailed = true;
    }
    notifySyncChange();
  } catch (error) {
    const message = error?.message || 'sync failed';
    patchSyncSettings({ lastError: message, lastErrorAt: new Date().toISOString() });
    if (!sessionSyncFailed) {
      toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));' }, iconSpan('alert'), 'Cloud sync failed: ' + message + '. Changes saved locally.'));
      sessionSyncFailed = true;
    }
    notifySyncChange();
  } finally {
    setSyncPulsing(false);
    syncInFlight = false;
  }
}
function doAutoPush() { return doPushNow('cents: auto push'); }

// Conflict recovery: pull, merge into local, push the merged result back.
async function resolveConflictAndPush() {
  if (syncExclusive) { scheduleSyncPush(); return; }
  syncExclusive = true;
  try {
    const r = await syncPull();
    if (!r.ok) {
      patchSyncSettings({ lastError: r.message || r.reason || 'error', lastErrorAt: new Date().toISOString() });
      if (!sessionSyncFailed) {
        toast($('span', { style: 'display:inline-flex;align-items:center;gap:8px;color:color-mix(in srgb, var(--negative) 45%, var(--bg));' }, iconSpan('alert'), 'Cloud sync failed: ' + (r.message || r.reason || 'error') + '. Changes saved locally.'));
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
      patchSyncSettings({ lastSha: r.sha, lastError: null, lastErrorAt: null });
      const push = await syncPush(cloudPayload(), { sha: r.sha, message: 'cents: auto push' });
      if (push.ok) patchSyncSettings({ lastSyncAt: new Date().toISOString(), lastSha: push.sha, lastError: null, lastErrorAt: null });
      else scheduleSyncPush(); // retry any failure (conflict, http, network) - the guards keep it bounded
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
      // Raced again - don't loop forever; the next poll/push reconciles.
      patchSyncSettings({ lastError: 'conflict - will retry automatically', lastErrorAt: new Date().toISOString() });
      scheduleSyncPush();
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
      patchSyncSettings({ lastError: null, lastErrorAt: null });
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
      patchSyncSettings({ lastError: null, lastErrorAt: null });
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
  node.append($('span', { class: cls, 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-sync-cloud" d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline class="icon-sync-arrows" points="17 6 19 4 21 6"/><line class="icon-sync-arrows" x1="19" y1="4" x2="19" y2="10"/><polyline class="icon-sync-check" points="20 6 9 17 4 12"/></svg>' }));
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
let balanceCheckpointCacheState = null;
let balanceCheckpointCache = null;
let balanceAtCacheState = null;
const balanceAtCache = new Map();

// Memoized full-dataset sort + id→index so the History screen's per-row
// balance walk doesn't re-sort everything once per row.
let liveSortedEntriesState = null;
let liveSortedEntriesCache = null;
let liveSortedIndexState = null;
let liveSortedIndexCache = null;
function liveSortedEntries() {
  if (liveSortedEntriesState === state.entries && liveSortedEntriesCache) return liveSortedEntriesCache;
  liveSortedEntriesState = state.entries;
  liveSortedEntriesCache = [...state.entries].sort((a, b) => a.date.localeCompare(b.date)
    || ((a.createdAt || '')).localeCompare(b.createdAt || '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return liveSortedEntriesCache;
}
function liveSortedIndex() {
  if (liveSortedIndexState === state.entries && liveSortedIndexCache) return liveSortedIndexCache;
  liveSortedIndexState = state.entries;
  liveSortedIndexCache = new Map(liveSortedEntries().map((e, i) => [e.id, i]));
  return liveSortedIndexCache;
}
// Per-entry balance cache keyed to the current state object, so each History
// row computes its running balance once instead of once per rendered field.
let balanceForEntryCacheState = null;
const balanceForEntryCache = new Map();

function clearBalanceCaches() {
  balanceCheckpointCacheState = null;
  balanceCheckpointCache = null;
  balanceAtCacheState = null;
  balanceAtCache.clear();
  liveSortedEntriesState = null;
  liveSortedEntriesCache = null;
  liveSortedIndexState = null;
  liveSortedIndexCache = null;
  balanceForEntryCacheState = null;
  balanceForEntryCache.clear();
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

function renderBalanceEditorRow(methodId, { label = methodShort(methodId), secondary = '', editable = false, canLoad = false, indent = false } = {}) {
  const row = $('div', { class: 'balance-editor-row', style: `display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;${indent ? `padding-left:${isNarrow() ? '26px' : '32px'};` : ''}border-bottom:1px solid var(--line);font-size:13px;` });
  let editing = false;
  let editMode = 'reconcile'; // 'reconcile' | 'load'
  const isGiftCard = GIFT_CARD_IDS.includes(methodId);
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
              secondary ? $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;' }, secondary) : null,
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
        secondary ? $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;' }, secondary) : null,
        summary ? $('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;' }, `reconciled ${friendlyDate(summary.point.date)}`) : null,
      ),
      $('div', { class: 'balance-editor-controls', style: 'display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:0;' },
        $('div', { style: 'text-align:right;' },
          $('div', { class: 'display-num', style: `font-size:14px;color:${balance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(balance)),
          summary && Math.abs(difference) >= 0.01
            ? $('div', { style: 'margin-top:2px;' }, $('span', { class: `signed-chip ${difference >= 0 ? 'is-positive' : 'is-negative'}`, style: 'font-size:10px;font-weight:700;padding:2px 9px;' }, `${difference >= 0 ? '+' : ''}${fmt(difference)} vs book`))
            : null,
        ),
        editable && (isGiftCard || canLoad) ? $('span', { style: 'display:flex;gap:4px;align-items:center;' },
          $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;padding:3px 5px;', onClick: () => { editMode = 'load'; editing = true; draw(); }, 'aria-label': `Load ${label}` }, iconSpan('plus', 'sm'), 'Load'),
          $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;padding:3px 5px;', onClick: () => { editMode = 'reconcile'; editing = true; draw(); }, 'aria-label': `Reconcile ${label}` }, iconSpan('pencil', 'sm')),
          isGiftCard ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;padding:3px 5px;', onClick: () => openGiftCardHistoryModal(methodId), 'aria-label': `${label} history` }, iconSpan('clipboard', 'sm')) : null,
        ) : editable ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:11px;padding:3px 5px;', onClick: () => { editing = true; draw(); }, 'aria-label': `Reconcile ${label}` }, iconSpan('pencil', 'sm')) : null,
        editable && summary ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:10px;padding:3px 5px;color:var(--negative);', onClick: async () => {
          if (!(await swalConfirm({ title: 'Remove reconciliation?', text: `Remove the ${label} reconciliation from ${friendlyDate(summary.point.date)}?`, confirmButtonText: 'Remove', danger: true }))) return;
          const removed = removeBalanceCheckpoint(methodId, summary.point.date);
          if (removed) {
            trackAction(() => {
              state.settings.balanceCheckpoints[methodId] = [
                ...(state.settings.balanceCheckpoints?.[methodId] || []).filter(point => point.date !== removed.date),
                removed,
              ].sort((a, b) => a.date.localeCompare(b.date));
              persist();
            }, `Restored ${label} reconciliation`, null, [{ methodId, point: { ...removed } }]);
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
function renderAccountBalanceRows({ editable = false, secondaryFor = () => '' } = {}) {
  const rows = [];
  const groupedIds = new Set(ACCOUNT_GROUPS.flatMap(group => group.members));
  for (const id of ACCOUNT_METHOD_IDS) {
    if (groupedIds.has(id)) continue;
    rows.push(renderBalanceEditorRow(id, { label: methodShort(id), secondary: secondaryFor(id), editable, canLoad: true }));
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
      rows.push(renderBalanceEditorRow(id, { label: methodShort(id), secondary: secondaryFor(id), editable, canLoad: true, indent: true }));
    }
  }
  return rows;
}

const fmt = (n) => {
  if (!Number.isFinite(n)) return '€0.00';
  const sign = n < 0 ? '−' : '';
  return `${sign}€${Math.abs(n).toFixed(2)}`;
};

// ---------- count-up animation ----------
// Animates a number element from its previous rendered value to a new target.
// A keyed cache lets repeated renders glide between values instead of flashing.
const _countCache = new Map();
const _reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function countUp(el, target, key, { format = fmt, duration = 600 } = {}) {
  const prev = _countCache.has(key) ? _countCache.get(key) : null;
  _countCache.set(key, target);
  if (prev === null || prev === target || _reduceMotion) { el.textContent = format(target); return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(prev + (target - prev) * eased);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Whole days from today until an ISO date; negative = in the past.
function daysUntil(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return Infinity;
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
}

const monthKey = (date) => date.slice(0, 7);
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const FRIENDLY_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });
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
function isSpendingEntry(entry) {
  return entry.type === 'expense' && !entry.transferId;
}
/** Spending that counts against the monthly budget (excludes savings). */
function isBudgetSpendingEntry(entry) {
  return isSpendingEntry(entry) && !BUDGET_EXCLUDED_METHOD_IDS.includes(entry.method);
}
function isIncomeEntry(entry) {
  return entry.type === 'credit' && !entry.transferId;
}
/** Income that counts toward the month's figures (excludes savings). */
function isBudgetIncomeEntry(entry) {
  return isIncomeEntry(entry) && !BUDGET_EXCLUDED_METHOD_IDS.includes(entry.method);
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
  // When walking live state (the History path), reuse the memoized sort and a
  // Map lookup instead of sorting the full dataset once per row.
  const usingLiveState = entries === state.entries && !checkpointsByMethod;
  const ordered = usingLiveState
    ? liveSortedEntries()
    : [...entries].sort((a, b) => a.date.localeCompare(b.date)
      || ((a.createdAt || '')).localeCompare(b.createdAt || '')
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const targetIndex = usingLiveState
    ? (liveSortedIndex().get(entry.id) ?? -1)
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

/** balanceForEntry with a per-state memo, so History rows compute each running
 *  balance once even when multiple fields need it. */
function cachedBalanceForEntry(entry) {
  if (!entry || !BALANCE_METHOD_IDS.includes(entry.method)) return 0;
  if (balanceForEntryCacheState !== state) {
    balanceForEntryCacheState = state;
    balanceForEntryCache.clear();
  }
  if (balanceForEntryCache.has(entry.id)) return balanceForEntryCache.get(entry.id);
  const value = balanceForEntry(entry);
  balanceForEntryCache.set(entry.id, value);
  return value;
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
  const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
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
  while (rec.nextDate <= dateStr && guard++ < 12) {
    rec.nextDate = advanceRecurringDate(rec.nextDate, rec.frequency, rec.dayOfMonth);
  }
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
  while (rec.nextDate <= dateStr && guard++ < 12) {
    rec.nextDate = advanceRecurringDate(rec.nextDate, rec.frequency, rec.dayOfMonth);
  }
  persist();
  trackAction(() => { rec.nextDate = oldDate; persist(); }, `Restored "${rec.details}"`);
  toast(`Skipped: ${rec.details} - next ${friendlyDate(rec.nextDate)}`);
  render();
}

/** Next occurrences of a recurring item within a horizon (default 30 days). */
function upcomingOccurrences(rec, horizonDays = 30) {
  const out = [];
  let date = rec.nextDate;
  let guard = 0;
  while (guard++ < 60) {
    const d = daysUntil(date);
    if (d > horizonDays) break;
    if (d >= 0) out.push(date);
    date = advanceRecurringDate(date, rec.frequency, rec.dayOfMonth);
  }
  return out.slice(0, 6);
}

// ---------- Tesco pay helpers ----------
function fillThursday(dateStr) {
  const lastTesco = [...state.entries].reverse().find(e => e.type === 'credit' && e.method === 'TG');
  const defaultAmt = lastTesco ? lastTesco.amount : 0;
  if (defaultAmt > 0) {
    const eid = uid();
    const tescoEntry = { id: eid, createdAt: nowIso(), date: dateStr, type: 'credit', category: 'misc', details: 'Tesco pay', amount: defaultAmt, method: 'TG', note: '' };
    state.entries.push(tescoEntry);
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist();
    trackAction(() => { state.entries = state.entries.filter(e => e.id !== eid); tombstoneIds([eid]); persist(); }, `Tesco ${friendlyDate(dateStr)}`, [tescoEntry]);
    toast(`Filled Tesco pay for ${friendlyDate(dateStr)} - ${fmt(defaultAmt)}`);
    render();
  } else {
    openTescoFillModal(dateStr, []);
  }
}

function autoFillAll(unpaidThursdays) {
  const lastTesco = [...state.entries].reverse().find(e => e.type === 'credit' && e.method === 'TG');
  const defaultAmt = lastTesco ? lastTesco.amount : 0;
  if (defaultAmt > 0 && unpaidThursdays.length > 0) {
    const created = [];
    const createdEntries = unpaidThursdays.map(d => {
      const entry = { id: uid(), createdAt: nowIso(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: defaultAmt, method: 'TG', note: '' };
      created.push(entry.id);
      state.entries.push(entry);
      return entry;
    });
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist();
    trackAction(() => {
      state.entries = state.entries.filter(e => !created.includes(e.id));
      tombstoneIds(created);
      persist();
    }, `Auto-fill ${unpaidThursdays.length} Tesco pay Thursdays`, createdEntries);
    toast(`Auto-filled ${unpaidThursdays.length} Tesco pay Thursdays - ${fmt(defaultAmt)} each`);
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
      if (data.date) {
        const entry = { id: uid(), createdAt: nowIso(), date: data.date, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: 'TG', note: '' };
        created.push(entry.id);
        createdEntries.push(entry);
        state.entries.push(entry);
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        trackAction(() => {
          state.entries = state.entries.filter(e => !created.includes(e.id));
          persist();
        }, `Filled Tesco pay ${friendlyDate(data.date)}`, createdEntries);
        toast(`Filled Tesco pay for ${friendlyDate(data.date)} - ${fmt(amt)}`);
      } else {
        for (const d of unpaidThursdays) {
          const entry = { id: uid(), createdAt: nowIso(), date: d, type: 'credit', category: 'misc', details: 'Tesco pay', amount: amt, method: 'TG', note: '' };
          created.push(entry.id);
          createdEntries.push(entry);
          state.entries.push(entry);
        }
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist();
        trackAction(() => {
          state.entries = state.entries.filter(e => !created.includes(e.id));
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
// A single undo slot: `_lastAction` holds the live closure for the most recent
// action, and the journal is its reload-safe serialisation. The toast captures
// the slot at creation time so a later action can't re-wire an earlier Undo
// button; the persistent undo button always reverts the latest action.
let _lastAction = null;
function trackAction(undoFn, label, journalEntries, journalCheckpoints) {
  _lastAction = { undo: undoFn, label };
  const hasEntries = Array.isArray(journalEntries) && journalEntries.length;
  const hasCheckpoints = Array.isArray(journalCheckpoints) && journalCheckpoints.length;
  if (hasEntries || hasCheckpoints) {
    saveUndoJournal({
      label,
      at: nowIso(),
      entries: hasEntries ? journalEntries.map(e => ({ ...e })) : [],
      checkpoints: hasCheckpoints ? journalCheckpoints.map(c => ({ methodId: c.methodId, point: { ...c.point } })) : [],
    });
  } else {
    // A non-serialisable action supersedes any older reload-safe undo.
    clearUndoJournal();
  }
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

// The most recent undoable action: the live in-memory slot first, then the
// reload-safe journal (so undo still works after a reload).
function lastUndoDescriptor() {
  if (_lastAction) return _lastAction;
  const journal = loadUndoJournal();
  if (!journal || !(journal.entries?.length || journal.checkpoints?.length)) return null;
  const missing = missingJournalData(journal);
  if (!missing.entries.length && !missing.checkpoints.length) { clearUndoJournal(); return null; }
  return { label: journal.label || 'that change', undo: () => { restoreUndoJournal(journal); } };
}

// Revert the most recent action and clear the single undo slot.
function performUndo() {
  const action = lastUndoDescriptor();
  if (!action) return;
  action.undo();
  if (_lastAction === action) _lastAction = null;
  clearUndoJournal();
  toast(`Undone: ${action.label}`);
  render();
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

// ---------- confetti ----------
function triggerConfetti() {
  // The only caller (screenDashboard) already guards confetti to once per
  // month via window.__confettiMonth, so no extra guard is needed here.
  const colors = ['#157A4A','#35B877','#8FD3B3','#E3E3DC','#FFFFFF','#8C928A'];
  // Prefer canvas-confetti when it's loaded: layered bursts with physics.
  if (typeof window.confetti === 'function') {
    const base = { colors, zIndex: 9999, disableForReducedMotion: true, gravity: 0.9, decay: 0.93, scalar: 0.9 };
    window.confetti({ ...base, particleCount: 60, spread: 360, startVelocity: 28, ticks: 90, origin: { x: 0.5, y: 0.75 } });
    setTimeout(() => window.confetti({ ...base, particleCount: 26, angle: 60, spread: 60, startVelocity: 42, ticks: 110, origin: { x: 0, y: 0.8 } }), 200);
    setTimeout(() => window.confetti({ ...base, particleCount: 26, angle: 120, spread: 60, startVelocity: 42, ticks: 110, origin: { x: 1, y: 0.8 } }), 350);
    return;
  }
  // Lazy-load canvas-confetti; the DOM fallback below covers a load failure.
  loadVendor('confetti', { js: 'vendor/confetti.browser.min.js' })
    .then(() => { if (typeof window.confetti === 'function') triggerConfetti(); else domConfetti(colors); })
    .catch(() => domConfetti(colors));
}

// DOM confetti fallback when the library is missing or fails to load.
function domConfetti(colors) {
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
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
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
  if (/grocer|tesco|lidl|aldi|supervalu|dunnes|spar|centra|m&s|marks|supermarket|shop|market/i.test(d)) cat = 'gro';
  else if (/bus|train|luas|dart|leap|taxi|uber|petrol|diesel|fuel|parking|toll|flight|ferry/i.test(d)) cat = 'travel';
  else if (/rent|lease|mortgage|deposit|landlord/i.test(d)) cat = 'rent';
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
    const numRe = /(?:€|£|\$|euros?\b|eur\b)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:€|£|\$|euros?\b|eur\b)?/gi;
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
  let method = 'AIB';
  if (/\brevolut\s+savings\b|\brs(?:\s+account)?\b|\bsavings\s+(?:account|pot|fund)\b/.test(lower)) method = 'RS';
  else if (/\brevolut\b/.test(lower)) method = 'Revolut';
  else if (/\btesco\b/.test(lower)) method = 'TG';
  else if (/\blidl\b/.test(lower)) method = 'LG';
  else if (/\baldi\b/.test(lower)) method = 'AG';
  else if (/\baib\b|\bbank\b|current account/.test(lower)) method = 'AIB';

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
  const details = cleanMagicDescription(raw, amountText);
  const guessed = parseReceiptLine(details);
  return { date, type: isCredit ? 'credit' : 'expense', amount, details, category: isCredit ? 'misc' : guessed.category, method };
}

// ── Magic-entry description cleaner ──
// Two-phase best-effort cleaner: strip provable value-noise first (amount,
// currency, dates, ordinals, numbers, units, payment channels, verbs,
// articles), then keep the meaningful words - prepositions only when they sit
// between two content words, no consecutive duplicates, title-cased.
const MAGIC_STOP = new Set([
  'the', 'a', 'an', 'i', 'my', 'our', 'some', 'any', 'just', 'only',
  'about', 'around', 'approx', 'approximately', 'am', 'pm',
  'income', 'received', 'salary', 'paid', 'got', 'paycheck', 'wage', 'wages',
  'refund', 'dividend', 'spent', 'expense', 'expenses', 'bought', 'cost',
  'costs', 'worth', 'total', 'amount', 'came',
]);
// Functional prepositions: pure glue that only survives between two content
// words ("pint of Guinness"). They never start a description on their own.
const MAGIC_PREPS = new Set([
  'at', 'from', 'on', 'using', 'via', 'with', 'for', 'in', 'to', 'of', 'by',
  'per', 'each',
]);
// Positional words that double as the first word of real brand names
// ("In & Out", "On The Run", "The Point"). They are preserved at the start of
// a description when what follows looks like a proper noun (capitalised).
const MAGIC_BRAND_START = new Set(['the', 'a', 'an', 'in', 'on']);
// Connectors that join two words of a name ("Fish & Chips", "Bar and Grill").
const MAGIC_CONNECTORS = new Set(['&', 'and']);
const MAGIC_EDGE_PUNCT = /^[,.;:!?()\[\]"'\-—-]+|[,.;:!?()\[\]"'\-—-]+$/g;
// Prepositions and connectors stay lowercase mid-description ("Pint of Guinness").
const MAGIC_LOWERCASE = new Set([...MAGIC_PREPS, 'and']);
function isContentToken(t) {
  return !!t && /[a-z0-9]/i.test(t) && !MAGIC_CONNECTORS.has(t.toLowerCase())
    && !MAGIC_STOP.has(t.toLowerCase()) && !MAGIC_PREPS.has(t.toLowerCase());
}
function cleanMagicDescription(raw, amountText) {
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
    .replace(/\b(aib|revolut(?: savings)?|\brs\b|bank|current account)\b/ig, ' ') // payment channels
    .replace(/[()\[\]"']+/g, ' ');                                             // brackets/quotes

  const tokens = s.split(/\s+/).filter(Boolean);
  const kept = [];
  // Still at the head of the description (no content word kept yet) - the only
  // place a brand-start "In"/"On"/"The" may legitimately appear.
  const atHead = () => !kept.some(isContentToken);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(MAGIC_EDGE_PUNCT, '');
    const low = t.toLowerCase();

    // Connector: keep when it visibly joins two words ("Fish & Chips",
    // "Bar and Grill"), drop when it dangles ("Dinner &", "& Sons").
    // Checked before the symbol filter so "&" survives. The left neighbour
    // must actually be the last KEPT word - a dropped stop word ("bought &
    // sold") must not let a leading "&" through.
    if (t && MAGIC_CONNECTORS.has(low)) {
      const left = tokens[i - 1]?.replace(MAGIC_EDGE_PUNCT, '');
      const right = tokens[i + 1]?.replace(MAGIC_EDGE_PUNCT, '');
      if (kept.length && kept[kept.length - 1] === left
        && right && /[a-z0-9]/i.test(right)) kept.push(t);
      continue;
    }
    if (!t || !/[a-z0-9]/i.test(t)) continue;                                   // pure-symbol tokens

    if (MAGIC_STOP.has(low)) {
      // Verbs and filler always drop. Articles keep their place only when they
      // precede a capitalised proper noun - "The Point", even mid-description
      // ("coffee at The Point") - never for a generic noun ("the rent" →
      // "rent", because "rent" is lowercase).
      const next = nextContentToken(tokens, i);
      if (MAGIC_BRAND_START.has(low) && next && /[A-Z]/.test(next.charAt(0))) {
        kept.push(t);
      }
      continue;
    }

    if (MAGIC_PREPS.has(low)) {
      // Prepositions survive mid-string between two content words, or at the
      // head of a proper-noun name ("In & Out") - but plain glue like
      // "at Tesco" / "from Revolut" is dropped.
      const prevContent = kept.length > 0 && isContentToken(kept[kept.length - 1]);
      const next = nextContentToken(tokens, i);
      const brandStart = atHead() && MAGIC_BRAND_START.has(low) && next && /[A-Z]/.test(next.charAt(0));
      if ((prevContent && next) || brandStart) kept.push(t);
      continue;
    }

    if (kept.length && kept[kept.length - 1].toLowerCase() === low) continue;  // de-dupe
    kept.push(t);
  }

  let details = kept.join(' ')
    .replace(/\s*([,;:.])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .replace(MAGIC_EDGE_PUNCT, '')
    .trim();
  if (!details) return 'Entry';
  // Title-case content words; keep prepositions/"and" lowercase mid-string, and
  // never mangle all-caps brands ("M&S", "IKEA", "B&Q").
  return details.split(' ').map((w, idx) => {
    if (idx > 0 && MAGIC_LOWERCASE.has(w.toLowerCase())) return w.toLowerCase();
    if (!/[a-z]/.test(w)) return w;                                             // all-caps token stays untouched
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}
function nextContentToken(tokens, from) {
  for (let j = from + 1; j < tokens.length; j++) {
    const nt = tokens[j].replace(MAGIC_EDGE_PUNCT, '');
    if (nt && isContentToken(nt)) return nt;
  }
  return null;
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
  const expenses = current.filter(isBudgetSpendingEntry);
  const spent = expenses.reduce((sum, e) => sum + e.amount, 0);
  const elapsed = key === monthKey(today()) ? now.getDate() : daysInMonth(key);
  const totalDays = daysInMonth(key);
  const dailyAverage = elapsed > 0 ? spent / elapsed : 0;
  const projected = spent + dailyAverage * Math.max(0, totalDays - elapsed);
  const budget = +state.settings.monthlyBudget || 0;
  const previous = entriesForMonth(previousMonthKey(key)).filter(isBudgetSpendingEntry);
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
  const current = entriesForMonth(key).filter(isBudgetSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const previousKey = previousMonthKey(key);
  const previous = entriesForMonth(previousKey).filter(isBudgetSpendingEntry).reduce((sum, entry) => sum + entry.amount, 0);
  const difference = current - previous;
  const percent = previous > 0 ? Math.round((difference / previous) * 100) : null;
  return { current, previous, previousKey, difference, percent };
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
  // Tombstone the removed ids so the deletion also propagates to other
  // devices through the cloud merge.
  tombstoneIds(removed.map(e => e.id));
  persist();
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
    toast(`Duplicate deletion blocked: ${methodShort(protection.methodId)} is reconciled through ${friendlyDate(protection.point.date)}.`);
    return;
  }
  const removedIds = new Set(removed.map(e => e.id));
  state.entries = state.entries.filter(e => !removedIds.has(e.id));
  tombstoneIds([...removedIds]);
  persist();
  trackAction(() => { state.entries.push(...removed); state.entries.sort((a, b) => a.date.localeCompare(b.date)); untombstoneIds(removed.map(e => e.id)); persist(); }, `Restored ${target.details}`, removed);
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
  if (uncategorized > financialEntries.length * 0.3) { score -= 15; issues.push(`${uncategorized} entries are "Misc" - try categorising them.`); }
  // Large amounts
  const avg = financialEntries.length ? financialEntries.reduce((s,e) => s + e.amount, 0) / financialEntries.length : 0;
  const outliers = financialEntries.filter(e => e.amount > avg * 5).length;
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

// ---------- season detection ----------
// Ledger uses a single emerald accent, so seasonal accent drift is retired.
function setSeason() {
  return;
}

// ---------- router ----------
const ROUTES = ['dashboard', 'add', 'history', 'balances', 'insights'];
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < 640;
const isTiny = () => typeof window !== 'undefined' && window.innerWidth < 480;
function currentRoute() {
  const r = (location.hash || '#dashboard').slice(1).split('?')[0];
  return ROUTES.includes(r) ? r : 'dashboard';
}
window.addEventListener('hashchange', render);

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
      $('div', { class: 'mark' }, $('span', { class: 'mark-icon', 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6.5A7 7 0 1 0 17 17.5"/><line x1="2.5" y1="8" x2="12" y2="8"/><line x1="2.5" y1="16" x2="12" y2="16"/></svg>' })),
      $('a', { href: '#dashboard', class: 'logo-wordmark', style: 'font-family:"Space Grotesk",sans-serif;font-size:30px;letter-spacing:-0.03em;' }, 'cents.'),
    ),
    $('nav', { class: 'nav', 'aria-label': 'Primary', style: locked ? 'display:none;' : '' },
      ...ROUTES.map(r => $('a', { href: `#${r}`, class: 'nav-link', 'aria-current': r === route ? 'page' : null }, titleFor(r))),
    ),
    $('div', { class: 'header-actions', style: locked ? 'display:none;' : '' },
      $('span', { id: 'sync-indicator', style: 'display:inline-flex;align-items:center;gap:7px;font-family:"Space Grotesk",sans-serif;font-size:14px;color:var(--muted);' }),      $('button', { class: 'dark-toggle', type: 'button', title: 'Toggle dark mode', 'aria-label': 'Toggle dark mode', 'aria-pressed': document.documentElement.dataset.theme === 'dark' ? 'true' : 'false', onClick: (event) => {
         const wasDark = document.documentElement.dataset.theme === 'dark';
         toggleDarkMode();
         event.currentTarget.setAttribute('aria-pressed', String(!wasDark));
         event.currentTarget.setAttribute('aria-label', `Switch to ${wasDark ? 'dark' : 'light'} mode`);
         event.currentTarget.setAttribute('title', `Switch to ${wasDark ? 'dark' : 'light'} mode`);
       } },
        $('span', { class: 'icon-sun', 'aria-hidden': 'true', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' }),
        $('span', { class: 'icon-moon', 'aria-hidden': 'true', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' }),
      ),
      $('button', { type: 'button', class: 'menu-trigger', title: 'Menu', 'aria-label': 'Open menu', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: toggleAppMenu },
        $('span', { class: 'menu-trigger-icon icon-burger', 'aria-hidden': 'true', innerHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>' }),
        $('span', { class: 'menu-trigger-icon icon-close', 'aria-hidden': 'true', innerHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' }),
      ),
    ),
  );
  queueMicrotask(renderSyncIndicator);
}

function titleFor(r) {
  return ({ dashboard: 'Dashboard', add: 'New entry', history: 'History', balances: 'Balances', insights: 'Insights' })[r];
}

// ---------- animated drill-down menu ----------
// Hamburger opens a springy, blur-backed panel (drawer on desktop, bottom
// sheet on mobile). Rows with chevrons drill into submenus; each level
// slides with a bounce while rows stagger in. Escape/back chevron pops back.
let appMenu = null;   // { backdrop, panel, track, stack }

const MENU_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8.5" x2="12" y2="15.5"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-6M22 20H2"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h12"/><path d="M20 7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7"/><rect x="16" y="11" width="4" height="5" rx="1"/></svg>',
  appearance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

// Full stroke-icon set - Lucide-style 24px grid, currentColor, 1.9 stroke.
// Extends MENU_ICONS so menus, pills, buttons, toasts and headers share one
// visual language (replaces the scattered emoji glyphs).
const ICONS = {
  ...MENU_ICONS,
  // Plain plus for tiny buttons - the menu's circled plus reads as a record
  // button at 12px.
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  medal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  'arrow-up': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  'arrow-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  'chevron-left': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  'chevron-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  'check-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="10"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z"/></svg>',
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

function menuRowEl({ icon, label, onClick = null, chevron = false, active = false, danger = false, check = false }) {
  return $('button', { type: 'button', class: 'menu-row' + (active ? ' active' : '') + (danger ? ' danger' : ''), onClick },
    $('span', { class: 'menu-row-icon', 'aria-hidden': 'true', innerHTML: MENU_ICONS[icon] || MENU_ICONS.home }),
    $('span', { class: 'menu-row-label' }, label),
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
    ROUTES.forEach(r => list.append($('a', { href: `#${r}`, class: 'menu-row' + (r === route ? ' active' : ''), 'aria-current': r === route ? 'page' : null, onClick: closeAppMenu },
      $('span', { class: 'menu-row-icon', 'aria-hidden': 'true', innerHTML: MENU_ICONS[{ dashboard: 'home', add: 'plus', history: 'clock', balances: 'wallet', insights: 'chart' }[r]] }),
      $('span', { class: 'menu-row-label' }, titleFor(r)),
    )));
    list.append($('div', { class: 'menu-sep' }));
    list.append(menuRowEl({ icon: 'clock', label: 'Recurring & bills', onClick: () => { closeAppMenu(); openRecurringManager(); } }));
    if (canInstallApp()) {
      list.append(menuRowEl({ icon: 'download', label: 'Install app', onClick: () => { closeAppMenu(); promptInstall(); } }));
    }
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
    list.append(menuInfoRow('Privacy lock', 'On'));
    list.append(menuRowEl({ icon: 'lock', label: hasCustomPin() ? 'Change PIN' : 'Set PIN', onClick: () => { closeAppMenu(); openPinSettings(); } }));
    list.append(menuRowEl({ icon: 'lock', label: 'Lock app now', onClick: () => { closeAppMenu(); lockApp(); } }));
  } else if (id === 'sync') {
    const s = getSyncSettings();
    const st = syncStatus();
    list.append(menuInfoRow('Status', s.enabled ? st.label : 'Off'));
    list.append(menuRowEl({ icon: 'cloud', label: 'Sync settings', onClick: () => { closeAppMenu(); openSyncSettings(); } }));
    if (s.enabled && s.endpoint && s.password) {
      list.append(menuRowEl({ icon: 'cloud', label: 'Sync now', onClick: () => { scheduleSyncPush(); toast('Syncing…'); menuRefreshLevel('sync'); } }));
    }
  } else if (id === 'data') {
    list.append(menuRowEl({ icon: 'data', label: 'Export data', onClick: () => { closeAppMenu(); exportJSON(state); toast('Exported.'); } }));
    list.append(menuRowEl({ icon: 'data', label: 'Reset all data', danger: true, onClick: async () => {
      closeAppMenu();
      if (!(await swalConfirm({ title: 'Reset all data?', text: 'This clears every entry, balance checkpoint, and setting on this device. Continue?', confirmButtonText: 'Reset', danger: true }))) return;
      syncRevision++;
      state = resetToBlank();
      clearBalanceCaches();
      scheduleSyncPush();
      render();
      toast('All data cleared.');
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
  document.body.classList.add('menu-open');
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
  document.body.classList.remove('menu-open');
  const trigger = document.querySelector('.menu-trigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  backdrop.classList.add('closing');
  panel.classList.add('closing');
  // 240ms matches the 0.2s closing animations + a small buffer.
  setTimeout(() => backdrop.remove(), 240);
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
  // Apply .shown synchronously so the stagger never shows a blank frame;
  // the CSS animation (with fill-mode both) starts rows hidden and springs
  // them in without any pop-in flicker.
  level.classList.add('shown');
  if (old) setTimeout(() => { if (old.parentNode === track) old.remove(); }, 240);
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
  prev.classList.add('in-left', 'shown');
  requestAnimationFrame(() => {
    // Keep keyboard/screen-reader users anchored after the level swap.
    const target = prev.querySelector('.menu-back') || prev.querySelector('.menu-row');
    if (target) target.focus({ preventScroll: true });
  });
  setTimeout(() => current.remove(), 240);
}

function menuRefreshLevel(id) {
  if (!appMenu) return;
  const { track, stack } = appMenu;
  const levels = Array.from(track.querySelectorAll('.menu-level'));
  const current = levels[levels.length - 1];
  if (!current || current.dataset.level !== id) return;
  const fresh = buildMenuLevel(id);
  fresh.classList.add('in-right', 'shown');
  track.replaceChild(fresh, current);
  if (stack[stack.length - 1] !== id) stack.push(id);
}


// ---------- shared form ----------
function formView({ initial = null, onSubmit }) {
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
  wireFlatpickr(dateInput, { defaultDate: data.date, onChange: (dateStr) => { data.date = dateStr; } });

  const creditMethods = METHODS.filter(m => m.id === 'AIB' || m.id === 'Revolut' || m.id === 'RS');
  const isCredit = () => data.type === 'credit';
  const isTransfer = () => data.type === 'transfer';
  // Ensure transfer defaults exist
  if (isTransfer()) { data.transferFrom = data.transferFrom || 'AIB'; data.transferTo = data.transferTo || 'Revolut'; }

  // Named methodLabelEl so it doesn't shadow the global methodLabel(id) helper.
  const methodLabelEl = $('label', { class: 'eyebrow', for: 'f-method' }, 'Method');
  const methodOpts = () => (isCredit() ? creditMethods : METHODS);
  const methodSel = $('select', { 'aria-label': 'Payment method', id: 'f-method', onChange: (e) => data.method = e.target.value });
  const methodSection = $('div');
  function rebuildMethodOpts() {
    methodLabelEl.textContent = isCredit() ? 'Income sent to' : 'Method';
    const ids = methodOpts().map(m => m.id);
    appendMethodOptions(methodSel, ids, data.method);
    if (!ids.includes(data.method)) { data.method = ids[0]; }
  }
  rebuildMethodOpts();
  methodSection.append(methodLabelEl, methodSel);

  // Transfer From / To dropdowns
  const transferFromSel = $('select', { 'aria-label': 'From account', onChange: (e) => data.transferFrom = e.target.value });
  const transferToSel = $('select', { 'aria-label': 'To account', onChange: (e) => data.transferTo = e.target.value });
  function rebuildTransferOpts() {
    const ids = METHODS.map(m => m.id);
    appendMethodOptions(transferFromSel, ids, data.transferFrom);
    appendMethodOptions(transferToSel, ids, data.transferTo);
    if (!ids.includes(data.transferFrom)) data.transferFrom = ids[0];
    if (!ids.includes(data.transferTo)) data.transferTo = ids[0];
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
    const amt = parseAmount(data.amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount.'); amountInput.focus(); return; }
    if (amt > 100000) { toast('Amount looks too large - double check.'); amountInput.focus(); return; }
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
    if (!isEdit && data.type !== 'note') {
      const dup = findPotentialDuplicate(entry);
      if (dup) {
        openDuplicateConfirm(entry, dup, () => onSubmit([entry]));
        return;
      }
    }
    onSubmit([entry]);
  };

  const payeeList = $('datalist', { id: 'payee-list' }, ...payeeHistory().map(payee => $('option', { value: payee })));
  let detailsLabel;
  let noteFieldSection;
  const formEl = $('div', { class: 'card', style: `padding:${isNarrow() ? '20px 16px' : '32px 16px'};max-width:540px;margin:0 auto;` },
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
      if (hasLocalDataToProtect()) { toast('Cloud file is empty - local data was kept and will be pushed.'); scheduleSyncPush(); }
      else toast('Cloud file is empty - nothing to pull.');
      return;
    }
    await applyReconcile(r, {});
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

  // Net worth sparkline card (if enough data) - points already computed above
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
    screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '14px 16px' : '18px 16px'};margin-bottom:24px;display:flex;align-items:center;gap:16px;` },
      $('svg', { viewBox: `0 0 ${sparkW} ${sparkH}`, style: 'flex:1;min-width:120px;height:40px;', 'aria-label': 'Net worth trend' },
        $('path', { d: areaD, style: `fill:${isUp ? 'var(--positive)' : 'var(--negative)'};opacity:0.1;` }),
        $('path', { d: pathD, style: `fill:none;stroke:${isUp ? 'var(--positive)' : 'var(--negative)'};stroke-width:1.5;stroke-linecap:round;` }),
      ),
      $('div', { style: 'text-align:right;flex-shrink:0;' },
        $('div', { class: 'eyebrow' }, 'Net worth'),
        (() => {
          const el = $('div', { class: 'display-num', style: `font-size:${isNarrow() ? '16px' : '18px'};color:${lastVal >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(lastVal));
          countUp(el, lastVal, 'dash-networth');
          return el;
        })(),
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

  // Hero - the monthly total and balance count up from their previous values
  const heroTotalEl = $('span', { class: 'serif' }, fmt(expenseSum));
  countUp(heroTotalEl, expenseSum, 'dash-total');
  const heroBalanceEl = $('span', { class: 'display-num', style: `font-size:13px;color:${runningBalance >= 0 ? 'var(--positive)' : 'var(--negative)'};` }, fmt(runningBalance));
  countUp(heroBalanceEl, runningBalance, 'dash-balance');
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
      ),
    ),
    $('div', { class: 'dashboard-actions' },
      $('label', { class: 'eyebrow', for: 'budget-input' }, 'Budget'),
      $('input', { id: 'budget-input', type: 'text', inputmode: 'decimal', value: String(budget || ''), placeholder: '-', 'aria-label': 'Monthly budget in euros', autocomplete: 'off', style: `width:${isNarrow() ? '72px' : '92px'};border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:7px 10px;font-size:13px;text-align:right;transition:border-color .15s;`, onFocus: (e) => e.target.style.borderColor = 'var(--accent)', onBlur: (e) => {
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

  // Milestone chips - personality that rewards consistency.
  const ms = computeMilestones();
  const chips = [];
  if (ms.entryCount > 0) chips.push($('span', { class: 'pill', title: 'Total entries logged' }, iconSpan('book', 'sm'), `${ms.entryCount} entr${ms.entryCount === 1 ? 'y' : 'ies'} logged`));
  if (ms.monthsUnderBudget >= 1) chips.push($('span', { class: 'pill', title: 'Months where spending stayed within budget' }, iconSpan('medal', 'sm'), `${ms.monthsUnderBudget} month${ms.monthsUnderBudget === 1 ? '' : 's'} under budget`));
  if (chips.length) screen.appendChild($('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;' }, ...chips));

  // Pulse - the single "how am I doing?" glance: headline number, key figures,
  // and a tap-through to Insights for the full picture.
  screen.appendChild(dashboardPulse(key, expenseSum, runningBalance));

  // Budget bar card
  if (budget > 0) {
    screen.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:${isNarrow() ? '22px' : '32px'};` },
      $('div', { class: 'row between' },
        $('span', { class: 'eyebrow' }, 'Spent of budget'),
        (() => {
          const el = $('span', { class: 'serif budget-pct-anim', style: 'font-size:22px;' }, `${pct.toFixed(1)}%`);
          countUp(el, pct, 'dash-budget-pct', { format: v => `${v.toFixed(1)}%` });
          return el;
        })(),
      ),
      $('div', { style: 'height:3px;background:var(--line);border-radius:99px;overflow:hidden;margin:14px 0 20px;' },
        $('div', { class: 'budget-bar-fill', style: `height:100%;width:${pct}%;background:${pct > 90 ? 'var(--negative)' : 'var(--accent)'};transition:width .5s cubic-bezier(0.2,0.8,0.2,1);border-radius:99px;` }),
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
      // The Pulse block already carries Spent/Projected/Remaining/Avg-day/Burn;
      // keep only what it doesn't, as one compact line instead of a stat grid.
      $('div', { style: `display:flex;flex-wrap:wrap;gap:4px 20px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);` },
        $('span', null, 'Income ', $('span', { style: 'color:var(--positive);font-weight:600;' }, fmt(incomeSum))),
        $('span', null, 'Net ', $('span', { style: 'color:var(--ink);' }, fmt(totalForMonth(key)))),
        $('span', null, 'Month elapsed ', $('span', { style: 'color:var(--ink);' }, Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100) + '%')),
      ),
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
        $('button', { type: 'button', style: 'font-size:11px;color:var(--accent);cursor:pointer;background:none;border:none;padding:0;', onClick: () => openNewRecurring() }, '+ New'),
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
                trackAction(() => { state.settings.recurring.push(...removed); persist(); }, `Restored recurring "${r.details}"`);
                persist(); toast(`Removed recurring "${r.details}".`); render();
              }, title: 'Remove recurring' }, '×'),
              $('span', { style: `display:inline-block;width:7px;height:7px;border-radius:50%;background:${isOverdue ? 'var(--negative)' : isDueSoon ? 'var(--accent)' : 'var(--muted)'};flex-shrink:0;box-shadow:${isDueSoon ? '0 0 0 3px var(--accent-glow)' : 'none'};` }),
              $('span', { style: 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, r.details),
              $('span', { class: 'pill', style: 'border-color:transparent;font-size:10px;flex-shrink:0;' }, r.method),
              $('span', { class: 'muted', style: 'font-size:11px;flex-shrink:0;' }, friendlyDate(r.nextDate)),
              isDueSoon ? $('span', { class: 'pill', style: 'border-color:var(--accent);color:var(--accent);font-size:10px;flex-shrink:0;' }, daysAway === 0 ? 'today' : `in ${daysAway}d`) : null,
            ),
            $('div', { style: 'display:flex;align-items:center;gap:10px;flex-shrink:0;' },
              $('span', { class: 'display-num', style: `font-size:13px;color:${r.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};` }, (r.type === 'credit' ? '+' : '') + fmt(r.amount)),
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
  const grid = $('div', { class: 'dashboard-grid', style: 'display:grid;grid-template-columns:1fr;gap:24px;align-items:start;' });
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
      const input = $('input', { type: 'text', inputmode: 'decimal', value: target ? String(target) : '', 'aria-label': `Monthly target for ${categoryLabel(cat)}`, autocomplete: 'off', style: 'width:62px;border:1px solid var(--accent);border-radius:var(--radius);background:transparent;color:inherit;font-family:inherit;outline:none;padding:3px 8px;font-size:12px;text-align:right;' });
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
      $('a', { href: '#history', class: 'btn-link' }, 'See all ', iconSpan('arrow-right', 'sm')),
    ),
    recent.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('chart'), ' No entries yet.')
      : $('div', { style: `display:grid;grid-template-columns:${isNarrow() ? '75px 1fr 80px' : '90px 1fr 110px 90px'};gap:${isNarrow() ? '8px 12px' : '12px 24px'};font-size:${isNarrow() ? '12px' : '14px'};${isNarrow() ? '' : 'min-width:520px;'}` },
          ...recent.flatMap(e => [
            $('span', { class: 'muted', style: 'font-size:12px;' }, friendlyDate(e.date)),
            $('div', null,
              $('div', { style: 'font-weight:500;' }, e.details || '-'),
              $('div', { style: `font-size:11px;color:var(--muted);${isNarrow() ? 'display:none;' : ''}` }, `${categoryLabel(e.category)} · ${methodLabel(e.method)}`),
            ),
            $('span', { class: 'display-num', style: `text-align:right;font-size:${isNarrow() ? '13px' : '15px'};color:${e.type === 'credit' ? 'var(--positive)' : 'var(--negative)'}` }, (e.type === 'credit' ? '+' : '') + fmt(e.amount)),
            ...(isNarrow() ? [] : [$('span', null, $('span', { class: 'pill', style: 'border-color:transparent;' }, e.method))]),
          ]),
        ),
  );

  grid.append(catCard, recentCard);
  screen.appendChild(grid);

  // All tracked balances share one inline reconciliation flow. A checkpoint
  // records the actual balance on a date without rewriting any transactions.
  const pendingPerMethod = {};
  for (const e of state.entries) {
    if (!e.transferId || e.settled) continue;
    pendingPerMethod[e.method] = (pendingPerMethod[e.method] || 0) + (e.type === 'credit' ? e.amount : -e.amount);
  }
  const secondaryFor = (id) => {
    const status = accountStatus(id);
    const pending = pendingPerMethod[id] ? `${pendingPerMethod[id] > 0 ? '+' : ''}${fmt(pendingPerMethod[id])} pending` : '';
    return [status.label, pending].filter(Boolean).join(' · ');
  };
  const accountsCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Bank account balances'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Current end-of-day balances; transaction history stays unchanged.'),
      ),
      $('a', { href: '#balances', class: 'btn-link', style: 'font-size:12px;' }, 'Manage ', iconSpan('arrow-right', 'sm')),
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
      ...renderAccountBalanceRows({ secondaryFor }),
    ),
  );
  screen.appendChild(accountsCard);

  const gcCard = $('div', { class: 'card', style: `padding:${isNarrow() ? '18px' : '24px'};margin-top:24px;` },
    $('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Gift card balances'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, 'Current provider balances without adding a fake transaction. Totals show recorded activity, or post-reconciliation adjustments when a checkpoint exists.'),
      ),
      $('a', { href: '#balances', class: 'btn-link', style: 'font-size:12px;' }, 'Manage ', iconSpan('arrow-right', 'sm')),
    ),
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

  // Tesco pay - Thursdays tracker
  const thursdays = thursdaysInMonth(now.getFullYear(), now.getMonth());
  // Look across ALL entries (not just this month) so Thursdays match regardless of when entered
  const incomeByDate = {};
  for (const e of state.entries.filter(x => x.type === 'credit')) { incomeByDate[e.date] = (incomeByDate[e.date] || 0) + e.amount; }
  // Build local today string the same way thursdaysInMonth does (no UTC shift)
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const unpaidThursdays = thursdays.filter(d => !incomeByDate[d] && d <= todayStr);
  const paidTotal = thursdays.reduce((sum, d) => sum + (incomeByDate[d] || 0), 0);

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
                  paid ? `+${fmt(incomeByDate[d])}` : '-',
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
    receipt: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="4" width="24" height="32" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="14" y1="12" x2="26" y2="12" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="18" x2="22" y2="18" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="24" x2="24" y2="24" stroke="currentColor" stroke-width="1.2"/></svg>',
    chart: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="22" width="7" height="14" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="16" y="12" width="7" height="24" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="26" y="6" width="7" height="30" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
    coin: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="14" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="20" r="10" stroke="currentColor" stroke-width="1.2"/><text x="20" y="24" text-anchor="middle" font-family="Space Grotesk,sans-serif" font-size="12" fill="currentColor">€</text></svg>',
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

function stat(label, value, color) {
  return $('div', null,
    $('div', { class: 'eyebrow' }, label),
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

// ---------- modal: manage all recurring ----------
// The dashboard card only lists rules whose next occurrence falls within the
// current month; this modal lists every rule regardless of when it is next
// due, sorted by next occurrence, with edit/remove/new in one place.
function openRecurringManager() {
  const bg = $('div', { class: 'modal-bg', onClick: (ev) => { if (ev.target === bg) close(); } });
  const modal = $('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Manage recurring transactions', tabindex: '-1', style: 'max-width:560px;display:flex;flex-direction:column;max-height:88vh;' });
  // Re-render the list whenever any nested editor modal closes, so edits/adds
  // made through the manager are reflected immediately.
  const refreshManager = () => refresh();
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => { document.removeEventListener('keydown', onEsc, true); bg.remove(); render(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const listEl = $('div', { style: 'overflow-y:auto;flex:1;min-height:0;margin:0 -4px;padding:0 4px;' });
  const emptyState = () => $('div', { class: 'muted', style: 'font-size:13px;padding:24px 4px;text-align:center;' },
    'No recurring transactions yet. Add rent, subscriptions, or paydays.',
  );

  const freqLabel = (r) => r.frequency === 'weekly' ? 'Weekly' : `Monthly · ${r.dayOfMonth}${ordinal(r.dayOfMonth)}`;
  const rowFor = (r) => {
    const d = daysUntil(r.nextDate);
    const overdue = d < 0;
    const dueSoon = !overdue && d <= 7;
    return $('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background-color:color-mix(in srgb, var(--card) 92%, transparent);' },
      $('div', { style: 'display:flex;align-items:center;gap:4px;min-width:0;flex:1;' },
        $('span', { style: `display:inline-block;width:7px;height:7px;border-radius:50%;background:${overdue ? 'var(--negative)' : dueSoon ? 'var(--accent)' : 'var(--muted)'};flex-shrink:0;` }),
        $('div', { style: 'min-width:0;flex:1;' },
          $('div', { style: 'font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, r.details),
          $('div', { class: 'muted', style: 'font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
            `${r.method} · ${freqLabel(r)} · next ${friendlyDate(r.nextDate)}${overdue ? ` (${Math.abs(d)}d overdue)` : d === 0 ? ' (today)' : dueSoon ? ` (in ${d}d)` : ''}`,
          ),
        ),
      ),
      $('div', { style: 'display:flex;align-items:center;gap:8px;flex-shrink:0;' },
        $('span', { class: 'display-num', style: `font-size:13px;color:${r.type === 'credit' ? 'var(--positive)' : 'var(--negative)'};` }, (r.type === 'credit' ? '+' : '') + fmt(r.amount)),
        $('button', { type: 'button', 'aria-label': `Edit ${r.details}`, title: 'Edit', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;', onClick: (ev) => { ev.stopPropagation(); openNewRecurring(r, refreshManager); } }, iconSpan('pencil', 'sm')),
        $('button', { type: 'button', 'aria-label': `Remove ${r.details}`, title: 'Remove', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1;', onClick: (ev) => {
          ev.stopPropagation();
          const removed = state.settings.recurring.filter(x => x.id === r.id);
          state.settings.recurring = state.settings.recurring.filter(x => x.id !== r.id);
          trackAction(() => { state.settings.recurring.push(...removed); persist(); }, `Restored recurring "${r.details}"`);
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

  // Prefill for edit mode
  if (existing) {
    amtInput.value = data.amount;
    descInput.value = data.details;
    methodSel.value = data.method;
    catSel.value = data.category;
    freqSel.value = data.frequency;
    daySel.value = String(data.dayOfMonth);
    noteInput.value = data.note || '';
    dayLabel.textContent = data.frequency === 'monthly' ? 'Day of month' : 'Start day';
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
        }, `Reverted edits to "${prev.details}"`);
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
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);

  const totalEl = $('span', { class: 'display-num', style: 'font-size:22px;' }, fmt(computeCashTotal(coins)));
  const rows = COINS.map(c => {
    const key = String(c.val);
    const countEl = $('span', { style: 'min-width:24px;text-align:center;font-weight:500;' }, String(coins[key]));
    // Per-row subtotal must live in a node we can refresh - computing it once
    // at render froze every row at €0.00 while only the total updated.
    const subEl = $('span', { class: 'muted', style: 'font-size:12px;width:55px;text-align:right;' }, fmt(coins[key] * c.val));
    const refresh = () => {
      countEl.textContent = String(coins[key]);
      subEl.textContent = fmt(coins[key] * c.val);
      totalEl.textContent = fmt(computeCashTotal(coins));
    };
    const decr = $('button', { type: 'button', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center;', onClick: () => {
      if (coins[key] > 0) { coins[key]--; refresh(); }
    } }, '−');
    const incr = $('button', { type: 'button', style: 'width:28px;height:28px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center;', onClick: () => {
      coins[key]++; refresh();
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
  ));

  if (state.entries.length === 0) {
    c.appendChild($('div', { class: 'card', style: 'max-width:540px;margin:0 auto 20px;padding:20px 16px;text-align:center;' },
      $('div', { class: 'serif', style: 'font-size:19px;' }, 'You’re starting fresh.'),
      $('div', { class: 'muted', style: 'font-size:12px;margin-top:4px;' }, 'Every tracker begins with one entry. Add your first one below - the magic field understands plain English.'),
    ));
  }

  // Natural-language and structured voice entry. The preview is a live parse:
  // a gentle on-ramp hint when empty, the parser's guidance when it can't find
  // an amount, and the fully resolved entry the moment it can.
  const magicPreview = $('div', { class: 'muted', style: 'font-size:12px;min-height:18px;margin-bottom:10px;' });
  // Live detection chips - each part of the grammar lights up the moment the
  // parser resolves it, so the input teaches itself as you type.
  const detectRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;' });
  const detectParts = ['Amount', 'Category', 'Account', 'Date'].map(name => {
    const el = $('span', { class: 'magic-detect-chip', 'aria-hidden': 'true', style: 'display:inline-flex;align-items:center;gap:5px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted);transition:border-color .15s,color .15s,background .15s;' }, name);
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
  const renderMagicPreview = (text) => {
    const parsed = parseNaturalLanguage(text);
    if (!String(text || '').trim()) {
      magicPreview.textContent = 'Start with an amount - the preview fills in as you type.';
      magicPreview.style.color = '';
      syncDetectChips(null);
      return;
    }
    if (parsed?.error) {
      magicPreview.textContent = parsed.error;
      magicPreview.style.color = 'var(--negative)';
      syncDetectChips(null);
      return;
    }
    magicPreview.style.color = '';
    syncDetectChips(parsed);
    magicPreview.textContent = parsed ? `${parsed.type === 'credit' ? 'Income' : 'Expense'} · ${fmt(parsed.amount)} · ${parsed.details} · ${categoryLabel(parsed.category)} · ${methodShort(parsed.method)} · ${friendlyDate(parsed.date)}` : '';
  };
  const magicInput = $('textarea', { placeholder: 'Try: Spent €18.50 at Tesco from Revolut yesterday', 'aria-label': 'Natural-language entry', rows: '2', style: 'width:100%;font-size:13px;margin-bottom:8px;', onInput: (e) => renderMagicPreview(e.target.value) });
  const magicExamples = [
    { label: 'coffee 3.50', hint: 'an expense' },
    { label: 'rent 850', hint: 'a bill' },
    { label: 'payday 1450', hint: 'income' },
  ];
  const magicChips = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;' },
    ...magicExamples.map(ex => $('button', { type: 'button', class: 'magic-chip', 'aria-label': `Example: ${ex.label} (${ex.hint})`, onClick: () => {
      magicInput.value = ex.label;
      renderMagicPreview(magicInput.value);
      magicInput.focus();
    } }, ex.label)),
  );
  const addMagic = () => {
    const parsed = parseNaturalLanguage(magicInput.value);
    if (!parsed || parsed.error) { toast(parsed?.error || 'Describe an entry first.'); magicInput.focus(); return; }
    const entry = { id: uid(), createdAt: nowIso(), date: parsed.date, type: parsed.type, category: parsed.category, details: parsed.details, amount: parsed.amount, method: parsed.method, note: 'Created with natural-language input' };
    const dup = findPotentialDuplicate(entry);
    if (dup) {
      openDuplicateConfirm(entry, dup, () => {
        state.entries.push(entry);
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        persist(); toast('Entry created from your description.'); location.hash = '#dashboard';
      });
      return;
    }
    state.entries.push(entry);
    state.entries.sort((a, b) => a.date.localeCompare(b.date));
    persist(); toast('Entry created from your description.'); location.hash = '#dashboard';
  };
  const restoreVoiceLabel = () => { voiceInputBtn.textContent = ''; voiceInputBtn.append(iconSpan('mic', 'sm'), ' Voice'); };
  const voiceInputBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'font-size:12px;', onClick: () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { toast('Voice input is not supported in this browser.'); return; }
    const recognition = new Recognition();
    recognition.lang = 'en-IE'; recognition.interimResults = false; recognition.maxAlternatives = 1;
    voiceInputBtn.textContent = 'Listening…'; voiceInputBtn.disabled = true;
    recognition.onresult = ev => { magicInput.value = ev.results[0][0].transcript; magicInput.dispatchEvent(new Event('input')); };
    recognition.onerror = () => toast('Could not hear that. Try again.');
    recognition.onend = () => { restoreVoiceLabel(); voiceInputBtn.disabled = false; };
    recognition.start();
  } }, iconSpan('mic', 'sm'), ' Voice');
  c.appendChild($('div', { class: 'card', style: `max-width:540px;margin:0 auto 20px;padding:${isNarrow() ? '18px 16px' : '22px 16px'};` },
    $('div', { class: 'eyebrow', style: 'margin-bottom:6px;' }, 'Magic entry'),
    $('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px;' }, 'Describe it naturally, check the preview, then add it.'),
    magicChips,
    magicInput,
    detectRow,
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

  const months = Array.from(new Set(state.entries.map(e => monthKey(e.date))))
    .sort((a, b) => b.localeCompare(a));
  // A stale URL month falls back to the newest month with entries, but the
  // current month is always honoured even when it's still empty ("Jump").
  if (!months.includes(activeMonth) && months.length && activeMonth !== monthKey(today())) activeMonth = months[0];

  const monthEntries = entriesForMonth(activeMonth);
  const activeMethodGroup = accountGroupForKey(activeMethod);
  const filtered = searchEntries(monthEntries, searchQuery, { type: 'all', category: activeCat, method: activeMethodGroup ? 'all' : activeMethod })
    .filter(e => !activeMethodGroup || activeMethodGroup.members.includes(e.method));
  // Sort a copy so filtering/history presentation never mutates persisted order.
  let visible = [...filtered].sort((a, b) => b.date.localeCompare(a.date)
    || ((b.createdAt || '')).localeCompare(a.createdAt || '')
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  if (activeDay) visible = visible.filter(e => e.date === activeDay);
  const expenseSum = monthEntries.filter(isSpendingEntry).reduce((s, e) => s + e.amount, 0);
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
    const qs = params.toString();
    location.hash = qs ? `history?${qs}` : 'history';
  };

  const c = $('section', { class: 'page-section', 'aria-label': 'History' });

  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, monthLabel(activeMonth)),
    $('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end;' },
      monthNav(iconSpan('chevron-left', 'md'), () => { const i = months.indexOf(activeMonth); if (i < months.length - 1) update({ month: months[i + 1] }); }, months.indexOf(activeMonth) >= months.length - 1),
      monthNav(monthKey(today()) === activeMonth ? 'Today' : 'Jump', () => update({ month: monthKey(today()) }), false),
      monthNav(iconSpan('chevron-right', 'md'), () => { const i = months.indexOf(activeMonth); if (i > 0) update({ month: months[i - 1] }); }, months.indexOf(activeMonth) <= 0),
    ),
  ));

  c.appendChild(calendarCard(activeMonth, activeDay, (ds) => update({ day: activeDay === ds ? '' : ds })));

  // Search bar
  const searchInput = $('input', { type: 'text', value: searchQuery, placeholder: 'Search descriptions, notes…', 'aria-label': 'Search entries', autocomplete: 'off', style: 'width:100%;max-width:320px;', onInput: (e) => {
    // Debounced update
    clearTimeout(searchInput._timer);
    searchInput._timer = setTimeout(() => update({ q: e.target.value }), 250);
  } });
  c.appendChild($('div', { style: 'margin-bottom:16px;' },
    $('div', { style: 'display:flex;gap:8px;align-items:center;' },
      $('span', { style: 'color:var(--muted);', 'aria-hidden': 'true' }, iconSpan('search')),
      searchInput,
      searchQuery ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { searchInput.value = ''; update({ q: '' }); } }, 'Clear') : null,
    ),
  ));

  const catCounts = {};
  for (const e of monthEntries) catCounts[e.category] = (catCounts[e.category] || 0) + 1;
  catCounts.all = monthEntries.length;

  const filterRow = $('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 12px;border-bottom:1px solid var(--line);margin-bottom:8px;' });
  filterRow.appendChild($('span', { class: 'eyebrow', style: 'align-self:center;margin-right:4px;' }, 'Category'));
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
  for (const group of ACCOUNT_GROUPS) {
    const key = `group:${group.id}`;
    const count = group.members.reduce((sum, id) => sum + (methodCounts[id] || 0), 0);
    if (count === 0 && activeMethod !== key) continue;
    methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': key, 'data-active': activeMethod === key ? 'true' : 'false', 'aria-pressed': activeMethod === key ? 'true' : 'false', onClick: () => update({ method: key }) }, `${group.label} · ${count}`));
  }
  for (const method of METHODS) {
    const count = methodCounts[method.id] || 0;
    if (count === 0 && activeMethod !== method.id) continue;
    methodFilterRow.appendChild($('button', { type: 'button', class: 'pill pill-cat', 'data-id': method.id, 'data-active': activeMethod === method.id ? 'true' : 'false', 'aria-pressed': activeMethod === method.id ? 'true' : 'false', onClick: () => update({ method: method.id }) }, `${methodShort(method.id)} · ${count}`));
  }
  c.appendChild(filterRow);
  c.appendChild(methodFilterRow);

  // Bulk selection - checkboxes in the header and each row, plus a toolbar.
  const selected = new Set();
  const bulkBar = $('div', { class: 'bulk-bar', style: 'display:none;margin-bottom:12px;padding:10px 16px;border:1px solid var(--accent);border-radius:var(--radius);background:var(--accent-soft);align-items:center;justify-content:space-between;gap:12px;' },
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
  function bulkDeleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    const affected = [];
    const seen = new Set();
    let protectedCount = 0;
    for (const id of ids) {
      const removed = deletionEntriesFor(id);
      if (removed.map(reconciliationProtectionFor).find(Boolean)) { protectedCount++; continue; }
      for (const e of removed) { if (!seen.has(e.id)) { seen.add(e.id); affected.push(e); } }
    }
    if (!affected.length) {
      toast('None of those entries can be deleted - they are protected by reconciliation.');
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
    }, `Restored ${removedCopy.length} deleted entr${removedCopy.length === 1 ? 'y' : 'ies'}`, removedCopy);
    toast(protectedCount ? `Deleted ${removedCopy.length} (${protectedCount} kept - protected).` : `Deleted ${removedCopy.length} entr${removedCopy.length === 1 ? 'y' : 'ies'}.`);
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
      options: METHODS.map(m => ({ id: m.id, label: m.label })),
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

  const tableWrap = $('div', { class: 'card', style: 'overflow-x:auto;padding:0;' });
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
      $('span'),
    ));

    let previousVisibleDate = null;
    for (const e of visible) {
      if (e.date !== previousVisibleDate) {
        previousVisibleDate = e.date;
        tableWrap.appendChild($('div', { class: 'history-day-header', role: 'row' },
          $('span', { role: 'rowheader', class: 'eyebrow' }, relativeDayLabel(e.date)),
        ));
      }
      const isTransfer = !!e.transferId;
      const settledLabel = isTransfer
        ? $('span', { class: `history-settled${e.settled ? ' is-settled' : ''}`, onClick: (ev) => {
            ev.stopPropagation();
            const newVal = !e.settled;
            for (const x of state.entries) {
              if (x.transferId === e.transferId) x.settled = newVal;
            }
            persist(); toast(newVal ? 'Transfer settled.' : 'Transfer unsettled.'); render();
          }, title: 'Click to toggle settled' },
            iconSpan(e.settled ? 'check-circle' : 'circle', 'sm'),
            e.settled ? ' settled' : ' unsettled')
        : null;
      const rowBalance = cachedBalanceForEntry(e);
      const rowType = e.type === 'note' ? 'note-row' : e.type === 'credit' ? 'income-row' : 'expense-row';
      const isCredit = e.type === 'credit';
      const row = $('div', { class: `history-row ${rowType}`, role: 'row', tabindex: '0', 'data-id': e.id, 'aria-label': `Edit entry ${e.details} on ${friendlyDate(e.date)}`, onClick: (ev) => { if (ev.target.closest('input[data-bulk]')) return; openEdit(e.id); }, onKeydown: (ev) => { if (ev.target.closest('input')) return; if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdit(e.id); } } },
        $('span', { role: 'cell', class: 'history-cell-check' }, $('input', { type: 'checkbox', 'data-bulk': '', checked: selected.has(e.id) ? true : null, 'aria-label': `Select ${e.details || 'entry'}`, onClick: (ev) => ev.stopPropagation(), onChange: (ev) => {
          if (ev.target.checked) selected.add(e.id); else selected.delete(e.id);
          syncBulkBar();
        } })),
        $('span', { class: 'muted history-date' }, friendlyDate(e.date)),          $('div', { class: 'history-details-wrap' },
            $('div', { class: 'history-details' }, e.details || '-',
              e.type === 'note' && e.audioData ? $('audio', { controls: '', preload: 'none', src: e.audioData, class: 'history-audio' }) : null,
            isTransfer ? settledLabel : null,
          ),
          $('div', { class: 'history-category' }, categoryLabel(e.category)),
        ),
        $('span', { class: `display-num history-amount${isCredit ? ' is-credit' : ''}` }, e.type === 'note' ? 'Note' : (isCredit ? '+' : '') + fmt(e.amount)),
        $('span', { class: `tnum history-balance${rowBalance >= 0 ? ' is-positive' : ' is-negative'}` }, e.type === 'note' ? '-' : fmt(rowBalance)),
        $('span', { class: 'history-method-wrap' }, $('span', { class: 'pill history-method' }, e.method)),
        $('span', { class: 'history-actions' },
          $('button', { type: 'button', class: 'history-action-btn', title: 'Edit or delete entry', 'aria-label': `Edit or delete ${e.details || 'entry'}`, onClick: ev => { ev.stopPropagation(); openEdit(e.id); } }, 'Manage'),
        ),
      );

      tableWrap.appendChild(row);
    }
  }
  c.appendChild(tableWrap);

  const histSumEl = $('span', { class: 'display-num', style: 'font-size:30px;' }, fmt(expenseSum));
  countUp(histSumEl, expenseSum, 'hist-sum');
  c.appendChild($('div', { class: 'summary-row' },
    $('span', { class: 'eyebrow' }, 'Monthly sum · expenses'),
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
  return $('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
    $('div', { class: 'row between', style: 'margin-bottom:14px;' },
      $('div', null,
        $('div', { class: 'eyebrow' }, 'Calendar'),
        $('div', { class: 'muted', style: 'font-size:11px;margin-top:3px;' }, activeDay ? `Showing ${friendlyDate(activeDay)}.` : 'Tap a day to filter the entries below.'),
      ),
      activeDay ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => onDayChange('') }, 'Clear') : null,
    ),
    $('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;' },
      ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(l => $('div', { class: 'cal-dow' }, l)),
      ...cells,
    ),
    $('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:10px;font-size:10px;color:var(--muted);' },
      $('span', null, 'Less'), ...[0.2, 0.4, 0.6, 0.8, 1].map(p => $('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${heatColor(p)};opacity:0.85;` })), $('span', null, 'More'),
    ),
  );
}

function monthNav(label, onClick, disabled) {
  return $('button', { type: 'button', class: 'btn btn-ghost', disabled: disabled ? '' : null, style: 'height:28px;padding:0 12px;font-size:13px;line-height:16px;font-weight:500;border-radius:6px;', onClick }, label);
}

// ---------- screens: balances ----------
// Reconcile end-of-day actual balances by date; no transaction records are
// changed. All tracked balances share one inline reconciliation flow.
function screenBalances() {
  const c = $('section', { class: 'page-section', 'aria-label': 'Balances' });

  c.appendChild($('div', { class: 'page-title-row' },
    $('h1', { class: 'page-title' }, 'Balances'),
    $('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end;' },
      $('a', { href: '#history', class: 'btn btn-ghost', style: 'padding:8px 14px;font-size:12px;' }, 'Transaction history'),
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
      ...renderAccountBalanceRows({ editable: true }),
    ),
  ));

  c.appendChild($('div', { class: 'card', style: `padding:${isNarrow() ? '18px 16px' : '24px 16px'};margin-bottom:24px;` },
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

  return c;
}

// ---------- screens: insights ----------
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

function screenInsights() {
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  const fromParam = params.get('from') || '';
  const toParam = params.get('to') || '';
  const defaultFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return localDateKey(d); })();
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
      $('span', { class: 'muted', style: 'font-size:13px;display:inline-flex;' }, iconSpan('arrow-right', 'sm')),
      toInput,
      (fromParam || toParam) ? $('button', { type: 'button', class: 'btn-link', style: 'font-size:12px;', onClick: () => { location.hash = 'insights'; } }, 'Reset') : null,
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

  c.appendChild($('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin-bottom:32px;' },
    statCard('Average / month', avg, 'ins-avg'),
    statCard('Top method', topMethodEntry ? `${(methodShort(topMethodEntry[0]))} · ${fmt(topMethodEntry[1])}` : '-'),
    statCard('Entries', String(recent.filter(isSpendingEntry).length)),
    statCard('Categories active', String(new Set(recent.filter(isSpendingEntry).map(e => e.category)).size)),
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
      intensity < 0.25 ? 0.22 : intensity < 0.5 ? 0.42 : intensity < 0.75 ? 0.65 : 0.9
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
        val > 0 ? $('span', { style: 'color:var(--ink);font-weight:600;font-size:8px;' }, String(d)) : null,
      ),
    ));
  }

  const heatGrid = $('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;' },
    ...['M','T','W','T','F','S','S'].map(l => $('div', { style: 'text-align:center;font-size:10px;color:var(--muted);padding-bottom:4px;' }, l)),
    ...heatCells,
  );
  wireHeatTippy(heatGrid);
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

  c.appendChild($('div', { class: 'card', style: 'padding:24px 16px;margin-bottom:24px;' },
    $('div', { class: 'eyebrow', style: 'margin-bottom:20px;' }, 'By category'),
    catRows.length === 0
      ? $('div', { class: 'empty' }, emptyIcon('coin'), ' No expenses in this range.')
      : $('div', { style: 'display:flex;flex-direction:column;gap:22px;' },
          donutChart(catRows),
          $('div', { style: 'display:flex;flex-direction:column;gap:18px;' },
            ...catRows.map(([cat, val]) => barWithSpark(cat, val, maxCat, val === maxCat)),
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
function statCard(label, value, countKey) {
  const numEl = $('div', { class: 'display-num', style: 'font-size:30px;margin-top:8px;' }, typeof value === 'number' && countKey ? '' : value);
  if (countKey && typeof value === 'number') countUp(numEl, value, countKey);
  return $('div', { class: 'card', style: 'padding:20px 16px;' },
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

// Draw-in the donut segments with anime.js; loads the library lazily on
// first use. If the segments were detached by a re-render mid-load, or the
// library fails, the final (fully-drawn) state is set instead.
function drawDonutAnimated(segments) {
  if (typeof anime !== 'undefined') {
    anime({ targets: segments, strokeDashoffset: el => el._finalOff, duration: 1000, delay: anime.stagger(90), easing: 'easeOutQuart' });
    return;
  }
  const settle = () => segments.forEach(seg => seg.setAttribute('stroke-dashoffset', String(seg._finalOff)));
  loadVendor('anime', { js: 'vendor/anime.min.js' })
    .then(() => {
      if (typeof anime !== 'undefined' && segments.every(seg => seg.isConnected)) {
        anime({ targets: segments, strokeDashoffset: el => el._finalOff, duration: 1000, delay: anime.stagger(90), easing: 'easeOutQuart' });
      } else settle();
    })
    .catch(settle);
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

function barWithSpark(cat, val, max, isMax) {
  const values = categorySparkData(cat);
  const hasSpark = values.some(v => v > 0);
  return $('div', { class: 'insight-bar-row' },
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
function donutChart(rows) {
  const total = rows.reduce((s, [, v]) => s + v, 0);
  if (!total) return null;
  const R = 52, C = 2 * Math.PI * R, W = 180, H = 180;
  let acc = 0;
  const segments = rows.map(([, val], i) => {
    const frac = val / total;
    const len = Math.max(0, frac * C - 2);
    const finalOff = -acc * C;
    const seg = $('circle', { cx: W / 2, cy: H / 2, r: R, fill: 'none', stroke: DONUT_PALETTE[i % DONUT_PALETTE.length], 'stroke-width': 16, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': String(finalOff - len), style: 'transition:stroke-dasharray .6s cubic-bezier(0.2,0.8,0.2,1);' });
    seg._finalOff = finalOff;
    acc += frac;
    return seg;
  });
  // Draw-in animation via anime.js; reduced-motion and missing-library
  // fallbacks land on the final state immediately. anime.js is fetched
  // lazily on first use; until it arrives the donut just shows final state.
  if (!_reduceMotion) {
    drawDonutAnimated(segments);
  } else {
    segments.forEach(seg => seg.setAttribute('stroke-dashoffset', String(seg._finalOff)));
  }
  const legend = rows.map(([cat, val], i) => {
    const pct = Math.round((val / total) * 100);
    return $('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12px;' },
      $('span', { style: `width:8px;height:8px;border-radius:2px;background:${DONUT_PALETTE[i % DONUT_PALETTE.length]};flex-shrink:0;` }),
      $('span', { style: 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, categoryLabel(cat)),
      $('span', { class: 'muted', style: 'flex-shrink:0;' }, `${pct}%`),
    );
  });
  return $('div', { style: 'display:flex;align-items:center;gap:28px;flex-wrap:wrap;' },
    $('div', { style: 'position:relative;flex-shrink:0;' },
      $('svg', { viewBox: `0 0 ${W} ${H}`, width: '150', height: '150', 'aria-label': 'Category share donut', style: 'transform:rotate(-90deg);' }, ...segments),
      $('div', { style: 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;' },
        $('span', { class: 'display-num', style: 'font-size:20px;' }, fmt(total)),
        $('span', { class: 'muted', style: 'font-size:10px;' }, 'spent'),
      ),
    ),
    $('div', { style: 'display:flex;flex-direction:column;gap:8px;flex:1;min-width:150px;' }, ...legend),
  );
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
  months.forEach((m, i) => {
    const x = xAt(i);
    if (m.exp > 0) rects.push($('rect', { x, y: yAt(m.exp), width: bw, height: H - padB - yAt(m.exp), rx: 2, style: 'fill:var(--chart-bar);' }));
    if (m.inc > 0) rects.push($('rect', { x: x + bw + 4, y: yAt(m.inc), width: bw, height: H - padB - yAt(m.inc), rx: 2, style: 'fill:var(--positive);' }));
    labels.push($('text', { x: x + bw + 2, y: H - 8, 'text-anchor': 'middle', style: 'fill:var(--muted);font-size:9px;' }, monthLabel(m.key).split(' ')[0].slice(0, 3)));
  });
  return $('div', null,
    $('div', { style: 'display:flex;gap:14px;justify-content:flex-end;margin-bottom:10px;' },
      $('span', { class: 'muted', style: 'font-size:11px;display:flex;align-items:center;gap:5px;' }, $('span', { style: 'width:8px;height:8px;border-radius:2px;background:var(--chart-bar);' }), 'Spending'),
      $('span', { class: 'muted', style: 'font-size:11px;display:flex;align-items:center;gap:5px;' }, $('span', { style: 'width:8px;height:8px;border-radius:2px;background:var(--positive);' }), 'Income'),
    ),
    $('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Monthly spending vs income, last 12 months', style: 'width:100%;height:auto;' }, ...rects, ...labels),
  );
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

  modal.appendChild($('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;' },
    $('button', { type: 'button', class: 'btn btn-ghost', onClick: close }, 'Close'),
    $('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
      const text = rows.map(([l,v]) => `${l}: ${v}`).join('\n');
      navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard!'), () => toast('Could not copy.'));
    } }, 'Copy summary'),
  ));
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
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
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
    $('button', { type: 'button', class: 'btn btn-primary', style: 'background:var(--negative);', onClick: () => {
      const removed = pair.map(entry => ({ ...entry }));
      if (deleteEntryOrTransfer(e.id)) {
        trackAction(() => {
          state.entries.push(...removed);
          state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          untombstoneIds(removed.map(e => e.id));
          persist();
        }, 'Restored transfer pair', removed);
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

  // Edit form (no delete button inside formView - we'll put it as a two-stage below)
  let formNode;
  const formContainer = $('div');
  modal.appendChild($('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;' },
    $('h2', { style: 'font-family:"Space Grotesk",sans-serif;font-weight:400;font-size:26px;' }, 'Edit entry'),
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
        untombstoneIds(removed.map(e => e.id));
        persist();
      }, e.transferId ? 'Restored transfer pair' : `Restored ${e.details}`, removed);
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
        // Start background reconciliation immediately so data flows both ways
        // as soon as the connection is established.
        startSyncPolling();
        silentSyncPoll();
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
      // without typing the password.
      if (s.password) {
        const link = syncSetupLink();
        if (link) {
          const linkInput = $('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Sync setup link', style: 'font-size:11px;font-family:"IBM Plex Mono",Menlo,monospace;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius);width:100%;min-width:0;color:var(--muted);background:var(--bg-deep);' });
          const copyBtn = $('button', { type: 'button', class: 'btn btn-ghost', style: 'padding:6px 10px;font-size:11px;flex-shrink:0;', onClick: async () => {
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
              ? 'Setup link copied - open it on your other device.'
              : 'Copy the link above to use on your other device.');
          } }, 'Copy');
          modal.appendChild($('div', { style: 'margin-top:24px;padding-top:18px;border-top:1px solid var(--line);' },
            $('div', { class: 'eyebrow' }, 'Add another device'),
            $('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 10px;' }, 'Open this link on your other device and sync starts automatically - no password to type. Anyone with the link can read and write your synced data, so keep it private.'),
            $('div', { style: 'display:flex;gap:8px;align-items:center;' }, linkInput, copyBtn),
          ));
        }
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
function dashboardPulse(key, expenseSum, runningBalance) {
  const t = today();
  const todays = state.entries.filter(e => e.date === t && e.type !== 'note');
  const spentToday = todays.filter(isBudgetSpendingEntry).reduce((s, e) => s + e.amount, 0);
  const earnedToday = todays.filter(isBudgetIncomeEntry).reduce((s, e) => s + e.amount, 0);
  const todaySummary = todays.length
    ? `${todays.length} entr${todays.length === 1 ? 'y' : 'ies'}${spentToday ? ' · −' + fmt(spentToday) : ''}${earnedToday ? ' · +' + fmt(earnedToday) : ''}`
    : 'nothing yet';

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
  } else if (forecast.budget && forecast.projected > forecast.budget) {
    headline = `${Math.round((forecast.projected / forecast.budget) * 100)}%`; caption = 'of budget';
    message = `Projected ${fmt(forecast.projected)} against ${fmt(forecast.budget)}.`;
    tone = 'var(--negative)'; status = 'Over budget';
  } else if (forecast.budget) {
    headline = fmt(Math.max(0, forecast.remaining)); caption = 'left this month';
    message = 'You are comfortably within budget.';
    tone = 'var(--positive)'; status = 'On track';
  } else {
    headline = fmt(runningBalance); caption = 'balance';
    message = 'Set a monthly budget to see your pace.';
    tone = 'var(--muted)'; status = 'Tracking';
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
      stat('Runway', runway.dailyAvg > 0 && runway.daysToZero !== null ? `${runway.daysToZero} days` : '-'),
      stat('Spent', fmt(forecast.spent), 'var(--negative)'),
      stat('Projected', fmt(forecast.projected), 'var(--negative)'),
      forecast.budget ? stat('Remaining', fmt(forecast.remaining)) : stat('Balance', fmt(runningBalance)),
      monthBudget ? stat('Safe today', fmt(safeToday), remainingBudget <= 0 ? 'var(--negative)' : '') : null,
      stat('Avg / day', fmt(expenseSum / Math.max(nowP.getDate(), 1)), 'var(--negative)'),
      monthBudget && expenseSum > 0 ? stat('Burn rate', (() => {
        const daysLeft = new Date(nowP.getFullYear(), nowP.getMonth() + 1, 0).getDate() - nowP.getDate();
        const projected = expenseSum + (expenseSum / Math.max(nowP.getDate(), 1)) * daysLeft;
        const pctProj = Math.round((projected / monthBudget) * 100);
        return pctProj > 100 ? $('span', { style: 'display:inline-flex;align-items:center;gap:5px;' }, iconSpan('alert', 'md'), `${pctProj}%`) : `${pctProj}%`;
      })()) : null,
    ),
    $('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 20px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);' },
      $('span', null, 'Today ', $('span', { style: 'color:var(--ink);' }, todaySummary)),
      $('span', null, 'Next due ', $('span', { style: 'color:var(--ink);' }, next ? `${next.rec.details}${daysUntil(next.date) === 0 ? ' today' : ` in ${daysUntil(next.date)}d`}` : '-')),
    ),
    comparison.previous > 0 ? $('div', { class: 'pulse-footnote muted' },
      `${comparison.difference <= 0 ? 'Down' : 'Up'} ${fmt(Math.abs(comparison.difference))} from ${monthLabel(comparison.previousKey)}.`,
    ) : null,
    $('a', { href: '#insights', class: 'btn-link', style: 'margin-top:10px;font-size:13px;' }, 'See details ', iconSpan('arrow-right', 'sm')),
  );
}

// ---------- toast ----------
// Toasts stack instead of replacing each other, so a later action can't wipe
// out an earlier toast's Undo button. The undo action is snapshotted at
// creation time (not looked up when clicked), and the stack is capped so a
// rapid burst can't pile up forever.
const MAX_TOASTS = 3;
function toast(text, undoFn, undoLabel) {
  let host = document.querySelector('.toast-host');
  if (!host) { host = $('div', { class: 'toast-host' }); document.body.appendChild(host); }
  // Snapshot the undo at creation: an explicit undoFn wins, otherwise capture
  // the currently-tracked action so an old toast never undoes a newer one.
  const tracked = _lastAction;
  const runUndo = undoFn || (tracked ? () => {
    tracked.undo();
    if (_lastAction === tracked) _lastAction = null;
    toast(`Undone: ${tracked.label}`);
    render();
  } : null);
  const children = [text];
  if (runUndo) {
    children.push($('button', { type: 'button', class: 'toast-undo', onClick: () => { runUndo(); t.remove(); } }, undoLabel || (runUndo ? 'Undo' : '')));
  }
  const t = $('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, ...children);
  host.appendChild(t);
  while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();
  // Toasts carrying an Undo button stay long enough to read and act on;
  // plain notifications dismiss quickly.
  setTimeout(() => t.remove(), runUndo ? 5000 : 2200);
}

// Offer the persisted undo journal after a reload. The toast is transient, but
// the journal is kept until it is actually undone (or superseded) so the
// persistent Undo button keeps offering it after the toast expires.
function offerPersistedUndo() {
  const journal = loadUndoJournal();
  if (!journal || !(journal.entries?.length || journal.checkpoints?.length)) return;
  const missing = missingJournalData(journal);
  if (!missing.entries.length && !missing.checkpoints.length) {
    // Nothing left to restore (the data still exists, e.g. a load that was
    // never undone, or an already-restored delete). Drop the stale journal
    // silently so the offer stops appearing on every reload.
    clearUndoJournal();
    return;
  }
  toast(`You can undo “${journal.label || 'that change'}” from before your last reload.`, () => {
    restoreUndoJournal(journal);
    toast(`Undone: ${journal.label || 'that change'}`);
    clearUndoJournal();
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

function _render() {
  const main = document.getElementById('app');
  if (!main) return;
  const focusedField = captureFocusedField();
    // Init dark mode + season on first render - dark is the default
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
  const screen = $('main', { class: `shell screen${shouldAnimateScreen ? ' stagger' : ' screen-static'}`, id: 'screen' });
  switch (route) {
    case 'add':      screen.appendChild(screenAdd()); break;
    case 'history':  screen.appendChild(screenHistory()); break;
    case 'balances': screen.appendChild(screenBalances()); break;
    case 'insights': screen.appendChild(screenInsights()); break;
    default:         screen.appendChild(screenDashboard());
  }
  // A per-child rise animation on a huge subtree (the History table) forces
  // the browser to rasterize the whole thing into a composite layer on every
  // navigation - keep the single cheap screenIn fade for heavy screens and
  // stagger only light ones, so navigation stays instant.
  if (shouldAnimateScreen && (screen.querySelector('.history-row') || screen.children.length > 12)) {
    screen.classList.remove('stagger');
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
      balances: { outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h12"/><path d="M20 7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7"/><rect x="16" y="11" width="4" height="5" rx="1"/></svg>', filled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M4 4h14a3 3 0 0 1 3 3v1h-4.5a2.5 2.5 0 0 0 0 5H21v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 1-2.2A3 3 0 0 1 4 4z"/><rect x="14" y="10" width="4" height="2" rx="1"/></svg>' },
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
    { id: 'insights', label: 'Insights' },
  ];
  main.appendChild($('nav', { class: 'bottom-tab-bar', 'aria-label': 'Mobile navigation' },
    ...tabItems.map(t => $('a', { href: `#${t.id}`, class: 'bottom-tab', 'aria-current': t.id === route2 ? 'page' : null },
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
    $('span', null, String(state.entries.length), ` entr${state.entries.length === 1 ? 'y' : 'ies'} \u00b7 `, getSyncSettings().enabled ? 'cloud-synced' : 'stored locally'),
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
      $('button', { type: 'button', class: 'footer-action', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) }, iconSpan('arrow-up', 'sm'), 'Top'),
    ),
  ));

  // Persistent undo button (fixed position; hidden when nothing is reversible).
  const undoFab = renderUndoFab();
  if (undoFab) main.appendChild(undoFab);

  // Route changes should land at the top of the page; only same-route
  // re-renders restore the user's scroll position.
  window.scrollTo(0, shouldAnimateScreen ? 0 : scrollY);
  // Rebuilding a same-route screen should not make typing/searching lose focus
  // or move the caret. Newly opened forms still manage their own initial focus.
  if (!shouldAnimateScreen) restoreFocusedField(focusedField);

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
      if (window.innerWidth < 640) return;
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

// Watermelon-style mouse spotlight: feeds --mx/--my CSS vars so the hovered
// card draws a radial glow that follows the cursor (see .card::after).
// Desktop-only (fine pointers) and rAF-throttled so touch scroll and rapid
// moves never read layout or write styles more than once per frame.
function initCardSpotlight() {
  if (window.__centsSpotlight) return;
  window.__centsSpotlight = true;
  const fine = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!fine) return;
  let rafId = null;
  // Repainting the card's radial gradient is the most expensive thing the
  // page does while the mouse is moving (a full-surface paint per frame), so
  // the glow is throttled to ~25fps and sub-10px micro-moves are skipped —
  // the eye can't track the glow faster than that, and the page stays fluid.
  let lastSpot = { card: null, x: -1e9, y: -1e9, t: 0 };
  document.addEventListener('pointermove', (e) => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const target = e.target;
      const card = target && target.closest ? target.closest('.card') : null;
      if (!card || !card.isConnected) return;
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const now = performance.now();
      if (card === lastSpot.card
        && Math.abs(x - lastSpot.x) < 10 && Math.abs(y - lastSpot.y) < 10
        && now - lastSpot.t < 40) return;
      lastSpot = { card, x, y, t: now };
      card.style.setProperty('--mx', `${x}px`);
      card.style.setProperty('--my', `${y}px`);
    });
  }, { passive: true });
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
  initCardSpotlight();
  // First-run setup replaces the default-PIN lock on a fresh install; every
  // later visit boots to the privacy lock as before. Cloud sync and the
  // persisted-undo offer start after the first surface resolves (onboarding
  // or unlock).
  applySetupLinkIfPresent();
  if (needsOnboarding()) showOnboarding();
  else if (hasPinLock()) showPinLock();
  render();
});

// Expose tiny global for DevTools tinkering
window.__cents = {
  resetToBlank, render, toast,
  initSync, scheduleSyncPush, doAutoPush,
  renderSyncIndicator, openSyncSettings,
  syncPull, syncPush,
  registerBiometric, unlockWithBiometric,
};
