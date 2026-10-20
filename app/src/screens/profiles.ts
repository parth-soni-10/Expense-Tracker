/* ============================================================
   Profiles, and the people who share a device with you.

   A shared device can hold several isolated spaces. Each profile has its own
   entries, balances, settings, PIN, biometric credential, sync credentials
   and cloud file; the registry itself is a DEVICE concept and never syncs.
   The ported rules live in `app/lib/profiles.ts`; this file is the surface.

   Five rules carry the feature, and each one exists because the obvious
   implementation loses somebody's data or lets somebody else in:

   1. THE OWNER IS THE ONLY ADMIN. The owner profile holds the site password
      and the base cloud file, so removing it would leave nobody able to open
      the panel again — `deleteProfile` refuses it, and the panel itself
      refuses to open for anyone else.

   2. A TAB IS A POLICY, NOT A PREFERENCE. A tab switched off for a person is
      hidden for that person everywhere their profile goes, on every device
      they sync it to — so the change is written to their document AND pushed
      to the cloud. The owner panel says so in as many words.

   3. A PROFILE IS IDENTIFIED BEFORE ITS PIN IS ASKED FOR. Picking a profile
      names it — "Who's tracking?" — and the pick lands on THAT profile's
      lock. A PIN typed at a screen that does not say whose it is is a PIN
      typed at the wrong ledger.

   4. A SETUP LINK MAY NOT REDIRECT THE DEVICE. An invite carries an
      endpoint, and only the site's own function path or the endpoint this
      device already trusts may be adopted from a link. An arbitrary foreign
      endpoint in a link is the exfiltration vector, and it is rejected
      outright. The token is never left sitting in the address bar.

   5. AN INVITE IS THE OWNER'S CREDENTIAL MINTED FOR ONE PROFILE. It is
      single-use, it expires, and it configures only the profile and tabs it
      was minted for.
   ============================================================ */
import { el } from '../dom.ts';
import { toast } from '../toast.ts';
import { HIDEABLE_TABS, TABS } from '../../lib/seed.ts';
import {
  createProfile,
  deleteProfile,
  getActiveProfileId,
  isAdminProfile,
  listProfiles,
  profileEnvName,
  renameProfile,
  setActiveProfileId,
  setProfileIcon,
} from '../../lib/profiles.ts';
import { loadStateFor, patchProfileSettings } from '../../lib/storage.ts';
import { getSyncSettings } from '../../lib/settings.ts';
import { syncIssueProfileInvite, syncPushProfilePolicy } from '../../lib/sync.ts';
import type { ScreenContext } from './context.ts';

const PENDING_KEY = 'cents-pending-setup';

/* ── the setup link ───────────────────────────────────────────────────────── */

/** Read a setup link: an optional endpoint, then a secret.
 *
 *  `endpoint|secret` is only meaningful when the part before the pipe looks
 *  like a real endpoint; otherwise the whole string is the secret, so a secret
 *  that itself contains `|` round-trips unharmed. */
export function parseSetupLink(raw: string):
  { endpoint: string | null; secret: string; isToken: boolean } | { error: string } {
  let decoded: string;
  try { decoded = decodeURIComponent(String(raw || '')); } catch { return { error: 'invalid' }; }
  let endpoint: string | null = null;
  let secret = decoded;
  const separator = decoded.indexOf('|');
  if (separator >= 0) {
    const possibleEndpoint = decoded.slice(0, separator);
    const looksLikeEndpoint = possibleEndpoint === ''
      || /^\/(?!\/)/.test(possibleEndpoint)
      || /^https:\/\//i.test(possibleEndpoint)
      || /^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(possibleEndpoint);
    if (looksLikeEndpoint) {
      endpoint = possibleEndpoint || null;
      secret = decoded.slice(separator + 1);
    }
  }
  if (!secret) return { error: 'invalid' };
  // New-style links carry an encrypted token with a fixed structure:
  // t2.<16-char iv>.<ciphertext>.<22-char tag> (base64url segments). The
  // exact segment lengths make it effectively impossible for a real password
  // to be mistaken for a token. Legacy 't1.' tokens can no longer be redeemed
  // (the HMAC format is gone), so they fall through to the password shape.
  const isToken = /^t2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{22}$/.test(secret);
  if (!isToken && secret.length < 8) return { error: 'invalid' };
  return { endpoint, secret, isToken };
}

