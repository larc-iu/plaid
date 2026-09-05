// Narrowing a vocabulary's entries by what is typed into the search box, and
// ordering them by a column.
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

/**
 * The entries in column order. `sort` is `{key, dir}` with key `form`, `gloss`
 * or `uses`. Ties, and every tie among homonyms, fall back to the form and
 * then the homonym subscript, so the list always reads form₁, form₂, …
 * regardless of the column. An entry with no gloss sorts after the glossed
 * ones in either direction: the gaps are what the chip is for.
 */
export function sortVocabItems(items, sort, { homonyms, usageCounts } = {}) {
  const dir = sort?.dir === 'desc' ? -1 : 1;
  const byForm = (a, b) => {
    const af = (a.form ?? '').toLowerCase();
    const bf = (b.form ?? '').toLowerCase();
    if (af < bf) return -1;
    if (af > bf) return 1;
    // Homonyms in subscript order. Not by id: ids do not sort into creation
    // order within a bulk write.
    return (homonyms?.get(a.id) ?? 0) - (homonyms?.get(b.id) ?? 0);
  };
  const column = {
    form: (a, b) => byForm(a, b) * dir,
    gloss: (a, b) => {
      const ag = fieldText(a, 'gloss').toLowerCase();
      const bg = fieldText(b, 'gloss').toLowerCase();
      if (!ag !== !bg) return ag ? -1 : 1;
      if (ag < bg) return -1 * dir;
      if (ag > bg) return 1 * dir;
      return 0;
    },
    uses: (a, b) => ((usageCounts?.[a.id] ?? 0) - (usageCounts?.[b.id] ?? 0)) * dir,
  };
  const cmp = column[sort?.key] ?? column.form;
  return [...items].sort((a, b) => cmp(a, b) || byForm(a, b));
}
