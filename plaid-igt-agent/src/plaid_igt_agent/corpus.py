"""Corpus-wide reads and target finding on the query engine.

The tools that look across the whole project (search, concordance, the
worklists, statistics, consistency and lexicon reports, sequence search,
and the bulk plan tools) ask the server's query engine for counts, grouped
tallies, and the ids of matching entities, instead of fetching every
document and scanning it in Python. Documents are fetched only to render
the handful of hits a tool shows (positional references, context), so cost
follows what is displayed, not the size of the corpus. With ``document=``
the tools still take the scan path over that one document, which gives the
richer per-document output and serves as the reference implementation the
query path is tested against.

Two conventions the query engine does not know are applied in Python on
grouped results: ignored (punctuation) word tokens are excluded from word
counts, and forms are compared case-insensitively.
"""

import re
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .project import IgtDoc, Sentence, Word, Morpheme, is_token_ignored
from .tools import Workspace, ToolError

GROUP_LIMIT = 100000       # the engine's backstop for group rows
ROW_LIMIT = 100000         # the engine's hard cap for ids/entities
LABEL_DOC_BUDGET = 10      # documents a bulk tool may load just to write positional labels
RENDER_DOC_BUDGET = 8      # documents a read tool loads to render the hits it shows
MORE_DOCS_NOTE = '  … more hits in other documents (name a document, or narrow the pattern)'


def rx(pattern: str, *, regex: bool = False, whole: bool = False, case_sensitive: bool = False) -> Dict[str, Any]:
    """A regex constraint: a literal substring (escaped) or a pattern, whole
    value when asked, case-insensitive unless asked otherwise."""
    p = pattern if regex else re.escape(pattern)
    if whole:
        p = f'^(?:{p})$'
    spec: Dict[str, Any] = {'regex': p}
    if not case_sensitive:
        spec['flags'] = 'i'
    return spec


def _err(e: Exception) -> ToolError:
    msg = str(e)
    m = re.search(r'"error"\s*:\s*"([^"]+)"', msg)
    return ToolError('Query rejected: ' + (m.group(1) if m else msg[:400]))


class Corpus:
    """Query helpers bound to one workspace (its client, project, caches)."""

    def __init__(self, ws: Workspace):
        self.ws = ws
        self.p = ws.project
        self.W, self.M, self.S = self.p.word_layer_id, self.p.morpheme_layer_id, self.p.sentence_layer_id
        self._ref_names: Optional[Dict[str, str]] = None

    # --- running queries ------------------------------------------------------

    def run(self, body: Dict[str, Any]) -> Dict[str, Any]:
        body = dict(body)
        body['scope'] = {'project_ids': [self.p.id]}
        try:
            res = self.ws.client.query(body)
        except Exception as e:  # noqa: BLE001 - the model gets the engine's message
            raise _err(e)
        return res if isinstance(res, dict) else {}

    def count(self, where: List[Any], find: List[str]) -> int:
        """Distinct tuples of ``find`` (never inflated by joins)."""
        return int(self.run({'find': find, 'where': where, 'return': 'count'}).get('count') or 0)

    def group(self, where: List[Any], group: List[str], aggregates=None, limit: int = GROUP_LIMIT) -> List[list]:
        """Grouped rows ``[key..., count]``; ``truncated`` is remembered on the
        instance for callers that want to say so."""
        res = self.run({'where': where, 'limit': limit,
                        'return': {'group': group, 'aggregates': aggregates or [['count']]}})
        self.truncated = bool(res.get('truncated'))
        return res.get('results') or []

    def entities(self, where: List[Any], find: List[str], limit: int, order_by=None) -> List[list]:
        body: Dict[str, Any] = {'find': find, 'where': where, 'return': 'entities', 'limit': min(limit, ROW_LIMIT)}
        if order_by:
            body['order_by'] = order_by
        res = self.run(body)
        self.truncated = bool(res.get('truncated'))
        return res.get('results') or []

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

    def doc_names(self) -> Dict[str, str]:
        return {d['id']: d.get('name') or d['id'] for d in self.ws.documents()}

    def doc_name(self, doc_id: str) -> str:
        return self.doc_names().get(doc_id, doc_id)

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
        """The document prefix on a reference; none in a one-document project."""
        return f'"{self.ref_name(doc_id)}" ' if len(self.doc_names()) > 1 else ''


# --- search ---------------------------------------------------------------------

def _hit_lines(c: Corpus, rows: List[list], token_col: int, limit: int, field=None, extra=None) -> List[str]:
    """Render token hits as the scan does: one line per word (deduplicated),
    ``"Doc" sN.wN <word> || <sentence>``, or the sentence line for a
    sentence field. ``extra`` returns text appended per hit (concordance)."""
    from .project import render_word, word_ref
    out: List[str] = []
    seen = set()
    loaded = set()
    for row in rows:
        ent = row[token_col]
        if not isinstance(ent, dict):
            continue
        if field is None and c.ignored(ent.get('value')):
            continue
        if not c.may_load(ent['document'], loaded):
            out.append(MORE_DOCS_NOTE)
            break
        doc, s, w, m = c.locate(ent['document'], ent['id'])
        if s is None:
            continue
        key = (doc.id, s.id, w.id if w else None)
        if key in seen:
            continue
        seen.add(key)
        tag = c.tag(doc.id)
        if w is None:
            sp = s.fields.get(field.name) if field else None
            out.append(f'{tag}s{s.index} {field.name}={sp.value if sp else ""} | {s.text}')
        else:
            out.append(f'{tag}{word_ref(s, w)} {render_word(w, c.p)[len(w.ref) + 1:]} || {s.text}')
        if len(out) >= limit:
            break
    return out


