/* Envelope garden — each budgeted category as a plant in a bed.
 *
 * The stems are `settings.categoryBudgets` against this month's spend in that
 * category, which is the same pair the Budget bar and the Insights categories
 * read. A stem that reaches its cap is at its limit; one that overflows is
 * taller than the bed. Pointing at a stem reads category, spent and limit; the
 * figures and the Insights list remain the exact source.
 *
 * Wrapped in an IIFE: three figures share one page and the engine's figures are
 * written at top level.
 */
(function () {
const {
  Cam, facing, fit, hull, open, poly, proj, rrect, ringAt, run,
  disposer, mk, pointer,
} = HL;

const MAX = 6;
const Z = 4;

function boxAt(parent, P, front, cx, cy, hw, hd, z0, z1, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.5, cy - hd + 0.5, cx + hw - 0.5, cy + hd - 0.5, Math.max(0.4, r - 0.5), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
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
  fit(C, [[-52, -20, 0], [52, 20, 0], [-52, -20, 12], [52, 20, 12]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let items = [];
  let stems = [];
  let selected = -1;
  let signature = null;

  function readDefault() {
    const n = items.length;
    const over = items.filter((x) => x.limit > 0 && x.spent > x.limit).length;
    read.textContent = n
      ? (over ? `${n} ${n === 1 ? 'envelope' : 'envelopes'} · ${over} over` : `${n} ${n === 1 ? 'envelope' : 'envelopes'} · all within budget`)
      : 'No category budgets set';
    stage.setAttribute(
      'aria-label',
      n
        ? `${n} budget ${n === 1 ? 'envelope' : 'envelopes'} as ${n === 1 ? 'a plant' : 'plants'}. Point at ${n === 1 ? 'it' : 'one'} to read its category, spend and limit.`
        : 'No category budgets are set yet.',
    );
  }

  function build() {
    root.replaceChildren();
    selected = -1;
    stems = [];

    const bed = boxAt(root, P, front, 0, 0, 50, 16, 0, 1.4, 4);
    mk('path', { d: open([P(-46, -10, 1.45), P(46, -10, 1.45)]), class: 'nf dash' }, bed.g);

    if (!items.length) {
      readDefault();
      return;
    }

    const step = items.length > 1 ? 84 / (items.length - 1) : 0;
    items.forEach((item, i) => {
      const x = -42 + i * step;
      const ratio = item.limit > 0 ? Math.max(0, item.spent / item.limit) : 0;
      const h = 6.5 + Math.min(ratio, 1.3) * 10;
      const stem = boxAt(root, P, front, x, 0, 2.2, 2.2, 1.4, h, 0.8);
      const cap = boxAt(root, P, front, x, 0, 7, 4.5, h, h + 3.2, 1.6);
      stems.push({ item, i, x, h, stem, cap, ratio });
    });

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    stems.forEach((s, k) => {
      const on = k === i;
      s.stem.sil.setAttribute('class', on ? 'sil hi' : 'sil');
      s.cap.sil.setAttribute('class', on ? 'sil hi' : 'sil');
      s.cap.cr.setAttribute('class', on ? 'nf lo hi' : 'nf lo');
    });
    if (i < 0) {
      readDefault();
      return;
    }
    const s = stems[i];
    read.textContent = `${s.item.label} · ${money(s.item.spent)} of ${money(s.item.limit)}`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], 6);
    let best = -1, distance = Infinity;
    stems.forEach((s, i) => {
      const d = Math.abs(u - s.x);
      if (d < distance && d <= 7.5 && Math.abs(v) <= s.h + 8) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const list = (Array.isArray(next) ? next : []).slice(0, MAX).map((x) => ({
      label: String(x && x.label ? x.label : ''),
      spent: Number(x && x.spent) || 0,
      limit: Number(x && x.limit) || 0,
    })).filter((x) => x.label && x.limit > 0);
    const sig = list.map((x) => `${x.label}:${x.spent}:${x.limit}`).join('|');
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
  name: 'envelope-garden',
  means: 'Budget categories as plants in a bed; point at one to read its spend and limit.',
  rules: [1, 4, 6, 8],
  range: [0, 6, 1],
  tour: [[150, 150], [200, 120], [260, 170], [310, 200], null],
  mount,
});
})();
