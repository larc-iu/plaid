"""Sentence citations in replies.

The model cites evidence by writing a tag: ``<cite doc="Text 1" ref="s3"/>``
(``ref="s3.w2"`` for a word, ``ref="s3.w2.m1"`` for a morpheme, and a
comma-separated list, ``ref="s3.w2,w5"``, for several items in one sentence),
with the document and the reference exactly as the read tools print them.
Every item named is highlighted in the example the reader sees.

The syntax, the order citations are read in and the budget one reply may spend
are :mod:`plaid_agent.core.citations`. What is here is what a reference may
look like in this app, and what one card holds: the sentence as structured
interlinear data, which the Assistant tab draws as an example card with a link
into the editor at that sentence. The model never pastes interlinear text
itself: a citation is cheaper for it and better for the reader.
"""

from typing import Any, Dict, List

from ..core.citations import bare_re, brace_re, resolve_citations as core_resolve
from ..core.limits import MAX_FOCUS
from ..core.refs import read_ref_list
from .project import Sentence, Word, join_morphemes, joiner_between, parse_ref, resolve, segmentation
from .workspace import Workspace

REF = r's\d+(?:\.w\d+(?:\.m\d+)?)?'
BRACE_RE = brace_re(REF)
# A bare reference ("s32.w16") is unambiguous only when the turn read one document.
BARE_RE = bare_re(REF)

def parse_refs(ref: str) -> List[str]:
    """The references in one ``ref="…"`` (:func:`core.refs.read_ref_list`)."""
    return read_ref_list(ref, ('w', 'm'))


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
    joiners = [joiner_between(a.form, a.goes_by, b.form, b.goes_by, b.equals_before)
               for a, b in zip(w.morphemes, w.morphemes[1:])]

    def joined(parts: List[str]) -> str:
        return join_morphemes([(p, m.goes_by, m.equals_before) for p, m in zip(parts, w.morphemes)])

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


def _one(ws: Workspace, doc, refs: List[str], view: str):
    """The card one citation's references name, or None where they name
    nothing in this document. One citation is one sentence: the first
    reference that resolves fixes it, and the rest highlight items in it."""
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
        return None
    return {'focus': focus,
            **_sentence_payload(doc.sentences[sentence - 1], ws.project,
                                {f['word'] for f in focus if f['morpheme']})}


def resolve_citations(ws: Workspace, text: str) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that names a real sentence, in
    order of first mention. Unresolvable ones are left out (the UI shows them
    as the plain document and reference they name)."""
    return core_resolve(ws, text, parse_refs=parse_refs, card=_one,
                        brace=BRACE_RE, bare=BARE_RE)
