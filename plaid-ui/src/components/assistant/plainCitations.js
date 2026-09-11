// A citation renderer that belongs to no app.
//
// The admin area lists every assistant conversation across every app, so it
// reads records whose app it is not. It cannot draw those citations the way
// that app would -- an interlinear grid, a CoNLL-U table -- and it must not
// import another app's adapter to try. So a foreign conversation shows each
// citation as the plain document and reference it names, which is what an
// unresolved one has always shown.

// A cite tag of any app, plus the older brace form. Deliberately looser than
// either app's: it matches the syntax, not the addressing inside it.
export const PLAIN_CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.[\w-]+)*\s*\}\}?/g;

export const PLAIN_CITATIONS = {
  CITE_RE: PLAIN_CITE_RE,
  citationTitle: (c) => `${c.documentName || 'document'}, sentence ${c.sentence}`,
  // No link: this app does not know where another app's editor lives.
  citationHref: () => '',
  citationToMarkdown: (c) => `**${c.documentName || 'document'}, sentence ${c.sentence}**`,
};
