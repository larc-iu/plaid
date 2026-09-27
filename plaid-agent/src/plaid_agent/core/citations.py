"""Finding the citations in a reply and resolving them against the corpus.

A reply cites its evidence with a tag: ``<cite doc="Text 1" ref="s3.w2"/>``,
with the document and the reference exactly as the read tools print them. At
the end of a turn each distinct citation is resolved against the documents the
workspace has loaded and returned beside the reply, and the app's Assistant tab
draws it as an example card. The model never pastes the example itself: a
citation is cheaper for it and better for the reader.

A tag rather than the ``{{...}}`` braces this used to use: models trained on
templating languages garble double braces, and quoted attributes keep a
document name (which may contain spaces, digits, even something like "s12")
apart from the reference after it. Braces are still read, because a model that
saw a lot of them in training drifts back to them whatever the prompt says.

In a turn that may read other projects, a tag names one of them with
``project``: ``<cite project="Lamkang B" doc="Text 1" ref="s3.w2"/>``. It is
resolved in that project's workspace and its card carries ``project_id``, so
the tab links it into that project. The brace and bare forms are the
conversation's own project only.

What is here is the half that is the same in both apps: the syntax, the order
citations are read in, and the budget one reply's citations may cost. What a
reference may look like and what a card holds are the app's own, passed in.
"""

import re
from typing import Any, Callable, Dict, List

from .limits import CITE_DOC_BUDGET, MAX_CITATIONS
from .tools import ToolError

TAG_RE = re.compile(r'<\s*cite\b(?P<attrs>[^<>]*?)/?\s*>(?:[ \t]*<\s*/\s*cite\s*>)?', re.I)
ATTR_RE = re.compile(r'''([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/]+))''')


def brace_re(ref: str) -> re.Pattern:
    """The older ``{{Text 1 s3}}`` form, over an app's reference syntax."""
    return re.compile(r'\{\{?\s*(?P<doc>[^{}\n]+?)\s+(?P<ref>' + ref + r')\s*\}\}?')


def bare_re(ref: str) -> re.Pattern:
    """A reference written on its own, which means one thing only when the
    turn read exactly one document."""
    return re.compile(r'(?<![\w{.])(?P<ref>' + ref + r')\b')


def tag_parts(attrs: str, views: tuple = ()):
    """``(doc, ref, view, project)`` from a ``<cite>`` tag's attributes, any of
    them possibly ''. ``view`` is how the model ASKS for the example to be
    drawn, out of ``views``; the reader can still switch the card."""
    at = {}
    for m in ATTR_RE.finditer(attrs):
        at[m.group(1).lower()] = next(g for g in m.groups()[1:] if g is not None)
    doc = at.get('doc') or at.get('document') or ''
    ref = at.get('ref') or at.get('sentence') or ''
    view = at.get('view', '').strip().lower()
    project = at.get('project') or ''
    return doc.strip(), ref.strip(), (view if view in views else ''), project.strip()


def cited(text: str, one_document: str, brace: re.Pattern, bare: re.Pattern,
          views: tuple = ()) -> List[tuple]:
    """``(key, document, ref, view, project)`` for every citation in ``text``,
    in the order they are written. ``one_document`` is the id to read a
    citation against when it names none, or '' when the turn read more than
    one. ``project`` is '' for the conversation's own project, and a tag that
    names another project must name its document too.
    """
    found: List[tuple] = []
    text = text or ''
    for m in TAG_RE.finditer(text):
        doc, ref, view, project = tag_parts(m.group('attrs'), views)
        if ref and (doc or (one_document and not project)):
            found.append((m.start(), m.group(0), doc or one_document, ref, view, project))
    for m in brace.finditer(text):
        found.append((m.start(), m.group(0), m.group('doc').strip().strip('"\''), m.group('ref'), '', ''))
    if one_document:
        # Sloppier models write the reference with no document at all, which
        # is fine where the turn read one and it means one thing.
        blank = lambda m: ' ' * len(m.group(0))  # noqa: E731 - keep offsets, so order survives
        rest = brace.sub(blank, TAG_RE.sub(blank, text))
        for m in bare.finditer(rest):
            found.append((m.start(), m.group(0), one_document, m.group('ref'), '', ''))
    return [f[1:] for f in sorted(found, key=lambda f: f[0])]


def resolve_citations(ws, text: str, *, parse_refs: Callable[[str], List[str]],
                      card: Callable[..., Any], brace: re.Pattern, bare: re.Pattern,
                      views: tuple = ()) -> List[Dict[str, Any]]:
    """Every distinct citation in ``text`` that resolves, in order of first
    mention. One that names nothing real is left out, and the tab then shows
    the tag's own text.

    ``card(ws, doc, refs, view)`` builds what the app's tab draws, or returns
    ``None`` where the references name nothing in that document. It is handed
    the workspace of the project the citation names.
    """
    from .reach import target
    out: List[Dict[str, Any]] = []
    seen = set()
    loaded = list(ws._docs.values())
    # Citing a document the turn never read costs a fetch each, and the user is
    # waiting on the reply: read a few, and drop citations past that. Counted
    # over every project's workspace, since each fetch costs the same.
    read_before: Dict[int, tuple] = {id(ws): (ws, len(ws._docs))}

    def fetched() -> int:
        return sum(len(w._docs) - n for w, n in read_before.values())

    for key, doc_name, ref, view, project in cited(text, loaded[0].id if len(loaded) == 1 else '',
                                                   brace, bare, views):
        if key in seen or len(out) >= MAX_CITATIONS:
            continue
        seen.add(key)
        try:
            w = target(ws, project)
            read_before.setdefault(id(w), (w, len(w._docs)))
            refs = parse_refs(ref)
            did = w.resolve_document_id(doc_name)
            if did not in w._docs and fetched() >= CITE_DOC_BUDGET:
                continue
            doc = w.doc(did)
        except (ToolError, ValueError):
            continue
        built = card(w, doc, refs, view)
        if built is not None:
            foreign = {'project_id': w.project.id} if w is not ws else {}
            out.append({'key': key, 'document_id': doc.id, 'document_name': doc.name, **foreign, **built})
    return out
