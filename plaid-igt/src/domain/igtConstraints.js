// The layer rules IGT declares on the layers it owns (plaid-core's layer
// constraints), and the few places it reads them back.
//
// The server holds the rules and applies them inside every write, whoever
// writes: a word merged in another app joins IGT's doubled annotations and
// drops the extra vocabulary link in the merge's own transaction, a morpheme
// left without a word of its extent is deleted with the text save that did
// it, and a value outside a closed tagset is refused. What IGT used to heal
// on open, and the second batch its own merge used to send, are gone.

// Relative imports only: project setup (executeSetup.js) runs this from plain
// node too.
import { uuidv7 } from '@larc-iu/plaid-client';
import { IGT_NAMESPACE } from './igtConfig.js';
import { MODES, resolveTagset } from './tagsets.js';
import { valueSetAllows, violationsOf } from '../../../plaid-client-js/src/constraints.js';
import {
  queueRepairOfBareLayer,
  sameConstraints,
  storedConstraints,
} from '../../../plaid-ui/src/lib/layerConstraints.js';

const tokenEntry = (layer, constraints) => ({
  kind: 'token',
  layerId: layer.id,
  namespace: IGT_NAMESPACE,
  constraints,
  stored: storedConstraints(layer, IGT_NAMESPACE),
});

/**
 * The rules for one field: one span per token, and when its tagset is closed,
 * a value made only of listed tags. A `mixed` tagset's lexical parts are a
 * Leipzig reading the server does not hold, and an open one enforces nothing,
 * so neither declares a value set.
 */
export const fieldConstraints = (spanLayerConfig, projectConfig) => {
  const constraints = [{ type: 'single-span' }];
  const tagset = resolveTagset(spanLayerConfig, projectConfig);
  if (tagset?.mode === MODES.CLOSED) {
    constraints.push({
      type: 'value-set',
      values: tagset.values.map((v) => v.value),
      delimiters: tagset.delimiters,
      parts: 'all',
    });
  }
  return constraints;
};

/** The rules on the morpheme layer: as wide as a word, one vocabulary link. */
export const morphemeLayerConstraints = () => [{ type: 'coextensive' }, { type: 'single-link' }];

/** The rules on the word layer: one vocabulary link. */
export const wordLayerConstraints = () => [{ type: 'single-link' }];

/**
 * Queue on batch `b` a new field's span layer under `parentLayerId`, with its
 * scope, its language when `field.lang` says one, and its rules. The layer is
 * new and empty, so no data can refuse the rules, and since they go in the
 * batch that makes it, no failure after it leaves the field without them.
 * Returns the new layer's id.
 */
export const queueNewField = (b, parentLayerId, field, projectConfig) => {
  const id = uuidv7();
  b.spanLayers.create(parentLayerId, field.name, undefined, { id });
  b.spanLayers.setConfig(id, IGT_NAMESPACE, 'scope', field.scope);
  if (field.lang) b.spanLayers.setConfig(id, IGT_NAMESPACE, 'lang', field.lang);
  b.spanLayers.setConstraints(
    id,
    IGT_NAMESPACE,
    fieldConstraints({ [IGT_NAMESPACE]: { scope: field.scope } }, projectConfig),
    undefined,
    { expected: null },
  );
  return id;
};

/**
 * Every rule IGT wants on this project's layers, as `ensureLayerConstraints`
 * takes them (plaid-ui/src/lib/layerConstraints.js):
 *
 *   morpheme layer        coextensive, single-link
 *   word layer            single-link (IGT's, the layer is shared)
 *   each IGT field        single-span, plus value-set when its tagset is closed
 *
 * Lists are in a fixed order (by type, values in the tagset's order), so an
 * unchanged project compares equal and writes nothing.
 */
export const wantedConstraints = (layerInfo, projectConfig) => {
  const out = [];
  if (layerInfo?.morphemeTokenLayer?.id) {
    out.push(tokenEntry(layerInfo.morphemeTokenLayer, morphemeLayerConstraints()));
  }
  if (layerInfo?.primaryTokenLayer?.id) {
    out.push(tokenEntry(layerInfo.primaryTokenLayer, wordLayerConstraints()));
  }
  for (const scope of ['word', 'morpheme', 'sentence']) {
    for (const sl of layerInfo?.spanLayers?.[scope] || []) {
      if (!sl?.id) continue;
      out.push({
        kind: 'span',
        layerId: sl.id,
        namespace: IGT_NAMESPACE,
        constraints: fieldConstraints(sl.config, projectConfig),
        stored: storedConstraints(sl, IGT_NAMESPACE),
      });
    }
  }
  return out;
};

/**
 * Queue on batch `b` the declarations a settings save changes: every field
 * in `spanLayers` ({id, config, constraints}, each config as it will be after
 * the save) whose rules under `projectConfig` (the project's config after the
 * save) differ from what its layer holds. The declaration goes in the same
 * batch as the settings write, so a tagset the stored values break is refused
 * with them and stays as it was. A field whose layer holds no rules yet is
 * repaired first in the batch (`sl.constraints` given: the layer exists).
 * Returns how many declarations it queued.
 */
