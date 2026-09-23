// The writes a field TYPE change makes to the values already in that field.
//
// Leaving Entry drops the ids outright: a text field would show them raw and
// let anyone type over them. Arriving at Entry keeps the references that still
// resolve, in the new field's own shape (one id or a list of them, see
// `withRefIds`), and drops what was never a reference at all.
//
// Pure, and its own module, because the dialog that calls it has already told
// the person how many values go, and what it writes is not recoverable: a
// vocabulary entry has no history to restore from.

import { refIds, withRefIds } from './vocabDictionary.js';
import { FIELD_TYPES } from './vocabFields.js';

/**
 * Bulk-update entries for every item whose value in `after.name` changes.
 *
 * Each write is ONE metadata op on the field's key: a set of the new value,
 * or a delete where the field can no longer hold what was there. Nothing else
 * on the entry is sent, so a concurrent edit to another field cannot be undone
 * by this one.
 *
 * `items` is the whole vocabulary, which is also what says which ids are live:
 * a reference to a deleted entry is not one that resolves.
 */
export function fieldPruneWrites(items, after) {
  const list = items || [];
  const field = after?.name;
  if (!field) return [];
  const live = new Set(list.map((it) => it.id));
  const writes = [];
  for (const it of list) {
    const raw = it.metadata?.[field];
    if (raw == null || raw === '') continue;
    let now = null;
    if (after.type === FIELD_TYPES.ITEM) {
      const ids = refIds(it, after).filter((x) => x !== it.id && live.has(x));
      now = withRefIds(it.metadata, after, ids)[field] ?? null;
    }
    if (JSON.stringify(now) !== JSON.stringify(raw)) {
      const op =
        now === null ? { op: 'delete', path: [field] } : { op: 'set', path: [field], value: now };
      writes.push({ id: it.id, metadata: [op] });
    }
  }
  return writes;
}
