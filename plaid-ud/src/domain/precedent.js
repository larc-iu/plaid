// What this project has said before about a word like this one.
//
// The parser writes a first draft of most things, so this is not how a document
// gets annotated: it is consistency help for the parts done by hand, and for
// the moment you are about to type the second `NNS` for a word you already
// tagged `NN` somewhere else. Alt+Down in a cell asks.
//
// Three questions, each one grouped aggregate:
//
//   lemma   what lemma has this FORM been given?
//   xpos    what XPOS has this LEMMA been given?
//   feats   what features has this LEMMA been given?
//
// Keyed on the form for the lemma and on the lemma for the rest, because that
// is the decision each one actually depends on: the same string can be two
// lemmas, and once the lemma is settled its tag and features usually follow.
//
// The counts come from the server, not from the open document: the point is
// what the PROJECT has done, and a project is bigger than a document. The open
// document's own words are included, which is right: a decision made a moment
// ago in this document is precedent too.

const COUNT = { aggregates: [['count']] };

/**
 * Lemmas given to this form. TWO queries, merged: a word's form is the Form
 * span's value when it has one (a multi-word token's components) and the
 * token's own text otherwise, and no single constraint covers both. Asking one
 * way would silently miss every word of the other kind.
 */
export const lemmaByForm = (projectId, layers, form) => [
  {
    where: [
      ['token', '?t', { layer: layers.morpheme, value: form }],
      ['span', '?l', { layer: layers.lemma }],
      ['covers', '?l', '?t'],
      ['span', '?l', { value: { var: '?precedent' } }],
    ],
    return: { ...COUNT, group: ['?precedent'] },
    scope: { projectIds: [projectId] },
  },
  {
    where: [
      ['span', '?f', { layer: layers.form, value: form }],
      ['covers', '?f', '?t'],
      ['span', '?l', { layer: layers.lemma }],
      ['covers', '?l', '?t'],
      ['span', '?l', { value: { var: '?precedent' } }],
    ],
    return: { ...COUNT, group: ['?precedent'] },
    scope: { projectIds: [projectId] },
  },
];

/** Values given in `layer` to words whose lemma is `lemma`. */
export const byLemma = (projectId, layers, layerId, lemma) => [
  {
    where: [
      ['span', '?l', { layer: layers.lemma, value: lemma }],
      ['covers', '?l', '?t'],
      ['span', '?v', { layer: layerId }],
      ['covers', '?v', '?t'],
      ['span', '?v', { value: { var: '?precedent' } }],
    ],
    return: { ...COUNT, group: ['?precedent'] },
    scope: { projectIds: [projectId] },
  },
];

/**
 * The queries for one cell, or null when there is nothing to ask about: an
 * empty key, or a field with no precedent question of its own.
 */
export function precedentQueries(projectId, layers, field, key) {
  const needle = String(key ?? '').trim();
  if (!needle || !projectId || !layers?.lemma) return null;
  if (field === 'lemma')
    return layers.morpheme && layers.form ? lemmaByForm(projectId, layers, needle) : null;
  if (field === 'xpos') return layers.xpos ? byLemma(projectId, layers, layers.xpos, needle) : null;
  if (field === 'feats')
    return layers.features ? byLemma(projectId, layers, layers.features, needle) : null;
  return null;
}

/**
 * Merge the results of one or more grouped aggregates into `[{value, count}]`,
 * commonest first. The two lemma queries can name the same value (a word with
 * a Form span matching its own text), so counts are summed rather than
 * concatenated.
 */
export function mergeCounts(resultSets) {
  const totals = new Map();
  for (const results of resultSets || []) {
    for (const [value, n] of results || []) {
      const key = String(value ?? '');
      if (!key) continue;
      totals.set(key, (totals.get(key) || 0) + (Number(n) || 0));
    }
  }
  return [...totals.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** What Alt+Down asks about, given a cell's field and its word's data. */
export function precedentKey(field, entry) {
  if (!entry) return null;
  if (field === 'lemma') return entry.tokenForm || null;
  // XPOS and FEATS follow the LEMMA: once that is settled its tag and features
  // usually follow, and the same string can be two lemmas.
  return entry.lemma?.value || null;
}
