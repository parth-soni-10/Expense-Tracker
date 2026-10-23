/* Timeline Calendar — a date spine over a long, dated list.
 *
 *   <div data-timeline-calendar>
 *     <div data-tl-header data-tl-caption="Timeline" data-tl-noun="month"></div>
 *     <section data-tl-label="September 2026" data-tl-count="24">…</section>
 *     <section data-tl-label="August 2026" data-tl-count="18">…</section>
 *   </div>
 *
 * The host keeps its own markup, its own headings and its own scroll. The kit
 * paints one compact bar, pins it to the top of the list, and names the group
 * the eye is in — the way a calendar app's pinned date does. The bar is also a
 * menu button: it lists the groups and jumps to the one chosen.
 *
 * It moves nothing out of the document. With no JavaScript the list still
 * reads, prints and scrolls; the visible group headings remain the headings a
 * screen reader hears.
 *
 * A dated row works as a group too: put data-tl-label on the rows themselves
 * and the bar follows the day under the line. Consecutive rows with the same
 * label count as one group, so a table needs no section markup and the menu
 * lists each day once.
 *
 * The header is the host's element, so the host owns its pin offset through
 * --tlc-top, its paper through --tlc-bg, its menu paper through --tlc-menu-bg
 * and its hairline through --tlc-line.
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
  var seq = 0;

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function span(cls, text) {
    var el = doc.createElement('span');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function mount(root) {
    if (!root || root.__timelineCalendar) return root && root.__timelineCalendar;
    var header = root.querySelector('[data-tl-header]');
    if (!header) return null;
    var labels = Array.prototype.slice.call(root.querySelectorAll('[data-tl-label]'));
    if (!labels.length) return null;

    // One entry per run of equal labels: Content's sections are already one per
    // month, cents.' rows repeat their day, and both should list each group
    // once in the menu.
    var groups = [];
    function rebuildGroups() {
      groups = [];
      labels.forEach(function (el, i) {
        var label = el.getAttribute('data-tl-label') || '';
        var last = groups[groups.length - 1];
        if (last && last.label === label) return;
        groups.push({ label: label, count: el.getAttribute('data-tl-count') || '', el: el, index: i });
      });
    }
    rebuildGroups();

    header.classList.add('tlc');
    header.textContent = '';

    var id = 'tlc-menu-' + (++seq);
    var trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'tlc-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id);

    var captionEl = span('tlc-caption');
    var labelEl = span('tlc-label');
    var countEl = span('tlc-count');
    var chev = span('tlc-chevron');
    chev.setAttribute('aria-hidden', 'true');
    /* The accessible name is the visible one plus this hint. An `aria-label`
       would have replaced the visible words and broken voice control: a
       command that says “Timeline October 2026” must name the same text the
       button shows. */
    var hintEl = span('tlc-hint');
    trigger.appendChild(captionEl);
    trigger.appendChild(labelEl);
    trigger.appendChild(countEl);
    trigger.appendChild(chev);
    trigger.appendChild(hintEl);

    var menu = doc.createElement('div');
    menu.className = 'tlc-menu';
    menu.id = id;
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    header.appendChild(trigger);
    header.appendChild(menu);

    var caption = header.getAttribute('data-tl-caption') || '';
    captionEl.textContent = caption;
    captionEl.hidden = !caption;
    var noun = header.getAttribute('data-tl-noun') || 'date';
    hintEl.textContent = 'Choose a ' + noun;
    menu.setAttribute('aria-label', 'Choose a ' + noun);

    var index = -1;
    var text = null;
    var shownCount = null;
    var isOpen = false;
    var items = [];
    var currentGroup = 0;

    function groupIndexFor(i) {
      for (var g = groups.length - 1; g >= 0; g--) if (groups[g].index <= i) return g;
      return 0;
    }

    function buildMenu() {
      menu.textContent = '';
      items = groups.map(function (g, gi) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'tlc-item';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('data-index', String(gi));
        b.appendChild(span('tlc-item-label', g.label));
        if (g.count) b.appendChild(span('tlc-item-count', g.count));
        b.addEventListener('click', function () { jumpTo(gi); });
        menu.appendChild(b);
        return b;
      });
      markCurrent();
    }
    buildMenu();

    function markCurrent() {
      items.forEach(function (b, i) {
        if (i === currentGroup) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    }

    /* Moving focus into the menu must never move the page: the bar is sticky,
       and a scroll the reader did not ask for would change the group under the
       line — and with it the very current marker the menu just highlighted. */
    function focusEl(el) {
      if (el) el.focus({ preventScroll: true });
    }

    /* preventScroll keeps the page still, but it also keeps the menu from
       scrolling to a current group far down a long list — so show it here,
       inside the menu only. */
    function revealItem(el) {
      if (!el) return;
      var box = menu.getBoundingClientRect();
      var item = el.getBoundingClientRect();
      if (item.top < box.top) menu.scrollTop += item.top - box.top - 6;
      else if (item.bottom > box.bottom) menu.scrollTop += item.bottom - box.bottom + 6;
    }

    function focusAndReveal(el) {
      focusEl(el);
      revealItem(el);
    }

    function setOpen(open, focusItem) {
      if (open === isOpen) return;
      isOpen = open;
      header.classList.toggle('is-open', open);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.hidden = !open;
      if (open) {
        markCurrent();
        doc.addEventListener('pointerdown', onDocDown, true);
        if (focusItem) focusItemAt(currentGroup);
      } else {
        doc.removeEventListener('pointerdown', onDocDown, true);
      }
    }

    function onDocDown(ev) {
      if (!header.contains(ev.target)) setOpen(false);
    }

    function focusItemAt(i) {
      focusAndReveal(items[i] || items[0]);
    }

    /* Where the bar's foot will be once it is pinned — not where it is now.
       Opened while the bar is still in the flow (a short list, a page not yet
       scrolled), its rect is far below the line it pins to; the sticky offset
       is the bar's own `top`. */
    function pinnedBottom() {
      var bar = header.getBoundingClientRect();
      var pin = parseFloat(global.getComputedStyle(header).top);
      return isNaN(pin) ? bar.bottom : pin + header.offsetHeight;
    }

    function jumpTo(gi) {
      var g = groups[gi];
      if (!g) return;
      setOpen(false);
      trigger.focus({ preventScroll: true });
      var y = g.el.getBoundingClientRect().top + global.pageYOffset - (pinnedBottom() - 1);
      global.scrollTo({ top: Math.max(0, y), behavior: reduced() ? 'auto' : 'smooth' });
    }

    trigger.addEventListener('click', function () {
      var opening = !isOpen;
      setOpen(opening, opening);
      if (!opening) focusEl(trigger);
    });
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      setOpen(true, true);
    });
    menu.addEventListener('keydown', function (e) {
      var at = items.indexOf(doc.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        focusEl(trigger);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (at < 0) focusItemAt(currentGroup);
        else focusAndReveal(items[at + 1] || items[0]);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (at < 0) focusItemAt(currentGroup);
        else focusAndReveal(items[at - 1] || items[items.length - 1]);
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusItemAt(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        focusItemAt(items.length - 1);
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    });

    function show(el, animate) {
      var next = el.getAttribute('data-tl-label') || '';
      var count = el.getAttribute('data-tl-count') || '';
      if (next !== text) {
        labelEl.textContent = next;
        text = next;
        labelEl.classList.remove('tlc-in');
        if (animate && !reduced()) {
          // Restart the reveal for a label that arrives twice in one scroll:
          // without the reflow the class is already set and nothing plays.
          void labelEl.offsetWidth;
          labelEl.classList.add('tlc-in');
        }
      }
      if (count !== shownCount) {
        countEl.textContent = count;
        shownCount = count;
      }
      countEl.hidden = !count;
      currentGroup = groupIndexFor(index);
      markCurrent();
    }

    /* Which group is the eye in? The last one whose top has crossed the line
       under the pinned bar. Walking from last frame's group rather than
       scanning the list keeps this to a few rects per frame — a history can
       hold hundreds of rows and every one of them would otherwise be read on
       every scroll. */
    function paint(animate) {
      if (!root.isConnected) {
        if (root.__timelineCalendar === api) destroy();
        return;
      }
      var line = header.getBoundingClientRect().bottom;
      var i = index < 0 ? 0 : index;
      if (labels[i].getBoundingClientRect().top > line) {
        while (i > 0 && labels[i].getBoundingClientRect().top > line) i--;
      } else {
        while (i + 1 < labels.length && labels[i + 1].getBoundingClientRect().top <= line) i++;
      }
      index = i;
      show(labels[i], animate !== false);
    }

    function destroy() {
      if (isOpen) doc.removeEventListener('pointerdown', onDocDown, true);
      header.classList.remove('tlc', 'is-open');
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
        rebuildGroups();
        buildMenu();
        index = -1;
        paint(false);
      },
      paint: function () { paint(true); },
      destroy: destroy,
    };

    root.__timelineCalendar = api;
    root.classList.add('tlc-live');
    mounted.push(api);
    paint(false);
    // A host may size its offscreen rows with content-visibility (cents. does),
    // in which case their boxes are placeholders until they are rendered — and
    // a jump lands before that has happened. One trailing read after the jump
    // has settled corrects the name without waiting for the next scroll.
    global.setTimeout(function () {
      if (root.__timelineCalendar === api) paint(false);
    }, 160);
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
