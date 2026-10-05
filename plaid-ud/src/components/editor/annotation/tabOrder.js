// Tab in the grid walks a sentence row by row (every LEMMA, then every XPOS,
// UPOS and FEATS), then on into the next sentence. Each cell carries its place
// in that walk as `data-tab-order`, and Tab moves to the cell with the next
// number. The cells used to carry the number as a positive `tabindex`, which
// put every cell of the page ahead of the header, the tabs and the sentence
// toolbars in the page's own Tab order.

const ORDERED = '[data-tab-order]';

/**
 * Tab and Shift+Tab from a grid cell, for the keydown listener above the
 * sentences. Past the last cell (or before the first) the key is left to the
 * browser, which moves on out of the grid.
 */
export function routeGridTab(event) {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const from = event.target;
  const here = Number(from?.dataset?.tabOrder);
  if (!Number.isFinite(here)) return;
  const back = event.shiftKey;
  let best = null;
  let bestOrder = back ? -Infinity : Infinity;
  for (const cell of event.currentTarget.querySelectorAll(ORDERED)) {
    if (cell.disabled) continue;
    const order = Number(cell.dataset.tabOrder);
    if (back ? order < here && order > bestOrder : order > here && order < bestOrder) {
      best = cell;
      bestOrder = order;
    }
  }
  if (!best) return;
  event.preventDefault();
  best.focus();
}
