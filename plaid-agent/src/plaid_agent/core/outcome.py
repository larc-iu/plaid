"""What an approval's run came to, as one value: applied with its counts, or
refused (out of date, stopped, failed, partly applied), which the approval
settles on the record and says to the user in one place once the documents'
locks are released. The tally of a plan that stopped partway is worked out
here, from the plan's ops and the error that stopped it."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import rules
from .conversation import partial_note, partial_tally


@dataclass(frozen=True)
class Outcome:
    """How an approval's run ended.

    ``counts``: applied, the per-kind counts of what was written (with
    ``notes`` and ``unwritten`` as the executor gives them). Otherwise the
    plan is settled as ``status`` (None leaves it undecided and only clears
    the marker) with ``note`` and ``fields``, after ``forget`` drops what a
    run that wrote nothing held, and the user is told ``message``: as a
    partly applied answer with ``written`` changes when that is given, else
    as an error. ``moved_on`` words the message from the record as it is once
    settled (`approval._moved_on`). ``failure``: the run failed, and is
    worded as one of the others once settled."""

    counts: Optional[Dict[str, Any]] = None
    status: Optional[str] = None
    note: Optional[str] = None
    message: str = ''
    forget: bool = False
    fields: Dict[str, Any] = field(default_factory=dict)
    written: Optional[int] = None
    moved_on: bool = False
    failure: Optional[BaseException] = None

    @classmethod
    def applied(cls, counts: Dict[str, Any]) -> 'Outcome':
        return cls(counts=counts)

    @classmethod
    def failed(cls, e: BaseException) -> 'Outcome':
        """A run that failed: worded once the locks are released
        (`Approving._failed`), since that reads the documents' names."""
        return cls(failure=e)

    @classmethod
    def refused(cls, message: str = '', status: Optional[str] = None, note: Optional[str] = None,
                forget: bool = False, moved_on: bool = False, **fields) -> 'Outcome':
        return cls(status=status, note=note, message=message, forget=forget, fields=fields, moved_on=moved_on)


def _sentence(text: str) -> str:
    """A note as a sentence of its own on screen, where a semicolon run of
    them read as one long clause."""
    text = str(text).strip()
    return text[:1].upper() + text[1:] + ('' if text.endswith('.') else '.')


def partly_applied(ops: List[Dict[str, Any]], e, why: str) -> Outcome:
    """A plan that stopped partway after writing some of it (``e``, a
    :class:`core.plan.PlanError` that wrote), settled as partly applied (Luke's
    ruling Q4): no Approve that cannot work, the card marks the changes
    written in full, and the model is told which, so the user asks it to
    finish. ``why`` is the failure as the clause after "Failed to apply the
    plan:". The count is of the card's rows: `applied` counts batch calls,
    and one change can be several."""
    done = list(e.written or [])
    labels = [op.get('label') or '' for op in ops]
    # A row that folds many changes ("dep on 600 words") counts
    # each of them, written or not, so a row cut short by the
    # failure says "400 of 600", not "0 of 1".
    sizes = [int(op.get('count') or 1) if op.get('compact') or rules.is_rule(op) else 1 for op in ops]
    parts = {i: n for i, n in (e.members or {}).items() if 0 <= i < len(ops) and i not in done}
    written_n = sum(sizes[i] for i in done if 0 <= i < len(ops)) + sum(parts.values())
    # A row another service wrote in part (a parse that stopped
    # partway) has no count here: its own message says how much.
    partly = sorted({i for i in e.partly if 0 <= i < len(ops) and i not in done and i not in parts})
    note = partial_note(labels, done, e.unknown, why,
                        parts={i: (n, sizes[i]) for i, n in parts.items()},
                        sizes=sizes, partly=partly)
    # The count as the card says it, kept on the record for
    # whatever shows the plan later (an exported conversation).
    outcome = f'{partial_tally(written_n, sum(sizes), len(partly))}.'
    # A row another service wrote in part and counted (a parse
    # that stopped partway) is said in its count, kept on the
    # record too (Luke 2026-10-16).
    count = e.partly_count if len(partly) == 1 else None
    if count:
        n, of, unit = count
        outcome = (f'Written in part: {n} of {of} {unit}.' if not written_n
                   else f'{partial_tally(written_n, sum(sizes), 1)} ({n} of {of} {unit}).')
    fields = {'written': done, 'outcome': outcome, **({'unknown': True} if e.unknown else {}),
              **({'in_part': list(count)} if count else {})}
    said = (f'Partly applied{". " if count and not written_n else ": "}{outcome} '
            + ('The server did not answer for the rest.' if e.unknown else _sentence(why)))
    return Outcome(status='partial', note=note, message=said, fields=fields, written=written_n)
