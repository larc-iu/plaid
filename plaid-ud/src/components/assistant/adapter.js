// What the shared Assistant tab cannot know without knowing this app: how UD
// addresses a place in a document (CoNLL-U's own `s3.w2`, and `s3.w1-2` for a
// multi-word token), where that place opens in the editor, and how a cited
// sentence is drawn (a CoNLL-U table).
//
// This is the whole of UD's side of the tab. The generic half is
// plaid-ui/src/components/assistant/, and plaid-igt has an adapter of its own.
import { citationFocus } from '@ui/components/assistant/citations.js';
import { ExampleCard } from './ExampleCard.jsx';

// Cite tags, plus the older `{{Doc sN}}` braces and bare "s3.w2" references
// (the service resolves those only when the turn read a single document).
// A reference may name a multi-word token, `s3.w1-2`, but never a morpheme:
// UD's words are the smallest thing addressed.
export const CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.w\d+(?:-\d+)?)?\s*\}\}?|(?<![\w{.])s\d+(?:\.w\d+(?:-\d+)?)?\b/g;

// The sentence in the annotation editor. The route is `annotate`, and the
// sentence rides in the URL so the link is shareable and a middle-click opens
// it in a new tab.
//
// `?sent=` takes the sentence's TOKEN ID, not its number: the editor matches it
// against the sentences it loaded. Passing the number lands on the document and
// silently never scrolls.
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

// --- where a planned change lands ---------------------------------------------
// The service locates every change (plaid-agent's ud/changes.py): `where` names
// the document and, for a change inside one, the CoNLL-U reference, the
// sentence, and the word's own text.

export const changeHref = (projectId, where) => {
  if (!where) return null;
  if (where.kind === 'token')
    return (
      `#/projects/${projectId}/documents/${where.documentId}/annotate` +
      (where.sentenceId ? `?sent=${encodeURIComponent(where.sentenceId)}` : '')
    );
  if (where.kind === 'document')
    return `#/projects/${projectId}/documents/${where.documentId}/annotate`;
  return null;
};

export const changeTitle = (where) => {
  if (!where) return '';
  if (where.kind === 'token')
    return (
      `${where.documentName}, sentence ${where.sentence}` +
      (where.word ? `, word ${where.word}` : '')
    );
  if (where.kind === 'document') return where.documentName || '';
  return '';
};

// The heading a change is filed under: its document. Changes with no location
// share one untitled group.
export const groupOf = (projectId, where) => {
  if (!where) return { key: 'other', title: 'Other changes', href: null };
  return {
    key: `doc:${where.documentId}`,
    title: where.documentName || where.documentId,
    href: changeHref(projectId, { kind: 'document', documentId: where.documentId }),
  };
};

// What a plan row shows: the word as a link, with its reference beside it. A
// change to the whole document names the document, one to a whole sentence
// names the sentence.
export const changePlace = (projectId, where) => {
  if (!where) return null;
  const href = changeHref(projectId, where);
  const title = changeTitle(where);
  if (where.kind === 'document') return { href, title, name: where.documentName, detail: null };
  if (where.kind !== 'token') return null;
  return where.word
    ? { href, title, name: where.surface, detail: where.ref }
    : { href, title, name: `Sentence ${where.sentence}`, detail: where.surface };
};

// A cited sentence as a Markdown table, for the conversation export: the
// CoNLL-U columns, one row per line, with the cited words in bold.
const esc = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

export const citationToMarkdown = (c, { origin, projectId }) => {
  const columns = c.columns || [];
  const out = [`**[${esc(citationTitle(c))}](${sentenceHref(origin, projectId, c)})**`, ''];
  if (!columns.length) {
    out.push(esc(c.text));
    return out.join('\n');
  }
  out.push(`| ${columns.map(esc).join(' | ')} |`);
  out.push(`|${columns.map(() => '---').join('|')}|`);
  for (const r of c.rows || []) {
    const cells = columns.map((col) => (r.focus ? `**${esc(r[col])}**` : esc(r[col])));
    out.push(`| ${cells.join(' | ')} |`);
  }
  return out.join('\n');
};

// A link back into a document this app is showing: the document it names and
// the sentence to put in view, or null when it points somewhere else.
export const parseCitationHref = (href) => {
  const m = /#\/projects\/[^/]+\/documents\/([^/?#]+)\/annotate(?:\?sent=([^&]+))?/.exec(
    href || '',
  );
  return m ? { documentId: m[1], focus: m[2] ? decodeURIComponent(m[2]) : null } : null;
};

export const UD_ASSISTANT = {
  app: 'ud',
  command: 'plaid-ud-agent',
  intro: 'Ask about the corpus or the annotation, or ask for changes.',
  convHref: (projectId, id) => `/projects/${projectId}/assistant?conversation=${id}`,
  documentHref: (projectId, documentId) =>
    `#/projects/${projectId}/documents/${documentId}/annotate`,
  CITE_RE,
  citationTitle,
  citationHref: sentenceHref,
  citationToMarkdown,
  ExampleCard,
  changeHref,
  changeTitle,
  changePlace,
  groupOf,
  parseCitationHref,
  examples: [
    'Which words in this project still have no lemma?',
    'Are there dependency relations that look wrong?',
    'Summarize the parts of speech used across the corpus.',
  ],
};
