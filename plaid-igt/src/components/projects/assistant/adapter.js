// What the shared Assistant tab cannot know without knowing this app: how IGT
// addresses a place in a document (`s3.w2.m1`), where that place is in the
// editor, and how a cited sentence is drawn (an interlinear table).
//
// This is the whole of IGT's side of the tab. The generic half is
// plaid-ui/src/components/assistant/, and plaid-ud has an adapter of its own.
import { readInitialized } from '../../../domain/igtConfig.js';
import { ExampleCard } from './ExampleCard.jsx';
import { citationToMarkdown } from './citationMarkdown.js';
import { citationHighlights, citationRows, citationTitle, sentenceHref } from './cite.js';

// Cite tags, plus the older `{{Doc sN}}` braces and bare "s32.w16" references
// (the service resolves those only when the turn read a single document).
export const CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.w\d+(?:\.m\d+)?)?\s*\}\}?|(?<![\w{.])s\d+(?:\.w\d+(?:\.m\d+)?)?\b/g;

// Where a citation opens and what it is called (cite.js, shared with the card).
export { citationHighlights, citationRows, citationTitle, sentenceHref };

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
const groupOf = (projectId, where) => {
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
const changePlace = (projectId, where) => {
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

// A link back into a document this app is showing: the document it names and
// the sentence to put in view, or null when it points somewhere else.
// The same link, read back. `focusWord` has to come with it: the island uses
// it to land on the cited WORD, so dropping it made an in-place scroll deliver
// less than opening the very same link in a new tab.
export const parseCitationHref = (href) => {
  const m = /#\/projects\/[^/]+\/documents\/([^/?#]+)\?[^#]*focusSentence=([^&]+)/.exec(href || '');
  if (!m) return null;
  const at = /[?&]focusWord=(\d+)/.exec(href);
  return {
    documentId: m[1],
    focus: decodeURIComponent(m[2]),
    begin: at ? Number(at[1]) : null,
  };
};

export const IGT_ASSISTANT = {
  app: 'igt',
  command: 'plaid-igt-agent',
  intro: 'Ask about the corpus or the lexicon, or ask for changes.',
  // What a plan is rewriting when it changes the text rather than an
  // annotation of it. This app's word for it, on the tab it is edited on.
  textName: 'your baseline text',
  convHref: (projectId, id) => `/projects/${projectId}?tab=assistant&conversation=${id}`,
  CITE_RE,
  citationTitle,
  citationHref: sentenceHref,
  ExampleCard,
  citationToMarkdown,
  changeHref,
  changeTitle,
  changePlace,
  groupOf,
  parseCitationHref,
  // The assistant reads a project set up for IGT, and no other.
  opensProject: (project) => readInitialized(project?.config),
  examples: [
    'Which words in this project are still unglossed?',
    'Are the glosses for the most common suffix consistent?',
    'Summarize the noun morphology you can see in the corpus.',
  ],
};
