// A `field` parameter names one of the project's annotation fields at its
// scope (see plaid-client's serviceSchema). What a form holds for one may name
// no field this project has: a value remembered from another project or from
// before a rename. A field is never chosen by its name, so such a value, and a
// parameter with no value at all, is replaced before anyone runs anything by
// the one field at its scope whose stored Lexicon field holds the parameter's
// `role`. Failing that it is left blank for a person to choose, and a required
// one says so.
//
//   fields:     {scope: [field name]}, from the app, which knows its project.
//               A scope the app does not list is left alone.
//   fieldRoles: {scope: {field name: role}}, the role each field's stored
//               Lexicon field holds, where it holds one.

const paired = (names, roles, role) => {
  if (!role) return '';
  const hits = names.filter((n) => roles?.[n] === role);
  return hits.length === 1 ? hits[0] : '';
};

export function resolveFieldParams(schema, values, fields, fieldRoles = null) {
  if (!fields) return values;
  const out = { ...values };
  for (const param of schema || []) {
    if (param?.type !== 'field' || !param.key) continue;
    const names = fields[param.scope];
    if (!Array.isArray(names) || names.includes(out[param.key])) continue;
    out[param.key] = paired(names, fieldRoles?.[param.scope], param.role);
  }
  return out;
}
