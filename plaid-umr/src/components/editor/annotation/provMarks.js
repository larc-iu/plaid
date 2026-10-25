import { PROV_STATES } from '@larc-iu/plaid-client';
import { provDescription } from '@ui/domain/provDescription.js';

// Provenance, the cross-app convention: what a machine drafted or a
// contributor made wears a dashed border in one of the two hues every app
// uses until somebody settles it. A node, an edge's relation label and a
// document-level tag carry the same mark, so there is one thing to learn.
// The line of an edge never does: a dashed line is a re-entrancy.
//
// Colour means provenance here, as it does in the igt grid, and the mark goes
// the moment a person edits the thing, because the edit carries the writer's
// stamp (UmrDocument's `writer`). Marking what needs attention rather than
// what is finished is why verified material draws plain, with a tooltip that
// still says where it came from, in igt's words (provTitle there).
const MARKS = {
  [PROV_STATES.MACHINE]: 'machine',
  [PROV_STATES.CONTRIBUTED]: 'contributed',
};

// `{ mark, title }`: `mark` is 'machine', 'contributed' or null, `title`
// the tooltip's words ('Machine-made, unverified', 'Contributed, confirmed'),
// null for hand-made material.
export const provMark = (metadata) => {
  const { state, word } = provDescription(metadata);
  if (state === PROV_STATES.HUMAN) return { mark: null, title: null };
  const how = state === PROV_STATES.VERIFIED ? 'confirmed' : 'unverified';
  return {
    mark: MARKS[state] || null,
    title: `${word.charAt(0).toUpperCase()}${word.slice(1)}, ${how}`,
  };
};

// The mark that needs a look first, of several things shown as one (a tag
// that lists several relations): machine, then contributed.
export const worstMark = (marks) =>
  marks.includes('machine') ? 'machine' : marks.includes('contributed') ? 'contributed' : null;
