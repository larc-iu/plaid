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
import { readProjectLanguage } from '../../utils/umrLayerUtils.js';
import { documentGroupOf } from '@ui/components/assistant/documentGroup.js';
import { ExampleCard } from './ExampleCard.jsx';
import { citationTitle, deepLink, sentenceHref } from './cite.js';
import { msg, t } from '@ui/lib/i18n.js';

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
  if (where.kind === 'token') {
    const v = {
      name: where.documentName,
      sentence: where.number ?? where.sentence,
      node: where.node,
    };
    return where.node
      ? t('{name}, sentence {sentence}, node {node}', v)
      : t('{name}, sentence {sentence}', v);
  }
  if (where.kind === 'document') return where.documentName || '';
  return '';
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
  // A node's variable carries its sentence's number already (`s19y`), so the
  // reference `s19.s19y` beside it said the variable twice: the sentence
  // stands there instead.
  const sentence = t('Sentence {sentence}', { sentence: where.number ?? where.sentence });
  return where.node
    ? { href, title, name: where.node, detail: sentence }
    : { href, title, name: sentence, detail: where.surface };
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
  if (focus.length) out.push('', `Nodes cited: ${focus.join(', ')}`); // i18n-ignore: the exported file's text
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
  // The tab's opening line, read when the tab is drawn: a getter, so the
  // message is looked up in the language of the page, not at module load.
  get intro() {
    return t('Ask about the graphs or the corpus, or ask for changes.');
  },
  // What a change flagged on the card is replacing. This app never edits the
  // text, so the only kind that sets the flag is a guideline rewrite, and what
  // approving one costs is the wording it replaces. The whole sentence the
  // plan card shows (`textRewrites`). `textName` is the contract's older
  // member, read only where `textRewrites` is missing.
  textRewrites: msg(
    '{n, plural, one {# change rewrites wording somebody wrote.} other {# changes rewrite wording somebody wrote.}}',
  ),
  textName: 'wording somebody wrote', // i18n-ignore: the old member, read only where textRewrites is missing
  convHref: (projectId, id) => `/projects/${projectId}/assistant?conversation=${id}`,
  CITE_RE,
  citationTitle,
  citationHref: sentenceHref,
  citationToMarkdown,
  ExampleCard,
  changePlace,
  // The heading a change is filed under: its document.
  groupOf: documentGroupOf(changeHref),
  parseCitationHref,
  // The assistant reads a project set up for UMR, and no other.
  opensProject: isUmrProject,
  projectLanguage: readProjectLanguage,
  // The example questions, in the reader's language when clicked (the tab
  // calls t() on each).
  examples: [
    msg('Which sentences have a graph with no aspect on its root?'),
    msg('What does the document graph say about the first sentence?'),
    msg('Summarize the concepts used across the corpus.'),
  ],
};
