/* What every screen is handed: the document it edits, the route's query, the
 * one save path, and a way to redraw itself. Deliberately small — a screen that
 * needs more than this is asking to own something the shell should. */
import type { CentsState } from '../../lib/types.ts';

export interface ScreenContext {
  state: CentsState;
  params: URLSearchParams;
  /** Persist the document; false means storage refused the write. */
  save: () => boolean;
  /** Redraw the current route, keeping focus where the user left it. */
  refresh: () => void;
}
