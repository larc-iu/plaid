// What a change to the ignored-tokens rule hides. The Analyze grid draws a word
// the rule excludes as an inert column, and exports and copies follow it, so a
// word that carries values and becomes ignored loses them from every view but
// the archive (they stay stored, and come back if the rule changes back). The
// settings screen says how many such words a change hides before it saves.

import { isTokenIgnored } from './igtConfig.js';

/**
 * The query for every word form that carries something the grid would hide on
 * an ignored word, with how many words of that form do: a value in a Word or
 * Morpheme field, or a lexicon link on the word or one of its morphemes.
 * `{ wordLayerId, morphLayerId, wordSpanLayerIds, morphSpanLayerIds }`. Rows
 * are `[form, count]`.
 *
 * Each kind of value is its own `or` branch, binding its own variables, so a
 * match is a word and its form whatever else it carries: `count` is a count of
 * words, not of values (query.adoc, Aggregates).
 */
export function annotatedWordFormsQuery({
  wordLayerId,
  morphLayerId = null,
  wordSpanLayerIds = [],
  morphSpanLayerIds = [],
}) {
  const branches = [
    ...wordSpanLayerIds.map((id, i) => [
      ['span', `?ws${i}`, { layer: id }],
      ['covers', `?ws${i}`, '?t'],
    ]),
    [['link-token', '?wl', '?t']],
    ...(morphLayerId
      ? [
          ...morphSpanLayerIds.map((id, i) => [
            ['token', `?m${i}`, { layer: morphLayerId }],
            ['within', `?m${i}`, '?t'],
            ['span', `?ms${i}`, { layer: id }],
            ['covers', `?ms${i}`, `?m${i}`],
          ]),
          [
            ['token', '?ml', { layer: morphLayerId }],
            ['within', '?ml', '?t'],
            ['link-token', '?mll', '?ml'],
          ],
        ]
      : []),
  ];
  return {
    where: [
      ['token', '?t', { layer: wordLayerId }],
      ['token', '?t', { value: { var: '?val' } }],
      // An `or` takes two groups at least. The link branch is always there, so
      // a project with no field at all asks it twice, which matches the same.
      ['or', ...(branches.length > 1 ? branches : [branches[0], branches[0]])],
    ],
    return: { group: ['?val'], aggregates: [['count']] },
  };
}

/**
 * How many words a rule change hides: those of `forms` (`[form, count]` rows)
 * that `after` ignores and `before` did not. Both rules in the stored shape
 * (`readIgnoredTokens`).
 */
export function hiddenWordCount(forms, before, after) {
  let n = 0;
  for (const [form, count] of forms || []) {
    if (isTokenIgnored(form, after) && !isTokenIgnored(form, before)) n += Number(count) || 0;
  }
  return n;
}
