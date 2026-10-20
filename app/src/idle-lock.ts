/* ============================================================
   Re-locking: idle, and the app switcher.

   The lock is the whole of this app's access control — localStorage has no
   session and no server to challenge a request — so "unlocked" has to be a
   state the app can take back by itself: a phone set down mid-screen, an
   app-switcher swipe, a tab left behind for the afternoon. Two rules, in one
   place because they share one door:

   1. Untouched for `IDLE_LOCK_MS` → locked again. This is the ONLY time-based
      lock, and it is about absence rather than about where the window is:
      five minutes without a keystroke or a tap locks the app whether that
      five minutes was spent in front of you or in a background tab.

   2. The moment the document hides, an opaque cover goes over it. The
      app-switcher snapshot is taken WHILE hidden, so a cover that waited for
      the return would be one screenshot too late. It cannot be a blur —
      nothing may re-sample the page behind it — so it paints the app's own
      surface instead.

   There used to be a third: hidden for 30 seconds → locked on the way back,
   measured on RETURN because a hidden tab's timers are throttled past any
   useful resolution. It was removed on 16 Oct 2026 because it charged the
   PIN for every glance at another tab, and a tab switch is not an absence.
   Nothing about the exposure it was covering went away: the cover is still
   painted by the rule 1 timer, which runs while hidden too — the clock is
   armed on the last genuine interaction and fires on its own.

   An interaction only restarts a clock. It never unlocks, and it never
   touches state.
   ============================================================ */
import { el, byId } from './dom.ts';

/** Five minutes. The shipping app's own figure, and the reason it is a
 *  *five* minutes rather than one: a phone set down for a minute is not an
 *  absence, and a PIN prompt every minute is a PIN prompt nobody reads. */
export const IDLE_LOCK_MS = 5 * 60 * 1000;

/** The events that count as presence. A pointer press, a key, a touch or a
 *  scroll — the four ways a person proves they are there. */
const INTERACTIONS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

let timer: ReturnType<typeof setTimeout> | null = null;
let armed = false;

/** Restart the idle clock. Called on every interaction while unlocked; a call
 *  while locked arms nothing, so the lock screen cannot keep itself awake. */
export function resetIdleLock(lock: () => void): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!armed) return;
  timer = setTimeout(() => {
    timer = null;
    lock();
  }, IDLE_LOCK_MS);
}

/** Start counting. Called when the app unlocks. */
export function startIdleLock(lock: () => void): void {
  armed = true;
  resetIdleLock(lock);
}

/** Stop counting. Called when the app locks, and when it is torn down. */
export function stopIdleLock(): void {
  armed = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Whether the clock is running. The Settings sheet says so out loud rather
 *  than leaving the reader to guess whether it is armed. */
export function idleLockArmed(): boolean {
  return armed;
}

/** The opaque cover, painted the moment the document hides. */
export function installPrivacyCover(): void {
  if (byId('privacy-cover')) return;
  const cover = el('div', { id: 'privacy-cover', class: 'privacy-cover', 'aria-hidden': 'true' },
    el('span', { class: 'privacy-cover-mark serif' }, 'cents.'));
  document.body.append(cover);
}

export function hidePrivacyCover(): void {
  byId('privacy-cover')?.remove();
}

/** Wire the whole thing: the interaction clock, and the cover on hide. */
export function wireIdleLock(lock: () => void): void {
  for (const event of INTERACTIONS) {
    document.addEventListener(event, () => resetIdleLock(lock), { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    // A hidden window is COVERED, never locked. The cover goes up because the
    // app-switcher snapshot is taken while hidden, and comes down on the way
    // back. The lock is the idle clock's business, and it runs either way.
    if (document.visibilityState === 'hidden') installPrivacyCover();
    else hidePrivacyCover();
  });
}
