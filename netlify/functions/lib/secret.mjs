/* ============================================================
   lib/secret.mjs — the deployment's root secret.

   One thing in this app needs a server-only, high-entropy value that never
   reaches the browser: the recovery links are ENCRYPTED with it
   (lib/tokens.mjs). It used to be the GitHub PAT, which was fine while the PAT
   was a variable somebody pasted in, and stops being fine the moment the
   deployment has to be re-created without the old value: changing a PAT would
   orphan every outstanding recovery link, i.e. a feature would break because of
   a code host's credential rotation. So the root secret gets a name of its own,
   CENTS_SECRET, and the PAT is kept as the fallback — a deployment configured
   the old way keeps working.

   (Until the daily reminder was removed, its Web Push signing pair was derived
   from this same value, which is why the variable is named for the deployment
   rather than for recovery links.)

   A short secret is refused rather than accepted: this is key material, and a
   guessable secret is a guessable key.
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
