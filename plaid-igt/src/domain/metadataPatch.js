// Turning a whole metadata MAP into the PATCH ops that write it.
//
// Several planners here hand back the map an entry should end up carrying:
// `planMergeRefs`, `planDeleteRefs` and `validateVocabRefs` in
// vocabDictionary.js, and the entry editor writes the same shape. That map used
// to go out as a PUT per entry, replacing everything. A bulk update takes
// metadata ops instead: a set op for every key whose value changed, and a
// delete op for every key that went away. Get that second half wrong and a
// sense stays parented to an entry that no longer exists.
//
// A patch is also the safer write of the two. A PUT of a map read a moment ago
// removes a key somebody else added in between. A patch names only what it
// means to change.

import { metadataOps } from '@larc-iu/plaid-client';

/**
 * The metadata ops that turn `before` into `after`, keys and deletions alike.
 * A key whose value is `undefined` counts as one the map does not carry, on
 * either side: JSON drops it, so a map that still "held" it would reach the
 * server without it, and the delete would quietly not happen. A key whose new
 * value is null is deleted, never stored as null.
 */
export const metadataPatchTo = (before, after) => {
  const held = (m, k) => m[k] !== undefined;
  const from = before || {};
  const to = after || {};
  const patch = {};
  for (const [k, v] of Object.entries(to)) if (v !== undefined && v !== from[k]) patch[k] = v;
  for (const k of Object.keys(from)) if (held(from, k) && !held(to, k)) patch[k] = null;
  return metadataOps(patch);
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
    if (metadata.length) out.push({ id: p.id, metadata });
  }
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether someone else changed what a save is about to write. `loaded` is the
 * entry (`{form, metadata}`) as the form read it, `next` what the save writes,
 * `now` the entry as the server holds it. A key the save changes counts only
 * when the server holds neither the value read nor the value saved (a resend of
 * this very save finds its own value). Keys the save leaves alone never count.
 */
export const changedUnderSave = (loaded, next, now) => {
  const was = loaded?.metadata || {};
  const will = next?.metadata || {};
  const is = now?.metadata || {};
  const keys = new Set([...Object.keys(was), ...Object.keys(will)]);
  for (const k of keys) {
    if (same(was[k], will[k])) continue;
    if (!same(is[k], was[k]) && !same(is[k], will[k])) return true;
  }
  if (loaded?.form !== next?.form && now?.form !== loaded?.form && now?.form !== next?.form)
    return true;
  return false;
};
