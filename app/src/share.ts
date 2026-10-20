/* ============================================================
   Text shared into the app from the share sheet.

   The manifest declares a `share_target`, so another app's Share → cents.
   arrives as `?title=…&text=…&url=…` — AHEAD of the `#add` fragment the
   target names, which is why this reads `location.search` and not the hash
   every other part of this app uses.

   Three rules, and each exists because of a way the share could go wrong:

   1. THE TEXT IS NOT STORED. It is put in the **Quick entry**, not kept
      anywhere: the preview names what the line will become, and the user
      still presses Add. Nothing is written to the ledger by a share.

   2. THE QUERY IS DROPPED FROM THE ADDRESS. It is not part of this app's
      address, and dropping it is what stops a reload prefilling the same
      share again — a share that reappears on every reload is a share that
      silently re-adds itself.

   3. IT IS CONSUMED ONCE, and only when the screen exists. The app may
      still be LOCKED when the share lands, so the text is held until the
      Add screen is built — and cleared as it is consumed, so no re-render can
      prefill it twice.
   ============================================================ */

let pendingShare: string | null = null;

/** Read the shared text out of the address and take it out of the address.
 *
 *  GET rather than POST deliberately: a POST with files would need the
 *  service worker to intercept it, and the worker is the one file whose
 *  correctness this project guards most carefully. */
export function readSharedText(): void {
  let text = '';
  try {
    const params = new URLSearchParams(location.search);
    text = ['title', 'text', 'url'].map((key) => params.get(key)).filter(Boolean).join(' ').trim();
  } catch {
    // No URL API: nothing was shared.
    return;
  }
  if (!text) return;
  pendingShare = text;
  // The query is not part of this app's address.
  try { history.replaceState(history.state, '', location.pathname + location.hash); } catch { /* ignore */ }
}

/** The shared text, if one is waiting. It is CLEARED as it is read, so it can
 *  only ever reach the screen once. */
export function takeSharedText(): string | null {
  const text = pendingShare;
  pendingShare = null;
  return text;
}

/** Whether a share is waiting, without consuming it. */
export function hasSharedText(): boolean {
  return pendingShare !== null;
}
