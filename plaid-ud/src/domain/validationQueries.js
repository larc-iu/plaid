// What a project has actually stored in each governed field, as one aggregate
// query per field.
//
// The point of asking the SERVER rather than loading documents: a closed
// vocabulary is enforced where a person types and nowhere else, so the values
// that got in another way (an import, a parser, the assistant, a script) are
// exactly the ones nobody has seen. There may be a corpus of them, and loading
// a corpus to count its tags is the wrong shape.
//
// Each query returns the field's whole value inventory as `[value, count]`
// pairs. The diff against the project's list happens on this side, so nothing
// loads a document until someone clicks a value and asks where it is.

// The REGEXP UDF matches on `contains`, so "." means "has at least one
// character" — every span in the layer, whatever its value.
const ANY_VALUE = { regex: '.' };

const COUNT = { aggregates: [['count']] };

/** Every value stored in a span layer, with how many spans carry it. */
export const spanValueCounts = (projectId, layerId) => ({
  where: [
    ['span', '?s', { layer: layerId, value: ANY_VALUE }],
    ['span', '?s', { value: { var: '?val' } }],
  ],
  return: { ...COUNT, group: ['?val'] },
  scope: { projectIds: [projectId] },
});

/** Every label stored in the relation layer, with how many relations carry it. */
export const relationValueCounts = (projectId, layerId) => ({
  where: [
    ['relation', '?r', { layer: layerId, value: ANY_VALUE }],
    ['relation', '?r', { value: { var: '?val' } }],
  ],
  return: { ...COUNT, group: ['?val'] },
  scope: { projectIds: [projectId] },
});

/**
 * The SENTENCES holding a given value in a span layer, with a count each. What
 * "show me where" costs: one query per value, asked only when clicked.
 *
 * Grouped by document AND sentence token, because a link into the editor is
 * `annotate?sent=<sentence token id>` — landing on the document and leaving the
 * reader to find the word is most of the work not done. `within` is the
 * containment predicate the Grew compiler already leans on for the same reason.
 */
export const spanValueSentences = (projectId, sentenceLayerId, layerId, value) => ({
  where: [
    ['token', '?S', { layer: sentenceLayerId }],
    ['span', '?s', { layer: layerId, value }],
    // `covers` is how a span reaches its token: a span constraint map takes
    // only :doc, :layer, :metadata and :value, so there is no `tokens` key to
    // ask on. The Grew compiler joins the same two the same way.
    ['covers', '?s', '?t'],
    ['within', '?t', '?S'],
    ['token', '?S', { doc: { var: '?d' } }],
  ],
  return: { ...COUNT, group: ['?d', '?S'] },
  scope: { projectIds: [projectId] },
});

/** The same for a relation label. The dependent is the relation's TARGET. */
export const relationValueSentences = (projectId, sentenceLayerId, layerId, value) => ({
  where: [
    ['token', '?S', { layer: sentenceLayerId }],
    ['relation', '?r', { layer: layerId, value, target: '?s' }],
    ['covers', '?s', '?t'],
    ['within', '?t', '?S'],
    ['token', '?S', { doc: { var: '?d' } }],
  ],
  return: { ...COUNT, group: ['?d', '?S'] },
  scope: { projectIds: [projectId] },
});

/**
 * The values a project has that its own list does not, as `[{value, count}]`
 * sorted commonest first.
 *
 * `allows` is the field's rule from udVocabMode (`(value) => message | null`),
 * so this answers the question the SAME way the cells do — including a DEPREL
 * judged by its base, which a plain set difference would get wrong.
 */
export function offListValues(counts, allows) {
  return (counts || [])
    .filter(([value]) => value != null && value !== '' && !!allows(String(value)))
    .map(([value, count]) => ({ value: String(value), count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * The values a project HAS that its list does not, whether or not the list is
 * closed — what the seed button offers to add. The difference from
 * `offListValues` is that this ignores the mode: a suggestion list is worth
 * completing too, and a project usually turns a list closed only after seeding
 * it from what is already there.
 */
export function seedCandidates(counts, vocab, covers) {
  const list = vocab || [];
  const have = new Set(list);
  // `covers` is how a list decides it already accounts for a value. DEPREL
  // passes a base-relation comparison, so a project listing `nsubj` is not
  // offered `nsubj:pass`: the subtype is already legal and adding it would
  // start the re-listing of the language that closed mode avoids.
  const known = covers ? (value) => list.some((v) => covers(v, value)) : (value) => have.has(value);
  return (counts || [])
    .filter(([value]) => value != null && value !== '' && !known(String(value)))
    .map(([value, count]) => ({ value: String(value), count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Feature spans store a whole `Key=Value`, so the inventory's candidates are
 * per key: `{key, values: [{value, count}]}` for every key that has something
 * the inventory does not, plus keys the inventory has never heard of.
 */
export function featureSeedCandidates(counts, inventoryMap) {
  const byKey = new Map();
  for (const [raw, count] of counts || []) {
    const value = String(raw ?? '');
    const eq = value.indexOf('=');
    if (eq < 1) continue;
    const key = value.slice(0, eq);
    const val = value.slice(eq + 1);
    if (!val) continue;
    const known = inventoryMap?.get(key);
    // A key with values listed is policed; a key listed with NO values accepts
    // anything, so nothing under it is a candidate.
    if (known && (known.length === 0 || known.includes(val))) continue;
    if (!byKey.has(key)) byKey.set(key, new Map());
    const bucket = byKey.get(key);
    bucket.set(val, (bucket.get(val) || 0) + (Number(count) || 0));
  }
  return [...byKey.entries()]
    .map(([key, bucket]) => ({
      key,
      known: !!inventoryMap?.has(key),
      values: [...bucket.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
