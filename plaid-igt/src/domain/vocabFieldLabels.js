// A vocabulary field's label and description as the screen shows them, in
// the reader's language.
//
// vocabFields.js says them in English (`fieldLabel`, `humanizeFieldName`,
// `fieldDescription`), which is what a file is written with: the LaTeX book
// and the vocabulary TSV put a field's label in the file, and two people in
// two languages share it. That module imports no translation, since
// plaid-agent's mirror of it runs in plain node, so the screen's words are
// here. Only the labels the app gives its own fields translate. A field a
// person or an import named keeps its name, whatever the language.

import { t, msg } from '@ui/lib/i18n.js';
import { fieldLabel, humanizeFieldName } from './vocabFields.js';
import { morphTypeLabel } from './affixMarkers.js';

// The labels vocabFields.js gives its known fields (FIELD_LABELS), by key.
const SHOWN = {
  morphType: msg('Morph Type'),
  status: msg('Status'),
  pos: msg('POS'),
  gloss: msg('Gloss'),
  definition: msg('Definition'),
  lexemeForm: msg('Lexeme Form'),
};

// What vocabFields.js says a field is for (FIELD_DESCRIPTIONS), by key.
const DESCRIPTIONS = {
  morphType: msg(
    'The kind of morph this entry is (stem, prefix, enclitic, …). Decides how it joins its neighbours in the interlinear line, so only FLEx morph-type names are accepted.',
  ),
  gloss: msg('The short meaning shown under the form in the interlinear line.'),
  pos: msg('Part of speech.'),
  definition: msg(
    'A fuller definition, shown in the entry detail rather than the interlinear line.',
  ),
  lexemeForm: msg('The underlying form of the lexeme, when it differs from the form as written.'),
  status: msg('How far along the entry is: draft, reviewed, or published.'),
};
const CUSTOM_DESCRIPTION = msg('A custom field on this vocabulary. Free text.');

// `english`, the label vocabFields.js made for the field named `name`, with
// the known base it starts with translated. "gloss (ru)" reads "Gloss (ru)"
// in English and "Glose (ru)" in French: the language stays as written.
const translated = (name, english) => {
  const raw = String(name ?? '');
  const base = /^(.*?\S)(\s*\([^()]*\))\s*$/.exec(raw)?.[1] ?? raw;
  const known = Object.hasOwn(SHOWN, base) ? SHOWN[base] : null;
  return known && english.startsWith(known) ? t(known) + english.slice(known.length) : english;
};

/** `fieldLabel` for the screen. */
export const fieldDisplayLabel = (field) =>
  translated(typeof field === 'string' ? field : field?.name, fieldLabel(field));

/** `humanizeFieldName` for the screen. */
export const fieldDisplayName = (name) => translated(name, humanizeFieldName(name));

/** `fieldDescription` for the screen. */
export const fieldDisplayDescription = (name) =>
  t(Object.hasOwn(DESCRIPTIONS, name) ? DESCRIPTIONS[name] : CUSTOM_DESCRIPTION);

/**
 * `morphTypeLabel` for the screen. Only the app's own name for FieldWorks'
 * phrase types translates: the others are FieldWorks' own names, which stay.
 */
export const morphTypeDisplayLabel = (type) => {
  const label = morphTypeLabel(type);
  return label === type ? label : t('multi-word expression');
};
