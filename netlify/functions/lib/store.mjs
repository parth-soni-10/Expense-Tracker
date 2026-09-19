/* ============================================================
   lib/store.mjs — tiny durable key/value adapter for the
   Netlify Functions.

   On Netlify, state persists in Netlify Blobs (site-wide store,
   zero config — getStore() resolves the site automatically inside
   a function). Everywhere else (local `netlify dev`, unit tests,
   a non-Netlify host) it falls back to an in-memory map so the
   functions never hard-fail because the Blobs package is missing.

   The adapter is intentionally narrow — getJSON / setJSON / an
   atomic consume-once / delete / prefix list — so its callers
   (single-use setup tokens, the reminder push store) stay
   readable and testable.
   ============================================================ */

let blobsModule = null;
let blobsLoadAttempted = false;

async function loadBlobs() {
  if (blobsLoadAttempted) return blobsModule;
  blobsLoadAttempted = true;
  try {
    const mod = await import('@netlify/blobs');
    if (mod && typeof mod.getStore === 'function') blobsModule = mod;
  } catch {
    blobsModule = null; // not running inside Netlify's runtime
  }
  return blobsModule;
}

// Module-level singleton so in-process state persists across requests
// (the Blobs path is naturally persistent; this mirrors that for local
// runs and tests, where repeated getStore() calls must see the same map).
const memMap = new Map();
function memoryStore() {
  return {
    async get(key) {
      const v = memMap.get(key);
      return v === undefined ? null : v;
    },
    async set(key, value) {
      memMap.set(key, String(value));
      return { modified: true };
    },
    async setJSON(key, value) {
      memMap.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
    },
    async getJSON(key) {
      const v = memMap.get(key);
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    },
    // Atomic claim: succeeds only if the key does not exist yet.
    async claimIfNew(key, value) {
      if (memMap.has(key)) return { modified: false };
      memMap.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
    },
    async del(key) {
      memMap.delete(key);
      return { deleted: true };
    },
    async list(prefix = '') {
      return [...memMap.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key }));
    },
  };
}

async function blobStore() {
  const mod = await loadBlobs();
  if (!mod) return null;
  try {
    const store = mod.getStore('cents-security');
    return store && typeof store.get === 'function' ? store : null;
  } catch {
    return null; // Blobs misconfigured — fall back to in-memory
  }
}

export async function getStore() {
  const blobs = await blobStore();
  if (!blobs) return memoryStore();
  return {
    get: (key) => blobs.get(key),
    set: (key, value) => blobs.set(key, value),
    setJSON: async (key, value) => { await blobs.set(key, JSON.stringify(value)); return { modified: true }; },
    getJSON: async (key) => {
      const raw = await blobs.get(key);
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    claimIfNew: async (key, value) => {
      // Blobs has no server-side compare-and-swap; emulate with an explicit
      // get-then-set. Fine for the token store's practical race window, and
      // documented as best-effort in the token module.
      const existing = await blobs.get(key);
      if (existing != null) return { modified: false };
      await blobs.set(key, JSON.stringify(value));
      return { modified: true };
    },
    del: (key) => blobs.delete(key),
    list: (prefix = '') => blobs.list({ prefix }).then(r => r.blobs || []),
  };
}
