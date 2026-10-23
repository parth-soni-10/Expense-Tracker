/* Analytics Chart — one line, one series, a tooltip per point.
 *
 *   <div data-analytics-chart data-ac-label="reserves"></div>
 *
 *   AnalyticsChart.render(el, [
 *     { label: '12 Oct', value: 902.4, note: 'week 41' },
 *     { label: '19 Oct', value: 918.7 }
 *   ], { label: 'reserves', format: function (v) { return '$' + v; } });
 *
 * Deliberately one series: no legend, no second axis, no zoom. A chart with
 * two lines and no legend is a puzzle; a chart with one line is a fact. If a
 * host needs to compare, it renders two charts.
 *
 * The picture is `role="img"` with a one-sentence summary (first, last, high,
 * low), and the whole series is in a visually hidden table underneath — a
 * screen reader should not have to arrow through 30 points to learn the
 * direction. Arrowing through them is there anyway, for anyone who wants the
 * exact number at a date: the root is focusable, Left/Right/Home/End move a
 * cursor, and each stop is announced.
 *
 * Sizing is the kit's job. It measures its own box and draws at that width,
 * following it with a ResizeObserver, so a host sets a width and never a
 * height or a viewBox.
 *
 * Nothing is animated but the draw-in, and reduced motion skips that too.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var NS = 'http://www.w3.org/2000/svg';
  var observers = typeof WeakMap === 'function' ? new WeakMap() : null;
  var sessions = [];

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function svg(name, attrs) {
    var node = doc.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function mk(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* A value is plottable or it is a gap. A y of 0 is a real reading and must
     not be treated as missing, which is why this tests the type, not truth. */
  function usable(point) {
    return point && typeof point.value === 'number' && isFinite(point.value);
  }

  function tidy(points) {
    return (points || []).map(function (point) {
      if (typeof point === 'number') return { label: '', value: point };
      return {
        label: point.label == null ? '' : String(point.label),
        value: point.value,
        note: point.note == null ? '' : String(point.note),
      };
    }).filter(usable);
  }

  function summary(points, label, format) {
    if (!points.length) return 'No ' + label + ' to chart yet.';
    var first = points[0];
    var last = points[points.length - 1];
    var high = points[0];
    var low = points[0];
    points.forEach(function (point) {
      if (point.value > high.value) high = point;
      if (point.value < low.value) low = point;
    });
    var where = first.label ? ' from ' + first.label : '';
    var to = last.label ? ' to ' + last.label : '';
    var direction = last.value > first.value ? ', rising'
      : last.value < first.value ? ', falling' : ', flat';
    return points.length + ' readings' + where + to + direction +
      '. Last ' + label + ' ' + format(last.value) +
      ', high ' + format(high.value) + (high.label ? ' on ' + high.label : '') +
      ', low ' + format(low.value) + (low.label ? ' on ' + low.label : '') + '.';
  }

  function measure(el) {
    var width = el.clientWidth - (parseFloat(global.getComputedStyle(el).paddingLeft) || 0) -
      (parseFloat(global.getComputedStyle(el).paddingRight) || 0);
    return width > 120 ? Math.floor(width) : 0;      // a hidden pane measures 0
  }

  function render(el, points, opts) {
    opts = opts || {};
    if (!el) return null;

    var data = tidy(points);
    var label = opts.label || el.getAttribute('data-ac-label') || 'values';
    var format = typeof opts.format === 'function'
      ? opts.format
      : function (v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
    var xLabel = typeof opts.xLabel === 'function' ? opts.xLabel : function (p) { return p.label; };
    var state = { at: data.length - 1 };

    while (el.firstChild) el.removeChild(el.firstChild);
    el.classList.add('ac');
    sessions = sessions.filter(function (s) { return s.el !== el; });

    if (!data.length) {
      el.classList.add('is-empty');
      el.appendChild(mk('p', 'ac-empty', opts.empty || 'No ' + label + ' yet.'));
      var none = { count: 0, first: null, last: null, high: null, low: null };
      sessions.push({ el: el, points: data, state: state, opts: opts, result: none });
      return none;
    }
    el.classList.remove('is-empty');

    // A single reading is a dot with a name, not a line pretending to be one.
    var flat = data.length === 1 || data.every(function (p) { return p.value === data[0].value; });

    var plot = mk('div', 'ac-plot');
    var tip = mk('div', 'ac-tip');
    tip.setAttribute('aria-hidden', 'true');
    var tipLabel = mk('span', 'ac-tip-label');
    var tipValue = mk('b', 'ac-tip-value');
    tip.appendChild(tipLabel);
    tip.appendChild(tipValue);
    plot.appendChild(tip);
    el.appendChild(plot);

    var chart = svg('svg', { class: 'ac-svg', role: 'img', 'aria-label': summary(data, label, format) });
    plot.appendChild(chart);

    var table = mk('table', 'ac-table');
    var caption = mk('caption', null, label + ' by point');
    table.appendChild(caption);
    var head = mk('tr');
    head.appendChild(mk('th', null, 'Point'));
    head.appendChild(mk('th', null, 'Value'));
    table.appendChild(head);
    data.forEach(function (point) {
      var row = mk('tr');
      row.appendChild(mk('th', null, xLabel(point) || '—'));
      row.appendChild(mk('td', null, format(point.value)));
      table.appendChild(row);
    });
    el.appendChild(table);

    /* One live sentence under the cursor. It is the only place the focused
       reading exists as text, so it must not be display:none. */
    var live = mk('p', 'ac-live');
    live.setAttribute('aria-live', 'polite');
    el.appendChild(live);

    el.setAttribute('data-ac-ready', '1');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'group');
    if (!el.getAttribute('aria-label')) {
      el.setAttribute('aria-label', 'Analytics chart: ' + label);
    }

    var geom = null;
    var dots = [];

    function pointLabel(point) {
      return xLabel(point) || (label + ' ' + data.indexOf(point) + 1);
    }

    function build() {
      var width = measure(el);
      if (!width) return false;
      var height = Math.max(96, Math.round(parseFloat(global.getComputedStyle(el).getPropertyValue('--ac-height')) || 168));
      var pad = { top: 12, right: 10, bottom: 22, left: 0 };
      var values = data.map(function (p) { return p.value; });
      var max = Math.max.apply(null, values);
      var min = Math.min.apply(null, values);
      if (max === min) { max = max + 1; min = min - 1; }        // a flat series sits mid-band
      var span = max - min;
      max += span * 0.12;
      min -= span * 0.12;

      var innerW = width - pad.left - pad.right;
      var innerH = height - pad.top - pad.bottom;
      var step = data.length > 1 ? innerW / (data.length - 1) : 0;
      var x = function (i) { return pad.left + (data.length > 1 ? i * step : innerW / 2); };
      var y = function (v) { return pad.top + innerH - ((v - min) / (max - min)) * innerH; };

      geom = { width: width, height: height, pad: pad, x: x, y: y, step: step, innerW: innerW, innerH: innerH };

      chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      chart.setAttribute('width', width);
      chart.setAttribute('height', height);
      while (chart.firstChild) chart.removeChild(chart.firstChild);

      [0, 0.5, 1].forEach(function (f) {
        var line = svg('line', {
          class: 'ac-grid',
          x1: 0, x2: width,
          y1: Math.round(pad.top + innerH * f) + 0.5,
          y2: Math.round(pad.top + innerH * f) + 0.5,
        });
        chart.appendChild(line);
      });

      var path = data.map(function (p, i) {
        return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1);
      }).join(' ');

      if (data.length > 1) {
        var area = svg('path', {
          class: 'ac-area',
          d: path + ' L' + x(data.length - 1).toFixed(1) + ' ' + (pad.top + innerH) +
            ' L' + x(0).toFixed(1) + ' ' + (pad.top + innerH) + ' Z',
        });
        chart.appendChild(area);

        var line = svg('path', { class: 'ac-line', d: path, pathLength: 1 });
        chart.appendChild(line);
        // The draw is a stroke trace: it tells you the chart is new without
        // hiding any of it. Reduced motion paints it complete.
        if (!reduced()) {
          line.style.strokeDasharray = '1 1';
          line.style.strokeDashoffset = '1';
          line.getBoundingClientRect();                 // commit the start state
          line.style.transition = 'stroke-dashoffset 620ms cubic-bezier(.22,.9,.3,1)';
          line.style.strokeDashoffset = '0';
        }
      }

      // The cursor: a vertical rule and one dot. Both are always in the DOM so
      // moving between points is a transform, not a rebuild.
      var cross = svg('line', { class: 'ac-cross', y1: pad.top, y2: pad.top + innerH });
      chart.appendChild(cross);
      var dot = svg('circle', { class: 'ac-dot', r: 4 });
      chart.appendChild(dot);

      // Quiet axis: the ends only. A tick per point is noise on a phone.
      var first = svg('text', { class: 'ac-axis', x: 0, y: height - 5 });
      first.textContent = data.length ? xLabel(data[0]) : '';
      chart.appendChild(first);
      if (data.length > 1) {
        var last = svg('text', { class: 'ac-axis ac-axis-end', x: width, y: height - 5, 'text-anchor': 'end' });
        last.textContent = xLabel(data[data.length - 1]);
        chart.appendChild(last);
      }

      dots = [dot];
      show(state.at);
      // A freshly built chart is at rest, not being read: position the cursor on
      // the latest point but leave the tooltip closed until someone asks.
      if (doc.activeElement !== el) hide();
      return true;
    }

    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

    function show(index) {
      if (!geom || !data.length) return;
      state.at = clamp(index, 0, data.length - 1);
      var point = data[state.at];
      var cx = geom.x(state.at);
      var cy = geom.y(point.value);

      chart.querySelector('.ac-cross').setAttribute('x1', cx);
      chart.querySelector('.ac-cross').setAttribute('x2', cx);
      chart.querySelector('.ac-dot').setAttribute('cx', cx);
      chart.querySelector('.ac-dot').setAttribute('cy', cy);

      tipLabel.textContent = pointLabel(point) + (point.note ? ' · ' + point.note : '');
      tipValue.textContent = format(point.value);

      var width = tip.offsetWidth || 96;
      var left = clamp(cx, width / 2 + 2, geom.width - width / 2 - 2);
      var top = clamp(cy - 12, tip.offsetHeight + 8, geom.height);
      tip.style.setProperty('--ac-x', left.toFixed(1) + 'px');
      tip.style.setProperty('--ac-y', top.toFixed(1) + 'px');
      plot.classList.add('is-live');

      live.textContent = pointLabel(point) + ': ' + format(point.value) +
        (doc.activeElement === el ? ' (' + (state.at + 1) + ' of ' + data.length + ')' : '');
    }

    function hide() {
      plot.classList.remove('is-live');
      // At rest the line under the plot is a reading, not a position: "latest"
      // is the question a chart left alone is being asked.
      live.textContent = 'Latest · ' + pointLabel(data[data.length - 1]) + ': ' +
        format(data[data.length - 1].value);
    }

    function indexAt(clientX) {
      if (!geom) return state.at;
      var box = plot.getBoundingClientRect();
      var rel = clientX - box.left - geom.pad.left;
      var step = data.length > 1 ? geom.step : 1;
      return clamp(Math.round(rel / step), 0, data.length - 1);
    }

    plot.addEventListener('pointermove', function (e) {
      show(indexAt(e.clientX));
    });
    plot.addEventListener('pointerdown', function (e) {
      show(indexAt(e.clientX));
      el.focus({ preventScroll: true });
    });
    plot.addEventListener('pointerleave', function () {
      if (doc.activeElement !== el) hide();
    });

    el.addEventListener('keydown', function (e) {
      var at = state.at;
      if (e.key === 'ArrowRight') { show(at + 1); }
      else if (e.key === 'ArrowLeft') { show(at - 1); }
      else if (e.key === 'Home') { show(0); }
      else if (e.key === 'End') { show(data.length - 1); }
      else if (e.key === 'Escape') { hide(); }
      else return;
      e.preventDefault();
      show(state.at);
    });
    el.addEventListener('focus', function () { show(state.at); });
    el.addEventListener('blur', function () { hide(); });
    live.textContent = 'Latest · ' + pointLabel(data[data.length - 1]) + ': ' +
      format(data[data.length - 1].value);

    if (global.ResizeObserver && observers && !observers.has(el)) {
      var ro = new global.ResizeObserver(function () { build(); });
      observers.set(el, ro);
      ro.observe(el);
    }

    build();

    var result = {
      count: data.length,
      first: data[0],
      last: data[data.length - 1],
      high: data.reduce(function (a, b) { return b.value > a.value ? b : a; }),
      low: data.reduce(function (a, b) { return b.value < a.value ? b : a; }),
      flat: flat,
      summary: summary(data, label, format),
    };
    sessions.push({ el: el, points: data, state: state, opts: opts, result: result });
    return result;
  }

  function parseAttr(el) {
    var raw = el.getAttribute('data-ac-points');
    if (raw && raw.trim()) {
      return raw.split(',').map(function (pair) {
        var bits = pair.split(':');
        var value = parseFloat(bits[1]);
        return { label: (bits[0] || '').trim(), value: value };
      });
    }
    try {
      var json = el.getAttribute('data-ac-series');
      if (json) return JSON.parse(json);
    } catch (err) { /* a broken attribute is a broken chart, not a crash */ }
    return [];
  }

  function attach(el) {
    if (!el || el.getAttribute('data-ac-ready')) return null;
    var points = parseAttr(el);
    if (!points.length) return null;
    return render(el, points, {
      label: el.getAttribute('data-ac-label') || undefined,
      empty: el.getAttribute('data-ac-empty') || undefined,
    });
  }

  function scan(root) {
    for (var i = sessions.length - 1; i >= 0; i--) {
      if (doc.contains(sessions[i].el)) continue;
      sessions.splice(i, 1);
    }
    var list = root.matches && root.matches('[data-analytics-chart]') ? [root] : [];
    if (root.querySelectorAll) {
      list = list.concat(Array.prototype.slice.call(root.querySelectorAll('[data-analytics-chart]')));
    }
    list.forEach(attach);
  }

  function boot() {
    scan(doc.body);
    if (!global.MutationObserver) return;
    var pending = 0;
    var queued = [];
    new global.MutationObserver(function (records) {
      Array.prototype.forEach.call(records, function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (n.nodeType === 1) queued.push(n);
        });
      });
      if (!queued.length || pending) return;
      pending = global.requestAnimationFrame(function () {
        pending = 0;
        var batch = queued;
        queued = [];
        batch.forEach(scan);
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.AnalyticsChart = {
    render: render,
    attach: attach,
    refresh: function () { scan(doc.body); },
    summary: summary,
  };
})(window);
