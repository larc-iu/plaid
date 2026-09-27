import { PARENT_KEY } from './vocabDictionary.js';

// How many entries each vocabulary holds, as `{ vocabId: count }` for the ids
// asked about (0 for one with no rows). Two grouped aggregates across every
// vocabulary the user can read: every row, and the rows that are SENSES. An
// entry is what is left. Counting rows and calling them entries read 23 for a
// dictionary of 20 entries and 3 senses.
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
  for (const id of vocabIds) counts[id] = Math.max(0, (rows[id] ?? 0) - (senseRows[id] ?? 0));
  return counts;
}