/** Take a setup link out of the address bar and decide whether it may be
 *  adopted. The link is stashed for after the unlock, because a link can
 *  arrive before the user is logged in on a shared device.
 *
 *  The WHITELIST is the whole of the safety here: only the site's own
 *  function path, or the endpoint this device already trusts, may be adopted
 *  from a link. An arbitrary foreign endpoint in a link is the exfiltration
 *  vector and is rejected outright. */
export function applySetupLinkIfPresent(): { endpoint: string; secret: string; isToken: boolean } | null {
  const params = new URLSearchParams(location.search);
  let raw = params.get('centsSync');
  if (!raw) {
    try { raw = sessionStorage.getItem(PENDING_KEY); } catch { raw = null; }
    if (!raw) return null;
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* session unavailable */ }
  }
  // Never leave a credential (or a garbage link) sitting in the address bar.
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* ignore */ }
  try { sessionStorage.setItem(PENDING_KEY, raw); } catch { /* session unavailable */ }

  const parsed = parseSetupLink(raw);
  if ('error' in parsed) {
    toast('That sync link is not valid.');
    return null;
  }
  const current = getSyncSettings();
  let endpoint = parsed.endpoint;
  if (endpoint === null || endpoint === '') endpoint = current.endpoint || '/api/sync';
  // Whitelist: only this site's own function path, or the endpoint this
  // device already trusts, may be adopted from a link.
  const isOwnSite = /^\/(?!\/)/.test(endpoint);
  const matchesCurrent = !!current.endpoint && endpoint === current.endpoint;
  if (!isOwnSite && !matchesCurrent) {
    toast('That sync link points to a different server and was ignored.');
    return null;
  }
  return { endpoint, secret: parsed.secret, isToken: parsed.isToken };
}

/** The stashed link, if there is one, and the reason it is not applied yet. */
export function pendingSetupLink(): { endpoint: string; secret: string; isToken: boolean } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = parseSetupLink(raw);
    if ('error' in parsed) return null;
    const current = getSyncSettings();
    let endpoint = parsed.endpoint;
    if (endpoint === null || endpoint === '') endpoint = current.endpoint || '/api/sync';
    const isOwnSite = /^\/(?!\/)/.test(endpoint);
    const matchesCurrent = !!current.endpoint && endpoint === current.endpoint;
    if (!isOwnSite && !matchesCurrent) return null;
    return { endpoint, secret: parsed.secret, isToken: parsed.isToken };
  } catch {
    return null;
  }
}

export function clearPendingSetupLink(): void {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* session unavailable */ }
}

/* ── the profile list ─────────────────────────────────────────────────────── */

const AVATARS = ['cat', 'dog', 'robot', 'star', 'leaf', 'wave'];

function avatarFor(id: string): string {
  const profile = listProfiles().find((p) => p.id === id);
  const icon = (profile as any)?.icon;
  return icon || 'cat';
}

/** The tabs a profile may open. The dashboard is never hidden: it is the
 *  landing page and the app's only hub, so hiding it would leave nowhere to
 *  land and no way back for the person it was hidden from. */
export function tabsFor(profileId: string, isCurrent: boolean): string[] {
  if (isCurrent) {
    const raw = (globalThis as any).__centsEnabledTabs;
    if (Array.isArray(raw) && raw.length) return raw;
  }
  const stored = loadStateFor(profileId).settings?.enabledTabs;
  return Array.isArray(stored) && stored.length ? stored : [...TABS];
}

/** Switch a tab for a profile. The owner's own change is written to their own
 *  document; anybody else's is written to *their* document and pushed to the
 *  cloud, so the change follows their profile to every device. */
