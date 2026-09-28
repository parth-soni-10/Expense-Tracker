/* ============================================================
   tour.js — the walk through the app (driver.js).

   One tour, offered from the app menu at any time and started once on a
   genuinely empty app: a welcome, a step on each tab this user actually has, and
   a step on the menu. Nothing in it changes data.

   Two decisions do the work, and both are consequences of this app rebuilding
   itself rather than anything about tours:

     * Every step is anchored on the NAVIGATION, and every element is a FUNCTION
       rather than a node. app.js's render replaces #app wholesale — header and
       tab bar included — on any navigation, so a node captured when the tour
       started would be detached under the highlight a second later. A function is
       re-resolved when its step becomes active, and again on `refresh()`;
     * A step's Next also GOES to a tab, so the tour shows what it is talking
       about instead of describing a screen the user cannot see — and it goes to
       the NEXT step's tab, because the popover that appears after the click is
       the one that describes it. Navigating to the step's own tab instead lands
       you one screen behind: the popover for Insights would open over the Tesco
       tab, which is what the first live run did. The wait is one frame, because
       the nav item is rebuilt in the same render as the screen.

   The hook is `popover.onNextClick`, and that home is not cosmetic. driver.js 1.8
   reads it there — `step.popover.onNextClick`, falling back to the instance config —
   so a hook written on the step itself is silently IGNORED, and the click then runs
   driver's own advance: the popovers walk forward while the screen stays on whatever
   tab the tour was opened from. That is exactly what the first live run did (the
   progress text counted 1 → 4 of 8 with `location.hash` never leaving #history), and
   nothing short of running the real library would have said so — the wiring looked
   right in the source and the harness asserted it. A popover hook also REPLACES the
   advance rather than preceding it (driver's default next is the hook it is
   overriding), which is why each one calls advance() itself; scripts/test-ui-libs.mjs
   now drives a step's hook and asserts both halves of that contract.

   driver.js is fetched on the first tour (25 KB + its 3 KB stylesheet), so a
   session that never asks for it never pays for it, and a tour that cannot be
   fetched says so rather than opening an empty overlay.
   ============================================================ */

// What each tab is for, in the words the tab itself would use. A route with no
// entry here is skipped rather than staged with an empty popover.
const TAB_NOTES = {
  dashboard: { title: 'Dashboard', description: 'Your month at a glance — balance, budget, what is left to spend and where it went.' },
  add: { title: 'New entry', description: 'Log an expense, income or a transfer. The Magic field takes a sentence: “coffee 4.20”.' },
  history: { title: 'History', description: 'Everything you have logged, one month at a time. The search forgives typos.' },
  balances: { title: 'Balances', description: 'What is in each account, card and pocket, with dated checkpoints behind the total.' },
  tesco: { title: 'Tesco Pay', description: 'Log your shifts, read a roster photo, and see what a pay week should land after tax.' },
  insights: { title: 'Insights', description: 'Charts and trends — where the money actually goes, month by month.' },
};
const WELCOME_NOTE = {
  title: 'cents.',
  description: 'A quick look at what is where. Next and Back move through it, Escape stops — nothing here changes your data.',
};
const MENU_NOTE = {
  title: 'The menu',
  description: 'Appearance, your privacy PIN, cloud sync and backups live here — along with this tour, whenever you want it again.',
};

let _active = null;   // the running driver instance; one tour at a time

/** The visible link to a route: the desktop header nav and the phone tab bar both
 *  link to every tab, and driver.js cannot stage an element that is not rendered. */
