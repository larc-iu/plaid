"""Sentence citations in replies.

The model cites evidence by writing ``{{<document> sN}}`` (or ``sN.wM`` to
point at a word), exactly as the read tools print references. At the end of
a turn the service resolves each citation against the documents the
workspace has loaded and returns the sentence as structured interlinear data
next to the reply, and the Assistant tab renders it as an example card with
a link into the editor at that sentence. The model never pastes interlinear
text itself: a citation is cheaper for it and better for the reader.
"""

import re
from typing import Any, Dict, List

from .project import Sentence, Word, resolve, joiner, segmentation
from .tools import Workspace, ToolError

CITE_RE = re.compile(r'\{\{\s*(?P<doc>.+?)\s+(?P<ref>s\d+(?:\.w\d+)?)\s*\}\}')
# A bare reference ("s32.w16") is unambiguous only when the turn read one document.
BARE_RE = re.compile(r'(?<![\w{.])(?P<ref>s\d+(?:\.w\d+)?)\b')
MAX_CITATIONS = 40


def _word_payload(w: Word, project) -> Dict[str, Any]:
    lines: List[Dict[str, str]] = []
    for f in project.fields_by_scope('Morpheme'):
        if not any(f.name in m.fields for m in w.morphemes):
            continue
        out = ''
        for i, m in enumerate(w.morphemes):
            if i:
                out += joiner(w.morphemes[i - 1].morph_type, m.morph_type)
            sp = m.fields.get(f.name)
            out += sp.value if sp and sp.value != '' else '_'
        lines.append({'field': f.name, 'value': out})
    for f in project.fields_by_scope('Word'):
        sp = w.fields.get(f.name)
        if sp and sp.value != '':
            lines.append({'field': f.name, 'value': sp.value})
    seg = segmentation(w)
    return {'index': w.index, 'surface': w.surface, 'seg': seg if (len(w.morphemes) > 1 or seg != w.surface) else None,
            'lines': lines}


def _sentence_payload(s: Sentence, project) -> Dict[str, Any]:
    return {'sentence_id': s.id, 'sentence': s.index, 'text': s.text,
            'words': [_word_payload(w, project) for w in s.words],
            'fields': [{'field': f.name, 'value': s.fields[f.name].value} for f in project.fields_by_scope('Sentence')
                       if f.name in s.fields and s.fields[f.name].value != '']}


def resolve_citations(ws: Workspace, text: str) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that names a real sentence, in
    order of first mention. Unresolvable ones are left out (the UI shows
    them as written)."""
    out: List[Dict[str, Any]] = []
    seen = set()
    text = text or ''

    def add(key: str, doc_name: str, ref: str) -> None:
        if key in seen or len(out) >= MAX_CITATIONS:
            return
        seen.add(key)
        try:
            doc = ws.doc(doc_name)
            obj = resolve(doc, ref)
        except (ToolError, ValueError):
            return
        if isinstance(obj, Word):
            s = next(s for s in doc.sentences if obj in s.words)
            word = obj.index
        else:
            s, word = obj, None
        out.append({'key': key, 'document_id': doc.id, 'document_name': doc.name, 'word': word,
                    **_sentence_payload(s, ws.project)})

    for m in CITE_RE.finditer(text):
        add(m.group(0), m.group('doc').strip().strip('"\''), m.group('ref'))
    # Sloppier models write "s32.w16" without the document: fine when the
    # turn read exactly one document, where such a reference means one thing.
    loaded = list(ws._docs.values())
    if len(loaded) == 1:
        rest = CITE_RE.sub(' ', text)
        for m in BARE_RE.finditer(rest):
            add(m.group(0), loaded[0].id, m.group('ref'))
    return out
