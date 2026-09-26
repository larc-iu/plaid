// A governed field's attested values, the rows the Validation tab, the
// off-tagset badges and the tagset seed all read (tagsets.js offTagsetValues,
// seedCandidates): [value, count, reading], one aggregate query per field and
// no document loaded.

import { glossReadingOf } from '@/domain/tagsets';
import { governedFreqQuery } from '../search/searchQueries.js';

// Adds [value, n, reading] to `tally`, one row per value and reading.
const add = (tally, value, n, reading) => {
  const key = `${reading ? 'bound' : ''}\u0000${value}`;
  const have = tally.get(key);
  if (have) have[1] += n;
  else tally.set(key, [value, n, reading]);
};

/**
 * A governedFreqQuery's result rows as [value, count, reading]. A morpheme
 * field's rows carry how the grid reads the value (glossReadingOf of the
 * morpheme's morph type and form), so each value appears once per reading.
 * Any other field's rows carry none: a word's, a sentence's or a document's
 * value is read as a stem's or a word's gloss.
 */
export const attestedRows = (g, results) => {
  const morpheme = g?.kind === 'span' && g?.scope === 'morpheme';
  const tally = new Map();
  for (const row of results || []) {
    const value = row?.[0];
    if (typeof value !== 'string') continue;
    const n = row[row.length - 1] || 0;
    add(tally, value, n, morpheme ? glossReadingOf(row[1], row[2]) : undefined);
  }
  return [...tally.values()];
};

/** One governed field's attested rows, asked of the server. */
export const loadAttested = async (client, projectId, g) => {
  const res = await client.query(governedFreqQuery(g, projectId));
  return attestedRows(g, res?.results);
};

/** Several fields' rows as one inventory, a value counted once per reading. */
export const mergeAttested = (lists) => {
  const tally = new Map();
  for (const rows of lists || []) {
    for (const [value, n, reading] of rows || []) add(tally, value, n, reading);
  }
  return [...tally.values()];
};

/** How many distinct values the rows hold, whatever they are read as. */
export const distinctValues = (rows) => new Set((rows || []).map((r) => r[0])).size;
