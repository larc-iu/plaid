// The words for a settings save not made because values in use are not in a
// closed list, as `refusedBySave` (domain/igtConstraints.js) answers it: each
// field's count and most frequent values, and of a composite value the parts
// not in the list. RefusedValuesNotice shows them in a panel, and a toast
// says them where no panel can.

export const REFUSED_TITLE = 'Not saved';
export const REFUSED_LEAD = 'These values are in use and not in the list:';

// The parts of a refused value that are not in the list, when the server's
// answer names fewer than the whole value (`1SG` of `1SG.NOM`), else null.
export const unlistedParts = (v) => {
  const parts = Array.isArray(v?.parts) ? v.parts : [];
  if (!parts.length || (parts.length === 1 && parts[0] === v.value)) return null;
  return parts.map((p) => (p === '' ? 'an empty part' : String(p))).join(', ');
};

export const countWord = (n) => `${n} ${n === 1 ? 'annotation' : 'annotations'}`;

export const moreText = (f) =>
  f.valueCount > f.values.length ? `, and ${f.valueCount - f.values.length} more` : '';

const valueText = (v) => {
  const parts = unlistedParts(v);
  return `${String(v.value)} (${v.count}${parts ? `, ${parts} not listed` : ''})`;
};

/**
 * The refusal as one line of text, for a toast where no panel can show it:
 * "These values are in use and not in the list: Gloss: 2 annotations, QQ (2)."
 */
export const refusedValuesText = (fields) =>
  `${REFUSED_LEAD} ${fields
    .map(
      (f) =>
        `${f.field}: ${countWord(f.count)}, ${f.values.map(valueText).join(', ')}${moreText(f)}.`,
    )
    .join(' ')}`;

export const NOT_IN_FORCE_TITLE = 'Not in force';
export const NOT_IN_FORCE_ACTION =
  'Change these values, then choose Put in force under Validation.';

const UNITS = { Word: 'word', Morpheme: 'morpheme', Sentence: 'sentence' };
const unitWord = (scope, n) => `${UNITS[scope] ?? 'word'}${n === 1 ? '' : 's'}`;

/**
 * A closed list left out of force because values in use are not in it, as
 * `declareIgtRules` (domain/igtConstraints.js) answers it, one line a field:
 * "“Leipzig” is not in force on Morph Gloss: 1 annotation not in the list,
 * QQ (1)." A field whose annotations would need joining to take its rules
 * (`repair`): "Raw note: 1 word with more than one annotation." A rule
 * refused for another reason has no values to name.
 */
export const notInForceLines = (fields) =>
  fields.map((f) => {
    const lines = [];
    if (f.values?.length) {
      lines.push(
        `${f.tagset ? `“${f.tagset}”` : 'The closed list'} is not in force on ${f.field}: ${countWord(f.count)} not in the list, ${f.values.map(valueText).join(', ')}${moreText(f)}.`,
      );
    }
    if (f.repair?.length) {
      const n = f.repairCount ?? 0;
      lines.push(`${f.field}: ${n} ${unitWord(f.scope, n)} with more than one annotation.`);
    }
    if (!lines.length) {
      lines.push(`The rules of ${f.field} are not in force: ${countWord(f.count)} break them.`);
    }
    return lines.join(' ');
  });

/**
 * The same as one text with what to do, for a toast. `here` when it shows
 * on Validation itself.
 */
export const notInForceText = (fields, { here = false } = {}) => {
  const steps = [];
  if (fields.some((f) => f.values?.length || !f.repair?.length)) steps.push('change these values');
  if (fields.some((f) => f.repair?.length)) steps.push('leave one annotation on each');
  const what = steps.join(' and ');
  const action = `${what[0].toUpperCase()}${what.slice(1)}, then choose Put in force${here ? '' : ' under Validation'}.`;
  return `${notInForceLines(fields).join(' ')} ${action}`;
};
