"""A replayed answer, marked.

A write sent under an Idempotency-Key whose request the server had already
run (its first answer was lost, and the client sent it again) is answered
from what that first send stored, with ``Idempotent-Replayed: true``, and
writes nothing. The client resends on its own (``retry_unknown``), so the
header never reaches the caller. It is marked on the answer instead: a dict
or list answer comes back as a subclass with ``replayed = True``, which reads,
compares and serializes as the plain one would. Only an answer with a JSON
object or list body can carry it. Imports nothing.
"""


class ReplayedDict(dict):
    """A dict answer that was replayed."""
    replayed = True


class ReplayedList(list):
    """A list answer that was replayed."""
    replayed = True


def mark_replayed(value):
    """``value`` marked as replayed, when it is a dict or a list."""
    if isinstance(value, dict):
        return ReplayedDict(value)
    if isinstance(value, list):
        return ReplayedList(value)
    return value


def was_replayed(answer):
    """Whether a client answer was replayed from its key's first send."""
    return isinstance(answer, (ReplayedDict, ReplayedList))
