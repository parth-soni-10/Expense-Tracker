/* ============================================================
   lib/profiles.mjs — shared per-profile credential resolution.

   Profile ids are client-generated slugs; the strict shape doubles
   as path/env safety. 'personal' is the default profile and maps
   to the original APP_PASSWORD + REPO_FILE pair; any other id maps
   to APP_PASSWORD_<ID> and a sibling file. Unknown profiles with
   no dedicated env var degrade to the shared credential, so
   single-user setups keep working unchanged.
   ============================================================ */

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const DEFAULT_PROFILE = 'personal';

/** Normalize a client-sent profile header into a safe id. */
export function profileIdFromHeader(value) {
  const raw = (value || '').trim();
  return PROFILE_ID_RE.test(raw) ? raw : DEFAULT_PROFILE;
}

/** Env var name for a profile's dedicated app password. */
export function passwordEnvName(id) {
  return `APP_PASSWORD_${id.toUpperCase().replace(/-/g, '_')}`;
}

/** Cloud file for a profile, derived from the configured base file. */
export function cloudFileFor(id, baseFile) {
  if (id === DEFAULT_PROFILE) return baseFile;
  return baseFile.replace(/(\.[^.]+)?$/, m => `-${id}${m || ''}`);
}

/** Resolve the request's profile to { id, expected }. */
export function resolveProfileForAuth(request) {
  const id = profileIdFromHeader(request.headers.get('x-cents-profile'));
  if (id === DEFAULT_PROFILE) {
    const expected = process.env.APP_PASSWORD;
    return { ok: !!expected, id, expected };
  }
  const expected = process.env[passwordEnvName(id)] || process.env.APP_PASSWORD;
  return { ok: !!expected, id, expected };
}
