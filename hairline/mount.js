/* The bench, minus the bench — Cents' variant, with a registry.
 *
 * A Hairline figure is written against the skill's bench page: it is handed a
 * stage, an svg and a read-out, and it owns nothing else. This is that contract
 * without the slider, the theme switch and the play button, so a figure can
 * mount inside a real card.
 *
 * Unlike the one-figure sites, Cents mounts three. The bench's `hairline()`
 * keeps the last-registered figure in a single variable; here the registration
 * is a registry keyed by the figure's own `name`, and `mountHairline()` takes
 * that name. Three figures therefore load in any order and none can mount into
 * another's card.
 *
 * No HL.inject() here: the bench injects its palette as a stylesheet, and this
 * site sends style-src 'self'. The same rules live in styles.css mapped onto
 * this site's tokens, so nothing is written at runtime.
 */
(function () {
  var figures = {};

  /** What the bench calls when a figure file loads. */
  window.hairline = function (f) {
    if (f && f.name) figures[f.name] = f;
  };

  /** Mount the named figure into an element. Returns the handle, or null. */
  window.mountHairline = function (hostId, value, name) {
    var host = document.getElementById(hostId);
    var figure = name ? figures[name] : null;
    if (!host || !figure || typeof HL === 'undefined') return null;
    host.replaceChildren();
    host.setAttribute('data-hairline', figure.name);
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', figure.means);
    var svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, host);
    var out = host.parentElement && host.parentElement.querySelector('[data-hairline-read]');
    var text = '';
    var read = {
      get textContent() { return text; },
      set textContent(v) { text = v == null ? '' : String(v); if (out) out.textContent = text; },
    };
    var handle = figure.mount({ stage: host, svg: svg, read: read }, value);
    if (text === '') read.textContent = 'rest';
    return handle;
  };
})();
