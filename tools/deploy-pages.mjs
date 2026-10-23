#!/usr/bin/env node
/**
 * Stage the directory a `wrangler pages deploy` should upload.
 *
 *   node tools/deploy-pages.mjs --assets <dir> --out <dir>
 *
 * ONE FILE, SEVEN REPOSITORIES. This exact file is committed in the same
 * `tools/` path of every Pages site in this collection, and the copies are
 * checked against this one — the workspace's `pages-ci/deploy-pages.mjs` is the
 * source, and `pages-ci/check-shared-tools.mjs` fails if any copy has drifted.
 * That check exists because the copies already drifted once: by 16 Oct 2026 there
 * were three dialects of this script — one with a `--bundle` flag, one that tied
 * a service worker's cache name to the staged output, one that generated the 404
 * as a linked stylesheet — and each dialect was a fix the other copies did not
 * have. All three are here now. Change one copy and change them all, or the check
 * will say which one is behind.
 *
 * Why this exists. Cloudflare Pages uploads whatever directory it is handed and
 * serves it, and — unlike the Workers static-assets layer — it reads no ignore
 * file. Measured, not assumed: a probe deployment whose `.assetsignore` listed
 * `secret.txt` still answered 200 for `/secret.txt`, `.assetsignore` itself
 * included. So the repository's own `.assetsignore` is applied here, before the
 * upload, which makes what reaches the host exactly what the repository says is
 * published.
 *
 * The function half of the site is deliberately not part of this: it lives in
 * `functions/`, which Pages compiles from the repository (`functions/[[path]].js`
 * is the catch-all route). An upload needs no `_worker.js` and no bundle step —
 * that file was how a Workers module reached a Pages deployment, and there is no
 * Worker here any more. `--bundle` remains for the one repository that still has
 * a Workers-shaped build to hand over.
 *
 * `_headers` / `_redirects` / `_routes.json` are always kept: the platform
 * consumes those as directives, it does not serve them as files. A `404.html` is
 * generated when the assets have none, because without one Pages answers 200
 * with index.html for every unmatched path — which makes an unknown path
 * indistinguishable from a real page. The generated page links a same-origin
 * `404.css` rather than carrying a `<style>` block: five of these sites send
 * `style-src 'self'` with no 'unsafe-inline', so an inline block was dropped and
 * the generated 404 rendered as bare markup on exactly the sites that needed it
 * most. (Every repository now carries its own 404.html, so this branch is a
 * fallback — but a fallback that has to be correct.)
 *
 * Flags:
 *   --assets <dir>        the directory to stage (required)
 *   --out <dir>           where the staged upload goes (required)
 *   --bundle <dir>        copy that directory's single bundled .js in as
 *                         `_worker.js` (Workers output staged for a Pages
 *                         deployment). Only passed by the repository that has one.
 *   --sw-cache <token>    tie a service worker's cache name to the staged
 *                         contents: the token is the cache-name literal in the
 *                         staged `sw.js` (e.g. `dashboard-portal-v1`), and it is
 *                         rewritten to `<token>-<content hash>` so every deploy
 *                         activates a fresh cache without touching the worker's
 *                         offline strategy. Opt-in, because a site whose worker
 *                         manages its own versioning must not have a second
 *                         scheme applied over the top of it.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const flags = { assets: null, out: null, bundle: null, "sw-cache": null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i].replace(/^--/, "");
  if (!(key in flags)) {
    console.error(`deploy-pages: unknown option ${argv[i]}`);
    process.exit(2);
  }
  flags[key] = argv[i + 1];
  i += 1;
}
if (!flags.assets || !flags.out) {
  console.error(
    "usage: node tools/deploy-pages.mjs --assets <dir> --out <dir> [--bundle <dir>] [--sw-cache <token>]"
  );
  process.exit(2);
}

const assets = resolve(flags.assets);
const out = resolve(flags.out);
const bundle = flags.bundle ? resolve(flags.bundle) : null;
const swCacheToken = flags["sw-cache"] || null;

// Directives the platform reads from the upload rather than serving as files.
const HONOURED_FILES = new Set(["_headers", "_redirects", "_routes.json"]);
// Never uploaded, whatever a repository's rules say: version control, caches,
// the staging directories themselves, and the two things that must never be
// published — the Workers-only ignore file, and local secret files.
const ALWAYS_SKIP = new Set([
  ".git", "node_modules", ".freebuff", ".wrangler", ".kilo", ".pytest_cache", "__pycache__",
  // Version control's own files: a repository that does not think to list them is
  // exactly how `.gitattributes` reaches a published site (measured: the UCD
  // upload carried one).
  ".assetsignore", ".gitignore", ".gitattributes", ".gitmodules",
  ".netlifyignore", ".dev.vars", ".env", ".env.local", ".pages-bundle", ".pages-dist",
]);

/** `.assetsignore` rules, reduced to what these repositories use. */
function matcher(patterns) {
  const rules = patterns
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((pattern) => {
      const dir = pattern.endsWith("/");
      const bare = pattern.replace(/\/$/, "");
      const glob = bare.includes("*")
        ? new RegExp(
            "^" +
              bare
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*\*/g, ".*")
                .replace(/\*/g, "[^/]*") +
              "$"
          )
        : null;
      return { dir, bare, glob };
    });
  return (relPath, name, isDir) => {
    for (const rule of rules) {
      const hit = rule.glob
        ? rule.glob.test(name) || rule.glob.test(relPath)
        : name === rule.bare ||
          relPath === rule.bare ||
          (rule.dir && relPath.startsWith(rule.bare + "/"));
      if (hit) return true;
    }
    return isDir && ALWAYS_SKIP.has(name);
  };
}