export function setProfileTab(
  ctx: ScreenContext,
  profileId: string,
  route: string,
  visible: boolean,
  isCurrent: boolean,
  redraw: () => void,
): void {
  const current = tabsFor(profileId, isCurrent);
  const next = TABS.filter((id) => (id === route ? visible : current.includes(id)));
  if (isCurrent) {
    (ctx.state as any).settings.enabledTabs = next;
    ctx.save();
    ctx.refresh();
    redraw();
    return;
  }
  if (!patchProfileSettings(profileId, { enabledTabs: next })) {
    toast('Could not save that change on this device.');
    return;
  }
  const profile = listProfiles().find((p) => p.id === profileId);
  toast(`${titleFor(route)} ${visible ? 'shown to' : 'hidden from'} ${profile ? profile.name : 'that profile'}.`);
  redraw();
  // The change follows the profile to every device it syncs to.
  void syncPushProfilePolicy(profileId, next);
}

export function titleFor(route: string): string {
  return ({
    dashboard: 'Dashboard', add: 'Add', history: 'History',
    balances: 'Balances', tesco: 'Tesco Pay', insights: 'Insights',
  } as Record<string, string>)[route] || route;
}

/* ── the Settings section ─────────────────────────────────────────────────── */

export function buildProfilesCard(ctx: ScreenContext, onSwitch: (id: string) => void): HTMLElement {
  const card = el('div', { class: 'card settings-card' });
  const list = el('div', { class: 'profile-list' });

  const draw = (): void => {
    list.replaceChildren();
    const active = getActiveProfileId();
    for (const profile of listProfiles()) {
      const isCurrent = profile.id === active;
      list.append(el('div', { class: `profile-row${isCurrent ? ' is-current' : ''}` },
        el('span', { class: 'profile-avatar', 'aria-hidden': 'true' }, avatarFor(profile.id)),
        el('span', { class: 'profile-row-main' },
          el('span', { class: 'profile-row-name' }, profile.name),
          el('span', { class: 'profile-row-note muted' },
            [isCurrent ? 'open now' : null, isAdminProfile(profile.id) ? 'owner' : null]
              .filter(Boolean).join(' · ') || 'your own account')),
        isCurrent ? null : el('button', {
          type: 'button', class: 'btn btn-ghost', 'aria-label': `Open ${profile.name}`,
          onClick: () => onSwitch(profile.id),
        }, 'Open'),
      ));
    }
  };

  const nameInput = el('input', {
    type: 'text', class: 'add-input', placeholder: 'Name', 'aria-label': 'New profile name', autocomplete: 'off', maxlength: '24',
  }) as HTMLInputElement;
  const addStatus = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });

  const add = (): void => {
    const made = createProfile(nameInput.value);
    if ((made as any).error) {
      addStatus.textContent = (made as any).error;
      addStatus.className = 'add-status is-error';
      return;
    }
    addStatus.textContent = '';
    addStatus.className = 'add-status';
    nameInput.value = '';
    toast('Profile created.');
    draw();
  };

  draw();
  card.append(
    el('div', { class: 'eyebrow' }, 'Profiles'),
    el('p', { class: 'muted tesco-card-note' },
      'Everyone opens their own account and sees only their own entries, balances and PIN.'),
    list,
    el('div', { class: 'add-row' },
      nameInput,
      el('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Add profile'),
    ),
    addStatus,
    isAdminProfile(getActiveProfileId())
      ? el('div', { class: 'add-actions' },
        el('button', {
          type: 'button', class: 'btn btn-ghost',
          onClick: () => openAdminPanel(ctx, draw, onSwitch),
        }, 'Manage people'))
      : null,
  );
  return card;
}

/* ── the admin panel ──────────────────────────────────────────────────────── */

