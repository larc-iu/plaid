import { PARENT_KEY, parentOf } from './vocabDictionary.js';

// How many entries each vocabulary holds, as `{ vocabId: count }` for the ids
// asked about. Two grouped aggregates across every vocabulary a readable
// project links: every row, and the rows that are SENSES. An entry is what is
// left. Counting rows and calling them entries read 23 for a dictionary of 20
// entries and 3 senses.
//
// The query has no group for a vocabulary with no rows, nor for one no readable
// project links (a deleted project's lexicon), so each id it does not answer is
// read on its own. One that cannot be read is left out (unknown), never 0.
//
// A sense is a row carrying a parent (PARENT_KEY, see vocabDictionary). The
// query language has no "this key is set" test and cannot bind a variable to
// a metadata field, but a regex matching anything is the same question: it
// matches a row that HAS the key and skips one that does not.
export async function loadEntryCounts(client, vocabIds) {
  const [all, senses] = await Promise.all([
    client.query({
      where: [['vocab', '?v', { layer: '?l' }]],
      return: { group: ['?l'], aggregates: [['count']] },
    }),
    client.query({
      where: [['vocab', '?v', { layer: '?l', metadata: { [PARENT_KEY]: { regex: '.*' } } }]],
      return: { group: ['?l'], aggregates: [['count']] },
    }),
  ]);
  const rows = {};
  for (const [layerId, n] of all?.results || []) rows[layerId] = n;
  const senseRows = {};
  for (const [layerId, n] of senses?.results || []) senseRows[layerId] = n;
  const counts = {};
  const unseen = [];
  for (const id of vocabIds) {
    if (id in rows) counts[id] = Math.max(0, rows[id] - (senseRows[id] ?? 0));
    else unseen.push(id);
  }
  await Promise.all(
    unseen.map(async (id) => {
      try {
        const { items = [] } = (await client.vocabLayers.get(id, true)) || {};
        counts[id] = items.filter((item) => !parentOf(item)).length;
      } catch {
        // Unknown: the list shows no count.
      }
    }),
  );
  return counts;
}
