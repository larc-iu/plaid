"""Sentence citations in replies.

The model cites evidence by writing a tag: ``<cite doc="Text 1" ref="s3"/>``
(``ref="s3.w2"`` for a word, ``ref="s3.w2.m1"`` for a morpheme, and a
comma-separated list, ``ref="s3.w2,w5"``, for several items in one sentence),
with the document and the reference exactly as the read tools print them.
Every item named is highlighted in the example the reader sees. At the end of
a turn the service resolves each citation against the documents the workspace
has loaded and returns the sentence as structured interlinear data next to the
reply, and the Assistant tab renders it as an example card with a link into the
editor at that sentence. The model never pastes interlinear text itself: a
citation is cheaper for it and better for the reader.

A tag rather than the ``{{...}}`` braces this used to use: models trained on
templating languages garble double braces, and quoted attributes keep a
document name (which may contain spaces, digits, even something like "s12")
apart from the reference after it.
"""

import re
from typing import Any, Dict, List

from .project import Sentence, Word, joiner, parse_ref, resolve, segmentation
from .tools import Workspace, ToolError

REF = r's\d+(?:\.w\d+(?:\.m\d+)?)?'
TAG_RE = re.compile(r'<\s*cite\b(?P<attrs>[^<>]*?)/?\s*>(?:[ \t]*<\s*/\s*cite\s*>)?', re.I)
ATTR_RE = re.compile(r'''([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/]+))''')
# Braces are still read: they were the old syntax, and a model that saw a lot
# of them in training drifts back to them.
BRACE_RE = re.compile(r'\{\{?\s*(?P<doc>[^{}\n]+?)\s+(?P<ref>' + REF + r')\s*\}\}?')
# A bare reference ("s32.w16") is unambiguous only when the turn read one document.
BARE_RE = re.compile(r'(?<![\w{.])(?P<ref>' + REF + r')\b')
MAX_CITATIONS = 40
MAX_FOCUS = 20  # highlighted items in one citation
CITE_DOC_BUDGET = 8  # documents the citations in one reply may fetch that the turn did not read

# One part of a ref="…" list: a whole reference, or only the piece that
# differs from the one before it ("s3.w2,w5", "s3.w2.m1,m3").
PART_RE = re.compile(r'(?:s(\d+))?\.?(?:w(\d+))?\.?(?:m(\d+))?')


def parse_refs(ref: str) -> List[str]:
    """The references in one ``ref="…"``: usually one, or several in the same
    sentence separated by commas or spaces, each inheriting from the one
    before it what it leaves out."""
    out: List[str] = []
    si = wi = None
    for part in re.split(r'[,;\s]+', (ref or '').strip()):
        if not part:
            continue
        m = PART_RE.fullmatch(part)
        if not m or not any(m.groups()):
            continue  # a stray word between references ("s3.w2 and w5"): skip it, keep the rest
        s_, w_, m_ = m.groups()
        if s_:
            si, wi = int(s_), (int(w_) if w_ else None)
        elif w_:
            wi = int(w_)
        if si is None or (m_ and wi is None):
            continue  # says neither which sentence nor which word it means
        out.append(f's{si}' + (f'.w{wi}' if wi else '') + (f'.m{int(m_)}' if m_ else ''))
    if not out:
        raise ValueError(f'Bad reference "{ref}": use s<n>, s<n>.w<n>, or s<n>.w<n>.m<n>')
    return out


def tag_parts(attrs: str):
    """-> (doc, ref) from a <cite> tag's attributes, either possibly ''."""
    at = {}
    for m in ATTR_RE.finditer(attrs):
        at[m.group(1).lower()] = next(g for g in m.groups()[1:] if g is not None)
    doc = at.get('doc') or at.get('document') or ''
    ref = at.get('ref') or at.get('sentence') or ''
    return doc.strip(), ref.strip()


def tiers(project) -> List[Dict[str, str]]:
    """The rows of the Analyze grid, in its order: orthographies, word fields,
    the morpheme forms, morpheme fields (each in layer order)."""
    out = [{'name': o, 'kind': 'orthography'} for o in project.orthographies]
    out += [{'name': f.name, 'kind': 'word'} for f in project.fields_by_scope('Word')]
    if project.morpheme_layer_id:
        out.append({'name': 'Morphemes', 'kind': 'morphemes'})
        out += [{'name': f.name, 'kind': 'morpheme'} for f in project.fields_by_scope('Morpheme')]
    return out


