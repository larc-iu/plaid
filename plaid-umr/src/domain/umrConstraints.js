// The layer rules UMR asks core to hold (plaid-core's layer constraints),
// under its own namespace, on the sentence graph ("UMR relations"): a
// relation joins two nodes of one sentence, which core holds as
// `same-ancestor` over the sentence token layer. The document graph is
// cross-sentence by design and carries none. Setup and adopt declare it
// (umrProjectSetup.js).
//
// The rule that the graph has no cycle but through a cycle role
// (CYCLE_ROLES) is not core's: the canvas, Text mode, the Draft service and
// the assistant each refuse a graph that breaks it, a sentence at a time.
//
// A node's place is where its anchor begins, so an unaligned node standing
// over its whole sentence is placed in that sentence, the one it records.

/** The rules on the sentence graph's relation layer, for a sentence layer id. */
export const relationRules = (sentenceLayerId) => [
  { type: 'same-ancestor', tokenLayer: sentenceLayerId },
];
