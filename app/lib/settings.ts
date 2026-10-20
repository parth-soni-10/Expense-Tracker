/* ============================================================
   Sync settings — stored separately from app state.
   Lives under its own localStorage key so wiping expenses
   doesn't wipe sync config (and vice versa).

   Every key is namespaced under the ACTIVE PROFILE (profiles.js),
   so profiles keep separate PINs, biometric credentials and sync
   credentials. The per-profile sync password is also that
   profile's CLOUD password: the sync proxy maps <profile-id> to a
   dedicated APP_PASSWORD_<ID> env var and a dedicated cloud file
   (see netlify/functions/lib/profiles.mjs).
   ============================================================ */

import { nsKey } from './profiles.ts';

const KEY = () => nsKey('sync');
const PRIVACY_KEY = () => nsKey('privacy');
const BIOMETRIC_KEY = () => nsKey('bio');

/* The appearance choice, and the ONE key that is deliberately not namespaced
 * per profile: the theme is a property of the DEVICE, not of a ledger, so a
 * second profile on the same phone is not a second light/dark choice. It is
 * also not part of the document, so it is never synced and never travels with
 * a backup — which is the same rule the sync settings follow.
 *
 * `cents-theme` is the only key and `data-theme` is the only attribute. Light
 * is the default: the stylesheet's `:root` is the light palette and
 * `[data-theme="dark"]` overrides it, so the attribute is only written for a
 * device that has chosen dark. `app/theme-init.js` reads this same key before
 * the stylesheets and the bundle run, so a device that has chosen dark never
 * flashes light on the way in.
 */
const THEME_KEY = 'cents-theme';

export function getTheme(): 'light' | 'dark' {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Remember the theme. A device that cannot remember it still shows it now;
 *  the next visit starts from the default again. */
export function setTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem(THEME_KEY, theme === 'dark' ? 'dark' : 'light');
  } catch {
    /* read-only storage: the choice is still in effect for this session */
  }
}

/**
 * The endpoint a device uses when it has not been pointed somewhere else.
 *
 * A SAME-ORIGIN PATH, not a host: whichever deployment answers — the Worker,
 * or the Pages deployment running the same bundled entry point — serves it,
 * so the app talks to the site it was loaded from and needs no configuration
 * to do it. It is named for the host that serves it — Cloudflare — rather than
 * for the host this project migrated off; see LEGACY_SYNC_ENDPOINT below for
 * the old name, which is still recognised and still routed. Everything
 * else the app calls (setup-token, profiles-admin) is DERIVED from this at
 * runtime by replacing the last path segment — sync.js's setupTokenEndpoint —
 * so a device pointed at a custom deployment moves it too.
 */
export const DEFAULT_SYNC_ENDPOINT = '/api/sync';

/**
 * The path this app called its sync endpoint before the rename, and what every
 * device that was set up before it still has in storage.
 *
 * Kept as a name it RECOGNISES rather than one it writes: functions/_router.js still
 * routes it, so a device that never re-saves its settings keeps working
 * unchanged, and the two values below are what let the app treat the old name
 * as "the default" (isDefaultSyncEndpoint) instead of as somebody's custom
 * endpoint.
 */
const LEGACY_SYNC_ENDPOINT = '/.netlify/functions/sync';

