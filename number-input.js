/* Animated Number Input — digits that arrive, typed exactly as they are.
 *
 *   <input class="input" type="text" inputmode="decimal" value="26"
 *          data-number-input data-ni-step="5" data-ni-min="5" data-ni-max="120"
 *          data-ni-steppers>
 *
 *   NumberInput.mount(input, { step: 5, min: 5, max: 120, decimals: 0 })
 *
 * The field you type in is a real input. It keeps the caret, the selection,
 * paste, undo and the mobile keypad; the kit only paints a mirrored copy of the
 * value on top of it, so each arriving character can slide in. The input's own
 * glyphs are made transparent and its collection background is switched off, and
 * the mirror paints the selection instead, so there is never a second copy of
 * the text and never a highlight with no digits under it.
 *
 * Exact entry is the one rule the kit refuses to break: it never parses the
 * typed text into a number and back. "0.10", "1.005" and "-0.5" survive
 * keystroke by keystroke, trailing zeros included, because the value in the
 * field is the only value there is. Stepping is the one place arithmetic
 * happens, and it is done on scaled integers (BigInt) rather than floats — so
 * 0.1 + 0.2 is 0.3 here, not 0.30000000000000004.
 *
 * Native <input type="number"> is converted to a text field with a decimal
 * keypad, because a number input silently empties itself while you are in the
 * middle of typing "1." or "-" — which is exactly the state this kit must keep.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var mounted = [];
  /* Destroy unwraps the field, which the boot observer sees as an input added to
     the page — and would mount straight back. Fields torn down by the kit are
     skipped until that batch has run. */
  var teardown = [];

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function decimalsOf(value) {
    var s = String(value);
    var dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
  }

  function isNumeric(value) {
    return /^-?(\d+(\.\d*)?|\.\d+)$/.test(String(value).trim());
  }

  /* Scaled integers: the only arithmetic in the kit, and float-free by design. */
  function scaled(value, dp) {
    var s = String(value).trim();
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '');
    if (frac.length > dp) frac = frac.slice(0, dp);
    while (frac.length < dp) frac += '0';
    var digits = (whole + frac).replace(/^0+(?=\d)/, '');
    var n = global.BigInt(digits || '0');
    return neg ? -n : n;
  }

  function fromScaled(n, dp) {
    var neg = n < 0;
    if (neg) n = -n;
    var str = n.toString();
    if (dp > 0) {
      while (str.length <= dp) str = '0' + str;
      str = str.slice(0, str.length - dp) + '.' + str.slice(str.length - dp);
    }
    return (neg ? '-' : '') + str;
  }

  // a + b, exact, at the wider of the two scales.
  function addExact(a, b) {
    var dp = Math.max(decimalsOf(a), decimalsOf(b));
    return fromScaled(scaled(a, dp) + scaled(b, dp), dp);
  }

  function padDecimals(value, dp) {
    if (dp == null) return value;
    var s = String(value);
    var dot = s.indexOf('.');
    var frac = dot === -1 ? '' : s.slice(dot + 1);
    if (frac.length === dp) return s;
    if (frac.length > dp) return fromScaled(scaled(s, dp), dp);
    return (dot === -1 ? s : s.slice(0, dot)) + '.' + (frac + new Array(dp - frac.length + 1).join('0'));
  }

  function compared(a, b) {
    var dp = Math.max(decimalsOf(a), decimalsOf(b));
    var x = scaled(a, dp), y = scaled(b, dp);
    return x === y ? 0 : (x < y ? -1 : 1);
  }

  function span(cls, text) {
    var el = doc.createElement('span');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // Same metrics as the field, so a mirrored glyph sits exactly where the
  // transparent one does: caret included.
  var METRICS = [
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
    'font-variant-numeric', 'font-feature-settings', 'letter-spacing', 'word-spacing',
    'line-height', 'text-transform', 'padding-left', 'padding-right',
    'padding-top', 'padding-bottom', 'text-indent'
  ];

  function mount(input, opts) {
    if (!input) return null;
    if (input.__numberInput) return input.__numberInput;
    opts = opts || {};

    var read = function (name, fallback) {
      var attr = input.getAttribute('data-ni-' + name);
      if (attr != null) return attr;
      if (opts[name] != null) return opts[name];
      var plain = input.getAttribute(name);
      return plain != null ? plain : fallback;
    };

    var step = String(read('step', '1'));
    var min = read('min', null);
    var max = read('max', null);
    var decimals = read('decimals', null);
    decimals = decimals == null ? null : Number(decimals);

    // A number input loses "1." and "-" while you type them; this kit needs them.
    if (input.type === 'number') {
      input.type = 'text';
      input.setAttribute('inputmode', decimals > 0 ? 'decimal' : 'numeric');
    }

    var wrap = span('ni');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var mirror = span('ni-mirror');
    mirror.setAttribute('aria-hidden', 'true');
    var text = span('ni-text');
    mirror.appendChild(text);
    wrap.appendChild(mirror);

    var field = input;
    field.classList.add('ni-field');

    var steps = null;
    if (input.hasAttribute('data-ni-steppers') || opts.steppers) {
      steps = span('ni-steps');
      [['up', 'Increase'], ['down', 'Decrease']].forEach(function (pair) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'ni-step ni-' + pair[0];
        b.tabIndex = -1;
        b.setAttribute('aria-label', pair[1] + ' value');
        b.textContent = pair[0] === 'up' ? '\u25B4' : '\u25BE';
        b.addEventListener('click', function (e) {
          e.preventDefault();
          field.focus();
          stepBy(pair[0] === 'up' ? 1 : -1);
        });
        steps.appendChild(b);
      });
      wrap.appendChild(steps);
      wrap.classList.add('ni-has-steps');
    }

    var spans = [];
    var lastValue = '';

    function syncMetrics() {
      var cs = global.getComputedStyle(field);
      // 'color' is the host's own ink: the field's glyphs are hidden with
      // text-fill, so this is still the colour it asked for.
      METRICS.forEach(function (prop) { mirror.style.setProperty(prop, cs.getPropertyValue(prop)); });
      var align = cs.textAlign;
      mirror.style.justifyContent = align === 'center' ? 'center' : (align === 'right' || align === 'end' ? 'flex-end' : 'flex-start');
      wrap.style.fontSize = cs.fontSize;
    }

    function clearText() {
      while (text.firstChild) text.removeChild(text.firstChild);
      spans = [];
    }

    function paint(animateFrom) {
      var value = field.value;
      if (!value) {
        clearText();
        var ph = field.getAttribute('placeholder');
        if (ph) text.appendChild(span('ni-ph', ph));
        lastValue = value;
        return;
      }

      var chars = Array.from(value);
      var previous = Array.from(lastValue);
      var common = 0;
      while (common < chars.length && common < previous.length && chars[common] === previous[common]) common++;
      var from = animateFrom == null ? common : Math.min(animateFrom, common);

      var next = [];
      for (var i = 0; i < chars.length; i++) {
        var reuse = spans[i] && spans[i].textContent === chars[i] ? spans[i] : null;
        if (reuse) {
          reuse.classList.remove('ni-enter');
          next.push(reuse);
          continue;
        }
        var cell = span('ni-ch', chars[i]);
        if (i >= from) cell.classList.add('ni-enter');
        next.push(cell);
      }

      // Reconcile in place: replacing the whole run would restart the
      // animation of characters that arrived a keystroke ago.
      for (var j = 0; j < next.length; j++) {
        if (text.childNodes[j] !== next[j]) text.insertBefore(next[j], text.childNodes[j] || null);
      }
      while (text.childNodes.length > next.length) text.removeChild(text.lastChild);

      spans = next;
      lastValue = value;
      syncSelection();
    }

    function syncSelection() {
      var start = field.selectionStart, end = field.selectionEnd;
      var has = start != null && end != null && end > start;
      for (var i = 0; i < spans.length; i++) {
        spans[i].classList.toggle('ni-selected', has && i >= start && i < end);
      }
    }

    function notify() {
      field.dispatchEvent(new global.Event('input', { bubbles: true }));
      field.dispatchEvent(new global.Event('change', { bubbles: true }));
    }

    function clampValue(value) {
      var out = value;
      if (min != null && min !== '' && compared(out, min) < 0) out = String(min);
      if (max != null && max !== '' && compared(out, max) > 0) out = String(max);
      return out;
    }

    function setValue(value, animate) {
      var before = field.value;
      field.value = value;
      if (value !== before) {
        // A programmatic change (a dial, a reset) is not an edit: it lands whole.
        paint(animate ? null : 0);
        notify();
      } else {
        paint(0);
      }
    }

    function current() {
      var raw = field.value.trim();
      return isNumeric(raw) ? raw : null;
    }

    function stepBy(direction) {
      var base = current();
      if (base == null) {
        base = min != null && min !== '' ? String(min) : (max != null && max !== '' && compared(max, '0') < 0 ? String(max) : '0');
      }
      var delta = direction > 0 ? step : '-' + String(step).replace(/^-/, '');
      var next = padDecimals(addExact(base, delta), decimals);
      next = clampValue(next);
      if (next === field.value) return;
      field.value = next;
      paint(null);
      notify();
    }

    field.addEventListener('input', function () { paint(null); });
    field.addEventListener('select', syncSelection);
    field.addEventListener('keyup', syncSelection);
    field.addEventListener('pointerup', syncSelection);
    // A host's own blur handler may rewrite the value (cents. reverts an amount
    // it refused, without firing input). Repaint from the field afterwards so
    // the mirror never keeps text the field no longer holds.
    field.addEventListener('blur', function () { syncSelection(); paint(null); });
    field.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      stepBy(e.key === 'ArrowUp' ? 1 : -1);
    });

    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(function () { syncMetrics(); paint(0); });
    // Named, because destroy() has to be able to take it off again: a host that
    // redraws its screen would otherwise leave one listener per redraw behind.
    function onWindowResize() { syncMetrics(); paint(0); }
    global.addEventListener('resize', onWindowResize, { passive: true });

    var ro = global.ResizeObserver ? new global.ResizeObserver(function () { syncMetrics(); }) : null;
    if (ro) ro.observe(field);

    syncMetrics();
    lastValue = '';
    paint(0);

    var api = {
      input: field,
      wrap: wrap,
      step: function (direction) { stepBy(direction); },
      set: function (value, animate) { setValue(String(value), animate !== false); },
      get: function () { return field.value; },
      number: function () { var v = current(); return v == null ? null : Number(v); },
      refresh: function () { syncMetrics(); paint(0); },
      destroy: function () {
        if (ro) ro.disconnect();
        global.removeEventListener('resize', onWindowResize);
        field.classList.remove('ni-field');
        if (steps && steps.parentNode) steps.parentNode.removeChild(steps);
        if (mirror.parentNode) mirror.parentNode.removeChild(mirror);
        if (wrap.parentNode) {
          wrap.parentNode.insertBefore(field, wrap);
          wrap.parentNode.removeChild(wrap);
        }
        field.__numberInput = null;
        field.__niTeardown = true;
        teardown.push(field);
        mounted = mounted.filter(function (m) { return m !== api; });
      },
    };
    field.__numberInput = api;
    mounted.push(api);
    return api;
  }

  function scan(root) {
    // A host that redraws its screen (cents. rebuilds the app shell on every
    // route change; Content Tracker replaces the goal card after Set) leaves the
    // old mount observing a detached field, and its window resize listener would
    // stay registered for the life of the page — one per redraw. Drop the dead
    // mounts before adding the replacement.
    mounted.slice().forEach(function (m) {
      if (!m.input.isConnected) m.destroy();
    });

    var list = [];
    if (root.matches && root.matches('input[data-number-input]')) list.push(root);
    if (root.querySelectorAll) {
      list = list.concat(Array.prototype.slice.call(root.querySelectorAll('input[data-number-input]')));
    }
    list.forEach(function (el) { if (!el.__niTeardown) mount(el); });
  }

  /* The mirror paints the host's colour, copied from the field, because its
     glyphs are hidden with text-fill. A theme flip changes that colour without
     touching the field's attributes, so the kit watches the document element
     and the colour-scheme media query and re-reads it. */
  function watchTheme() {
    if (global.MutationObserver) {
      new global.MutationObserver(function () {
        mounted.forEach(function (m) { m.refresh(); });
      }).observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    }
    if (global.matchMedia) {
      var mq = global.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { mounted.forEach(function (m) { m.refresh(); }); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
  }

  function boot() {
    scan(doc.body);
    watchTheme();
    if (!global.MutationObserver) return;
    var queue = [];
    var raf = 0;
    new global.MutationObserver(function (records) {
      Array.prototype.forEach.call(records, function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (node) {
          if (node.nodeType === 1) queue.push(node);
        });
      });
      if (!queue.length || raf) return;
      raf = global.requestAnimationFrame(function () {
        raf = 0;
        var batch = queue;
        queue = [];
        batch.forEach(scan);
        teardown.splice(0).forEach(function (el) { el.__niTeardown = false; });
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.NumberInput = {
    mount: mount,
    refresh: function () { mounted.forEach(function (m) { m.refresh(); }); },
  };

})(window);