def q_search(ws: Workspace, pattern: str, where_l: str, field, regex: bool, limit: int) -> Tuple[List[str], int]:
    """Hits for search over the whole project: (lines, total)."""
    c = ws.corpus
    spec = rx(pattern, regex=regex)
    if where_l == 'baseline':
        where = [c.word('?t', value=spec)]
        total = c.word_count(where)
        rows = c.entities(where, ['?t'], limit * 2, [['?t.doc'], ['?t.begin']])
        return _hit_lines(c, rows, 0, limit), total
    if where_l == 'morpheme':
        where = [c.morph_form_clauses('?m', spec)] + c.in_word('?m', '?w')
        total = c.count(where, ['?w'])  # words, as the scan counts
        rows = c.entities(where, ['?m', '?w'], limit * 3, [['?w.doc'], ['?w.begin']])
        return _hit_lines(c, rows, 1, limit), total
    layer = c.scope_layer(field.scope)
    where = [c.span('?s', field.layer_id, value=spec), ['covers', '?s', '?t'], ['token', '?t', {'layer': layer}]]
    if field.scope == 'Morpheme':
        where += c.in_word('?t', '?w')
        total = c.count(where, ['?w'])
        rows = c.entities(where, ['?s', '?w'], limit * 3, [['?w.doc'], ['?w.begin']])
        return _hit_lines(c, rows, 1, limit), total
    total = c.count(where, ['?t'])
    rows = c.entities(where, ['?s', '?t'], limit * 2, [['?t.doc'], ['?t.begin']])
    return _hit_lines(c, rows, 1, limit, field=field if field.scope == 'Sentence' else None), total


# --- shared tallies --------------------------------------------------------------

def _casefold_tally(rows: List[list], keyfn) -> Tuple[Counter, Dict[str, set]]:
    """Fold grouped rows into casefolded counts, remembering the raw spellings
    behind each key (for follow-up ``in`` queries)."""
    counts: Counter = Counter()
    raw: Dict[str, set] = defaultdict(set)
    for row in rows:
        key, rawval = keyfn(row)
        if key is None:
            continue
        counts[key] += row[-1]
        raw[key].add(rawval)
    return counts, raw


def _chunks(items: List[Any], n: int = 200):
    for i in range(0, len(items), n):
        yield items[i:i + n]


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


def linked_word_ids(c: Corpus) -> Dict[str, str]:
    """Word id -> surface for every word linked itself or through a morpheme."""
    out: Dict[str, str] = {}
    for wid, value, _n in c.group([c.word('?w'), ['vocab-link', '?w', '?v']], ['?w', '?w.value']):
        out[wid] = value
    if c.M:
        for wid, value, _n in c.group(c.in_word('?m', '?w') + [['vocab-link', '?m', '?v']], ['?w', '?w.value']):
            out[wid] = value
    return out


# --- frequency_list ---------------------------------------------------------------

def q_frequency_list(ws: Workspace, what_l: str, field, limit: int, min_count: int):
    """(items [(key, n)], spread {key: documents}, empty) over the whole project."""
    c = ws.corpus
    empty = 0
    if what_l in ('wordform', 'word'):
        counts, raw = _casefold_tally(c.group([c.word('?t')], ['?t.value']),
                                      lambda r: ((r[0].casefold(), r[0]) if r[0] and not c.ignored(r[0]) else (None, None)))
    elif what_l == 'morpheme':
        counts, raw = _casefold_tally(c.group([c.morph('?m')], ['?m.metadata.form', '?m.value']),
                                      lambda r: ((Corpus.morph_key(r[0], r[1]) or None, (r[0], r[1])) if not c.ignored(r[1]) else (None, None)))
    else:
        counts, raw = _casefold_tally(c.group([c.span('?s', field.layer_id)], ['?s.value']),
                                      lambda r: ((r[0], r[0]) if r[0] not in (None, '') else (None, None)))
        layer = c.scope_layer(field.scope)
        where = [['token', '?t', {'layer': layer}], ['not', c.span('?s', field.layer_id), ['covers', '?s', '?t']]]
        empty = c.word_count(where) if field.scope == 'Word' else c.count(where, ['?t'])
    items = sorted(((k, n) for k, n in counts.items() if n >= max(1, int(min_count or 1))), key=lambda kv: (-kv[1], kv[0]))
    shown = items[:limit]
    # Document dispersion for the shown items only (a second, narrow query).
    spread: Dict[str, set] = defaultdict(set)
    if what_l in ('wordform', 'word'):
        values = [v for k, _ in shown for v in raw[k]]
        for chunk in _chunks(values):
            for value, doc, _n in c.group([c.word('?t'), ['in', '?t.value', chunk]], ['?t.value', '?t.doc']):
                spread[value.casefold()].add(doc)
    elif what_l == 'morpheme':
        forms = [f for k, _ in shown for f, v in raw[k] if f not in (None, '')]
        values = [v for k, _ in shown for f, v in raw[k] if f in (None, '')]
        for chunk in _chunks(forms):
            for form, doc, _n in c.group([c.morph('?m'), ['in', '?m.metadata.form', chunk]], ['?m.metadata.form', '?m.doc']):
                spread[form.casefold()].add(doc)
        for chunk in _chunks(values):
            for value, doc, _n in c.group([c.morph('?m'), ['not', c.has_form('?m')], ['in', '?m.value', chunk]],
                                          ['?m.value', '?m.doc']):
                spread[value.casefold()].add(doc)
    else:
        values = [k for k, _ in shown]
        for chunk in _chunks(values):
            for value, doc, _n in c.group([c.span('?s', field.layer_id), ['in', '?s.value', chunk]], ['?s.value', '?s.doc']):
                spread[value].add(doc)
    return items, spread, empty


# --- worklist ---------------------------------------------------------------------

