// The one row ordering every sortable list shares: DataTable's, and a hand-made
// list of editable rows that cannot use DataTable.

/**
 * Order two values, with a missing one counting as the smallest.
 *
 * A blank participates in the ordering rather than being pinned to one end,
 * so it flips with the column like every other value. That is what the data
 * usually means: a project with no last change is the least recently changed
 * one, so ascending "Last change" puts it first and descending puts it last.
 */
const compareSortValues = (a, b, own) => {
  if (a === b) return 0;
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing ? -1 : 1;
  if (own) return own(a, b);
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return a < b ? -1 : 1;
};

/**
 * `rows` sorted on a COPY by `column.sort(row)` (and `column.compare` when it
 * has one) in `dir` ('asc' or 'desc'). The key is the tiebreak, always
 * ascending, so equal values keep a stable order instead of shuffling between
 * renders.
 */
export const sortRows = (rows, column, dir, rowKey) => {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compareSortValues(column.sort(a), column.sort(b), column.compare);
    return primary !== 0 ? primary * sign : compareSortValues(rowKey(a), rowKey(b));
  });
};
