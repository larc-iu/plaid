// Read-side helpers for the provenance convention's prediction extras
// (manual, "Provenance"): rank selector suggestions by a parser's declared
// distribution, and describe a machine-made annotation for tooltips.
//
// plaid-ud reads per-field distributions from these provDetail keys, each a
// flat { label: probability } map (parsers that emit distributions should
// write the top handful, not the whole tag set):
//   UPOS  -> provDetail.uposProbs
//   XPOS  -> provDetail.xposProbs
//   deprel-> provDetail.deprelProbs

import { provState, PROV_STATES, PROV } from '@larc-iu/plaid-client';

const FIELD_PROBS_KEY = {
  upos: 'uposProbs',
  xpos: 'xposProbs',
  deprel: 'deprelProbs',
};

export const PARSER_GROUP = 'Parser suggestions';

// The sanitized { label: prob } distribution a producer recorded for this
// field, or null when there is none (the normal case today).
export function readFieldProbs(metadata, field) {
  const key = FIELD_PROBS_KEY[field];
  const raw = key && metadata?.[PROV.detailKey]?.[key];
  if (!raw || typeof raw !== 'object') return null;
  const entries = Object.entries(raw).filter(
    ([, p]) => typeof p === 'number' && Number.isFinite(p)
  );
  return entries.length ? Object.fromEntries(entries) : null;
}

// Group a selector's vocab so the producer's top-k floats above the rest:
//   [{ group: 'Parser suggestions', items: top-k by prob desc },
//    { group: 'All tags', items: the remaining vocab }]
// Falls back to the plain list when there is no distribution. Labels the
// parser suggested that are off-vocab still appear (they're what it thinks).
export function groupSuggestions(suggestions, probs, { topK = 5, restLabel = 'All tags' } = {}) {
  const base = suggestions || [];
  if (!probs) return base;
  const ranked = Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([label]) => label);
  if (!ranked.length) return base;
  const rankedSet = new Set(ranked);
  const rest = base.filter((s) => !rankedSet.has(s));
  const groups = [{ group: PARSER_GROUP, items: ranked }];
  if (rest.length) groups.push({ group: restLabel, items: rest });
  return groups;
}

// '84%' for an option the distribution covers, else null. Used by
// renderOption to decorate; the option's committed value stays the bare tag.
export function probLabel(probs, value) {
  const p = probs?.[value];
  return typeof p === 'number' && Number.isFinite(p) ? `${Math.round(p * 100)}%` : null;
}

// Tooltip text: the base title, extended with the machine-origin record when
// the entity is machine-made — producer, model/language from provDetail, and
// provProb when present. Once verified, say so (the prediction extras
// describe the ORIGINAL prediction, not necessarily the current value).
export function provCellTitle(base, metadata) {
  const state = provState(metadata);
  if (state === PROV_STATES.HUMAN) return base;
  const detail = metadata?.[PROV.detailKey];
  const bits = [metadata?.[PROV.sourceKey]];
  if (detail?.model) bits.push(detail.model);
  if (detail?.language) bits.push(detail.language);
  const prob = metadata?.[PROV.probKey];
  if (typeof prob === 'number') bits.push(`p=${prob}`);
  const who = state === PROV_STATES.VERIFIED
    ? 'machine-made, human-verified'
    : 'machine-made, unverified';
  return `${base}: ${who} (${bits.filter(Boolean).join(' · ')})`;
}
