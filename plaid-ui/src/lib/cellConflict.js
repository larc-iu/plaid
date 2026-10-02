// The words and the lookup behind a grid cell's refused edit, one copy for
// plaid-igt and plaid-ud (Luke's ruling Q1, 2026-09-29).
//
// A cell edit refused because someone else changed the cell first shows the
// stored value, with the refused one under it. A toast names the change:
// "b changed this to NOUN." The name comes from the document's audit log: the
// newest change whose operations name one of the cell's entities (its span or
// token). No match names nobody ("Someone"): the newest change by anyone else
// may have touched another cell entirely.

import { settledId } from '../domain/pendingIds.js';

const RECENT = 50;

/** What `whoChanged` answers for a change made by the same account. */
const YOU = 'You';

/**
 * The display name of whoever last changed one of `entityIds` in the
 * document, `YOU` when that was `me` (another tab or a run under the same
 * account) and nobody else wrote since, or null when the log names nobody.
 */
async function whoChanged(client, documentId, entityIds, me) {
  const ids = (entityIds ?? []).filter(Boolean);
  if (ids.length === 0) return null;
  const page = await client.documents.auditPage(documentId, { order: 'desc', limit: RECENT });
  const entries = (page?.entries ?? []).filter((e) => e.user?.id);
  const wrote = (e) => (e.ops ?? []).some((op) => ids.some((id) => op.description?.includes(id)));
  const at = entries.findIndex(wrote);
  if (at < 0) return null;
  const entry = entries[at];
  if (entry.user.id !== me) return entry.user.displayName || entry.user.id;
  // Ours, but a later change by someone else that names no id may be the one.
  return entries.slice(0, at).some((e) => e.user.id !== me) ? null : YOU;
}

// A value that already ends a sentence ("He is tall.") takes no second period.
const closed = (value) => (/[.!?…]$/u.test(value) ? value : `${value}.`);

/** "b changed this word to si.": the word under a refused cell edit was
 * split or joined meanwhile, so the value was typed for another word. `unit`
 * is 'morpheme' for a morpheme re-segmented meanwhile. */
export const recutTo = (who, text, unit = 'word') =>
  `${who || 'Someone'} changed this ${unit} to ${closed(text)}`;

/** "b changed this to NOUN.", or "b cleared this." */
export const changedTo = (who, stored) =>
  stored
    ? `${who || 'Someone'} changed this to ${closed(stored)}`
    : `${who || 'Someone'} cleared this.`;

/**
 * The message for a cell edit refused as a conflict that is not the cell's
 * own (another change came first elsewhere), when the value waits in its
 * cell, drawn or not, to be sent again.
 */
export const KEPT_IN_CELL = 'Changed elsewhere. Your value is in its cell, not saved.';

/** The toast for a refused cell edit whose row is gone: nothing to put it back into. */
const NOT_SAVED = (typed) => `Not saved: ${typed}`;

/**
 * The words of the note under a cell that lost a conflict, "Yours: X · Enter
 * to keep yours", in three parts so the value can sit in its own `<bdi>`.
 */
export const conflictNoteParts = (typed) => ({
  before: 'Yours: ',
  value: typed || '(none)',
  after: ' · Enter to keep yours',
});

/**
 * The cell engine's `announce` (domain/cells/CellEngine.js), as toasts:
 * `warn(message)` for a conflict, once the audit log has said who, and
 * `error(message, title)` for a value kept in its cell or lost. `client`,
 * `documentId` and `me` are read when a toast is due, so they may be getters.
 */
export const announceCells = (context) => (event) => {
  if (event.kind === 'conflict') {
    // A re-cut is named by the change that split, joined or re-segmented its row.
    const ids = [...(event.entityIds ?? []), ...(event.recut?.ids ?? [])]
      .filter(Boolean)
      .map(settledId);
    Promise.resolve()
      .then(() => whoChanged(context.client, context.documentId, ids, context.me))
      .catch(() => null)
      .then((who) =>
        context.warn(
          event.recut != null
            ? recutTo(who, event.recut.text, event.recut.unit)
            : changedTo(who, event.stored),
        ),
      );
  } else if (event.kind === 'keptInCell') {
    context.error(KEPT_IN_CELL, `Failed to update ${event.field}`);
  } else if (event.kind === 'lost') {
    context.error(NOT_SAVED(event.typed), 'Changed elsewhere');
  }
};
