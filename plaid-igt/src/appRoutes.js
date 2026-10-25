// Where this app keeps the screens plaid-ui has to link to, and which of its
// routes a path is. Handed to the package once, by `configureUi`.
//
// It lives here, and not in the package, because the apps do not agree: this
// one opens a document at the document itself and keeps its document list on
// the project's own screen, where plaid-ud and plaid-umr open a document on
// their work surface. `packageBoundaries.test.js` is what keeps a route from
// being guessed at over there.
export const APP_ROUTES = {
  projects: '/projects',
  login: '/login',
  profile: '/profile',
  // The document list is the project screen's first tab, not a route of its own.
  documents: (projectId) => `/projects/${projectId}`,
  document: (projectId, documentId) => `/projects/${projectId}/documents/${documentId}`,
  // A sentence is reached on the tab that draws it, which is the grid, and
  // `word` (a word's begin offset) puts the caret on that word. With no
  // sentence it is the document's Analyze tab.
  sentence: (projectId, documentId, sentenceId, { word } = {}) =>
    `/projects/${projectId}/documents/${documentId}?tab=analyze` +
    (sentenceId == null ? '' : `&focusSentence=${encodeURIComponent(sentenceId)}`) +
    (typeof word === 'number' ? `&focusWord=${word}` : ''),
  // What kind of screen a path is, for a shell: whether a project is in scope,
  // whether the width belongs to a document, and whether the assistant already
  // has the whole screen.
  at: {
    project: (path) => /^\/projects\/[^/]+/.test(path),
    document: (path) => /^\/projects\/[^/]+\/documents\/[^/]+/.test(path),
    // This app's assistant is a TAB on the project screen rather than a route
    // of its own, so a path alone does not say. `AppLayout` reads the `?tab=`
    // itself, and it is the only thing here that asks.
    assistant: () => false,
  },
};

/**
 * A sentence link read back, as `APP_ROUTES.sentence` writes it behind a `#`
 * (with or without an origin before it): `{documentId, sentenceId, word}`,
 * `word` null when the link names none, or null for a link that is not one.
 */
export const parseSentenceHref = (href) => {
  const m = /#\/projects\/[^/]+\/documents\/([^/?#]+)\?[^#]*focusSentence=([^&]+)/.exec(href || '');
  if (!m) return null;
  const at = /[?&]focusWord=(\d+)/.exec(href);
  return {
    documentId: m[1],
    sentenceId: decodeURIComponent(m[2]),
    word: at ? Number(at[1]) : null,
  };
};
