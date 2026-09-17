// The ELAN round-trip expectation: what its loss list says an import gives back,
// as edits to the snapshots (see ./index.js).
//
// Not written yet: `incomplete` keeps the guard test from holding it to its
// list, and a round trip against it reports every change the list describes as
// a difference.

export default {
  id: 'elan',
  incomplete: true,
  strips: {},
  steps: [],
};
