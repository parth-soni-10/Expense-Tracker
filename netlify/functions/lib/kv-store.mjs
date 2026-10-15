/* ============================================================
   lib/kv-store.mjs — the durable store, on Cloudflare.

   lib/store.mjs runs on Netlify Blobs because that runtime provides
   `getStore(name)`. It documents ONE injection point for a host that has
   something else — `useBlobsModule(mod)`, "anything with getStore(name) →
   store" — and that is what this file provides: a KV namespace in the shape
   store.mjs already calls.

   That indirection is the whole reason this port is small: no caller of
   openStore() changed, and store.mjs's `durable: true` answer — which is what
   decides whether a cloud document is committed to the primary or to the
   GitHub mirror (lib/cloud.mjs) — stays a true statement. A memory map would
   have answered `false` and quietly turned someone's only cloud copy into a
   GitHub commit.

   Storage namespaces are prefixed, not shared. store.mjs's stores are named
   (`cents-cloud`, `cents-security`), and each name
   gets its own prefix here for the same reason it got its own Blobs store:
   security tokens and somebody's expense document have nothing to do with each
   other and must not share a keyspace.

   One property to know about, because it is not Blobs': KV is eventually
   consistent across Cloudflare's locations (a write is immediately visible
   where it was made; other locations converge within about a minute). The
   cloud document has carried a version token of its own bytes since before
   this port — that is what makes a late-arriving copy a detectable conflict
   instead of a lost edit — but a second device reading seconds after a save
   can still be answered with the previous version at a distant location. The
   app's own pull-merge-retry path is the same one it used when a GitHub
   commit's sha moved, so the behaviour is unchanged in kind, and a single
   user syncing their own phone is reading the same location they wrote.
   ============================================================ */

/** Longest key KV accepts is 512 bytes; names and ids here are short. */
const DEFAULT_ROOT = 'cents';

/**
 * A Blobs-shaped module over one KV namespace.
 *
 * `getStore(name)` returns the seven methods lib/store.mjs's wrapper calls
 * (get / set / delete / list), and list() hands back `{ blobs: [{ key }] }`
 * with the store prefix already stripped — the shape the wrapper's own
 * `blobs.list({ prefix }).then(r => r.blobs || [])` expects.
 *
 * Returns null when handed something that is not a KV namespace, so a missing
 * binding degrades to store.mjs's in-memory fallback (and answers
 * `durable: false`) instead of throwing on the first write.
 */
export function kvBlobsModule(kv, root = DEFAULT_ROOT) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return null;
  const prefixFor = name => `${root}:${name}:`;

  return {
    getStore(name) {
      const prefix = prefixFor(name);
      return {
        async get(key) {
          const value = await kv.get(prefix + key);
          return value === undefined ? null : value;
        },
        // Values are stored as text: store.mjs stringifies its JSON itself and
        // parses on the way back, so KV must not do either.
        async set(key, value) {
          await kv.put(prefix + key, String(value));
        },
        async delete(key) {
          await kv.delete(prefix + key);
        },
        // KV pages its key list (1000 per page), and a profile list that
        // silently stopped at the first page would read as "no other accounts".
        async list({ prefix: sub = '' } = {}) {
          const blobs = [];
          let cursor;
          do {
            const page = await kv.list({ prefix: prefix + sub, cursor });
            for (const entry of page.keys) blobs.push({ key: entry.name.slice(prefix.length) });
            cursor = page.list_complete ? null : page.cursor;
          } while (cursor);
          return { blobs };
        },
      };
    },
  };
}
