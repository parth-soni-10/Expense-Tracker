/* Timeline Calendar — a date spine over a long, dated list.
 *
 *   <div data-timeline-calendar>
 *     <div data-tl-header data-tl-caption="Timeline"></div>
 *     <section data-tl-label="September 2026" data-tl-count="24">…</section>
 *     <section data-tl-label="August 2026" data-tl-count="18">…</section>
 *   </div>
 *
 * The host keeps its own markup, its own headings and its own scroll. The kit
 * paints one compact header, pins it to the top of the list, and names the
 * group the eye is in — the way a calendar app's pinned date does. It moves
 * nothing out of the document: with no JavaScript the list still reads, prints
 * and scrolls, and the visible group headings keep being the headings a screen
 * reader hears (the pinned bar is aria-hidden, a duplicate of them).
 *
 * A dated row works as a group too: put data-tl-label on the rows themselves
 * and the bar follows the day under the line. That is how a long table with no
 * section markup gets a spine without being rebuilt.
 *
 * The header is the host's element, so the host owns its pin offset through
 * --tlc-top, its paper through --tlc-bg and its hairline through --tlc-line.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var mounted = [];
  /* A redraw replaces the host's list, which the boot observer sees as a new
     subtree — and would mount into the old one again if it were still there.
     Roots torn down by the kit are skipped until that batch has run. */
  var teardown = [];
  var frame = 0;
  var settle = 0;

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function build(header) {
    header.classList.add('tlc');
    header.setAttribute('aria-hidden', 'true');
    header.textContent = '';
    var caption = doc.createElement('span');
    caption.className = 'tlc-caption';
    var label = doc.createElement('span');
    label.className = 'tlc-label';
    var count = doc.createElement('span');
    count.className = 'tlc-count';
    header.appendChild(caption);
    header.appendChild(label);
    header.appendChild(count);
    return { caption: caption, label: label, count: count };
  }

  function mount(root) {
    if (!root || root.__timelineCalendar) return root && root.__timelineCalendar;
    var header = root.querySelector('[data-tl-header]');
    if (!header) return null;
    var labels = Array.prototype.slice.call(root.querySelectorAll('[data-tl-label]'));
    if (!labels.length) return null;

    var parts = build(header);
    // With the bar live it is the visible label, so a host can retire the
    // duplicate in-flow heading without losing it when the kit has not run.
    root.classList.add('tlc-live');
    var caption = header.getAttribute('data-tl-caption') || '';
    parts.caption.textContent = caption;
    parts.caption.hidden = !caption;

    var index = -1;
    var text = null;
    var shownCount = null;

    function show(el, animate) {
      var next = el.getAttribute('data-tl-label') || '';
      var count = el.getAttribute('data-tl-count') || '';
      if (next !== text) {
        parts.label.textContent = next;
        text = next;
        parts.label.classList.remove('tlc-in');
        if (animate && !reduced()) {
          // Restart the reveal for a label that arrives twice in one scroll:
          // without the reflow the class is already set and nothing plays.
          void parts.label.offsetWidth;
          parts.label.classList.add('tlc-in');
        }
      }
      if (count !== shownCount) {
        parts.count.textContent = count;
        shownCount = count;
      }
      parts.count.hidden = !count;
    }

    /* Which group is the eye in? The last one whose top has crossed the line
       under the pinned bar. Walking from last frame's group rather than
       scanning the list keeps this to a few rects per frame — a history can
       hold hundreds of rows and every one of them would otherwise be read on
       every scroll. */
    function paint(animate) {
      if (!root.isConnected) { destroy(); return; }
      var line = header.getBoundingClientRect().bottom;
      var i = index < 0 ? 0 : index;
      if (labels[i].getBoundingClientRect().top > line) {
        while (i > 0 && labels[i].getBoundingClientRect().top > line) i--;
      } else {
        while (i + 1 < labels.length && labels[i + 1].getBoundingClientRect().top <= line) i++;
      }
      index = i;
      show(labels[i], animate !== false && index !== -1);
    }

    function destroy() {
      header.classList.remove('tlc');
      header.removeAttribute('aria-hidden');
      header.textContent = '';
      root.classList.remove('tlc-live');
      root.__timelineCalendar = null;
      root.__tlTeardown = true;
      teardown.push(root);
      mounted = mounted.filter(function (m) { return m.api !== api; });
    }

    var api = {
      root: root,
      header: header,
      refresh: function () {
        labels = Array.prototype.slice.call(root.querySelectorAll('[data-tl-label]'));
        index = -1;
        paint(false);
      },
      paint: function () { paint(true); },
      destroy: destroy,
    };

    root.__timelineCalendar = api;
    mounted.push(api);
    paint(false);
    // A host may size its offscreen rows with content-visibility (cents. does),
    // in which case their boxes are placeholders until they are rendered — and
    // a jump lands before that has happened. One trailing read after the jump
    // has settled corrects the name without waiting for the next scroll.
    global.setTimeout(function () { if (root.isConnected) paint(false); }, 160);
    return api;
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    var list = [];
    if (node.matches && node.matches('[data-timeline-calendar]')) list.push(node);
    if (node.querySelectorAll) {
      list = list.concat(Array.prototype.slice.call(node.querySelectorAll('[data-timeline-calendar]')));
    }
    list.forEach(function (el) { if (!el.__tlTeardown) mount(el); });
  }

  function prune() {
    mounted.slice().forEach(function (m) { if (!m.root.isConnected) m.destroy(); });
  }

  function onFrame() {
    frame = 0;
    mounted.slice().forEach(function (m) { m.paint(); });
  }

  function onScroll() {
    if (frame) return;
    frame = global.requestAnimationFrame(onFrame);
    global.clearTimeout(settle);
    settle = global.setTimeout(function () {
      settle = 0;
      mounted.slice().forEach(function (m) { m.paint(false); });
    }, 160);
  }

  function boot() {
    scan(doc.body);
    global.addEventListener('scroll', onScroll, { passive: true });
    global.addEventListener('resize', onScroll, { passive: true });
    if (!global.MutationObserver) return;
    var queue = [];
    var raf = 0;
    new global.MutationObserver(function (records) {
      Array.prototype.forEach.call(records, function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (node) {
          if (node.nodeType === 1) queue.push(node);
        });
        Array.prototype.forEach.call(r.removedNodes, function (node) {
          if (node.nodeType === 1) queue.push(node);
        });
      });
      if (!queue.length || raf) return;
      raf = global.requestAnimationFrame(function () {
        raf = 0;
        prune();
        var batch = queue;
        queue = [];
        batch.forEach(scan);
        teardown.splice(0).forEach(function (el) { el.__tlTeardown = false; });
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.TimelineCalendar = {
    mount: mount,
    refresh: function () { mounted.slice().forEach(function (m) { m.refresh(); }); },
  };
})(window);
