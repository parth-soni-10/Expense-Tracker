/* The privacy lock and the profile picker, ported from the shipping app.
 *
 * The rules are the shipping app's, unchanged: every device opens locked; the
 * built-in PIN ("100901") is the credential until a personal one is saved on the
 * device; personal PINs are PBKDF2-SHA256 with a 310k work factor; a legacy
 * salted SHA-256 hash still verifies and is upgraded in place; fifteen failures
 * inside five minutes close the door for the rest of the window; and on phones
 * with a platform authenticator a registered credential can open the lock
 * instead. What changed is the markup only: classes instead of inline styles,
 * because the served app runs under `style-src 'self'`.
 */
import {
  getPrivacyPin,
  setPrivacyPin,
  getBiometricCredential,
  setBiometricCredential,
} from '../lib/settings.ts';
import { el, byId, clear } from './dom.ts';

export const DEFAULT_PIN_HASH = '3bc83f9bf0224554bd08d03d598a4c44d7eda855bbf034131e48d1dba72d5d7d';
export const DEFAULT_PIN_PLAIN = '100901';

const PBKDF2_ITERATIONS = 310_000;
const PIN_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
const PIN_THROTTLE_MAX = 15;
const PIN_FAILURES: number[] = [];

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
const randomToken = () =>
  globalThis.crypto.randomUUID?.()
  || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hashPin(pin: string, salt = ''): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(String(salt ?? '')), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256);
  return hex(bits);
}

export async function hashPinLegacy(pin: string, salt = ''): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const bytes = new TextEncoder().encode(`${salt ?? ''}:${String(pin)}`);
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export async function hashPinPlain(pin: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  const bytes = new TextEncoder().encode(String(pin));
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** The credential this device checks: the device PIN, else a legacy in-document
 *  hash, else the built-in default. */
export function getPinCredential(state: any): { hash: string; salt: string | null; kdf: string | null; isDefault: boolean } {
  const device = getPrivacyPin();
  if (device.hash) return { hash: device.hash, salt: device.salt, kdf: device.kdf, isDefault: false };
  const legacy = state?.settings?.pinHash;
  if (typeof legacy === 'string' && /^[a-f0-9]{64}$/i.test(legacy)) {
    return { hash: legacy.toLowerCase(), salt: null, kdf: 'sha256', isDefault: false };
  }
  return { hash: DEFAULT_PIN_HASH, salt: null, kdf: 'sha256', isDefault: true };
}

export function hasCustomPin(state: any): boolean {
  return !getPinCredential(state).isDefault;
}

/** Verify a candidate against the stored credential, upgrading a legacy salted
 *  hash to PBKDF2 on a successful check. */
export async function verifyPin(value: string, state: any): Promise<boolean> {
  const saved = getPinCredential(state);
  try {
    if (saved.salt !== null) {
      if (saved.kdf === 'pbkdf2') return (await hashPin(value, saved.salt)) === saved.hash;
      const legacyOk = (await hashPinLegacy(value, saved.salt)) === saved.hash;
      if (legacyOk) {
        try {
          const freshSalt = randomToken();
          setPrivacyPin(await hashPin(value, freshSalt), freshSalt, 'pbkdf2');
        } catch { /* keep the legacy credential; verification still succeeds */ }
      }
      return legacyOk;
    }
    if (globalThis.crypto?.subtle) return (await hashPinPlain(value)) === saved.hash;
    return saved.isDefault && value === DEFAULT_PIN_PLAIN;
  } catch {
    return false;
  }
}

function pinThrottleRemaining(now = Date.now()): number {
  const cutoff = now - PIN_THROTTLE_WINDOW_MS;
  while (PIN_FAILURES.length && PIN_FAILURES[0] < cutoff) PIN_FAILURES.shift();
  if (PIN_FAILURES.length < PIN_THROTTLE_MAX) return 0;
  return Math.max(1, Math.ceil((PIN_FAILURES[0] + PIN_THROTTLE_WINDOW_MS - now) / 1000));
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/* ── biometrics (mobile only) ─────────────────────────────────────────────── */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64URL[((b1 & 15) << 2) | (b2 >> 6)] : '';
    out += i + 2 < bytes.length ? B64URL[b2 & 63] : '';
  }
  return out;
}
function b64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const c of String(str)) {
    const v = B64URL.indexOf(c);
    if (v === -1) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
  }
  return new Uint8Array(out);
}
function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}
let bioSupport: Promise<boolean> | null = null;
export function biometricSupported(): Promise<boolean> {
  if (bioSupport) return bioSupport;
  bioSupport = (async () => {
    try {
      return Boolean(
        isMobileDevice()
        && globalThis.isSecureContext
        && typeof window.PublicKeyCredential === 'function'
        && typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
        && await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      );
    } catch { return false; }
  })();
  return bioSupport;
}
export function biometricLabel(): string {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'Face ID';
  if (/Android/i.test(ua)) return 'fingerprint';
  if (/Macintosh/i.test(ua)) return 'Touch ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  return 'biometrics';
}
export async function registerBiometric(): Promise<{ ok: boolean; reason?: string }> {
  if (!await biometricSupported()) return { ok: false, reason: 'unsupported' };
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const user = new Uint8Array(16);
    crypto.getRandomValues(user);
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { id: location.hostname, name: 'cents.' },
        user: { id: user, name: 'cents-device', displayName: 'cents.' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 60000,
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        attestation: 'none',
      },
    }) as PublicKeyCredential | null;
    if (!cred?.rawId) return { ok: false, reason: 'failed' };
    if (!setBiometricCredential(b64urlEncode(new Uint8Array(cred.rawId)))) return { ok: false, reason: 'failed' };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'NotAllowedError' ? 'cancelled' : 'failed' };
  }
}
export async function unlockWithBiometric(): Promise<{ ok: boolean; reason?: string }> {
  const stored = getBiometricCredential();
  if (!stored) return { ok: false, reason: 'none' };
  if (!await biometricSupported()) return { ok: false, reason: 'unsupported' };
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: b64urlDecode(stored.credentialId) }],
        userVerification: 'required',
      },
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'NotAllowedError' ? 'cancelled' : 'failed' };
  }
}

