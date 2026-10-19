/* Receipt constellation — the last few entries as points in the dark.
 *
 * The points are the newest entries the History list shows, one point per
 * entry, its height set by the amount and its position by age. Pointing at a
 * point reads the entry's details and amount; the History list remains the
 * exact, keyboard-accessible source.
 *
 * Wrapped in an IIFE: three figures share one page and the engine's figures are
 * written at top level.
 */
(function () {
const {
  Cam, facing, fit, open, poly, proj, rrect, ringAt, run, seg,
  disposer, mk, pointer,
} = HL;

const MAX = 9;
const Z = 4.2;

function plateAt(parent, P, front, cx, cy, hw, hd, z, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.4, cy - hd + 0.4, cx + hw - 0.4, cy + hd - 0.4, Math.max(0.3, r - 0.4), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(ringAt(P, foot, z).concat(ringAt(P, top, z + 0.5))) }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z + 0.5)) }, g);
  return { g, sil, cr };
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return '€' + n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const C = Cam(45, 0.5, 3.3);
  fit(C, [[-54, -30, 0], [54, 30, 0], [-54, -30, 12], [54, 30, 12]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let items = [];
  let stars = [];
  let selected = -1;
  let signature = null;

  function readDefault() {
    const n = items.length;
    read.textContent = n ? `${n} recent entries` : 'No entries yet';
    stage.setAttribute(
      'aria-label',
      n
        ? `${n} recent entries as points. Point at one to read its details and amount.`
        : 'No entries have been logged yet.',
    );
  }

  function build() {
    root.replaceChildren();
    selected = -1;
    stars = [];

    const disc = plateAt(root, P, front, 0, 0, 46, 26, 0, 10);
    disc.sil.setAttribute('class', 'sil');
    disc.cr.setAttribute('class', 'nf lo');

    if (!items.length) {
      readDefault();
      return;
    }

    const amounts = items.map((x) => Math.abs(Number(x.amount) || 0));
    const max = Math.max(1, ...amounts);
    const n = items.length;
    items.forEach((item, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
      const radius = 26 + (i % 2) * 6;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius * 0.7;
      const z = 4 + (amounts[i] / max) * 8;
      const [sx, sy] = P(x, y, z);
      const star = mk('g', {}, root);
      const line = mk('path', { d: seg(P(x * 0.25, y * 0.25, 1), P(x, y, z)), class: 'nf lo' }, star);
      const dot = mk('circle', { cx: sx.toFixed(2), cy: sy.toFixed(2), r: 3, class: 'dot off' }, star);
      stars.push({ item, i, x, y, z, line, dot });
    });

    mk('path', { d: open(stars.map((s) => P(s.x, s.y, s.z))), class: 'sil' }, root);

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    stars.forEach((s, k) => {
      s.dot.setAttribute('class', k === i ? 'dot' : 'dot off');
      s.line.setAttribute('class', k === i ? 'nf hi' : 'nf lo');
    });
    if (i < 0) {
      readDefault();
      return;
    }
    const s = stars[i];
    const title = s.item.title || 'Entry';
    read.textContent = `${title} · ${money(s.item.amount)}`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], 8);
    let best = -1, distance = Infinity;
    stars.forEach((s, i) => {
      const d = Math.hypot(u - s.x, v - s.y);
      if (d < distance && d <= 8) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const list = (Array.isArray(next) ? next : []).slice(0, MAX).map((e) => ({
      title: String(e && (e.title || e.details || e.name) ? (e.title || e.details || e.name) : 'Entry'),
      amount: Number(e && e.amount) || 0,
      date: e && e.date ? String(e.date) : '',
    }));
    const sig = list.map((x) => `${x.title}:${x.amount}:${x.date}`).join('|');
    if (sig === signature) return;
    signature = sig;
    items = list;
    build();
  }

  bag.add(pointer(stage, {
    move: (p) => highlight(pick(p)),
    down: (p) => highlight(pick(p)),
    leave: () => highlight(-1),
  }));
  bag.add(() => root.replaceChildren());

  set(value);
  return { set, destroy: bag.dispose };
}

hairline({
  name: 'receipt-constellation',
  means: 'Recent entries as points in a constellation; point at one to read its details and amount.',
  rules: [1, 4, 6, 8],
  range: [0, 9, 1],
  tour: [[150, 150], [200, 120], [260, 170], [310, 200], null],
  mount,
});
})();
