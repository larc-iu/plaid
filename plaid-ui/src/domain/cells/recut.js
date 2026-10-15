// Whether a row whose text changed since a value was typed for it was split,
// joined or merged (its boundaries changed), or only respelled.
//
// `was` and `now` are `{ text, before, after }`: the row's text and the ids of
// the rows on either side of it, as they read when the value was typed and as
// they read now. A split leaves a new row beside the kept one, and a join or
// merge takes a row beside it away, so a row whose text changed and that has
// a neighbour new or gone was re-cut, whatever its text now is (the cut can
// also re-case or respell the kept part, or keep its id on a middle piece). A
// respelling keeps both neighbours. A respelling made while a neighbour was
// split or deleted reads as a re-cut, which errs toward not writing.
//
// After a split, join or merge the value was typed for a row that is gone, so
// the cell keeps nothing on Enter. After a respelling the conflict is the
// plain one, whose typed value Enter keeps (Luke, 2026-10-15, H16-UI-CORE-3,
// REV-UI-1).

import { settledId } from '../pendingIds.js';

const same = (a, b) => (a == null ? null : settledId(a)) === (b == null ? null : settledId(b));

/** Whether the row went from `was` to `now` by a split, join or merge. */
export const reshaped = (was, now) =>
  !!was &&
  !!now &&
  was.text !== now.text &&
  (!same(was.before, now.before) || !same(was.after, now.after));

/** The ids on either side of the item at `at` in `order`, by `idOf`. */
export const neighboursAt = (order, at, idOf = (x) => x.id) => ({
  before: at > 0 ? idOf(order[at - 1]) : null,
  after: at >= 0 && at < order.length - 1 ? idOf(order[at + 1]) : null,
});
