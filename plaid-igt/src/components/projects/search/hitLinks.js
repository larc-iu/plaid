import { analyzeFocus } from '@/components/documents/hooks/focusHandoff.js';
import { APP_ROUTES } from '@/appRoutes';

// Click-through target for a hit: the document's Analyze tab focused on the
// hit sentence. The tab + sentence ride in the URL so the result is a real,
// shareable link (and a middle-click opens it in a new tab); the caret offset
// goes through sessionStorage via `rememberCaret`, since landing on the exact
// WORD is a detail of a click here, not something a shared link reproduces.
export const hitTo = (projectId, docId, sentenceId) =>
  APP_ROUTES.sentence(projectId, docId, sentenceId);

export const rememberCaret = (docId, sentenceId, begin = null) => {
  analyzeFocus.write({ docId, sentenceId, begin });
};
