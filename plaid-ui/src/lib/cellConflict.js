// The words and the lookup behind a grid cell's refused edit, one copy for
// plaid-igt and plaid-ud (Luke's ruling Q1, 2026-09-29).
//
// A cell edit refused because someone else changed the cell first shows the
// stored value, with the refused one under it. A toast names the change:
// "b changed this to NOUN." The name comes from the document's audit log: the
// newest change by another user that wrote one of the cell's entities (its
// span or token), else the newest change by another user at all.

const RECENT = 50;

/**
 * The display name of whoever last changed one of `entityIds` in the
 * document, else of whoever last changed anything in it but `me`, or null.
 */
export async function whoChanged(client, documentId, entityIds, me) {
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
 * own (another change came first elsewhere), when the value is kept in the
 * cell and leaving the cell sends it again.
 */
export const KEPT_IN_CELL =
  'Changed elsewhere. Your value is kept in its cell, and leaving the cell sends it again.';
