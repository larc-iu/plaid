"""What both apps' corpus helpers share.

The engine will return only so many rows, and a report built on a read it cut
short is the top of an arbitrary prefix presented as the top of the corpus.
Worse, an empty clipped read reads as "nothing to do" for a corpus that may be
full of it. So every read records whether it was cut, and every report that
states a tally says so when one was.
"""

from typing import Any, Dict


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