export function navAnchor(route) {
  const links = [...document.querySelectorAll(`a[href="#${route}"]`)];
  const shown = links.find(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return shown || links[0] || null;
}

function goTo(route) {
  if (location.hash === `#${route}`) return;
  location.hash = route;   // renderRoute owns the swap (and its View Transition)
}

// One frame later, but BOUNDED. The wait is deliberate — the render that follows the
// hash change replaces the node this step was staged on, and the next step resolves
// its own element then — but a frame is not guaranteed to arrive: this app already
// measured a document that could not produce a compositor frame at all (see
// VT_BUDGET in app.js), and a step whose Next is waiting on a frame that never comes
// is a tour frozen on a telephone. So the timeout is the release, and whichever
// arrives first wins.
export const ADVANCE_BUDGET = 250;
function advance() {
  const driver = _active;
  if (!driver) return;
  let done = false;
  let timer = 0;
  const move = () => {
    if (done) return;
    done = true;
    try { driver.moveNext(); } catch { /* the tour was closed in between */ }
  };
  requestAnimationFrame(() => { clearTimeout(timer); move(); });
  timer = setTimeout(move, ADVANCE_BUDGET);
}

/**
 * The steps, in order: the welcome, one per tab the user has, then the menu.
 *
 * Pure apart from the DOM probes inside the element functions, so the harness can
 * pin the order, the copy and the fact that every anchor is resolved lazily —
 * without a browser and without loading driver.js.
 */
export function tourSteps(routes) {
  const list = Array.isArray(routes) ? routes.filter(r => TAB_NOTES[r]) : [];
  // Each hook shows the tab the NEXT popover is about — the welcome hands over to
  // the first tab, a tab step to the next tab, and the last tab step to nothing,
  // because the menu step's anchor is the header button every screen carries.
  const showNext = (route) => { if (route) goTo(route); advance(); };
  return [
    { popover: { ...WELCOME_NOTE, side: 'over', onNextClick: () => showNext(list[0]) } },
    ...list.map((route, i) => ({
      element: () => navAnchor(route),
      popover: { ...TAB_NOTES[route], side: 'bottom', align: 'start', onNextClick: () => showNext(list[i + 1]) },
    })),
    {
      element: () => document.querySelector('.menu-trigger'),
      popover: { ...MENU_NOTE, side: 'bottom', align: 'end' },
    },
  ];
}

/**
 * Run the tour. Resolves with what happened: 'started', 'busy' (one is already
 * open), 'too-few-tabs' (nothing worth touring), or 'unavailable' (driver.js could
 * not be fetched or did not define its factory) — the last of which the caller
 * reports, because a menu row that silently does nothing is worse than one that
 * says why.
 */
export async function startTour({ routes, loadVendor, onEnd = null }) {
  if (_active) return 'busy';
  if (!Array.isArray(routes) || routes.filter(r => TAB_NOTES[r]).length < 2) return 'too-few-tabs';
  try {
    await loadVendor('driver', { js: 'vendor/driver.js.iife.js', css: 'vendor/driver.css' });
  } catch {
    onEnd?.('unavailable');
    return 'unavailable';
  }
  const factory = globalThis.driver && globalThis.driver.js && globalThis.driver.js.driver;
  if (typeof factory !== 'function') {
    onEnd?.('unavailable');
    return 'unavailable';
  }
  let observer = null;
  let raf = 0;
  let lastRefresh = 0;
  const stop = () => {
    if (observer) { observer.disconnect(); observer = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    _active = null;
  };
  const driver = factory({
    animate: true,
    smoothScroll: false,
    allowClose: true,
    overlayColor: 'rgba(8, 12, 10, 0.62)',
    stagePadding: 8,
    stageRadius: 10,
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    steps: tourSteps(routes),
    onDestroyed: () => { stop(); onEnd?.('closed'); },
  });
  _active = driver;
  // An app render — a sync merge, a toast, a navigation — detaches the node the
  // active step is staged on. The steps carry functions, so a refresh re-resolves
  // the stage; it is throttled to four a second and only ever scheduled after a
  // frame, so a refresh that touches the DOM cannot schedule another refresh.
  observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const now = Date.now();
      if (now - lastRefresh < 250) return;
      lastRefresh = now;
      try { driver.refresh(); } catch { /* nothing left to redraw */ }
    });
  });
  observer.observe(document.getElementById('app') || document.body, { childList: true });
  driver.drive();
  return 'started';
}
