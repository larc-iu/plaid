// The role a new lexicon field is given when it is made: a name may propose a
// stored value once, at creation, and nothing reads the name afterwards. The
// role itself is `role` in the field's config (see vocabFields.js). The Python
// backfill that gave existing fields their roles (B/scripts/backfill_entry_roles.py)
// applies the same rule.

import { ENTRY_ROLES, fieldBaseName } from './vocabFields.js';

/** The roles in the order the field settings offer them, with their labels. */
export const ENTRY_ROLE_CHOICES = [
  { role: ENTRY_ROLES.GLOSS, label: 'Gloss' },
  { role: ENTRY_ROLES.DEFINITION, label: 'Definition' },
  { role: ENTRY_ROLES.POS, label: 'Part of speech' },
  { role: ENTRY_ROLES.STATUS, label: 'Status' },
];

const BY_NAME = {
  gloss: ENTRY_ROLES.GLOSS,
  definition: ENTRY_ROLES.DEFINITION,
  pos: ENTRY_ROLES.POS,
  partofspeech: ENTRY_ROLES.POS,
  status: ENTRY_ROLES.STATUS,
};

/**
 * The role a field made under `name` is given: its name without a language
 * suffix, case, spaces, hyphens and underscores, matched against the four
 * roles ("Gloss (en)" a gloss, "Part of speech" a part of speech), else null.
 */
export const proposeEntryRole = (name) =>
  BY_NAME[
    fieldBaseName(name)
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ] ?? null;
