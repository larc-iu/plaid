/**
 * A table cell's value that is still being worked out: a muted ellipsis, the
 * cell-sized form of the "Loading…" line (a cell has no room for the word).
 * `data-loading` marks it for tests that wait for a column to fill.
 */
export const PendingCell = () => (
  <span data-loading="" className="text-muted-foreground">
    <span aria-hidden="true">…</span>
    <span className="sr-only">Loading</span>
  </span>
);
