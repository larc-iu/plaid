/**
 * How many tokens each project holds, in ONE round trip for the whole list.
 *
 * Count tokens grouped by their token layer across every readable project, then
 * map each project's own word layer to its count. `wordLayerId(project)` is the
 * caller's, because the two apps count different layers: plaid-igt its word
 * layer, plaid-ud the morpheme layer whose tokens are UD's syntactic words.
 *
 * A project with no such layer gets `null`, which reads as a dash rather than
 * as a zero: it has no answer, and zero is an answer.
 *
 * `layer: '?l'` binds a layer VARIABLE (a bare "?name" string); the `{var}`
 * form is only for scalar values (doc, value, begin, end, form).
 */
export const wordCountsByProject = async (client, projects, wordLayerId) => {
  const res = await client.query({
    where: [['token', '?t', { layer: '?l' }]],
    return: { group: ['?l'], aggregates: [['count']] },
  });
  const byLayer = new Map((res?.results || []).map(([layerId, n]) => [layerId, n]));
  const byProject = {};
  for (const p of projects) {
    const id = wordLayerId(p);
    byProject[p.id] = id ? (byLayer.get(id) ?? 0) : null;
  }
  return byProject;
};
