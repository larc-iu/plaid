// Vocabulary → TSV. Cells can't contain tabs or newlines, so those collapse
// to a single space (no quoting layer — that's the point of TSV).

export const tsvCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

/**
 * items: [{ id, form, metadata }]; fieldNames: metadata keys to emit as
 * columns; fieldLabels: optional display names for the header (parallel to
 * fieldNames); usageCounts: { [itemId]: n } or null to omit the Uses column.
 */
export function serializeVocabTsv({ items, fieldNames = [], fieldLabels = null, usageCounts = null }) {
  const header = ['Form', ...(fieldLabels ?? fieldNames)];
  if (usageCounts) header.push('Uses');
  const lines = [header.map(tsvCell).join('\t')];
  for (const it of items || []) {
    const row = [it.form, ...fieldNames.map((f) => it.metadata?.[f] ?? '')];
    if (usageCounts) row.push(usageCounts[it.id] ?? 0);
    lines.push(row.map(tsvCell).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
