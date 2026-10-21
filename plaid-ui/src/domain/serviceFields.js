// A `field` parameter names one of the project's annotation fields at its
// scope (see plaid-client's serviceSchema). What a form holds for one may name
// no field this project has: a value remembered from another project or from
// before a rename. A field is never chosen by its name, so such a value, and a
// parameter with no value at all, is replaced before anyone runs anything by
// the field the parameter's `lexiconField` names: the one field at its scope
// whose stored Lexicon field is that entry field. Failing that it is left
// blank for a person to choose, and a required one says so.
//
//   fields:        {scope: [field name]}, from the app, which knows its
//                  project. A scope the app does not list is left alone.
//   lexiconFields: {scope: {field name: entry field}}, each field's stored
//                  Lexicon field, where it has one.

const paired = (names, lexiconFields, entryField) => {
  if (!entryField) return '';
  const hits = names.filter((n) => lexiconFields?.[n] === entryField);
  return hits.length === 1 ? hits[0] : '';
};

export function resolveFieldParams(schema, values, fields, lexiconFields = null) {
  if (!fields) return values;
  const out = { ...values };
  for (const param of schema || []) {
    if (param?.type !== 'field' || !param.key) continue;
    const names = fields[param.scope];
    if (!Array.isArray(names) || names.includes(out[param.key])) continue;
    out[param.key] = paired(names, lexiconFields?.[param.scope], param.lexiconField);
  }
  return out;
}
