/* ============================================================
   lib/secret.mjs — the deployment's root secret.

   Two things in this app need one server-only, high-entropy value that never
   reaches the browser, and both of them used the GitHub PAT for it: the VAPID
   signing pair is DERIVED from it (lib/webpush.mjs), and the recovery links are
   ENCRYPTED with it (lib/tokens.mjs).

   That was fine while the PAT was a variable somebody pasted in, and it stops
   being fine the moment the deployment has to be re-created without the old
   value: changing a PAT would silently re-key push subscriptions and orphan
   every outstanding recovery link, i.e. two unrelated features would break
   because of a code host's credential rotation. So the root secret gets a name
   of its own, CENTS_SECRET, and the PAT is kept as the fallback — a deployment
   configured the old way keeps working, and one configured the new way no
   longer has a code host in the middle of its push keys.

   A short secret is refused rather than accepted: both of these are key
   material, and one of them is public (the VAPID public key ships to every
   browser), which is exactly the case where a guessable secret is a guessable
   private key. Same 16-character floor webpush.mjs applies to its own.
   ============================================================ */

const NAMES = ['CENTS_SECRET', 'GITHUB_TOKEN'];
const MIN_SECRET_LENGTH = 16;

/** The names, in the order they are tried — read by the guards and the docs. */
export const ROOT_SECRET_NAMES = NAMES;

/** The name that is actually configured, or null. Never returns the value. */
export function rootSecretSource(env = process.env) {
  for (const name of NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) return name;
  }
  return null;
}

/** The root secret, or `{ ok: false, error }` naming what to set. */
export function rootSecret(env = process.env) {
  for (const name of NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
      return { ok: true, secret: value, source: name };
    }
  }
  return {
    ok: false,
    error: `no root secret: set ${NAMES[0]} (any ${MIN_SECRET_LENGTH}+ character `
      + `server-only string), or make ${NAMES[1]} available to this function`,
  };
}
