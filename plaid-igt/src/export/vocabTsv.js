// Vocabulary → TSV. Cells can't contain tabs or newlines, so those collapse
// to a single space (no quoting layer — that's the point of TSV).

export const tsvCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

/**
 * items: [{ id, form, metadata }]; fieldNames: metadata keys to emit as
 * columns; fieldLabels: optional display names for the header (parallel to
 * fieldNames); usageCounts: { [itemId]: n } or null to omit the Uses column.
 *
 * A dictionary vocabulary passes `numbers` (item id -> its dotted number,
 * see buildItemNumbers) and gets a Number column after the form, and
 * `refFields` (the names of its Entry fields) so those cells hold the
 * referenced entry's name ("a 1.2") rather than an id.
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
  const header = ['Form', ...(numbers ? ['Number'] : []), ...(fieldLabels ?? fieldNames)];
  if (usageCounts) header.push('Uses');
  const lines = [header.map(tsvCell).join('\t')];
  for (const it of items || []) {
    const row = [
      it.form,
      ...(numbers ? [numbers.get(it.id) ?? ''] : []),
      ...fieldNames.map((f) => cell(it, f)),
    ];
    if (usageCounts) row.push(usageCounts[it.id] ?? 0);
    lines.push(row.map(tsvCell).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
