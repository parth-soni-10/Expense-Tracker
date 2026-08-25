/* ============================================================
   lib/auth.mjs — shared auth helpers for the Netlify functions.

   safeEqual: constant-time string comparison (compares SHA-256
   digests, so length differences do not leak either).

   createFailureThrottle: best-effort in-memory sliding-window
   throttle on failed auth attempts per client IP. Netlify
   Functions are stateless, so this resets on cold start — it
   stops sustained bursts from a single IP, not a distributed
   attack, and should be paired with platform-level rate limits.
   ============================================================ */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * In-memory sliding-window failure throttle keyed by client IP.
 * Returns { ok: true, record } for allowed attempts (call record()
 * only after a FAILED auth), or { ok: false, retryAfterSeconds }.
 *
 * Only the platform-set client IP is trusted: Netlify sets
 * x-nf-client-connection-ip and overwrites any client-supplied value.
 * x-forwarded-for is deliberately NOT used — it is client-spoofable, so
 * throttling on it would let an attacker both rotate past the limit and
 * impersonate a victim's IP to lock them out. When no trusted IP is
 * available (non-Netlify hosts), the throttle fails open rather than
 * bucketing every caller together.
 */
export function createFailureThrottle({ windowMs = 5 * 60 * 1000, max = 15 } = {}) {
  const log = new Map();
  return {
    check(request) {
      const ip = request.headers.get('x-nf-client-connection-ip');
      if (!ip) return { ok: true, record: () => {} };
      const now = Date.now();
      const arr = (log.get(ip) || []).filter(t => now - t < windowMs);
      if (arr.length >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
        return { ok: false, retryAfterSeconds };
      }
      const record = () => { arr.push(Date.now()); log.set(ip, arr); };
      return { ok: true, ip, record };
    },
  };
}
