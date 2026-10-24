// What plaid-core's single-span rule leaves after a token merge, for an app's
// copy to show at once (plaid-core `remedy-single-span!`). A merge moves the
// merged tokens' spans onto the survivor, and on a layer with the rule the
// survivor's own span stays (else the one with the smallest id), takes the
// distinct values of the others joined in text order, unless a value-set
// rule on its layer would refuse the joined value, and the others go.
//
// Generic over the document read's span layers, with nothing of any app.
// Relative imports only, so plaid-ud's node suite and igt's setup can load it.

import { PROV, PROVENANCE_KEYS, isMachine } from '../../../plaid-client-js/src/provenance.js';
import { valueSetAllows } from '../../../plaid-client-js/src/constraints.js';

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const rulesOf = (layer) => Object.values(layer?.constraints || {}).flat();

/** The single-span rule a span layer carries, in any app's namespace, or null. */
export const singleSpanRule = (layer) =>
  rulesOf(layer).find((c) => c?.type === 'single-span') ?? null;

/**
 * Whether a layer's value-set rules (any app's) allow `value`: every part
 * listed, or only the first with `parts: 'first'`. The server's rule, read
 * the same way.
 */
export const valueSetsAllow = (layer, value) =>
  rulesOf(layer)
    .filter((c) => c?.type === 'value-set')
    .every((c) => valueSetAllows(c, value));

/**
 * The metadata a joined span holds (plaid-core `joined-provenance`,
 * HUNT-model M1): `inputs` are the spans joined, the kept one first and then
 * in the join's order, and `joined` the value it now holds. A person's value
 * in the join (anything but an unverified machine value) makes it that
 * person's, the first such input's provenance keys. Unverified machine values
 * alone keep the kept one's. Either way the producer's probability goes when
 * the value held is not the one it weighed. The kept span's other keys stay.
 */
const joinedMetadata = (inputs, joined) => {
  const held = inputs.filter((s) => typeof s.value === 'string' && s.value.trim() !== '');
  const from = held.find((s) => !isMachine(s.metadata)) ?? inputs[0];
  const keepProb = joined === from.value;
  const out = { ...(inputs[0].metadata || {}) };
  for (const k of PROVENANCE_KEYS) {
    const v = from.metadata?.[k];
    if (v != null && (keepProb || k !== PROV.probKey)) out[k] = v;
    else delete out[k];
  }
  return out;
};

const sameMetadata = (a, b) => {
  const ka = Object.keys(a || {});
  return (
    ka.length === Object.keys(b || {}).length &&
    ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
  );
};

/**
 * Apply the join to span layer `sl` in place, over the spans now on
 * `survivorId` alone. `beginOf` gives where each moved span's token began
 * before the merge (the join's order), `own` the ids of the spans the
 * survivor had before it, and `joinWith` the rule's separator.
 */
export const joinSpansOn = (sl, survivorId, beginOf, own, joinWith = ' | ') => {
  const onSurvivor = (sl.spans || []).filter(
    (s) => s.tokens?.length === 1 && s.tokens[0] === survivorId,
  );
  if (onSurvivor.length < 2) return;
  const ids = onSurvivor.map((s) => s.id).sort(byId);
  const keepId = ids.find((id) => own.has(id)) ?? ids[0];
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
    if (strings.length) joined = strings.join(joinWith);
  }
  if (valueSetsAllow(sl, joined)) {
    const md = joinedMetadata([keep, ...others], joined);
    if (!sameMetadata(md, keep.metadata)) keep.metadata = md;
    keep.value = joined;
  }
  const dead = new Set(others.map((s) => s.id));
  sl.spans = sl.spans.filter((s) => !dead.has(s.id));
};
