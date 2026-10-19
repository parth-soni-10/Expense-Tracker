/* ============================================================
   profiles.js — device-local user profiles (Netflix-style).

   A shared device can hold several isolated spaces: each profile
   has its own entries, balances, settings, PIN, biometric
   credential, sync credentials and cloud file. The
   registry itself is a DEVICE concept — it lives in localStorage
   and never syncs.

   Sharing one profile across devices (the whole point of sync):
     1. Give the profile the SAME NAME on each device, so both
        resolve to the same id ("Sam P." -> sam-p).
     2. Give it the SAME password: the sync proxy maps that id to
        APP_PASSWORD_<ID> and to data-<id>.json in the repo (see
        netlify/functions/lib/profiles.mjs). The default profile id
        is "personal" and keeps the original APP_PASSWORD +
        REPO_FILE pair.
     3. Or hand a device the profile's setup link (?centsSync=...):
        it carries the profile id, so the receiving device offers to
        create the profile with that exact id and password rather
        than asking the user to retype both. See setActiveProfileId
        and applySetupLinkIfPresent in app.js.

   Storage layout (per profile id):
     cents:p/<id>/state       app state (was expense-tracker:v1)
     cents:p/<id>/quarantine  a copy of unreadable state, kept per profile
     cents:p/<id>/privacy     PIN hash (was cents:privacySettings)
     cents:p/<id>/bio         WebAuthn credential (was cents:biometric)
     cents:p/<id>/sync        sync settings (was cents:syncSettings)
     cents:p/<id>/undo        persisted undo journal
     cents:p/<id>/alerts      dismissed dashboard alerts
   The legacy global keys are migrated into the first profile
   ("personal") the first time this module runs, then removed.

   The active profile is resolved at module load. sessionStorage
   remembers the choice (so a reload lands straight on that
   profile's lock rather than "Who's tracking?" — see
   hasSessionChoice), and a switch in the running app re-resolves
   through setActiveProfileId + app.js's loadProfileIntoApp rather
   than a reload. Every reader must therefore go through nsKey()
   per call — never capture a resolved id at module load.
   ============================================================ */

const REGISTRY_KEY = 'cents:profiles';
const SESSION_KEY = 'cents:activeProfile';
const MAX_PROFILES = 6;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

// Logical storage bases. Every one is namespaced per profile, and every
// one is removed when a profile is deleted — a base missing from this
// list is a key that survives a delete and leaks into the next profile.
const BASES = ['state', 'quarantine', 'privacy', 'bio', 'sync', 'undo', 'alerts'];
const LEGACY_KEYS = {
  state: 'expense-tracker:v1',
  quarantine: 'expense-tracker:unreadable',
  privacy: 'cents:privacySettings',
  bio: 'cents:biometric',
  sync: 'cents:syncSettings',
  undo: 'cents-undo-journal',
  alerts: 'cents-dismissed-alerts',
};

function validRegistry(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.profiles) && value.profiles.length > 0
    && value.profiles.length <= MAX_PROFILES
    && value.profiles.every(p => p && typeof p === 'object'
      && typeof p.id === 'string' && ID_RE.test(p.id)
      && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 24
      // `icon` is OPTIONAL and loosely typed on purpose. Rejecting an unknown
      // one would reject the whole registry — and a rejected registry means the
      // app rebuilds it from scratch, i.e. every profile and its data would be
      // treated as gone. An id this build does not draw simply falls back to
      // the initial (see profileAvatar in app.js).
      && (p.icon == null || (typeof p.icon === 'string' && p.icon.length <= 24))
      && (p.createdAt == null || typeof p.createdAt === 'string'))
    && new Set(value.profiles.map(p => p.id)).size === value.profiles.length;
}

function readRegistry() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // A malformed picture is cosmetic, so it is dropped rather than treated as
    // a corrupt registry — rejecting the registry would rebuild it from
    // scratch and strand every other profile's data (their keys would still be
    // on the device, but nothing would point at them).
    if (parsed && Array.isArray(parsed.profiles)) {
      for (const p of parsed.profiles) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.icon === 'string' && p.icon.length <= 24) continue;
        if ('icon' in p) delete p.icon;
      }
    }
    return validRegistry(parsed) ? parsed : null;
  } catch { return null; }
}

