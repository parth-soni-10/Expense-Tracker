/* ============================================================
   lib/reminder-run.mjs — ONE run of the daily-reminder sender.

   The HTTP trigger (reminders-tick.mjs) is the ONLY entry point to this job, so
   the job is written once, here: walk
   every stored push subscription, work out whether the record's own local clock
   has reached the time its user chose (inside the look-back window below), send
   the reminder, and prune a subscription the push service calls gone.

   It also records a HEARTBEAT of the run (recordSchedulerHeartbeat). That is the
   piece the app's own "Push is on" sentence was missing: a device could ask the
   server whether its record still existed, and nothing could ask whether the
   SCHEDULER ever runs — so a platform that quietly stopped invoking it looked
   exactly like a healthy subscription, and the phone stayed silent. The device
   reads the heartbeat through the push probe (reminders-push.mjs), and its
   background wake then stops deferring to a push that is not being sent
   (see reminders.js and sw.js's dailyReminderWake).

   Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional), resolved
   through vapidConfig() so the key the browser subscribed with and the key this
   sender signs with cannot drift apart.
   ============================================================ */

import { openStore } from './store.mjs';
import { pushSendWarming, vapidConfig } from './webpush.mjs';
import { CLOUD_STORE, keyFor } from './cloud.mjs';

export const PUSH_PREFIX = 'push:';

// The heartbeat's key. Deliberately NOT under `push:` — that prefix is the
// subscription list this run walks, and a record without a `subscription`
// field sitting inside it is a shape the loop would have to keep skipping.
export const SCHEDULER_KEY = 'meta:reminder-send';

// HOW BIG THE LOOK-BACK IS, with no clock of its own deciding the cadence. A run fires
// whenever something calls it — the app on open and on refocus
// (triggerServerTick), or whatever scheduler the user points at
// reminders-tick.mjs — so the window is what keeps the CALLER from deciding the
// outcome: a target fires on the first run at or after its HH:MM, so a
// reminder lands at its hour rather than at the next caller's convenience, and
// a run that arrives late (or a day nobody called at all, then one late in the
// evening) still catches a target up to WINDOW_MINUTES old instead of losing
// the whole day. Overlap between consecutive windows is absorbed by
// lastFiredDate, and nothing here can ever fire more than WINDOW_MINUTES after
// its hour.
export const WINDOW_MINUTES = 10;

/**
 * "2 bills due" — appended to the reminder for a profile whose synced
 * document has recurring items whose next date has arrived (or passed) as of
 * `localDate`, the record's OWN local date: the same clock the due check and
 * the once-a-day marker use, so a bill never counts as "due" a day early in a
 * zone ahead of the device. Empty string unless there is something to say —
 * no document, no recurring list, nothing due — and never throws: a hint must
 * not cost the delivery it rides on. "Due" deliberately includes overdue
 * (nextDate <= today): a bill that is late needs paying MORE, not less.
 */
export function billsDueHint(doc, localDate) {
  try {
    const recurring = doc && doc.settings && Array.isArray(doc.settings.recurring)
      ? doc.settings.recurring : null;
    if (!recurring || typeof localDate !== 'string' || !localDate) return '';
    const due = recurring.filter(r => r && typeof r.nextDate === 'string' && r.nextDate <= localDate);
    if (due.length === 0) return '';
    return ` ${due.length} bill${due.length === 1 ? '' : 's'} due.`;
  } catch {
    return '';
  }
}

/** Local "HH:MM" for a Date in an IANA zone, via Intl (no deps). */
function localTimeInZone(date, zone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const h = parts.find(p => p.type === 'hour')?.value;
    const m = parts.find(p => p.type === 'minute')?.value;
    if (h == null || m == null) return null;
    return { h: Number(h), m: Number(m), label: `${h}:${m}` };
  } catch {
    return null; // unknown zone id — treated as never-due rather than wrong
  }
}

/** Local YYYY-MM-DD in a zone, for the once-a-day dedupe marker. */
function localDateInZone(date, zone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date); // en-CA gives YYYY-MM-DD
  } catch {
    return null;
  }
}

// True when the record's local HH:MM arrived within the look-back window,
// i.e. it falls in the local-time window [now - WINDOW_MINUTES, now].
// Comparing local wall times to local wall times avoids the UTC-slot mismatch
// for zones whose offset is not a whole number of hours. The midnight case
// (prev 23:50, now 00:05) is a wrap: due when target >= prev OR target <= now.
// The inclusive upper bound makes consecutive windows overlap by one minute;
// the per-record lastFiredDate marker absorbs that overlap.
export function isDue(recordTime, now, zone) {
  const t = String(recordTime || '').split(':');
  if (t.length !== 2) return false;
  const target = Number(t[0]) * 60 + Number(t[1]);
  if (!Number.isInteger(target) || target < 0 || target > 24 * 60 - 1) return false;
  const nowLocal = localTimeInZone(now, zone);
  const prevLocal = localTimeInZone(new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000), zone);
  if (!nowLocal || !prevLocal) return false;
  const nowM = nowLocal.h * 60 + nowLocal.m;
  const prevM = prevLocal.h * 60 + prevLocal.m;
  return prevM <= nowM
    ? target >= prevM && target <= nowM
    : target >= prevM || target <= nowM;
}

