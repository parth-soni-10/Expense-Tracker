/* ============================================================
   Sync settings — stored separately from app state.
   Lives under its own localStorage key so wiping expenses
   doesn't wipe sync config (and vice versa).

   Every key is namespaced under the ACTIVE PROFILE (profiles.js),
   so profiles keep separate PINs, biometric credentials, and sync
   credentials. The per-profile sync password is also the profile's
   CLOUD password: the sync proxy maps <profile-id> to a dedicated
   APP_PASSWORD_<ID> env var and a dedicated cloud file.
   ============================================================ */

import { nsKey } from './profiles.js';

const KEY = () => nsKey('sync');
const PRIVACY_KEY = () => nsKey('privacy');
const BIOMETRIC_KEY = () => nsKey('bio');

const SYNC_DEFAULTS = Object.freeze({
  enabled: false,
  // Same-origin by default; override if proxying somewhere else.
  endpoint: '/.netlify/functions/sync',
  // The password the client sends to the Netlify Function.
  password: '',
  // Connection bookkeeping shown in the UI.
  lastSyncAt: null,   // ISO timestamp
  lastSha: null,      // GitHub blob SHA from most recent successful read/write
  lastErrorAt: null,
  lastError: null,
  // Which repo we're connected to (for display).
  repoLabel: '',      // e.g. "yourname/cents-data \u00b7 data.json @ main"
});

/** Is an endpoint URL acceptable? Same-origin path, https, or a localhost
 *  http URL. Empty string is allowed (means "use the default"). Shared by
 *  settings normalization and the sync test-connection flow. */
export function isValidEndpoint(candidateEndpoint) {
  return candidateEndpoint === ''
    || (/^\/(?!\/)/.test(candidateEndpoint))
    || /^https:\/\//i.test(candidateEndpoint)
    || /^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(candidateEndpoint);
}

function normalizeSyncSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const candidateEndpoint = typeof source.endpoint === 'string' ? source.endpoint.trim() : '';
  const validEndpoint = isValidEndpoint(candidateEndpoint);
  return {
    ...SYNC_DEFAULTS,
    enabled: source.enabled === true,
    endpoint: validEndpoint && candidateEndpoint ? candidateEndpoint : SYNC_DEFAULTS.endpoint,
    password: typeof source.password === 'string' ? source.password : '',
    lastSyncAt: typeof source.lastSyncAt === 'string' ? source.lastSyncAt : null,
    lastSha: typeof source.lastSha === 'string' && source.lastSha ? source.lastSha : null,
    lastErrorAt: typeof source.lastErrorAt === 'string' ? source.lastErrorAt : null,
    lastError: typeof source.lastError === 'string' && source.lastError ? source.lastError : null,
    repoLabel: typeof source.repoLabel === 'string' ? source.repoLabel.slice(0, 240) : '',
  };
}

export function getSyncSettings() {
  try {
    const raw = localStorage.getItem(KEY());
    return normalizeSyncSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...SYNC_DEFAULTS };
  }
}

function setSyncSettings(next) {
  try { localStorage.setItem(KEY(), JSON.stringify(next)); }
  catch (e) { console.warn('Failed to save sync settings:', e); }
}

export function patchSyncSettings(patch) {
  const next = { ...getSyncSettings(), ...patch };
  setSyncSettings(next);
  return next;
}

export function clearSyncSettings() {
  try { localStorage.removeItem(KEY()); } catch (e) { console.warn('Failed to clear sync settings:', e); }
}

// Device-only privacy credentials. These are deliberately separate from the
// synced expense state so a PIN hash cannot be exported or pushed to GitHub.
// kdf marks how the hash was derived: 'pbkdf2' (current) vs null (legacy
// single-round SHA-256). Absence of the field means legacy.
export function getPrivacyPin() {
  try {
    const raw = localStorage.getItem(PRIVACY_KEY());
    if (!raw) return { salt: null, hash: null, kdf: null };
    const parsed = JSON.parse(raw);
    return {
      salt: typeof parsed.salt === 'string' ? parsed.salt : null,
      hash: typeof parsed.hash === 'string' && /^[a-f0-9]{64}$/i.test(parsed.hash) ? parsed.hash.toLowerCase() : null,
      kdf: parsed.kdf === 'pbkdf2' ? 'pbkdf2' : null,
    };
  } catch {
    return { salt: null, hash: null, kdf: null };
  }
}

export function setPrivacyPin(hash, salt = null, kdf = null) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)
    || (salt !== null && typeof salt !== 'string')
    || (kdf !== null && kdf !== 'pbkdf2')) return false;
  try {
    const next = { hash: hash.toLowerCase(), salt };
    if (kdf === 'pbkdf2') next.kdf = 'pbkdf2';
    localStorage.setItem(PRIVACY_KEY(), JSON.stringify(next));
    // Do not report success until the credential can be read back. This keeps
    // legacy state.pinHash as a safe fallback when storage is unavailable or
    // silently refuses writes (private browsing/quota failures).
    const saved = getPrivacyPin();
    return saved.hash === hash.toLowerCase() && saved.salt === salt && saved.kdf === kdf;
  } catch (e) {
    console.warn('Failed to save privacy settings:', e);
    return false;
  }
}

export function clearPrivacyPin() {
  try {
    localStorage.removeItem(PRIVACY_KEY());
    return !getPrivacyPin().hash;
  } catch (e) {
    console.warn('Failed to clear privacy settings:', e);
    return false;
  }
}

// Device-only biometric credential (WebAuthn platform authenticator —
// fingerprint / Face ID). Like the PIN hash this lives under its own key,
// separate from synced expense state, so a credential ID can never be
// exported or pushed to GitHub. The credential ID is stored base64url.
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function getBiometricCredential() {
  try {
    const raw = localStorage.getItem(BIOMETRIC_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const credentialId = typeof parsed.credentialId === 'string' && B64URL_RE.test(parsed.credentialId)
      ? parsed.credentialId : null;
    return credentialId ? { credentialId } : null;
  } catch {
    return null;
  }
}

export function setBiometricCredential(credentialId) {
  if (typeof credentialId !== 'string' || !B64URL_RE.test(credentialId) || credentialId.length > 512) return false;
  try {
    localStorage.setItem(BIOMETRIC_KEY(), JSON.stringify({ credentialId }));
    return !!getBiometricCredential();
  } catch (e) {
    console.warn('Failed to save biometric settings:', e);
    return false;
  }
}

export function clearBiometricCredential() {
  try {
    localStorage.removeItem(BIOMETRIC_KEY());
    return !getBiometricCredential();
  } catch (e) {
    console.warn('Failed to clear biometric settings:', e);
    return false;
  }
}
