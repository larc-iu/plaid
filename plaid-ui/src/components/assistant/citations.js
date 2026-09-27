// Sentence citations, the half that does not depend on how an app addresses a
// place in a document.
//
// The model cites evidence with a tag, `<cite doc="Text 1" ref="s3"/>`, and
// the service resolves each one to the data behind it, keyed by the exact text
// it matched. What a reference may look like inside that tag, what a resolved
// citation is called, where it links, and how its card is drawn are all the
// app's answer: see the `adapter` each of these takes.

const ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/]+))/g;

// What an unresolved citation reads as: the document and reference it names,
// without the syntax around them (Markdown would show the raw tag verbatim).
export const citePlain = (m) => {
  if (/^<\s*cite\b/i.test(m)) {
    const at = {};
    for (const a of m.matchAll(ATTR_RE)) at[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    return [at.doc || at.document || '', at.ref || at.sentence || ''].filter(Boolean).join(' ');
  }
  return m.replace(/^\{{1,2}\s*/, '').replace(/\s*\}{1,2}$/, '');
};

// What the citation points at: [{word, ...}], one entry per item the model
// named. The shape inside an entry is the app's.
export const citationFocus = (c) => c?.focus || [];

// Where a scroll box must be scrolled to put [left, right] (content
// coordinates) in the middle of it, clamped to what there is to scroll.
export const centeredScrollLeft = (left, right, viewport, scrollWidth) =>
  Math.max(0, Math.min((left + right) / 2 - viewport / 2, scrollWidth - viewport));

// The one Markdown escaper. Every name, title and cell value the assistant
// writes into Markdown (a reply, the conversation export, the admin
// transcript) goes through it. A document is named by whoever imported it,
// so a name can hold anything:
// - an unbalanced bracket ended a link's label early and cost the citation
//   its link, and a balanced pair with a URL made a link of its own
// - a CR or newline ends a heading, a table row or a bold run and starts
//   whatever comes next, a second heading or a `javascript:` link
// - a pipe ends a table cell, and a backslash before an escape undoes it
// - `<` opens an autolink or an HTML tag, and `*`, `_`, `~` and a backtick
//   restyle the text (a reconstructed `*kat` is not emphasis)
// - marked reads `\](` as the end of a label even when the bracket is
//   escaped, so an opening parenthesis is escaped as well (a closing one
//   stays bare, or a URL just before it would take the backslash)
// Every Markdown punctuation character that can start any of these is
// backslash-escaped, which CommonMark allows for any ASCII punctuation, and
// line breaks become one space. The result is one line of literal text,
// safe in a link label, a heading, a bold run and a table cell alike.
// - `&` starts an entity reference, so `&amp;` in a name printed as `&`
// - GFM links a bare `http://`, `https://`, `ftp://` or `www.` wherever it
//   appears, and inside such a link every escape shows as a backslash
//   (`a\_b`). The scheme's colon or the dot after `www` is escaped, so the
//   URL stays text and reads as it was written.
const MARKDOWN_SPECIAL = /[\\`*_[\](<>|~#&]/g;
const BARE_URL_START = /\b(https?|ftp)(:\/\/)|\b(www)(\.)/gi;

export const markdownText = (text) =>
  String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(MARKDOWN_SPECIAL, '\\$&')
    .replace(BARE_URL_START, (m, scheme, rest, www, dot) =>
      scheme ? `${scheme}\\${rest}` : `${www}\\${dot}`,
    );

// The same rule under the names the apps' citation writers use.
export const linkLabel = markdownText;
export const tableCell = markdownText;

// Text shown verbatim in a fenced code block, as the block's lines. A fence
// ends at the first run of backticks as long as its own, so the fence is one
// backtick longer than the longest run inside the text.
export const fencedBlock = (text) => {
  const body = String(text ?? '');
  const longest = Math.max(0, ...(body.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, body, fence];
};

// Text with every citation replaced: a resolved one by a Markdown link to the
// place in the editor (`onCited` sees each, for listing the cards), an
// unresolved one by its plain reference.
export const linkifyCitations = (adapter, text, byKey, { origin, projectId, onCited } = {}) =>
  (text || '').replace(adapter.CITE_RE, (m) => {
    const c = byKey.get(m);
    if (!c) return citePlain(m);
    onCited?.(m, c);
    // A citation into another project the conversation reads carries that
    // project's id, and links there.
    return `[${linkLabel(adapter.citationTitle(c))}](${adapter.citationHref(origin, c.projectId ?? projectId, c)})`;
  });