export function openAdminPanel(ctx: ScreenContext, onChanged: () => void, onSwitch: (id: string) => void): void {
  // THE OWNER IS THE ONLY ADMIN. The panel refuses to open for anyone else,
  // and the refusal is a sentence rather than a hidden button.
  if (!isAdminProfile(getActiveProfileId())) {
    toast('Only the owner can manage users.');
    return;
  }
  const dialog = el('dialog', { class: 'history-dialog', id: 'admin-panel' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card admin-panel' });
  const rows = el('div', { class: 'admin-cards' });

  const close = (): void => { dialog.close(); };
  dialog.addEventListener('close', () => { dialog.remove(); onChanged(); });

  const draw = (): void => {
    rows.replaceChildren();
    const active = getActiveProfileId();
    for (const profile of listProfiles()) {
      const isCurrent = profile.id === active;
      const owner = isAdminProfile(profile.id);
      const tabs = tabsFor(profile.id, isCurrent);
      // The cloud credential is NAMED, not implied: a second profile syncs only
      // once its own env var exists, and this is where the owner finds out.
      const note = [
        owner ? 'Owner' : null,
        isCurrent ? 'open now' : null,
        owner ? null : `Cloud password: ${profileEnvName(profile.id)}`,
      ].filter(Boolean).join(' · ');

      const chips = el('div', { class: 'admin-tabs', role: 'group', 'aria-label': `Tabs ${profile.name} can open` });
      for (const route of HIDEABLE_TABS) {
        const on = tabs.includes(route);
        chips.append(el('button', {
          type: 'button', class: `admin-tab${on ? ' on' : ''}`, 'aria-pressed': String(on),
          'aria-label': `${titleFor(route)} for ${profile.name}: ${on ? 'shown' : 'hidden'}`,
          onClick: () => setProfileTab(ctx, profile.id, route, !on, isCurrent, draw),
        }, titleFor(route)));
      }

      rows.append(el('div', { class: 'card admin-card' },
        el('div', { class: 'profile-row' },
          el('span', { class: 'profile-avatar', 'aria-hidden': 'true' }, avatarFor(profile.id)),
          el('span', { class: 'profile-row-main' },
            el('span', { class: 'profile-row-name' }, profile.name),
            note ? el('span', { class: 'profile-row-note muted' }, note) : null),
          el('span', { class: 'profile-row-actions' },
            !isCurrent ? el('button', {
              type: 'button', class: 'btn btn-ghost', 'aria-label': `Open ${profile.name}`,
              onClick: () => onSwitch(profile.id),
            }, 'Open') : null,
            // An invite is how this person gets their account onto their own
            // phone. The owner profile has no invite: it is this device.
            !owner ? el('button', {
              type: 'button', class: 'btn btn-ghost', 'aria-label': `Invite ${profile.name}`,
              onClick: () => openInviteDialog(profile.id, tabs),
            }, 'Invite') : null,
            el('button', {
              type: 'button', class: 'btn btn-ghost', 'aria-label': `Picture for ${profile.name}`,
              onClick: () => openAvatarPicker(profile.id, draw),
            }, 'Picture'),
            el('button', {
              type: 'button', class: 'btn btn-ghost', 'aria-label': `Rename ${profile.name}`,
              onClick: () => openRenameDialog(profile.id, profile.name, draw),
            }, 'Rename'),
            // The owner profile is not deletable: it holds the site password
            // and the base cloud file, and removing it would leave nobody able
            // to open this panel again.
            !owner ? el('button', {
              type: 'button', class: 'btn btn-danger', 'aria-label': `Delete ${profile.name}`,
              onClick: () => openDeleteDialog(profile.id, profile.name, draw),
            }, 'Delete') : null,
          ),
        ),
        el('div', { class: 'admin-tabs-label' }, 'Tabs'),
        chips,
      ));
    }
  };

  card.append(
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Admin'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close the admin panel', onClick: close }, 'Close'),
    ),
    el('p', { class: 'muted tesco-card-note' },
      'People you share cents. with. Everyone opens their own account on their own phone and sees only their own entries, balances and PIN. A tab you switch off is hidden for that person everywhere their profile goes, on every device they sync it to.'),
    rows,
  );
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
  draw();
}

/* ── the small dialogs ────────────────────────────────────────────────────── */

function openAvatarPicker(profileId: string, redraw: () => void): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'avatar-picker' }) as HTMLDialogElement;
  const grid = el('div', { class: 'avatar-grid' });
  for (const icon of AVATARS) {
    grid.append(el('button', {
      type: 'button', class: 'avatar-tile', 'aria-label': `Use the ${icon} picture`,
      onClick: () => {
        setProfileIcon(profileId, icon);
        dialog.close();
        redraw();
      },
    }, icon));
  }
  const card = el('div', { class: 'history-dialog-card' },
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Picture'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close the picture picker', onClick: () => dialog.close() }, 'Close'),
    ),
    grid,
  );
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}

