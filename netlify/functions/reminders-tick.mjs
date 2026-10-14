/* ============================================================
   reminders-tick.mjs — run the daily-reminder sender NOW, over HTTP.

   WHY THIS EXISTS. The reminder sender is the on-time path for a closed app, and
   it is the one piece of this feature that runs on somebody else's clock. The
   per-minute cron that used to drive it was scrapped on 13 Oct 2026, and the
   reason is worth keeping: on this account it was the unreliable half, not the
   code — the trigger was accepted and re-deployed, the bundle carried the
   `scheduled` handler, and 30 minutes later no invocation had ever reached the
   Worker, while Cloudflare's own local trigger endpoint ran the same handler and
   logged its run. Before that, on Netlify, every scheduled function on the site
   went silent the same way: correct countdowns in the dashboard, no error and no
   log line, the remedy a support ticket. Either way nothing is wrong with any
   subscription — the devices are all stored, the app still says "Push is on",
   and the phone simply never rings. With the cron gone this endpoint IS the
   server's clock, so the same run is reachable here:

       GET|POST https://<site>/api/reminders-tick
       X-Cents-Password: <this profile's app password>
       X-Cents-Profile:  <optional; defaults to the personal profile>

   Point any scheduler at that URL when the platform's own cannot be trusted —
   a free cron service, a home server, a GitHub Actions schedule — and the
   reminder keeps arriving at the hour. `?password=` / `?profile=` exist for a
   service that can only reach a URL and cannot set a header; the header is the
   one to prefer, because a query string lands in request logs.

   It is the same idempotent job a scheduler runs: a record already delivered today
   is not delivered again, so a trigger that fires twice changes nothing, and a
   trigger that fires late only catches what is still inside the sender's own
   look-back window. That is also why any profile's password is enough to fire
   it: the run reaches every profile's due devices, exactly as any other trigger does,
   and it can never be used to send anything a user did not schedule.

   Answers { ok, scheduler: { ranAt, ok, error, considered, sent, … } } — the
   run's own heartbeat, which is also what the app reads to decide whether the
   closed-app push is really being sent.
   ============================================================ */

import { getStore } from './lib/store.mjs';
import { runReminderTick } from './lib/reminder-run.mjs';
import { safeEqual, createFailureThrottle } from './lib/auth.mjs';
import { resolveProfileForAuth, profileAuthMessage } from './lib/profiles.mjs';

// Failed passwords are throttled like every other write surface. Successful
// runs are idempotent, so they need no ceiling of their own — two triggers
// racing each other cannot deliver the same day twice.
const failureThrottle = createFailureThrottle({ windowMs: 5 * 60 * 1000, max: 15 });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const cors = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password, X-Cents-Profile',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (origin) { cors['Access-Control-Allow-Origin'] = origin; cors['Vary'] = 'Origin'; }
  return cors;
}

const ok = (body, status = 200, cors = {}) => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...cors } },
);
const err = (msg, status = 400, cors = {}) => ok({ error: msg, code: status }, status, cors);

/**
 * The credential the run is fired with: the header pair every other write uses,
 * or — for a cron service that cannot set headers — `?password=` / `?profile=`.
 * A query profile is turned into the one header lookup resolveProfileForAuth
 * makes, so a named profile's password is checked against ITS OWN env var and
 * never against the default one.
 */
function requestProfile(request, url) {
  const headerProfile = request.headers.get('x-cents-profile');
  const queryProfile = url.searchParams.get('profile');
  if (headerProfile || !queryProfile) return resolveProfileForAuth(request);
  return resolveProfileForAuth({
    headers: { get: (name) => (String(name).toLowerCase() === 'x-cents-profile' ? queryProfile : null) },
  });
}

export default async (request, _context) => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return ok({}, 200, cors);
  if (request.method !== 'GET' && request.method !== 'POST') return err('Method not allowed', 405, cors);

  const url = new URL(request.url);
  const supplied = request.headers.get('x-cents-password') || url.searchParams.get('password') || '';
  const throttle = failureThrottle.check(request);
  if (!throttle.ok) {
    return new Response(JSON.stringify({ error: 'Too many failed attempts - retry later', code: 429 }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(throttle.retryAfterSeconds), ...cors } });
  }

  const profile = requestProfile(request, url);
  if (!profile.ok) return err(profileAuthMessage(profile), 500, cors);
  if (!safeEqual(supplied, profile.expected)) {
    throttle.record();
    await new Promise(r => setTimeout(r, 500));
    return err('Bad app password', 401, cors);
  }

  const store = await getStore();
  const summary = await runReminderTick({ store });
  const scheduler = {
    ranAt: summary.ranAt,
    ok: summary.ok === true,
    error: summary.error || null,
    considered: summary.considered,
    sent: summary.sent,
    pruned: summary.pruned,
    warming: summary.warming,
    rejected: summary.rejected,
  };
  console.log(`cents reminders-tick: via=${profile.id} considered=${summary.considered} sent=${summary.sent} pruned=${summary.pruned} warming=${summary.warming} rejected=${summary.rejected}`);
  return ok({ ok: true, scheduler }, 200, cors);
};
