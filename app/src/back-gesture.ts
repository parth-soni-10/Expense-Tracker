/* ============================================================
   Android's back gesture.

   The back gesture is the phone's most-used control, and on a web app it
   normally leaves the site. The shipping app keeps it INSIDE: a back press
   closes the top sheet, exactly as Escape does, and only leaves the app when
   there is no sheet to close.

   Four rules, and each exists because the obvious implementation loses
   something:

   1. THE LOCK IS NEVER CLOSABLE. The lock is a sheet like any other to the
      gesture, so without an exemption a back press would dismiss the very
      thing that is protecting the ledger. (The new shell's lock is the gate,
      which is not a sheet at all — so it is exempt by construction, and the
      rule is asserted rather than assumed.)

   2. A SHEET THAT CLOSES ITSELF GIVES ITS ENTRY BACK — but only on a LATER
      TASK, and only while that entry is still on top. The same click that
      closed the sheet may have navigated as well, and by then the browser has
      pushed the navigation entry; popping the stack then would undo the
      navigation the user just asked for. So the give-back is deferred, and
      the deferred task checks that the entry it is about to pop is still ours.

   3. THE ONBOARDING OVERLAY IS EXEMPT. A stray press must not walk the user
      out of a half-filled first run. (The new shell has no onboarding overlay;
      the rule is kept because the exemption is about the OVERLAY, not about a
      particular screen.)

   4. `data-no-back` OPTS OUT, and it pushes NO entry at all — so back keeps
      its old meaning for that surface. The profile picker uses it: it is the
      gate, and dismissing it would leave nowhere to go.

   Every sheet owns its own exit, so nothing here needs to know how any
   particular sheet shuts: the gesture presses Escape, and the sheet's own
   handler does the rest.
   ============================================================ */

/** The sheets that own a history entry. The new shell's sheets are real
 *  `<dialog>` elements, so a sheet is a dialog that is OPEN. */
const SURFACE_SELECTOR = 'dialog[open]';

/** Sheets that own a history entry, in DOM order — the last is the topmost. */
const backSurfaces = (): HTMLElement[] =>
  Array.from(document.querySelectorAll(`${SURFACE_SELECTOR}[data-back-entry]`)) as HTMLElement[];

/** How many entries of ours are on the history stack. */
let backDepth = 0;
/** Pops this file caused itself, to be ignored. */
let backMine = 0;

/** Surfaces the gesture may not close. */
function backExempt(el: Element): boolean {
  if (el.getAttribute('data-no-back') === 'true') return true;
  // The lock and the profile picker live in the gate, which is not a sheet —
  // but a sheet mounted INSIDE the gate would be, so the exemption is by
  // ancestry as well as by attribute.
  if (el.closest('#gate')) return true;
  return false;
}

function pushBackEntry(el: HTMLElement): void {
  el.setAttribute('data-back-entry', '1');
  backDepth += 1;
  try {
    history.pushState({ centsSurface: true }, '');
  } catch {
    // No history API: no gesture. The sheet still opens and closes normally.
    backDepth -= 1;
    el.removeAttribute('data-back-entry');
  }
}

/** Close the topmost sheet the way a person would. Both exits are the sheet's
 *  own, so nothing here needs to know how any particular sheet shuts. */
function closeTopBackSurface(): boolean {
  const top = backSurfaces().pop();
  if (!top) return false;
  // A `<dialog>` closes on Escape through its own machinery; the event is
  // dispatched so the sheet's own handler runs exactly as it would for a
  // person pressing the key.
  top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (typeof (top as any).close === 'function' && top.isConnected) (top as any).close();
  return true;
}

/** Give a self-closed sheet's entry back — but only if it is still on top, and
 *  on a later task, because the same click may have navigated. */
function returnBackEntry(): void {
  setTimeout(() => {
    if (backDepth <= 0) return;
    const state = history.state as any;
    if (!state || !state.centsSurface) return;
    backDepth -= 1;
    backMine += 1;
    history.back();
  }, 0);
}

/** Wire the gesture. Call it once, at boot. */
export function wireBackGesture(): void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const el of [node, ...node.querySelectorAll(SURFACE_SELECTOR)]) {
          if (!el.matches(SURFACE_SELECTOR) || backExempt(el) || el.getAttribute('data-back-entry')) continue;
          pushBackEntry(el as HTMLElement);
        }
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        // A sheet can be removed as part of a larger subtree, so every entry
        // it held has to be given back — one return per marked element, not
        // per removed node.
        if (node.getAttribute('data-back-entry')) returnBackEntry();
        for (let i = node.querySelectorAll('[data-back-entry]').length; i > 0; i -= 1) returnBackEntry();
      }
    }
  });
  observer.observe(document.body, { childList: true });

  // A sheet already open when this is installed still owns its entry.
  for (const el of document.querySelectorAll(SURFACE_SELECTOR)) {
    if (!backExempt(el) && !el.getAttribute('data-back-entry')) pushBackEntry(el as HTMLElement);
  }

  window.addEventListener('popstate', () => {
    if (backMine > 0) { backMine -= 1; return; }
    if (backDepth <= 0) return;
    backDepth -= 1;
    // Nothing to close: not our press to spend, so the depth is put back and
    // the browser is left where it was.
    if (!closeTopBackSurface()) backDepth += 1;
  });
}

/** How many entries of ours are on the history stack. The a11y harness and the
 *  browser leg read it to say whether the gesture is armed. */
export function backEntryDepth(): number {
  return backDepth;
}
