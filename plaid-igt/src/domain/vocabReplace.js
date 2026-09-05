// Find and replace across one field of a vocabulary: the rows a substitution
// would change, and the writes that make the change. Pure, so the dialog can
// preview as the person types (every entry is already in memory).

import { isValueAllowed, tagsetEnforces } from './tagsets.js';

/**
 * One row per entry whose value in `field` the replacer rewrites.
 * `apply(value)` is `buildReplacer`'s: the new value, or null for no change.
 *
 * A row is `invalid` when the new value cannot be written: an empty form
 * (every entry has one), or a value an enforcing tagset refuses. Such rows are
 * shown so the person can see what the replacement would have done, and are
 * never written.
 */
export function planVocabReplace(items, { field, apply, tagset = null }) {
  const enforcing = tagsetEnforces(tagset);
  const rows = [];
  for (const it of items || []) {
    const old = field === 'form' ? (it.form ?? '') : String(it.metadata?.[field] ?? '');
    const next = apply(old);
    if (next == null) continue;
    let invalid = null;
    if (field === 'form' && next.trim() === '') invalid = 'empty';
    else if (enforcing && !isValueAllowed(next, tagset)) invalid = 'tagset';
    rows.push({ id: it.id, form: it.form, old, new: next, invalid });
  }
  return rows;
}

/**
 * The writes for the chosen rows, as `{id, form}` for a form change or
 * `{id, metadata}` for a field change. A field change carries the entry's
 * WHOLE metadata: the API's patch cannot remove a key, and a replacement that
 * empties a value must leave no key behind (the entry form never stores one).
 */
export function replaceWrites(rows, { field, itemsById }) {
  const out = [];
  for (const row of rows) {
    if (row.invalid) continue;
    if (field === 'form') {
      out.push({ id: row.id, form: row.new.trim() });
      continue;
    }
    const item = itemsById.get(row.id);
    const metadata = { ...(item?.metadata || {}) };
    if (row.new.trim() === '') delete metadata[field];
    else metadata[field] = row.new;
    out.push({ id: row.id, metadata });
  }
  return out;
}
