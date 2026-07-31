/* ============================================================
   Sync settings — stored separately from app state.
   Lives under its own localStorage key so wiping expenses
   doesn't wipe sync config (and vice versa).
   ============================================================ */

const KEY = 'cents:syncSettings';

export const SYNC_DEFAULTS = Object.freeze({
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

export function getSyncSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...SYNC_DEFAULTS };
    return { ...SYNC_DEFAULTS, ...JSON.parse(raw) };
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
  localStorage.removeItem(KEY);
}
