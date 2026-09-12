"""Corpus-wide reads, through the query engine.

A treebank is too big to scan: EWT is 1172 documents, and a tool that loaded
them all to answer "how many AUX" would cost minutes and a great deal of
memory for a number the engine has. So the corpus-wide tools ask the engine,
and only load the documents whose hits they are actually going to print.

Two things about the engine (v0) that shape everything here:

* a span is joined to its token with ``['covers', '?span', '?token']``. A span
  clause itself takes only ``doc``, ``layer``, ``metadata`` and ``value``.
* ``order_by`` is REFUSED with an aggregate return, so a grouped result comes
  back unordered and is sorted here. That is why the group limit is high: the
  whole group set has to arrive for the top of it to be the real top.
"""

import re
from typing import Any, Dict, List, Optional

from .project import UdProject
from .tools import ToolError, Workspace

GROUP_LIMIT = 100000    # the engine's backstop for group rows
ROW_LIMIT = 100000      # the engine's hard cap for ids and entities
DOCS_PER_SEARCH = 12    # documents one search will load to print its hits


def rx(pattern: str, *, regex: bool = False, whole: bool = False,
       case_sensitive: bool = False) -> Dict[str, Any]:
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
    """Query helpers bound to one workspace."""

    def __init__(self, ws: Workspace):
        self.ws = ws
        self.p: UdProject = ws.project
        self.truncated = False

    # --- running ---------------------------------------------------------

    def run(self, body: Dict[str, Any]) -> Dict[str, Any]:
        body = dict(body)
        body['scope'] = {'project_ids': [self.p.id]}
        try:
            res = self.ws.client.query(body)
        except Exception as e:  # noqa: BLE001 - the model gets the engine's own message
            raise _err(e)
        return res if isinstance(res, dict) else {}

    def entities(self, where: List[Any], find: List[str], limit: int, order_by=None) -> List[list]:
        """Entity rows, ``limit`` at most."""
        body: Dict[str, Any] = {'find': find, 'where': where, 'return': 'entities',
                                'limit': min(int(limit), ROW_LIMIT)}
        if order_by:
            body['order_by'] = order_by
        res = self.run(body)
        self.truncated = bool(res.get('truncated'))
        return res.get('results') or []

    def count(self, where: List[Any], find: List[str]) -> int:
        return int(self.run({'find': find, 'where': where, 'return': 'count'}).get('count') or 0)

    def group(self, where: List[Any], group: List[str], limit: int = GROUP_LIMIT) -> List[list]:
        """Grouped rows ``[key..., count]``, sorted here by count descending
        because the engine will not order an aggregate."""
        res = self.run({'where': where, 'limit': limit,
                        'return': {'group': group, 'aggregates': [['count']]}})
        self.truncated = bool(res.get('truncated'))
        return sorted(res.get('results') or [], key=lambda r: -r[-1])

    def clipped_note(self, what: str = 'values') -> str:
        """A line to append when the LAST read hit the engine's row limit.

        `group` and `entities` record `truncated` and nothing read it, so a
        "commonest" list was the top of an arbitrary prefix stated as the top
        of the corpus. Read it straight after the call: the Corpus is cached
        for the whole turn, so the flag belongs to the most recent read only.
        """
        if not self.truncated:
            return ''
        return (f'\n(note) The engine returned as many rows as it will, so these {what} come '
                f'from part of the corpus and not all of it. Narrowing it to one document or '
                f'one field gives a complete answer.')

    # --- clauses ----------------------------------------------------------

    def word(self, var: str = '?t', **c) -> list:
        """A syntactic word: the token every annotation hangs on."""
        return ['token', var, {'layer': self.p.word_layer_id, **c}]

    def field(self, name: str, var: str = '?s', **c) -> list:
        return ['span', var, {'layer': self.p.layer(name), **c}]

    def on(self, span_var: str, word_var: str = '?t') -> list:
        """The span sits on that word."""
        return ['covers', span_var, word_var]

    def dep(self, var: str = '?r', **c) -> list:
        return ['relation', var, {'layer': self.p.relation_layer_id, **c}]

    def unconfirmed(self, span_var: str = '?s') -> list:
        """A value a machine made that nobody has confirmed."""
        return ['not', ['span', span_var, {'metadata': {'provConfirmed': True}}]]

    # --- forms ----------------------------------------------------------
    #
    # A word's FORM is its token's surface text, unless a Form span overrides
    # it, which is what the parts of a multi-word token have ("al" is one
    # token, "a" and "el" are its Form spans). The engine does not know that
    # rule, but it knows both halves: the surface of every token WITHOUT a
    # Form span, and every Form span's value. Together they are the forms
    # exactly. Before this the form tools read twelve documents by name and
    # called it the corpus.

    def no_form_span(self, tok: str = '?t') -> list:
        return ['not', ['span', '?f', {'layer': self.p.layer('form')}], ['covers', '?f', tok]]

    def _merged_groups(self, first: List[list], second: List[list]) -> List[list]:
        """Two grouped results with the same key shape, summed by key and
        sorted by count. `truncated` covers both reads."""
        first_truncated = self.truncated
        counts: Dict[tuple, int] = {}
        for rows in (first, second):
            for row in rows:
                key = tuple(row[:-1])
                counts[key] = counts.get(key, 0) + int(row[-1] or 0)
        self.truncated = self.truncated or first_truncated
        return sorted([list(k) + [n] for k, n in counts.items()], key=lambda r: -r[-1])

    def form_documents(self, spec: Dict[str, Any]) -> List[tuple]:
        """[(document id, hits)] for forms matching ``spec``, most hits first."""
        surface = self.group([self.word('?t', value=spec), self.no_form_span('?t')], ['?t.doc'])
        spans = self.group([self.field('form', '?f', value=spec)], ['?f.doc'])
        return [(row[0], row[-1]) for row in self._merged_groups(surface, spans) if row[0]]

    def form_values(self) -> List[list]:
        """[[form, count]] over the corpus."""
        surface = self.group([self.word('?t'), self.no_form_span('?t')], ['?t.value'])
        spans = self.group([self.field('form', '?f')], ['?f.value'])
        return self._merged_groups(surface, spans)

    def form_lemma_pairs(self) -> List[list]:
        """[[form, lemma, count]] over the corpus."""
        surface = self.group([self.word('?t'), self.no_form_span('?t'),
                              self.field('lemma', '?l'), self.on('?l')], ['?t.value', '?l.value'])
        spans = self.group([self.word('?t'), self.field('form', '?f'), self.on('?f'),
                            self.field('lemma', '?l'), self.on('?l')], ['?f.value', '?l.value'])
        return self._merged_groups(surface, spans)

    # --- size -------------------------------------------------------------

    def sizes(self) -> Dict[str, int]:
        """How much corpus there is: sentences and words."""
        return {'sentences': self.count([['token', '?s', {'layer': self.p.sentence_layer_id}]], ['?s']),
                'words': self.count([self.word('?t')], ['?t'])}

    # --- documents --------------------------------------------------------

    def documents_with(self, where: List[Any], var: str = '?s') -> List[tuple]:
        """[(document id, hits)] for a constraint, most hits first."""
        return [(row[0], row[-1]) for row in self.group(where, [f'{var}.doc']) if row[0]]

    def doc_name(self, document_id: str) -> str:
        for d in self.ws.documents():
            if d['id'] == document_id:
                return d.get('name') or document_id
        return document_id
