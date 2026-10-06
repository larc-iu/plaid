// A citation renderer, and a whole adapter, that belong to no app.
//
// The admin area lists every assistant conversation across every app, so it
// reads records whose app it is not. It cannot draw those citations the way
// that app would -- an interlinear grid, a CoNLL-U table -- and it must not
// import another app's adapter to try. So a foreign conversation shows each
// citation as the plain document and reference it names, which is what an
// unresolved one has always shown.

import { markdownText } from './citations.js';
import { PlainCitationCard } from './PlainCitationCard.jsx';

// A cite tag of any app, plus the older brace form. Deliberately looser than
// either app's: it matches the syntax, not the addressing inside it.
const PLAIN_CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.[\w-]+)*\s*\}\}?/g;

export const PLAIN_CITATIONS = {
  CITE_RE: PLAIN_CITE_RE,
  citationTitle: (c) => `${c.documentName || 'document'}, sentence ${c.sentence}`,
  // No link: this app does not know where another app's editor lives.
  citationHref: () => '',
  citationToMarkdown: (c) =>
    `**${markdownText(`${c.documentName || 'document'}, sentence ${c.sentence}`)}**`,
};

// Everything `Turn` reads from an adapter (adapterContract.js), for a
// conversation of an app this one is not. Citations as above, and a plan's
// changes filed under the document each names (`where.documentId` and
// `documentName` are the vocabulary every app's service shares), each row
// its word and reference where the service gave them, then its stored label,
// with no link.
export const PLAIN_ASSISTANT = {
  ...PLAIN_CITATIONS,
  app: '',
  command: '',
  intro: '',
  examples: [],
  textName: 'the text',
  convHref: () => '',
  ExampleCard: PlainCitationCard,
  groupOf: (_projectId, where) =>
    where?.documentId
      ? {
          key: `doc:${where.documentId}`,
          title: where.documentName || where.documentId,
          href: null,
        }
      : { key: 'other', title: 'Other changes', href: null },
  // The word a change lands on and its reference, as the service located it,
  // unlinked, so rows that change the same thing in different places are told
  // apart.
  changePlace: (_projectId, where) => {
    const name = where?.surface || where?.ref;
    if (!name) return null;
    return { href: null, title: '', name, detail: where.surface ? where.ref || null : null };
  },
  // The stored label, which says the whole change.
  rowText: (row) => row.label,
  parseCitationHref: () => null,
};
