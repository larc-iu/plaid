/**
 * How many tokens each project holds, in one round trip for the whole list
 * (two when some project needs the fallback below).
 *
 * Count tokens grouped by their token layer across every readable project, then
 * map each project's own word layer to its count. `wordLayerId(project)` is the
 * caller's, because the two apps count different layers: plaid-igt its word
 * layer, plaid-ud the morpheme layer whose tokens are UD's syntactic words.
 *
 * `seedLayerId(project)` is plaid-ud's token layer, and counts the way
 * DocumentTable's `seedLayerId` does: a document with no words yet counts its
 * tokens, because opening it gives each token a word (reconcile's back-fill).
 * Without it, a project just set up for UD from another app reads zero words
 * on this list and the token count on its own document list. That takes the
 * counts per document, which is several times slower than per layer across
 * every project, so it is asked only for a project with fewer words than
 * tokens. A project whose multi-word tokens make up for an unopened
 * document's missing words is not caught.
 *
 * A project with no such layer gets `null`, which reads as a dash rather than
 * as a zero: it has no answer, and zero is an answer.
 *
 * `layer: '?l'` binds a layer VARIABLE (a bare "?name" string); the `{var}`
 * form is only for scalar values (doc, value, begin, end, form).
 */
export const wordCountsByProject = async (client, projects, wordLayerId, seedLayerId = null) => {
  const res = await client.query({
    where: [['token', '?t', { layer: '?l' }]],
    return: { group: ['?l'], aggregates: [['count']] },
  });
  const byLayer = new Map((res?.results || []).map(([layerId, n]) => [layerId, n]));
  const byProject = {};
  const short = [];
  for (const p of projects) {
    const id = wordLayerId(p);
    byProject[p.id] = id ? (byLayer.get(id) ?? 0) : null;
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
    const words = byLayerDoc.get(id) ?? new Map();
    const seeds = byLayerDoc.get(seed) ?? new Map();
    let total = 0;
    for (const docId of new Set([...words.keys(), ...seeds.keys()])) {
      const n = words.get(docId) ?? 0;
      total += n > 0 ? n : (seeds.get(docId) ?? 0);
    }
    byProject[p.id] = total;
  }
  return byProject;
};
