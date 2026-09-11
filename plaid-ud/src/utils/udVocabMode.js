// Whether a project's controlled vocabularies are suggestions or rules, and the
// one-line definitions shown beside a value while picking one.
//
// Both are SIBLING keys next to the existing ones, never a new shape for them:
//
//   ud.vocab              string[]                     (unchanged)
//   ud.inventory          [{key, values}]              (unchanged)
//   ud.vocabMode          'open' | 'closed'            (new, absent = open)
//   ud.vocabDescriptions  {value: 'one line'}          (new, absent = none)
//
// The alternative was folding the values into `{values: [{value, description}],
// mode}` the way plaid-igt shapes a tagset. That would change `ud.vocab` under
// every project that already has one, and reading both shapes afterwards is
// exactly the legacy handling this repo does not do. Additive keys need no
// migration and no branch.
//
// DEFAULT IS OPEN, by Luke's ruling: a vocabulary offers values and accepts
// anything until a maintainer decides otherwise. Off-list machine output is a
// signal worth seeing, not an error worth refusing, and the Validation tab is
// where it gets cleaned up.

import { baseRel } from './udVocab.js';

const UD_NAMESPACE = 'ud';

export const MODES = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

/** A vocabulary's mode. Anything unrecognised, absent included, reads as open. */
export const readVocabMode = (config) =>
  config?.[UD_NAMESPACE]?.vocabMode === MODES.CLOSED ? MODES.CLOSED : MODES.OPEN;

/** True when this vocabulary refuses values outside its list. */
export const isClosed = (config) => readVocabMode(config) === MODES.CLOSED;

/**
 * The stored `{value: description}` map, as a fresh copy so a caller cannot
 * mutate the layer config in place. `fallback` supplies the definitions that
 * ship with the app for a vocabulary nobody has edited.
 */
export const readDescriptions = (config, fallback = {}) => {
  const raw = config?.[UD_NAMESPACE]?.vocabDescriptions;
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  return { ...fallback, ...(stored || {}) };
};

/** Only the entries worth storing: a description for a value that has one. */
export const cleanDescriptions = (descriptions) =>
  Object.fromEntries(
    Object.entries(descriptions || {})
      .map(([value, text]) => [value, typeof text === 'string' ? text.trim() : ''])
      .filter(([, text]) => text !== ''),
  );

/**
 * Whether a value may be committed to a closed vocabulary of plain tags (UPOS,
 * XPOS). An EMPTY value is always allowed: clearing a cell is not annotating it.
 */
export const allowsPlainValue = (value, vocab, config) => {
  if (!value) return true;
  if (!isClosed(config)) return true;
  return (vocab || []).includes(value);
};

/**
 * The same question for a DEPREL, where a closed list governs the BASE relation
 * only: `nsubj:pass` is legal wherever `nsubj` is. Subtypes are language-
 * specific and open-ended by design, and a project that listed every one it
 * used would be re-listing the language.
 */
export const allowsDeprel = (value, vocab, config) => {
  if (!value) return true;
  if (!isClosed(config)) return true;
  return (vocab || []).some((v) => baseRel(v) === baseRel(value));
};

/**
 * And for a feature, where a closed inventory governs both halves: the KEY must
 * be in the inventory and the VALUE in that key's list. A key whose list is
 * empty accepts any value, which is how an inventory says "this feature exists,
 * its values are the language's business".
 *
 * `value` is a whole `Key=Value` string, as the chip input commits it.
 */
export const allowsFeature = (value, inventoryMap, config) => {
  if (!value) return true;
  if (!isClosed(config)) return true;
  const eq = value.indexOf('=');
  if (eq < 1) return false;
  const key = value.slice(0, eq);
  const val = value.slice(eq + 1);
  if (!inventoryMap?.has(key)) return false;
  const allowed = inventoryMap.get(key) || [];
  return allowed.length === 0 || allowed.includes(val);
};

/**
 * What a refusal says. Short, names the value and the list, and does not
 * apologise: the annotator either meant a different tag or wants the list
 * changed, and both are one click away for a maintainer.
 */
export const refusalMessage = (value, field) => `${value} is not in this project's ${field} list.`;

/**
 * The refusal rule for each annotation field, as `(value) => message | null`,
 * built once from a document's layerInfo. The cells take a function rather than
 * a mode and a list, so the rule lives here and a cell only has to ask.
 *
 * An open vocabulary yields a validator that always says null, which is the
 * normal case and costs a call.
 */
export const makeValidators = (layerInfo) => {
  const vocab = layerInfo?.vocab || {};
  const modes = layerInfo?.modes || {};
  const closedFor = (field) => modes[field] === MODES.CLOSED;
  const plain = (field, list, label) => (value) =>
    !closedFor(field) || allowsPlainValue(value, list, { ud: { vocabMode: MODES.CLOSED } })
      ? null
      : refusalMessage(value, label);
  return {
    upos: plain('upos', vocab.upos, 'UPOS'),
    xpos: plain('xpos', vocab.xpos, 'XPOS'),
    deprel: (value) =>
      !closedFor('deprel') || allowsDeprel(value, vocab.deprel, { ud: { vocabMode: MODES.CLOSED } })
        ? null
        : refusalMessage(value, 'dependency relation'),
    feats: (value) =>
      !closedFor('feats') ||
      allowsFeature(value, vocab.featureInventory?.map, { ud: { vocabMode: MODES.CLOSED } })
        ? null
        : refusalMessage(value, 'feature'),
  };
};
