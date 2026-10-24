// Find and replace across one field of a vocabulary: the rows a substitution
// would change, and the writes that make the change. Pure, so the dialog can
// preview as the person types (every entry is already in memory).

import { entryForm } from '@larc-iu/plaid-client';
import { entryTagsetFor, isValueAllowed, tagsetEnforces } from './tagsets.js';

/**
 * One row per entry whose value in `field` the replacer rewrites.
 * `apply(value)` is `buildReplacer`'s: the new value, or null for no change.
 *
 * A row is `invalid` when the new value cannot be written: an empty form
 * (every entry has one), or a value an enforcing tagset refuses. Such rows are
 * shown so the person can see what the replacement would have done, and are
 * never written. An entry's value is read as its morph type gives
 * (entryTagsetFor): `morphTypeOf(id)` is the one each entry goes by, its own
 * when not given.
 *
 * `reserved` ({value, keep}) is a value the field may not lose under another
 * spelling: a row that turns it into anything but one of `keep`, or nothing,
 * is `invalid` too ('reserved'). The Status field's published value is one.
 *
 * A new form is the one an entry stores (entryForm): without its affix or
 * clitic markers, and a row whose markers name a type other than the entry's
 * carries it as `morphType`.
 */
export function planVocabReplace(
  items,
  {
    field,
    apply,
    tagset = null,
    morphTypeOf = (id, it) => it?.metadata?.morphType,
    reserved = null,
  },
) {
  const enforcing = tagsetEnforces(tagset);
  const rows = [];
  for (const it of items || []) {
    const old = field === 'form' ? (it.form ?? '') : String(it.metadata?.[field] ?? '');
    const next = apply(old);
    if (next == null) continue;
    let invalid = null;
    if (field === 'form' && next.trim() === '') invalid = 'empty';
    else if (
      reserved &&
      old === reserved.value &&
      next.trim() !== '' &&
      !(reserved.keep || []).includes(next)
    )
      invalid = 'reserved';
    else if (
      enforcing &&
      !isValueAllowed(next, entryTagsetFor(() => tagset, morphTypeOf(it.id, it), it.form)(field))
    )
      invalid = 'tagset';
    if (field === 'form' && !invalid) {
      // An entry form is stored without its affix or clitic markers, and
      // markers that name a type set it.
      const own = it.metadata?.morphType ?? null;
      const read = entryForm(own, next.trim());
      rows.push({
        id: it.id,
        form: it.form,
        old,
        new: read.form,
        invalid,
        ...(read.morphType !== own ? { morphType: read.morphType } : {}),
      });
      continue;
    }
    rows.push({ id: it.id, form: it.form, old, new: next, invalid });
  }
  return rows;
}

/**
 * The writes for the chosen rows, as bulk-update entries: `{id, form}` for a
 * form change (with the morph type its markers named, R27), `{id, metadata}` for a field change. A field change is ONE
 * metadata op on the key it touches: a set, or a delete where the replacement
 * empties the value, since the entry form never stores an empty one. Nothing
 * else on the entry is named, so nothing else can be lost.
 */
export function replaceWrites(rows, { field }) {
  const out = [];
  for (const row of rows) {
    if (row.invalid) continue;
    if (field === 'form')
      out.push({
        id: row.id,
        form: row.new.trim(),
        ...(row.morphType
          ? { metadata: [{ op: 'set', path: ['morphType'], value: row.morphType }] }
          : {}),
      });
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
