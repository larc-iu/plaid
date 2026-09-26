// A governed field's attested values, the rows the Validation tab, the
// off-tagset badges and the tagset seed all read (tagsets.js offTagsetValues,
// seedCandidates): [value, count, reading], from aggregate queries and no
// document loaded.

import { glossReadingOf } from '@/domain/tagsets';
import { governedFreqQueries, headwordTypesQuery } from '../search/searchQueries.js';

// Adds [value, n, reading] to `tally`, one row per value and reading.
const add = (tally, value, n, reading) => {
  const key = `${reading ? 'bound' : ''}\u0000${value}`;
  const have = tally.get(key);
  if (have) have[1] += n;
  else tally.set(key, [value, n, reading]);
};

/**
 * A field's aggregate rows as [value, count, reading]. A morpheme field's
 * rows, [value, morph type, form, count], carry how the grid reads the value
 * (glossReadingOf of the morph type and form), so each value appears once
 * per reading.
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

const typed = (t) => (typeof t === 'string' && t !== '' ? t : null);

/**
 * The type an entry gives its morphemes: its own, else the nearest typed
 * headword's through `headwords` (id -> [type, parent]). Null when the entry
 * and everything above it are untyped.
 */
const entryTypeOf = (own, parent, headwords) => {
  if (typed(own)) return own;
  const seen = new Set();
  for (let cur = parent; cur && !seen.has(cur); ) {
    seen.add(cur);
    const h = headwords.get(cur);
    if (!h) return null;
    if (typed(h[0])) return h[0];
    cur = h[1];
  }
  return null;
};

/**
 * Linked morpheme rows [value, entry type, entry parent, cached type, form,
 * n] as [value, type, form, n], the type resolved as the grid's
 * effectiveMorphType does: the entry's, else the token's cached one.
 */
const resolveLinkedRows = (rows, headwords = new Map()) =>
  (rows || []).map(([value, own, parent, cached, form, n]) => [
    value,
    entryTypeOf(own, parent, headwords) ?? typed(cached),
    form,
    n,
  ]);

/**
 * The linked rows with a morpheme linked to two or more entries counted once.
 * The linked query counts it once per entry, and `doubled` holds one row per
 * span, token and entry of such a morpheme. Each is taken off the linked row
 * it added to, and each span and token goes back once as an unlinked row, by
 * the token's cached type: the grid reads one of the links, and opening the
 * document syncs the cached type to it.
 */
const withoutDoubleLinks = (linked, unlinked, doubled) => {
  if (!doubled.length) return [linked, unlinked];
  const key = (row) => JSON.stringify(row.slice(0, 5));
  const over = new Map();
  const once = new Map();
  for (const [s, t, , value, own, parent, cached, form] of doubled) {
    const k = key([value, own, parent, cached, form]);
    over.set(k, (over.get(k) || 0) + 1);
    once.set(JSON.stringify([s, t, value]), [value, cached, form, 1]);
  }
  const kept = linked
    .map((row) => {
      const less = over.get(key(row)) || 0;
      return less ? [...row.slice(0, 5), row[5] - less] : row;
    })
    .filter((row) => row[5] > 0);
  return [kept, [...unlinked, ...once.values()]];
};

/** One governed field's attested rows, asked of the server. */
export const loadAttested = async (client, projectId, g) => {
  const res = await Promise.all(governedFreqQueries(g, projectId).map((q) => client.query(q)));
  if (res.length === 1) return attestedRows(g, res[0]?.results);
  const [linked, unlinked] = withoutDoubleLinks(...res.map((r) => r?.results || []));
  const headwords = new Map();
  if (linked.some(([, own, parent]) => !typed(own) && parent)) {
    const hw = await client.query(headwordTypesQuery(projectId));
    for (const [id, type, parent] of hw?.results || []) headwords.set(id, [type, parent]);
  }
  return attestedRows(g, [...resolveLinkedRows(linked, headwords), ...unlinked]);
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
