#!/usr/bin/env node
/**
 * Stage the directory a `wrangler pages deploy` should upload.
 *
 *   node tools/deploy-pages.mjs --assets <dir> --bundle <dir> --out <dir>
 *
 * Why this exists. Cloudflare Pages uploads whatever directory it is handed and
 * serves it, and — unlike the Workers static-assets layer — it reads no ignore
 * file. Measured, not assumed: a probe deployment whose `.assetsignore` listed
 * `secret.txt` still answered 200 for `/secret.txt`. So the repository's own
 * `.assetsignore` is applied here, before the upload, which makes what reaches
 * the host exactly what the repository says is published.
 *
 * `--bundle` is the output directory of `wrangler deploy --dry-run --outdir …`.
 * Its single `.js` file becomes the upload's `_worker.js`, the advanced-mode
 * entry, so the Pages mirror runs the same Worker code as the Worker it mirrors.
 * More than one or none is an error rather than a guess.
 *
 * `_headers` / `_redirects` / `_routes.json` are always kept: the platform
 * consumes those as directives, it does not serve them as files. A `404.html` is
 * generated when the assets have none, because without one Pages answers 200
 * with index.html for every unmatched path — which makes an unknown path
 * indistinguishable from a real page.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const flags = { assets: null, bundle: null, out: null };
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
  console.error("usage: node tools/deploy-pages.mjs --assets <dir> [--bundle <dir>] --out <dir>");
  process.exit(2);
}

const assets = resolve(flags.assets);
const out = resolve(flags.out);
const bundle = flags.bundle ? resolve(flags.bundle) : null;

// Directives the platform reads from the upload rather than serving as files.
const HONOURED_FILES = new Set(["_headers", "_redirects", "_routes.json"]);
// Never uploaded, whatever a repository's rules say: version control, caches,
// the staging directories themselves, and the two things that must never be
// published — the Workers-only ignore file, and local secret files.
const ALWAYS_SKIP = new Set([
  ".git", "node_modules", ".freebuff", ".wrangler", ".kilo", ".pytest_cache", "__pycache__",
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
    join(out, "404.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e9e9ea;font:16px/1.6 system-ui,sans-serif}main{text-align:center;padding:2rem}a{color:inherit}</style>
</head>
<body><main><h1>404</h1><p>Nothing here.</p><p><a href="/">Back to the site</a></p></main></body>
</html>
`,
    "utf8"
  );
  copied.push("404.html (generated)");
}

const indexPresent = existsSync(join(out, "index.html"));
console.log(`deploy-pages: ${assets} -> ${out}`);
console.log(`  uploaded ${copied.length} file(s)${indexPresent ? "" : "  ⚠ no index.html"}`);
if (workerFrom) console.log(`  server:   _worker.js from ${bundle}/${workerFrom}`);
for (const s of skipped) console.log(`  left out  ${s}`);
process.exit(indexPresent ? 0 : 1);