def _word_payload(w: Word, project, pieces: bool = False) -> Dict[str, Any]:
    """A word's cells, in the grid's row order (see :func:`tiers`). Morpheme
    rows are joined strings, as the grid shows them; ``pieces`` also sends
    them morpheme by morpheme, for a word whose morpheme is highlighted."""
    joiners = [joiner(a.morph_type, b.morph_type) for a, b in zip(w.morphemes, w.morphemes[1:])]

    def joined(parts: List[str]) -> str:
        return ''.join(p if i == 0 else joiners[i - 1] + p for i, p in enumerate(parts))

    lines: List[Dict[str, Any]] = []
    for o in project.orthographies:
        v = w.orthographies.get(o)
        if v:
            lines.append({'field': o, 'value': v})
    for f in project.fields_by_scope('Word'):
        sp = w.fields.get(f.name)
        if sp and sp.value != '':
            lines.append({'field': f.name, 'value': sp.value})
    for f in project.fields_by_scope('Morpheme'):
        if not any(f.name in m.fields for m in w.morphemes):
            continue
        parts = [(sp.value if (sp := m.fields.get(f.name)) and sp.value != '' else '_') for m in w.morphemes]
        lines.append({'field': f.name, 'value': joined(parts), **({'parts': parts} if pieces else {})})
    seg = segmentation(w)
    out = {'index': w.index, 'surface': w.surface, 'begin': w.begin,
           'seg': seg if (len(w.morphemes) > 1 or seg != w.surface) else None, 'lines': lines}
    if pieces:
        out['morphs'] = [m.form or '?' for m in w.morphemes]
        out['joiners'] = joiners
    return out


def _sentence_payload(s: Sentence, project, pieces_for=frozenset()) -> Dict[str, Any]:
    return {'sentence_id': s.id, 'sentence': s.index, 'text': s.text, 'tiers': tiers(project),
            'words': [_word_payload(w, project, w.index in pieces_for) for w in s.words],
            'fields': [{'field': f.name, 'value': s.fields[f.name].value} for f in project.fields_by_scope('Sentence')
                       if f.name in s.fields and s.fields[f.name].value != '']}


def resolve_citations(ws: Workspace, text: str) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that names a real sentence, in
    order of first mention. Unresolvable ones are left out (the UI shows them
    as the plain document and reference they name)."""
    out: List[Dict[str, Any]] = []
    seen = set()
    text = text or ''
    loaded = list(ws._docs.values())
    # Citing a document the turn never read costs a fetch each, and the user is
    # waiting on the reply: read a few, and drop citations past that.
    read_before = len(ws._docs)

    def add(key: str, doc_name: str, ref: str) -> None:
        if key in seen or len(out) >= MAX_CITATIONS:
            return
        seen.add(key)
        try:
            refs = parse_refs(ref)
            did = ws.resolve_document_id(doc_name)
            if did not in ws._docs and len(ws._docs) - read_before >= CITE_DOC_BUDGET:
                return
            doc = ws.doc(did)
        except (ToolError, ValueError):
            return
        # One citation is one sentence: the first reference that resolves
        # fixes it, and the rest highlight items in that sentence.
        sentence = None
        focus: List[Dict[str, int]] = []
        for r in refs:
            try:
                resolve(doc, r)  # for its bounds checks; the indexes come from the reference itself
            except ValueError:
                continue
            si, wi, mi = parse_ref(r)
            if sentence is None:
                sentence = si
            if si != sentence or wi is None or len(focus) >= MAX_FOCUS:
                continue
            if {'word': wi, 'morpheme': mi} not in focus:
                focus.append({'word': wi, 'morpheme': mi})
        if sentence is None:
            return
        out.append({'key': key, 'document_id': doc.id, 'document_name': doc.name, 'focus': focus,
                    **_sentence_payload(doc.sentences[sentence - 1], ws.project,
                                        {f['word'] for f in focus if f['morpheme']})})

    # Every citation, wherever it is written, in the order it is written.
    found: List[tuple] = []
    for m in TAG_RE.finditer(text):
        doc, ref = tag_parts(m.group('attrs'))
        # A tag without doc= means one thing when the turn read one document.
        if ref and (doc or len(loaded) == 1):
            found.append((m.start(), m.group(0), doc or loaded[0].id, ref))
    for m in BRACE_RE.finditer(text):
        found.append((m.start(), m.group(0), m.group('doc').strip().strip('"\''), m.group('ref')))
    # Sloppier models write "s32.w16" with no document at all: fine when the
    # turn read exactly one document, where such a reference means one thing.
    if len(loaded) == 1:
        blank = lambda m: ' ' * len(m.group(0))  # noqa: E731 - keep offsets, so order survives
        rest = BRACE_RE.sub(blank, TAG_RE.sub(blank, text))
        for m in BARE_RE.finditer(rest):
            found.append((m.start(), m.group(0), loaded[0].id, m.group('ref')))
    for _, key, doc, ref in sorted(found, key=lambda f: f[0]):
        add(key, doc, ref)
    return out
