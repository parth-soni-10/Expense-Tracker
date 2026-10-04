/* ============================================================
   reminders-send.mjs — SCHEDULED function (Netlify Scheduled
   Functions, cron in netlify.toml) that delivers the daily
   "upload your transactions" Web Push to every subscribed device
   at its profile's chosen local time.

   Runs every 15 minutes. For each stored push subscription:
     - compute the subscription's current local HH:MM from the
       stored IANA zone (fallback: UTC),
     - if that matches the record's time (within this run's slot)
       and it has not fired today already, push the reminder,
     - prune dead subscriptions (push service 404/410) — but only
       once the record is past pushSendWarming's warm-up, because a
       registration seconds old is not registered YET, not dead.

   "Not fired today" is tracked per subscription with the last
   fired LOCAL date; the scheduled run straddling midnight of the
   record's own zone cannot double-send. A missed slot (no run
   within the scheduled minute, e.g. platform hiccup) is simply
   skipped — the reminder never fires hours late.

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

import { getStore, openStore } from './lib/store.mjs';
import { pushSendWarming, vapidConfig } from './lib/webpush.mjs';
import { CLOUD_STORE, keyFor } from './lib/cloud.mjs';

const PUSH_PREFIX = 'push:';
// The cron fires every 15 minutes; a record matches when its HH:MM falls
// within the current slot (e.g. 20:07 fires on the 20:00 run).
const SLOT_MINUTES = 15;

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

// True when the record's local HH:MM arrived since the previous run, i.e.
// it falls in the local-time window [prev run, now]. Comparing local wall
// times to local wall times avoids the UTC-slot mismatch for zones whose
// offset is not a whole number of hours. The midnight case (prev 23:50,
// now 00:05) is a wrap: due when target >= prev OR target <= now. The
// inclusive upper bound makes consecutive runs overlap by one minute;
// the per-record lastFiredDate marker absorbs that overlap.
function isDue(recordTime, now, zone) {
  const t = String(recordTime || '').split(':');
  if (t.length !== 2) return false;
  const target = Number(t[0]) * 60 + Number(t[1]);
  if (!Number.isInteger(target) || target < 0 || target > 24 * 60 - 1) return false;
  const nowLocal = localTimeInZone(now, zone);
  const prevLocal = localTimeInZone(new Date(now.getTime() - SLOT_MINUTES * 60 * 1000), zone);
  if (!nowLocal || !prevLocal) return false;
  const nowM = nowLocal.h * 60 + nowLocal.m;
  const prevM = prevLocal.h * 60 + prevLocal.m;
  return prevM <= nowM
    ? target >= prevM && target <= nowM
    : target >= prevM || target <= nowM;
}

export default async (_request, _context) => {
  const vapid = vapidConfig();
  if (!vapid.ok) {
    console.error(`cents reminders-send: ${vapid.error}`);
    return { statusCode: 200, body: 'vapid-not-configured' };
  }

  const now = new Date();
  const store = await getStore();
  let keys = [];
  try { keys = (await store.list(PUSH_PREFIX)).map(item => item.key); }
  catch (e) {
    console.error('cents reminders-send: store list failed', e?.message || e);
    return { statusCode: 200, body: 'store-error' };
  }

  let sent = 0, pruned = 0, warming = 0, considered = 0, rejected = 0;
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
    const record = await store.getJSON(key).catch(() => null);
    if (!record || !record.subscription) continue;
    considered += 1;
    const zone = record.zone || 'UTC';
    if (!isDue(record.time, now, zone)) continue;
    const localDate = localDateInZone(now, zone);
    if (record.lastFiredDate && record.lastFiredDate === localDate) continue;

    const body = (record.profileName
      ? `Quick tally for ${record.profileName} — it takes a minute.`
      : 'Log today\'s spending while it\'s fresh.')
      + (await billsHint(record.profileId, localDate));
    const result = await pushSendWarming(record.subscription, {
      title: 'cents. — time to upload your transactions',
      body,
      tag: 'cents-daily-reminder',
    }, { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    { createdAt: record.createdAt });

    if (result.ok) {
      sent += 1;
      await store.setJSON(key, { ...record, lastFiredDate: localDate });
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

  // One-line run summary in Netlify's function logs (useful when debugging
  // "why didn't my phone get the reminder"). `rejected` is counted separately
  // because a push service refusing every message — a VAPID key that no longer
  // matches the subscription, most often — is not something the next 15-minute
  // run fixes, and it used to be invisible here: the summary said sent=0 and
  // nothing else. `warming` is the transient version of the same question — a
  // device whose registration the push service did not know yet, which the
  // next slot will very likely deliver to.
  console.log(`cents reminders-send: considered=${considered} sent=${sent} pruned=${pruned} warming=${warming} rejected=${rejected}`);
  return { statusCode: 200, body: `sent=${sent}` };
};
