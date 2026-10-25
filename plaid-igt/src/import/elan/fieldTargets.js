// Where an ELAN tier's values land when the import writes into a project that
// already exists. Pure. The project's own inventory is domain/fieldInventory.js,
// and creating what is missing is createFields in import/project.js.
//
// A fresh-project import derives the whole field inventory from the corpus and
// lets setup create it. A project someone has been working in already HAS
// fields, and the same tier almost always belongs in one of them: a corpus
// exported for FieldWorks names its tiers `A_Translation-gls-nl`, while the
// project that came from the same FieldWorks project calls the field
// `Translation (nl)`. Mapping onto what is there is the common case, and
// creating a field is the exception that has to be asked for, or a project
// grows a second Translation every time someone imports.

import { parseFieldName } from '../../domain/fieldNames.js';
import { existingFields } from '../../domain/fieldInventory.js';

// Names read alike when their base names do, ignoring case, spacing and
// punctuation: "Translation (nl)", "translation" and "Translation-nl" all fold
// together. The writing-system tag comes off first, because "Gloss (en)" beside
// "Gloss" is the naming convention working, not a duplicate.
const fold = (name) =>
  parseFieldName(name)
    .base.toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * An existing field in the same scope whose name reads like `name`, or null.
 * An exact match returns null: that is the field itself, not a near-duplicate.
 */
export function similarField(existing, scope, name) {
  const fields = existing?.[scope] || [];
  if (fields.some((f) => f.name === name)) return null;
  const target = fold(name);
  if (!target) return null;
  return fields.find((f) => fold(f.name) === target)?.name ?? null;
}

/**
 * The fields an import would have to create in this project, in build order.
 * `similarTo` names an existing field that reads like it, which is the one
 * signal that a new field is a mistake about to happen.
 *
 * @returns {Array<{name, scope, similarTo: string|null}>}
 */
export function missingFields(project, fields) {
  const existing = existingFields(project);
  const seen = new Set();
  const out = [];
  for (const { name, scope, lang } of fields || []) {
    const key = `${scope}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((existing[scope] || []).some((f) => f.name === name)) continue;
    out.push({ name, scope, lang: lang ?? null, similarTo: similarField(existing, scope, name) });
  }
  return out;
}
