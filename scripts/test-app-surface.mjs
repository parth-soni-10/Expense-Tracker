#!/usr/bin/env node
/**
 * The app's own surfaces: the install manifest, the back gesture, the offline
 * shell, and the deploy-freshness notice.
 *
 * Four parity lines live here:
 *
 *   - docs/CENTS_PARITY.md line 70 — the installable manifest, its icons and
 *     screenshots, the launcher shortcuts and the share target all resolve to
 *     CURRENT routes.
 *   - line 71 — Android's back gesture closes the top sheet without closing
 *     the lock, and pull-to-refresh does not lose a work-in-progress
 *     interaction.
 *   - line 72 — the offline shell and the first-visit behaviour match the
 *     existing service-worker semantics, and the cache is versioned by build
 *     hash.
 *   - line 73 — a deploy is detected on the device and the required
 *     update-available reload action is presented.
 *
 * The manifest is the one that rots quietly. A shortcut pointing at a route
 * that no longer exists is a dead launcher entry, and no app code would ever
 * notice it — so the guard checks every shortcut's hash against the ROUTER's
 * own list, and reads the description to check it does not promise a feature
 * the app has removed. (It did: the roster-photo reader was deleted from the
 * shipping app, and the manifest still told anyone who installed it that they
 * could "read Tesco payslips from a photo of the roster".)
 *
 * The back gesture is the one with a trap in it. A sheet that closes ITSELF
 * has to give its history entry back — but on a LATER task, and only while
 * that entry is still on top, because the same click may have navigated as
 * well, and by then the browser has pushed the navigation entry. Popping the
 * stack then would undo the navigation the user just asked for.
 *
 * Run: node scripts/test-app-surface.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const read = (rel) => readFileSync(resolve(repo, rel), 'utf8');

/* ══ 1. THE MANIFEST RESOLVES TO CURRENT ROUTES ════════════════════════════ */

