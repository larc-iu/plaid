import { analyzeFocus } from '@/components/documents/hooks/focusHandoff.js';
import { APP_ROUTES } from '@/appRoutes';

// Click-through target for a hit: the document's Analyze tab focused on the
// hit sentence. The tab + sentence ride in the URL so the result is a real,
// shareable link (and a middle-click opens it in a new tab); the caret offset
// goes through sessionStorage via `rememberCaret`, since landing on the exact
// WORD is a detail of a click here, not something a shared link reproduces.
export const hitTo = (projectId, docId, sentenceId) =>
  APP_ROUTES.sentence(projectId, docId, sentenceId);

// Only on a plain left click: a click that opens the link in another tab or
// window would leave the request in this tab, for its next Analyze tab of
// that document.
export const rememberCaret = (event, docId, sentenceId, begin = null) => {
  const { button = 0, ctrlKey, metaKey, shiftKey, altKey } = event;
  if (button !== 0 || ctrlKey || metaKey || shiftKey || altKey) return;
  analyzeFocus.write({ docId, sentenceId, begin });
};
