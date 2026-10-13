/**
 * Cents — Cloudflare Worker.
 *
 * This file only adapts how the functions under netlify/functions/ are hosted.
 * Wrangler bundles those files into this Worker, so the sync proxy, the cloud
 * document store, the reminder push pipeline, the recovery tokens and the
 * profiles admin keep exactly one implementation — the one the site ran on, and
 * the one the guard suite exercises.
 *
 * What Netlify's runtime used to provide, and what replaces it here:
 *
 *   storage    Netlify Blobs, through the same `getStore(name)` call the
 *              functions have always made. It is a KV namespace now
 *              (CENTS_KV), handed to lib/store.mjs through the injection point
 *              that file already documented for hosts other than Netlify; see
 *              lib/kv-store.mjs. No caller changed, and the store's answer to
 *              "is this durable?" — which is what decides whether a profile's
 *              cloud document commits to the primary or falls back to the
 *              GitHub mirror (lib/cloud.mjs) — is still true.
 *
 *   config     Netlify put the project's environment variables and secrets in
 *              process.env; Workers hand them over as bindings. They are copied
 *              onto process.env before any handler runs (nodejs_compat supplies
 *              the object), so the functions still read process.env.APP_PASSWORD
 *              and the rest exactly as they always did.
 *
 *   routing    The paths the frontend already calls, /.netlify/functions/*, are
 *              served from here. Nothing in the browser changed: the app's
 *              reminder and recovery endpoints are DERIVED from the sync
 *              endpoint it is configured with (reminders.js's tickEndpoint,
 *              sync.js's setup-token), which is still the default
 *              /.netlify/functions/sync. `run_worker_first` in wrangler.toml is
 *              scoped to that one prefix, so ordinary page and asset requests
 *              never invoke this Worker at all.
 *
 *   scheduler  There is none. The per-minute cron and the scheduled function it
 *              woke (reminders-send.mjs) were removed on 13 Oct 2026: the cron
 *              never dispatched on this Worker, and the reminder no longer
 *              depends on a platform clock. The job survives unchanged in
 *              lib/reminder-run.mjs and is reached over HTTP by
 *              reminders-tick.mjs, which the app calls when it opens (see
 *              wrangler.toml for how to put an external schedule back).
 *
 * These are Netlify v2 functions — `export default (request, context)` — so the
 * Request is passed straight through and their Response is returned as-is.
 * That also means no response shaping happens here: every CORS header, cache
 * header and status code below is still the function's own.
 */

import syncFunction from './netlify/functions/sync.mjs';
import setupTokenFunction from './netlify/functions/setup-token.mjs';
import remindersPushFunction from './netlify/functions/reminders-push.mjs';
import remindersTickFunction from './netlify/functions/reminders-tick.mjs';
import profilesAdminFunction from './netlify/functions/profiles-admin.mjs';
import { useBlobsModule } from './netlify/functions/lib/store.mjs';
import { kvBlobsModule } from './netlify/functions/lib/kv-store.mjs';

// The five URL-reachable entry points. The paths are written out rather than
// built from a prefix because they are a contract with the browser, not a
// convention: /.netlify/functions/sync is the endpoint settings.js defaults to,
// and every other one is DERIVED from it at runtime (sync.js's setup-token,
// reminders.js's push and tick endpoints). check-worker-config.mjs reads the
// default out of settings.js and requires this table to serve it.
//
// This table is now the whole set: reminders-tick is the only way the reminder
// job is reached (the second entry point, reminders-send.mjs, was the cron's and
// went with the cron). check-worker-config.mjs requires every function file to
// appear here, so an endpoint cannot ship unreachable.
const ROUTES = {
  '/.netlify/functions/sync': syncFunction,
  '/.netlify/functions/setup-token': setupTokenFunction,
  '/.netlify/functions/reminders-push': remindersPushFunction,
  '/.netlify/functions/reminders-tick': remindersTickFunction,
  '/.netlify/functions/profiles-admin': profilesAdminFunction,
};

/**
 * Hand this request's bindings to the code that expects Netlify's shape.
 *
 * Runs before every handler because a Worker isolate is reused across requests
 * and nothing here may depend on a previous request having run.
 */
function wireBindings(env) {
  if (typeof process !== 'undefined' && process.env) {
    for (const [key, value] of Object.entries(env)) {
      // Bindings that are not plain strings (the KV namespace, the assets
      // binding) have no environment variable equivalent: the KV one is wired
      // deliberately below, and ASSETS is only ever used by this file.
      if (typeof value === 'string') process.env[key] = value;
    }
  }
  if (env.CENTS_KV) useBlobsModule(kvBlobsModule(env.CENTS_KV));
}

/** A thrown handler is reported, not described — the same call sync.mjs makes. */
function failed(path, error) {
  console.error(`${path} failed:`, (error && error.stack) || error);
  return new Response(JSON.stringify({ error: 'Unexpected server error', code: 500 }), {
    status: 500,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    // Anything that is not a function path is an asset: the assets layer owns
    // it, including its headers (_headers) and what it refuses to serve.
    if (!handler) return env.ASSETS.fetch(request);

    wireBindings(env);
    try {
      return await handler(request, { waitUntil: promise => ctx.waitUntil(promise) });
    } catch (error) {
      return failed(url.pathname, error);
    }
  },
};
