import { PROV, PROV_STATES, provOrigin, provState } from '@larc-iu/plaid-client';

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
const TITLES = {
  [PROV_STATES.MACHINE]: 'Machine-made, unverified',
  [PROV_STATES.CONTRIBUTED]: 'Contributed, unverified',
};

// `{ mark, title }`: `mark` is 'machine', 'contributed' or null, `title`
// the tooltip's words, null for hand-made material.
export const provMark = (metadata) => {
  const state = provState(metadata);
  if (state !== PROV_STATES.VERIFIED) {
    return { mark: MARKS[state] || null, title: TITLES[state] || null };
  }
  return {
    mark: null,
    title:
      provOrigin(metadata) === PROV.CONTRIBUTED
        ? 'Contributed, confirmed'
        : 'Machine-made, confirmed',
  };
};

// The mark that needs a look first, of several things shown as one (a tag
// that lists several relations): machine, then contributed.
export const worstMark = (marks) =>
  marks.includes('machine') ? 'machine' : marks.includes('contributed') ? 'contributed' : null;
