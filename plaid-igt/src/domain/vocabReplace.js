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
 * The writes for the chosen rows, as bulk-update entries: `{id, form}` for a
 * form change, `{id, metadata}` for a field change. A field change is ONE
 * metadata op on the key it touches: a set, or a delete where the replacement
 * empties the value, since the entry form never stores an empty one. Nothing
 * else on the entry is named, so nothing else can be lost.
 */
export function replaceWrites(rows, { field }) {
  const out = [];
  for (const row of rows) {
    if (row.invalid) continue;
    if (field === 'form') out.push({ id: row.id, form: row.new.trim() });
    else {
      const op =
        row.new.trim() === ''
          ? { op: 'delete', path: [field] }
          : { op: 'set', path: [field], value: row.new };
      out.push({ id: row.id, metadata: [op] });
    }
  }
  return out;
}
