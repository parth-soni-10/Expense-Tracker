/* ---------------------------------------------------------------------------
 * The Pages Function this app is served by.
 *
 * Pages is this site's only host. `functions/[[path]].js` is the catch-all
 * route, so every request arrives here, and the router it imports -
 * `_router.js` - does the work: it answers the two spellings of each of the
 * five endpoints (`/api/*`, which the app defaults to, and the pre-rename
 * `/.netlify/functions/*`, which a device set up before the rename still has
 * saved), wiring this request's bindings into the shape those functions expect,
 * and hands everything else to `env.ASSETS`.
 *
 * This replaced a `run_worker_first` pattern. As a Worker, the handler was
 * invoked only for the two endpoint prefixes and the assets layer answered
 * everything else; as a Pages Function the whole request surface belongs to it,
 * which is why the fall-through in `_router.js` is the routing contract rather
 * than an optimisation.
 *
 * Why two files rather than one: Pages compiles every file in this directory as
 * a route, and only the entry needs to be one. `_router.js` carries the
 * underscore prefix Pages treats as private - a module, never a path of its own
 * - so the routing table is exactly the one catch-all below.
 * ------------------------------------------------------------------------ */
import router from './_router.js';

export const onRequest = (context) => router.fetch(context.request, context.env, context);
