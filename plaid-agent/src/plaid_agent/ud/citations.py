"""Turning the citation tags in a reply into example cards.

The syntax, the order citations are read in and the budget one reply may spend
are :mod:`plaid_agent.core.citations`. What is here is what a reference may
look like in this app, and what one card holds: the sentence it names, with the
words the reference singles out marked so the reader's eye lands on what the
claim rests on.
"""

import re
from typing import Any, Dict, List

from ..core.citations import bare_re, brace_re, resolve_citations as core_resolve
from ..core.limits import MAX_FOCUS
from .project import ALL_COLUMNS, UdDoc, deps_of, parse_ref, resolve
from .tools import Workspace

REF = r's\d+(?:\.w\d+(?:-\d+)?)?(?:\s*,\s*(?:s\d+\.)?w?\d+(?:-\d+)?)*'

BRACE_RE = brace_re(REF)
# A bare reference is unambiguous only when the turn read exactly one document.
BARE_RE = bare_re(r's\d+\.w\d+(?:-\d+)?')

# One part of a ref="…" list: a whole reference, or only the piece that differs
# from the one before it ("s3.w2,w5"). The `w` is optional on a continuation,
# because REF above accepts "s3.w2,3" and a part that matched nothing silently
# repeated the word before it.
PART_RE = re.compile(r'(?:s(\d+))?\.?(?:w?(\d+)(?:-(\d+))?)?')


def parse_refs(ref: str) -> List[str]:
    """``"s3.w2,w5"`` -> ``['s3.w2', 's3.w5']``. Each part may leave off what
    it shares with the part before it."""
    out: List[str] = []
    si = wi = None
    for part in (ref or '').split(','):
        part = part.strip()
        # Every group in PART_RE is optional, so `.match` succeeds on anything
        # with a zero-length match and the `if not m` below was dead code: a
        # part that matched NOTHING carried the previous word forward and
        # repeated the reference before it. "s3.w2,garbage" marked word 2
        # twice. A part has to match all of itself to count.
        m = PART_RE.fullmatch(part)
        if not part or not m:
            continue
        s, w, w2 = m.groups()
        # A reference is 1-BASED, so a zero is not a place: it reads as absent
        # and turns one reference into a different, valid-looking one.
        if any(p is not None and int(p) == 0 for p in (s, w, w2)):
            continue
        si = int(s) if s else si
        if si is None:
            continue
        wi = int(w) if w else (None if s else wi)
        if wi is None:
            out.append(f's{si}')
        elif w2:
            out.append(f's{si}.w{wi}-{w2}')
        else:
            out.append(f's{si}.w{wi}')
    return out


VIEWS = ('table', 'tree')


def _card(doc: UdDoc, sentence_index: int, focus: List[int],
          view: str = '') -> Dict[str, Any]:
    """One example card: the sentence as STRUCTURE, not as a rendered block.

    The tab has to mark the words the citation singles out, and it cannot do
    that inside a pre-formatted string. So a card carries the columns and one
    row per line, each saying whether it is in focus, and the tab decides how a
    CoNLL-U table looks.
    """
    # A row is keyed by its COLUMN name, lowercased, so the card can read
    # row[column] for any column. The app calls the field "features" and
    # CoNLL-U calls the column FEATS: the column name wins here.
    s = doc.sentences[sentence_index - 1]
    marked = set(focus)
    rows = []
    for t in s.tokens:
        if len(t.words) > 1:
            span = f'{t.words[0].index}-{t.words[-1].index}'
            rows.append({'id': span, 'form': t.surface, 'lemma': '', 'upos': '', 'xpos': '',
                         'feats': '', 'head': '', 'deprel': '', 'deps': '', 'token': True,
                         'focus': any(w.index in marked for w in t.words)})
        for w in t.words:
            rows.append({'id': str(w.index), 'form': w.form,
                         'lemma': w.marked('lemma'), 'upos': w.marked('upos'),
                         'xpos': w.marked('xpos'), 'feats': w.marked('features'),
                         'head': '' if w.head is None else str(w.head),
                         'deprel': w.deprel or '',
                         # The enhanced graph, on the sentences that have one
                         # of their own. A column nothing fills is dropped
                         # below, so a treebank without it sees no change.
                         'deps': deps_of(w) if s.has_enhanced else '',
                         'token': False, 'focus': w.index in marked})
    # A column nothing in this sentence fills is noise in a narrow panel, so it
    # is left out. ID and FORM always stay: they are what a reference points at.
    keep = [c.lower() for c in ALL_COLUMNS]
    keep = [c for c in keep if c in ('id', 'form') or any(r[c] for r in rows)]
    # The INDEX is what a reference names and what the card prints. The ID is
    # what the editor's ?sent= deep link needs. Both, or the link lands on the
    # document and never scrolls.
    return {'sentence': s.index, 'sentence_id': s.id, 'text': s.text, 'columns': keep, 'rows': rows,
            'focus': focus, 'view': view or 'table'}


def _one(ws: Workspace, doc: UdDoc, refs: List[str], view: str):
    """The card one citation's references name, or None where they name nothing
    in this document. One citation is one sentence: the first reference that
    resolves fixes it, and the rest mark words inside it."""
    sentence = None
    focus: List[int] = []
    for r in refs:
        try:
            resolve(doc, r)   # for its bounds checks
        except ValueError:
            continue
        si, a, b = parse_ref(r)
        if sentence is None:
            sentence = si
        if si != sentence or a is None or len(focus) >= MAX_FOCUS:
            continue
        for i in range(a, (b or a) + 1):
            if i not in focus:
                focus.append(i)
    if sentence is None:
        return None
    return _card(doc, sentence, focus, view)


def resolve_citations(ws: Workspace, text: str) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that names a real sentence, in order
    of first mention."""
    return core_resolve(ws, text, parse_refs=parse_refs, card=_one,
                        brace=BRACE_RE, bare=BARE_RE, views=VIEWS)
