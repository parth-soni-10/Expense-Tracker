/* ============================================================
   Function — visitor feedback (served from /api/feedback by
   functions/_router.js, plus its pre-rename /.netlify/functions/feedback
   spelling for a device that stored that one).

   POST { message, website? }  →  201 { ok: true }
                                202 { ok: true }  (honeypot tripped: nothing kept)
                                400 { error }      bad or oversized message
                                413 { error }      body over 4 KB
                                405 { error }      not a POST
                                503 { error }      no KV bound on this deployment

   The write is `fb:cents:<uuid>` in the deployment's EXISTING namespace
   (CENTS_KV), with a 90-day TTL. No new binding, no D1, and no key that
   outlives the TTL — feedback is a note to the owner, not part of anybody's
   ledger, and it must not accumulate in the store that holds their expense
   documents.

   Why the namespace directly instead of lib/store.mjs: that wrapper is
   Blobs-shaped and cannot carry `expirationTtl` (see lib/feedback-kv.mjs).
   The cost of using it here would be feedback that never expires.

   Auth: none, deliberately — a visitor has no password, and this is the one
   public write in the app. It is bounded instead: a 4 KB body cap, a 2000
   character message cap, a honeypot field (`website`), a JSON-only contract,
   and no read path (nothing in the app or the router can list what was
   written). It never touches profiles, the cloud document, or the mirror.

   Same contract as the Portal's route (`fb:<site>:<uuid>`, honeypot `website`,
   `{ message, source, createdAt }`), so one feedback component can post to
   either site without knowing which it is talking to.
   ============================================================ */

import { getFeedbackKv } from './lib/feedback-kv.mjs';

/** 90 days, in the seconds KV expects. Part of the contract, not a default. */
export const FEEDBACK_TTL = 60 * 60 * 24 * 90;
const MAX_BODY_BYTES = 4096;
const MAX_MESSAGE = 2000;
const FEEDBACK_PREFIX = 'fb:cents:';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body, status) => new Response(JSON.stringify(body), { status, headers });

export default async (request, _context) => {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  const kv = getFeedbackKv();
  if (!kv) return reply({ error: 'Feedback is not configured' }, 503);

  // Content-Length is a hint, so the text is measured too: a lying header must
  // not get an unbounded body past the cap.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return reply({ error: 'Payload too large' }, 413);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply({ error: 'Payload too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return reply({ error: 'Invalid feedback' }, 400);
  }

  // Honeypot: a field a human never sees and a bot fills. Answer as if it
  // worked, so the bot has no signal, and write nothing.
  if (body && typeof body.website === 'string' && body.website) return reply({ ok: true }, 202);

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE) return reply({ error: 'Invalid feedback' }, 400);

  try {
    await kv.put(
      FEEDBACK_PREFIX + crypto.randomUUID(),
      JSON.stringify({ message, source: 'cents', createdAt: new Date().toISOString() }),
      { expirationTtl: FEEDBACK_TTL },
    );
  } catch (error) {
    // The write failing is the deployment's problem, not the visitor's input;
    // say so without describing the store.
    console.error('feedback write failed:', (error && error.message) || error);
    return reply({ error: 'Could not save feedback' }, 503);
  }

  return reply({ ok: true }, 201);
};
