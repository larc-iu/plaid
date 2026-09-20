// Turning a whole metadata MAP into the PATCH that writes it.
//
// Several planners here hand back the map an entry should end up carrying —
// `planMergeRefs`, `planDeleteRefs` and `validateVocabRefs` in
// vocabDictionary.js, and the entry editor writes the same shape. That map used
// to go out as a PUT per entry, replacing everything. A bulk update takes a
// patch instead: keys present are set, keys absent are left alone, and a key
// whose value is null is deleted. So the patch is every key whose value changed,
// plus an explicit null for every key that went away — get that second half
// wrong and a sense stays parented to an entry that no longer exists.
//
// A patch is also the safer write of the two. A PUT of a map read a moment ago
// removes a key somebody else added in between; a patch names only what it means
// to change.

/**
 * The patch that turns `before` into `after`, keys and deletions alike. A key
 * whose value is `undefined` counts as one the map does not carry, on either
 * side: JSON drops it, so a map that still "held" it would reach the server
 * without it, and the delete would quietly not happen.
 */
export const metadataPatchTo = (before, after) => {
  const held = (m, k) => m[k] !== undefined;
  const from = before || {};
  const to = after || {};
  const patch = {};
  for (const [k, v] of Object.entries(to)) if (v !== undefined && v !== from[k]) patch[k] = v;
  for (const k of Object.keys(from)) if (held(from, k) && !held(to, k)) patch[k] = null;
  return patch;
};

/**
 * Whole-map plans (`[{id, metadata}]`) as bulk-update entries, against the
 * metadata each entry carries NOW (`metaById`). A plan that turns out to change
 * nothing is dropped: these walks decide from the sense tree, which can name an
 * entry whose map comes out identical.
 */
export function metadataUpdates(plans, metaById) {
  const out = [];
  for (const p of plans || []) {
    const metadata = metadataPatchTo(metaById.get(p.id), p.metadata);
    if (Object.keys(metadata).length) out.push({ id: p.id, metadata });
  }
  return out;
}
