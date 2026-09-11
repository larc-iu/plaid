// What the shared Assistant tab cannot know without knowing this app: how IGT
// addresses a place in a document (`s3.w2.m1`), where that place is in the
// editor, and how a cited sentence is drawn (an interlinear table).
//
// This is the whole of IGT's side of the tab. The generic half is
// plaid-ui/src/components/assistant/, and plaid-ud has an adapter of its own.
import { citationFocus } from '@ui/components/assistant/citations.js';
import { ExampleCard } from './ExampleCard.jsx';
import { citationToMarkdown } from './citationMarkdown.js';

// Cite tags, plus the older `{{Doc sN}}` braces and bare "s32.w16" references
// (the service resolves those only when the turn read a single document).
export const CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.w\d+(?:\.m\d+)?)?\s*\}\}?|(?<![\w{.])s\d+(?:\.w\d+(?:\.m\d+)?)?\b/g;

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

// --- where a planned change lands ---------------------------------------------
// The service locates every change (plaid-agent's igt/changes.py): `where`
// names the document and, for a token change, the sentence, word, and
// morpheme, with the word's offset for the editor's deep link.

// The editor's deep link for a change, or null when there is nothing to open.
export const changeHref = (projectId, where) => {
  if (!where) return null;
  if (where.kind === 'token') {
    const at = typeof where.begin === 'number' && where.word ? `&focusWord=${where.begin}` : '';
    return `#/projects/${projectId}/documents/${where.documentId}?tab=analyze&focusSentence=${where.sentenceId}${at}`;
  }
  if (where.kind === 'document') return `#/projects/${projectId}/documents/${where.documentId}`;
  if (where.kind === 'entry' && where.vocabId) return `#/vocabularies/${where.vocabId}`;
  return null;
};

// `s3.w2.m1`: the short reference the assistant and the person share.
export const changeRef = (where) => {
  if (!where || where.kind !== 'token') return '';
  return (
    `s${where.sentence}` +
    (where.word ? `.w${where.word}` : '') +
    (where.morpheme ? `.m${where.morpheme}` : '')
  );
};

// What the link's tooltip says: the place in words.
export const changeTitle = (where) => {
  if (!where) return '';
  if (where.kind === 'token') {
    let s = `${where.documentName}, sentence ${where.sentence}`;
    if (where.word) s += `, word ${where.word}`;
    if (where.morpheme) s += `, morpheme ${where.morpheme}`;
    return s;
  }
  if (where.kind === 'document') return where.documentName || '';
  if (where.kind === 'entry')
    return where.vocabName ? `${where.vocabName}: ${where.form}` : where.form || '';
  return '';
};

// The heading a change is filed under: its document, or the lexicon for an
// entry. Changes with no location share one untitled group.
export const groupOf = (projectId, where) => {
  if (!where) return { key: 'other', title: 'Other changes', href: null };
  if (where.kind === 'entry')
    return {
      key: `entry:${where.vocabId || ''}`,
      title: where.vocabName || 'Lexicon',
      href: changeHref(projectId, where),
    };
  return {
    key: `doc:${where.documentId}`,
    title: where.documentName || where.documentId,
    href: changeHref(projectId, { kind: 'document', documentId: where.documentId }),
  };
};

// What a plan row shows for a change: the place as a link, plus the short
// reference beside it. A token change names the word (a whole-sentence one
// names the sentence and shows its text), an entry change names the form.
export const changePlace = (projectId, where) => {
  if (!where) return null;
  const href = changeHref(projectId, where);
  const title = changeTitle(where);
  if (where.kind === 'token')
    return where.word
      ? { href, title, name: where.surface, detail: changeRef(where) }
      : { href, title, name: `Sentence ${where.sentence}`, detail: where.surface };
  if (where.kind === 'entry') return { href, title, name: where.form, detail: null };
  return null;
};

export const IGT_ASSISTANT = {
  app: 'igt',
  label: 'this project',
  convHref: (projectId, id) => `/projects/${projectId}?tab=assistant&conversation=${id}`,
  documentHref: (projectId, documentId) =>
    `#/projects/${projectId}/documents/${documentId}?tab=analyze`,
  CITE_RE,
  citationTitle,
  citationHref: sentenceHref,
  ExampleCard,
  citationToMarkdown,
  changeHref,
  changeRef,
  changeTitle,
  changePlace,
  groupOf,
  examples: [
    'Which words in this project are still unglossed?',
    'Are the glosses for the most common suffix consistent?',
    'Summarize the noun morphology you can see in the corpus.',
  ],
};
