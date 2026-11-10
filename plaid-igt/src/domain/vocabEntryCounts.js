// How many entries each vocabulary holds, as `{ vocabId: count }` for the ids
// asked about. Every entry counts, senses included, so the number is the one
// the vocabulary's own page shows. One grouped aggregate across every
// vocabulary a readable project links.
//
// The query has no group for a vocabulary with no rows, nor for one no readable
// project links (a deleted project's lexicon), so each id it does not answer is
// read on its own. One that cannot be read is left out (unknown), never 0.
export async function loadEntryCounts(client, vocabIds) {
  const all = await client.query({
    where: [['vocab', '?v', { layer: '?l' }]],
    return: { group: ['?l'], aggregates: [['count']] },
  });
  const rows = {};
  for (const [layerId, n] of all?.results || []) rows[layerId] = n;
  const counts = {};
  const unseen = [];
  for (const id of vocabIds) {
    if (id in rows) counts[id] = rows[id];
    else unseen.push(id);
  }
  await Promise.all(
    unseen.map(async (id) => {
      try {
        const { items = [] } = (await client.vocabLayers.get(id, true)) || {};
        counts[id] = items.length;
      } catch {
        // Unknown: the list shows no count.
      }
    }),
  );
  return counts;
}
