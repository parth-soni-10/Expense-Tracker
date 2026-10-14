#!/usr/bin/env node
/**
 * test-failure-throttle.mjs — the failure throttle has to be able to see the caller.
 *
 * Why this guard exists: `createFailureThrottle` keys its buckets on the client
 * address the platform sets, and the version of it this guard was written for
 * read `x-nf-client-connection-ip` — Netlify's header. This app no longer runs on
 * Netlify. On Cloudflare Pages that header is absent unless the *caller* sends
 * it, so `check()` took its no-IP path, which fails open by design, and the
 * 15-attempt damper became a control that existed only in the comments. Nothing
 * failed loudly: the endpoint still answered `401`, the app still said "wrong
 * password", and 18 wrong passwords in a row were all counted as fresh attempts.
 * A guard is the only thing that would have said so, which is what this is.
 *
 * What it pins:
 *   1. Cloudflare's `cf-connecting-ip` is read — it is what a Pages deployment
 *      sends, and the deployment is Pages.
 *   2. Netlify's `x-nf-client-connection-ip` still works, so the function is not
 *      welded to one host's header name.
 *   3. When both are present, Cloudflare's wins. On Pages, `cf-connecting-ip` is
 *      platform-set and a caller cannot forge it, while
 *      `x-nf-client-connection-ip` arrives exactly as it was sent — so preferring
 *      Netlify's name would let a caller pick its own bucket and rotate past the
 *      limit.
 *   4. `x-forwarded-for` is still never trusted. It is client-spoofable, and
 *      bucketing on it would let an attacker both rotate past the limit and
 *      impersonate a victim's address to lock them out.
 *   5. The counted attempts are the failures: the 16th check inside the window is
 *      refused with a Retry-After in seconds, and the block lifts when the
 *      window slides off.
 *   6. Buckets are per address, so one caller exhausting the limit cannot lock
 *      everyone else out.
 *
 * Run: node scripts/test-failure-throttle.mjs
 */
import { createFailureThrottle } from '../netlify/functions/lib/auth.mjs';

const MAX = 15;
const WINDOW_MS = 5 * 60 * 1000;
const problems = [];

const call = (headers, target = {}) => {
  const throttle = target.throttle || createFailureThrottle();
  return { throttle, verdict: throttle.check(new Request('https://cents.test/api/sync', { headers })) };
};

/** Fail `MAX` times from one address, then say what the next attempt was told. */
function exhaust(throttle, headers) {
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const verdict = throttle.check(new Request('https://cents.test/api/sync', { headers }));
    if (!verdict.ok) return { refusedAt: attempt, next: verdict };
    verdict.record();
  }
  return { refusedAt: null, next: throttle.check(new Request('https://cents.test/api/sync', { headers })) };
}

// 1 + 5. Cloudflare's address is seen, and the window closes on the next attempt.
{
  const throttle = createFailureThrottle();
  const { verdict } = call({ 'cf-connecting-ip': '203.0.113.7' }, { throttle });
  if (!verdict.ok) problems.push('a request carrying cf-connecting-ip was refused outright — the throttle cannot see a Pages caller at all');
  else if (verdict.ip !== '203.0.113.7') problems.push(`cf-connecting-ip was not used as the bucket key (got ${JSON.stringify(verdict.ip)})`);

  const { refusedAt, next } = exhaust(throttle, { 'cf-connecting-ip': '203.0.113.7' });
  if (refusedAt) problems.push(`attempt ${refusedAt} of ${MAX} was refused before the limit was reached — the window counts more than failures`);
  if (next.ok !== false) problems.push(`after ${MAX} failed attempts the next one was allowed: the damper does not exist on this host`);
  else {
    if (!(Number.isInteger(next.retryAfterSeconds) && next.retryAfterSeconds >= 1 && next.retryAfterSeconds <= WINDOW_MS / 1000)) {
      problems.push(`the refusal carried Retry-After ${JSON.stringify(next.retryAfterSeconds)}; it must be whole seconds inside the window`);
    }
  }
}

// 2. Netlify's spelling still buckets.
{
  const throttle = createFailureThrottle();
  const { verdict } = call({ 'x-nf-client-connection-ip': '198.51.100.5' }, { throttle });
  if (!verdict.ok || verdict.ip !== '198.51.100.5') {
    problems.push(`x-nf-client-connection-ip is no longer read (got ${JSON.stringify(verdict.ip)}) — the function would stop being host-portable`);
  }
  const { next } = exhaust(throttle, { 'x-nf-client-connection-ip': '198.51.100.5' });
  if (next.ok !== false) problems.push('a Netlify-shaped caller never reaches the limit either');
}

// 3. Both present: the platform-forged-proof header decides the bucket.
{
  const throttle = createFailureThrottle();
  const { verdict } = call({ 'cf-connecting-ip': '203.0.113.9', 'x-nf-client-connection-ip': 'attacker-chosen' }, { throttle });
  if (verdict.ip !== '203.0.113.9') {
    problems.push(`with both headers present the bucket key was ${JSON.stringify(verdict.ip)} — a caller that sends x-nf-client-connection-ip picks its own bucket`);
  }
}

// 4. x-forwarded-for is not a key, however it is spelled.
{
  for (const headers of [{ 'x-forwarded-for': '203.0.113.11' }, { 'x-forwarded-for': '203.0.113.11, 203.0.113.12' }, { 'Forwarded': 'for=203.0.113.11' }]) {
    const { verdict } = call(headers);
    if (!verdict.ok) problems.push(`a request carrying only ${Object.keys(headers)[0]} was refused: an untrusted header must not be able to lock a caller out`);
    else if (verdict.ip) problems.push(`${Object.keys(headers)[0]} was trusted as the bucket key — it is client-spoofable`);
  }
}

// 6. One blocked address does not block another.
{
  const throttle = createFailureThrottle();
  exhaust(throttle, { 'cf-connecting-ip': '203.0.113.20' });
  const { verdict } = call({ 'cf-connecting-ip': '203.0.113.21' }, { throttle });
  if (!verdict.ok) problems.push('a second caller was refused because a different address had used up the window — every caller shares one bucket');
}

// 5b. The window really is a window: it lifts when the oldest failure expires.
{
  const throttle = createFailureThrottle({ windowMs: 60, max: 1 });
  const first = throttle.check(new Request('https://cents.test/api/sync', { headers: { 'cf-connecting-ip': '203.0.113.30' } }));
  first.record();
  const blocked = throttle.check(new Request('https://cents.test/api/sync', { headers: { 'cf-connecting-ip': '203.0.113.30' } }));
  if (blocked.ok !== false) problems.push(`max=1 did not block the second attempt (got ${JSON.stringify(blocked)})`);
  await new Promise(resolve => setTimeout(resolve, 90));
  const lifted = throttle.check(new Request('https://cents.test/api/sync', { headers: { 'cf-connecting-ip': '203.0.113.30' } }));
  if (lifted.ok !== true) problems.push('the block outlived its window: a caller locked out forever is a denial-of-service on the owner');
}

if (problems.length) {
  console.error(`test-failure-throttle: ${problems.length} problem(s):`);
  for (const problem of problems) console.error('  ' + problem);
  process.exit(1);
}
console.log('test-failure-throttle: OK — the throttle reads the platform address (cf-connecting-ip first), never a spoofable one,');
console.log(`  refuses attempt ${MAX + 1} within the window, and buckets each caller separately.`);