function openRenameDialog(profileId: string, current: string, redraw: () => void): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'rename-profile' }) as HTMLDialogElement;
  const input = el('input', {
    type: 'text', class: 'add-input', value: current, 'aria-label': 'Profile name', autocomplete: 'off', maxlength: '24',
  }) as HTMLInputElement;
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });
  const card = el('div', { class: 'history-dialog-card' },
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Rename profile'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close', onClick: () => dialog.close() }, 'Close'),
    ),
    el('div', { class: 'add-row' }, input),
    status,
    el('div', { class: 'add-actions' },
      el('button', {
        type: 'button', class: 'btn btn-primary',
        onClick: () => {
          const result = renameProfile(profileId, input.value);
          if ((result as any).error) {
            status.textContent = (result as any).error;
            status.className = 'add-status is-error';
            return;
          }
          dialog.close();
          redraw();
        },
      }, 'Rename'),
    ),
  );
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}

function openDeleteDialog(profileId: string, name: string, redraw: () => void): void {
  const dialog = el('dialog', { class: 'history-dialog', id: 'delete-profile' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card' },
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, `Delete ${name}?`),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close', onClick: () => dialog.close() }, 'Close'),
    ),
    el('p', { class: 'muted tesco-card-note' },
      'Every entry, balance, PIN and setting stored on this device for that profile is removed. A copy already synced to the cloud is not touched.'),
    el('div', { class: 'add-actions' },
      el('button', {
        type: 'button', class: 'btn btn-danger',
        onClick: () => {
          const result = deleteProfile(profileId);
          if ((result as any).error) {
            toast((result as any).error);
            return;
          }
          dialog.close();
          redraw();
        },
      }, 'Delete'),
    ),
  );
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}

/** Why an invite could not be minted, in the terms of the screen the owner
 *  would go and fix it on. */
function inviteFailure(reason: string, message?: string): string {
  if (reason === 'not_configured') return "Turn on Cloud sync first - an invite is minted with the owner's password.";
  if (reason === 'invalid_endpoint') return 'Cloud sync points somewhere without the invite function - check the URL.';
  if (reason === 'auth') return "The password in Cloud sync is not the owner's password - invites need APP_PASSWORD.";
  if (reason === 'network') return 'Could not reach the server - check your connection.';
  return message || 'Could not create that invite.';
}

function openInviteDialog(profileId: string, tabs: string[]): void {
  toast('Creating an invite...');
  void syncIssueProfileInvite(profileId, tabs).then((result: any) => {
    if (!result.ok) {
      toast(inviteFailure(result.reason, result.message));
      return;
    }
    const link = `${location.origin}${location.pathname}?centsSync=${encodeURIComponent(result.token)}`;
    const dialog = el('dialog', { class: 'history-dialog', id: 'invite-dialog' }) as HTMLDialogElement;
    const field = el('input', {
      type: 'text', class: 'add-input', readonly: true, value: link, 'aria-label': `Invite link for ${profileId}`,
    }) as HTMLInputElement;
    const note = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });
    const card = el('div', { class: 'history-dialog-card' },
      el('div', { class: 'add-card-head' },
        el('span', { class: 'eyebrow' }, 'Invite link'),
        el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close the invite', onClick: () => dialog.close() }, 'Close'),
      ),
      el('p', { class: 'muted tesco-card-note' },
        'Single-use, and it expires. It sets up this profile and the tabs it was minted for, and nothing else.'),
      field,
      el('div', { class: 'add-actions' },
        el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => {
            void navigator.clipboard?.writeText(link).then(
              () => { note.textContent = 'Link copied. Send it to them directly.'; },
              () => { field.select(); note.textContent = 'Press Ctrl/Cmd+C to copy the selected link.'; },
            );
          },
        }, 'Copy link'),
      ),
      note,
    );
    dialog.append(card);
    document.body.append(dialog);
    dialog.showModal();
  });
}
