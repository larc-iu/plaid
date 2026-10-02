// The layer rules UMR asks core to hold (plaid-core's layer constraints),
// under its own namespace, on the sentence graph ("UMR relations"): a
// relation joins two nodes of one sentence, which core holds as
// `same-ancestor` over the sentence token layer, and the graph has no cycle
// but through a cycle role (CYCLE_ROLES), which core holds as `acyclic`. A
// cycle an import, a copy or a restore wrote is kept, as the canvas keeps
// one a file brings. The document graph is cross-sentence by design and
// carries none.
//
// A node's place is where its anchor begins, so an unaligned node standing
// over its whole sentence is placed in that sentence, the one it records.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { rulesNotInForce, storedConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';
import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';
import { CYCLE_ROLES } from './format/inventory.js';

/** The rules on the sentence graph's relation layer, for a sentence layer id. */
export const relationRules = (sentenceLayerId) => [
  { type: 'same-ancestor', tokenLayer: sentenceLayerId },
  { type: 'acyclic', exceptValues: [...CYCLE_ROLES] },
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
