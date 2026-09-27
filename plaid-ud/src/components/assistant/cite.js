// Where a cited sentence opens and what its link is called. Its own module,
// imported by both the adapter and the card: the card importing the adapter,
// which imports the card, was a cycle, and a page that evaluated the card first
// (a hot update, or another entry order) found the adapter's `ExampleCard`
// uninitialized and went blank.
import { citationFocus } from '@ui/components/assistant/citations.js';

// The sentence in the annotation editor. The route is `annotate`, and the
// sentence rides in the URL so the link is shareable and a middle-click opens
// it in a new tab.
//
// `?sent=` takes the sentence's TOKEN ID. The editor reads a number too, but a
// number moves when a sentence is split or merged, and an id does not.
export const sentenceHref = (origin, projectId, c) =>
  `${origin || ''}#/projects/${projectId}/documents/${c.documentId}/annotate` +
  (c.sentenceId ? `?sent=${encodeURIComponent(c.sentenceId)}` : '');

export const citationTitle = (c) => {
  const focus = citationFocus(c);
  const head = `${c.documentName}, sentence ${c.sentence}`;
  if (focus.length === 0) return head;
  if (focus.length === 1) return `${head}, word ${focus[0]}`;
  return `${head}, words ${focus.join(', ')}`;
};
