/* ============================================================
   lib/cloud.mjs — where a profile's cloud document actually lives.

   The deployment's durable store holds it (Netlify Blobs there, a KV namespace
   on Cloudflare — see lib/store.mjs and lib/kv-store.mjs); GitHub holds a mirror
   of it, when a mirror is configured at all. It is optional and stays optional:
   nothing below fails a save or a read because there is no token, only because
   the store that COMMITS the save did not take it.

   Why the move: the GitHub Contents API was the only store, so every
   read and every save was a round trip to a code host that rate-limits,
   records a commit per save, and refuses the save the moment the sha
   has moved — with the document itself never queryable, just one JSON
   blob in a repo. Blobs is the runtime this deployment already runs on
   (the reminder push store uses it), so a save stops being a commit.
   GitHub stays as the mirror: a second, human-readable copy in history,
   and the recovery path if a site's Blobs data is ever lost.

   THE VERSION TOKEN is the SHA-256 of the document's bytes, which the
   client round-trips as `sha`. A write is accepted only if the document
   still hashes to the token the client last saw — exactly the guarantee
   a conflict check needs ("the cloud still holds what I saw"), stable
   across both stores, and immune to the order two devices finish in. An
   identical re-push is therefore not a conflict, and no client change is
   needed: the token is opaque to it, just like the git sha it replaces.

   TWO MODES, decided by whether a durable store exists:

     durable (a real deployment)  The durable store is the commit point. The mirror is
                            written on every save and its failure is
                            logged, never returned: a code host having a
                            bad day must not fail someone's save. Losing
                            the PRIMARY is different — that is reported,
                            because claiming success over a stale primary
                            would leave every other device reading the
                            previous document.
     not durable (local)    No durable primary exists, so the mirror IS
                            the commit point and its failure is a real
                            failure. Outside Netlify's runtime the
                            behaviour is exactly what it was before this
                            module existed, which is also what keeps a
                            non-Netlify host and every local test honest.

   Reads consult GitHub only for a profile that has no document in the primary
   store yet, and that read seeds the primary — which is what migrates an
   existing deployment rather than emptying it. After that the mirror is
   written, not read. With no mirror configured (no token) that lookup is
   skipped outright: an absent mirror has no document to offer, and asking a
   code host with no credential is an error, not a read.

   THE ORDER OF THE TWO WRITES: the primary commits first, and the mirror is
   written after it. That is both a latency rule and a correctness one.

     latency    a save is allowed to wait on the store that decides whether the
                save worked, and on nothing else. The mirror is best-effort by
                contract, so a slow (or dead) code host must not sit between a
                keystroke and the answer. A caller that can hand work off to
                the platform — a Worker's ctx.waitUntil, passed in as `defer`
                — gets that promise returned while the mirror is still in
                flight; a caller that cannot (local runs, the tests, any host
                with no such hook) waits for it as before.

     correctness the backup must never lead the primary. Written first, a mirror
                would keep content the primary then REFUSED — the save answers
                an error, the store still holds the previous document, and the
                "backup" is the only place the rejected version exists.

   The cost of the order is that the primary's record cannot carry the mirror's
   new sha before it is written, so the record is patched afterwards, when the
   mirror returns one (and only while it still holds the version we wrote). A
   hand-off that never lands therefore leaves a stale mirror sha behind, which
   costs the NEXT save one conflict-and-retry against the code host — the
   mirror's own 409 path, already exercised — and never a failed save.

   Recovery: to fall back to the GitHub copy for one profile, delete its key in
   the primary store (cents-cloud / doc/<profile>.json — under the KV prefix
   cents:cents-cloud: on Cloudflare); the next read seeds from the mirror again.

   THE GAP CHECK, and why it is measured rather than assumed. Everything above
   is arranged so a code host can fail without anybody noticing: the mirror is
   written after the primary, and its failure is logged rather than returned. The
   cost of that is exactly the thing worth knowing — the two homes can drift
   apart in silence, with the KV record holding a version the repo does not have,
   and the first person to find out is whoever restores from the mirror. So every
   save now ENDS by comparing the two for real: the record's version token
   against the repository blob's own bytes, read back over the Contents API, and
   the verdict is written into the record beside the document (and handed back to
   whoever asked for the save).

   The read-back is one extra Contents API GET per save, and it is deliberate.
   The mirror write's answer says what the WRITER believed it sent; the question
   here is what the repository holds NOW, which a second device, a force-push or
   a hand edit all change without changing the answer the writer got. It runs
   after the save has been answered — handed to the caller's waitUntil where
   there is one — so a keystroke never waits on it.

   A verdict always describes ONE version: `recordVersion` is the record's token
   at the moment of the comparison, so a verdict that arrives after the next save
   is recognisable as stale rather than as news. A save's own record deliberately
   carries no verdict until its check returns, so nothing can read a previous
   save's "in sync" as a statement about this one.
   ============================================================ */

