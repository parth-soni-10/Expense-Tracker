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

   Recovery: to fall back to the GitHub copy for one profile, delete its key in
   the primary store (cents-cloud / doc/<profile>.json — under the KV prefix
   cents:cents-cloud: on Cloudflare); the next read seeds from the mirror again.
   ============================================================ */

import { createHash } from 'node:crypto';
import { openStore } from './store.mjs';
import { ghFetch, decodeBase64, encodeBase64, contentsPath, mirrorConfigured } from './gh.mjs';
import { cloudFileFor } from './profiles.mjs';

// Exported for reminders-send, which reads a profile's document from the same
// store to count due bills — a second copy of either the store name or the key
// format is a doc the two halves stop agreeing about (an empty store looks
// exactly like "nothing due").
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
        updatedAt: rec.updatedAt, commitSha: rec.ghCommit || null };
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
 * Returns { ok, version, updatedAt, commitSha, mirrored }
 *      | { conflict: true }
 *      | { error: <message> } when the store this deployment commits to did
 *        not take it.
 */
export async function writeCloudDoc(profileId, config, { content, expectedVersion = null, message = '', branch = '' } = {}) {
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

  // The mirror is written first so the primary's single record can carry the
  // mirror's new sha, and because it is the one store that is always attempted
  // — a spare durable copy costs one request and is never what decides whether
  // the save works.
  const mirror = await mirrorToGithub(profileId, config, json, { sha: ghSha, message, branch });

  let primaryOk = true;
  if (durable) {
    try {
      await store.setJSON(key, { v: 1, version, updatedAt, content,
        ghSha: mirror?.sha || ghSha || null, ghCommit: mirror?.commit || rec?.ghCommit || null });
    } catch (e) {
      primaryOk = false;
      console.error('cents cloud: primary write failed', e?.message || e);
    }
  }

  // The store this deployment commits to has to have taken it (TWO MODES
  // above): claiming success over a stale primary would leave every other
  // device reading the previous document.
  if (durable ? !primaryOk : !mirror) return { error: 'Saving to the cloud failed' };

  return { ok: true, version, updatedAt, commitSha: mirror?.commit || null, mirrored: !!mirror };
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