def q_worklist(ws: Workspace, kind: str, f, lvl: str):
    """{form: count} over the whole project, plus {form: example document
    names}; for sentence fields the groups are documents."""
    c = ws.corpus
    names = c.doc_names()
    examples: Dict[str, List[str]] = {}
    if lvl == 'sentence':
        rows = c.group([c.sent('?t'), ['not', c.span('?s', f.layer_id), ['covers', '?s', '?t']]], ['?t.doc'])
        return {names.get(d, d): n for d, n in rows}, examples
    if kind == 'unanalyzed':
        where = [c.word('?w')] + Unanalyzed.clauses(c, '?w')
        counts = c.word_tally(where, '?w')
        by_doc = c.group(where, ['?w.value', '?w.doc'])
    elif kind == 'unverified':
        # Distinct words carrying any machine-made, unconfirmed span or
        # morpheme (links are not reachable by query).
        ids: Dict[str, Tuple[str, str]] = {}
        machine_span = ['span', '?s', {'layer': '?sl', 'metadata': {'prov': 'inferred'}}]
        unconfirmed = ['not', ['span', '?s', {'metadata': {'provConfirmed': True}}]]
        for wid, value, doc, _n in c.group([c.word('?w'), machine_span, ['covers', '?s', '?w'], unconfirmed],
                                           ['?w', '?w.value', '?w.doc']):
            ids[wid] = (value, doc)
        if c.M:
            for wid, value, doc, _n in c.group(c.in_word('?m', '?w') + [c.morph('?m', metadata={'prov': 'inferred'}),
                                                ['not', ['token', '?m', {'metadata': {'provConfirmed': True}}]]],
                                               ['?w', '?w.value', '?w.doc']):
                ids[wid] = (value, doc)
            for wid, value, doc, _n in c.group(c.in_word('?m', '?w') + [machine_span, ['covers', '?s', '?m'], unconfirmed],
                                               ['?w', '?w.value', '?w.doc']):
                ids[wid] = (value, doc)
        counts = Counter()
        by_doc = []
        for value, doc in ids.values():
            if c.ignored(value):
                continue
            counts[value.casefold()] += 1
            by_doc.append((value, doc, 1))
    elif lvl == 'word':
        if kind == 'unlinked':
            where = [c.word('?w'), ['not', ['vocab-link', '?w', '?v']]]
        else:
            where = [c.word('?w'), ['not', c.span('?s', f.layer_id), ['covers', '?s', '?w']]]
        counts = c.word_tally(where, '?w')
        by_doc = c.group(where, ['?w.value', '?w.doc'])
    else:
        if kind == 'unlinked':
            where = c.in_word('?m', '?w') + [['not', ['vocab-link', '?m', '?v']], ['not', ['vocab-link', '?w', '?v2']]]
        else:
            where = [c.morph('?m'), ['not', c.span('?s', f.layer_id), ['covers', '?s', '?m']]]
        rows = c.group(where, ['?m.metadata.form', '?m.value', '?m.doc'])
        counts = Counter()
        by_doc = []
        for form, value, doc, n in rows:
            key = Corpus.morph_key(form, value)
            if not key or c.ignored(value):  # a punctuation token's morpheme is not work
                continue
            counts[key] += n
            by_doc.append((key, doc, n))
    docs_of: Dict[str, Counter] = defaultdict(Counter)
    for value, doc, n in by_doc:
        if value:
            docs_of[value.casefold()][doc] += n
    for key, dc in docs_of.items():
        examples[key] = [f'"{names.get(d, d)}"' for d, _ in dc.most_common(3)]
    return dict(counts), examples


# --- corpus_stats ------------------------------------------------------------------

def q_corpus_numbers(ws: Workspace, per_doc: bool):
    """The numbers ``corpus_stats`` reports, from grouped queries: one dict
    (project-wide) or ``{doc_id: dict}``. ``longest`` is not computed here."""
    c = ws.corpus
    p = c.p
    fields = list(p.fields.values())

    def fresh():
        return {'sentences': 0, 'words': 0, 'forms': 0, 'hapax': 0, 'morphemes': 0, 'morpheme_forms': 0,
                'morpheme_hapax': 0, 'analyzed': 0, 'linked': 0, 'ttr': 0.0, 'longest': [],
                **{f'field:{f.name}': [0, 0] for f in fields}}

    rows: Dict[str, dict] = defaultdict(fresh)
    key = (lambda d: d) if per_doc else (lambda d: '*')
    # sentences
    for doc, n in c.group([c.sent('?t')], ['?t.doc']):
        rows[key(doc)]['sentences'] += n
    # words: (doc, form) pairs when per document, else forms
    forms: Dict[str, Counter] = defaultdict(Counter)
    if per_doc:
        for doc, value, n in c.group([c.word('?t')], ['?t.doc', '?t.value']):
            if value and not c.ignored(value):
                forms[doc][value.casefold()] += n
    else:
        forms['*'] = c.word_tally([c.word('?t')])
    for k, tally in forms.items():
        r = rows[k]
        r['_forms'] = tally
        r['words'] = sum(tally.values())
        r['forms'] = len(tally)
        r['hapax'] = sum(1 for n in tally.values() if n == 1)
        r['ttr'] = (r['forms'] / r['words']) if r['words'] else 0.0
    # morphemes
    if c.M:
        mforms: Dict[str, Counter] = defaultdict(Counter)
        group = ['?m.doc', '?m.metadata.form', '?m.value'] if per_doc else ['?m.metadata.form', '?m.value']
        for row in c.group([c.morph('?m')], group):
            doc = row[0] if per_doc else '*'
            if c.ignored(row[-2]):
                continue
            mforms[doc][Corpus.morph_key(row[-3], row[-2])] += row[-1]
        for k, tally in mforms.items():
            r = rows[k]
            r['_mforms'] = tally
            r['morphemes'] = sum(tally.values())
            r['morpheme_forms'] = len([f for f in tally if f])
            r['morpheme_hapax'] = sum(1 for f, n in tally.items() if f and n == 1)
    # analyzed = words - unanalyzed
    unan = [c.word('?w')] + Unanalyzed.clauses(c, '?w')
    for row in c.group(unan, ['?w.doc', '?w.value'] if per_doc else ['?w.value']):
        value = row[-2]
        if value and not c.ignored(value):
            rows[key(row[0]) if per_doc else '*']['unanalyzed'] = rows[key(row[0]) if per_doc else '*'].get('unanalyzed', 0) + row[-1]
    for r in rows.values():
        r['analyzed'] = r['words'] - r.pop('unanalyzed', 0)
    # linked words
    if p.vocabs:
        linked: Dict[str, set] = defaultdict(set)
        for where in ([c.word('?w'), ['vocab-link', '?w', '?v']],
                      *([c.in_word('?m', '?w') + [['vocab-link', '?m', '?v']]] if c.M else [])):
            for wid, value, doc, _n in c.group(where, ['?w', '?w.value', '?w.doc']):
                if not c.ignored(value):
                    linked[key(doc)].add(wid)
        for k, ids in linked.items():
            rows[k]['linked'] = len(ids)
    # field coverage
    for f in fields:
        filled = c.group([c.span('?s', f.layer_id), ['!=', '?s.value', '']], ['?s.doc'])
        for doc, n in filled:
            rows[key(doc)][f'field:{f.name}'][0] += n
    for k, r in rows.items():
        for f in fields:
            of = r['sentences'] if f.scope == 'Sentence' else r['words'] if f.scope == 'Word' else r['morphemes']
            r[f'field:{f.name}'] = (r[f'field:{f.name}'][0], of)
    if per_doc:
        return dict(rows)
    return rows['*']


