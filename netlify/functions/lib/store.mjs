/* ============================================================
   lib/store.mjs — tiny durable key/value adapter for the functions
   under netlify/functions/ (the directory is named for the host this
   code came from; the functions themselves are bundled into worker.js
   and served from the same paths).

   Where the host has a durable store it is used: Netlify Blobs resolves
   the site by itself inside a function, and any other host hands one in
   (see lib/kv-store.mjs, which puts a KV namespace into the same shape).
   Where there is neither — local `netlify dev`, unit tests — it falls back
   to an in-memory map so the functions never hard-fail for want of a store.

   The adapter is intentionally narrow — getJSON / setJSON / an
   atomic consume-once / delete / prefix list — so its callers
   (single-use setup tokens, the reminder push store, the cloud
   document store) stay readable and testable.

   Stores are named, and each name gets its own backend and its own
   in-memory map: security tokens and someone's expense document have
   nothing to do with each other and should not share a keyspace.

   openStore() also says whether the store it returned is durable. A
   caller whose data has a second home needs that answer: the cloud
   document store commits to Blobs when it is durable, and to the
   GitHub mirror when it is not, because an in-memory map is not
   somewhere to keep the only copy of someone's expenses.
   ============================================================ */

const DEFAULT_STORE = 'cents-security';

let blobsModule = null;
let blobsLoadAttempted = false;
const blobStores = new Map();

/**
 * Install a store module (anything with getStore(name) → store).
 *
 * Two callers, and neither of them is a test: Netlify's runtime provides
 * `@netlify/blobs` by itself, and the Worker calls this with lib/kv-store.mjs's
 * KV-backed module, because a KV namespace is what this deployment's durable
 * store is. Pass null to reset, and note the reset drops cached stores but
 * keeps in-memory data.
 */
export function useBlobsModule(mod) {
  blobsModule = mod && typeof mod.getStore === 'function' ? mod : null;
  blobsLoadAttempted = true;
  blobStores.clear();
}

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

async function blobStore(name) {
  if (blobStores.has(name)) return blobStores.get(name);
  const mod = await loadBlobs();
  let store = null;
  if (mod) {
    try {
      const s = mod.getStore(name);
      if (s && typeof s.get === 'function') store = s;
    } catch {
      store = null; // Blobs misconfigured — fall back to in-memory
    }
  }
  blobStores.set(name, store);
  return store;
}

// Module-level singleton maps — one per store name — so in-process state
// persists across requests, mirroring how the Blobs path is naturally
// persistent for local runs and tests that call openStore() repeatedly.
const memMaps = new Map();
function memoryStore(name) {
  if (!memMaps.has(name)) memMaps.set(name, new Map());
  const memMap = memMaps.get(name);
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

/** A Blobs store, in the shape the callers expect. */
function wrapBlobs(blobs) {
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

/** The named store, plus whether it survives a cold start. */
export async function openStore(name = DEFAULT_STORE) {
  const blobs = await blobStore(name);
  return blobs
    ? { durable: true, store: wrapBlobs(blobs) }
    : { durable: false, store: memoryStore(name) };
}

/** The store itself, for callers that do not care whether it is durable. */
export async function getStore(name = DEFAULT_STORE) {
  return (await openStore(name)).store;
}
