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

import { provState, provOrigin, PROV_STATES, PROV } from '@larc-iu/plaid-client';

const FIELD_PROBS_KEY = {
  upos: 'uposProbs',
  xpos: 'xposProbs',
  deprel: 'deprelProbs',
};

export const PARSER_GROUP = 'Parser suggestions';

// The display mark an entity's provenance earns, or null when it renders plain:
// 'machine' for a machine's unverified material (violet), 'contributed' for a
// contributor's unreviewed work (amber). Hues are shared with plaid-igt through
// `--plaid-machine` / `--plaid-contributed` in the plaid-ui stylesheet, so a
// project open in both apps reads the same.
//
// A VERIFIED entity renders plain, like a person's own. plaid-igt keeps a quiet
// mark on one; UD does not, because confirming is the gesture the whole review
// flow is built on and seeing the mark go is how you know it landed. The value
// doubles as the CSS modifier suffix: `editable-field--machine`.
export const provMark = (metadata) => {
  const s = provState(metadata);
  return s === PROV_STATES.MACHINE || s === PROV_STATES.CONTRIBUTED ? s : null;
};

// The two hues, for the surfaces that cannot reach a CSS class: the dependency
// tree paints its arcs, arrowheads and labels with SVG presentation attributes,
// and those do not accept var(). Keyed by provMark.
//
// These MUST equal --plaid-machine and --plaid-contributed in plaid-ui's
// stylesheet. test/provenanceUi.test.js reads that file and asserts it, because
// a colour written twice and changed once is exactly the failure a .module.css
// naming --mantine-color-* shipped: silent, and only visible to whoever happens
// to look at the right screen.
export const PROV_MARK_COLORS = Object.freeze({
  machine: '#6d28d9',
  contributed: '#b45309',
});

// The sanitized { label: prob } distribution a producer recorded for this
// field, or null when there is none (the normal case today).
export function readFieldProbs(metadata, field) {
  const key = FIELD_PROBS_KEY[field];
  const raw = key && metadata?.[PROV.detailKey]?.[key];
  if (!raw || typeof raw !== 'object') return null;
  const entries = Object.entries(raw).filter(
    ([, p]) => typeof p === 'number' && Number.isFinite(p),
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

// Tooltip text: the base title, extended with the origin record when the
// entity is machine-made or contributed — producer, model/language from
// provDetail, and provProb when present. Once verified, say so (the
// prediction extras describe the ORIGINAL prediction, not necessarily the
// current value).
/** Every reserved provenance metadata key (the convention's flat slots). */
export const PROV_KEYS = Object.freeze(
  new Set([PROV.key, PROV.sourceKey, PROV.confirmedKey, PROV.probKey, PROV.detailKey]),
);

/** True for a reserved provenance key — what CoNLL-U export/import must not carry. */
export const isProvKey = (key) => PROV_KEYS.has(key);

export function provCellTitle(base, metadata) {
  const state = provState(metadata);
  if (state === PROV_STATES.HUMAN) return base;
  const detail = metadata?.[PROV.detailKey];
  const bits = [metadata?.[PROV.sourceKey]];
  if (detail?.model) bits.push(detail.model);
  if (detail?.language) bits.push(detail.language);
  const prob = metadata?.[PROV.probKey];
  if (typeof prob === 'number') bits.push(`p=${prob}`);
  const origin = provOrigin(metadata) === PROV.CONTRIBUTED ? 'contributed' : 'machine-made';
  const who =
    state === PROV_STATES.VERIFIED ? `${origin}, human-verified` : `${origin}, unverified`;
  return `${base}: ${who} (${bits.filter(Boolean).join(' · ')})`;
}
