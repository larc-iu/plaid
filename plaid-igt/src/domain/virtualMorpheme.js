// A word that has never been analyzed has no morpheme token of its own, and it
// does not need one: a default morpheme's extent is its word's extent, its form
// is its word's text, and it carries no annotation. Every field is derivable,
// so the row stored nothing.
//
// `derive` therefore synthesizes one for each such word, and the editor renders
// it like any other. It becomes a real token the first time anyone writes to
// it, through `_materializeMorpheme`. Until then it carries this id, which
// names the word it belongs to so materialization needs no lookup table, and
// which is deliberately not uuid-shaped so a leak to the server is obvious
// rather than silent.
const PREFIX = 'virtual:';

export const virtualMorphemeId = (wordTokenId) => `${PREFIX}${wordTokenId}`;

export const isVirtualMorphemeId = (id) => typeof id === 'string' && id.startsWith(PREFIX);

/** The word a virtual morpheme belongs to, or null if `id` is a real token. */
export const virtualMorphemeWordId = (id) =>
  isVirtualMorphemeId(id) ? id.slice(PREFIX.length) : null;
