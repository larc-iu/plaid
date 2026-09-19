"""Turning the citation tags in a reply into example cards.

The syntax, the order citations are read in and the budget one reply may spend
are :mod:`plaid_agent.core.citations`. What is here is what a reference may
look like in this app, and what one card holds: the sentence it names, with
its words, its gloss lines and its graph, and the nodes the reference singles
out marked so the reader's eye lands on what the claim rests on.

**A reference is ``s3`` for a sentence and ``s3.s3e`` for a node in it.** A
list marks several nodes of one sentence, ``s3.s3e,s3p``, and a part after the
first may leave off the sentence it shares with the one before it. A UMR
variable carries its own sentence number, so ``s3e`` on its own resolves too.
"""

import re
from typing import Any, Dict, List

from ..core.citations import bare_re, brace_re, resolve_citations as core_resolve
from ..core.limits import MAX_FOCUS
from .project import UmrDoc, ilg_lines, penman_of, resolve_ilg
from .tools import Workspace

#: One whole reference, for the older ``{{Doc s3}}`` brace form.
REF = r's\d+(?:\.[A-Za-z][\w-]*)?(?:\s*,\s*[A-Za-z][\w-]*)*'

BRACE_RE = brace_re(REF)
# A bare reference is unambiguous only when it names a node: a lone "s3" turns
# every sentence number in a sentence of prose into a citation.
BARE_RE = bare_re(r's\d+\.[A-Za-z][\w-]*')

_SENTENCE = re.compile(r'^s(\d+)$')
_NODE = re.compile(r'^s(\d+)\.([A-Za-z][\w-]*)$')
_VARIABLE = re.compile(r'^[A-Za-z][\w-]*$')
# The UMR variable convention: a variable carries the number of the sentence
# it belongs to, so a bare one still says where it is.
_OWN_SENTENCE = re.compile(r'^s(\d+)[a-z]')

VIEWS = ('graph', 'words')


def parse_refs(ref: str) -> List[str]:
    """``"s3.s3e,s3p"`` -> ``['s3.s3e', 's3.s3p']``. A part after the first may
    leave off the sentence it shares with the part before it."""
    out: List[str] = []
    current = None
    for part in (ref or '').split(','):
        part = part.strip()
        if not part:
            continue
        m = _NODE.match(part)
        if m:
            current = int(m.group(1))
            out.append(f's{current}.{m.group(2)}')
            continue
        m = _SENTENCE.match(part)
        if m:
            current = int(m.group(1))
            out.append(f's{current}')
            continue
        if not _VARIABLE.match(part):
            continue
        own = _OWN_SENTENCE.match(part)
        where = int(own.group(1)) if own else current
        if where is None:
            continue
        current = where
        out.append(f's{where}.{part}')
    return out


def _card(doc: UmrDoc, project, sentence_index: int, focus: List[str],
          view: str = '') -> Dict[str, Any]:
    """One example card: the sentence as STRUCTURE, not as a rendered block.

    The tab has to mark the nodes the citation singles out, and it cannot do
    that inside a pre-formatted string. So the card carries the words, the
    gloss lines and the graph text separately, and the tab decides how an
    example looks.
    """
    s = doc.sentences[sentence_index - 1]
    marked = set(focus)
    lines = ilg_lines(s, project, doc.gloss, resolve_ilg(project))
    nodes = [{'var': n.var, 'concept': n.concept, 'attrs': n.attr_line(),
              'alignment': [list(a) for a in n.alignment], 'focus': n.var in marked}
             for n in s.nodes]
    return {
        'sentence': s.index,
        'sentence_id': s.id,
        'text': s.text,
        'words': [{'index': w.index, 'text': w.text} for w in s.words],
        'lines': [{'header': line.get('header') or line.get('key') or '',
                   'lang': line.get('lang'),
                   'items': [str(i) for i in line.get('items') or []]} for line in lines],
        'penman': penman_of(doc, s) or (s.raw_graph or ''),
        'nodes': nodes,
        'focus': focus,
        'view': view or 'graph',
    }


def _one(ws: Workspace, doc: UmrDoc, refs: List[str], view: str):
    """The card one citation's references name, or None where they name
    nothing in this document. One citation is one sentence: the first
    reference that resolves fixes it, and the rest mark nodes inside it."""
    sentence = None
    focus: List[str] = []
    for r in refs:
        m = _NODE.match(r) or _SENTENCE.match(r)
        if not m:
            continue
        index = int(m.group(1))
        if not 1 <= index <= len(doc.sentences):
            continue
        var = m.group(2) if m.re is _NODE else None
        if sentence is None:
            sentence = index
        if index != sentence or var is None or len(focus) >= MAX_FOCUS:
            continue
        if doc.sentences[index - 1].node(var) is not None and var not in focus:
            focus.append(var)
    if sentence is None:
        return None
    return _card(doc, ws.project, sentence, focus, view)


def resolve_citations(ws: Workspace, text: str) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that names a real sentence, in order
    of first mention."""
    return core_resolve(ws, text, parse_refs=parse_refs, card=_one,
                        brace=BRACE_RE, bare=BARE_RE, views=VIEWS)
