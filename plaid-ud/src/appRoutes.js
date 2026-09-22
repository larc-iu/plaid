// Where this app keeps the screens plaid-ui has to link to, and which of its
// routes a path is. Handed to the package once, by `configureUi`.
//
// It lives here, and not in the package, because the apps do not agree: this
// one opens a document on its work surface, plaid-igt opens it at the document
// itself. `packageBoundaries.test.js` is what keeps a route from being guessed
// at over there.
export const APP_ROUTES = {
  projects: '/projects',
  login: '/login',
  profile: '/profile',
  documents: (projectId) => `/projects/${projectId}/documents`,
  document: (projectId, documentId) => `/projects/${projectId}/documents/${documentId}/annotate`,
  sentence: (projectId, documentId, sentenceId) =>
    `/projects/${projectId}/documents/${documentId}/annotate?sent=${sentenceId}`,
  // What kind of screen a path is, for the shell: whether a project is in
  // scope, whether the width belongs to a document, and whether the assistant
  // already has the whole screen.
  at: {
    project: (path) => /^\/projects\/[^/]+/.test(path),
    document: (path) => /^\/projects\/[^/]+\/documents\/[^/]+/.test(path),
    assistant: (path) => /^\/projects\/[^/]+\/assistant\/?$/.test(path),
  },
};
