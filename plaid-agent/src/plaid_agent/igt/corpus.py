"""One project's clauses for the query engine.

``Corpus`` binds the shared engine wrapper (``core.corpus``) to one IGT
project: the clauses that name a word, a morpheme, a sentence, or a span of
a field, the two conventions the engine does not know (ignored punctuation
tokens are left out of word counts, and forms are compared
case-insensitively), and the lookups that turn an entity id back into a
reference a reader can type back. The per-tool queries built out of them
are in ``queries.py``.
"""

from collections import Counter
from typing import Any, Dict, Iterable, List, Optional

from ..core.corpus import Corpus as BaseCorpus
from ..core.limits import ROW_LIMIT
from .project import is_token_ignored
from ..core.tools import ToolError
from .workspace import Workspace

LABEL_DOC_BUDGET = 10      # documents a bulk tool may load just to write positional labels
# Documents a corpus read loads to show its hits. UD sets the same budget
# higher: a hit there is one KWIC line, where one here is a block of aligned
# lines, so more documents fit in the same answer.
RENDER_DOC_BUDGET = 8


class Corpus(BaseCorpus):
    """Query helpers bound to one workspace (its client, project, caches)."""

    def __init__(self, ws: Workspace):
        super().__init__(ws)
        self.W, self.M, self.S = self.p.word_layer_id, self.p.morpheme_layer_id, self.p.sentence_layer_id
        self._ref_names: Optional[Dict[str, str]] = None

    # --- clause builders -------------------------------------------------------

    def word(self, var: str = '?t', **c) -> list:
        return ['token', var, {'layer': self.W, **c}]

    def morph(self, var: str = '?m', **c) -> list:
        if not self.M:
            raise ToolError('This project has no morpheme layer.')
        return ['token', var, {'layer': self.M, **c}]

    def sent(self, var: str = '?sent', **c) -> list:
        return ['token', var, {'layer': self.S, **c}]

    def scope_layer(self, scope: str) -> str:
        if scope == 'Word':
            return self.W
        if scope == 'Sentence':
            return self.S
        if not self.M:
            raise ToolError('This project has no morpheme layer.')
        return self.M

    @staticmethod
    def span(var: str, layer_id: str, **c) -> list:
        return ['span', var, {'layer': layer_id, **c}]

    @staticmethod
    def has_form(var: str) -> list:
        """A morpheme token with a stored form (else it shows the word's surface)."""
        return ['token', var, {'metadata': {'form': {'regex': '.'}}}]

    def in_word(self, mvar: str, wvar: str, tag: str = '') -> List[list]:
        """A morpheme token ``mvar`` of the word token ``wvar``. In IGT a
        morpheme exactly fills its word, so this is an equality join on
        (doc, begin, end) value variables, which the engine runs an order of
        magnitude faster than the range containment of ``within``. Add your
        own constrained clauses for the same variables; constraints conjoin."""
        vs = {'doc': {'var': f'?xd{tag}'}, 'begin': {'var': f'?xb{tag}'}, 'end': {'var': f'?xe{tag}'}}
        return [['token', mvar, {'layer': self.M, **vs}], ['token', wvar, {'layer': self.W, **vs}]]

    def morph_form_clauses(self, var: str, spec: Dict[str, Any]) -> list:
        """Match a morpheme by its FORM: the stored metadata.form, or, for a
        morpheme without one, the surface it inherits from its word."""
        return ['or',
                [self.morph(var, metadata={'form': spec})],
                [self.morph(var, value=spec), ['not', self.has_form(var)]]]

    # --- conventions ----------------------------------------------------------

    def ignored(self, value: Optional[str]) -> bool:
        return is_token_ignored(value or '', self.p.ignored_cfg)

    def word_tally(self, where: List[Any], var: str = '?t') -> Counter:
        """Word forms (case-folded, punctuation excluded) with counts, from a
        grouped query over ``var``'s surface."""
        out: Counter = Counter()
        for value, n in self.group(where, [f'{var}.value']):
            if value is None or self.ignored(value):
                continue
            out[value.casefold()] += n
        return out

    def word_count(self, where: List[Any], var: str = '?t') -> int:
        return sum(self.word_tally(where, var).values())

    @staticmethod
    def morph_key(form: Optional[str], value: Optional[str]) -> str:
        """A morpheme's form for tallies: the stored one, else its surface."""
        return (form if form not in (None, '') else (value or '')).casefold()

    # --- documents ------------------------------------------------------------

    def document_metadata(self) -> Dict[str, dict]:
        """id -> metadata for every document, in one query."""
        rows = self.entities([['document', '?d', {}]], ['?d'], ROW_LIMIT)
        return {r[0]['id']: (r[0].get('metadata') or {}) for r in rows if isinstance(r[0], dict)}

    def versions(self, doc_ids: Iterable[str]) -> Dict[str, Optional[int]]:
        """Current versions of the named documents (for the stale-plan check)."""
        ids = [i for i in dict.fromkeys(doc_ids) if i]
        out: Dict[str, Optional[int]] = {}
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for r in self.entities([['document', '?d', {'id': chunk}]], ['?d'], len(chunk)):
                if isinstance(r[0], dict):
                    out[r[0]['id']] = r[0].get('version')
        return out

    # --- materializing hits ---------------------------------------------------

    def locate(self, doc_id: str, entity_id: str):
        """(doc, sentence, word|None, morpheme|None) for a token or span id,
        loading the document (cached for the turn)."""
        doc = self.ws.doc(doc_id)
        hit = doc.find(entity_id)
        if hit is None:
            return doc, None, None, None
        return (doc,) + hit

    def label_ref(self, doc_id: str, token_id: str, budget: Optional[set] = None) -> str:
        """``Doc s3.w2`` (the scan's label head) when the document is loaded
        or the plan touches few enough documents to load them; else the
        document name alone, quoted. Callers add the surface as the scan does."""
        label = self.ws.doc_label(doc_id)
        if doc_id in self.ws._docs or (budget is not None and len(budget) <= LABEL_DOC_BUDGET):
            _, s, w, m = self.locate(doc_id, token_id)
            if s is not None:
                ref = f's{s.index}' + (f'.w{w.index}' if w else '') + (f'.m{m.index}' if m else '')
                return f'{label} {ref}'
        return f'"{label}"'

    def may_load(self, doc_id: str, loaded: set) -> bool:
        """Whether rendering may fetch this document: already fetched this
        turn, or within the per-call budget of documents to fetch."""
        if doc_id in self.ws._docs or doc_id in loaded:
            loaded.add(doc_id)
            return True
        if len(loaded) >= RENDER_DOC_BUDGET:
            return False
        loaded.add(doc_id)
        return True

    def ref_name(self, doc_id: str) -> str:
        """How a printed reference names a document so that it can be read
        back: its name, or its id where another document shares that name
        (nothing forbids it, and imports produce it). resolve_document_id
        matches names case-insensitively, so collisions are judged that way."""
        if self._ref_names is None:
            names = self.doc_names()
            taken = Counter(n.casefold() for n in names.values())
            self._ref_names = {i: (i if taken[n.casefold()] > 1 else n) for i, n in names.items()}
        return self._ref_names.get(doc_id, doc_id)

    def tag(self, doc_id: str) -> str:
        """The document prefix on a reference. None in a one-document project."""
        return f'"{self.ref_name(doc_id)}" ' if len(self.doc_names()) > 1 else ''


