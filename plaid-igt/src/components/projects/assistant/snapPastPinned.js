// The centring cuts the column under the pinned labels' edge partway, so a
// sliver of the neighbouring word showed beside them. Snap that edge to the
// nearer side of the column, so the column is whole or hidden, as long as
// the cited columns stay in view. Positions are in the scroller's content,
// which stays LTR. `columns` are each word's left and right, `cited` the
// cited span's, `pinned` the labels' width.
export const snapPastPinned = (scrollLeft, { columns, cited, viewport, max, pinned, rtl }) => {
  const free = viewport - pinned;
  const edge = rtl ? scrollLeft + free : scrollLeft + pinned;
  const cut = columns.find((col) => col.left < edge - 0.5 && col.right > edge + 0.5);
  if (!cut) return scrollLeft;
  const at = (x) => (rtl ? x - free : x - pinned);
  const fits = (s) => {
    const start = rtl ? s : s + pinned;
    return s >= 0 && s <= max && cited.left >= start - 0.5 && cited.right <= start + free + 0.5;
  };
  return (
    [at(cut.left), at(cut.right)]
      .sort((a, b) => Math.abs(a - scrollLeft) - Math.abs(b - scrollLeft))
      .find(fits) ?? scrollLeft
  );
};
