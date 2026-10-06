// The words and the lookup behind a grid cell's refused edit, one copy for
// plaid-igt and plaid-ud (Luke's ruling Q1, 2026-09-29).
//
// A cell edit refused because someone else changed the cell first shows the
// stored value, with the refused one under it. A toast names the change:
// "b changed this to NOUN." The name comes from the document's audit log: the
// newest change whose operations name one of the cell's entities (its span or
// token). Failing that (a Bulk Edit, a text edit that re-cut the word, a
// value filled in, none of which names the row), the one person other than
// this one who wrote anything since the document the edit was made on, when
// there is exactly one. Otherwise nobody ("Someone").

import { settledId } from '../domain/pendingIds.js';

const RECENT = 50;

/** What `whoChanged` answers for a change made by the same account. */
const YOU = 'You';

// An audit time or a document's `timeModified` (ISO instants) with the
// fraction of a second at nine digits, so two compare as strings.
const instant = (t) => {
  const m = String(t ?? '').match(/^(.*?)(?:\.(\d+))?Z$/);
  return m ? `${m[1]}.${(m[2] ?? '').padEnd(9, '0').slice(0, 9)}Z` : null;
};

/**
 * The display name of whoever last changed one of `entityIds` in the
 * document, `YOU` when that was `me` (another tab or a run under the same
 * account) and nobody else wrote since, or null when the log names nobody.
 * `since` is when the document the edit was made on was last changed: only
 * what was written after it can be the change.
 */
async function whoChanged(client, documentId, entityIds, me, since = null) {
  const ids = (entityIds ?? []).filter(Boolean);
  const from = since ? instant(since) : null;
  if (ids.length === 0 && !from) return null;
  const page = await client.documents.auditPage(documentId, { order: 'desc', limit: RECENT });
  const all = (page?.entries ?? []).filter((e) => e.user?.id);
  const unseen = from ? all.filter((e) => (instant(e.time) ?? '') > from) : all;
  const wrote = (e) => (e.ops ?? []).some((op) => ids.some((id) => op.description?.includes(id)));
  const at = unseen.findIndex(wrote);
  if (at < 0) {
    // The log page may not reach back to `since`: then who wrote in the
    // window is not known.
    const reaches = all.length < RECENT || unseen.length < all.length;
    return from && reaches ? soleAuthor(unseen, me) : null;
  }
  const entry = unseen[at];
  if (entry.user.id !== me) return entry.user.displayName || entry.user.id;
  // Ours, but a later change by someone else that names no id may be the one.
  return unseen.slice(0, at).some((e) => e.user.id !== me) ? null : YOU;
}

/** The one person other than `me` who wrote any of `entries`, or null. */
function soleAuthor(entries, me) {
  const others = entries.filter((e) => e.user.id !== me);
  if (others.length === 0 || others.some((e) => e.user.id !== others[0].user.id)) return null;
  return others[0].user.displayName || others[0].user.id;
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
 * The notice for a lexicon link edit refused because someone else changed
 * what it changes first. `conflict.kind` says what: `changed` (the link),
 * `removed` (the link), `linked` (another link on the same word or words,
 * to the entry `conflict.form`), `token` (the word or morpheme itself,
 * `conflict.unit`), `entry` (the entry changed) or `entryGone`.
 */
export const linkChangedTo = (who, conflict = {}) => {
  const by = who || 'Someone';
  switch (conflict.kind) {
    case 'removed':
      return `${by} removed this link.`;
    case 'linked':
      return conflict.form ? `${by} linked this to ${closed(conflict.form)}` : `${by} linked this.`;
    case 'token':
      return `${by} changed this ${conflict.unit || 'word'}.`;
    case 'entry':
      return `${by} changed this entry.`;
    case 'entryGone':
      return `${by} deleted this entry.`;
    default:
      return `${by} changed this link.`;
  }
};

/**
 * Says a refused link edit's conflict (`err.linkConflict`, see
 * `linkChangedTo`) as `warn(message)`, once the audit log has said who, as
 * `announceCells` says a cell's. `context` as `announceCells`'s.
 */
export const announceLinkConflict = (context) => (conflict) =>
  Promise.resolve()
    .then(() =>
      whoChanged(
        context.client,
        context.documentId,
        (conflict.ids ?? []).filter(Boolean).map(settledId),
        context.me,
        conflict.since,
      ),
    )
    .catch(() => null)
    .then((who) => context.warn(linkChangedTo(who, conflict)));

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
      .then(() => whoChanged(context.client, context.documentId, ids, context.me, event.since))
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
