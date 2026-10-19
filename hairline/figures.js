/* Cents' three figures, mounted together.
 *
 * One call from the dashboard render, with the numbers that render already
 * computed: `balances` is computeBalance()'s own points plus today,
 * `envelopes` is the month's category budget against its spend, and `receipts`
 * is the newest entries. Nothing is read twice, so a figure cannot disagree
 * with the card beside it.
 *
 * The hosts are created by the dashboard (app.js) — if the first call happens
 * before they are in the document, the mount retries on the next frame instead
 * of silently doing nothing.
 */
(function () {
  var HOSTS = [
    { host: 'cents-balance-tide', name: 'balance-tide', key: 'balances' },
    { host: 'cents-envelope-garden', name: 'envelope-garden', key: 'envelopes' },
    { host: 'cents-receipt-constellation', name: 'receipt-constellation', key: 'receipts' },
  ];
  var handles = {};
  var pending = null;
  var retry = 0;

  function allPresent() {
    return HOSTS.every(function (h) { return document.getElementById(h.host); });
  }

  function paint(data) {
    HOSTS.forEach(function (h) {
      var value = data && data[h.key];
      if (handles[h.name]) {
        if (handles[h.name].set) handles[h.name].set(Array.isArray(value) ? value : []);
        return;
      }
      var handle = window.mountHairline(h.host, Array.isArray(value) ? value : [], h.name);
      if (handle) handles[h.name] = handle;
    });
  }

  window.mountCentsFigures = function (data) {
    pending = data;
    retry = 0;
    if (allPresent()) {
      paint(pending);
      return;
    }
    window.requestAnimationFrame(function () {
      if (allPresent()) paint(pending);
      else if (retry++ < 3) window.setTimeout(function () { window.mountCentsFigures(pending); }, 40);
    });
  };
})();
