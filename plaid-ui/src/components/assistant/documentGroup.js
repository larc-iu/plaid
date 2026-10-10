// An adapter's `groupOf` for an app whose planned changes all sit in its
// documents: the heading a change is filed under is its document, linked by
// the app's `changeHref(projectId, { kind: 'document', documentId })`.
// Changes with no location share one untitled group.
export const documentGroupOf = (changeHref) => (projectId, where) => {
  if (!where) return { key: 'other', title: 'Other changes', href: null };
  return {
    key: `doc:${where.documentId}`,
    title: where.documentName || where.documentId,
    href: changeHref(projectId, { kind: 'document', documentId: where.documentId }),
  };
};