const SYNC_DEFAULTS = Object.freeze({
  enabled: false,
  // Same-origin by default; override if proxying somewhere else.
  endpoint: DEFAULT_SYNC_ENDPOINT,
  // The password the client sends to the sync endpoint.
  password: '',
  // Connection bookkeeping shown in the UI.
  lastSyncAt: null,   // ISO timestamp
  lastSha: null,      // GitHub blob SHA from most recent successful read/write
  lastErrorAt: null,
  lastError: null,
  // Which repo we're connected to (for display).
  repoLabel: '',      // e.g. "yourname/cents-data \u00b7 data.json @ main"
  // The last mirror-gap verdict the app saw (sync.js's mirrorStatus renders
  // it). Cached on the device so the Data menu can say what the state was
  // without a request, and so a gap survives the reload that would otherwise
  // be the moment somebody would notice it.
  mirror: null,
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

/**
 * The endpoint a STORED value should become, repairing the two shapes that are
 * known to be dead ends rather than letting them sit in storage and fail:
 *
 *   * this app's own pre-rename default. It names a host that does not serve
 *     this app — the path is served by Cloudflare — and it still answers, but
 *     leaving it there means the Sync screen keeps showing a Netlify path to
 *     someone whose site never ran on Netlify. Rewritten to the current
 *     default, which is the same same-origin endpoint under its own name.
 *   * a `*.netlify.app` URL. The site used to live on one, and that host is
 *     gone, so a device still pointing at it cannot read a single entry and
 *     reports only a network failure. Rewritten to this site's own endpoint —
 *     which is where that data lives now, in the KV namespace and the GitHub
 *     mirror — so sync recovers by itself instead of staying broken.
 *
 * Anything else is left exactly as it was found. A custom endpoint is a
 * deliberate choice (self-hosted sync, a local `wrangler dev`), not a stale
 * value, and rewriting one would be the app silently changing where somebody's
 * data goes.
 */
function migrateEndpoint(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (raw === '' || raw === LEGACY_SYNC_ENDPOINT) return DEFAULT_SYNC_ENDPOINT;
  if (/^https?:\/\/[^/]*\.netlify\.app(?:\/|$)/i.test(raw)) return DEFAULT_SYNC_ENDPOINT;
  return raw;
}

/** Is this the site's own endpoint — the current default or the name it had
 *  before the rename? Both are "this site", so both are shown and generated as
 *  such: the setup-link flow omits an endpoint the receiving device already
 *  has, and the sync screen labels it "this site" rather than printing a path. */
export function isDefaultSyncEndpoint(value) {
  return !value || value === DEFAULT_SYNC_ENDPOINT || value === LEGACY_SYNC_ENDPOINT;
}

function normalizeSyncSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const candidateEndpoint = migrateEndpoint(source.endpoint);
  const validEndpoint = isValidEndpoint(candidateEndpoint);
  return {
    ...SYNC_DEFAULTS,
    enabled: source.enabled === true,
    endpoint: validEndpoint && candidateEndpoint ? candidateEndpoint : SYNC_DEFAULTS.endpoint,
    // Trimmed like the endpoint, and for the same reason: a paste can carry a
    // trailing space or newline, a password is compared byte for byte, and the
    // field is type="password" — so a value nothing can be seen wrong with is
    // refused forever, and re-saving it by hand reproduces it. A secret with
    // meaningful leading/trailing whitespace cannot exist on the project side
    // anyway (pages-secrets.py strips it), so trimming can only ever heal.
    password: typeof source.password === 'string' ? source.password.trim() : '',
    lastSyncAt: typeof source.lastSyncAt === 'string' ? source.lastSyncAt : null,
    lastSha: typeof source.lastSha === 'string' && source.lastSha ? source.lastSha : null,
    lastErrorAt: typeof source.lastErrorAt === 'string' ? source.lastErrorAt : null,
    lastError: typeof source.lastError === 'string' && source.lastError ? source.lastError : null,
    repoLabel: typeof source.repoLabel === 'string' ? source.repoLabel.slice(0, 240) : '',
    mirror: normalizeMirror(source.mirror),
  };
}

/**
 * A mirror verdict, kept to what it is: a state name and two short opaque
 * tokens. It is written from a server's answer and rendered in the Data menu, so
 * it is bounded the way every other stored value here is — a value from off the
 * device is not a layout, and an unbounded one would be a way to make the menu
 * unreadable many saves later.
 *
 * The state is deliberately NOT checked against a list of known ones: this side
 * does not own that vocabulary (lib/cloud.mjs does, and a deployment can be
 * newer than the app that talks to it). An unknown state is kept and rendered as
 * "not checked" by sync.js, which is the honest reading of one.
 */
function normalizeMirror(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
  const state = text(raw.state, 40);
  if (!state) return null;
  return {
    state,
    checkedAt: text(raw.checkedAt, 40),
    recordVersion: text(raw.recordVersion, 64),
    mirrorVersion: text(raw.mirrorVersion, 64),
    commit: text(raw.commit, 64),
    wrote: raw.wrote === true ? true : raw.wrote === false ? false : null,
  };
}

export function getSyncSettings() {
  try {
    const raw = localStorage.getItem(KEY());
    const stored = raw ? JSON.parse(raw) : null;
    const settings = normalizeSyncSettings(stored);
    // Repair the one thing normalization changes in place. Reading a padded
    // password out and sending the trimmed one is not enough: the value stays
    // in storage for the next reader (the invite flow), and
    // the modal redraws it from there — so the repair is written back, once,
    // the first time any of them looks.
    if (stored && typeof stored.password === 'string' && stored.password !== settings.password) {
      setSyncSettings(settings);
    }
    return settings;
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
export function getPrivacyPin(): { salt: string | null; hash: string | null; kdf: 'pbkdf2' | null } {
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
    const next: { hash: string; salt: string | null; kdf?: 'pbkdf2' } = { hash: hash.toLowerCase(), salt };
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
