import { needsReview } from '@larc-iu/plaid-client';
import { resolveColor, baseRel } from '../../../utils/udVocab.js';
import { provMark, PROV_MARK_COLORS } from '../../../utils/provenanceUi.js';

// The rules that go with a deprel label, apart from the drawing of one
// (ArcLabel.jsx, which is where the note on why the two live together is).
// Here rather than beside the component because a file that exports a React
// component may export nothing else.

// The highlight on the label being worked on, and on the arc under it.
export const ACTIVE_BLUE = '#2563eb';

/**
 * What colour an arc and its label are drawn in: blue while it is the one
 * being worked on, else the hue of its provenance mark, else the DEPREL's own
 * configured colour. The mark is paired with a dashed stroke by the callers,
 * so the state never rests on colour alone (a configured DEPREL colour could
 * itself be purple).
 */
export const arcColor = (relation, active, deprelColors) => {
  if (active) return ACTIVE_BLUE;
  const mark = provMark(relation?.metadata);
  if (mark) return PROV_MARK_COLORS[mark];
  return resolveColor(baseRel(relation?.value || 'dep'), deprelColors);
};

/** An edited label, with the whitespace taken off. Empty means "write nothing". */
export const trimLabel = (v) => (v || '').trim();

/** Whether `t` is a different label from the one the relation wears. */
export const labelChanged = (relation, t) => t !== (relation?.value || 'dep');

/**
 * Whether leaving the editor writes anything. A changed label always commits;
 * an UNCHANGED one commits only when the human actually typed or picked it
 * (`typed`) over material still awaiting review — re-entering a machine's own
 * label is a confirmation of it (provenance write contract), while merely
 * opening the editor and leaving is not.
 */
export const commitsLabel = (relation, t, typed) =>
  labelChanged(relation, t) || (typed && needsReview(relation?.metadata));

/**
 * The next label along in visual order, wrapping at either end: what Tab and
 * the arrows move to.
 */
export const stepThrough = (ordered, id, delta) => {
  if (ordered.length === 0) return null;
  const i = ordered.findIndex((r) => r.id === id);
  if (i < 0) return null;
  return ordered[(i + delta + ordered.length) % ordered.length];
};

/**
 * Where the focus goes when a label's relation is deleted: the next one along,
 * or the one before it at the end of the row. Not a wrap — the row is one
 * shorter now — and it matters that it is somewhere, because focus on the page
 * body leaves every key here dead until the annotator clicks.
 */
export const afterDeleting = (ordered, id) => {
  const i = ordered.findIndex((r) => r.id === id);
  if (i < 0) return null;
  return ordered[i + 1] || ordered[i - 1] || null;
};
