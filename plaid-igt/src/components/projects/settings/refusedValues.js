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
