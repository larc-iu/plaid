// A sentence field's role: which sentence field is the free translation, the
// literal translation or a note, stored on the field's span layer as
// `config.igt.sentenceRole` (readSentenceRole in igtConfig.js) next to its
// scope and language. Setup and the importers write it, the field settings
// show and edit it, and the exporters, the service defaults and the
// importers read it. Nothing reads a sentence field's NAME for it.
//
// A field's name may PROPOSE the role, once, when the field is made (the
// setup wizard, an import, Fields settings). A role a maintainer cleared is
// never filled back in. The Python backfill that gave existing fields their
// roles (beta-review-2026-10-24/scripts/backfill_sentence_roles.py) applies
// the same rule.

import { SENTENCE_ROLES } from './igtConfig.js';
import { fieldBaseName } from './vocabFields.js';

/** The roles in the order the field settings offer them, with their labels. */
export const SENTENCE_ROLE_CHOICES = [
  { role: SENTENCE_ROLES.TRANSLATION, label: 'Translation' },
  { role: SENTENCE_ROLES.LITERAL_TRANSLATION, label: 'Literal translation' },
  { role: SENTENCE_ROLES.NOTE, label: 'Note' },
];

const BY_NAME = {
  translation: SENTENCE_ROLES.TRANSLATION,
  freetranslation: SENTENCE_ROLES.TRANSLATION,
  literaltranslation: SENTENCE_ROLES.LITERAL_TRANSLATION,
  note: SENTENCE_ROLES.NOTE,
  notes: SENTENCE_ROLES.NOTE,
  comment: SENTENCE_ROLES.NOTE,
};

/**
 * The role a sentence field made under `name` is given: its name without a
 * language suffix, case, spaces, hyphens and underscores, matched against the
 * roles ("Translation (en)" and "Free translation" a translation, "Literal
 * Translation" a literal translation, "Note" and "Comment" a note), else null.
 */
export const proposeSentenceRole = (name) =>
  BY_NAME[
    fieldBaseName(name)
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ] ?? null;

/**
 * Each field with its role: a sentence field keeps the one it states
 * (`sentenceRole`, null meaning none), else gets the one its name proposes. A
 * word or morpheme field has none. What every maker of fields runs once,
 * before the fields exist.
 */
export const withSentenceRoles = (fields) =>
  (fields || []).map((f) => {
    if (f?.scope !== 'Sentence') return f;
    return f.sentenceRole !== undefined ? f : { ...f, sentenceRole: proposeSentenceRole(f.name) };
  });
