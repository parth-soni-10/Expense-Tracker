/* ============================================================
   Sync settings — stored separately from app state.
   Lives under its own localStorage key so wiping expenses
   doesn't wipe sync config (and vice versa).
   ============================================================ */

const KEY = 'cents:syncSettings';
const PRIVACY_KEY = 'cents:privacySettings';

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

function normalizeSyncSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const candidateEndpoint = typeof source.endpoint === 'string' ? source.endpoint.trim() : '';
  const validEndpoint = candidateEndpoint === ''
    || (/^\/(?!\/)/.test(candidateEndpoint))
    || /^https:\/\//i.test(candidateEndpoint)
    || /^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(candidateEndpoint);
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
    const raw = localStorage.getItem(KEY);
    return normalizeSyncSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...SYNC_DEFAULTS };
  }
}

function setSyncSettings(next) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); }
  catch (e) { console.warn('Failed to save sync settings:', e); }
}

export function patchSyncSettings(patch) {
  const next = { ...getSyncSettings(), ...patch };
  setSyncSettings(next);
  return next;
}

export function clearSyncSettings() {
  try { localStorage.removeItem(KEY); } catch (e) { console.warn('Failed to clear sync settings:', e); }
}

// Device-only privacy credentials. These are deliberately separate from the
// synced expense state so a PIN hash cannot be exported or pushed to GitHub.
export function getPrivacyPin() {
  try {
    const raw = localStorage.getItem(PRIVACY_KEY);
    if (!raw) return { salt: null, hash: null };
    const parsed = JSON.parse(raw);
    return {
      salt: typeof parsed.salt === 'string' ? parsed.salt : null,
      hash: typeof parsed.hash === 'string' && /^[a-f0-9]{64}$/i.test(parsed.hash) ? parsed.hash.toLowerCase() : null,
    };
  } catch {
    return { salt: null, hash: null };
  }
}

export function setPrivacyPin(hash, salt = null) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)
    || (salt !== null && typeof salt !== 'string')) return false;
  try {
    localStorage.setItem(PRIVACY_KEY, JSON.stringify({ hash: hash.toLowerCase(), salt }));
    // Do not report success until the credential can be read back. This keeps
    // legacy state.pinHash as a safe fallback when storage is unavailable or
    // silently refuses writes (private browsing/quota failures).
    const saved = getPrivacyPin();
    return saved.hash === hash.toLowerCase() && saved.salt === salt;
  } catch (e) {
    console.warn('Failed to save privacy settings:', e);
    return false;
  }
}

export function clearPrivacyPin() {
  try {
    localStorage.removeItem(PRIVACY_KEY);
    return !getPrivacyPin().hash;
  } catch (e) {
    console.warn('Failed to clear privacy settings:', e);
    return false;
  }
}
