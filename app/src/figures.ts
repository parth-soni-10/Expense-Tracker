/* The dashboard's three Hairline read-outs, mounted from typed data.
 *
 * The figures themselves are not rewritten here. `hairline/` in the shipping app
 * is a 28 KB kernel plus one file per figure, all classic scripts that register
 * into a global registry (`HL`, `hairline()`, `mountHairline()`). This shell
 * copies five of those files verbatim into `app/hairline/`
 * (`scripts/check-app-figures.mjs` fails the moment a copy drifts from the
 * source) and loads them with `defer`, exactly as the shipping app loads them.
 *
 * What is deliberately NOT copied is `hairline/figures.js`. That wrapper caches
 * one handle per figure *name* for the life of the page, so once a screen had
 * been re-rendered — which on this dashboard happens on a budget keystroke — the
 * next paint called `set()` on figures whose cards no longer existed. Here the
 * dashboard owns the handles and drops the previous render's before drawing the
 * next, so a re-render repaints rather than writing into detached nodes.
 *
 * Class-only: the kernel's `mk()` writes attributes and nothing else, and the
 * one function that would inject a `<style>` element — `HL.inject` — is never
 * called by these files or by this bridge. The rules the figures need live in
 * `styles.css` (`.hairline-card .sil`, `.nf`, `.dot`, …), mapped onto this
 * app's tokens.
 *
 * A figure that cannot mount must not take the dashboard with it: every failure
 * path here is a `return`, never a throw.
 */

export interface TidePoint {
  date: string;
  balance: number;
}

/** One month's category budget against what it has spent. */
export interface Envelope {
  label: string;
  spent: number;
  limit: number;
}

export interface Receipt {
  title: string;
  amount: number;
  date: string;
}

export interface FigureData {
  /** `computeBalance`'s own points plus today, as the tide columns. */
  balances: TidePoint[];
  envelopes: Envelope[];
  receipts: Receipt[];
}

interface FigureHandle {
  set?: (value: unknown) => void;
  destroy?: () => void;
}

declare global {
  interface Window {
    /** Provided by the vendored `hairline/mount.js`. Undefined when the figure
     *  scripts did not load, which is a dashboard without figures, not an error. */
    mountHairline?: (hostId: string, value: unknown, name: string) => FigureHandle | null;
  }
}

/** The host ids are the shipping app's, so the same figure and the same host
 *  cannot drift apart between the two shells. */
export const HOSTS = [
  { id: 'cents-balance-tide', name: 'balance-tide', key: 'balances' },
  { id: 'cents-envelope-garden', name: 'envelope-garden', key: 'envelopes' },
  { id: 'cents-receipt-constellation', name: 'receipt-constellation', key: 'receipts' },
] as const satisfies ReadonlyArray<{ id: string; name: string; key: keyof FigureData }>;

let mounted: FigureHandle[] = [];

/** Drop what the last render mounted. The nodes are already gone; this exists so
 *  the figures' pointer handlers and springs go with them instead of
 *  accumulating one set per budget keystroke. */
export function releaseFigures(): void {
  for (const handle of mounted) {
    try {
      handle.destroy?.();
    } catch {
      /* disposal is housekeeping: a figure that cannot clean up still must not
         stop the screen from drawing. */
    }
  }
  mounted = [];
}

/** Draw the three figures into the dashboard's hosts. Returns how many drew, so
 *  a caller can tell "the kernel never loaded" from "there was nothing to draw". */
export function paintFigures(data: FigureData): number {
  releaseFigures();
  const mount = window.mountHairline;
  if (typeof mount !== 'function') return 0;
  let drawn = 0;
  for (const host of HOSTS) {
    // The dashboard hands its root to `main.ts`, which appends it: a figure host
    // that is not in the document yet is a paint that should not happen.
    if (!document.getElementById(host.id)) continue;
    const handle = mount(host.id, data[host.key], host.name);
    if (!handle) continue;
    mounted.push(handle);
    drawn += 1;
  }
  return drawn;
}