/* ── the lock screen ──────────────────────────────────────────────────────── */

export interface LockOptions {
  state: any;
  onUnlock: () => void;
}

export function showPinLock({ state, onUnlock }: LockOptions): void {
  const gate = byId('gate');
  if (!gate) return;
  clear(gate);
  const label = biometricLabel();
  const saved = getPinCredential(state);

  const message = el('p', { class: 'gate-msg muted', role: 'status' }, 'Enter your PIN.');
  const input = el('input', {
    class: 'gate-input', type: 'password', maxlength: '20', autocomplete: 'new-password',
    placeholder: 'PIN', 'aria-label': 'PIN',
  }) as HTMLInputElement;

  const bioArea = el('div', { class: 'gate-bio', hidden: true });
  const pinArea = el('form', { class: 'gate-pin' },
    input,
    el('button', { class: 'btn btn-primary gate-btn', type: 'submit' }, 'Unlock'),
  ) as HTMLFormElement;

  const card = el('main', {
    class: 'gate-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Unlock cents',
  },
    el('h1', { class: 'gate-brand serif' }, 'cents.'),
    el('p', { class: 'eyebrow' }, 'Privacy lock'),
    el('p', { class: 'gate-title serif' }, 'Welcome back.'),
    message,
    saved.isDefault
      ? el('p', { class: 'gate-hint muted' },
          `Still the default PIN: ${DEFAULT_PIN_PLAIN}. Set your own in Privacy lock.`)
      : null,
    bioArea,
    pinArea,
  );

  const overlay = el('div', { class: 'gate-bg' }, card);
  gate.append(overlay);

  const finish = () => {
    PIN_FAILURES.length = 0;
    overlay.remove();
    onUnlock();
  };

  const attempt = async (value: string) => {
    if (!/^[a-zA-Z0-9]{4,20}$/.test(value)) {
      message.textContent = 'Use 4-20 letters or numbers.';
      input.value = '';
      input.focus();
      return;
    }
    const wait = pinThrottleRemaining();
    if (wait > 0) {
      message.textContent = `Too many attempts. Try again in ${clock(wait)}.`;
      input.value = '';
      return;
    }
    if (!await verifyPin(value, state)) {
      PIN_FAILURES.push(Date.now());
      const left = pinThrottleRemaining();
      message.textContent = left > 0
        ? `Too many attempts. Try again in ${clock(left)}.`
        : globalThis.crypto?.subtle
          ? 'That PIN is not correct.'
          : 'PIN verification needs a secure (HTTPS) connection on this device.';
      input.value = '';
      input.focus();
      return;
    }
    finish();
  };

  pinArea.addEventListener('submit', (event) => {
    event.preventDefault();
    void attempt(input.value.trim());
  });
  input.addEventListener('input', async () => {
    const value = String(input.value || '').trim();
    if (value.length < 4 || !/^[a-zA-Z0-9]+$/.test(value)) return;
    if (await verifyPin(value, state)) {
      if (overlay.isConnected) finish();
    }
  });

  const showPin = () => {
    bioArea.hidden = true;
    pinArea.hidden = false;
    message.textContent = 'Enter your PIN.';
    queueMicrotask(() => input.focus());
  };
  const attemptBio = (auto: boolean) => {
    message.textContent = `Touch ${label} when prompted.`;
    void unlockWithBiometric().then((res) => {
      if (!overlay.isConnected) return;
      if (res.ok) finish();
      else if (auto) message.textContent = `Tap ${label} to unlock, or use your PIN.`;
      else {
        message.textContent = res.reason === 'cancelled'
          ? 'Fingerprint cancelled - tap again or use your PIN.'
          : 'Fingerprint unavailable - use your PIN.';
      }
    });
  };

  void biometricSupported().then((supported) => {
    if (!overlay.isConnected) return;
    if (!supported) {
      pinArea.hidden = false;
      queueMicrotask(() => input.focus());
      return;
    }
    if (!getBiometricCredential()) {
      pinArea.hidden = false;
      bioArea.hidden = false;
      bioArea.append(el('button', {
        class: 'btn btn-ghost gate-btn', type: 'button',
        onClick: () => {
          message.textContent = `Enable ${label}? Verify with ${label} when prompted.`;
          void registerBiometric().then((res) => {
            if (!overlay.isConnected) return;
            if (res.ok) finish();
            else if (res.reason === 'cancelled') {
              message.textContent = 'Not enabled - use your PIN.';
              input.focus();
            } else {
              message.textContent = 'Fingerprint is not available on this device - use your PIN.';
              input.focus();
            }
          });
        },
      }, `Enable ${label} unlock`));
      queueMicrotask(() => input.focus());
      return;
    }
    bioArea.hidden = false;
    pinArea.hidden = true;
    bioArea.append(
      el('button', { class: 'btn btn-primary gate-btn', type: 'button', onClick: () => attemptBio(false) }, `Unlock with ${label}`),
      el('button', { class: 'btn btn-ghost gate-btn', type: 'button', onClick: showPin }, 'Use PIN instead'),
    );
    pinArea.append(el('button', { class: 'btn btn-ghost gate-btn', type: 'button', onClick: () => {
      bioArea.hidden = false;
      pinArea.hidden = true;
      attemptBio(false);
    } }, `Use ${label} instead`));
    setTimeout(() => { if (overlay.isConnected) attemptBio(true); }, 350);
  });

  queueMicrotask(() => input.focus());
}

