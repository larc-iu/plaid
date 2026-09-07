// What a dictionary draws for one entry, out of the vocabulary's field schema.
//
// The schema is plaid-igt's (`config.igt.fields`), read and grouped by its own
// helpers so the two apps agree on a field's label and its language. This
// module only decides what a READER sees:
//
//   pos          shown beside the number, the way a dictionary sets it
//   glosses      the meaning line, one per language
//   definitions  under it, one per language
//   others       everything else the compiler put on the entry, labelled
//
// Left out: `status` (editorial, and the reason the entry is here at all),
// `morphType` (it decorates the form instead, "-ka" for a suffix), and the
// reference fields, which are links rather than text.

import { fieldBaseName, fieldLabel, FIELD_TYPES } from '@igt/domain/vocabFields.js';
import { groupFieldsForForm } from '@igt/domain/vocabFields.js';
import { STATUS_FIELD } from '@igt/domain/vocabDictionary.js';
import { decorateWithAffixMarkers } from '@igt/domain/affixMarkers.js';

export const POS_FIELD = 'pos';
const SILENT = new Set([STATUS_FIELD, 'morphType', POS_FIELD]);

const value = (item, field) => {
  const v = item?.metadata?.[field.name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

/**
 * The language tag set beside a value. A FLEx import names the non-primary
 * language in the field's own name ("gloss (en)") and leaves `lang` unset, so
 * read the name's suffix when the config has nothing, or one line of a
 * multilingual gloss is tagged and its neighbour is not.
 */
const langTag = (field) => {
  if (field.lang) return field.lang;
  const suffix = String(field.name ?? '').match(/\(([^()]+)\)$/);
  return suffix ? suffix[1] : null;
};

const entryOf = (item, field) => {
  const v = value(item, field);
  return v === null
    ? null
    : { name: field.name, label: fieldLabel(field), lang: langTag(field), value: v };
};

const filled = (item, fields) => fields.map((f) => entryOf(item, f)).filter(Boolean);

/**
 * The form as a dictionary sets it: a bound morph carries its affix markers,
 * the way FLEx writes one standing alone.
 */
export const displayForm = (item) =>
  decorateWithAffixMarkers(item?.metadata?.morphType, item?.form ?? '');

/**
 * One entry's text, ready to draw.
 *
 * @param {object} item   the vocab item
 * @param {object[]} fields  normalized fields (normalizeVocabFields)
 * @returns {{pos: string|null, glosses: object[], definitions: object[], others: object[]}}
 */
export const entryText = (item, fields) => {
  const groups = groupFieldsForForm(fields || [], { statusField: STATUS_FIELD });
  const text = [...groups.builtIn, ...groups.custom].filter(
    (f) => f.type !== FIELD_TYPES.ITEM && !SILENT.has(f.name),
  );
  const posField = (fields || []).find((f) => f.name === POS_FIELD);
  return {
    pos: posField ? value(item, posField) : null,
    glosses: filled(
      item,
      text.filter((f) => fieldBaseName(f.name) === 'gloss'),
    ),
    definitions: filled(
      item,
      text.filter((f) => fieldBaseName(f.name) === 'definition'),
    ),
    others: filled(
      item,
      text.filter((f) => !['gloss', 'definition'].includes(fieldBaseName(f.name))),
    ),
  };
};

/** Every word a search should look at on one entry: its form and its text. */
export const searchableText = (item, fields) => {
  const { pos, glosses, definitions, others } = entryText(item, fields);
  return [
    item?.form ?? '',
    pos ?? '',
    ...[...glosses, ...definitions, ...others].map((e) => e.value),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
};

/**
 * The meaning a result list sets beside a form: the gloss the query matched,
 * looked for on the headword and then on its senses, so a reader searching in
 * English is answered in English. With no match, or no query, the first gloss
 * the entry carries.
 */
export const firstGloss = (node, fields, query = '') => {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  const glossesOf = (n) => entryText(n.item, fields).glosses;
  const walk = (n, pick) => {
    const found = pick(glossesOf(n));
    if (found) return found.value;
    for (const sense of n.senses || []) {
      const deeper = walk(sense, pick);
      if (deeper) return deeper;
    }
    return null;
  };
  const matched = q ? walk(node, (gs) => gs.find((g) => g.value.toLowerCase().includes(q))) : null;
  return matched ?? walk(node, (gs) => gs[0]);
};
