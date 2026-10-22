/* Slide Commit — a slide-to-confirm handle in place of a blocking confirm().
 *
 * The gesture is the confirmation: a drag that returns true only when the knob
 * reaches the end of the rail. A tap cannot do it, so the dialog is harder to
 * get past than a Confirm button was, not easier.
 *
 * Keyboard is a first-class path, not a fallback: the rail is a real <button>,
 * Enter/Space arms it ("Press again to reset") and a second press commits. The
 * armed window closes itself after four seconds. Arrow keys slide the knob a
 * third at a time, so the same gesture exists without a pointer.
 *
 *   var ok = await SlideCommit.ask({
 *     title: 'Reset all data?',
 *     text:  'This clears every entry on this device.',
 *     label: 'Slide to reset',
 *     done:  'Reset',
 *   });
 *
 * Resolves true as the done pill appears (the caller's work then runs while the
 * pill is still on screen), false on Escape, Cancel, a backdrop tap or an
 * unfinished drag.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var NS = 'http://www.w3.org/2000/svg';
  var ARM_MS = 4000;      // keyboard armed window
  var SNAP_MS = 260;      // rail snap, then the handle spins
  var SPIN_MS = 420;      // "the action is running" beat
  var DONE_MS = 620;      // done pill stays this long before the sheet closes
  var COMMIT_AT = 0.82;   // share of the rail that counts as a commit

  var live = null;        // the one open sheet

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function make(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function strokePath(d) {
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  // "Slide to reset" -> "reset", so the armed label reads like the gesture.
  function verbOf(opts) {
    if (opts.press) return opts.press;
    var m = /^slide to\s+(.+)$/i.exec(String(opts.label || ''));
    return m ? m[1] : String(opts.done || 'confirm').toLowerCase();
  }

  function build(opts, resolve) {
    var prevFocus = doc.activeElement;
    var prevOverflow = doc.documentElement.style.overflow;
    var label = opts.label || 'Slide to confirm';
    var done = opts.done || 'Done';
    var verb = verbOf(opts);

    var scrim = make('div', 'sc-scrim');
    var sheet = make('div', 'sc-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'sc-title');
    if (opts.text) sheet.setAttribute('aria-describedby', 'sc-text');

    sheet.appendChild(make('h2', 'sc-title', opts.title || 'Are you sure?')).id = 'sc-title';
    if (opts.text) sheet.appendChild(make('p', 'sc-text', opts.text)).id = 'sc-text';

    var track = make('button', 'sc-track');
    track.type = 'button';
    track.setAttribute('aria-describedby', 'sc-hint');

    var fill = make('span', 'sc-fill');
    fill.setAttribute('aria-hidden', 'true');
    var labelEl = make('span', 'sc-label', label);
    var knob = make('span', 'sc-knob');
    knob.setAttribute('aria-hidden', 'true');
    var arrow = make('span', 'sc-ico sc-ico-arrow');
    arrow.appendChild(strokePath('M5 12h13M13 6l6 6-6 6'));
    var spinner = make('span', 'sc-spinner');
    var check = make('span', 'sc-ico sc-ico-check');
    check.appendChild(strokePath('M4 12.5l5.5 5.5L20 7'));
    knob.appendChild(arrow);
    knob.appendChild(spinner);
    knob.appendChild(check);

    track.appendChild(fill);
    track.appendChild(labelEl);
    track.appendChild(knob);

    var hint = make('p', 'sc-hint', opts.hint || 'Drag the handle to the end, or press Enter twice.');
    hint.id = 'sc-hint';

    var cancel = make('button', 'sc-cancel', opts.cancelText || 'Cancel');
    cancel.type = 'button';

    var announce = make('p', 'sc-live');
    announce.setAttribute('aria-live', 'polite');

    sheet.appendChild(track);
    sheet.appendChild(hint);
    sheet.appendChild(cancel);
    sheet.appendChild(announce);
    scrim.appendChild(sheet);
    doc.body.appendChild(scrim);

    var prev = doc.documentElement.style.overflow;
    doc.documentElement.style.overflow = 'hidden';

    live = {
      opts: opts, resolve: resolve, settled: false,
      scrim: scrim, sheet: sheet, track: track, label: labelEl, hint: hint,
      cancel: cancel, announce: announce, knob: knob,
      phase: 'idle', armed: false, dragging: false,
      pos: 0, max: 0, startX: 0,
      prevFocus: prevFocus, armTimer: 0, timers: [],
    };

    measure(live);
    paint(live);

    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
    track.addEventListener('keydown', onKey);
    cancel.addEventListener('click', function () { settle(false); });
    scrim.addEventListener('pointerdown', function (ev) {
      if (ev.target === scrim) settle(false);
    });
    doc.addEventListener('keydown', onDocKey, true);
    global.addEventListener('resize', onResize);

    // Focus without scrolling: the sheet is already where the eye lands. The
    // second attempt is for hosts that close their own menu (and hand focus
    // back to its trigger) after the sheet has already mounted.
    var takeFocus = function () {
      if (!live || live.track !== track) return;
      if (sheet.contains(doc.activeElement)) return;
      try { track.focus({ preventScroll: true }); } catch (err) { track.focus(); }
    };
    takeFocus();
    if (global.requestAnimationFrame) global.requestAnimationFrame(takeFocus);

    return live;
  }

  function measure(s) {
    var cs = global.getComputedStyle(s.track);
    var pad = parseFloat(cs.paddingLeft) || 0;
    s.max = Math.max(0, s.track.clientWidth - s.knob.offsetWidth - pad * 2);
    s.rail = s.track.clientWidth - s.knob.offsetWidth - pad * 2;
    s.pad = pad;
  }

  function paint(s) {
    var max = s.max || 1;
    var p = clamp(s.pos / max, 0, 1);
    s.track.style.setProperty('--sc-p', String(p));
    s.track.style.setProperty('--sc-x', (s.pos || 0) + 'px');
    // The fill reaches the knob's centre, so the colour arrives with the handle.
    s.track.style.setProperty('--sc-w', ((s.pos || 0) + s.knob.offsetWidth / 2 + s.pad) + 'px');
  }

  function onDown(ev) {
    var s = live;
    if (!s || (s.phase !== 'idle' && s.phase !== 'armed')) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    measure(s);
    s.dragging = true;
    s.startX = ev.clientX - s.pos;
    s.track.classList.add('is-dragging');
    disarm();
    try { s.track.setPointerCapture(ev.pointerId); } catch (err) { /* no capture: fine */ }
    ev.preventDefault();
  }

  function onMove(ev) {
    var s = live;
    if (!s || !s.dragging) return;
    s.pos = clamp(ev.clientX - s.startX, 0, s.max);
    paint(s);
  }

  function onUp(ev) {
    var s = live;
    if (!s || !s.dragging) return;
    s.dragging = false;
    s.track.classList.remove('is-dragging');
    try { s.track.releasePointerCapture(ev.pointerId); } catch (err) { /* already released */ }
    if (s.max > 0 && s.pos >= s.max * COMMIT_AT) commit();
    else snapBack();
  }

  function snapBack() {
    var s = live;
    if (!s) return;
    s.pos = 0;
    paint(s);
    if (s.phase === 'armed') disarm();
  }

  function onKey(ev) {
    var s = live;
    if (!s) return;
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      if (s.phase !== 'idle' && s.phase !== 'armed') return;
      if (s.armed) commit();
      else arm();
      return;
    }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      if (s.phase !== 'idle' && s.phase !== 'armed') return;
      disarm();
      measure(s);
      // Three presses cross the rail; a press that reaches the end commits, the
      // same as a drag that reaches the end. Nothing snaps back on its own, so
      // repeated presses accumulate instead of fighting a timer.
      var step = Math.max(28, s.max / 3);
      s.pos = clamp(s.pos + (ev.key === 'ArrowRight' ? step : -step), 0, s.max);
      paint(s);
      if (s.pos >= s.max) commit();
    }
  }

  function arm() {
    var s = live;
    if (!s || s.armed) return;
    s.armed = true;
    s.track.classList.add('is-armed');
    s.label.textContent = 'Press again to ' + verbOf(s.opts);
    s.hint.textContent = 'Enter or Space again to confirm. Escape cancels.';
    s.announce.textContent = 'Armed. Press Enter again to ' + verbOf(s.opts) + '.';
    s.armTimer = global.setTimeout(disarm, ARM_MS);
  }

  function disarm() {
    var s = live;
    if (!s || !s.armed) return;
    s.armed = false;
    global.clearTimeout(s.armTimer);
    s.track.classList.remove('is-armed');
    s.label.textContent = s.opts.label || 'Slide to confirm';
    s.hint.textContent = s.opts.hint || 'Drag the handle to the end, or press Enter twice.';
    s.announce.textContent = '';
  }

  function commit() {
    var s = live;
    if (!s || (s.phase !== 'idle' && s.phase !== 'armed')) return;
    s.phase = 'commit';
    disarm();
    measure(s);
    s.pos = s.max;
    s.track.classList.add('is-dragging');
    s.track.classList.add('is-committing');
    paint(s);
    s.label.textContent = s.opts.busy || 'Working\u2026';
    s.announce.textContent = s.label.textContent;

    var beat = reduced() ? 40 : SNAP_MS;
    s.timers.push(global.setTimeout(function () {
      if (!live || live !== s) return;
      s.track.classList.remove('is-dragging');
      s.track.classList.add('is-spin');
      s.timers.push(global.setTimeout(finish, reduced() ? 60 : SPIN_MS));
    }, beat));
  }

  function finish() {
    var s = live;
    if (!s || s.phase !== 'commit') return;
    s.phase = 'done';
    s.track.classList.remove('is-spin');
    s.track.classList.add('is-done');
    s.label.textContent = s.opts.done || 'Done';
    s.sheet.classList.add('is-committed');
    s.hint.textContent = s.opts.doneText || 'Done.';
    s.announce.textContent = s.label.textContent;
    s.track.setAttribute('aria-disabled', 'true');
    // Focus stays on the rail: the Cancel button is already fading out, and a
    // focus ring on an invisible button is worse than no announcement at all.
    if (!s.settled) {
      s.settled = true;
      s.resolve(true);   // the caller's work starts here, under the pill
    }
    s.timers.push(global.setTimeout(function () {
      if (live && live === s) close();
    }, reduced() ? 320 : DONE_MS));
  }

  function settle(answer) {
    var s = live;
    if (!s) return;
    clearTimers(s);
    if (!s.settled) {
      s.settled = true;
      s.resolve(answer);
    }
    close();
  }

  function clearTimers(s) {
    global.clearTimeout(s.armTimer);
    s.timers.forEach(global.clearTimeout);
    s.timers = [];
  }

  function close() {
    var s = live;
    if (!s) return;
    live = null;
    clearTimers(s);
    doc.removeEventListener('keydown', onDocKey, true);
    global.removeEventListener('resize', onResize);
    s.scrim.classList.add('is-closing');
    var done = function () {
      if (s.scrim.parentNode) s.scrim.parentNode.removeChild(s.scrim);
      doc.documentElement.style.overflow = s.prevOverflow;
      var back = s.prevFocus;
      if (back && back.focus && doc.contains(back)) {
        try { back.focus({ preventScroll: true }); } catch (err) { back.focus(); }
      }
    };
    if (reduced()) done();
    else global.setTimeout(done, 160);
  }

  function onDocKey(ev) {
    var s = live;
    if (!s) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (s.phase === 'idle' || s.phase === 'armed') settle(false);
      return;
    }
    if (ev.key === 'Tab') {
      var stops = [s.track, s.cancel].filter(function (n) { return !n.disabled && n.tabIndex !== -1; });
      if (!stops.length) return;
      var first = stops[0];
      var last = stops[stops.length - 1];
      var active = doc.activeElement;
      if (ev.shiftKey && (active === first || !s.sheet.contains(active))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (active === last || !s.sheet.contains(active))) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  function onResize() {
    var s = live;
    if (!s || s.phase !== 'idle') return;
    measure(s);
    s.pos = clamp(s.pos, 0, s.max);
    paint(s);
  }

  global.SlideCommit = {
    ask: function (opts) {
      return new Promise(function (resolve) {
        if (live) settle(false);
        build(opts || {}, resolve);
      });
    },
    isOpen: function () { return !!live; },
  };
})(window);
