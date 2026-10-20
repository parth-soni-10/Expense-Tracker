#!/usr/bin/env node
/**
 * Stage the cutover app for a Pages upload.
 *
 *   node tools/build-app.mjs [--out .pages-dist]
 *
 * `app/` becomes the document root. The things it reads but does not own are
 * copied in beside it — the crawl files — because the Pages upload is one
 * directory and a relative path has to resolve inside it. Dropping the crawl
 * files would have been a silent SEO regression: the old root app served
 * them, and a cutover that forgets them is a site that stops being crawlable
 * while every page still renders.
 *
 * The root `_headers` and the root `404.html` are deliberately NOT copied:
 * `app/_headers` is the new policy (deploy-pages keeps a staged `_headers` as
 * a directive), and the shared stager generates a CSP-safe 404 when the assets
 * carry none. The root `_headers` stays in the repository as the rollback's
 * policy — reverting the build command must bring the old app's headers back
 * with it, not leave the old app bare.
 *
 * `--sw-cache` ties the worker's cache name to the staged bytes, so every
 * deploy supersedes the previous offline cache. The shell's cache is named
 * `cents-app-v<N>` in the source; the stager rewrites it to
 * `cents-app-v<N>-<content hash>` in the staged copy only, so the source
 * keeps a readable name and the deployed one is fresh by construction.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outIndex = process.argv.indexOf('--out');
const out = resolve(repo, outIndex >= 0 ? process.argv[outIndex + 1] : '.pages-dist');

// The shell's cache name, read from the source. It is the token the shared
// stager rewrites into the staged copy.
const swSource = await import('node:fs').then((fs) => fs.readFileSync(join(repo, 'app', 'sw.js'), 'utf8'));
const swCache = /const CACHE = '(cents-app-v\d+)'/.exec(swSource)?.[1];
if (!swCache) throw new Error('build-app: app/sw.js does not name a cents-app-v<N> cache');

// The bundle is what the document loads, so it has to exist before the
// upload is staged. A build that failed must fail HERE, not on the host.
//
// `npm run build` is the ONE definition of the build, so it is run rather
// than re-implemented — but on Windows `npm` is a batch file, and a batch
// file cannot be spawned directly, so the shell is used there and only there.
const isWindows = process.platform === 'win32';
execFileSync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: join(repo, 'app'),
  stdio: 'inherit',
  shell: isWindows,
});

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

execFileSync(process.execPath, [
  join(repo, 'tools', 'deploy-pages.mjs'),
  '--assets', join(repo, 'app'),
  '--out', out,
  '--sw-cache', swCache,
], { stdio: 'inherit' });

// The crawl files. They are served by the old root app, so a cutover that
// drops them is a site that stops being crawlable while every page renders.
for (const file of ['robots.txt']) {
  const from = join(repo, file);
  if (!existsSync(from)) throw new Error(`build-app: ${file} is part of the published site but is missing from the repository root`);
  await cp(from, join(out, file));
}

// The Workers/Functions router is not part of the upload — Pages compiles
// `functions/` from the repository — but a copy of the staging list is useful
// when someone asks what the deploy actually contained.
const files = (await readdir(out, { withFileTypes: true })).map((entry) => entry.name).sort();
console.log(`build-app: staged ${files.length} top-level entries in ${out}`);
console.log(`build-app: the worker's cache is tied to the staged bytes (${swCache}-<hash>)`);
