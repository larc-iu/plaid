// Where this app keeps the screens plaid-ui has to link to: the Activity
// panel's rows, the Comments tab's jump links, and the bounce out of a project
// a reader may not manage. Handed to the package once, by `configureUi`.
//
// It lives here, and not in the package, because the apps do not agree: this
// one opens a document on its work surface, plaid-igt opens it at the document
// itself. `packageBoundaries.test.js` is what keeps a route from being guessed
// at over there.
export const APP_ROUTES = {
  projects: '/projects',
  documents: (projectId) => `/projects/${projectId}/documents`,
  document: (projectId, documentId) => `/projects/${projectId}/documents/${documentId}/annotate`,
  sentence: (projectId, documentId, sentenceId) =>
    `/projects/${projectId}/documents/${documentId}/annotate?sent=${sentenceId}`,
};
