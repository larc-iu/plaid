// Where a cited sentence opens and what its link is called. Its own module,
// imported by both the adapter and the card: the card importing the adapter,
// which imports the card, was a cycle, and a page that evaluated the card first
// (a hot update, or another entry order) found the adapter's `ExampleCard`
// uninitialized and went blank.
import { citationFocus } from '@ui/components/assistant/citations.js';
import { t } from '@ui/lib/i18n.js';

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
  const v = { name: c.documentName, sentence: c.number ?? c.sentence };
  if (focus.length === 0) return t('{name}, sentence {sentence}', v);
  if (focus.length === 1)
    return t('{name}, sentence {sentence}, node {node}', { ...v, node: focus[0] });
  return t('{name}, sentence {sentence}, nodes {nodes}', { ...v, nodes: focus.join(', ') });
};
