// Narrowing a vocabulary's entries by what is typed into the search box.
//
// The box searches every column by default. Scoped to one field it searches
// that field alone, and can instead show the entries that have no value in it
// at all, which is how a lexicon's gaps are found (every entry without a gloss,
// say) once it is too long to scroll.

import { morphTypeLabel } from './affixMarkers.js';

/** The `field` meaning "every column". Not the empty string: a Select item
 * may not carry one, and this is what the field picker shows as "All fields". */
export const ANY_FIELD = '*';

/** The text a field shows for an entry: the form, or a metadata value. */
export const fieldText = (item, field) => {
  if (field === 'form') return item.form ?? '';
  const v = item.metadata?.[field];
  // Morph types are stored as codes and shown as labels, so a search says
  // "prefix" the way the table does.
  return String((field === 'morphType' ? morphTypeLabel(v) : v) ?? '');
};

/** Whether an entry has nothing in `field`. Never true of the form. */
export const fieldEmpty = (item, field) =>
  field !== 'form' && String(item.metadata?.[field] ?? '').trim() === '';

/**
 * The entries that match. `query` is matched case-insensitively as a
 * substring of the scoped field, or of the form and any field when the scope
 * is ANY_FIELD. `emptyOnly` (with a scoped field) keeps only the entries with
 * no value there; the field being empty, the query then reads the form, so
 * the gaps can still be narrowed to a stretch of the alphabet.
 */
export function filterVocabItems(
  items,
  { query = '', field = ANY_FIELD, emptyOnly = false, fieldNames = [] },
) {
  const scoped = field && field !== ANY_FIELD ? field : null;
  const gaps = scoped && emptyOnly;
  const list = gaps ? items.filter((it) => fieldEmpty(it, scoped)) : items;
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const columns = gaps ? ['form'] : scoped ? [scoped] : ['form', ...fieldNames];
  return list.filter((it) => columns.some((f) => fieldText(it, f).toLowerCase().includes(q)));
}
