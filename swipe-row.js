/* Swipe Row — a list row that slides aside to reveal its actions.
 *
 *   <div class="summary-item" data-swipe-row>
 *     ...
 *     <button class="s-x" data-swipe-action data-swipe-label="Remove"
 *             data-swipe-tone="danger">×</button>
 *   </div>
 *
 * The row's own buttons stay in the DOM and keep their handlers; the pane
 * mirrors them, so a site never has to rewire anything. A full swipe fires the
 * first action, which is why the first one must be the safe one: Edit before
 * Delete, Remove before anything destructive.
 *
 * Rows are adopted automatically, including rows a render adds later
 * (a MutationObserver picks up new [data-swipe-row] nodes).
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var START = 6;          // px before a gesture is read as a drag
  var FULL = 0.45;        // share of the row width that counts as a full swipe
  var OPEN_AT = 0.4;      // share of the pane width that snaps it open
  var LEAVE_MS = 160;

  var openRow = null;
  var rows = [];

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function measure(s) {
    s.paneW = s.pane.getBoundingClientRect().width || 96;
    s.rowW = s.wrap.clientWidth || 320;
  }

  function paint(s, x) {
    s.pos = x;
    s.surface.style.transform = x ? 'translateX(' + x + 'px)' : '';
  }

  function attach(row) {
    if (!row || row.dataset.srReady) return null;
    var sources = Array.prototype.slice.call(row.querySelectorAll('[data-swipe-action]'));
    if (!sources.length) return null;
    row.dataset.srReady = '1';

    var wrap = doc.createElement('div');
    wrap.className = 'sr-row';
    var parent = row.parentNode;
    parent.insertBefore(wrap, row);
    wrap.appendChild(row);
    row.classList.add('sr-surface');
    // So Escape can put focus back on the row itself; a div is not focusable
    // otherwise and focus would be left on a button that is now behind it.
    if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');

    var pane = doc.createElement('div');
    pane.className = 'sr-pane';
    pane.setAttribute('role', 'group');
    pane.setAttribute('aria-label', row.getAttribute('data-swipe-label') || 'Row actions');

    // Mirror, never move: the site's button keeps its handler, its label and
    // its data, and the pane button is the one the pointer can see.
    var mirrors = sources.map(function (source) {
      source.classList.add('sr-source');
      var b = doc.createElement('button');
      b.type = 'button';
      var label = source.getAttribute('data-swipe-label')
        || source.getAttribute('aria-label')
        || (source.textContent || '').trim()
        || 'Action';
      b.className = 'sr-action' + (source.getAttribute('data-swipe-tone') === 'danger' ? ' is-danger' : '');
      b.textContent = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        close(s, false);
        source.click();
      });
      pane.appendChild(b);
      return b;
    });

    wrap.insertBefore(pane, row);

    var s = {
      row: row, wrap: wrap, surface: row, pane: pane, sources: sources, mirrors: mirrors,
      pos: 0, paneW: 0, rowW: 0, open: false, drag: false, moved: false,
      startX: 0, startY: 0, base: 0, suppress: false,
    };
    rows.push(s);

    row.addEventListener('pointerdown', function (ev) { onDown(s, ev); });
    row.addEventListener('pointermove', function (ev) { onMove(s, ev); });
    row.addEventListener('pointerup', function (ev) { onUp(s, ev); });
    row.addEventListener('pointercancel', function (ev) { onUp(s, ev); });
    row.addEventListener('click', function (ev) {
      if (s.suppress) { s.suppress = false; ev.stopPropagation(); ev.preventDefault(); return; }
      if (s.open) { ev.stopPropagation(); ev.preventDefault(); close(s, false); }
    }, true);
    pane.addEventListener('focusin', function () { open(s); });

    return s;
  }

  function onDown(s, ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    measure(s);
    s.base = s.open ? -s.paneW : 0;
    s.startX = ev.clientX;
    s.startY = ev.clientY;
    s.drag = false;
    s.moved = false;
    try { s.surface.setPointerCapture(ev.pointerId); } catch (err) { /* fine without */ }
  }

  function onMove(s, ev) {
    if (!s.surface.hasPointerCapture || !ev.buttons) return;
    var dx = ev.clientX - s.startX;
    var dy = ev.clientY - s.startY;
    if (!s.drag) {
      if (Math.abs(dx) < START) return;
      // Vertical wins: this is a scroll, not a swipe.
      if (Math.abs(dy) > Math.abs(dx) * 1.1) return;
      s.drag = true;
      if (openRow && openRow !== s) close(openRow, false);
      s.wrap.classList.add('is-dragging');
      if (s.open) s.base = -s.paneW;
    }
    s.moved = true;
    var x = clamp(s.base + dx, -s.rowW * 0.92, 0);
    paint(s, x);
    s.wrap.classList.toggle('is-primed', x < -s.rowW * FULL);
  }

  function onUp(s, ev) {
    if (!s.drag) {
      if (s.moved) s.suppress = true;
      return;
    }
    s.drag = false;
    s.wrap.classList.remove('is-dragging');
    try { s.surface.releasePointerCapture(ev.pointerId); } catch (err) { /* released */ }
    s.suppress = true;

    var full = s.rowW * FULL;
    var fullOn = s.row.getAttribute('data-swipe-full') !== 'off';
    if (fullOn && s.pos < -full && s.mirrors.length) {
      // The first action is the one a full swipe fires. It is the safe one by
      // contract, so the gesture can be decisive without being dangerous.
      s.wrap.classList.remove('is-primed');
      s.surface.style.transform = 'translateX(' + (-s.rowW) + 'px)';
      s.surface.style.opacity = '0';
      var fire = function () {
        var b = s.mirrors[0];
        if (b) b.click();
        // A host usually re-renders the list; a host that keeps the row gets it
        // back instead of an invisible blank space.
        global.setTimeout(function () {
          if (doc.contains(s.wrap)) close(s, false);
        }, 420);
      };
      if (reduced()) fire(); else global.setTimeout(fire, LEAVE_MS);
      return;
    }
    if (s.pos < -s.paneW * OPEN_AT) open(s); else close(s, false);
  }

  function open(s) {
    if (!s || s.open) return;
    measure(s);
    s.open = true;
    s.wrap.classList.add('is-open');
    paint(s, -s.paneW);
    if (openRow && openRow !== s) close(openRow, false);
    openRow = s;
  }

  function close(s, restoreFocus) {
    if (!s) return;
    s.open = false;
    s.wrap.classList.remove('is-open', 'is-primed');
    paint(s, 0);
    s.surface.style.opacity = '';
    if (openRow === s) openRow = null;
    if (restoreFocus) {
      try { s.surface.focus({ preventScroll: true }); } catch (err) { s.surface.focus(); }
    }
  }

  function scan(root) {
    // A host that repaints its list leaves the old wrappers behind as detached
    // nodes; their sessions would pin the whole subtree in memory for as long
    // as the page is open, and one of them could still be the "open" row.
    for (var i = rows.length - 1; i >= 0; i--) {
      if (doc.contains(rows[i].wrap)) continue;
      if (openRow === rows[i]) openRow = null;
      rows.splice(i, 1);
    }
    var list = root.matches && root.matches('[data-swipe-row]') ? [root] : [];
    if (root.querySelectorAll) list = list.concat(Array.prototype.slice.call(root.querySelectorAll('[data-swipe-row]')));
    list.forEach(attach);
  }

  function boot() {
    scan(doc.body);
    if (!global.MutationObserver) return;
    var pending = 0;
    var queued = [];
    var observer = new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (n.nodeType === 1) queued.push(n);
        });
      });
      // A host that repaints a list appends every row in one go; the frame
      // that adopts the first batch must not swallow the rest, so nodes are
      // queued rather than dropped while a frame is already scheduled.
      if (!queued.length || pending) return;
      pending = global.requestAnimationFrame(function () {
        pending = 0;
        var batch = queued;
        queued = [];
        batch.forEach(scan);
      });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  doc.addEventListener('pointerdown', function (ev) {
    if (openRow && !openRow.wrap.contains(ev.target)) close(openRow, false);
  }, true);

  // Escape comes from anywhere: the pane button holds focus once it is tapped.
  doc.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && openRow) {
      ev.preventDefault();
      close(openRow, true);
    }
  }, true);

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.SwipeRow = {
    attach: attach,
    closeAll: function () { rows.slice().forEach(function (s) { close(s, false); }); },
    refresh: function () { scan(doc.body); },
  };
})(window);
