/* ============================================================
   lib/store.mjs — tiny durable key/value adapter for the
   Netlify Functions.

   On Netlify, state persists in Netlify Blobs (site-wide store,
   zero config — getStore() resolves the site automatically inside
   a function). Everywhere else (local `netlify dev`, unit tests,
   a non-Netlify host) it falls back to an in-memory map so the
   functions never hard-fail because the Blobs package is missing.

   The adapter is intentionally narrow — getJSON / setJSON / an
   atomic consume-once — so the two callers (single-use setup
   tokens) stay readable and testable.
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
    async setJSON(key, value) {
      memMap.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
    },
    // Atomic claim: succeeds only if the key does not exist yet.
    async claimIfNew(key, value) {
      if (memMap.has(key)) return { modified: false };
      memMap.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
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
  return (await blobStore()) || memoryStore();
}
