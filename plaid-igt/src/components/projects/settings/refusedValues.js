// The words for a settings save not made because values in use are not in a
// closed list, as `refusedBySave` (domain/igtConstraints.js) answers it: each
// field's count and most frequent values, and of a composite value the parts
// not in the list. RefusedValuesNotice shows them in a panel, and a toast
// says them where no panel can.

import { t, tx, msg } from '@ui/lib/i18n.js';

export const REFUSED_TITLE = msg('Not saved');
export const REFUSED_LEAD = msg('These values are in use and not in the list:');

// The parts of a refused value that are not in the list, when the server's
// answer names fewer than the whole value (`1SG` of `1SG.NOM`), else null.
export const unlistedParts = (v) => {
  const parts = Array.isArray(v?.parts) ? v.parts : [];
  if (!parts.length || (parts.length === 1 && parts[0] === v.value)) return null;
  return parts.map((p) => (p === '' ? t('an empty part') : String(p))).join(', ');
};

// A field's count: annotations, or the documents a metadata field's are on.
export const countWord = (n, noun = 'annotation') =>
  noun === 'document'
    ? t('{n, plural, one {{n} document} other {{n} documents}}', { n })
    : t('{n, plural, one {{n} annotation} other {{n} annotations}}', { n });

// The values shown, and how many more there are. `values` is text, or nodes
// with `nodes` set, and so is the answer.
export const withMore = (f, values, { nodes = false } = {}) => {
  if (f.valueCount <= f.values.length) return values;
  const v = { values, n: f.valueCount - f.values.length };
  return nodes ? tx('{values}, and {n} more', v) : t('{values}, and {n} more', v);
};

const valueText = (v) => {
  const parts = unlistedParts(v);
  return parts
    ? t('{value} ({n}, {parts} not listed)', { value: String(v.value), n: v.count, parts })
    : `${String(v.value)} (${v.count})`;
};

const valuesText = (f) => withMore(f, f.values.map(valueText).join(', '));

/**
 * The refusal as one line of text, for a toast where no panel can show it:
 * "These values are in use and not in the list: Gloss: 2 annotations, QQ (2)."
 */
export const refusedValuesText = (fields) =>
  `${t(REFUSED_LEAD)} ${fields
    .map((f) =>
      t('{field}: {total}, {values}.', {
        field: f.field,
        total: countWord(f.count, f.noun),
        values: valuesText(f),
      }),
    )
    .join(' ')}`;

export const NOT_IN_FORCE_TITLE = msg('Not in force');

/**
 * A closed list left out of force because values in use are not in it, as
 * `declareIgtRules` (domain/igtConstraints.js) answers it, one line a field:
 * "“Leipzig” is not in force on Morph Gloss: 1 annotation not in the list,
 * QQ (1)." A field whose annotations would need joining to take its rules
 * (`repair`): "Raw note: 1 word with more than one annotation." A rule
 * refused for another reason has no values to name.
 */
const notInForceLines = (fields) =>
  fields.map((f) => {
    const lines = [];
    if (f.values?.length) {
      const values = { field: f.field, n: f.count, values: valuesText(f) };
      lines.push(
        f.tagset
          ? t(
              '“{tagset}” is not in force on {field}: {n, plural, one {{n} annotation} other {{n} annotations}} not in the list, {values}.',
              { ...values, tagset: f.tagset },
            )
          : t(
              'The closed list is not in force on {field}: {n, plural, one {{n} annotation} other {{n} annotations}} not in the list, {values}.',
              values,
            ),
      );
    }
    if (f.repair?.length) {
      const n = f.repairCount ?? 0;
      lines.push(
        n > 0
          ? t(
              '{field}: {scope, select, Morpheme {{n, plural, one {{n} morpheme} other {{n} morphemes}}} Sentence {{n, plural, one {{n} sentence} other {{n} sentences}}} other {{n, plural, one {{n} word} other {{n} words}}}} with more than one annotation.',
              { field: f.field, scope: String(f.scope), n },
            )
          : f.scope === 'Morpheme'
            ? t('{field}: morphemes of ignored words hold more than one annotation.', {
                field: f.field,
              })
            : t('{field}: ignored words hold more than one annotation.', { field: f.field }),
      );
    }
    if (!lines.length) {
      lines.push(
        t(
          'The rules of {field} are not in force: {n, plural, one {{n} annotation breaks} other {{n} annotations break}} them.',
          { field: f.field, n: f.count },
        ),
      );
    }
    return lines.join(' ');
  });

/**
 * The same as one text with what to do, for a toast. `here` when it shows
 * on Validation itself.
 */
export const notInForceText = (fields, { here = false } = {}) => {
  const steps = [];
  if (fields.some((f) => f.values?.length)) steps.push('values');
  if (fields.some((f) => f.repair?.length && f.repairCount > 0)) steps.push('repair');
  if (fields.some((f) => !f.values?.length && !f.repair?.length)) steps.push('breaks');
  const lines = notInForceLines(fields).join(' ');
  // Doubles only on ignored words: nothing Analyze can do.
  if (!steps.length) return lines;
  // All three steps are the select's `other`.
  const values = { steps: steps.length === 3 ? 'all' : steps.join('_') };
  const action = here
    ? t(
        '{steps, select, values {Change these values} repair {Leave one annotation on each} breaks {Change the annotations that break them} values_repair {Change these values and leave one annotation on each} values_breaks {Change these values and change the annotations that break them} repair_breaks {Leave one annotation on each and change the annotations that break them} other {Change these values and leave one annotation on each and change the annotations that break them}}, then choose Put in force.',
        values,
      )
    : t(
        '{steps, select, values {Change these values} repair {Leave one annotation on each} breaks {Change the annotations that break them} values_repair {Change these values and leave one annotation on each} values_breaks {Change these values and change the annotations that break them} repair_breaks {Leave one annotation on each and change the annotations that break them} other {Change these values and leave one annotation on each and change the annotations that break them}}, then choose Put in force under Validation.',
        values,
      );
  return `${lines} ${action}`;
};
