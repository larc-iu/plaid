"""Turning the citation tags in a reply into example cards.

A reply cites evidence with ``<cite doc="Viaje" ref="s3.w2"/>``. Each distinct
citation becomes one card: the sentence it names, rendered, with the words the
reference singles out marked so the reader's eye lands on what the claim rests
on. A citation that names nothing real is left out, and the tab then shows the
tag's own text.
"""

import re
from typing import Any, Dict, List, Optional

from .project import COLUMNS, UdDoc, parse_ref, resolve
from .tools import ToolError, Workspace

REF = r's\d+(?:\.w\d+(?:-\d+)?)?(?:\s*,\s*(?:s\d+\.)?w?\d+(?:-\d+)?)*'

TAG_RE = re.compile(r'<\s*cite\b(?P<attrs>[^<>]*?)/?\s*>(?:[ \t]*<\s*/\s*cite\s*>)?', re.I)
ATTR_RE = re.compile(r'''([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/]+))''')
# Braces are still read: a model that saw a lot of them in training drifts back
# to them whatever the prompt says.
BRACE_RE = re.compile(r'\{\{?\s*(?P<doc>[^{}\n]+?)\s+(?P<ref>' + REF + r')\s*\}\}?')
# A bare reference is unambiguous only when the turn read exactly one document.
BARE_RE = re.compile(r'(?<![\w{.])(?P<ref>s\d+\.w\d+(?:-\d+)?)\b')

MAX_CITATIONS = 40
MAX_FOCUS = 20          # marked words in one citation
CITE_DOC_BUDGET = 8     # documents one reply's citations may fetch that the turn did not read

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
        m = PART_RE.match(part.strip())
        if not m:
            continue
        s, w, w2 = m.groups()
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


VIEWS = ('table', 'tree', 'grid')


def tag_parts(attrs: str):
    """-> (doc, ref, view, fields) from a <cite> tag's attributes.

    ``doc`` and ``ref`` may each be ''. ``view`` is how the example is drawn
    and ``fields`` which columns a grid shows; both are what the model ASKS
    for, and the reader can still switch the card to any of them.
    """
    at = {}
    for m in ATTR_RE.finditer(attrs):
        at[m.group(1).lower()] = next(g for g in m.groups()[1:] if g is not None)
    doc = at.get('doc') or at.get('document') or ''
    ref = at.get('ref') or at.get('sentence') or ''
    view = at.get('view', '').strip().lower()
    fields = [f.strip().lower() for f in at.get('fields', '').split(',') if f.strip()]
    return doc.strip(), ref.strip(), (view if view in VIEWS else ''), fields


def _card(doc: UdDoc, sentence_index: int, focus: List[int],
          view: str = '', fields: Optional[List[str]] = None) -> Dict[str, Any]:
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
                         'feats': '', 'head': '', 'deprel': '', 'token': True,
                         'focus': any(w.index in marked for w in t.words)})
        for w in t.words:
            rows.append({'id': str(w.index), 'form': w.form,
                         'lemma': w.marked('lemma'), 'upos': w.marked('upos'),
                         'xpos': w.marked('xpos'), 'feats': w.marked('features'),
                         'head': '' if w.head is None else str(w.head),
                         'deprel': w.deprel or '', 'token': False,
                         'focus': w.index in marked})
    # A column nothing in this sentence fills is noise in a narrow panel, so it
    # is left out. ID and FORM always stay: they are what a reference points at.
    keep = [c.lower() for c in COLUMNS]
    keep = [c for c in keep if c in ('id', 'form') or any(r[c] for r in rows)]
    # The INDEX is what a reference names and what the card prints; the ID is
    # what the editor's ?sent= deep link needs. Both, or the link lands on the
    # document and never scrolls.
    return {'sentence': s.index, 'sentence_id': s.id, 'text': s.text, 'columns': keep, 'rows': rows,
            'focus': focus, 'view': view or 'table',
            'fields': [f for f in (fields or []) if f in keep]}


def resolve_citations(ws: Workspace, text: str) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that names a real sentence, in order
    of first mention."""
    out: List[Dict[str, Any]] = []
    seen = set()
    text = text or ''
    loaded = list(ws._docs.values())
    read_before = len(ws._docs)

    def add(key: str, doc_name: str, ref: str, view: str = '', fields=None) -> None:
        if key in seen or len(out) >= MAX_CITATIONS:
            return
        seen.add(key)
        try:
            refs = parse_refs(ref)
            did = ws.resolve_document_id(doc_name)
            # Citing a document the turn never read costs a fetch each, and the
            # user is waiting on the reply.
            if did not in ws._docs and len(ws._docs) - read_before >= CITE_DOC_BUDGET:
                return
            doc = ws.doc(did)
        except (ToolError, ValueError):
            return
        # One citation is one sentence: the first reference that resolves fixes
        # it, and the rest mark words inside it.
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
            return
        out.append({'key': key, 'document_id': doc.id, 'document_name': doc.name,
                    **_card(doc, sentence, focus, view, fields)})

    found: List[tuple] = []
    for m in TAG_RE.finditer(text):
        doc, ref, view, fields = tag_parts(m.group('attrs'))
        # A tag without doc= means one thing when the turn read one document.
        if ref and (doc or len(loaded) == 1):
            found.append((m.start(), m.group(0), doc or loaded[0].id, ref, view, fields))
    for m in BRACE_RE.finditer(text):
        found.append((m.start(), m.group(0), m.group('doc').strip().strip('"\''), m.group('ref'), '', []))
    if len(loaded) == 1:
        blank = lambda m: ' ' * len(m.group(0))  # noqa: E731 - keep offsets, so order survives
        rest = BRACE_RE.sub(blank, TAG_RE.sub(blank, text))
        for m in BARE_RE.finditer(rest):
            found.append((m.start(), m.group(0), loaded[0].id, m.group('ref'), '', []))
    for _, key, doc, ref, view, fields in sorted(found, key=lambda f: f[0]):
        add(key, doc, ref, view, fields)
    return out
