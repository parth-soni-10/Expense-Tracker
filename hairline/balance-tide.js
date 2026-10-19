/* Balance tide — the running balance as water rising and falling.
 *
 * The columns are the same `points` the net-worth sparkline draws: one per
 * entry date, plus today, computed by the dashboard's own
 * `accountBalanceHistory()` helper. Pointing at a column reads that date and
 * balance; the balance figures above remain the exact, keyboard-accessible
 * source.
 *
 * Wrapped in an IIFE: the engine's figures are written at top level, and three
 * of them on one page would collide on their destructured names.
 */
(function () {
const {
  Cam, facing, fit, hull, open, poly, proj, rrect, ringAt, run, seg,
  disposer, mk, pointer,
} = HL;

const MAX = 14;
const Z = 3.4;

/** A rounded box, drawn from its foot and top rings. */
function boxAt(parent, P, front, cx, cy, hw, hd, z0, z1, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.6, cy - hd + 0.6, cx + hw - 0.6, cy + hd - 0.6, Math.max(0.5, r - 0.6), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
  return { g, sil, cr, foot, top };
}

function readDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso) + 'T00:00:00');
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return '€' + n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const C = Cam(45, 0.5, 3.3);
  fit(C, [[-52, -20, 0], [52, 20, 0], [-52, -20, 10], [52, 20, 10]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let items = [];
  let columns = [];
  let points = [];
  let selected = -1;
  let signature = null;

  function readDefault() {
    const n = items.length;
    const last = n ? items[n - 1] : null;
    read.textContent = n ? `${n} days · ${last ? money(last.value) : '—'}` : 'No balance history yet';
    stage.setAttribute(
      'aria-label',
      n
        ? `The running balance over ${n} days. Point at a column to read its date and balance.`
        : 'No balance history yet — a few entries will draw the tide.',
    );
  }

  function build() {
    root.replaceChildren();
    selected = -1;
    columns = [];
    points = [];

    const plate = boxAt(root, P, front, 0, 0, 49, 14, 0, 1.2, 4);
    mk('path', { d: seg(P(-44, 0, 1.25), P(44, 0, 1.25)), class: 'nf dash' }, plate.g);

    const usable = items.filter((x) => Number.isFinite(Number(x.value)));
    if (!usable.length) {
      readDefault();
      return;
    }

    const values = usable.map((x) => Number(x.value));
    const min = Math.min(0, ...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = usable.length > 1 ? 88 / (usable.length - 1) : 0;
    const hw = Math.min(3.2, Math.max(1.2, step * 0.32));

    usable.forEach((item, i) => {
      const x = -44 + i * step;
      const z = 1.2 + ((Number(item.value) - min) / span) * 13;
      const box = boxAt(root, P, front, x, 0, hw, 4, 1.2, z, 0.8);
      const col = { item, i, x, z, sil: box.sil, cr: box.cr };
      columns.push(col);
      points.push({ x, y: 0, z, item });
    });

    mk('path', { d: open(points.map((p) => P(p.x, p.y, p.z + 0.35))), class: 'sil' }, root);

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    columns.forEach((col, k) => {
      col.sil.setAttribute('class', k === i ? 'sil hi' : 'sil');
      col.cr.setAttribute('class', k === i ? 'nf lo hi' : 'nf lo');
    });
    if (i < 0) {
      readDefault();
      return;
    }
    const item = columns[i].item;
    read.textContent = `${readDate(item.date)} · ${money(item.value)}`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], 7);
    let best = -1, distance = Infinity;
    columns.forEach((col, i) => {
      const d = Math.abs(u - col.x);
      if (d < distance && d <= 8 && Math.abs(v) <= 18) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const list = (Array.isArray(next) ? next : []).slice(-MAX).map((p) => ({
      date: p && p.date ? String(p.date) : '',
      value: p ? p.balance : null,
    }));
    const sig = list.map((x) => `${x.date}:${x.value}`).join('|');
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
  name: 'balance-tide',
  means: 'The running balance drawn as a tide: one column per day, read on pointer.',
  rules: [1, 4, 6, 8],
  range: [0, 14, 1],
  tour: [[150, 160], [200, 130], [260, 170], [310, 200], null],
  mount,
});
})();
