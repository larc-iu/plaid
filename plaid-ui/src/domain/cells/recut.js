// Whether a row whose text changed since a value was typed for it was split,
// joined or merged (its boundaries changed), or only respelled.
//
// `was` and `now` are `{ text, before, after }`: the row's text and the ids of
// the rows on either side of it, as they read when the value was typed and as
// they read now. A split leaves the row a prefix (or suffix) of its old text
// and a new row beside it on that side. A join or merge makes the old text a
// prefix (or suffix) of the new one, and the row it took in is gone from that
// side. A respelling keeps both neighbours. A neighbour's own split or delete
// changes the ids beside the row but leaves its text as it was.
//
// After a split, join or merge the value was typed for a row that is gone, so
// the cell keeps nothing on Enter. After a respelling the conflict is the
// plain one, whose typed value Enter keeps (Luke, 2026-10-15, H16-UI-CORE-3).

import { settledId } from '../pendingIds.js';

const same = (a, b) => (a == null ? null : settledId(a)) === (b == null ? null : settledId(b));

/** Whether the row went from `was` to `now` by a split, join or merge. */
export const reshaped = (was, now) => {
  if (!was || !now || was.text === now.text) return false;
  const a = was.text ?? '';
  const b = now.text ?? '';
  const right = !same(was.after, now.after) && (a.startsWith(b) || b.startsWith(a));
  const left = !same(was.before, now.before) && (a.endsWith(b) || b.endsWith(a));
  return right || left;
};

/** The ids on either side of the item at `at` in `order`, by `idOf`. */
export const neighboursAt = (order, at, idOf = (x) => x.id) => ({
  before: at > 0 ? idOf(order[at - 1]) : null,
  after: at >= 0 && at < order.length - 1 ? idOf(order[at + 1]) : null,
});