export const queueFieldDeclarations = (b, spanLayers, projectConfig) => {
  let n = 0;
  for (const sl of spanLayers || []) {
    if (!sl?.id) continue;
    const wanted = fieldConstraints(sl.config, projectConfig);
    const stored = storedConstraints(sl, IGT_NAMESPACE);
    if (sameConstraints(wanted, stored)) continue;
    // A layer that exists and holds no rules yet: what core can repair first.
    if (sl.constraints != null) {
      queueRepairOfBareLayer(b, { kind: 'span', layerId: sl.id, constraints: wanted, stored });
    }
    b.spanLayers.setConstraints(sl.id, IGT_NAMESPACE, wanted, undefined, {
      expected: stored ?? null,
    });
    n += 1;
  }
  return n;
};

/** Every IGT field of a layer info, as `queueFieldDeclarations` takes them. */
export const igtFields = (layerInfo) => Object.values(layerInfo?.spanLayers || {}).flat();

/**
 * The words for a settings save refused because stored values break the
 * tagset it would put in force, or null for any other refusal.
 */
export const tagsetRefusal = (error) => {
  const vs = violationsOf(error);
  if (!vs?.length || !vs.every((v) => v.constraint === 'value-set')) return null;
  const n = error.responseData['violation-count'] ?? vs.length;
  const fields = [...new Set(vs.map((v) => v.layerName).filter(Boolean))];
  const values = [...new Set(vs.map((v) => v.value).filter((v) => typeof v === 'string'))];
  const shown = values.slice(0, 5).join(', ') + (values.length > 5 ? ', …' : '');
  return `${n} ${n === 1 ? 'value' : 'values'} in ${fields.join(', ')} ${n === 1 ? 'is' : 'are'} not in the tagset: ${shown}.`;
};

/**
 * Whether a layer's value-set rules (any app's) allow `value`: every part
 * listed, or only the first with `parts: 'first'`. The server's rule, read
 * the same way, for the screen's mirror of a join it makes.
 */
export const valueSetsAllow = (layer, value) =>
  Object.values(layer?.constraints || {})
    .flat()
    .filter((c) => c?.type === 'value-set')
    .every((c) => valueSetAllows(c, value));

/**
 * What the server's rules leave after a word or sentence merge, for the
 * screen to show at once: in each field of the merged unit's scope, the
 * survivor's own annotation stays (else the one with the smallest id) and
 * takes the distinct values of the others joined with " | " in text order,
 * unless its field's closed tagset would refuse the joined value, and the
 * others go. Of the single-token vocabulary links now on the survivor, its
 * own stays (else the smallest id).
 *
 * @param {object} infoNext layer info of the patched document, spans already
 *   reparented onto the survivor
 * @param {object} vocabs the patched vocabularies, links already reparented
 * @param {string} survivorId
 * @param {Map<string, number>} beginOf where each annotation's word began
 *   before the merge, by annotation id
 * @param {{spans: Set<string>, links: Set<string>}} own the survivor's own
 *   annotations and links before the merge
 * @param {'word'|'sentence'} [scope] the fields of which scope the merge
 *   gathered on the survivor
 */
export const applyMergeRules = (infoNext, vocabs, survivorId, beginOf, own, scope = 'word') => {
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const sl of infoNext.spanLayers?.[scope] || []) {
    const onSurvivor = (sl.spans || []).filter(
      (s) => s.tokens?.length === 1 && s.tokens[0] === survivorId,
    );
    if (onSurvivor.length < 2) continue;
    const ids = onSurvivor.map((s) => s.id).sort(byId);
    const keepId = ids.find((id) => own.spans.has(id)) ?? ids[0];
    const keep = onSurvivor.find((s) => s.id === keepId);
    const others = onSurvivor
      .filter((s) => s.id !== keepId)
      .sort(
        (a, b) =>
          (beginOf.get(a.id) ?? Infinity) - (beginOf.get(b.id) ?? Infinity) || byId(a.id, b.id),
      );
    const kv = keep.value;
    let joined = kv;
    if (kv == null || typeof kv === 'string') {
      const strings = [];
      for (const v of [kv, ...others.map((s) => s.value)]) {
        if (typeof v === 'string' && v.trim() !== '' && !strings.includes(v)) strings.push(v);
      }
      if (strings.length) joined = strings.join(' | ');
    }
    if (valueSetsAllow(sl, joined)) keep.value = joined;
    const dead = new Set(others.map((s) => s.id));
    sl.spans = sl.spans.filter((s) => !dead.has(s.id));
  }
  const links = [];
  for (const vocab of Object.values(vocabs || {})) {
    for (const link of vocab.vocabLinks || []) {
      if (link.tokens?.length === 1 && link.tokens[0] === survivorId) links.push(link.id);
    }
  }
  if (links.length > 1) {
    const sorted = links.slice().sort(byId);
    const keep = sorted.find((id) => own.links.has(id)) ?? sorted[0];
    for (const vocab of Object.values(vocabs || {})) {
      if (Array.isArray(vocab.vocabLinks)) {
        vocab.vocabLinks = vocab.vocabLinks.filter(
          (l) => !(l.id !== keep && l.tokens?.length === 1 && l.tokens[0] === survivorId),
        );
      }
    }
  }
};
