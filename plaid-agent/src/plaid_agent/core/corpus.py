"""What both apps' corpus helpers share.

A corpus is too big to scan: a tool that loaded every document to answer a
question the query engine can answer would cost minutes and a great deal of
memory. So the corpus-wide tools ask the engine, and load documents only to
render the handful of hits they are going to print. :class:`Corpus` is the
engine bound to one workspace: how a query runs, how a pattern is written, and
the three shapes of answer.

The engine will return only so many rows, and a report built on a read it cut
short is the top of an arbitrary prefix presented as the top of the corpus.
Worse, an empty clipped read reads as "nothing to do" for a corpus that may be
full of it. So every read records whether it was cut, and every report that
states a tally says so when one was.
"""

import math
import re
from typing import Any, Dict, List, Tuple

from .limits import GROUP_LIMIT, ROW_LIMIT
from .tools import ToolError


class Clipping:
    """Whether the engine cut short any read a tool has made.

    Two flags, and the difference matters. ``truncated`` is the LAST read, for
    a caller deciding whether that one read can be trusted. ``clipped`` is
    every read since :meth:`forget_clipping`, which is what a report has to
    answer for: these tools run several queries and the narrow ones come last,
    so the last read's flag says nothing about the tally the numbers came
    from.
    """

    def __init__(self):
        self.truncated = False
        self._clipped = False

    def note_truncation(self, res: Dict[str, Any]) -> None:
        self.truncated = bool(res.get('truncated'))
        self._clipped = self._clipped or self.truncated

    def forget_clipping(self) -> None:
        """Forget whether earlier reads were clipped. Called once per tool
        call, so a report answers for its own reads and not the turn's."""
        self._clipped = False

    @property
    def clipped(self) -> bool:
        return self._clipped

    def clipped_note(self, what: str = 'values') -> str:
        """A line to append when ANY read since :meth:`forget_clipping` hit
        the engine's row limit, and nothing at all when none did."""
        if not self._clipped:
            return ''
        return (f'\n(note) The engine returned as many rows as it will, so these {what} come '
                f'from part of the corpus and not all of it. Narrowing it to one document or '
                f'one field gives a complete answer.')


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


class Spread:
    """Which documents a corpus-wide read shows hits from, and how many each
    may show. What :func:`spread` returns; iterating it gives
    ``(document id, how many of its hits may be shown)``.
    """

    def __init__(self, picks: List[Tuple[str, int]], per_doc: int, documents: int):
        self.picks = picks
        #: The cap every picked document shares, for a caller that renders
        #: rows rather than counting them.
        self.per_doc = per_doc
        #: How many documents have hits at all, which is what a read says when
        #: it shows fewer.
        self.documents = documents

    def __iter__(self):
        return iter(self.picks)

    def __len__(self) -> int:
        return len(self.picks)

    @property
    def ids(self) -> List[str]:
        return [did for did, _quota in self.picks]


def spread(docs: List[tuple], limit: int, budget: int) -> Spread:
    """Which documents a corpus-wide read loads, and how many hits each may
    show: a few from each of several, not thirty from the one with the most.

    ``docs`` is ``[(document id, hits)]`` as the engine ranked it, most first,
    and ``budget`` is the app's ``RENDER_DOC_BUDGET`` (a hit costs a different
    amount to render in each app, so the budget is the app's own).

    Taking documents off the top until the limit was full showed every hit
    from one blog post and called it the corpus. The picks are evenly spaced
    down the ranked list instead: the documents with the most hits are the
    largest documents, which cost the most to load (the twelve largest in EWT
    took nine seconds) and are one kind of text. Loading a document is one
    round trip, so how many each may show is capped as well.
    """
    if not docs:
        return Spread([], max(1, int(limit)), 0)
    if len(docs) > budget:
        chosen = [docs[i * len(docs) // budget] for i in range(budget)]
    else:
        chosen = list(docs)
    per_doc = max(1, math.ceil(limit / len(chosen)))
    return Spread([(did, min(int(n or per_doc), per_doc)) for did, n in chosen],
                  per_doc, len(docs))


def query_refused(e: Exception) -> ToolError:
    """The engine's own complaint, for the model to read and correct."""
    msg = str(e)
    m = re.search(r'"error"\s*:\s*"([^"]+)"', msg)
    return ToolError('Query rejected: ' + (m.group(1) if m else msg[:400]))


class Corpus(Clipping):
    """The query engine bound to one workspace (its client, its project).

    An app subclasses this with the clauses that name what IT annotates. The
    three shapes of answer are here: a count, entity rows, and grouped tallies.
    """

    def __init__(self, ws):
        super().__init__()
        self.ws = ws
        self.p = ws.project

    # --- running ----------------------------------------------------------

    def run(self, body: Dict[str, Any]) -> Dict[str, Any]:
        body = dict(body)
        body['scope'] = {'project_ids': [self.p.id]}
        try:
            res = self.ws.client.query(body)
        except Exception as e:  # noqa: BLE001 - the model gets the engine's own message
            raise query_refused(e)
        return res if isinstance(res, dict) else {}

    def count(self, where: List[Any], find: List[str]) -> int:
        """Distinct tuples of ``find`` (never inflated by joins)."""
        return int(self.run({'find': find, 'where': where, 'return': 'count'}).get('count') or 0)

    def entities(self, where: List[Any], find: List[str], limit: int, order_by=None) -> List[list]:
        """Entity rows, ``limit`` at most."""
        body: Dict[str, Any] = {'find': find, 'where': where, 'return': 'entities',
                                'limit': min(int(limit), ROW_LIMIT)}
        if order_by:
            body['order_by'] = order_by
        res = self.run(body)
        self.note_truncation(res)
        return res.get('results') or []

    def group(self, where: List[Any], group: List[str], aggregates=None,
              limit: int = GROUP_LIMIT) -> List[list]:
        """Grouped rows ``[key..., count]``. Whether the read was cut short is
        remembered on the instance for callers that have to say so."""
        res = self.run({'where': where, 'limit': limit,
                        'return': {'group': group, 'aggregates': aggregates or [['count']]}})
        self.note_truncation(res)
        return res.get('results') or []

    # --- documents --------------------------------------------------------

    def doc_names(self) -> Dict[str, str]:
        return {d['id']: d.get('name') or d['id'] for d in self.ws.documents()}

    def doc_name(self, doc_id: str) -> str:
        return self.doc_names().get(doc_id, doc_id)

    def documents_with(self, where: List[Any], var: str = '?s') -> List[tuple]:
        """[(document id, hits)] for a constraint, most hits first."""
        rows = [(row[0], row[-1]) for row in self.group(where, [f'{var}.doc']) if row[0]]
        return sorted(rows, key=lambda r: -r[1])
