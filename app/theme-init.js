/* Theme before first paint. Classic script (not a module) so it runs before the
   stylesheets and the app bundle on every browser; external because the app's
   CSP is script-src 'self' with no inline allowance. */
(function () {
  var stored = localStorage.getItem('cents-theme');
  // Light is the default: the stylesheet's `:root` is the light palette and
  // `[data-theme="dark"]` overrides it, so the attribute is only written
  // for a device that has chosen dark.
  if (stored === 'dark') document.documentElement.dataset.theme = 'dark';

  var schemeMeta = document.querySelector('meta[name="color-scheme"]');
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  function syncChrome() {
    var dark = document.documentElement.dataset.theme === 'dark';
    if (schemeMeta) schemeMeta.content = dark ? 'dark' : 'light';
    if (themeMeta) themeMeta.content = dark ? '#101210' : '#F5F5F2';
  }
  syncChrome();
  new MutationObserver(syncChrome).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
})();
