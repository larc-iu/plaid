// The words and the lookup behind a grid cell's refused edit, one copy for
// plaid-igt and plaid-ud (Luke's ruling Q1, 2026-09-29).
//
// A cell edit refused because someone else changed the cell first shows the
// stored value, with the refused one under it. A toast names the change:
// "b changed this to NOUN." The name comes from the document's audit log: the
// newest change by another user that wrote one of the cell's entities (its
// span or token), else the newest change by another user at all.

import { settledId } from '../domain/pendingIds.js';

const RECENT = 50;

/**
 * The display name of whoever last changed one of `entityIds` in the
 * document, else of whoever last changed anything in it but `me`, or null.
 */
async function whoChanged(client, documentId, entityIds, me) {
  const ids = (entityIds ?? []).filter(Boolean);
  const page = await client.documents.auditPage(documentId, { order: 'desc', limit: RECENT });
  const others = (page?.entries ?? []).filter((e) => e.user?.id && e.user.id !== me);
  const wrote = (e) => (e.ops ?? []).some((op) => ids.some((id) => op.description?.includes(id)));
  const entry = others.find(wrote) ?? others[0];
  return entry ? entry.user.displayName || entry.user.id : null;
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
    const ids = (event.entityIds ?? []).filter(Boolean).map(settledId);
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
