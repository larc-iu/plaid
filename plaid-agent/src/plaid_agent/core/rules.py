"""Rule-shaped plans: one stored change that stands for many.

A rule is a corpus-wide tool call kept as the tool and its arguments, how
many changes it makes, where, and a digest of what it matched. It is expanded
into per-entity writes only at approval, by the service, with the same
function that previewed it (each app's scope resolver). The card shows the
rule, its total, the count in each document and a sample, and a settled plan
keeps that row, which is the whole record of what the rule proposed.

What the stored op carries beside the app's own scope keys
(``tool``, ``args``, ``count``, ``counts``, ``documents``):

``matched``   one ``[document id, changes there, digest]`` per document the
              rule changes, sorted by id. The digest is of every change there
              as ``(target, change, replaces a person's work)``, so a value
              edited, verified, added or removed since staging changes it.
              At approval the rule is resolved again and :func:`check_matched`
              refuses the whole plan when anything differs (Luke's ruling,
              2026-10-08), naming what the rule matched then and matches now.
``change``    the rule in the user's words (``"VASP" → "ASP" in Field``), for
              that refusal and for the card.

A document reached only by rules is recorded on the plan with ``rule: true``
and no sentences: its version may move, since the digest decides.

The card row (:func:`card`) is ``changes[i]`` with one more key, ``rule``:
the tool, its arguments, the total, the count per kind, every document up to
:data:`DOCUMENTS_MAX` largest first with its count (``documents_more`` says
what the rest hold), and :data:`SAMPLE_LINES` changes taken evenly down the
ranked documents, those replacing a person's work first, each an ordinary
card row with its place. A settled plan keeps it whole: it is never cut by
the settled-row cap.
"""

from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from . import fingerprint as fp
from . import opkind
from .limits import PLAN_MAX_CHANGES, PLAN_MAX_DOCUMENTS, SAMPLE_LINES
from .plan import PlanOutOfDate, change_of

#: The key on a card row that makes it a rule's row.
RULE = 'rule'

#: Documents a rule's card row lists by name. The rest are counted.
DOCUMENTS_MAX = 200

#: Documents one refusal names before "and n more".
REASON_DOCUMENTS = 3


def is_rule(op: Dict[str, Any]) -> bool:
    """Whether a stored op is a rule (a scope staged with what it matched)."""
    return isinstance(op, dict) and isinstance(op.get('matched'), list)


def normalize(args: Dict[str, Any], flags: Sequence[str] = ()) -> Dict[str, Any]:
    """A rule's arguments as stored: each of ``flags`` a boolean, an empty
    string or a missing value as None, so the same rule asked twice is one
    stored op (its target is its tool and these)."""
    out = {}
    for k, v in args.items():
        if k in flags:
            out[k] = bool(v)
        elif v == '':
            out[k] = None
        else:
            out[k] = v
    return out


def fingerprint_args(args: Dict[str, Any]) -> str:
    return fp.fingerprint(args or {})


def target(op: Dict[str, Any]) -> tuple:
    """What a rule writes to, for last-wins replacement in a plan: the tool and
    its arguments."""
    return ('rule', op.get('tool'), fingerprint_args(op.get('args') or {}))


# --- what a rule matched ---------------------------------------------------------

def _fact(reg, op: Dict[str, Any], replaces: Callable[[Dict[str, Any]], int]) -> list:
    """One change as the digest reads it: what it writes to, the change as the
    card says it (the value as found and the new one), and whether it
    replaces a person's work. Its place in the document is left out, so text
    typed into another sentence does not move it."""
    change = change_of(op)
    if change is None:
        change = op.get('label') or ''
    return [repr(opkind.target_of(reg, op)), change, int(replaces(op) or 0)]


def matched(reg, ops: Iterable[Dict[str, Any]], doc_of: Callable[[Dict[str, Any]], Optional[str]],
            replaces: Callable[[Dict[str, Any]], int]) -> List[list]:
    """``[[document id, changes, digest], ...]`` for what a rule resolved to,
    sorted by document id. A change outside any document counts under None."""
    by: Dict[Any, List[list]] = {}
    for op in ops:
        by.setdefault(doc_of(op), []).append(_fact(reg, op, replaces))
    return [[d, len(facts), fp.fingerprint(sorted(facts))]
            for d, facts in sorted(by.items(), key=lambda kv: (kv[0] is None, kv[0] or ''))]


