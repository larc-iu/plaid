/**
 * How many tokens each project holds, in one round trip for the whole list
 * (two when some project needs the fallback below).
 *
 * Count tokens grouped by their token layer across the listed projects that
 * have a word layer (never every project on the server, which an admin can
 * read), then map each project's own word layer to its count. `wordLayerId(project)` is the
 * caller's, because the two apps count different layers: plaid-igt its word
 * layer, plaid-ud the morpheme layer whose tokens are UD's syntactic words.
 *
 * `seedLayerId(project)` is plaid-ud's token layer, and counts the way
 * DocumentTable's `seedLayerId` does: a document with no words yet counts its
 * tokens, because every reader shows each token as a word until a write makes
 * it. Without it, a document whose words another app made after the project
 * was set up for UD reads zero words on this list and the token count on its
 * own document list. That takes the
 * counts per document, which is several times slower than per layer across
 * every project, so it is asked only for a project with fewer words than
 * tokens. A project whose multi-word tokens make up for an unopened
 * document's missing words is not caught.
 *
 * A project with no such layer gets `null`, which reads as a dash rather than
 * as a zero: it has no answer, and zero is an answer.
 *
 * `wordValue(project)`, optional, is a query value spec a word's surface
 * matches (plaid-igt's: a token its ignored-tokens rule excludes, punctuation
 * ud's Tokenize made say, is no word). Such a project's word layer is counted
 * by core's token count (`tokenLayers.countMatching`, one call per distinct
 * spec), which reads each text once: the query language's `value` regex slices
 * every token out of its text and timed out on a long document.
 *
 * `layer: '?l'` binds a layer VARIABLE (a bare "?name" string); the `{var}`
 * form is only for scalar values (doc, value, begin, end, form).
 */
export const wordCountsByProject = async (
  client,
  projects,
  wordLayerId,
  seedLayerId = null,
  wordValue = null,
) => {
  const bySpec = new Map();
  for (const p of projects) {
    const spec = wordLayerId(p) && wordValue ? wordValue(p) : null;
    if (!spec) continue;
    const key = JSON.stringify(spec);
    if (!bySpec.has(key)) bySpec.set(key, { spec, projects: [] });
    bySpec.get(key).projects.push(p);
  }
  const counted = projects.filter((p) => wordLayerId(p)).map((p) => p.id);
  const [res, ...filtered] = await Promise.all([
    counted.length
      ? client.query({
          where: [['token', '?t', { layer: '?l' }]],
          scope: { projectIds: counted },
          return: { group: ['?l'], aggregates: [['count']] },
        })
      : null,
    ...[...bySpec.values()].map(({ spec, projects: ps }) =>
      client.tokenLayers.countMatching(ps.map(wordLayerId), spec),
    ),
  ]);
  const byLayer = new Map((res?.results || []).map(([layerId, n]) => [layerId, n]));
  const wordsByLayer = new Map();
  for (const r of filtered) {
    for (const [layerId, , n] of r?.results || []) {
      wordsByLayer.set(layerId, (wordsByLayer.get(layerId) || 0) + n);
    }
  }
  const filteredIds = new Set([...bySpec.values()].flatMap((g) => g.projects.map((p) => p.id)));
  const byProject = {};
  const short = [];
  for (const p of projects) {
    const id = wordLayerId(p);
    const counts = filteredIds.has(p.id) ? wordsByLayer : byLayer;
    byProject[p.id] = id ? (counts.get(id) ?? 0) : null;
    const seed = id && seedLayerId ? seedLayerId(p) : null;
    if (seed && byProject[p.id] < (byLayer.get(seed) ?? 0)) short.push({ p, id, seed });
  }
  if (!short.length) return byProject;

  const perDoc = await client.query({
    where: [['token', '?t', { layer: '?l', doc: { var: '?d' } }]],
    scope: { projectIds: short.map(({ p }) => p.id) },
    return: { group: ['?l', '?d'], aggregates: [['count']] },
  });
  // layer -> Map(doc -> count)
  const byLayerDoc = new Map();
  for (const [layerId, docId, n] of perDoc?.results || []) {
    if (!byLayerDoc.has(layerId)) byLayerDoc.set(layerId, new Map());
    byLayerDoc.get(layerId).set(docId, n);
  }
  for (const { p, id, seed } of short) {
    const perDoc = withSeedCounts(byLayerDoc.get(id), byLayerDoc.get(seed));
    let total = 0;
    for (const n of perDoc.values()) total += n;
    byProject[p.id] = total;
  }
  return byProject;
};

/**
 * Each document's word count: its words, or its seed layer's tokens when it
 * has no words yet (see `seedLayerId` above). Both are maps from document id
 * to count, and a document in neither is absent.
 */
const withSeedCounts = (words, seeds) => {
  const byDoc = new Map(seeds ?? []);
  for (const [docId, n] of words ?? []) if (n > 0) byDoc.set(docId, n);
  return byDoc;
};

/**
 * How many words each document of a word layer holds, as `{documentId: n}`,
 * by the rules `wordCountsByProject` counts a project by: a word value spec
 * is counted by core's token count, and a document with no words counts its
 * seed layer's tokens. A document with no tokens is absent. Unlike the list's
 * short-project path, which counts per document unfiltered, the spec is
 * applied here.
 */
export const wordCountsByDocument = async (
  client,
  wordLayerId,
  seedLayerId = null,
  wordValue = null,
) => {
  // Rows [doc, n] either way.
  const countPerDoc = async (layer, value = null) => {
    if (!value) {
      return client.query({
        where: [['token', '?t', { layer, doc: { var: '?d' } }]],
        return: { group: ['?d'], aggregates: [['count']] },
      });
    }
    const res = await client.tokenLayers.countMatching([layer], value);
    return { results: (res?.results || []).map(([, doc, n]) => [doc, n]) };
  };
  const [res, seeds] = await Promise.all([
    countPerDoc(wordLayerId, wordValue),
    seedLayerId ? countPerDoc(seedLayerId) : null,
  ]);
  return Object.fromEntries(
    withSeedCounts(new Map(res?.results || []), new Map(seeds?.results || [])),
  );
};