def _empty_numbers(project):
    return {'sentences': 0, 'words': 0, 'forms': 0, 'hapax': 0, 'morphemes': 0, 'morpheme_forms': 0,
            'morpheme_hapax': 0, 'analyzed': 0, 'linked': 0, 'ttr': 0.0, 'longest': [],
            **{f'field:{f.name}': (0, 0) for f in project.fields.values()}}


q_corpus_numbers.empty = _empty_numbers


# --- concordance -------------------------------------------------------------------

def q_concordance_hits(ws: Workspace, pattern: str, where_l: str, field, regex: bool, limit: int):
    """[(doc, sentence, word, hit morpheme|None)] for the shown occurrences,
    ordered by document and position, and the total number of occurrences."""
    c = ws.corpus
    spec = rx(pattern, regex=regex, whole=not regex)
    if where_l == 'baseline':
        where = [c.word('?w', value=spec)]
        total = c.word_count(where, '?w')
        rows = c.entities(where, ['?w'], limit * 2, [['?w.doc'], ['?w.begin']])
        picks = [(r[0], None) for r in rows]
    elif where_l == 'morpheme':
        where = [c.morph_form_clauses('?m', spec)] + c.in_word('?m', '?w')
        total = c.count(where, ['?m'])
        rows = c.entities(where, ['?w', '?m'], limit, [['?w.doc'], ['?w.begin'], ['?m.precedence']])
        picks = [(r[0], r[1]) for r in rows]
    elif field.scope == 'Word':
        where = [c.span('?s', field.layer_id, value=spec), ['covers', '?s', '?w'], c.word('?w')]
        total = c.count(where, ['?w'])
        rows = c.entities(where, ['?w'], limit, [['?w.doc'], ['?w.begin']])
        picks = [(r[0], None) for r in rows]
    else:
        where = [c.span('?s', field.layer_id, value=spec), ['covers', '?s', '?m']] + c.in_word('?m', '?w')
        total = c.count(where, ['?m'])
        rows = c.entities(where, ['?w', '?m'], limit, [['?w.doc'], ['?w.begin'], ['?m.precedence']])
        picks = [(r[0], r[1]) for r in rows]
    hits = []
    loaded = set()
    for went, ment in picks:
        if not isinstance(went, dict) or (where_l == 'baseline' and c.ignored(went.get('value'))):
            continue
        if not c.may_load(went['document'], loaded):
            break
        doc, s, w, _ = c.locate(went['document'], went['id'])
        if w is None:
            continue
        hit = None
        if isinstance(ment, dict):
            hit = next((m for m in w.morphemes if m.id == ment['id']), None)
            if hit is None:
                continue
        hits.append((doc, s, w, hit))
        if len(hits) >= limit:
            break
    return hits, total


# --- analyses_of --------------------------------------------------------------------

def _tally_line(label: str, pairs, fmt=lambda k: k) -> Optional[str]:
    pairs = [(k, n) for k, n in pairs if k not in (None, '')]
    if not pairs:
        return None
    return f'  {label}: ' + ', '.join(f'{fmt(k)} ({n})' for k, n in sorted(pairs, key=lambda kv: (-kv[1], str(kv[0]))))


