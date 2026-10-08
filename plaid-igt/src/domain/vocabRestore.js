// Putting one vocabulary entry back as it was at an earlier time: what the
// server's dry run says would change, said in the entry's own terms, and the
// history message the restore is written under.
//
// The server does the restore (`vocabLayers.restoreItem`) in one operation.
// Its dry run answers with booleans: the entry comes back (`inserted`), or a
// living entry's form or fields are set back. Which fields, and from what to
// what, is read here from the two entries the screen already holds: the one
// at that time and the one now.

import { fullTimestamp } from '@ui/lib/formatTime.js';
import { isolate } from '@ui/lib/bidi.js';
import { fieldLabel, FIELD_TYPES } from './vocabFields.js';

const show = (v) => {
  if (v == null || v === '') return '—';
  return `“${isolate(typeof v === 'string' ? v : JSON.stringify(v))}”`;
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The keys an entry keeps that no field row edits, by what they mean to the
// person reading the list.
const STRUCTURE = [
  [['parent', 'senseOrder'], 'Its place among the senses'],
  [['homograph'], 'Its number among the entries spelled alike'],
  [['examples'], 'Examples'],
];

/**
 * One line per change the restore makes, or [] before the dry run answers.
 * `summary` is the dry run's `{inserted, form, metadata, total}`, `past` the
 * entry at that time, `live` the entry now (null when it has been deleted),
 * `fields` the vocabulary's field rows.
 */
export function entryRestoreLines(summary, past, live, fields = []) {
  if (!summary) return [];
  if (summary.inserted) {
    return ['The entry comes back as it was.', 'Its links in documents do not come back.'];
  }
  const lines = [];
  if (summary.form) lines.push(`Form: ${show(live?.form)} → ${show(past?.form)}`);
  if (summary.metadata) {
    const fieldsFrom = lines.length;
    const then = past?.metadata || {};
    const now = live?.metadata || {};
    const told = new Set();
    for (const f of fields) {
      told.add(f.name);
      if (same(then[f.name], now[f.name])) continue;
      lines.push(
        f.type === FIELD_TYPES.ITEM
          ? fieldLabel(f)
          : `${fieldLabel(f)}: ${show(now[f.name])} → ${show(then[f.name])}`,
      );
    }
    for (const [keys, label] of STRUCTURE) {
      keys.forEach((k) => told.add(k));
      if (keys.some((k) => !same(then[k], now[k]))) lines.push(label);
    }
    const others = new Set([...Object.keys(then), ...Object.keys(now)]);
    // The server says the fields differ even where the copy on screen does
    // not (another person's edit since it was read): say so rather than
    // offer nothing to restore.
    if (
      lines.length === fieldsFrom ||
      [...others].some((k) => !told.has(k) && !same(then[k], now[k]))
    ) {
      lines.push('Other values');
    }
  }
  return lines;
}

/** The history message a restore of entry `label` to `asOf` is written under. */
export const entryRestoreMessage = (label, asOf) =>
  `Restore entry “${label}” to ${fullTimestamp(asOf)}`;

/**
 * The newest history entry of the vocabulary, or with `itemId` of that one
 * entry: the moment its live state belongs to, or null with no history. Read
 * BEFORE a restore so the state from just before it can be brought back, and
 * after, to tell whether the entry was edited since.
 */
export async function latestVocabState(client, vocabularyId, itemId = null) {
  const page = await client.vocabLayers.auditPage(vocabularyId, {
    order: 'desc',
    limit: 1,
    ...(itemId ? { itemId } : {}),
  });
  const last = page?.entries?.[0];
  if (!last) return null;
  return { time: last.endTime || last.time, id: last.id };
}