def total(op: Dict[str, Any]) -> int:
    return int(op.get('count') or 0)


def _plural(n: int, one: str, many: str) -> str:
    return f'{n:,} {one if n == 1 else many}'


def check_matched(op: Dict[str, Any], now: List[list], name_of: Callable[[str], str]) -> None:
    """Refuse the plan when a rule matches anything other than it did when
    it was staged: another document, another count, another value, or a value
    whose provenance changed. Raises :class:`PlanOutOfDate` with a sentence
    naming the rule, what it matched then and now, and where."""
    then = {d: (n, digest) for d, n, digest in op.get('matched') or []}
    nowd = {d: (n, digest) for d, n, digest in now}
    if then == nowd:
        return
    raise PlanOutOfDate([moved_reason(op, then, nowd, name_of)])


def moved_reason(op: Dict[str, Any], then: Dict[Any, tuple], now: Dict[Any, tuple],
                 name_of: Callable[[str], str]) -> str:
    """The refusal in the user's words: ``"VASP" → "ASP" in Field now matches
    1,180 places in 17 documents, not the 1,171 shown when it was planned (9
    more in "Text 4")``."""
    what = op.get('change') or op.get('label') or 'A change over the whole project'
    t_then = sum(n for n, _ in then.values())
    t_now = sum(n for n, _ in now.values())
    docs_now = len([d for d in now if d is not None])
    places = []
    for d in sorted(set(then) | set(now), key=lambda d: -abs(now.get(d, (0, ''))[0] - then.get(d, (0, ''))[0])):
        a, b = then.get(d, (0, None)), now.get(d, (0, None))
        if a == b:
            continue
        where = f'"{name_of(d)}"' if d is not None else 'outside any document'
        if b[0] > a[0]:
            places.append(f'{b[0] - a[0]:,} more in {where}')
        elif b[0] < a[0]:
            places.append(f'{a[0] - b[0]:,} fewer in {where}')
        else:
            places.append(f'other values in {where}')
    shown = places[:REASON_DOCUMENTS]
    if len(places) > REASON_DOCUMENTS:
        rest = len(places) - REASON_DOCUMENTS
        shown.append(f'and {_plural(rest, "more document", "more documents")}')
    detail = f' ({", ".join(shown)})' if shown else ''
    if t_now == t_then:
        return (f'{what} now matches other values than the {t_then:,} shown when it was '
                f'planned{detail}')
    return (f'{what} now matches {_plural(t_now, "place", "places")} in '
            f'{_plural(docs_now, "document", "documents")}, not the {t_then:,} shown when it was '
            f'planned{detail}')


# --- what a plan may hold ----------------------------------------------------------

def changes_in(reg, ops: Iterable[Dict[str, Any]]) -> int:
    """How many changes a plan stands for once expanded: a rule or a folded
    group counts its members, any other op one."""
    n = 0
    for op in ops:
        spec = reg.get(op.get('kind'))
        n += opkind.stored_count(spec, op) if spec is not None else 1
    return n


def documents_in(ops: Iterable[Dict[str, Any]]) -> set:
    from .plan import docs_of_op
    out: set = set()
    for op in ops:
        out |= docs_of_op(op)
        if op.get('doc'):
            out.add(op['doc'])
        out.update(d for d in ((op.get('items') or {}).get('doc') or []) if d)
    out.discard(None)
    return out


def too_many(reg, ops: List[Dict[str, Any]], adding: int = 0, documents: Iterable[str] = ()) -> Optional[str]:
    """Why a plan holding ``ops`` and ``adding`` more changes over
    ``documents`` would be more than one plan may hold, or None.
    :data:`PLAN_MAX_CHANGES` bounds the writes approval makes,
    :data:`PLAN_MAX_DOCUMENTS` the documents it holds locked while it runs."""
    n = changes_in(reg, ops) + adding
    if n > PLAN_MAX_CHANGES:
        return (f'That would bring the plan to {n:,} changes, more than the {PLAN_MAX_CHANGES:,} one plan '
                f'may make. Narrow it (a document, a stricter pattern) and go in passes, or let the user '
                f'approve what is planned first.')
    docs = documents_in(ops) | set(documents or ())
    if len(docs) > PLAN_MAX_DOCUMENTS:
        return (f'That would bring the plan to {len(docs):,} documents, more than the {PLAN_MAX_DOCUMENTS} '
                f'one plan may reach. Go in passes by document.')
    return None


