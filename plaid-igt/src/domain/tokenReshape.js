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
// Orthographies do NOT follow. An `orthog:*` value transcribes the token's
// text, and after a reshape it transcribes text that no longer exists: the
// left half of a split would keep a transcription of the whole original word.
// A wrong transcription reads as real, so they are cleared rather than
// apportioned or copied.

import { PROV, mergeMetadata, needsReview } from '@larc-iu/plaid-client';

const PROV_KEYS = [PROV.key, PROV.sourceKey, PROV.confirmedKey, PROV.probKey, PROV.detailKey];

const ORTHOG_PREFIX = 'orthog:';

/** Just the provenance keys of a metadata map. */
export const provenanceOf = (metadata) => {
  const out = {};
  for (const key of PROV_KEYS) {
    if (metadata && metadata[key] !== undefined) out[key] = metadata[key];
  }
  return out;
};

/** A patch that removes every orthography key the token has (null deletes). */
export const clearOrthographies = (metadata) => {
  const out = {};
  for (const key of Object.keys(metadata || {})) {
    if (key.startsWith(ORTHOG_PREFIX)) out[key] = null;
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
 * are returned: the edit stamp, the provenance it is inheriting, and the
 * orthographies to drop. Null when there is nothing to write.
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
    ...clearOrthographies(own),
  };
  // Only the keys that actually change anything.
  for (const [key, value] of Object.entries(patch)) {
    if (own?.[key] === value) delete patch[key];
  }
  return Object.keys(patch).length ? patch : null;
};

/**
 * The whole metadata map for a token BORN of a reshape (the right half of a
 * split). It starts empty, so it gets the provenance and nothing else: no
 * orthographies, and no `form` — the text under it is not the text that value
 * described. Null when the original carried no provenance.
 */
export const newHalfMetadata = (original, editStamp) => {
  const provenance = provenanceOf(original);
  if (!Object.keys(provenance).length) return null;
  return mergeMetadata(provenance, editStamp(original) || {});
};
