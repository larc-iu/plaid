// How far down the window the page's pinned chrome reaches: the app header,
// and the document's tab row while it is pinned under it. A popover placed
// against the window keeps below it (Radix `collisionPadding`), where it was
// drawn over them and its first rows were hidden.
const CHROME = 'header, [data-testid="document-tab-row"]';

export const stickyChromeBottom = () => {
  if (typeof document === 'undefined') return 0;
  let bottom = 0;
  // In page order, each stacked on the one before: the tab row counts only
  // while it sits right under the header.
  for (const el of document.querySelectorAll(CHROME)) {
    const position = getComputedStyle(el).position;
    if (position !== 'sticky' && position !== 'fixed') continue;
    const box = el.getBoundingClientRect();
    if (box.top <= bottom + 1 && box.bottom > bottom) bottom = box.bottom;
  }
  return bottom;
};