/* ── the profile picker ───────────────────────────────────────────────────── */

export interface PickerOptions {
  profiles: Array<{ id: string; name: string }>;
  activeId: string | null;
  onPick: (id: string) => void;
}

export function showProfilePicker({ profiles, activeId, onPick }: PickerOptions): void {
  const gate = byId('gate');
  if (!gate) return;
  clear(gate);

  const grid = el('div', { class: 'profile-grid', role: 'list' });
  for (const profile of profiles) {
    grid.append(el('button', {
      type: 'button',
      class: `profile-tile${profile.id === activeId ? ' current' : ''}`,
      role: 'listitem',
      'aria-label': `Open ${profile.name}`,
      onClick: () => onPick(profile.id),
    },
      el('span', { class: 'profile-name' }, profile.name),
      profile.id === activeId ? el('span', { class: 'profile-current-tag' }, 'Current') : null,
    ));
  }

  const card = el('main', {
    class: 'gate-card gate-card-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a profile',
  },
    el('h1', { class: 'gate-brand serif' }, 'cents.'),
    el('p', { class: 'eyebrow' }, "Who's tracking?"),
    grid,
  );

  gate.append(el('div', { class: 'gate-bg' }, card));
  (card.querySelector('.profile-tile') as HTMLElement | null)?.focus();
}
