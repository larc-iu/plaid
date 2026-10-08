// Where a cited sentence opens and what its link is called. Its own module,
// imported by both the adapter and the card: the card importing the adapter,
// which imports the card, was a cycle, and a page that evaluated the card first
// (a hot update, or another entry order) found the adapter's `ExampleCard`
// uninitialized and went blank.
import { citationFocus } from '@ui/components/assistant/citations.js';

// The sentence in the annotation editor, which scrolls to it and focuses the
// first cited node. A real anchor, so middle-click and cmd-click open it in a
// browser tab.
export const deepLink = (sentence, variable) =>
  sentence ? `?sent=${sentence}${variable ? `&var=${encodeURIComponent(variable)}` : ''}` : '';

export const sentenceHref = (origin, projectId, c) =>
  `${origin || ''}#/projects/${projectId}/documents/${c.documentId}/annotate` +
  deepLink(c.sentence, citationFocus(c)[0]);

export const citationTitle = (c) => {
  const focus = citationFocus(c);
  // `number` is what the editor shows, `sentence` the place ?sent= takes.
  const head = `${c.documentName}, sentence ${c.number ?? c.sentence}`;
  if (focus.length === 0) return head;
  if (focus.length === 1) return `${head}, node ${focus[0]}`;
  return `${head}, nodes ${focus.join(', ')}`;
};
