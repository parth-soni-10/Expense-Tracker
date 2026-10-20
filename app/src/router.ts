/* Hash router for the app shell.
 *
 * The existing app's routes are preserved exactly (docs/URL_CONTRACT.md): the
 * hash carries the screen id and its query — `#add?more=1&type=credit` — and an
 * empty or unknown hash lands on the dashboard. Screen-level filters write the
 * query with replaceState, so Back never steps through a filter change; that is
 * exposed here as `setParams(..., { replace: true })`. */

export const ROUTES = ['dashboard', 'add', 'history', 'balances', 'tesco', 'insights'] as const;
export type RouteId = (typeof ROUTES)[number];

export interface Route {
  id: RouteId;
  params: URLSearchParams;
}

const KNOWN = new Set<string>(ROUTES);

export function isRouteId(value: string): value is RouteId {
  return KNOWN.has(value);
}

export function readRoute(hash = location.hash): Route {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const cut = raw.indexOf('?');
  const path = cut === -1 ? raw : raw.slice(0, cut);
  const query = cut === -1 ? '' : raw.slice(cut + 1);
  return { id: isRouteId(path) ? path : 'dashboard', params: new URLSearchParams(query) };
}

export function routeHash(id: RouteId, params?: URLSearchParams | Record<string, string>): string {
  const query = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params || {}).toString();
  return `#${id}${query ? `?${query}` : ''}`;
}

/** Move to a route. `replace` is for state a screen owns (filters, a folded
 *  form), not for navigation: Back must not step through those. */
export function navigate(id: RouteId, params?: URLSearchParams | Record<string, string>, { replace = false } = {}): void {
  const next = routeHash(id, params);
  if (replace) {
    history.replaceState(history.state, '', next);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (location.hash === next) return;
  location.hash = next;
}

export function subscribe(listener: (route: Route) => void): () => void {
  const onChange = () => listener(readRoute());
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
