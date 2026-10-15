import { neighboursAt, reshaped } from '@ui/domain/cells/recut.js';

// What a value in an annotation cell is typed for, for the grid's cell engine
// (plaid-ui cells/CellEngine.js): the word's text, how much of the text its
// token covers, and the tokens beside it, which tell a split or join (a new
// token beside it, or one gone) from a respelling (plaid-ui
// domain/cells/recut.js). `order` is every token's data in reading order and
// `at` the word's place in it.

export const wordShapeOf = (order, at) => {
  const data = order[at];
  return {
    text: data.wordForm,
    length: data.token.end - data.token.begin,
    ...neighboursAt(order, at, (d) => d.token?.id),
  };
};

/**
 * The word at `at` as it reads now, `{ unit, text, ids, reshaped }`, when it
 * was split, joined or respelled since `snapshot` (its text, or how much of
 * the text it covers, changed), else null. Only a split or join is
 * `reshaped`, after which Enter keeps nothing.
 */
export const wordRecutOf = (snapshot, order, at) => {
  if (snapshot == null || at == null || !order[at]) return null;
  const now = wordShapeOf(order, at);
  if (now.text === snapshot.text && now.length === snapshot.length) return null;
  const data = order[at];
  return {
    unit: 'word',
    text: data.wordForm,
    ids: [data.token.id],
    reshaped: reshaped(snapshot, now),
  };
};