import { createHash } from 'node:crypto';
import { openStore } from './store.mjs';
import { ghFetch, decodeBase64, encodeBase64, contentsPath, mirrorConfigured } from './gh.mjs';
import { cloudFileFor } from './profiles.mjs';

// Exported for the reminder run (lib/reminder-run.mjs, reached over HTTP), which
// reads a profile's document from the same store to count due bills — a second
// copy of either the store name or the key format is a doc the two halves stop
// agreeing about (an empty store looks exactly like "nothing due").
export const CLOUD_STORE = 'cents-cloud';
export const keyFor = profileId => `doc/${profileId}.json`;

/** Infrastructure failure a caller should report rather than swallow. */
export class CloudError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
  }
}

/** The version token a client round-trips: a hash of the document's bytes. */
export function versionOf(json) {
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

/* ---------- the mirror gap ----------
 *
 * The vocabulary of a comparison between the record's version and the repo
 * blob. Every consumer renders one of these and nothing else — the Data menu
 * (sync.js's mirrorStatus), the save response and the stored verdict — so the
 * set is closed on purpose:
 *
 *   in_sync       the blob hashes to the record's version; the two agree
 *   pending       the blob differs and NO save's check has landed for this
 *                 version yet — a save is still being mirrored, or its check
 *                 died with the process that owed it. Not a gap: nothing has
 *                 been claimed about this version, so nothing is being denied
 *                 either. (A save answers BEFORE its mirror write, so this
 *                 window is a real, repeatable state rather than a race to
 *                 paper over: an on-demand check taken a second after a save
 *                 lands in it.)
 *   behind        the blob is readable and differs, and the save this check
 *                 belongs to did not reach it (its mirror write failed)
 *   diverged      the blob is readable and differs, and this save's write DID
 *                 report success — so something else owns the mirror's head
 *   missing       the repo has no file at that path (deleted, REPO_FILE
 *                 renamed, or a token that can no longer see it)
 *   unverifiable  the blob could not be read, so nothing can be said of it
 *   no_document   the primary holds no document, so there is nothing to compare
 *   unconfigured  no mirror is configured, which is a supported shape, not a gap
 */
export const MIRROR_STATES = ['in_sync', 'pending', 'behind', 'diverged', 'missing', 'unverifiable', 'no_document', 'unconfigured'];

/**
 * Classify one comparison. Pure — no store, no GitHub, no request — so the whole
 * vocabulary can be exercised without any of them.
 *
 * `blobExists` is null when the read itself failed, which is a different answer
 * from "the file is not there" and must not be reported as one.
 * `wrote` is null when nothing is known about the write this comparison belongs
 * to (an on-demand check with no verdict to inherit).
 */
export function classifyMirror({ recordExists, blobExists, recordVersion, mirrorVersion, wrote }) {
  if (!recordExists) return 'no_document';
  if (blobExists === null) return 'unverifiable';
  if (!blobExists) return 'missing';
  if (mirrorVersion === recordVersion) return 'in_sync';
  // Nothing claimed about this version, so a difference is unexplained rather
  // than a gap somebody can act on — the save that owes the check may still be
  // in flight (see the states above).
  if (wrote === null) return 'pending';
  // A differing blob is explained by the write: one that failed leaves the
  // mirror behind, one that succeeded leaves somebody else's version there.
  return wrote ? 'diverged' : 'behind';
}

/**
 * Compare a record's version against the repo blob by reading the blob.
 *
 * `recordVersion` is what the record holds (null when there is no record at
 * all). `wrote` says whether the save this check belongs to reached the mirror:
 * true, false, or null when nothing is known about a write (an on-demand check
 * that found no verdict to inherit).
 *
 * Returns the verdict — { state, checkedAt, recordVersion, mirrorVersion,
 * commit, wrote } — and never throws: a comparison that cannot complete is the
 * `unverifiable` state, which the caller reports as "not checked" rather than as
 * a mirror that is fine.
 */
export async function checkMirror(profileId, config, recordVersion, { wrote = null } = {}) {
  const checkedAt = new Date().toISOString();
  const base = { checkedAt, recordVersion: recordVersion || null, mirrorVersion: null, commit: null, wrote };
  // No token, no coordinates, nothing to compare with — and asking a code host
  // with no credential is an error, not a read (lib/gh.mjs).
  if (!mirrorConfigured()) return { ...base, state: 'unconfigured' };
  // Nothing recorded to compare against. Worth saying, and not worth a read of
  // the code host to say it: there is no version on this side to compare with.
  if (recordVersion == null) return { ...base, state: classifyMirror({ recordExists: false }) };
  let gh = null;
  try {
    gh = await readGithubDoc(profileId, config);
  } catch (e) {
    console.error('cents cloud: the mirror could not be read for the gap check', e?.message || e);
  }
  return {
    ...base,
    state: classifyMirror({
      recordExists: true,
      blobExists: gh ? !!gh.exists : null,
      recordVersion,
      mirrorVersion: gh?.version || null,
      wrote,
    }),
    mirrorVersion: (gh && gh.exists && gh.version) || null,
    commit: (gh && gh.exists && gh.commitSha) || null,
  };
}

/**
 * The gap as it stands right now, for a caller who asked (sync.mjs's
 * `?mirror=1`, which the Data menu uses). Reads the record and the blob and
 * nothing else — no document — so asking on demand costs two small reads rather
 * than a re-download of the ledger.
 *
 * The written-ness of the last save is inherited from the recorded verdict when
 * that verdict describes the same version, so the on-demand answer cannot
 * disagree with the one the save recorded (a differing blob would otherwise read
 * as `behind` here and `diverged` there). Where there is no such verdict this
 * passes `wrote: null`, which classifies a difference as `pending` — the save
 * that owes the answer has not given it yet, and reporting that as `behind`
 * would be an alarm about a write that may be a second away from landing.
 */
export async function mirrorGap(profileId, config) {
  const { store, durable } = await openStore(CLOUD_STORE);
  const rec = durable ? await readRecord(store, keyFor(profileId)) : null;
  if (!rec) return checkMirror(profileId, config, null);
  const recorded = rec.mirror && rec.mirror.recordVersion === rec.version ? rec.mirror : null;
  return checkMirror(profileId, config, rec.version, { wrote: recorded ? recorded.wrote : null });
}

/**
 * Read a profile's cloud document: { exists, content, version, updatedAt,
 * commitSha }. Throws CloudError when the only store that could hold it is
 * unreachable. A document that could not be parsed comes back as a present
 * entry with content null — the caller reports that as malformed.
 */
export async function readCloudDoc(profileId, config) {
  const { store, durable } = await openStore(CLOUD_STORE);
  if (durable) {
    const rec = await readRecord(store, keyFor(profileId));
    if (rec) {
      return { exists: true, content: rec.content, version: rec.version,
        updatedAt: rec.updatedAt, commitSha: rec.ghCommit || null,
        // The last save's gap verdict, if it has one yet. Recorded, not
        // measured: a plain read must not cost a GitHub round trip (that is
        // what ?mirror=1 is for), and the verdict names the version it judged.
        mirror: rec.mirror || null };
    }
  }
  const gh = await readGithubDoc(profileId, config);
  // Seed the primary on the way past — this is the one moment an existing
  // deployment's document is known to be somewhere else. Only a durable one:
  // a memory map is not a place to keep the only copy of anything.
  if (gh.exists && durable) {
    try {
      await store.setJSON(keyFor(profileId), { v: 1, version: gh.version, updatedAt: gh.updatedAt, content: gh.content });
    } catch (e) {
      console.error('cents cloud: seeding the primary failed', e?.message || e);
    }
  }
  return gh;
}

/**
 * Commit a document. `expectedVersion` is the token the client last saw, and
 * null means "I believe no document exists yet" — the same contract GitHub's
 * sha had, so a client that predates this module still recovers through its
 * normal pull-merge-retry path.
 *
 * `defer` is optional and is how a caller says "I can hand background work to
 * the platform": it is called with a promise to keep alive (a Worker passes
 * ctx.waitUntil). Only the mirror uses it, and only when the primary is the
 * commit point — a deployment whose commit point IS the mirror has to wait for
 * it, so there the hook is ignored.
 *
 * Returns { ok, version, updatedAt, commitSha, mirrored, mirror }
 *      | { conflict: true }
 *      | { error: <message> } when the store this deployment commits to did
 *        not take it.
 * `mirrored: null` means the mirror write was handed off and its outcome is not
 * known yet; `commitSha` is null in that case, because the code host has not
 * answered. Nothing that reads this response needs either field — the client
 * round-trips `version` and nothing else.
 *
 * `mirror` is the gap verdict for the version just saved: an object, or null
 * when the mirror write AND its check were handed to the platform and their
 * outcome is not known yet — which is the normal case on a real deployment. A
 * null here is "not measured yet", never "in sync"; the verdict is written into
 * the record when it lands, so the next read (or an on-demand ?mirror=1 check)
 * is where a caller learns it.
 */
export async function writeCloudDoc(profileId, config, { content, expectedVersion = null, message = '', branch = '', defer = null } = {}) {
  const { store, durable } = await openStore(CLOUD_STORE);
  const key = keyFor(profileId);
  const json = JSON.stringify(content, null, 2);

  const rec = durable ? await readRecord(store, key) : null;
  let current = rec ? rec.version : null;
  let ghSha = rec?.ghSha || null;
  if (!rec) {
    // Nothing recorded, so the honest answer about what is out there has to come
    // from the mirror — it may be the only copy of an older document.
    const gh = await readGithubDoc(profileId, config);
    current = gh.exists ? gh.version : null;
    ghSha = gh.ghSha;
  }
  if (expectedVersion !== current) return { conflict: true };

  const version = versionOf(json);
  const updatedAt = new Date().toISOString();

  // ---- 1. the primary, and the only thing a save waits on -------------------
  // The record carries the mirror sha it already knows (the one this save is
  // about to write WITH) rather than the sha the mirror will answer with; the
  // patch below replaces it once the code host has spoken.
  // The previous verdict is deliberately NOT carried into the new record: it
  // judged a different version, and an "in sync" left over from the last save
  // would read as a statement about this one. It arrives with the check below.
  if (durable) {
    try {
      await store.setJSON(key, { v: 1, version, updatedAt, content,
        ghSha: ghSha || null, ghCommit: rec?.ghCommit || null });
    } catch (e) {
      console.error('cents cloud: primary write failed', e?.message || e);
      // The store this deployment commits to has to have taken it (TWO MODES
      // above): claiming success over a stale primary would leave every other
      // device reading the previous document. Returning here also means the
      // mirror is never touched, so it cannot end up ahead of the primary.
      return { error: 'Saving to the cloud failed' };
    }
  }

  // ---- 2. the mirror, after the document is already safe --------------------
  const mirrorTask = async () => {
    const wrote = await mirrorToGithub(profileId, config, json, { sha: ghSha, message, branch });
    // The gap check, right after the write rather than instead of it: the write
    // says what we sent, this says what the repo holds now (see THE GAP CHECK
    // at the top of this file). It runs whether or not the write landed, because
    // a failed write is the case where the difference matters most.
    const verdict = await checkMirror(profileId, config, version, { wrote: !!wrote });
    // Remember the sha the mirror answered with, so the next save updates it
    // instead of colliding with its own last write — and the verdict, so the
    // next reader learns whether this save actually reached the code host.
    // Re-read first: a second device may have committed while this one was
    // talking to it, and the patch must not resurrect the version it is
    // patching over. A record that has moved on keeps neither.
    if (durable) {
      try {
        const live = await readRecord(store, key);
        if (live && live.version === version) {
          const patch = { mirror: verdict };
          // A write that failed leaves the sha we already had: it still names
          // the mirror's head, and clearing it would cost the next save a
          // sha-less PUT and the 422-then-retry that follows.
          if (wrote) { patch.ghSha = wrote.sha || null; patch.ghCommit = wrote.commit || null; }
          await store.setJSON(key, { ...live, ...patch });
        }
      } catch (e) {
        console.error('cents cloud: recording the mirror sha failed', e?.message || e);
      }
    }
    return { wrote, verdict };
  };

  if (durable && typeof defer === 'function') {
    defer(mirrorTask().catch(() => null));
    return { ok: true, version, updatedAt, commitSha: null, mirrored: null, mirror: null };
  }

  const { wrote, verdict } = await mirrorTask();
  // With no durable primary the mirror IS the commit point, so its failure is
  // the save's failure rather than a spare copy having a bad day.
  if (!durable && !wrote) return { error: 'Saving to the cloud failed' };

  return { ok: true, version, updatedAt, commitSha: wrote?.commit || null, mirrored: !!wrote, mirror: verdict };
}

/** A stored record, or null when absent, unreadable or from an older shape. */
async function readRecord(store, key) {
  try {
    const rec = await store.getJSON(key);
    return rec && typeof rec === 'object' && rec.content != null && typeof rec.version === 'string'
      ? rec
      : null;
  } catch (e) {
    // Treat an unreadable primary as absent: the caller then answers from the
    // mirror, which is still a truthful copy, rather than failing the request.
    console.error('cents cloud: primary read failed, using the mirror', e?.message || e);
    return null;
  }
}

/** Read the GitHub copy. `ghSha` is not part of the document — the writer
 *  needs it to update the mirror instead of colliding with it. */
async function readGithubDoc(profileId, config) {
  // No mirror, nothing to read from it. Returning an absent document here (not
  // an error) is what lets a deployment without a token answer honestly: the
  // profile simply has no cloud copy yet.
  if (!mirrorConfigured()) return { exists: false };
  const file = cloudFileFor(profileId, config.file);
  const r = await ghFetch(contentsPath({ ...config, file }));
  if (r.status === 404) return { exists: false };
  if (!r.ok) {
    console.error('cents cloud: github read failed', r.status, (await r.text()).slice(0, 400));
    throw new CloudError('Reading the cloud copy failed', r.status);
  }
  const j = await r.json();
  const text = decodeBase64(j.content || '');
  // A file with nothing in it is not a document. A file we cannot parse is: the
  // caller sees content null and reports it as malformed rather than as absent.
  if (!text.trim()) return { exists: false };
  let content = null;
  try { content = JSON.parse(text); } catch { /* stays null: read as malformed */ }
  return {
    exists: true,
    content,
    version: versionOf(text),
    updatedAt: j.updated_at || j.commit?.author?.date || content?.lastLocalChangeAt || null,
    commitSha: j.commit?.sha || null,
    ghSha: j.sha || null,
  };
}

/**
 * Write the GitHub mirror. Best-effort by contract: it returns null instead of
 * throwing, so the caller decides whether a mirror failure is fatal (it is,
 * but only when the mirror is the sole durable home).
 * A 409/422 means the mirror moved — re-read its sha and retry once, because a
 * mirror conflict must never become a failed save for the user.
 */
async function mirrorToGithub(profileId, config, json, { sha, message, branch }) {
  if (!mirrorConfigured()) return null;
  const file = cloudFileFor(profileId, config.file);
  const path = `/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(file)}`;
  const put = s => ghFetch(path, {
    method: 'PUT',
    body: JSON.stringify({
      message: message || `cents: mirror ${profileId}`,
      content: encodeBase64(json),
      branch: branch || config.branch,
      ...(s ? { sha: s } : {}),
    }),
  });
  try {
    let r = await put(sha);
    if (r.status === 409 || r.status === 422) {
      const read = await ghFetch(contentsPath({ ...config, file, branch: branch || config.branch }));
      r = await put(read.ok ? (await read.json()).sha : null);
    }
    if (!r.ok) {
      console.error('cents cloud: mirror write failed', r.status, (await r.text()).slice(0, 300));
      return null;
    }
    const j = await r.json();
    return { sha: j.content?.sha || null, commit: j.commit?.sha || null };
  } catch (e) {
    console.error('cents cloud: mirror write threw', e?.message || e);
    return null;
  }
}
