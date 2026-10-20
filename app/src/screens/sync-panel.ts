/* ============================================================
   Cloud sync, and the setup link that configures it.

   The sync CLIENT lives in `app/lib/sync.ts` and the server half in
   `netlify/functions/`. This file is the surface: the Settings sheet's Cloud
   sync section, and the one-off redemption of a setup or invite link.

   Three rules carry the feature:

   1. A LINK MAY NOT REDIRECT THE DEVICE. An invite carries an endpoint, and
      only the site's own function path, or the endpoint this device already
      trusts, may be adopted from a link. An arbitrary foreign endpoint in a
      link is the exfiltration vector and it is rejected outright. The token is
      never left sitting in the address bar.

   2. A LINK IS SINGLE-USE AND IT EXPIRES. The server says so with a 410, and
      the screen says so in a sentence — "that link has expired" — rather than
      a generic failure the reader has to interpret.

   3. A LINK CONFIGURES ONLY WHAT IT WAS MINTED FOR. The exchange answers
      with the profile it belongs to and the tabs it carries, and the adopting
      device applies exactly those and nothing else.

   The mirror — a second copy of the ledger in a private repo — is a BACKUP,
   not the commit point. A save commits to the store that actually holds the
   document, and the mirror write is handed off and never returned, because a
   code host having a bad day must not fail somebody's save. The consequence
   is that the record can hold a version the repo does not, so the gap is
   MEASURED after every save and written down where the user will see it.
   ============================================================ */
import { el } from '../dom.ts';
import { toast } from '../toast.ts';
import { DEFAULT_SYNC_ENDPOINT, getSyncSettings, patchSyncSettings } from '../../lib/settings.ts';
import {
  mirrorStatus,
  relativeTime,
  syncCheckMirror,
  syncExchangeSetupToken,
  syncIssueSetupToken,
  syncStatus,
  syncTestConnection,
} from '../../lib/sync.ts';
import { clearPendingSetupLink, pendingSetupLink } from './profiles.ts';
import type { ScreenContext } from './context.ts';

/** The client half of a mirror gap, in the words the user reads. The
 *  vocabulary is closed and classified in `lib/sync.ts` — the states are
 *  `in_sync`, `pending`, `behind`, `diverged`, `missing`, `unverifiable`,
 *  `no_document` and `unconfigured` — so the screen does not invent a state
 *  of its own. `gap` is the only one that colours anything. */
export function mirrorLine(): { text: string; tone: '' | 'positive' | 'negative' } {
  const verdict = mirrorStatus((globalThis as any).__centsMirrorVerdict);
  if (!verdict.known) return { text: 'GitHub mirror · not checked yet', tone: '' };
  const text = `GitHub mirror · ${verdict.label}${verdict.detail ? ` · ${verdict.detail}` : ''}`;
  if (verdict.state === 'in_sync') return { text, tone: 'positive' };
  if (verdict.state === 'pending' || verdict.state === 'no_document' || verdict.state === 'missing'
    || verdict.state === 'unconfigured') return { text, tone: '' };
  return { text, tone: 'negative' };
}

