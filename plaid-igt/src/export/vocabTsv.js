import { itemLabel } from '../domain/vocabDictionary.js';

// Vocabulary → TSV. Cells can't contain tabs or newlines, so those collapse
// to a single space (no quoting layer — that's the point of TSV).
//
// The one exception is a cell that BEGINS with a double quote: every reader of
// delimited text, ours (vocabBulk.js parseDelimited) and Excel alike, takes
// that as RFC 4180 quoting and eats the quotes. Such a cell is written quoted,
// with its own quotes doubled, so it comes back as it was.

export const tsvCell = (v) => {
  const flat = String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return flat.startsWith('"') ? `"${flat.replace(/"/g, '""')}"` : flat;
};

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
  const nameOf = (id) => itemLabel(byId.get(id), numbers);
  const cell = (it, f) => {
    const v = it.metadata?.[f];
    if (!refs.has(f)) return v ?? '';
    return (Array.isArray(v) ? v : v ? [v] : []).map(nameOf).filter(Boolean).join('; ');
  };
  // The Number column earns its place only when something carries a number: a
  // vocabulary with no senses and no two entries spelled alike numbers nothing.
  const numbered = !!numbers && (items || []).some((it) => numbers.get(it.id));
  // A vocabulary may have a field of its own called Number, and two columns of
  // one name make a reader pick one: the entry's number stands aside, since
  // the field's values are the data and the number is bookkeeping.
  const names = (fieldLabels ?? fieldNames).map((n) => String(n ?? '').toLowerCase());
  const numberHeader = names.includes('number') ? 'Entry number' : 'Number';
  const header = ['Form', ...(numbered ? [numberHeader] : []), ...(fieldLabels ?? fieldNames)];
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
