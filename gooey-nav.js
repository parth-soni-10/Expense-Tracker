/* Gooey Nav — the active item's pill, drawn as a liquid that stretches after it.
 *
 *   <nav data-gooey-nav>
 *     <a href="#one" class="active">One</a>
 *     <a href="#two">Two</a>
 *   </nav>
 *
 *   GooeyNav.mount(navEl, { fill: '…' })
 *
 * The host keeps its links, its active class and its click handling. The kit
 * appends one decorative layer behind them: a single pill under an SVG goo
 * filter. Moving it does not teleport a box across the nav — the pill first
 * stretches to cover the ground to the new item, then contracts into it, so a
 * move reads as liquid being pulled, and at no instant is there a second pill
 * that could be mistaken for a second active item.
 *
 * Nothing here changes what the nav means. The layer is aria-hidden, the host's
 * own active state is still the truth (class, aria-current or aria-selected),
 * the links keep their focus and their order, and a reduced-motion visitor gets
 * an instant move with no droplet.
 *
 * While the blob is drawing, the kit puts `.gn-on` on the nav and the stylesheet
 * clears the active link's own background, so the two do not stack into a
 * double pill. The class comes off when the nav turns into a column (a phone
 * dropdown), where the host's own active row is the better picture.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var NS = 'http://www.w3.org/2000/svg';
  var seq = 0;
  var mounted = [];
  var DEFAULT_PAD = 2;         // keeps the blurred edge over the link's box
  var STRETCH = 90;            // how long the pill spends reaching for the target

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function linksOf(nav) {
    return Array.prototype.filter.call(
      nav.querySelectorAll('a[href], button'),
      // getClientRects, not offsetParent: a nav inside a fixed header has no
      // offsetParent even though every link in it is on screen.
      function (el) { return !el.classList.contains('gn-skip') && el.getClientRects().length > 0; }
    );
  }

  function activeOf(links) {
    var i;
    for (i = 0; i < links.length; i++) {
      var cur = links[i].getAttribute('aria-current');
      if (cur === 'page' || cur === 'true' || cur === 'location') return links[i];
    }
    for (i = 0; i < links.length; i++) {
      if (links[i].classList.contains('active') || links[i].getAttribute('aria-selected') === 'true') return links[i];
    }
    return links[0] || null;
  }

  function filterEl(id) {
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'gn-svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var defs = doc.createElementNS(NS, 'defs');
    var filter = doc.createElementNS(NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '-30%');
    filter.setAttribute('y', '-30%');
    filter.setAttribute('width', '160%');
    filter.setAttribute('height', '160%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    var blur = doc.createElementNS(NS, 'feGaussianBlur');
    blur.setAttribute('in', 'SourceGraphic');
    blur.setAttribute('stdDeviation', '5');
    blur.setAttribute('result', 'blur');
    filter.appendChild(blur);

    var matrix = doc.createElementNS(NS, 'feColorMatrix');
    matrix.setAttribute('in', 'blur');
    matrix.setAttribute('type', 'matrix');
    matrix.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9');
    filter.appendChild(matrix);

    defs.appendChild(filter);
    svg.appendChild(defs);
    return svg;
  }

  function span(cls) {
    var el = doc.createElement('span');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function mount(nav, opts) {
    if (!nav) return null;
    if (nav.__gooeyNav) return nav.__gooeyNav;
    opts = opts || {};

    // A pill around a padded link needs the bleed; a full-height tab strip is
    // already the shape and must not spill past the bar it lives in.
    var padAttr = nav.getAttribute('data-gooey-pad');
    var PAD = padAttr == null ? (opts.pad == null ? DEFAULT_PAD : Number(opts.pad)) : Number(padAttr);
    if (!isFinite(PAD)) PAD = DEFAULT_PAD;

    var id = 'gn-goo-' + (++seq);
    var blob = span('gn-blob');
    var goo = span('gn-goo');
    goo.style.filter = 'url(#' + id + ')';
    goo.appendChild(blob);
    nav.appendChild(filterEl(id));
    nav.appendChild(goo);
    nav.classList.add('gooey-nav');
    if (opts.fill) nav.style.setProperty('--gn-fill', opts.fill);

    var last = '';
    var preview = null;
    var stretchTimer = 0;

    function box(link) {
      var nr = nav.getBoundingClientRect();
      var lr = link.getBoundingClientRect();
      return {
        left: lr.left - nr.left - nav.clientLeft - PAD,
        top: lr.top - nr.top - nav.clientTop - PAD,
        width: lr.width + PAD * 2,
        height: lr.height + PAD * 2,
      };
    }

    function place(el, r) {
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
    }

    function instant(el, r) {
      el.classList.add('is-instant');
      place(el, r);
      // Reading a layout property flushes the "no transition" frame, so the
      // next class removal animates from this position rather than the old one.
      void el.offsetWidth;
      el.classList.remove('is-instant');
    }

    function canDraw(link) {
      if (!link || !link.getBoundingClientRect().width) return false;
      if (!nav.clientWidth) return false;
      var dir = global.getComputedStyle(nav).flexDirection;   // grid reports row
      return dir.indexOf('row') !== -1;
    }

    function refresh() {
      var links = linksOf(nav);
      var target = preview && links.indexOf(preview) !== -1 ? preview : activeOf(links);
      if (!target || !canDraw(target)) {
        nav.classList.remove('gn-on');
        return;
      }
      nav.classList.add('gn-on');

      var r = box(target);
      var key = [target.getAttribute('href') || target.textContent, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join('|');
      // Nothing new to say. This used to re-place the pill here, which quietly
      // snapped a move in flight back onto its target the moment any other
      // refresh came through (a class flip on a link was enough).
      if (key === last) return;

      var previous = blob.style.left ? {
        left: parseFloat(blob.style.left),
        top: parseFloat(blob.style.top),
        width: parseFloat(blob.style.width),
        height: parseFloat(blob.style.height),
      } : null;

      if (!previous || reduced()) {
        instant(blob, r);
        last = key;
        return;
      }

      // Stretch, then settle. The union box is the span the pill has to cross,
      // so the first beat grows it toward the target at a short duration and the
      // second beat lets it contract into the target at the full one. Both are
      // transitions on the same element, so an interruption (a fast second
      // click) simply redraws from wherever the pill currently is.
      var union = {
        left: Math.min(previous.left, r.left),
        top: Math.min(previous.top, r.top),
        width: Math.max(previous.left + previous.width, r.left + r.width) - Math.min(previous.left, r.left),
        height: Math.max(previous.height, r.height),
      };
      global.clearTimeout(stretchTimer);
      blob.classList.add('is-stretch');
      place(blob, union);
      stretchTimer = global.setTimeout(function () {
        blob.classList.remove('is-stretch');
        place(blob, r);
      }, STRETCH);
      last = key;
    }

    nav.addEventListener('pointerdown', function () { preview = null; });
    nav.addEventListener('focusin', function (e) {
      var link = e.target.closest && e.target.closest('a[href], button');
      if (!link || !nav.contains(link)) return;
      preview = link;
      refresh();
    });
    nav.addEventListener('focusout', function (e) {
      if (nav.contains(e.relatedTarget)) return;
      preview = null;
      refresh();
    });

    /* Watch what the host changes, never what this refresh writes. The nav's own
       class and the pill's .is-stretch / .is-instant flips are all inside the
       observed subtree, so feeding them straight back into refresh() made every
       pass schedule the next one — a renderer that never goes idle. Host edits
       land on the links, so the kit's own layer is simply skipped. */
    var raf = 0;
    function isKitOwned(record) {
      var t = record.target;
      if (goo === t || goo.contains(t) || blob === t) return true;
      return record.type === 'attributes' && t === nav && record.attributeName === 'class';
    }
    function onMutations(records) {
      var host = false;
      for (var i = 0; i < records.length; i++) {
        if (!isKitOwned(records[i])) { host = true; break; }
      }
      if (!host || raf) return;
      raf = global.requestAnimationFrame(function () { raf = 0; refresh(); });
    }
    var mo = global.MutationObserver ? new global.MutationObserver(onMutations) : null;
    if (mo) mo.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-selected', 'hidden'] });

    var ro = global.ResizeObserver ? new global.ResizeObserver(refresh) : null;
    if (ro) {
      ro.observe(nav);
      Array.prototype.forEach.call(nav.children, function (child) {
        if (child !== goo && child.className !== 'gn-svg') ro.observe(child);
      });
    }
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(refresh);

    function onResize() { refresh(); }
    global.addEventListener('resize', onResize, { passive: true });

    refresh();

    var api = {
      nav: nav,
      refresh: refresh,
      destroy: function () {
        if (mo) mo.disconnect();
        if (raf) { global.cancelAnimationFrame(raf); raf = 0; }
        if (ro) ro.disconnect();
        global.removeEventListener('resize', onResize);
        global.clearTimeout(stretchTimer);
        if (goo.parentNode) goo.parentNode.removeChild(goo);
        var svg = nav.querySelector('.gn-svg');
        if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
        nav.classList.remove('gooey-nav', 'gn-on');
        nav.__gooeyNav = null;
        mounted = mounted.filter(function (m) { return m !== api; });
      },
    };
    nav.__gooeyNav = api;
    mounted.push(api);
    return api;
  }

  function scan(root) {
    // A host that rebuilds its header (cents. redraws the whole app shell on a
    // route change, nav included) leaves the old mount observing a detached
    // node, and its window resize listener would stay registered for the life
    // of the page — one per render. Drop the dead mounts before adding the new
    // one: the kit's own observers are all it has to unwind.
    mounted.slice().forEach(function (m) {
      if (!m.nav.isConnected) m.destroy();
    });

    var list = [];
    if (root.matches && root.matches('[data-gooey-nav]')) list.push(root);
    if (root.querySelectorAll) {
      list = list.concat(Array.prototype.slice.call(root.querySelectorAll('[data-gooey-nav]')));
    }
    list.forEach(function (nav) { mount(nav); });
  }

  function boot() {
    scan(doc.body);
    if (!global.MutationObserver) return;
    var queued = [];
    var raf = 0;
    new global.MutationObserver(function (records) {
      Array.prototype.forEach.call(records, function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (node) {
          if (node.nodeType === 1) queued.push(node);
        });
      });
      if (!queued.length || raf) return;
      raf = global.requestAnimationFrame(function () {
        raf = 0;
        var batch = queued;
        queued = [];
        batch.forEach(scan);
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.GooeyNav = {
    mount: mount,
    refresh: function () { mounted.forEach(function (m) { m.refresh(); }); },
  };
})(window);