def too_big(ops: List[Dict[str, Any]], documents: Sequence[str]) -> Optional[str]:
    """Why a stored plan may not be applied, asked at approval: more changes
    once its rules are expanded than :data:`PLAN_MAX_CHANGES`, or more
    documents to hold than :data:`PLAN_MAX_DOCUMENTS`. None when it fits."""
    n = sum(int(op.get('count') or 1) if (op.get('compact') or is_rule(op)) else 1
            for op in ops if isinstance(op, dict))
    if n > PLAN_MAX_CHANGES:
        return f'The plan makes {n:,} changes, more than the {PLAN_MAX_CHANGES:,} one plan may make.'
    if len(documents) > PLAN_MAX_DOCUMENTS:
        return f'The plan reaches {len(documents):,} documents, more than the {PLAN_MAX_DOCUMENTS} one plan may reach.'
    return None


# --- the card row ----------------------------------------------------------------

def ranked(counts: Dict[str, int]) -> List[Tuple[str, int]]:
    """Documents largest first, then by id, so every reader ranks alike."""
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0] or ''))


def sample(ops: List[Dict[str, Any]], doc_of: Callable[[Dict[str, Any]], Optional[str]],
           replaces: Callable[[Dict[str, Any]], int], n: int = SAMPLE_LINES) -> List[Dict[str, Any]]:
    """``n`` of a rule's changes to show: those replacing a person's work
    first, then taken evenly down the documents ranked by how many changes
    each holds, a few from each, never a run from the largest alone."""
    if len(ops) <= n:
        return list(ops)
    by: Dict[Any, List[Dict[str, Any]]] = {}
    for op in ops:
        by.setdefault(doc_of(op), []).append(op)
    order = [d for d, _ in ranked({d: len(v) for d, v in by.items()})]
    flagged = [op for op in ops if replaces(op)][:n]
    picked = list(flagged)
    seen = {id(op) for op in picked}
    if len(picked) < n:
        # Every k-th document of the ranking, one change at a time, until
        # enough are taken.
        step = max(1, len(order) // (n - len(picked)))
        cursors = {d: 0 for d in order}
        while len(picked) < n:
            took = False
            for d in order[::step] + [d for i, d in enumerate(order) if i % step]:
                rows = by[d]
                while cursors[d] < len(rows) and id(rows[cursors[d]]) in seen:
                    cursors[d] += 1
                if cursors[d] < len(rows):
                    op = rows[cursors[d]]
                    picked.append(op)
                    seen.add(id(op))
                    cursors[d] += 1
                    took = True
                    if len(picked) >= n:
                        break
            if not took:
                break
    keep = {id(op) for op in picked}
    return [op for op in ops if id(op) in keep]


def card(op: Dict[str, Any], found: List[Dict[str, Any]], doc_of: Callable[[Dict[str, Any]], Optional[str]],
         name_of: Callable[[str], str], describe: Callable[[Dict[str, Any]], Dict[str, Any]],
         replaces: Callable[[Dict[str, Any]], int]) -> Dict[str, Any]:
    """The ``rule`` of a rule's card row, built from what it resolved to when
    it was staged. ``describe(change)`` is the app's card row for one change,
    for the sample."""
    counts: Dict[str, int] = {}
    for o in found:
        d = doc_of(o)
        if d is not None:
            counts[d] = counts.get(d, 0) + 1
    order = ranked(counts)
    rest = order[DOCUMENTS_MAX:]
    return {'tool': op.get('tool'), 'args': op.get('args') or {}, 'total': len(found),
            'kinds': dict(op.get('counts') or {}),
            'documents': [[d, name_of(d), n] for d, n in order[:DOCUMENTS_MAX]],
            'documents_more': [len(rest), sum(n for _, n in rest)],
            'sample': [describe(o) for o in sample(found, doc_of, replaces)]}


def count_line(n: int, unit: Tuple[str, str], documents: int) -> str:
    """``1,240 values in 12 documents``."""
    return f'{_plural(n, *unit)} in {_plural(documents, "document", "documents")}'
