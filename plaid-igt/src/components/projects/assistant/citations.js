// Sentence citations, shared by the Assistant tab and the Markdown export.
//
// The model cites evidence with a tag, `<cite doc="Text 1" ref="s3"/>` (`ref`
// may name a word, `s3.w2`, or a morpheme, `s3.w2.m1`); the service resolves
// each one to interlinear data keyed by the exact text it matched (see
// citations.py). A citation alone on a line becomes an example card in place,
// one inside a sentence becomes a link, and one the service could not resolve
// is shown as the plain document and reference it names — never as markup.

// Cite tags, plus the older `{{Doc sN}}` braces and bare "s32.w16" references
// (the service resolves those only when the turn read a single document).
export const CITE_RE =
  /<\s*cite\b[^<>]*?\/?\s*>(?:[ \t]*<\s*\/\s*cite\s*>)?|\{\{?\s*[^{}\n]+?\s+s\d+(?:\.w\d+(?:\.m\d+)?)?\s*\}\}?|(?<![\w{.])s\d+(?:\.w\d+(?:\.m\d+)?)?\b/g;

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

// What the citation points at: [{word, morpheme}], one entry per item the
// model named. (A conversation saved before citations could name several
// carries a single `word`/`morpheme` instead.)
export const citationFocus = (c) =>
  c.focus || (c?.word ? [{ word: c.word, morpheme: c.morpheme || null }] : []);

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

// The rows of a cited sentence, in the Analyze grid's order: the surface row
// first, then the tiers the service sends (older stored citations without
// `tiers` fall back to the order the cells appear in). Empty rows are left out.
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

export const citationRows = (c) => {
  const words = c.words || [];
  let tiers = c.tiers;
  if (!tiers) {
    tiers = [];
    words.forEach((w) =>
      (w.lines || []).forEach((l) => {
        if (!tiers.some((t) => t.name === l.field)) tiers.push({ name: l.field, kind: 'field' });
      }),
    );
    if (words.some((w) => w.seg)) tiers.unshift({ name: 'Morphemes', kind: 'morphemes' });
  }
  const rows = [{ label: '', kind: 'surface', cells: words.map((w) => w.surface) }];
  for (const t of tiers) {
    const cells =
      t.kind === 'morphemes'
        ? words.map((w) => w.seg || '')
        : words.map((w) => (w.lines || []).find((l) => l.field === t.name)?.value || '');
    if (cells.some(Boolean)) rows.push({ label: t.name, kind: t.kind, cells });
  }
  return rows;
};

// Where a scroll box must be scrolled to put [left, right] (content
// coordinates) in the middle of it, clamped to what there is to scroll.
export const centeredScrollLeft = (left, right, viewport, scrollWidth) =>
  Math.max(0, Math.min((left + right) / 2 - viewport / 2, scrollWidth - viewport));

// Text with every citation replaced: a resolved one by a Markdown link to the
// sentence in the editor (`onCited` sees each, for listing the cards), an
// unresolved one by its plain reference.
export const linkifyCitations = (text, byKey, { origin, projectId, onCited } = {}) =>
  (text || '').replace(CITE_RE, (m) => {
    const c = byKey.get(m);
    if (!c) return citePlain(m);
    onCited?.(m, c);
    return `[${citationTitle(c)}](${sentenceHref(origin, projectId, c)})`;
  });