export function buildSyncCard(ctx: ScreenContext): HTMLElement {
  const card = el('div', { class: 'card settings-card' });
  const status = el('p', { class: 'add-status', role: 'status', 'aria-live': 'polite' });
  const mirror = el('p', { class: 'muted tesco-card-note' });

  const settings = getSyncSettings();
  const endpointField = el('input', {
    type: 'text', class: 'add-input', value: settings.endpoint || DEFAULT_SYNC_ENDPOINT,
    'aria-label': 'Sync endpoint', autocomplete: 'off',
  }) as HTMLInputElement;
  const passwordField = el('input', {
    type: 'password', class: 'add-input', value: settings.password || '',
    'aria-label': 'Cloud sync password', autocomplete: 'off',
  }) as HTMLInputElement;

  const paint = (): void => {
    const current = syncStatus();
    card.replaceChildren();
    const line = mirrorLine();
    card.append(
      el('div', { class: 'eyebrow' }, 'Cloud sync'),
      el('p', { class: 'muted tesco-card-note' },
        'Your ledger stays on this device. Cloud sync is optional: it keeps a copy in a private store, and a second copy in a private repo you can read back.'),
      el('div', { class: 'add-row' },
        el('label', { class: 'add-label', for: 'sync-endpoint' }, 'Endpoint'),
        endpointField,
      ),
      el('div', { class: 'add-row' },
        el('label', { class: 'add-label', for: 'sync-password' }, 'Password'),
        passwordField,
      ),
      el('div', { class: 'add-actions' },
        el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => {
            const endpoint = endpointField.value.trim() || DEFAULT_SYNC_ENDPOINT;
            const password = passwordField.value;
            patchSyncSettings({ endpoint, password, enabled: true });
            status.textContent = 'Saved. Testing the connection...';
            status.className = 'add-status';
            void syncTestConnection(endpoint, password).then((result: any) => {
              if (result.ok) {
                status.textContent = 'Connected.';
                status.className = 'add-status';
                toast('Cloud sync is on.');
              } else {
                status.textContent = result.reason === 'auth'
                  ? 'That password was not accepted.'
                  : 'Could not reach that endpoint.';
                status.className = 'add-status is-error';
              }
            });
          },
        }, 'Save and test'),
        el('button', {
          type: 'button', class: 'btn btn-ghost',
          onClick: () => {
            status.textContent = 'Checking the backup...';
            status.className = 'add-status';
            void syncCheckMirror().then((verdict: any) => {
              (globalThis as any).__centsMirrorVerdict = verdict;
              paint();
              status.textContent = '';
              status.className = 'add-status';
            });
          },
        }, 'Check the backup now'),
        el('button', {
          type: 'button', class: 'btn btn-ghost',
          onClick: () => {
            void syncIssueSetupToken().then((result: any) => {
              if (!result.ok) {
                status.textContent = result.reason === 'not_configured'
                  ? 'Set a password first — a setup link is minted with it.'
                  : 'Could not create a setup link.';
                status.className = 'add-status is-error';
                return;
              }
              const link = `${location.origin}${location.pathname}?centsSync=${encodeURIComponent(result.token)}`;
              void navigator.clipboard?.writeText(link).then(
                () => toast('Setup link copied. It is single-use and it expires.'),
                () => toast(link),
              );
            });
          },
        }, 'Copy a setup link'),
      ),
      el('p', { class: 'muted tesco-card-note' }, `Sync · ${current.label}`),
      mirror,
      status,
    );
  };

  paint();
  return card;
}

/** Redeem a setup or invite link: exchange the token for a password, adopt the
 *  profile and the tabs it names, and enable sync — and nothing else.
 *
 *  The link is single-use and it expires, so the two failures the user is
 *  most likely to hit are both named: an expired link and one that was
 *  already used. */
export function redeemSetupLink(
  link: { endpoint: string; secret: string; isToken: boolean },
  onDone: (summary: string) => void,
): void {
  void syncExchangeSetupToken(link.secret, link.endpoint).then((result: any) => {
    if (!result.ok) {
      if (result.reason === 'expired') {
        toast('That link has expired. Ask for a new one.');
      } else if (result.reason === 'auth') {
        toast('That link was already used, or it was not accepted.');
      } else if (result.reason === 'network') {
        toast('Could not reach the server — check your connection.');
      } else {
        toast(result.message || 'That link could not be used.');
      }
      return;
    }
    patchSyncSettings({
      endpoint: link.endpoint,
      password: result.password,
      enabled: true,
    });
    clearPendingSetupLink();
    const bits: string[] = ['Cloud sync is on'];
    if (result.profileId) bits.push(`for ${result.profileId}`);
    if (Array.isArray(result.tabs) && result.tabs.length) bits.push(`with ${result.tabs.length} tab${result.tabs.length === 1 ? '' : 's'}`);
    onDone(bits.join(' '));
  });
}

/** Offer a stashed link, once the app is unlocked. A link can arrive before
 *  the user is logged in on a shared device, so it is held until then — and
 *  held rather than applied, because a link is something the user may not
 *  have meant to open. */
export function offerPendingSetupLink(ctx: ScreenContext): void {
  const link = pendingSetupLink();
  if (!link) return;
  const dialog = el('dialog', { class: 'history-dialog', id: 'setup-link' }) as HTMLDialogElement;
  const card = el('div', { class: 'history-dialog-card' },
    el('div', { class: 'add-card-head' },
      el('span', { class: 'eyebrow' }, 'Set up cloud sync?'),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Close', onClick: () => dialog.close() }, 'Close'),
    ),
    el('p', { class: 'muted tesco-card-note' },
      'A sync link is waiting. It is single-use and it expires, and it sets up only the profile and tabs it was made for.'),
    el('div', { class: 'add-actions' },
      el('button', {
        type: 'button', class: 'btn btn-primary',
        onClick: () => {
          dialog.close();
          redeemSetupLink(link, (summary) => {
            toast(`${summary}.`);
            ctx.refresh();
          });
        },
      }, 'Set it up'),
      el('button', {
        type: 'button', class: 'btn btn-ghost',
        onClick: () => {
          clearPendingSetupLink();
          dialog.close();
        },
      }, 'Not now'),
    ),
  );
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();
}
