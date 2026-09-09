// What a token carries through a SPLIT or a MERGE.
//
// The server splits a row and leaves its metadata alone: the surviving half
// keeps everything, the new half is born bare, and a merge keeps whatever the
// survivor had. That is right for a generic layer, which has no business
// knowing that `prov` means something and `form` means something else. Deciding
// what those keys mean when a token is reshaped is this app's job, and this is
// where it is decided.
//
// TWO RULES.
//
// Provenance follows the material. Reshaping a token is a person editing
// machine material, which is exactly what `doc.editStamp` is for: a verifier's
// edit confirms it and keeps the origin, a contributor's marks it contributed,
// and it is null when the material was already a person's. Both halves of a
// split get it, so one word never renders as two different kinds of thing; the
// survivor of a merge gets it too. Where merged tokens disagree, the one that
// most needs review wins, because the whole point of the mark is that
// unreviewed machine work gets seen rather than absorbed into a neighbour.
//
// Nothing else is touched. Orthographies, forms and every other key are the
// USER'S content: after a reshape one of them may describe text that no longer
// exists, but the person who reshaped the token knows that, and a stale value
// they can edit down beats a deleted one they must retype. We cannot write
// the new value for them, so we leave theirs alone. (This was briefly the other
// way round, clearing `orthog:*`; the user's call, and the right one.)

import { PROV, mergeMetadata, needsReview } from '@larc-iu/plaid-client';

const PROV_KEYS = [PROV.key, PROV.sourceKey, PROV.confirmedKey, PROV.probKey, PROV.detailKey];

/** Just the provenance keys of a metadata map. */
export const provenanceOf = (metadata) => {
  const out = {};
  for (const key of PROV_KEYS) {
    if (metadata && metadata[key] !== undefined) out[key] = metadata[key];
  }
  return out;
};

/**
 * Of several tokens being merged, whose provenance the survivor takes: the
 * first that still needs review, else the first that carries any, else none.
 */
export const survivingProvenance = (metadatas) => {
  const carrying = (metadatas || []).filter((m) => m && m[PROV.key] !== undefined);
  return provenanceOf(carrying.find((m) => needsReview(m)) ?? carrying[0] ?? null);
};

/**
 * The metadata patch for a token that SURVIVES a reshape (the left half of a
 * split, the survivor of a merge). It keeps what it has, so only the changes
 * are returned: the edit stamp and the provenance it is inheriting. Null when
 * there is nothing to write.
 *
 * @param {Object} own        the surviving token's metadata
 * @param {Object} inherited  the provenance the reshape settles on
 * @param {Function} editStamp  doc.editStamp
 */
export const survivorPatch = (own, inherited, editStamp) => {
  const provenance = Object.keys(inherited || {}).length ? inherited : provenanceOf(own);
  const patch = {
    ...provenance,
    ...(editStamp(mergeMetadata(own, provenance)) || {}),
  };
  // Only the keys that actually change anything.
  for (const [key, value] of Object.entries(patch)) {
    if (own?.[key] === value) delete patch[key];
  }
  return Object.keys(patch).length ? patch : null;
};

/**
 * The whole metadata map for a token BORN of a reshape (the right half of a
 * split). It starts empty, so it gets the provenance and nothing else: an
 * orthography or a `form` copied onto it would describe text it does not
 * cover. Null when the original carried no provenance.
 */
export const newHalfMetadata = (original, editStamp) => {
  const provenance = provenanceOf(original);
  if (!Object.keys(provenance).length) return null;
  return mergeMetadata(provenance, editStamp(original) || {});
};