def q_analyses_of(ws: Workspace, form: str) -> str:
    """Precedent tallies for a form, from grouped queries: per field, per
    morpheme slot, links, and a few rendered examples."""
    from .project import render_word, word_ref
    c = ws.corpus
    p = c.p
    spec = rx(form, whole=True)
    item_form: Dict[str, str] = {}
    for v in p.vocabs:
        for it in ws.lexicon(v):
            item_form[it['id']] = it.get('form') or ''
    lines: List[str] = []

    def examples(where, find, order):
        out = []
        for row in c.entities(where, find, 3, order):
            ent = row[0]
            if not isinstance(ent, dict):
                continue
            doc, s, w, _ = c.locate(ent['document'], ent['id'])
            if w is not None:
                out.append(f'    {c.tag(doc.id)}{word_ref(s, w)} {render_word(w, p)[len(w.ref) + 1:]}')
        return out

    # the word
    word = [c.word('?w', value=spec)]
    n = c.word_count(word, '?w')
    if not n:
        lines.append(f'Word "{form}": no occurrences.')
    else:
        lines.append(f'Word "{form}": {n} occurrence{"s" if n != 1 else ""}.')
        # One query for every word field: spans on any layer covering the word.
        per_field: Dict[str, Counter] = defaultdict(Counter)
        for layer, v, k in c.group(word + [['span', '?s', {'layer': '?sl'}], ['covers', '?s', '?w']], ['?sl', '?s.value']):
            f = p.field_by_layer(layer)
            if f and v not in (None, ''):
                per_field[f.name][v] += k
        for f in p.fields_by_scope('Word'):
            line = _tally_line(f.name, per_field.get(f.name, {}).items())
            if line:
                lines.append(line)
        if c.M:
            slots: Dict[int, Counter] = defaultdict(Counter)
            for prec, mform, value, mtype, k in c.group(word + c.in_word('?m', '?w'),
                                                       ['?m.precedence', '?m.metadata.form', '?m.value', '?m.metadata.morphType']):
                key = Corpus.morph_key(mform, value) + (f' ({mtype})' if mtype else '')
                slots[prec or 0][key] += k
            if slots:
                lines.append('  Segmentation by slot: ' + '; '.join(
                    f'm{prec}: ' + ', '.join(f'{k} ({n2})' for k, n2 in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0])))
                    for prec, cnt in sorted(slots.items())))
            # One query for every morpheme field, by slot.
            fslots: Dict[str, Dict[int, Counter]] = defaultdict(lambda: defaultdict(Counter))
            for layer, prec, value, k in c.group(word + c.in_word('?m', '?w') + [['span', '?s', {'layer': '?sl'}], ['covers', '?s', '?m']],
                                                 ['?sl', '?m.precedence', '?s.value']):
                f = p.field_by_layer(layer)
                if f and value not in (None, ''):
                    fslots[f.name][prec or 0][value] += k
            for f in p.fields_by_scope('Morpheme'):
                if fslots.get(f.name):
                    lines.append(f'  {f.name} by slot: ' + '; '.join(
                        f'm{prec}: ' + ', '.join(f'{k} ({n2})' for k, n2 in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0])))
                        for prec, cnt in sorted(fslots[f.name].items())))
        if p.vocabs:
            line = _tally_line('Links', ((iid, k) for iid, k in c.group(word + [['vocab-link', '?w', '?v']], ['?v'])),
                               lambda iid: item_form.get(iid, iid))
            if line:
                lines.append(line)
            if c.M:
                line = _tally_line('Morpheme links', ((f'm{prec}:{item_form.get(iid, iid)}', k) for prec, iid, k in
                                                      c.group(word + c.in_word('?m', '?w') + [['vocab-link', '?m', '?v']], ['?m.precedence', '?v'])))
                if line:
                    lines.append(line)
        lines.append('  Examples:')
        lines.extend(examples(word, ['?w'], [['?w.doc'], ['?w.begin']]))
    # the morpheme
    if c.M:
        morph = [c.morph_form_clauses('?m', spec)] + c.in_word('?m', '?w')
        n = c.count(morph, ['?m'])
        if not n:
            lines.append(f'Morpheme "{form}": no occurrences.')
        else:
            lines.append(f'Morpheme "{form}": {n} occurrence{"s" if n != 1 else ""}.')
            # Containing words, type and slot from one grouped query; every
            # morpheme field from one more.
            words_t: Counter = Counter()
            types_t: Counter = Counter()
            slots_t: Counter = Counter()
            for wv, mtype, prec, k in c.group(morph, ['?w.value', '?m.metadata.morphType', '?m.precedence']):
                if wv:
                    words_t[wv.casefold()] += k
                if mtype:
                    types_t[mtype] += k
                slots_t[f'm{prec}'] += k
            line = _tally_line('In words', words_t.items())
            if line:
                lines.append(line)
            per_field = defaultdict(Counter)
            for layer, v, k in c.group(morph + [['span', '?s', {'layer': '?sl'}], ['covers', '?s', '?m']], ['?sl', '?s.value']):
                f = p.field_by_layer(layer)
                if f and v not in (None, ''):
                    per_field[f.name][v] += k
            for f in p.fields_by_scope('Morpheme'):
                line = _tally_line(f.name, per_field.get(f.name, {}).items())
                if line:
                    lines.append(line)
            line = _tally_line('Type', types_t.items())
            if line:
                lines.append(line)
            line = _tally_line('Slot', slots_t.items())
            if line:
                lines.append(line)
            if p.vocabs:
                line = _tally_line('Links', ((iid, k) for iid, k in c.group(morph + [['vocab-link', '?m', '?v']], ['?v'])),
                                   lambda iid: item_form.get(iid, iid))
                if line:
                    lines.append(line)
            lines.append('  Examples:')
            lines.extend(examples(morph, ['?w', '?m'], [['?w.doc'], ['?w.begin']]))
    return '\n'.join(lines)


# --- check_consistency ---------------------------------------------------------------