function writeRegistry(next) {
  try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(next)); } catch { /* read-only storage */ }
}

/** Turn a display name into a profile id slug ("Sam P." -> "sam-p"). */
function slugify(name) {
  const slug = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return ID_RE.test(slug) ? slug : null;
}

function migrateLegacyKeysInto(profileId) {
  for (const base of BASES) {
    let value = null;
    try { value = localStorage.getItem(LEGACY_KEYS[base]); } catch { value = null; }
    if (value == null) continue;
    try {
      localStorage.setItem(nsKey(base, profileId), value);
      localStorage.removeItem(LEGACY_KEYS[base]);
    } catch { /* leave the legacy key in place rather than drop data */ }
  }
}

let registry = null;
let activeId = null;

// Resolved once, at module load — every later read on this page belongs
// to this profile. A switch re-resolves through a full reload.
(function initProfiles() {
  registry = readRegistry();
  if (!registry) {
    // First run (or a registry we cannot trust): the "personal" profile
    // takes over everything that existed before profiles did.
    registry = {
      v: 1,
      profiles: [{ id: 'personal', name: 'Personal', createdAt: new Date().toISOString() }],
      lastUsedId: 'personal',
    };
    migrateLegacyKeysInto('personal');
    writeRegistry(registry);
  }
  let candidate = null;
  try { candidate = sessionStorage.getItem(SESSION_KEY); } catch { candidate = null; }
  if (!candidate || !registry.profiles.some(p => p.id === candidate)) candidate = registry.lastUsedId;
  if (!candidate || !registry.profiles.some(p => p.id === candidate)) candidate = registry.profiles[0].id;
  activeId = candidate;
  if (registry.lastUsedId !== candidate) {
    registry.lastUsedId = candidate;
    writeRegistry(registry);
  }
})();

/** Namespace a logical storage key under the given profile (default: active). */
export function nsKey(base, profileId = null) {
  const id = profileId || activeId;
  return id ? `cents:p/${id}/${base}` : LEGACY_KEYS[base] || `cents:${base}`;
}

/** Env var this profile's cloud access needs (the sync proxy reads it). */
export function profileEnvName(id) {
  return id === 'personal' ? 'APP_PASSWORD' : `APP_PASSWORD_${id.toUpperCase().replace(/-/g, '_')}`;
}

export function listProfiles() {
  return registry.profiles.map(p => ({ ...p }));
}

export function activeProfile() {
  return registry.profiles.find(p => p.id === activeId) || registry.profiles[0];
}

export function getActiveProfileId() {
  return activeId;
}

/**
 * Choose the picture for a profile (any icon id the UI knows, or null for the
 * initial). Device-local, exactly like the name: it lives on the registry next
 * to it, so it is readable before unlock and does not sync.
 */
export function setProfileIcon(id, icon) {
  const profile = registry.profiles.find(p => p.id === id);
  if (!profile) return { error: 'Profile not found.' };
  if (icon == null || icon === '') delete profile.icon;
  else profile.icon = String(icon).slice(0, 24);
  writeRegistry(registry);
  return { ok: true, profile: { ...profile } };
}

/**
 * The admin of this device: the "personal" profile, whose credential is the
 * site's APP_PASSWORD and whose cloud file is the base REPO_FILE. It is the
 * profile the app creates first and the only one that can open the Admin
 * panel, so it can never be deleted (deleteProfile refuses it). Falls back to
 * the first profile for a registry written before that rule existed.
 */
export function isAdminProfile(id) {
  const admin = registry.profiles.find(p => p.id === 'personal') || registry.profiles[0];
  return !!admin && admin.id === id;
}

/** True when this tab has already answered "who's tracking?" at least once.
 *  The picker is for a fresh visit; a reload in the same tab keeps the
 *  choice (and still meets that profile's lock). */
