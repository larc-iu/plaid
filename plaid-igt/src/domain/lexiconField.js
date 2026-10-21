// A field's Lexicon field: the lexicon entry field that holds the same kind of
// value as an annotation field, stored on the field's span layer as
// `config.igt.lexiconField` (readLexiconField in igtConfig.js). A morpheme
// whose "Gloss" field pairs with the entry field `gloss` takes guesses from
// the linked sense's `gloss`, lists each sense with its `gloss` in the pair
// picker, and has that field filled when a sense is picked from the chip.
// Nothing reads a field's NAME to pair it: a field with no Lexicon field
// pairs with nothing.
//
// The record names an entry field by its key. Entry field schemas are per
// vocabulary, so an entry of a vocabulary that has no such key has no value
// for the field, and nothing else follows from it.
//
// A field's name may PROPOSE the record, once, when the field is made (the
// setup wizard, an import, Fields settings), as its language is proposed. A
// Lexicon field a maintainer cleared is never filled back in.

import { normalizeVocabFields, CORE_VOCAB_FIELDS, FIELD_TYPES } from './vocabFields.js';
import { readVocabFields } from './igtConfig.js';
import { fieldNameLang, parseFieldName } from './fieldNames.js';

/**
 * The entry fields a Lexicon field can name: every text field of the given
 * vocabularies (each `{ config }`), with the language its schema records, in
 * first-seen order. With no vocabulary, the fields every new vocabulary starts
 * with, so a project set up before its lexicon pairs its fields all the same.
 *
 * @returns {{ key: string, lang: string|null }[]}
 */
export function lexiconFieldChoices(vocabs) {
  const out = [];
  const seen = new Set();
  for (const v of vocabs || []) {
    for (const f of normalizeVocabFields(readVocabFields(v?.config))) {
      if (f.type !== FIELD_TYPES.TEXT) continue;
      const id = `${f.name}\u0000${f.lang ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ key: f.name, lang: f.lang });
    }
  }
  if (out.length) return out;
  return CORE_VOCAB_FIELDS.map((f) => ({ key: f.name, lang: null }));
}

// An annotation field and an entry field name the same thing when they match
// after case and separators are dropped: "Gloss" and `gloss`, "POS" and
// `pos`, "Morph Type" and `morphType`.
const squash = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * The Lexicon field a new field's name proposes, or null. The same name
 * first. Failing that, the same base name in the same language: a FieldWorks
 * import in several analysis languages names the annotation field
 * "Gloss (pmy)" and keeps the entry's built-in `gloss`, whose language the
 * vocabulary's schema records. A sentence field pairs with nothing, since no
 * sentence is linked to an entry.
 *
 * @param {{ name: string, scope: string, lang?: string|null }} field
 * @param {{ key: string, lang: string|null }[]} choices (lexiconFieldChoices)
 */
export function proposeLexiconField(field, choices) {
  if (field?.scope !== 'Word' && field?.scope !== 'Morpheme') return null;
  const want = squash(field.name);
  if (!want) return null;
  const same = (choices || []).find((c) => squash(c.key) === want);
  if (same) return same.key;
  const lang = field.lang || fieldNameLang(field.name);
  if (!lang) return null;
  const base = squash(parseFieldName(field.name).base);
  const hit = (choices || []).find(
    (c) => squash(parseFieldName(c.key).base) === base && (c.lang || fieldNameLang(c.key)) === lang,
  );
  return hit?.key ?? null;
}
