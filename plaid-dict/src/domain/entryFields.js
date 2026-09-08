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

import {
  fieldBaseName,
  fieldLabel,
  groupFieldsForForm,
  FIELD_TYPES,
} from '@igt/domain/vocabFields.js';
import {
  allExamples,
  fieldsForItem,
  itemRefFields,
  refIds,
  statusFieldKey,
} from '@igt/domain/vocabDictionary.js';
import { decorateWithAffixMarkers } from '@igt/domain/affixMarkers.js';

export const POS_FIELD = 'pos';
// Fields the article never prints as text: the status decides what is shown,
// the morph type decorates the form, the part of speech has its own place.
const silentFields = (fields) => new Set([statusFieldKey(fields), 'morphType', POS_FIELD]);

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
  // A headword-scope field belongs to the headword, so a sense never repeats
  // its entry's etymology.
  const groups = groupFieldsForForm(fieldsForItem(fields, item), {
    statusField: statusFieldKey(fields),
  });
  const silent = silentFields(fields);
  const text = [...groups.builtIn, ...groups.custom].filter(
    (f) => f.type !== FIELD_TYPES.ITEM && !silent.has(f.name),
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
  // A node on the spine only (an unpublished headword over a published sense)
  // lends its structure, never its gloss.
  const glossesOf = (n) => (n.shown === false ? [] : entryText(n.item, fields).glosses);
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

/**
 * The entries this one points at, field by field. `resolve` turns a target id
 * into whatever the page needs to draw a link, and returns null for a target
 * the dictionary does not show: a reference to an unpublished entry is not a
 * link to nowhere, it is not a reference at all.
 *
 * @returns {{name: string, label: string, targets: object[]}[]}
 */
export const entryRefs = (item, fields, resolve) => {
  const out = [];
  for (const field of itemRefFields(fieldsForItem(fields, item))) {
    const targets = refIds(item, field).map(resolve).filter(Boolean);
    if (targets.length) out.push({ name: field.name, label: fieldLabel(field), targets });
  }
  return out;
};

/**
 * An entry's examples, ready to draw. An imported FLEx example is its own text
 * and its own translation, which no layer choice applies to. A promoted one is
 * a reference into a document, looked up in `sentences` (see resolveExamples)
 * and carrying every sentence layer that had a value.
 *
 * `layers` is the dictionary's chosen sentence layers, in the order it wants
 * them; null means it has not chosen and every layer is shown. A layer with
 * nothing in it for this sentence was already dropped by the resolver, so it
 * takes up no room here. A promoted example whose sentence could not be read is
 * left out: a dictionary shows an example or nothing, never a placeholder.
 */
export const entryExamples = (item, sentences = null, layers = null) =>
  allExamples(item)
    .map((example) => {
      if (!example.document) {
        // An imported example has one translation and no layer to name it.
        const translation = example.translation ? [{ name: null, value: example.translation }] : [];
        return example.text ? { text: example.text, lines: translation } : null;
      }
      const found = sentences?.get(`${example.document}/${example.token}`);
      if (!found) return null;
      return {
        text: found.text,
        lines: pickLines(found.lines, layers),
        document: example.document,
      };
    })
    .filter((example) => example && example.text);

// The lines a dictionary shows, in the order it asked for them. A line with no
// layer name is an imported translation and is never filtered out: there was
// nothing to choose.
const pickLines = (lines, layers) => {
  if (!layers) return lines || [];
  const byName = new Map(
    (lines || []).filter((line) => line.name).map((line) => [line.name, line]),
  );
  const out = (lines || []).filter((line) => !line.name);
  for (const name of layers) if (byName.has(name)) out.push(byName.get(name));
  return out;
};

/** Every `{document, token}` a headword and its senses point at. */
export const collectExampleRefs = (node, out = []) => {
  for (const example of allExamples(node.item)) {
    if (example.document && example.token) out.push(example);
  }
  for (const sense of node.senses || []) collectExampleRefs(sense, out);
  return out;
};