/**
 * Run the job once. Returns the summary the caller logs AND the heartbeat the
 * app reads:
 *
 *   { considered, sent, pruned, warming, rejected, ok, error, ranAt }
 *
 * `ok: false` is a run that could not sign anything at all (no VAPID pair) and
 * is recorded rather than raised: a misconfigured site and a site whose
 * scheduler never fires look identical from a phone — both are "nothing was
 * ever sent" — and they are fixed by completely different people. Saying which
 * one it is costs one field.
 */
export async function runReminderTick({ store, now = new Date(), vapid = vapidConfig() } = {}) {
  const ranAt = now.toISOString();
  const record = (summary) => writeSchedulerHeartbeat(store, summary);
  if (!vapid.ok) {
    const summary = { ok: false, error: vapid.error, considered: 0, sent: 0, pruned: 0, warming: 0, rejected: 0, ranAt };
    await record(summary);
    return summary;
  }

  let keys = [];
  try { keys = (await store.list(PUSH_PREFIX)).map(item => item.key); }
  catch (e) {
    const summary = { ok: false, error: 'store-error', considered: 0, sent: 0, pruned: 0, warming: 0, rejected: 0, ranAt };
    await record(summary);
    console.error('cents reminders: store list failed', e?.message || e);
    return summary;
  }

  let sent = 0; let pruned = 0; let warming = 0; let considered = 0; let rejected = 0;
  // The hint source, read lazily and per profile: the profile's synced
  // document in the cloud store (the same one sync writes), cached per run so
  // two devices of one profile read it once. A profile with no synced
  // document — no cloud sync configured — simply gets the plain reminder.
  const hintCache = new Map();
  const billsHint = async (profileId, localDate) => {
    if (!profileId) return '';
    const cacheKey = `${profileId}|${localDate}`;
    if (!hintCache.has(cacheKey)) {
      let hint = '';
      try {
        const { store: cloud } = await openStore(CLOUD_STORE);
        const rec = await cloud.getJSON(keyFor(profileId));
        hint = billsDueHint(rec && typeof rec.content === 'object' ? rec.content : null, localDate);
      } catch { hint = ''; }
      hintCache.set(cacheKey, hint);
    }
    return hintCache.get(cacheKey);
  };
  for (const key of keys) {
    const rec = await store.getJSON(key).catch(() => null);
    if (!rec || !rec.subscription) continue;
    considered += 1;
    const zone = rec.zone || 'UTC';
    if (!isDue(rec.time, now, zone)) continue;
    const localDate = localDateInZone(now, zone);
    if (rec.lastFiredDate && rec.lastFiredDate === localDate) continue;

    const body = (rec.profileName
      ? `Quick tally for ${rec.profileName} — it takes a minute.`
      : 'Log today\'s spending while it\'s fresh.')
      + (await billsHint(rec.profileId, localDate));
    const result = await pushSendWarming(rec.subscription, {
      title: 'cents. — time to upload your transactions',
      body,
      tag: 'cents-daily-reminder',
    }, { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    { createdAt: rec.createdAt });

    if (result.ok) {
      sent += 1;
      await store.setJSON(key, { ...rec, lastFiredDate: localDate, lastFiredAt: ranAt });
    } else if (result.gone) {
      pruned += 1;
      await store.del(key).catch(() => {});
    } else if (result.warming) {
      // A registration the push service has not been told about yet (a device
      // subscribed seconds ago). The record is kept — deleting it is the one
      // outcome that loses the user's setup — and it is counted, so a run that
      // delivered nothing still says what it met. Deliberately no lastFiredDate:
      // the reminder was not delivered.
      warming += 1;
    } else if (result.status) {
      // The service answered and said no — told apart from a network failure
      // (no status) because this one does not heal on the next run.
      rejected += 1;
    }
    // Transient push-service failures: do not mark fired; the next slot's
    // run may succeed. (Slightly wider delivery window beats silent loss.)
  }

  const summary = { ok: true, error: null, considered, sent, pruned, warming, rejected, ranAt };
  await record(summary);
  return summary;
}

/**
 * Write the run's heartbeat where the push probe can hand it to a device.
 *
 * Never throws and never blocks the delivery it describes: a heartbeat that
 * cannot be written costs a stale "the scheduler has not run" line, not a
 * reminder. The value is small and overwritten every run — it is a liveness
 * signal, not a log (the run summary still goes to the function's own log).
 */
export async function writeSchedulerHeartbeat(store, summary) {
  try {
    await store.setJSON(SCHEDULER_KEY, {
      ranAt: summary.ranAt || new Date().toISOString(),
      ok: summary.ok !== false,
      error: summary.error || null,
      considered: summary.considered || 0,
      sent: summary.sent || 0,
      pruned: summary.pruned || 0,
      warming: summary.warming || 0,
      rejected: summary.rejected || 0,
    });
  } catch { /* a liveness signal is not worth a failed run */ }
}

/** The last recorded run, or null when the scheduler has never run here. */
export async function readSchedulerHeartbeat(store) {
  try {
    const meta = await store.getJSON(SCHEDULER_KEY);
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  } catch {
    return null;
  }
}
