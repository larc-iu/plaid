// What a change to the ignored-tokens rule hides. The Analyze grid draws a word
// the rule excludes as an inert column, and exports and copies follow it, so a
// word that carries values and becomes ignored loses them from every view but
// the archive (they stay stored, and come back if the rule changes back). The
// settings screen says how many such words a change hides before it saves.
//
// Two reads, both cheap on a large project. First every word form with how
// often it occurs (one scan of the word layer), from which the forms the
// change newly ignores are picked here, with the grid's own rule. Usually
// there are none, or a handful. Then, for those forms only, the words that
// carry something. A morpheme is found by its own surface, which is its
// word's (a morpheme has its word's extent), never by nesting it in the word:
// a `within` join over a whole project ran past the query time limit.

import { isTokenIgnored } from './igtConfig.js';
import { chunk } from './bulk.js';

/** Every word form on the word layer, as `[form, count]` rows. */
export const wordFormsQuery = (wordLayerId) => ({
  where: [['token', '?t', { layer: wordLayerId, value: { var: '?val' } }]],
  return: { group: ['?val'], aggregates: [['count']] },
});

/**
 * The forms of `forms` (`[form, count]` rows) that `after` ignores and
 * `before` did not. Both rules in the stored shape (`readIgnoredTokens`).
 */
export const newlyIgnoredForms = (forms, before, after) =>
  (forms || [])
    .map(([form]) => form)
    .filter((form) => isTokenIgnored(form, after) && !isTokenIgnored(form, before));

/**
 * The queries for the words spelled one of `forms` that carry something the
 * grid would hide on an ignored word: a value in a Word or Morpheme field, or
 * a lexicon link on the word or one of its morphemes. One query per chunk of
 * forms. Each row is one word, `[form, doc, begin, count]`: every kind of
 * value is its own `or` branch, and the word's form and place (document and
 * offset, which its morphemes share) are what every branch binds, so a word
 * that carries several is one row.
 */
export function annotatedWordsQueries(
  { wordLayerId, morphLayerId = null, wordSpanLayerIds = [], morphSpanLayerIds = [] },
  forms,
) {
  return chunk(forms, 200).map((part) => {
    const at = (v, layer) => [
      ['token', v, { layer, value: part, doc: { var: '?d' }, begin: { var: '?b' } }],
      ['token', v, { value: { var: '?val' } }],
    ];
    const branches = [
      ...wordSpanLayerIds.map((id, i) => [
        ...at(`?t${i}`, wordLayerId),
        ['span', `?ws${i}`, { layer: id }],
        ['covers', `?ws${i}`, `?t${i}`],
      ]),
      [...at('?tl', wordLayerId), ['link-token', '?wl', '?tl']],
      ...(morphLayerId
        ? [
            ...morphSpanLayerIds.map((id, i) => [
              ...at(`?m${i}`, morphLayerId),
              ['span', `?ms${i}`, { layer: id }],
              ['covers', `?ms${i}`, `?m${i}`],
            ]),
            [...at('?ml', morphLayerId), ['link-token', '?mll', '?ml']],
          ]
        : []),
    ];
    return {
      // An `or` takes two groups at least. The link branch is always there, so
      // a project with no field at all asks it twice, which matches the same.
      where: [['or', ...(branches.length > 1 ? branches : [branches[0], branches[0]])]],
      return: { group: ['?val', '?d', '?b'], aggregates: [['count']] },
    };
  });
}

/**
 * How many annotated words each of `forms` has, from the rows of
 * `annotatedWordsQueries`' answers: a Map form -> count, 0 for a form with none.
 */
export function annotatedCounts(forms, results) {
  const out = new Map(forms.map((f) => [f, 0]));
  for (const rows of results)
    for (const [form] of rows || []) out.set(form, (out.get(form) ?? 0) + 1);
  return out;
}
