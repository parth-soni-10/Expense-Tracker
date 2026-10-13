/* ============================================================
   reminders-send.mjs — SCHEDULED function (the Worker's per-minute
   cron in wrangler.toml) that delivers the daily
   "upload your transactions" Web Push to every subscribed device
   at its profile's chosen local time.

   The job itself lives in lib/reminder-run.mjs, because it is also
   reachable over HTTP (reminders-tick.mjs): The platform's scheduler is the one
   piece of this feature that runs on somebody else's clock, and it has
   stopped invoking functions for hours with no error anywhere — the run is
   not allowed to be reachable only from there.

   This file is the platform's entry point and nothing else: guard the clock
   contract, run the tick, write the one-line summary to the function log, and
   answer. Every run also records a heartbeat the app reads (see
   lib/reminder-run.mjs) so a device can tell "the scheduler runs" from
   "nothing was ever sent".

   Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional).
   The pair comes from vapidConfig() in lib/webpush.mjs — the same
   call the subscribe endpoint makes — so the key a browser binds
   its subscription to and the key this sender signs with cannot
   drift apart (they must be identical or every push is discarded
   in silence). When no usable pair is configured, one is derived
   from a server-only secret the deploy already has.
   No app password needed: the scheduler is platform-invoked, and
   the stored records already bind each subscription to its profile
   and carry its schedule.
   ============================================================ */

import { getStore } from './lib/store.mjs';
import { billsDueHint, runReminderTick } from './lib/reminder-run.mjs';

// The harness has always read the hint's rule from here; it now lives in the
// shared lib so the HTTP trigger appends the same sentence.
export { billsDueHint };

export default async (_request, _context) => {
  const store = await getStore();
  const summary = await runReminderTick({ store });
  if (!summary.ok && summary.error) {
    console.error(`cents reminders-send: ${summary.error}`);
  }
  // One-line run summary in Netlify's function logs (useful when debugging
  // "why didn't my phone get the reminder"). `rejected` is counted separately
  // because a push service refusing every message — a VAPID key that no longer
  // matches the subscription, most often — is not something any later run fixes,
  // and it used to be invisible here: the summary said sent=0 and nothing else.
  // `warming` is the transient version of the same question — a device whose
  // registration the push service did not know yet, which the next slot will
  // very likely deliver to.
  console.log(`cents reminders-send: considered=${summary.considered} sent=${summary.sent} pruned=${summary.pruned} warming=${summary.warming} rejected=${summary.rejected}`);
  return { statusCode: 200, body: `sent=${summary.sent}` };
};
