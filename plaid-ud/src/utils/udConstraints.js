// The layer rules UD declares on the layers it owns (plaid-core's layer
// constraints). The server applies them inside every write, whoever writes:
// a dependency relation left crossing a sentence boundary by a split made in
// another app is deleted in the split's own transaction, a syntactic word
// left without a word of its extent goes with the text save that did it, a
// second head, a cycle or a value outside a closed list is refused. What UD
// used to heal on open is gone.

import { MODES, valueSetRule } from './udVocabMode.js';
import {
  queueRepairOfBareLayer,
  rulesNotInForce as findingsFor,
  sameConstraints,
} from '../../../plaid-ui/src/lib/layerConstraints.js';

const UD_NAMESPACE = 'ud';

const stored = (layer) => layer?.constraints?.[UD_NAMESPACE] ?? null;

const entry = (kind, layer, constraints) => ({
  kind,
  layerId: layer.id,
  namespace: UD_NAMESPACE,
  constraints,
  stored: stored(layer),
});

/**
 * Every rule UD wants on this project's layers, as plaid-ui's
 * `ensureLayerConstraints` takes them:
 *
 *   syntactic words        coextensive (each has its word's extent)
 *   Form, Lemma            single-span
 *   UPOS, XPOS             single-span, plus value-set when the list is closed
 *   basic dependencies     acyclic (a root heads itself), max-in-degree 1,
 *                          same-ancestor (one sentence), plus value-set on the
 *                          base relation when the list is closed
 *   enhanced dependencies  same-ancestor
 *
 * Features are many per token and keep their two-level inventory in the app.
 * Lists are in a fixed order (by type), so an unchanged project writes nothing.
 *
 * @param {object} info getUdLayerInfo's answer
 */
export const wantedConstraints = (info) => {
  const out = [];
  if (!info) return out;
  if (info.morphemeTokenLayer?.id && info.wordTokenLayer?.id) {
    out.push(entry('token', info.morphemeTokenLayer, [{ type: 'coextensive' }]));
  }
  const plain = (layer, field) => {
    if (!layer?.id) return;
    const constraints = [{ type: 'single-span' }];
    if (field && info.modes?.[field] === MODES.CLOSED) {
      constraints.push(valueSetRule(field, info.vocab?.[field]));
    }
    out.push(entry('span', layer, constraints));
  };
  plain(info.formLayer);
  plain(info.lemmaLayer);
  plain(info.uposLayer, 'upos');
  plain(info.xposLayer, 'xpos');
  const sentences = info.sentenceTokenLayer?.id;
  if (info.relationLayer?.id) {
    const constraints = [
      { type: 'acyclic', selfLoops: true },
      { type: 'max-in-degree', max: 1 },
    ];
    if (sentences) constraints.push({ type: 'same-ancestor', tokenLayer: sentences });
    if (info.modes?.deprel === MODES.CLOSED) {
      constraints.push(valueSetRule('deprel', info.vocab?.deprel));
    }
    out.push(entry('relation', info.relationLayer, constraints));
  }
  if (info.enhancedRelationLayer?.id && sentences) {
    out.push(
      entry('relation', info.enhancedRelationLayer, [
        { type: 'same-ancestor', tokenLayer: sentences },
      ]),
    );
  }
  return out;
};

const BUNDLE = { token: 'tokenLayers', span: 'spanLayers', relation: 'relationLayers' };

/**
 * Queue on batch `b` the declarations a settings save changes: the layers
 * whose rules differ between `before` and `after` (getUdLayerInfo of the
 * project before and after the save), each naming what it holds, as IGT's
 * settings do. The declaration goes in the same batch as the settings
 * write, so a list the stored data breaks is refused with it. A layer that
 * holds no rules yet is repaired first in the batch, so only a violation
 * with no remedy refuses it. Returns how
 * many it queued.
 */
export const queueRuleChanges = (b, before, after) => {
  const was = new Map(wantedConstraints(before).map((w) => [w.layerId, w]));
  let n = 0;
  for (const w of wantedConstraints(after)) {
    if (sameConstraints(w.constraints, was.get(w.layerId)?.constraints)) continue;
    queueRepairOfBareLayer(b, w);
    b[BUNDLE[w.kind]].setConstraints(w.layerId, w.namespace, w.constraints, undefined, {
      expected: w.stored ?? null,
    });
    n += 1;
  }
  return n;
};

/** The findings for the layers whose rules are not in force (plaid-ui's). */
export const rulesNotInForce = (pending, info) =>
  findingsFor(pending, [
    info?.morphemeTokenLayer,
    info?.formLayer,
    info?.lemmaLayer,
    info?.uposLayer,
    info?.xposLayer,
    info?.relationLayer,
    info?.enhancedRelationLayer,
  ]);

/**
 * A copy of `project` with each of `writes` ({entity, key, value}, a config
 * write under the UD namespace) applied to the layer or project it names, to
 * read the rules a settings save leaves (queueRuleChanges).
 */
export const withConfigWrites = (project, writes) => {
  const copy = structuredClone(project);
  const byId = new Map([[copy?.id, copy]]);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.id && node.config) byId.set(node.id, node);
    for (const k of ['textLayers', 'tokenLayers', 'spanLayers', 'relationLayers']) walk(node[k]);
  };
  walk(copy?.textLayers);
  for (const { entity, key, value } of writes) {
    const target = byId.get(entity?.id);
    if (!target) continue;
    target.config = {
      ...target.config,
      [UD_NAMESPACE]: { ...target.config?.[UD_NAMESPACE], [key]: value },
    };
  }
  return copy;
};

/**
 * Queue on batch `b` a declaration for every entry of `wanted` (see
 * wantedConstraints) that differs from what its layer holds, each naming
 * what it read. For layers just made, which hold nothing and cannot be
 * refused.
 */
export const queueDeclarations = (b, wanted) => {
  for (const w of wanted) {
    if (sameConstraints(w.stored, w.constraints)) continue;
    b[BUNDLE[w.kind]].setConstraints(w.layerId, w.namespace, w.constraints, undefined, {
      expected: w.stored ?? null,
    });
  }
};
