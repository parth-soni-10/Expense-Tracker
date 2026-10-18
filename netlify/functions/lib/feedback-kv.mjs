/* ============================================================
   lib/feedback-kv.mjs — the raw KV namespace, for feedback only.

   Every other store in this project goes through lib/store.mjs, which wraps a
   Blobs-shaped module (getStore/get/set/delete/list). That wrapper cannot
   express `expirationTtl`, and feedback is the one thing here whose keys are
   supposed to disappear on their own: a 90-day TTL is part of the contract,
   not an optimisation, so those writes need the namespace itself.

   So this file is deliberately tiny and deliberately separate: it hands the
   Handler the raw binding through an injection point, exactly as
   lib/store.mjs does for the Blobs seam, and nothing else in the app imports
   it. Keeping it out of store.mjs means the durable document path cannot
   accidentally start writing keys that expire.

   functions/_router.js calls useFeedbackKv(env.CENTS_KV) in wireBindings(),
   before any handler runs. A missing binding leaves the slot empty, and the
   handler answers 503 rather than throwing — the same shape the other hosts'
   feedback routes use.
   ============================================================ */

let kv = null;

/** Inject the deployment's KV namespace (or null to clear it). */
export function useFeedbackKv(namespace) {
  kv = namespace && typeof namespace.put === 'function' ? namespace : null;
}

/** The namespace, or null where nothing is bound (local dev, a bad deploy). */
export function getFeedbackKv() {
  return kv;
}