const manifest = JSON.parse(read('app/manifest.json'));
const routerSource = read('app/src/router.ts');
const routeList = /export const ROUTES = \[([^\]]+)\]/.exec(routerSource);
check('the router declares its routes', !!routeList);
const routes = routeList
  ? [...routeList[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  : [];
check('and there are six of them', routes.length === 6, routes.join(', '));

/** The hash a manifest URL names, if it names one. */
const hashOf = (url) => {
  const m = /#([a-z]+)/i.exec(String(url || ''));
  return m ? m[1] : null;
};

for (const shortcut of manifest.shortcuts || []) {
  const hash = hashOf(shortcut.url);
  check(`the "${shortcut.short_name || shortcut.name}" shortcut names a current route`,
    hash === null || routes.includes(hash), `${shortcut.url} -> ${hash}`);
}
check('there are launcher shortcuts', (manifest.shortcuts || []).length >= 3,
  String((manifest.shortcuts || []).length));

const shareHash = hashOf(manifest.share_target?.action);
check('the share target lands on a current route',
  shareHash === null || routes.includes(shareHash), String(manifest.share_target?.action));
check('and it is the Add screen', shareHash === 'add', String(manifest.share_target?.action));
check('the share target is a GET, so the worker never has to intercept it',
  (manifest.share_target?.method || 'GET') === 'GET', String(manifest.share_target?.method));

// The icons and the screenshot must be really there, at the size they claim.
for (const icon of manifest.icons || []) {
  check(`the icon ${icon.src} exists`, existsSync(resolve(repo, 'app', icon.src.replace(/^\//, ''))));
}
for (const shot of manifest.screenshots || []) {
  check(`the screenshot ${shot.src} exists`, existsSync(resolve(repo, 'app', shot.src.replace(/^\//, ''))));
}

// The description must not promise a feature the app removed.
const description = String(manifest.description || '');
check('the description does not promise the removed roster reader',
  !/roster|photo of the roster/i.test(description), description);
const shortcutText = (manifest.shortcuts || []).map((s) => String(s.description || '')).join(' ');
check('and neither does any shortcut',
  !/roster|photo reader/i.test(shortcutText), shortcutText);
check('the title and the short name agree',
  // The em dash, not a hyphen: an installed window's title bar is composed
  // from the manifest's name, and a hyphen next to an em dash made the
  // browser print BOTH.
  manifest.name === 'cents. — expense tracker' && manifest.short_name === 'cents.',
  `${manifest.name} / ${manifest.short_name}`);
check('and the document title is the manifest\'s name byte for byte',
  /<title>cents\. — expense tracker<\/title>/.test(read('app/index.html')),
  'an installed window would print both names');

/* ══ 2. THE BACK GESTURE ═══════════════════════════════════════════════════ */

const backSource = read('app/src/back-gesture.ts');
check('the gesture is wired at boot', /wireBackGesture\(\);/.test(read('app/src/main.ts')));
check('a sheet owns a history entry', /history\.pushState\(\{ centsSurface: true \}/.test(backSource));
check('and the entry is marked on the sheet', /data-back-entry/.test(backSource));
check('the lock is EXEMPT — a back press must not dismiss it',
  /el\.closest\('#gate'\)/.test(backSource), 'the gate must be exempt');
check('a sheet may opt out with data-no-back',
  /getAttribute\('data-no-back'\) === 'true'/.test(backSource));
check('a self-closed sheet gives its entry back on a LATER task',
  /setTimeout\(\(\) => \{[\s\S]{0,400}history\.back\(\)/.test(backSource),
  'the give-back must be deferred');
check('and only while that entry is still on top',
  /if \(!state \|\| !state\.centsSurface\) return;/.test(backSource),
  'the give-back must check the entry is still ours');
check('the gesture closes the sheet the way a person would — with Escape',
  /KeyboardEvent\('keydown', \{ key: 'Escape'/.test(backSource));
check('and it never spends a press it cannot honour',
  /if \(!closeTopBackSurface\(\)\) backDepth \+= 1;/.test(backSource));

// Pull-to-refresh: the page must not be pullable, or a refresh in the middle
// of a half-typed entry would lose it.
const styles = read('app/styles.css');
check('pull-to-refresh is off', /html, body \{ overscroll-behavior: none; \}/.test(styles),
  'a pull-to-refresh would lose a work-in-progress interaction');

/* ══ 3. THE OFFLINE SHELL MATCHES THE EXISTING SEMANTICS ══════════════════ */

const sw = read('app/sw.js');
const oldSw = read('sw.js');
for (const [name, pattern] of [
  ['install never awaits a precache', /skipWaiting\(\)/],
  ['the shell is warmed in the background, one entry at a time', /SHELL/],
  ['every request is network-first', /no-store|cache: 'no-store'/],
  ['the build baseline has its own cache', /const BUILD_CACHE = 'cents-build'/],
  ['and it outlives the deploy it compares against', /BUILD_KEY/],
]) {
  check(`the new worker keeps the old rule: ${name}`, pattern.test(sw), name);
  check(`  and the old worker has it too`, pattern.test(oldSw), name);
}
check('the new worker sweeps the old caches on activate', /activate/.test(sw));
check('and it does NOT sweep the build cache', !/caches\.delete\(BUILD_CACHE\)/.test(sw),
  'the baseline has to outlive the deploy it compares against');

// The cache is versioned by BUILD HASH at the cutover, and the source keeps a
// readable name.
check('the source names a readable cache', /const CACHE = 'cents-app-v\d+'/.test(sw));
const stager = read('tools/build-app.mjs');
check('the stager ties the deployed cache to the staged bytes',
  /--sw-cache/.test(stager) && /swCache/.test(stager),
  'the deployed cache must be a function of what was deployed');
check('and it reads the token from the source rather than repeating it',
  /const CACHE = '\(cents-app-v\\d\+\)'/.test(stager));
check('the app directory has its own ignore file', existsSync(resolve(repo, 'app', '.assetsignore')));
const appIgnore = read('app/.assetsignore');
check('which leaves the source out', /src\//.test(appIgnore) && /lib\//.test(appIgnore));
check('and keeps the built bundle in', !/^dist\//m.test(appIgnore));

/* ══ 4. A DEPLOY IS DETECTED, AND THE RELOAD IS OFFERED ═══════════════════ */

check('the worker tells its clients a new build exists',
  /postMessage\(\{ type: 'centsNewBuild'/.test(sw));
check('it measures the served document against a stored baseline',
  /maybeBroadcastBuildChange/.test(sw) && /BUILD_KEY/.test(sw));
const mainSource = read('app/src/main.ts');
check('the shell listens for it', /centsNewBuild/.test(mainSource));
check('and offers a Reload', /'Reload'/.test(mainSource));
check('a first install is SILENT — only a controlled page is told',
  /controlledAtLoad/.test(mainSource),
  'a first visit must not be told to reload');
check('and the notice is a real status line', /role: 'status'/.test(mainSource));

if (failures) {
  console.error(`\ntest-app-surface: ${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`test-app-surface: OK — ${checks} checks (the manifest points at live routes, back closes a sheet and not the lock, the shell matches, and a deploy is noticed)`);
