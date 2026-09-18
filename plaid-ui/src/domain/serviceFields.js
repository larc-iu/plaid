// A `field` parameter names one of the project's annotation fields at its
// scope (see plaid-client's serviceSchema). What a form holds for one may name
// no field this project has: the schema's default ("Gloss" in a project whose
// glosses are "Gloss (pmy)" and "Gloss (en)"), or a value remembered from
// another project or from before a rename. A service handed a field that is
// not there either stops, or, for a field it only reads as context, carries on
// without it. So such a value is replaced before anyone runs anything, by the
// field it most plausibly meant: the one field whose name it begins ("Gloss"
// for "Gloss (pmy)"), else the scope's only field, else nothing, for a person
// to choose.
//
//   fields: {scope: [field name]}, from the app, which knows its project.
//           A scope the app does not list is left alone.

const pick = (names, wanted) => {
  if (wanted && names.includes(wanted)) return wanted;
  const alike = wanted ? names.filter((n) => n.startsWith(`${wanted} (`)) : [];
  if (alike.length === 1) return alike[0];
  if (names.length === 1) return names[0];
  return '';
};

export function resolveFieldParams(schema, values, fields) {
  if (!fields) return values;
  const out = { ...values };
  for (const param of schema || []) {
    if (param?.type !== 'field' || !param.key) continue;
    const names = fields[param.scope];
    if (!Array.isArray(names) || names.includes(out[param.key])) continue;
    out[param.key] = pick(names, out[param.key] || param.default);
  }
  return out;
}