# --- unanalyzed words ---------------------------------------------------------------

class Unanalyzed:
    """Clauses for a word token ``var`` with no analysis at all: no link, no
    span on any layer, and no morpheme within it that has a form, a type, a
    span, or a link, nor two morphemes (the scan's ``_analyzed`` negated)."""

    @staticmethod
    def clauses(c: Corpus, var: str = '?w') -> List[Any]:
        out = [['not', ['vocab-link', var, '?uv']],
               ['not', ['span', '?us', {'layer': '?usl'}], ['covers', '?us', var]]]
        if c.M:
            vs = {'doc': {'var': '?uxd'}, 'begin': {'var': '?uxb'}, 'end': {'var': '?uxe'}}
            m = lambda v, **cons: ['token', v, {'layer': c.M, **vs, **cons}]  # noqa: E731
            out.insert(0, ['token', var, {'layer': c.W, **vs}])
            out += [['not', m('?um1', metadata={'form': {'regex': '.'}})],
                    ['not', m('?um2', metadata={'morphType': {'regex': '.'}})],
                    ['not', m('?um3'), ['span', '?us3', {'layer': '?usl3'}], ['covers', '?us3', '?um3']],
                    ['not', m('?um4'), ['vocab-link', '?um4', '?uv4']],
                    ['not', m('?ua'), m('?ub'), ['precedes', '?ua', '?ub']]]
        return out


# --- awaiting review ----------------------------------------------------------------

def review_stamps(kind: str, user: Optional[str] = None) -> List[Dict[str, Any]]:
    """The metadata a span or morpheme awaiting review carries, one dict per
    origin: unconfirmed machine output and a contributor's work for
    ``unverified``, the latter alone (one person's with ``user``) for
    ``contributed``. Each is matched by JSON equality per key, so the
    origins are queried one at a time."""
    if kind == 'contributed':
        return [{'prov': 'contributed', **({'provSource': f'user:{user}'} if user else {})}]
    return [{'prov': 'inferred'}, {'prov': 'contributed'}]
