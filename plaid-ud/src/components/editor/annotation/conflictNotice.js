// Who stored the value an edit lost to, and the toast that says so.
//
// A cell edit refused because someone else changed the cell first shows the
// stored value, with the refused one under it (unsentValues.js). The toast
// names the change: "b changed this to NOUN." The name comes from the
// document's audit log: the newest change by another user that wrote this
// span, else the newest change by another user at all.

const RECENT = 50;

/** The display name of whoever last changed `spanId`, or null. */
export async function whoChanged(client, documentId, spanId, me) {
  const page = await client.documents.auditPage(documentId, { order: 'desc', limit: RECENT });
  const others = (page?.entries ?? []).filter((e) => e.user?.id && e.user.id !== me);
  const wrote = (e) => (e.ops ?? []).some((op) => spanId && op.description?.includes(spanId));
  const entry = others.find(wrote) ?? others[0];
  return entry ? entry.user.displayName || entry.user.id : null;
}

/** "b changed this to NOUN." */
export const changedTo = (who, stored) =>
  stored ? `${who || 'Someone'} changed this to ${stored}.` : `${who || 'Someone'} cleared this.`;
