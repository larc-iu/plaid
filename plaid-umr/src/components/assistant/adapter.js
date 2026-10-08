// What the shared Assistant tab cannot know without knowing this app: how UMR
// addresses a place in a document (a sentence `s3`, a node `s3.s3e`), where
// that place opens in the editor, and how a cited sentence is drawn (its words
// and its graph).
//
// This is the whole of UMR's side of the tab. The generic half is
// plaid-ui/src/components/assistant/, and plaid-ud and plaid-igt have adapters
// of their own.
import {
  citationFocus,
  fencedBlock,
  linkLabel,
  tableCell,
} from '@ui/components/assistant/citations.js';
import { isUmrProject } from '@ui/domain/umrProject.js';
import { ExampleCard } from './ExampleCard.jsx';
import { citationTitle, deepLink, sentenceHref } from './cite.js';

// Cite tags, plus the older `{{Doc sN}}` braces and bare "s3.s3e" references
// (the service resolves those only when the turn read a single document). A
// lone "s3" is deliberately NOT matched: it would turn every sentence number
// in a sentence of prose into a link.
const CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.[A-Za-z][\w-]*)?(?:\s*,\s*[A-Za-z][\w-]*)*\s*\}\}?|(?<![\w{.])s\d+\.[A-Za-z][\w-]*\b/g;

// Where a citation opens and what it is called (cite.js, shared with the card).
export { citationTitle, sentenceHref };

// --- where a planned change lands ---------------------------------------------
// The service locates every change (plaid-agent's umr/changes.py): `where`
// names the document and, for a change inside one, the sentence, the reference
// and the node's own variable.

const changeHref = (projectId, where) => {
  if (!where) return null;
  if (where.kind === 'token' || where.kind === 'document') {
    return (
      `#/projects/${projectId}/documents/${where.documentId}/annotate` +
      (where.kind === 'token' ? deepLink(where.sentence, where.node) : '')
    );
  }
  return null;
};

const changeTitle = (where) => {
  if (!where) return '';
  if (where.kind === 'token')
    return (
      `${where.documentName}, sentence ${where.number ?? where.sentence}` +
      (where.node ? `, node ${where.node}` : '')
    );
  if (where.kind === 'document') return where.documentName || '';
  return '';
};

// The heading a change is filed under: its document. Changes with no location
// share one untitled group.
const groupOf = (projectId, where) => {
  if (!where) return { key: 'other', title: 'Other changes', href: null };
  return {
    key: `doc:${where.documentId}`,
    title: where.documentName || where.documentId,
    href: changeHref(projectId, { kind: 'document', documentId: where.documentId }),
  };
};

// What a plan row shows: the node as a link, with its reference beside it. A
// change to the whole document names the document, one to a whole sentence
// names the sentence.
const changePlace = (projectId, where) => {
  if (!where) return null;
  const href = changeHref(projectId, where);
  const title = changeTitle(where);
  if (where.kind === 'document') return { href, title, name: where.documentName, detail: null };
  if (where.kind !== 'token') return null;
  return where.node
    ? { href, title, name: where.node, detail: where.ref }
    : { href, title, name: `Sentence ${where.number ?? where.sentence}`, detail: where.surface };
};

// A cited sentence for the conversation export: the words, the gloss lines the
// project maps, and the graph in a fenced block, with the cited nodes named.
const citationToMarkdown = (c, { origin, projectId }) => {
  const out = [`**[${linkLabel(citationTitle(c))}](${sentenceHref(origin, projectId, c)})**`, ''];
  const words = (c.words || []).map((w) => w.text);
  if (words.length) {
    out.push(`| ${words.map((_w, i) => i + 1).join(' | ')} |`);
    out.push(`|${words.map(() => '---').join('|')}|`);
    out.push(`| ${words.map(tableCell).join(' | ')} |`);
    for (const line of c.lines || []) {
      if ((line.items || []).length !== words.length) continue;
      out.push(`| ${line.items.map(tableCell).join(' | ')} |`);
    }
    out.push('');
  } else if (c.text) {
    out.push(tableCell(c.text), '');
  }
  if (c.penman) out.push(...fencedBlock(c.penman));
  const focus = citationFocus(c);
  if (focus.length) out.push('', `Nodes cited: ${focus.join(', ')}`);
  return out.join('\n');
};

// A link back into a document this app is showing, or null when it points
// somewhere else. `focus` is the sentence and node the link names, which the
// shell's focusHere scrolls to instead of opening a second tab.
export const parseCitationHref = (href) => {
  const m = /#\/projects\/[^/]+\/documents\/([^/?#]+)\/annotate(?:\?([^#]*))?/.exec(href || '');
  if (!m) return null;
  const params = new URLSearchParams(m[2] || '');
  const sentence = params.get('sent');
  return {
    documentId: m[1],
    focus: sentence ? { sentence: sentence.replace(/^s/, ''), var: params.get('var') } : null,
  };
};

export const UMR_ASSISTANT = {
  app: 'umr',
  command: 'plaid-umr-agent',
  intro: 'Ask about the graphs or the corpus, or ask for changes.',
  // What a change flagged on the card is replacing. This app never edits the
  // text, so the only kind that sets the flag is a guideline rewrite, and what
  // approving one costs is the wording it replaces. Reads both ways: "1 change
  // rewrites wording somebody wrote", "2 changes rewrite wording somebody
  // wrote".
  textName: 'wording somebody wrote',
  convHref: (projectId, id) => `/projects/${projectId}/assistant?conversation=${id}`,
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
  // The assistant reads a project set up for UMR, and no other.
  opensProject: isUmrProject,
  examples: [
    'Which sentences have a graph with no aspect on its root?',
    'What does the document graph say about the first sentence?',
    'Summarize the concepts used across the corpus.',
  ],
};
