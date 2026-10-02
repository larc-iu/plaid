// The layer rules UMR asks core to hold (plaid-core's layer constraints),
// under its own namespace, on the sentence graph ("UMR relations"): a
// relation joins two nodes of one sentence, which core holds as
// `same-ancestor` over the sentence token layer. The document graph is
// cross-sentence by design and carries none.
//
// The rule that the graph has no cycle but through a cycle role
// (CYCLE_ROLES) is not core's: the canvas, Text mode, the Draft service and
// the assistant each refuse a graph that breaks it, a sentence at a time.
// Core's `acyclic` refused an edit to a relation on a cycle a file brought,
// and a whole batch of drafted sentences for one of them (REV-FX-CORE F2,
// F4), so a layer an earlier open declared it on has it taken off.
//
// A node's place is where its anchor begins, so an unaligned node standing
// over its whole sentence is placed in that sentence, the one it records.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { rulesNotInForce, storedConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';
import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';

/** The rules on the sentence graph's relation layer, for a sentence layer id. */
export const relationRules = (sentenceLayerId) => [
  { type: 'same-ancestor', tokenLayer: sentenceLayerId },
];

/**
 * What UMR declares, as `ensureLayerConstraints` takes it: one entry per
 * layer, with the list the layer holds now under `umr`. Empty while the
 * project lacks the relation layer or the sentence layer.
 * @param {object} layerInfo - from getUmrLayerInfo
 */
export const wantedConstraints = (layerInfo) => {
  const { relationLayer, sentenceTokenLayer } = layerInfo || {};
  if (!relationLayer || !sentenceTokenLayer) return [];
  return [
    {
      kind: 'relation',
      layerId: relationLayer.id,
      namespace: UMR_NAMESPACE,
      constraints: relationRules(sentenceTokenLayer.id),
      stored: storedConstraints(relationLayer, UMR_NAMESPACE),
    },
  ];
};

/**
 * The validator findings for the rules the stored data kept from being
 * declared (`pending` from ensureLayerConstraints), one per layer (plaid-ui's).
 * @param {Array<object>} pending
 * @param {object} layerInfo - from getUmrLayerInfo
 */
export const constraintFindings = (pending, layerInfo) =>
  rulesNotInForce(pending, [layerInfo?.relationLayer, layerInfo?.documentGraphLayer]);