const ignorePath = join(assets, ".assetsignore");
const isIgnored = matcher(
  existsSync(ignorePath) ? (await readFile(ignorePath, "utf8")).split("\n") : []
);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const copied = [];
const skipped = [];
async function walk(dir, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const full = join(dir, item.name);
    if (resolve(full) === out) continue;
    const honoured = HONOURED_FILES.has(item.name) && !item.isDirectory();
    if (!honoured && (ALWAYS_SKIP.has(item.name) || isIgnored(rel, item.name, item.isDirectory()))) {
      skipped.push(rel + (item.isDirectory() ? "/" : ""));
      continue;
    }
    if (item.isDirectory()) {
      await mkdir(join(out, rel), { recursive: true });
      await walk(full, rel);
    } else {
      await cp(full, join(out, rel));
      copied.push(rel);
    }
  }
}
await walk(assets);

// Workers output handed in for the `_worker.js` slot, for the one repository that
// still builds one. Exactly one .js is expected; anything else is a build mistake
// worth stopping for rather than guessing which file was meant.
let workerFrom = null;
if (bundle) {
  if (!existsSync(bundle)) {
    console.error(`deploy-pages: bundle directory not found: ${bundle}`);
    process.exit(2);
  }
  const entries = (await readdir(bundle, { withFileTypes: true })).filter(
    (e) => e.isFile() && e.name.endsWith(".js")
  );
  if (entries.length !== 1) {
    console.error(
      `deploy-pages: expected exactly one bundled .js in ${bundle}, found ${entries.length}` +
        (entries.length ? `: ${entries.map((e) => e.name).join(", ")}` : "")
    );
    process.exit(2);
  }
  workerFrom = entries[0].name;
  await cp(join(bundle, workerFrom), join(out, "_worker.js"));
  copied.push(`_worker.js (from ${workerFrom})`);
}

if (!existsSync(join(out, "404.html"))) {
  await writeFile(
    join(out, "404.css"),
    `:root { color-scheme: light dark; }\n` +
      `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; color: #e9e9ea;\n` +
      `  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }\n` +
      `main { max-width: 34rem; padding: 2rem; text-align: center; }\n` +
      `h1 { margin: .5rem 0 0; font-size: 1.375rem; }\n` +
      `p { margin: .75rem 0 0; color: #9aa2ae; }\n` +
      `a { color: #6cc79a; }\n`,
    "utf8"
  );
  await writeFile(
    join(out, "404.html"),
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<meta name="robots" content="noindex">\n<title>Not found</title>\n` +
      `<link rel="stylesheet" href="/404.css">\n</head>\n` +
      `<body><main><h1>Nothing here</h1><p><a href="/">Back to the site</a></p></main></body>\n</html>\n`,
    "utf8"
  );
  copied.push("404.html (generated)", "404.css (generated)");
}

// Tie the service worker's cache name to the staged contents, so every deploy
// activates a fresh cache without changing the worker's offline strategy. The
// hash covers everything except the worker itself, sorted, so it depends on the
// upload rather than on the order the filesystem handed the files over.
if (swCacheToken) {
  const swPath = join(out, "sw.js");
  if (!existsSync(swPath)) {
    console.log(`  note:      --sw-cache ${swCacheToken} given but the upload has no sw.js`);
  } else {
    const names = (await readdir(out, { recursive: true }))
      .filter((name) => !name.endsWith("sw.js"))
      .sort();
    const digest = createHash("sha256");
    for (const name of names) {
      const path = join(out, name);
      try {
        digest.update(name);
        digest.update(await readFile(path));
      } catch (_) { /* directories are skipped */ }
    }
    const source = await readFile(swPath, "utf8");
    const base = swCacheToken.replace(/-v\d+$/, "");
    const next = `${base}-${digest.digest("hex").slice(0, 16)}`;
    if (!source.includes(swCacheToken)) {
      console.log(`  note:      --sw-cache token ${swCacheToken} is not in the staged sw.js`);
    } else {
      await writeFile(swPath, source.split(swCacheToken).join(next), "utf8");
      copied.push(`sw.js (cache name -> ${next})`);
    }
  }
}

const indexPresent = existsSync(join(out, "index.html"));
console.log(`deploy-pages: ${assets} -> ${out}`);
console.log(`  uploaded ${copied.length} file(s)${indexPresent ? "" : "  ⚠ no index.html"}`);
if (workerFrom) console.log(`  server:   _worker.js from ${bundle}/${workerFrom}`);
for (const s of skipped) console.log(`  left out  ${s}`);
process.exit(indexPresent ? 0 : 1);
