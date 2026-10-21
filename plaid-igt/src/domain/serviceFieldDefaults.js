// The project's default fields for igt's own services, proposed once, when
// setup makes the fields: `config.igt.serviceDefaults[task].fieldParams` (see
// plaid-ui's domain/serviceDefaults.js). The run dialog and Services settings
// read the stored value and never a field's name. The rule is the one the
// run dialog applied to every project before FX-W, and the one the one-off
// backfill (B/scripts/backfill_service_defaults.py) applies to existing
// projects: the field of that exact name at the scope, else the one whose
// name begins with it and a language ("Gloss (pmy)"), else the scope's only
// field.

import { TASKS } from '@larc-iu/plaid-client';

// The field parameters igt's bundled services take, by task: the parameter's
// key, its scope, and the name that proposes a field for it.
const SERVICE_FIELD_PARAMS = {
  [TASKS.ANALYZE]: [
    { key: 'gloss_field', scope: 'Morpheme', name: 'Gloss' },
    { key: 'translation_field', scope: 'Sentence', name: 'Translation' },
  ],
  [TASKS.TRANSLATE]: [
    { key: 'translation_field', scope: 'Sentence', name: 'Translation' },
    { key: 'gloss_field', scope: 'Morpheme', name: 'Gloss' },
  ],
};

const pick = (names, wanted) => {
  if (names.includes(wanted)) return wanted;
  const alike = names.filter((n) => n.startsWith(`${wanted} (`));
  if (alike.length === 1) return alike[0];
  if (names.length === 1) return names[0];
  return null;
};

/**
 * The serviceDefaults entries a project's fields propose, `{task:
 * {fieldParams}}`, for the tasks whose fields resolve. `fields` is a list of
 * `{name, scope}`.
 */
export function proposeServiceFieldDefaults(fields) {
  const byScope = {};
  for (const f of fields || []) {
    if (f?.name && f?.scope) (byScope[f.scope] ??= []).push(f.name);
  }
  const out = {};
  for (const [task, params] of Object.entries(SERVICE_FIELD_PARAMS)) {
    const fieldParams = {};
    for (const p of params) {
      const name = pick(byScope[p.scope] || [], p.name);
      if (name) fieldParams[p.key] = name;
    }
    if (Object.keys(fieldParams).length) out[task] = { fieldParams };
  }
  return out;
}
