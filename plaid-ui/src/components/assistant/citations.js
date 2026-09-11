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

// Text with every citation replaced: a resolved one by a Markdown link to the
// place in the editor (`onCited` sees each, for listing the cards), an
// unresolved one by its plain reference.
export const linkifyCitations = (adapter, text, byKey, { origin, projectId, onCited } = {}) =>
  (text || '').replace(adapter.CITE_RE, (m) => {
    const c = byKey.get(m);
    if (!c) return citePlain(m);
    onCited?.(m, c);
    return `[${adapter.citationTitle(c)}](${adapter.citationHref(origin, projectId, c)})`;
  });