def q_consistency(ws: Workspace, f):
    """(values Counter, by_form {form: Counter}, unlinked (n, examples), linked_empty (n, examples))."""
    from .project import word_ref
    c = ws.corpus
    layer = c.scope_layer(f.scope)
    values: Counter = Counter()
    for v, n in c.group([c.span('?s', f.layer_id)], ['?s.value']):
        if v not in (None, ''):
            values[v] += n
    by_form: Dict[str, Counter] = {}
    unlinked = (0, [])
    linked_empty = (0, [])
    if f.scope == 'Sentence':
        return values, by_form, unlinked, linked_empty
    unit = ['token', '?u', {'layer': layer}]
    covered = [c.span('?s', f.layer_id), ['covers', '?s', '?u'], unit]
    if f.scope == 'Word':
        for form, v, n in c.group(covered, ['?u.value', '?s.value']):
            if v not in (None, '') and form and not c.ignored(form):
                by_form.setdefault(form.casefold(), Counter())[v] += n
    else:
        for mform, value, v, n in c.group(covered, ['?u.metadata.form', '?u.value', '?s.value']):
            if v not in (None, '') and not c.ignored(value):
                by_form.setdefault(Corpus.morph_key(mform, value), Counter())[v] += n
    if not c.p.vocabs:
        return values, by_form, unlinked, linked_empty

    def examples(where, find, fmt):
        out = []
        for row in c.entities(where, find, 15, [['?u.doc'], ['?u.begin']]):
            ent = row[0]
            if not isinstance(ent, dict):
                continue
            doc, s, w, m = c.locate(ent['document'], ent['id'])
            if w is None:
                continue
            ref = f'{c.tag(doc.id)}{word_ref(s, w)}' + (f'.m{m.index}' if m else '')
            out.append(fmt(ref, m or w, row))
        return out
    where = covered + [['!=', '?s.value', ''], ['not', ['vocab-link', '?u', '?v']]]
    n = c.count(where, ['?u'])
    unlinked = (n, examples(where, ['?u', '?s'], lambda ref, u, row: f'{ref} {u.form if f.scope == "Morpheme" else u.surface} ({row[1].get("value")})') if n else [])
    where = [unit, ['vocab-link', '?u', '?v'], ['not', c.span('?s', f.layer_id), ['covers', '?s', '?u']]]
    n = c.count(where, ['?u'])
    linked_empty = (n, examples(where, ['?u'], lambda ref, u, row: f'{ref} {u.form if f.scope == "Morpheme" else u.surface} → {u.link.form if u.link else "?"}') if n else [])
    return values, by_form, unlinked, linked_empty


# --- check_lexicon --------------------------------------------------------------------

def q_lexicon_usage(ws: Workspace, vocabs: List[dict], items: Dict[str, dict]):
    """(uses, use_docs, corpus_gloss, gloss_items, stale) for check_lexicon,
    from grouped queries over the links of the given lexicons."""
    from .stats import _strip_affix
    c = ws.corpus
    p = c.p
    gm, gw = p.gloss_field('Morpheme'), p.gloss_field('Word')
    uses: Counter = Counter()
    use_docs: Dict[str, set] = defaultdict(set)
    corpus_gloss: Dict[str, Counter] = defaultdict(Counter)
    gloss_items: Dict[str, set] = defaultdict(set)
    stale: List[str] = []
    levels = [('?t', c.word('?t'), gw, ['?t.value'])]
    if c.M:
        levels.append(('?t', c.morph('?t'), gm, ['?t.metadata.form', '?t.value']))
    for v in vocabs:
        base = [['vocab', '?v', {'layer': v['id']}], ['vocab-link', '?t', '?v']]
        for var, tok, gloss_field, form_keys in levels:
            where = base + [tok]
            for iid, n in c.group(where, ['?v']):
                if iid in items:
                    uses[iid] += n
            for iid, doc, _n in c.group(where, ['?v', '?t.doc']):
                if iid in items:
                    use_docs[iid].add(doc)
            if gloss_field:
                for iid, value, n in c.group(where + [c.span('?s', gloss_field.layer_id), ['covers', '?s', '?t']], ['?v', '?s.value']):
                    if iid in items and value not in (None, ''):
                        corpus_gloss[iid][value] += n
                        gloss_items[value].add(iid)
            for row in c.group(where, ['?v'] + form_keys):
                iid, n = row[0], row[-1]
                if iid not in items:
                    continue
                form = Corpus.morph_key(row[1], row[2]) if len(form_keys) == 2 else (row[1] or '')
                if c.ignored(row[2] if len(form_keys) == 2 else row[1]):
                    continue
                if _strip_affix(items[iid].get('form')) not in _strip_affix(form):
                    stale.append(f'{form} → "{items[iid].get("form")}"' + (f' ×{n}' if n > 1 else ''))
    return uses, use_docs, corpus_gloss, gloss_items, stale


# --- sequence_search ----------------------------------------------------------------

_PUNCT_FILLER = ['rep', 0, 2, ['token', {'value': {'regex': r'^[\p{P}\p{S}]+$'}}]]


def q_sequence(ws: Workspace, sequence: List[Dict[str, Any]], adjacent: bool, regex: bool, limit: int):
    """[(doc, sentence, [matched word ids])] for the first match in each of
    the shown sentences, and the number of matching sentences."""
    c = ws.corpus
    p = c.p
    n = len(sequence)
    wvars = [f'?w{i}' for i in range(n)]
    extra: List[Any] = []
    token_cons: List[Dict[str, Any]] = []
    for i, cond in enumerate(sequence):
        cons: Dict[str, Any] = {}
        for key, pat in cond.items():
            spec = rx(str(pat), regex=regex, whole=not regex)
            k = (key or '').lower()
            if k in ('form', 'word', 'baseline'):
                cons['value'] = spec
            elif k == 'morpheme':
                extra += [c.morph_form_clauses(f'?m{i}f', spec)] + c.in_word(f'?m{i}f', wvars[i], f'{i}f')
            elif k == 'type':
                extra += [c.morph(f'?m{i}t', metadata={'morphType': spec})] + c.in_word(f'?m{i}t', wvars[i], f'{i}t')
            else:
                f = p.field(key)
                if f.scope == 'Word':
                    extra += [c.span(f'?s{i}w', f.layer_id, value=spec), ['covers', f'?s{i}w', wvars[i]]]
                elif f.scope == 'Morpheme':
                    extra += [c.span(f'?s{i}m', f.layer_id, value=spec), ['covers', f'?s{i}m', f'?m{i}g']] \
                        + c.in_word(f'?m{i}g', wvars[i], f'{i}g')
                else:
                    raise ToolError(f'"{f.name}" is a sentence field; sequence conditions are per word')
        token_cons.append(cons)
    where: List[Any] = []
    if adjacent:
        seq: List[Any] = ['seq', {'layer': c.W}]
        for i, cons in enumerate(token_cons):
            if i:
                seq.append(_PUNCT_FILLER)
            seq.append(['token', cons, 'as', wvars[i]])
        where.append(seq)
    else:
        for i, cons in enumerate(token_cons):
            where.append(c.word(wvars[i], **cons))
            if i:
                where.append(['precedes*', wvars[i - 1], wvars[i]])
    where += extra
    where += [c.sent('?sent')] + [['within', v, '?sent'] for v in wvars]
    total = c.count(where, ['?sent'])
    order = [['?sent.doc'], ['?sent.begin']] + [[f'{v}.begin'] for v in wvars]
    rows = c.entities(where, ['?sent'] + wvars, limit * 4, order)
    out = []
    seen = set()
    loaded = set()
    for row in rows:
        sent = row[0]
        if not isinstance(sent, dict) or sent['id'] in seen:
            continue
        seen.add(sent['id'])
        if not c.may_load(sent['document'], loaded):
            break
        doc, s, _, _ = c.locate(sent['document'], sent['id'])
        if s is None:
            continue
        out.append((doc, s, [w['id'] for w in row[1:] if isinstance(w, dict)]))
        if len(out) >= limit:
            break
    return out, total


