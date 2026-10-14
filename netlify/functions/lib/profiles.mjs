/* ============================================================
   lib/profiles.mjs — shared per-profile credential resolution.

   A profile id is a client-generated slug; the strict shape doubles
   as path/env safety, so an id can never escape into a path or
   name an arbitrary env var.

   'personal' is the default profile and keeps the original
   APP_PASSWORD + REPO_FILE pair, so an existing single-user site
   needs no change. Any other id REQUIRES its own APP_PASSWORD_<ID>:
   there is deliberately no fallback to APP_PASSWORD. The fallback a
   previous version had meant a second profile silently shared the
   owner's password — anyone holding it could read that profile's
   file, and a profile the operator thought was isolated was not.
   Without the env var the request is refused with the exact name to
   set, which is also what the app's sync screen tells the user.
   ============================================================ */

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const DEFAULT_PROFILE = 'personal';

/** Normalize a client-sent profile header into a safe id. */
export function profileIdFromHeader(value) {
  const raw = (value || '').trim();
  return PROFILE_ID_RE.test(raw) ? raw : DEFAULT_PROFILE;
}

/** Strict profile-id check, for values that must not silently default. */
export function isProfileId(value) {
  return typeof value === 'string' && PROFILE_ID_RE.test(value);
}

/** Env var holding a profile's app password. */
export function passwordEnvName(id) {
  return id === DEFAULT_PROFILE ? 'APP_PASSWORD' : `APP_PASSWORD_${id.toUpperCase().replace(/-/g, '_')}`;
}

/** Cloud file for a profile, derived from the configured base file. */
export function cloudFileFor(id, baseFile) {
  if (id === DEFAULT_PROFILE) return baseFile;
  return baseFile.replace(/(\.[^.]+)?$/, m => `-${id}${m || ''}`);
}

/**
 * Resolve the request's profile to its credential.
 * Returns { ok, id, expected, envName, problem } where problem is one of
 * null | 'missing' | 'too-short' — the caller turns that into a message,
 * so every function explains the same failure the same way.
 */
export function resolveProfileForAuth(request) {
  const id = profileIdFromHeader(request.headers.get('x-cents-profile'));
  const envName = passwordEnvName(id);
  const expected = process.env[envName];
  if (!expected) return { ok: false, id, expected: null, envName, problem: 'missing' };
  if (expected.length < 8) return { ok: false, id, expected, envName, problem: 'too-short' };
  return { ok: true, id, expected, envName, problem: null };
}

/** Operator-facing message for a failed profile resolution. */
export function profileAuthMessage(profile) {
  if (profile.problem === 'missing') {
    return `No password configured for profile "${profile.id}" - set ${profile.envName} as a secret on the Worker `
      + `(>= 8 characters). Profiles never share the default password.`;
  }
  if (profile.problem === 'too-short') {
    return `${profile.envName} must be at least 8 characters`;
  }
  return 'Profile authentication failed';
}
