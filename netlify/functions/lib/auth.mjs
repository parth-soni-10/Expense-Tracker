/* ============================================================
   lib/auth.mjs — shared auth helpers for the Netlify functions.

   safeEqual: constant-time string comparison (compares SHA-256
   digests, so length differences do not leak either).

   createFailureThrottle: best-effort in-memory sliding-window
   throttle on failed auth attempts per client IP. The host's
   functions are stateless, so this resets on cold start — it
   stops sustained bursts from a single IP, not a distributed
   attack, and should be paired with platform-level rate limits.

   Which header carries that IP is per host, and getting it wrong
   is silent: see the note on the reader below.
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
 * Only the platform-set client IP is trusted, and each host sets its own:
 * Cloudflare Pages sets `cf-connecting-ip`, Netlify sets
 * `x-nf-client-connection-ip`. Both are read, in that order, because a
 * header name that is not the host's is not an empty string — it is
 * whatever the caller sent. Pages forwards `x-nf-client-connection-ip`
 * untouched, so preferring it would let a caller pick its own bucket and
 * rotate past the limit at will; Cloudflare overwrites `cf-connecting-ip`
 * on the way in, so it is the one name a Pages caller cannot choose.
 *
 * x-forwarded-for is deliberately NOT used — it is client-spoofable, so
 * throttling on it would let an attacker both rotate past the limit and
 * impersonate a victim's IP to lock them out. When neither platform header
 * is present (a local run, or a host that sets neither), the throttle fails
 * open rather than bucketing every caller together.
 *
 * `scripts/test-failure-throttle.mjs` pins all of that, including the
 * precedence: this read is one line, and the version of it that named only
 * Netlify's header left the damper inert on the host this app actually runs
 * on, without anything failing.
 */
export function createFailureThrottle({ windowMs = 5 * 60 * 1000, max = 15 } = {}) {
  const log = new Map();
  return {
    check(request) {
      const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-nf-client-connection-ip');
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