export function hasSessionChoice() {
  try { return !!sessionStorage.getItem(SESSION_KEY); } catch { return false; }
}

/** Pick the profile for the NEXT page load (session + registry), then reload. */
export function setActiveProfileId(id) {
  if (!registry.profiles.some(p => p.id === id)) return false;
  activeId = id;
  registry.lastUsedId = id;
  writeRegistry(registry);
  try { sessionStorage.setItem(SESSION_KEY, id); } catch { /* session unavailable */ }
  return true;
}

/**
 * Add a profile. `id` is normally derived from the name; pass one
 * explicitly to adopt a profile from a setup link, so the id (and with it
 * the cloud file + password) matches the device the link came from.
 */
export function createProfile(name, { id: wantedId = null } = {}) {
  const label = String(name || '').trim();
  if (label.length < 1 || label.length > 24) return { error: 'Use 1-24 characters.' };
  if (wantedId) {
    if (!ID_RE.test(wantedId)) return { error: 'That profile id cannot be used.' };
    // Adopting a profile a device already has (a setup link opened twice) is
    // not an error and must not be mistaken for a name clash.
    const existing = registry.profiles.find(p => p.id === wantedId);
    if (existing) return { profile: { ...existing }, existing: true };
    if (registry.profiles.length >= MAX_PROFILES) return { error: `Up to ${MAX_PROFILES} profiles.` };
    const taken = registry.profiles.some(p => p.name.toLowerCase() === label.toLowerCase());
    const profile = { id: wantedId, name: taken ? `${label} (${wantedId})`.slice(0, 24) : label, createdAt: new Date().toISOString() };
    registry.profiles.push(profile);
    writeRegistry(registry);
    return { profile: { ...profile } };
  }
  if (registry.profiles.some(p => p.name.toLowerCase() === label.toLowerCase())) {
    return { error: 'That name is taken.' };
  }
  if (registry.profiles.length >= MAX_PROFILES) return { error: `Up to ${MAX_PROFILES} profiles.` };
  let id = slugify(label);
  if (!id) return { error: 'Use letters or numbers in the name.' };
  for (let n = 2; registry.profiles.some(p => p.id === id); n += 1) {
    id = `${slugify(label).slice(0, 20)}-${n}`;
  }
  const profile = { id, name: label, createdAt: new Date().toISOString() };
  registry.profiles.push(profile);
  writeRegistry(registry);
  return { profile: { ...profile } };
}

export function renameProfile(id, name) {
  const label = String(name || '').trim();
  if (label.length < 1 || label.length > 24) return { error: 'Use 1-24 characters.' };
  const profile = registry.profiles.find(p => p.id === id);
  if (!profile) return { error: 'Profile not found.' };
  if (registry.profiles.some(p => p.id !== id && p.name.toLowerCase() === label.toLowerCase())) {
    return { error: 'That name is taken.' };
  }
  // The id (and so the cloud file + password) never changes on a rename:
  // renaming "Sam" to "Samantha" must not orphan the data already synced.
  profile.name = label;
  writeRegistry(registry);
  return { profile: { ...profile } };
}

/** Remove a profile and every storage key it owns. Refuses the last one, and
 *  refuses the admin — see isAdminProfile. */
export function deleteProfile(id) {
  if (isAdminProfile(id)) return { error: 'The owner profile cannot be deleted.' };
  if (registry.profiles.length <= 1) return { error: 'The last profile cannot be deleted.' };
  const index = registry.profiles.findIndex(p => p.id === id);
  if (index === -1) return { error: 'Profile not found.' };
  for (const base of BASES) {
    try { localStorage.removeItem(nsKey(base, id)); } catch { /* best effort */ }
  }
  registry.profiles.splice(index, 1);
  if (registry.lastUsedId === id) registry.lastUsedId = registry.profiles[0].id;
  writeRegistry(registry);
  if (activeId === id) {
    activeId = registry.profiles[0].id;
    try { sessionStorage.setItem(SESSION_KEY, activeId); } catch { /* session unavailable */ }
  }
  return { ok: true, remaining: listProfiles() };
}