# --- lexicon_entry --------------------------------------------------------------------

def q_entry_usage(ws: Workspace, item_id: str, examples: int):
    """(word links, morpheme links, example lines) for one lexicon entry."""
    from .project import render_word, word_ref
    c = ws.corpus
    where = [['vocab', '?v', {}], ['=', '?v.id', item_id], ['vocab-link', '?t', '?v']]
    word_links = morph_links = 0
    for layer, n in c.group(where, ['?t.layer']):
        if layer == c.W:
            word_links += n
        elif layer == c.M:
            morph_links += n
    exs = []
    if examples:
        for row in c.entities(where, ['?t'], examples * 2, [['?t.doc'], ['?t.begin']]):
            ent = row[0]
            if not isinstance(ent, dict):
                continue
            doc, s, w, _ = c.locate(ent['document'], ent['id'])
            if w is None or any(e.endswith(f'|| {s.text}') and word_ref(s, w) in e for e in exs):
                continue
            exs.append(f'  {c.ws.doc_tag(doc)}{word_ref(s, w)} {render_word(w, p := c.p)[len(w.ref) + 1:]} || {s.text}')
            if len(exs) >= examples:
                break
    return word_links, morph_links, exs


def q_entry_links(ws: Workspace, item_id: str) -> List[Dict[str, str]]:
    """[{link_id, token_id}] for an entry: the documents its links live in
    are found by query and only those are loaded (link ids are not queryable)."""
    c = ws.corpus
    rows = c.entities([['vocab', '?v', {}], ['=', '?v.id', item_id], ['vocab-link', '?t', '?v']], ['?t'], ROW_LIMIT)
    doc_ids = list(dict.fromkeys(r[0]['document'] for r in rows if isinstance(r[0], dict)))
    out = []
    for did in doc_ids:
        doc = ws.doc(did)
        for s in doc.sentences:
            for w in s.words:
                if w.link and w.link.item_id == item_id:
                    out.append({'link_id': w.link.id, 'token_id': w.id})
                for m in w.morphemes:
                    if m.link and m.link.item_id == item_id:
                        out.append({'link_id': m.link.id, 'token_id': m.id})
    return out


# --- bulk plan tools -----------------------------------------------------------------

def _docs_of(rows: List[list]) -> set:
    return {e['document'] for r in rows for e in r if isinstance(e, dict) and e.get('document')}


def q_replace_in_field(ws: Workspace, f, rep, cap: int) -> List[Dict[str, Any]]:
    c = ws.corpus
    layer = c.scope_layer(f.scope)
    rows = c.entities([c.span('?s', f.layer_id), ['covers', '?s', '?t'], ['token', '?t', {'layer': layer}]],
                      ['?s', '?t'], cap + 1, [['?t.doc'], ['?t.begin']])
    budget = _docs_of(rows)
    staged = []
    for sp, tok in rows:
        if not (isinstance(sp, dict) and isinstance(tok, dict)):
            continue
        cur = ws.planned_span_value(f.layer_id, tok['id'], sp.get('value') or '')
        if cur == '':
            continue
        new = rep(cur)
        if new == cur:
            continue
        what = (tok.get('metadata') or {}).get('form') if f.scope == 'Morpheme' else None
        what = what or (tok.get('value') or '').strip()
        head = c.label_ref(tok['document'], tok['id'], budget)
        staged.append({'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': tok['id'], 'span_id': sp['id'],
                       'value': new, 'doc': tok['document'],
                       'label': f'{head} "{what[:30]}": {f.name} "{cur}" → "{new}"' + (' (cleared)' if new == '' else '')})
    return staged


def q_respell_all(ws: Workspace, rep, spec: Dict[str, Any], morpheme_forms: bool, cap: int):
    """(word respell ops, morpheme form ops) for every word the pattern hits."""
    from .tools import check_respell_overlap
    c = ws.corpus
    rows = c.entities([c.word('?t', value=spec)], ['?t'], cap + 1, [['?t.doc'], ['?t.begin']])
    budget = _docs_of(rows)
    words, morphs = [], []
    for (tok,) in rows:
        if not isinstance(tok, dict) or c.ignored(tok.get('value')):
            continue
        old = tok.get('value') or ''
        new = rep(old)
        if new == old:
            continue
        head = c.label_ref(tok['document'], tok['id'], budget)
        if not new.strip():
            raise ToolError(f'{head}: "{old}" would become empty; there is no delete-word tool')
        check_respell_overlap(ws, tok['text'], tok['begin'], tok['end'], head)
        words.append({'kind': 'respell', 'text_id': tok['text'], 'begin': tok['begin'], 'end': tok['end'], 'value': new,
                      'doc': tok['document'], 'label': f'{head}: respell "{old}" → "{new}"',
                      '_pos': (tok['document'], tok['begin'], 0, 0)})
    if morpheme_forms and c.M and words:
        mrows = c.entities([c.word('?w', value=spec), c.morph('?m', metadata={'form': spec})] + c.in_word('?m', '?w'),
                           ['?m', '?w'], cap + 1, [['?w.doc'], ['?w.begin'], ['?m.precedence']])
        for m, w in mrows:
            if not (isinstance(m, dict) and isinstance(w, dict)) or c.ignored(w.get('value')):
                continue
            old = (m.get('metadata') or {}).get('form') or ''
            new = rep(old)
            if new == old or not new.strip():
                continue
            head = c.label_ref(m['document'], m['id'], budget)
            morphs.append({'kind': 'set_morpheme_form', 'morpheme_id': m['id'], 'form': new, 'doc': m['document'],
                           'label': f'{head} (in "{w.get("value")}"): morpheme form "{old}" → "{new}"',
                           '_pos': (m['document'], m['begin'], 1, m.get('precedence') or 0)})
    # Interleave as the scan does: each word, then its morpheme forms.
    ordered = sorted(words + morphs, key=lambda op: op['_pos'])
    for op in ordered:
        op.pop('_pos', None)
    return ordered, len(words), len(morphs)


