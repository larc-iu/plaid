// The project's default fields for igt's own services, proposed once, when
// setup makes the fields: `config.igt.serviceDefaults[task].fieldParams` (see
// plaid-ui's domain/serviceDefaults.js), each field named by its span layer's
// id. The run dialog and Services settings read the stored id, never a
// field's name. A field is proposed by its stored role, never its name: the
// one morpheme field whose Lexicon field holds the gloss role, and the one
// sentence field whose role is the translation (domain/sentenceRole.js). A
// scope with none, or with several, proposes nothing for that parameter.

import { TASKS } from '@larc-iu/plaid-client';
import { SENTENCE_ROLES } from './igtConfig.js';
import { ENTRY_ROLES } from './vocabFields.js';

// The field parameters igt's bundled services take, by task: the parameter's
// key, its scope, and the role that proposes a field for it.
const SERVICE_FIELD_PARAMS = {
  [TASKS.ANALYZE]: [
    { key: 'gloss_field', scope: 'Morpheme', role: ENTRY_ROLES.GLOSS },
    { key: 'translation_field', scope: 'Sentence', role: SENTENCE_ROLES.TRANSLATION },
  ],
  [TASKS.TRANSLATE]: [
    { key: 'translation_field', scope: 'Sentence', role: SENTENCE_ROLES.TRANSLATION },
    { key: 'gloss_field', scope: 'Morpheme', role: ENTRY_ROLES.GLOSS },
  ],
};

// A field's role: a sentence field's own, else the entry role its Lexicon
// field holds.
const roleOf = (f, entryRoles) =>
  f.scope === 'Sentence' ? (f.sentenceRole ?? null) : (entryRoles?.[f.lexiconField] ?? null);

/**
 * The serviceDefaults entries a project's fields propose, `{task:
 * {fieldParams: {param key: span layer id}}}`, for the tasks whose fields
 * resolve. `fields` is a list of `{name, scope, id, lexiconField?,
 * sentenceRole?}`, and `entryRoles` the entry role each entry field key holds
 * (entryRolesByKey in lexiconField.js).
 */
export function proposeServiceFieldDefaults(fields, entryRoles = {}) {
  const out = {};
  for (const [task, params] of Object.entries(SERVICE_FIELD_PARAMS)) {
    const fieldParams = {};
    for (const p of params) {
      const held = (fields || []).filter(
        (f) => f?.id && f.scope === p.scope && roleOf(f, entryRoles) === p.role,
      );
      if (held.length === 1) fieldParams[p.key] = held[0].id;
    }
    if (Object.keys(fieldParams).length) out[task] = { fieldParams };
  }
  return out;
}
