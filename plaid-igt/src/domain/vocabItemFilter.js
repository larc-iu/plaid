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
 *
 * `textOf` overrides what a field reads as. An Entry field holds ids, and the
 * screen shows the entries they name, so the list passes a reader that does
 * the same.
 */
export function filterVocabItems(
  items,
  { query = '', field = ANY_FIELD, emptyOnly = false, fieldNames = [], textOf = fieldText },
) {
  const scoped = field && field !== ANY_FIELD ? field : null;
  const gaps = scoped && emptyOnly;
  const list = gaps ? items.filter((it) => fieldEmpty(it, scoped)) : items;
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const columns = gaps ? ['form'] : scoped ? [scoped] : ['form', ...fieldNames];
  return list.filter((it) => columns.some((f) => textOf(it, f).toLowerCase().includes(q)));
}

/**
 * The entries in column order. `sort` is `{key, dir}` with key `form`, `gloss`
 * or `uses`. Ties, and every tie among entries spelled alike, fall back to the
 * form and then its dotted number, so the list always reads "a 1", "a 2", …
 * regardless of the column. An entry with no gloss sorts after the glossed
 * ones in either direction: the gaps are what the chip is for.
 */
export function sortVocabItems(items, sort, { numbers, usageCounts } = {}) {
  const dir = sort?.dir === 'desc' ? -1 : 1;
  const byForm = (a, b) => {
    const af = (a.form ?? '').toLowerCase();
    const bf = (b.form ?? '').toLowerCase();
    if (af < bf) return -1;
    if (af > bf) return 1;
    // In dotted-number order. Not by id: ids do not sort into creation order
    // within a bulk write. Numeric collation so "a 10" follows "a 9".
    const na = numbers?.get(a.id) ?? '';
    const nb = numbers?.get(b.id) ?? '';
    return String(na).localeCompare(String(nb), undefined, { numeric: true });
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
