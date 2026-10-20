/* Boot watchdog. External because the app's CSP allows no inline script; it
   runs before the module bundle and paints the failure panel if the bundle
   never reaches its boot flag (a parse error, a missing chunk, a stale cache).
   It says nothing when the app boots. */
(function () {
  window.__centsBooted = false;
  setTimeout(function () {
    if (window.__centsBooted) return;
    var panel = document.getElementById('boot-fail');
    if (panel && panel.hasAttribute('hidden')) panel.removeAttribute('hidden');
  }, 3000);
})();
