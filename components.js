/* Cents — component host upgrades.
 *
 * `ui.js` installs everything declared with `data-ui` and the app writes those
 * attributes where its own render already knows the data. The one host that
 * cannot be declared in app.js is the Tesco stat cell: `tesco.js` paints it
 * from inside the lazily imported screen, and that file belongs to another
 * in-flight change. Upgrading it here keeps this pass out of that file and
 * still binds the component to the live figure (the node is the one paintStats
 * writes).
 *
 * Loaded AFTER app.js, so the boot-payload guard still treats app.js as the
 * entry module.
 */

import { scan } from './ui.js';

const LABEL = 'Anticipated (est. net)';

function labelOf(cell) {
  return (cell.firstElementChild?.textContent || '').replace(/\s+/g, ' ').trim();
}

function upgradeTesco() {
  const grid = document.querySelector('.tesco-stats-grid');
  if (!grid) return;
  const cells = [...grid.querySelectorAll('.tesco-stat')];
  const cell = cells.find((node) => labelOf(node) === LABEL);
  const value = cell?.querySelector('.tesco-stat-value');
  if (!cell || !value || cell.dataset.ui) return;

  cell.setAttribute('data-ui', 'fund-widget');
  cell.setAttribute('data-ui-label', 'est. net');
  value.setAttribute('data-ui-value', '');
  cell.setAttribute('role', 'button');
  cell.setAttribute('tabindex', '0');
  cell.setAttribute('aria-label', `Anticipated net pay ${value.textContent}. Jump to pay weeks.`);

  // The same figure the card already prints; this only takes a reader to the
  // weeks it is made of. The real fold button remains the keyboard path there.
  const jump = () => {
    const target = [...document.querySelectorAll('.tesco-section .eyebrow, .tesco-section h2, .tesco-section .tesco-fold-btn')]
      .find((node) => /pay week/i.test(node.textContent || ''));
    target?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  };
  cell.addEventListener('click', jump);
  cell.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    jump();
  });

  // Install just this new host; the rest of the screen was already scanned by
  // ui.js's observer.
  scan(grid);
}

function upgrade() {
  upgradeTesco();
}

window.addEventListener('cents:rendered', upgrade);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', upgrade);
else upgrade();
