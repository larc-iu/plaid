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

from plaid_client.workflows.igt.senses import morpheme_morph_type

from ..core.bidi import plain_quote
from ..core.java_regex import compile_local
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


#: Any type an entry holds of its own: a non-empty string.
ANY_TYPE = {'regex': '.+'}


def _own_type(item: dict) -> bool:
    t = (item.get('metadata') or {}).get('morphType')
    return isinstance(t, str) and t != ''


class Corpus(BaseCorpus):
    """Query helpers bound to one workspace (its client, project, caches)."""

    def __init__(self, ws: Workspace):
        super().__init__(ws)
        self.W, self.M, self.S = self.p.word_layer_id, self.p.morpheme_layer_id, self.p.sentence_layer_id

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

    def bare_word(self, var: str = '?w', **c) -> List[list]:
        """A word token ``var`` nobody has segmented: no morpheme token at
        its extent. The editor shows it one morpheme all the same, the whole
        word (``project.virtual_morpheme_id``), which the engine cannot see."""
        if not self.M:
            raise ToolError('This project has no morpheme layer.')
        vs = {'doc': {'var': '?bxd'}, 'begin': {'var': '?bxb'}, 'end': {'var': '?bxe'}}
        return [self.word(var, **c), ['token', var, {'layer': self.W, **vs}],
                ['not', ['token', '?bxm', {'layer': self.M, **vs}]]]

    def shown_morph(self, var: str = '?m', form: Optional[Dict[str, Any]] = None) -> List[list]:
        """A morpheme token ``var`` that shows a form: its stored one, or,
        alone in its word, the word's surface. A morpheme with no form beside
        others is a gap the editor shows as ?, and no form at all. ``form``,
        when given, is a value constraint the shown form must meet. The
        variables it adds are named after ``var``, so one query can hold it
        for several morphemes."""
        t = ''.join(ch for ch in var if ch.isalnum())
        vs = {'doc': {'var': f'?gxd{t}'}, 'begin': {'var': f'?gxb{t}'}, 'end': {'var': f'?gxe{t}'}}
        tok = lambda v: ['token', v, {'layer': self.M, **vs}]  # noqa: E731
        stored = self.has_form(var) if form is None else self.morph(var, metadata={'form': form})
        surface = [] if form is None else [self.morph(var, value=form)]
        return [self.morph(var), tok(var),
                ['or', [stored],
                 [*surface, ['not', self.has_form(var)],
                  ['not', tok(f'?ga{t}'), tok(f'?gb{t}'), ['precedes', f'?ga{t}', f'?gb{t}']]]]]

    def morph_form_clauses(self, var: str, spec: Dict[str, Any]) -> List[list]:
        """Match a morpheme by the FORM it shows (:func:`shown_morph`): the
        stored metadata.form, or, for a morpheme alone in its word without
        one, the word's surface. A gap beside other morphemes matches none."""
        return self.shown_morph(var, spec)

    # --- morph types -----------------------------------------------------------
    # A morpheme linked to an entry that goes by a type goes by that one, and
    # stores no copy of it (R2): the query sees only the type a morpheme holds
    # of its own, so these read the entries' types from the lexicons.

    def entry_types(self) -> Dict[str, str]:
        """The morph type each entry of the project's lexicons goes by."""
        out: Dict[str, str] = {}
        for v in self.p.vocabs:
            out.update(self.ws.entry_types(v))
        return out

    def typed_group(self, where: List[Any], group: List[str], var: str = '?m') -> List[list]:
        """``group`` rows over the morphemes ``var`` of ``where``, each with the
        morph type the morpheme goes by after the keys: ``[key..., type,
        count]``, largest count first. Two reads, the linked morphemes and the
        others, since the query has no left join. A morpheme linked to two
        entries counts once for each."""
        own = f'{var}.metadata.morphType'
        types = self.entry_types() if self.p.vocabs else {}
        tally: Counter = Counter()
        if not types:
            for *keys, t, k in self.group(where, group + [own]):
                tally[(*keys, t or None)] += k
        else:
            for *keys, item, t, k in self.group(where + [['vocab-link', var, '?gtv']],
                                                group + ['?gtv', own]):
                tally[(*keys, morpheme_morph_type({'morphType': t}, types.get(item)))] += k
            for *keys, t, k in self.group(where + [['not', ['vocab-link', var, '?gtu']]], group + [own]):
                tally[(*keys, t or None)] += k
        return [[*key, n] for key, n in sorted(tally.items(), key=lambda kv: -kv[1])]

    def inherited_types(self) -> Dict[str, str]:
        """The entries of the project's lexicons that go by a type they do not
        hold of their own (a sense under a typed headword), by id."""
        out: Dict[str, str] = {}
        for v in self.p.vocabs:
            own = {it['id'] for it in self.ws.lexicon(v) if _own_type(it)}
            out.update((i, t) for i, t in self.ws.entry_types(v).items() if i not in own)
        return out

    def morph_type_clauses(self, var: str, spec: Dict[str, Any], pattern: str, regex: bool) -> List[list]:
        """A morpheme ``var`` that goes by a morph type ``spec`` matches
        (``rx(pattern, regex=regex, whole=not regex)``): one linked to an entry
        whose type matches, or one whose entry goes by none, or that has none,
        and whose own type matches.

        An entry that holds its type is matched by a join on it, and only the
        entries that take theirs from a headword are sent by id: a FLEx
        dictionary types every entry and sense, and the ids of all of them
        could pass SQLite's limit on a statement's bound parameters."""
        own = [self.morph(var, metadata={'morphType': spec})]
        types = self.entry_types() if self.p.vocabs else {}
        if not types:
            return own
        inherited = self.inherited_types()
        test = compile_local(pattern, literal=not regex, case_insensitive=True, whole=not regex)
        untyped = own + [['not', ['vocab', f'{var}n', {'metadata': {'morphType': ANY_TYPE}}],
                          ['vocab-link', var, f'{var}n']]]
        if inherited:
            untyped.append(['not', ['link', f'{var}i', {'item': list(inherited)}], ['link-token', f'{var}i', var]])
        branches = []
        if any(test.search(t) for i, t in types.items() if i not in inherited):
            branches.append([self.morph(var), ['vocab', f'{var}h', {'metadata': {'morphType': spec}}],
                             ['vocab-link', var, f'{var}h']])
        hits = [i for i, t in inherited.items() if test.search(t)]
        if hits:
            branches.append([self.morph(var), ['link', f'{var}l', {'item': hits}], ['link-token', f'{var}l', var]])
        if not branches:
            return untyped
        return [['or', *branches, untyped]]

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
        """``Doc s3.w2`` when the document is loaded or the plan touches few
        enough documents to load them, else the document name alone, quoted.
        Callers add the surface."""
        label = self.ws.doc_label(doc_id)
        if doc_id in self.ws._docs or (budget is not None and len(budget) <= LABEL_DOC_BUDGET):
            _, s, w, m = self.locate(doc_id, token_id)
            if s is not None:
                ref = f's{s.index}' + (f'.w{w.index}' if w else '') + (f'.m{m.index}' if m else '')
                return f'{label} {ref}'
        return self.ws.doc_label(doc_id, quote=True)

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
        back: its name, its own in the project (ruling 5), or its id when it
        has none."""
        return self.doc_name(doc_id)

    def tag(self, doc_id: str) -> str:
        """The document prefix on a reference. None in a one-document project."""
        return f'{plain_quote(self.ref_name(doc_id))} ' if len(self.doc_names()) > 1 else ''


# --- unanalyzed words ---------------------------------------------------------------

class Unanalyzed:
    """Clauses for a word token ``var`` with no analysis at all: no link, no
    span on any layer, and no morpheme within it that has a form, a type, a
    span, or a link, nor two morphemes (``stats._analyzed`` negated)."""

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
