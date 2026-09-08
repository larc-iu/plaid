// Vocabulary → TSV. Cells can't contain tabs or newlines, so those collapse
// to a single space (no quoting layer — that's the point of TSV).

export const tsvCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

/**
 * items: [{ id, form, metadata }]; fieldNames: metadata keys to emit as
 * columns; fieldLabels: optional display names for the header (parallel to
 * fieldNames); usageCounts: { [itemId]: n } or null to omit the Uses column.
 *
 * `numbers` (item id -> its dotted number, see buildItemNumbers) makes
 * `refFields` (the names of the Entry fields) hold the referenced entry's
 * name ("a 1.2") rather than an id, and adds a Number column after the form
 * when anything is actually numbered.
 */
export function serializeVocabTsv({
  items,
  fieldNames = [],
  fieldLabels = null,
  usageCounts = null,
  numbers = null,
  refFields = [],
}) {
  const refs = new Set(refFields);
  const byId = new Map((items || []).map((it) => [it.id, it]));
  const nameOf = (id) => {
    const it = byId.get(id);
    if (!it) return '';
    const n = numbers?.get(id);
    return n ? `${it.form} ${n}` : (it.form ?? '');
  };
  const cell = (it, f) => {
    const v = it.metadata?.[f];
    if (!refs.has(f)) return v ?? '';
    return (Array.isArray(v) ? v : v ? [v] : []).map(nameOf).filter(Boolean).join('; ');
  };
  // The Number column earns its place only when something carries a number: a
  // vocabulary with no senses and no two entries spelled alike numbers nothing.
  const numbered = !!numbers && (items || []).some((it) => numbers.get(it.id));
  const header = ['Form', ...(numbered ? ['Number'] : []), ...(fieldLabels ?? fieldNames)];
  if (usageCounts) header.push('Uses');
  const lines = [header.map(tsvCell).join('\t')];
  for (const it of items || []) {
    const row = [
      it.form,
      ...(numbered ? [numbers.get(it.id) ?? ''] : []),
      ...fieldNames.map((f) => cell(it, f)),
    ];
    if (usageCounts) row.push(usageCounts[it.id] ?? 0);
    lines.push(row.map(tsvCell).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