def q_copy_to_orthography(ws: Workspace, target: str, src: Optional[str], overwrite: bool, cap: int):
    c = ws.corpus
    where = [c.word('?t')]
    if not overwrite:
        where.append(['not', ['token', '?t', {'metadata': {f'orthog:{target}': {'regex': '.'}}}]])
    rows = c.entities(where, ['?t'], cap + 1, [['?t.doc'], ['?t.begin']])
    budget = _docs_of(rows)
    staged = []
    for (tok,) in rows:
        if not isinstance(tok, dict) or c.ignored(tok.get('value')):
            continue
        meta = tok.get('metadata') or {}
        cur = meta.get(f'orthog:{target}') or ''
        if cur and not overwrite:
            continue
        value = tok.get('value') if src is None else meta.get(f'orthog:{src}', '')
        if not value or value == cur:
            continue
        head = c.label_ref(tok['document'], tok['id'], budget)
        staged.append({'kind': 'set_orthography', 'word_id': tok['id'], 'key': f'orthog:{target}', 'value': value,
                       'doc': tok['document'], 'label': f'{head} "{tok.get("value") or ""}": {target} = "{value}"'})
    return staged


def q_set_field_for_form(ws: Workspace, form: str, f, value: str, only_empty: bool, cap: int):
    from .tools import span_op
    from .project import Span
    c = ws.corpus
    spec = rx(form, whole=True)
    if f.scope == 'Word':
        unit = [c.word('?u', value=spec)]
    else:
        unit = [c.morph_form_clauses('?u', spec)]
    with_span = [] if False else c.entities(unit + [c.span('?s', f.layer_id), ['covers', '?s', '?u']], ['?u', '?s'], cap + 1,
                                            [['?u.doc'], ['?u.begin']])
    without = c.entities(unit + [['not', c.span('?s', f.layer_id), ['covers', '?s', '?u']]], ['?u'], cap + 1,
                         [['?u.doc'], ['?u.begin']])
    rows = [(u, s) for u, s in with_span] + [(u, None) for (u,) in without]
    budget = _docs_of([[u] for u, _ in rows])
    staged = []
    for tok, sp in rows:
        if not isinstance(tok, dict):
            continue
        what = ((tok.get('metadata') or {}).get('form') if f.scope == 'Morpheme' else None) or tok.get('value') or ''
        old = Span(sp['id'], sp.get('value') or '', sp.get('metadata'), f.layer_id) if isinstance(sp, dict) else None
        cur = ws.planned_span_value(f.layer_id, tok['id'], old.value if old else '')
        if cur == value or (only_empty and cur != ''):
            continue
        head = c.label_ref(tok['document'], tok['id'], budget)
        op = {'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': tok['id'], 'span_id': old.id if old else None,
              'value': value, 'doc': tok['document'],
              'label': f'{head} "{what[:40]}": {f.name} '
                       + (f'"{old.value}" → "{value}"' if old and old.value != '' else f'= "{value}"')
                       + (' (cleared)' if value == '' else ''),
              '_pos': (tok['document'], tok['begin'], tok.get('precedence') or 0)}
        staged.append(op)
    staged.sort(key=lambda op: op['_pos'])
    for op in staged:
        op.pop('_pos', None)
    return staged


def q_analysis_targets(ws: Workspace, form: str, skip_analyzed: bool, cap: int):
    """Word occurrences of a form with their current morpheme chains (ids,
    precedence, span ids), without loading documents."""
    from .corpus import Unanalyzed
    c = ws.corpus
    where = [c.word('?w', value=rx(form, whole=True))]
    if skip_analyzed:
        where += Unanalyzed.clauses(c, '?w')
    rows = c.entities(where, ['?w'], cap + 1, [['?w.doc'], ['?w.begin']])
    words = [r[0] for r in rows if isinstance(r[0], dict) and not c.ignored(r[0].get('value'))]
    chains: Dict[str, List[dict]] = defaultdict(list)
    spans: Dict[str, List[str]] = defaultdict(list)
    if c.M and words:
        # Even an unanalyzed word carries its default morpheme, which the executor reuses.
        base = [c.word('?w', value=rx(form, whole=True))] + c.in_word('?m', '?w')
        for m, w in c.entities(base, ['?m', '?w'], ROW_LIMIT, [['?w.doc'], ['?w.begin'], ['?m.precedence']]):
            if isinstance(m, dict) and isinstance(w, dict):
                chains[w['id']].append(m)
        for sp, m in c.entities(base + [['span', '?s', {'layer': '?sl'}], ['covers', '?s', '?m']], ['?s', '?m'], ROW_LIMIT):
            if isinstance(sp, dict) and isinstance(m, dict):
                spans[m['id']].append(sp['id'])
    return words, chains, spans
