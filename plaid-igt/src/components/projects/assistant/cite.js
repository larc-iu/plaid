// Where a cited sentence opens, what its link is called, and what its card and
// its Markdown table show. Its own module, imported by the adapter, the card
// and the Markdown writer alike: the card and the writer importing the adapter,
// which imports both, was a cycle, and a page that evaluated the card first (a
// hot update, or another entry order) found the adapter's `ExampleCard`
// uninitialized and went blank.
import { citationFocus } from '@ui/components/assistant/citations.js';

// The sentence in the editor, and the first cited word within it: both ride in
// the URL, so the link is shareable and a middle-click opens it in a new tab
// (a new tab does not inherit the sessionStorage an in-app click-through uses).
export const sentenceHref = (origin, projectId, c) => {
  const [first] = citationFocus(c);
  const word = first && (c.words || []).find((w) => w.index === first.word);
  const at = typeof word?.begin === 'number' ? `&focusWord=${word.begin}` : '';
  return `${origin || ''}#/projects/${projectId}/documents/${c.documentId}?tab=analyze&focusSentence=${c.sentenceId}${at}`;
};

export const citationTitle = (c) => {
  const focus = citationFocus(c);
  const head = `${c.documentName}, sentence ${c.sentence}`;
  if (focus.length === 0) return head;
  if (focus.length === 1) {
    const [f] = focus;
    return `${head}, word ${f.word}` + (f.morpheme ? `, morpheme ${f.morpheme}` : '');
  }
  // Several: the words locate them, and the highlight shows which morphemes.
  const words = [...new Set(focus.map((f) => f.word))];
  return `${head}, words ${words.join(', ')}`;
};

// Highlights by word index: `true` for the whole word, or a Set of morpheme
// indexes when the citation names morphemes inside it.
export const citationHighlights = (c) => {
  const out = new Map();
  for (const f of citationFocus(c)) {
    if (!f.morpheme) out.set(f.word, true);
    else if (out.get(f.word) !== true)
      out.set(f.word, (out.get(f.word) || new Set()).add(f.morpheme));
  }
  return out;
};

// The rows of a cited sentence, in the Analyze grid's order: the surface row
// first, then the tiers the service sends. Empty rows are left out.
export const citationRows = (c) => {
  const words = c.words || [];
  const rows = [{ label: '', kind: 'surface', cells: words.map((w) => w.surface) }];
  for (const t of c.tiers || []) {
    const cells =
      t.kind === 'morphemes'
        ? words.map((w) => w.seg || '')
        : words.map((w) => (w.lines || []).find((l) => l.field === t.name)?.value || '');
    if (cells.some(Boolean)) rows.push({ label: t.name, kind: t.kind, cells });
  }
  return rows;
};
