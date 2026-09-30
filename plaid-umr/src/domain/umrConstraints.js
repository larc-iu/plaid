// The layer rules UMR asks core to hold (plaid-core's layer constraints),
// under its own namespace. One: a relation of the sentence graph ("UMR
// relations") joins two nodes of one sentence, which core holds as
// `same-ancestor` over the sentence token layer. The document graph is
// cross-sentence by design and carries none.
//
// A node's place is where its anchor begins, so an unaligned node standing
// over its whole sentence is placed in that sentence, the one it records.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { storedConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';
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

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One validator finding for the rules the stored data kept from being
 * declared (`pending` from ensureLayerConstraints), or none.
 * @param {Array<object>} pending
 * @param {object} layerInfo - from getUmrLayerInfo
 */
export const constraintFindings = (pending, layerInfo) => {
  if (!pending?.length) return [];
  const layers = [layerInfo?.relationLayer, layerInfo?.documentGraphLayer].filter(Boolean);
  const nameOf = (id) => layers.find((l) => l.id === id)?.name || 'UMR relations';
  const lines = pending.map((p) => {
    const n = p.violationCount;
    const name = nameOf(p.layerId);
    if (p.constraints?.length === 1 && p.constraints[0] === 'same-ancestor') {
      return (
        `The rule that a relation stays inside its sentence is not in force on ${name}: ` +
        `${count(n, 'relation crosses', 'relations cross')} sentences. ` +
        `Fix ${n === 1 ? 'it' : 'them'} to put it in force.`
      );
    }
    return `The rules of ${name} are not in force: ${count(n, 'relation breaks', 'relations break')} them.`;
  });
  return [
    {
      severity: 'warning',
      code: 'layer-rules-not-in-force',
      message: lines.join(' '),
      context: { pending },
    },
  ];
};
