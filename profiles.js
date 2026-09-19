/* ============================================================
   profiles.js — device-local user profiles (Netflix-style).

   A shared device can hold several isolated spaces: each profile
   has its own entries, balances, settings, PIN, biometric
   credential, sync credentials, and cloud file. Profiles are a
   DEVICE concept — the registry lives in localStorage and never
   syncs. To share a profile's data across devices, create a
   profile with the same name on each device and give it the same
   password (see sync.mjs header for the env-var mapping).

   Storage layout (per profile id):
     cents:p/<id>/state      app state (was expense-tracker:v1)
     cents:p/<id>/privacy    PIN hash (was cents:privacySettings)
     cents:p/<id>/bio        WebAuthn credential (was cents:biometric)
     cents:p/<id>/sync       sync settings (was cents:syncSettings)
     cents:p/<id>/undo       persisted undo journal
     cents:p/<id>/alerts     dismissed dashboard alerts
     cents:p/<id>/reminder   daily reminder settings

   The legacy global keys are migrated into the first profile
   ("personal") the first time this module runs, then removed.
   The active profile is resolved once per page load and fixed:
   sessionStorage survives soft reloads, so a profile switch
   always goes through a location.reload() to re-resolve.
   ============================================================ */

const REGISTRY_KEY = 'cents:profiles';
const SESSION_KEY = 'cents:activeProfile';
const MAX_PROFILES = 6;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

// base name -> legacy global key. Order is irrelevant; each maps
// into cents:p/<id>/<base> for every profile.
const BASES = ['state', 'privacy', 'bio', 'sync', 'undo', 'alerts', 'reminder'];
const LEGACY_KEYS = {
  state: 'expense-tracker:v1',
  privacy: 'cents:privacySettings',
  bio: 'cents:biometric',
  sync: 'cents:syncSettings',
  undo: 'cents-undo-journal',
  alerts: 'cents-dismissed-alerts',
  reminder: 'cents:reminder',
};

function validRegistry(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.profiles) && value.profiles.length > 0
    && value.profiles.every(p => p && typeof p === 'object'
      && typeof p.id === 'string' && ID_RE.test(p.id)
      && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 24
      && (p.createdAt == null || typeof p.createdAt === 'string'));
}

function readRegistry() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validRegistry(parsed) ? parsed : null;
  } catch { return null; }
}

function writeRegistry(registry) {
  try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry)); } catch (e) { /* read-only storage */ }
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
    const legacy = LEGACY_KEYS[base];
    let value = null;
    try { value = localStorage.getItem(legacy); } catch { value = null; }
    if (value == null) continue;
    try {
      localStorage.setItem(nsKey(base, profileId), value);
      localStorage.removeItem(legacy);
    } catch { /* leave the legacy key in place rather than dropping data */ }
  }
}

let registry = null;
let activeId = null;

// Resolved once, at module load — every later read on this page belongs
// to this profile. A switch re-resolves through a full reload.
(function initProfiles() {
  registry = readRegistry();
  if (!registry) {
    // First run after the profiles upgrade: the "personal" profile owns
    // everything that existed before it.
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

export function listProfiles() {
  return registry.profiles.map(p => ({ ...p }));
}

export function activeProfile() {
  return registry.profiles.find(p => p.id === activeId) || registry.profiles[0];
}

export function getActiveProfileId() {
  return activeId;
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

export function createProfile(name) {
  const label = String(name || '').trim();
  if (label.length < 1 || label.length > 24) return { error: 'Use 1-24 characters.' };
  if (registry.profiles.length >= MAX_PROFILES) return { error: `Up to ${MAX_PROFILES} profiles.` };
  if (registry.profiles.some(p => p.name.toLowerCase() === label.toLowerCase())) {
    return { error: 'That name is taken.' };
  }
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
  profile.name = label;
  writeRegistry(registry);
  return { profile: { ...profile } };
}

/** Remove a profile and every storage key it owns. Refuses the last one. */
export function deleteProfile(id) {
  if (registry.profiles.length <= 1) return { error: 'The last profile cannot be deleted.' };
  const index = registry.profiles.findIndex(p => p.id === id);
  if (index === -1) return { error: 'Profile not found.' };
  for (const base of BASES) {
    try { localStorage.removeItem(nsKey(base, id)); } catch { /* best effort */ }
  }
  registry.profiles.splice(index, 1);
  if (registry.lastUsedId === id) registry.lastUsedId = registry.profiles[0].id;
  writeRegistry(registry);
  return { ok: true, remaining: listProfiles() };
}
