#!/usr/bin/env node
/**
 * The installed-app contract: what makes an installed copy behave like an app
 * rather than a web page in a window.
 *
 * Four of these are behaviours a Node guard cannot run (they live in app.js,
 * which touches the DOM on evaluation) so those are pinned against source text —
 * the technique scripts/test-motion.mjs uses for paintFigure and
 * scripts/test-integrity.mjs for the method pickers. The rest are real
 * assertions against real files: manifest.json is parsed, every icon and
 * screenshot it names is opened and its declared size is compared with the size
 * the PNG header actually says, and every shortcut and share target route is
 * checked against seed.js's own TABS rather than a copy of that list.
 *
 * Why it exists at all: every one of these fails SILENTLY in production.
 *  - a manifest that still parses but has lost `scope`/`id` installs as a
 *    browser tab, and nothing in the app can tell;
 *  - a shortcut pointing at a route that no longer exists opens a blank screen
 *    from a long-press, with no app code involved to notice;
 *  - an icon whose `sizes` lies is accepted everywhere and looks wrong only on
 *    the launcher;
 *  - Android's back gesture closing a sheet is invisible until the day a sheet
 *    traps the user — and the lock screen being closable by it is a security
 *    hole that reads like a convenience;
 *  - pull-to-refresh reloading the app mid-scroll is a one-line CSS omission.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const has = (rel) => existsSync(join(root, rel));

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; return; }
  failures.push(detail ? `${name} — ${detail}` : name);
};
const fail = (name, detail = '') => check(name, false, detail);

const manifest = JSON.parse(read('manifest.json'));
const appSource = read('app.js');
const css = read('styles.css');
const toml = read('netlify.toml');
const { TABS } = await import('../seed.js');

// ---------------------------------------------------------------- 1. identity
// An installed app's identity is `id` + `scope` + `start_url`. Without `id` a
// browser derives one from start_url and can install a SECOND copy the day the
// start URL changes; without `scope` every URL counts as in-scope, which is how
// a navigation ends up in a tab with a URL bar.
for (const key of ['id', 'name', 'short_name', 'description', 'start_url', 'scope', 'display', 'orientation', 'categories', 'background_color', 'theme_color', 'icons']) {
  check(`the manifest declares ${key}`, manifest[key] !== undefined);
}
check('the identity, start url and scope are the app root',
  manifest.id === '/' && manifest.start_url === '/' && manifest.scope === '/',
  `${manifest.id} / ${manifest.start_url} / ${manifest.scope}`);
check('it installs with no browser chrome', manifest.display === 'standalone', String(manifest.display));
check('and declares a fallback for a platform that cannot do standalone',
  Array.isArray(manifest.display_override) && manifest.display_override[0] === 'standalone',
  JSON.stringify(manifest.display_override));
check('the splash and status bar use the app background',
  manifest.background_color === '#101210' && manifest.theme_color === '#101210',
  `${manifest.background_color} / ${manifest.theme_color}`);
check('the description is short enough to survive an install prompt',
  typeof manifest.description === 'string' && manifest.description.length > 20 && manifest.description.length <= 320,
  String(manifest.description?.length));
check('it is a finance app as far as a store listing is concerned',
  Array.isArray(manifest.categories) && manifest.categories.includes('finance'),
  JSON.stringify(manifest.categories));
// Portrait-first: the layout is designed vertically, and an installed copy that
// rotates mid-entry is the one way it reflows into a state nobody has looked at
// on a phone.
check('the installed app is portrait', manifest.orientation === 'portrait', String(manifest.orientation));

// ------------------------------------------------- 2. icons that are really there
/** The PNG header's own width/height, so a declared `sizes` cannot lie. */
function pngSize(src) {
  const buf = readFileSync(join(root, String(src).replace(/^\//, '')));
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
const declaredSize = (entry) => {
  const [w, h] = String(entry.sizes || '').split('x').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
};
const everyImage = [
  ...(manifest.icons || []),
  ...(manifest.screenshots || []),
  ...(manifest.shortcuts || []).flatMap(s => s.icons || []),
];
check('the manifest names at least one icon', (manifest.icons || []).length > 0);
for (const src of [...new Set(everyImage.map(entry => entry.src))]) {
  check(`${src} is in the checkout`, has(String(src).replace(/^\//, '')));
}
for (const icon of [...(manifest.icons || []), ...(manifest.screenshots || [])]) {
  if (!has(String(icon.src).replace(/^\//, ''))) continue; // reported above
  const size = declaredSize(icon);
  const actual = pngSize(icon.src);
  check(`${icon.src} is a PNG of the size it claims (${icon.sizes})`,
    !!size && !!actual && size.w === actual.w && size.h === actual.h,
    actual ? `file is ${actual.w}x${actual.h}` : 'not a PNG');
}
check('there is a 512 maskable icon, which is what Android draws the launcher from',
  (manifest.icons || []).some(i => i.sizes === '512x512' && String(i.purpose).includes('maskable')));
check('and a 512 any-purpose icon, which is what the install UI and splash use',
  (manifest.icons || []).some(i => i.sizes === '512x512' && String(i.purpose).includes('any')));

// ------------------------------------------------------------- 3. screenshots
// Chrome only offers the richer install UI when a screenshot exists, and picks
// one by form factor — so the form factor has to be stated, not guessed.
check('the manifest carries at least one screenshot', (manifest.screenshots || []).length > 0);
for (const shot of manifest.screenshots || []) {
  check(`screenshot ${shot.src} states a form factor`,
    shot.form_factor === 'narrow' || shot.form_factor === 'wide', String(shot.form_factor));
}

// ------------------------------------------- 4. shortcuts point at real routes
// A long-press shortcut opens its URL directly, with no app code between the tap
// and the screen — so a route that was renamed leaves a dead launcher entry that
// nothing else in the repo would catch. TABS is the router's own list.
check('there is at least one launcher shortcut', (manifest.shortcuts || []).length > 0);
for (const shortcut of manifest.shortcuts || []) {
  const name = shortcut.short_name || shortcut.name;
  check(`shortcut "${name}" has a short name fit for a launcher`,
    typeof shortcut.short_name === 'string' && shortcut.short_name.length <= 12, String(shortcut.short_name));
  const match = /^\/#([a-z]+)$/.exec(shortcut.url || '');
  check(`shortcut "${name}" targets an in-scope hash route (${shortcut.url})`, !!match);
  check(`shortcut "${name}" targets a route the router actually has`,
    !!match && TABS.includes(match[1]), match ? `${match[1]} not in TABS [${TABS.join(', ')}]` : String(shortcut.url));
}

// ----------------------------------------------------------- 5. share target
const target = manifest.share_target;
check('the app registers a share target', !!target);
if (target) {
  const route = /^\/#([a-z]+)$/.exec(target.action || '');
  check('the share target opens a real route', !!route && TABS.includes(route[1]), String(target.action));
  check('it takes the share over a GET, so no service worker has to intercept a POST',
    target.method === 'GET', String(target.method));
  check('and it accepts a title, text and url',
    target.params?.title === 'title' && target.params?.text === 'text' && target.params?.url === 'url',
    JSON.stringify(target.params));
}

// -------------------------------------------------- 6. the app reads that share
// The params arrive as a query ahead of the #add fragment, so the reader has to
// look in location.search — not in the hash, which is where every other part of
// this app reads its state from.
// Scoped to the reader's own body: `location.search` appears elsewhere in the
// file, so a bare "does the app touch location.search" check would pass even if
// the reader itself had been pointed at the hash.
const shareBlock = appSource.match(/function readSharedText\(\) \{[\s\S]*?\n\}/);
check('the shared text is read out of the query string, in the reader itself',
  !!shareBlock
  && /new URLSearchParams\(location\.search\)/.test(shareBlock[0])
  && /\['title', 'text', 'url'\]/.test(shareBlock[0])
  && /if \(!text\) return;/.test(shareBlock[0]),
  shareBlock ? 'reader found but not reading the query' : 'no readSharedText()');
check('the shared line is handed to the Magic entry, not stored',
  /magicInput\.value = shared;/.test(appSource) && /renderMagicPreview\(shared\)/.test(appSource));
// One session slot, and the three lines that consume it all live inside the Add
// screen: the app can be locked when the share arrives, so the screen — and the
// box the text goes into — may not exist until the user unlocks it.
const addScreenAt = appSource.indexOf('function screenAdd');
const consumedAt = appSource.lastIndexOf('pendingShare = null;');
check('the shared line is consumed in the Add screen, not on the way in',
  addScreenAt > 0 && consumedAt > addScreenAt
  && (appSource.match(/let pendingShare = null;/g) || []).length === 1
  && /if \(pendingShare\) \{/.test(appSource)
  && appSource.indexOf('magicInput.value = shared;') > addScreenAt,
  `slot(s): ${(appSource.match(/let pendingShare = null;/g) || []).length}, guarded: ${/if \(pendingShare\) \{/.test(appSource)}`);
check('the query is dropped from the address, so a reload cannot re-prefill it',
  /history\.replaceState\(history\.state, '', location\.pathname \+ location\.hash\)/.test(appSource));

// Both are installed at boot, once — counted as CALLS rather than as mentions of
// the name, because prose that cites either one as the pattern to follow is not
// an installation. (A raw name count is what broke this assertion's twin in
// test-ui-libs the moment the back-gesture block cited wireModalFocusTrap.)
check('the back gesture is installed once, at boot',
  (appSource.match(/^\s*wireBackGesture\(\);/gm) || []).length === 1,
  String((appSource.match(/^\s*wireBackGesture\(\);/gm) || []).length));
check('and the share reader is installed at boot too, before anything renders',
  (appSource.match(/^\s*readSharedText\(\);/gm) || []).length === 1,
  String((appSource.match(/^\s*readSharedText\(\);/gm) || []).length));

// --------------------------------------- 7. the back gesture closes a sheet
// One observer, not twenty hooks: a sheet added later is covered without anyone
// remembering to ask — the same reason wireModalFocusTrap exists.
const backBlock = appSource.match(/function wireBackGesture\(\) \{[\s\S]*?\n\}/);
check('the back gesture is wired from one place', !!backBlock);
if (backBlock) {
  check('it watches the body for a sheet appearing rather than every call site',
    /new MutationObserver\(/.test(backBlock[0])
    && /\.observe\(document\.body, \{ childList: true \}\)/.test(backBlock[0]));
  check('and covers a sheet that was already open when it was installed',
    /document\.querySelectorAll\(BACK_SURFACE_SELECTOR\)/.test(backBlock[0]));
}
check('a popstate closes the top sheet',
  /addEventListener\('popstate'/.test(appSource)
  && /closeTopBackSurface\(\)/.test(appSource)
  && /backSurfaces\(\)\.pop\(\)/.test(appSource));
check('it closes through exits a sheet already has (Escape, then its own backdrop)',
  /dispatchEvent\(new KeyboardEvent\('keydown', \{ key: 'Escape'/.test(appSource)
  && /if \(top\.isConnected\) top\.click\(\)/.test(appSource));
// The lock is a .modal-bg like any other, so this exemption is the difference
// between a convenience and a security hole.
check('the lock screen can never be dismissed by back',
  /classList\.contains\('pin-lock-bg'\)/.test(appSource));
check('onboarding is exempt, so a stray back press cannot abandon first-run setup',
  /classList\.contains\('onboarding-bg'\)/.test(appSource));
check('a sheet can opt out, and the profile picker does when it cannot be cancelled',
  /dataset\.noBack === 'true'/.test(appSource)
  && /if \(!cancellable\) bg\.dataset\.noBack = 'true';/.test(appSource));
// The deferred check is the whole reason a sheet that closes itself does not
// undo the navigation it just asked for (the menu's rows close it AND navigate).
check('a self-closed sheet gives its entry back only while that entry is on top',
  /function returnBackEntry\(\) \{[\s\S]{0,300}setTimeout\(/.test(appSource)
  && /history\.state\?\.centsSurface/.test(appSource)
  && /history\.back\(\)/.test(appSource));
check('and back never spends a press with nothing to close',
  /if \(!closeTopBackSurface\(\)\) backDepth\+\+;/.test(appSource));
check('the sheet selector names the two surfaces the app actually mounts',
  /const BACK_SURFACE_SELECTOR = '\.modal-bg, \.menu-backdrop';/.test(appSource));
check('the guest list covers every .modal-bg surface the app mounts',
  // Nineteen sites append one; the two exemptions above are the only ones that
  // may be skipped, so a count that drops means a surface lost its coverage.
  (appSource.match(/class: 'modal-bg/g) || []).length >= 19,
  String((appSource.match(/class: 'modal-bg/g) || []).length));

// ------------------------------------- 8. no web-page tells on a touch screen
// `none` on both axes: no pull-to-refresh (Chrome reloads the app mid-scroll) and
// no two-finger back-swipe racing the cards' own swipe-to-dismiss. It turns off
// overscroll CHAINING only — in-page scrolling is untouched — which is why it
// belongs on html/body rather than on the scroll containers.
check('the page cannot be pull-to-refreshed or swiped into a history navigation',
  /html, body \{ overscroll-behavior: none; \}/.test(css));
check('in-page scroll containers still contain their own overscroll',
  /overscroll-behavior: contain;/.test(css));
check('taps have no grey flash and no double-tap zoom delay',
  /-webkit-tap-highlight-color: transparent/.test(css) && /touch-action: manipulation/.test(css));
check('the app chrome cannot be text-selected by a long press',
  /-webkit-user-select: none; user-select: none;/.test(css));
check('the layout uses the dynamic viewport unit, so a keyboard cannot break it',
  /100dvh/.test(css));

// ------------------------------- 9. the dot-path a deploy has to serve
// /.well-known/ is where Digital Asset Links can live, and it is the one
// dot-directory a CDN does serve — so it needs its own rule. The rule exists
// before the file does, which is the point: dropping the file in is then the
// whole step.
check('the deploy serves /.well-known/ as JSON',
  /for = "\/\.well-known\/\*"[\s\S]{0,200}?Content-Type = "application\/json/.test(toml));
check('with a revalidating cache, so a corrected fingerprint is not cached for a day',
  /for = "\/\.well-known\/\*"[\s\S]{0,260}?Cache-Control = "no-cache, must-revalidate"/.test(toml));
if (has('.well-known/assetlinks.json')) {
  const links = JSON.parse(read('.well-known/assetlinks.json'));
  const entry = Array.isArray(links) ? links[0] : null;
  check('assetlinks.json delegates link handling to the app package',
    Array.isArray(entry?.relation) && entry.relation.includes('delegate_permission/common.handle_all_urls'),
    JSON.stringify(entry?.relation));
  check('it names a package and at least one signing fingerprint',
    !!entry?.target?.package_name
    && Array.isArray(entry.target.sha256_cert_fingerprints)
    && entry.target.sha256_cert_fingerprints.length > 0,
    JSON.stringify(entry?.target));
  check('and every fingerprint is a colon-separated SHA-256',
    (entry?.target?.sha256_cert_fingerprints || []).every(fp => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(fp).toUpperCase())),
    JSON.stringify(entry?.target?.sha256_cert_fingerprints));
} else {
  pass++; // nothing to check yet, and part 9's rule is what makes dropping one in safe
}

// ---------------------------------------------------------------- report
if (failures.length) {
  console.error(`check-app-shell: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`check-app-shell: OK — ${pass} assertions passed (an installed copy is identified, sized, `
  + 'reachable from a long-press, reachable from a share, and cannot be pull-to-refreshed or trapped by its own sheets)');
