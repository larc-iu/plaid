"""How a value's provenance shows in something the model reads.

The four provenance states are a cross-app convention (see the manual), and
so is the way a read marks them: a reader who cannot tell a parser's guess
from a person's decision cannot review either. The marks are one character so
they can ride along inside a dense rendering without turning every value into
a sentence.

The states themselves live in ``plaid_client.provenance``. What is here is
only the reading of them.
"""

from plaid_client.provenance import prov_state, MACHINE, CONTRIBUTED_STATE

from .tools import ToolError

UNVERIFIED = '~'    # after a value: machine-made, nobody has confirmed it
CONTRIBUTED = '^'   # after a value: a contributor's work, no verifier has reviewed it
REVIEWABLE = (MACHINE, CONTRIBUTED_STATE)


def review_mark(metadata) -> str:
    """The mark a value carries in a read: ``~`` for unconfirmed machine
    output, ``^`` for a contributor's unreviewed work, nothing otherwise."""
    state = prov_state(metadata)
    return UNVERIFIED if state == MACHINE else CONTRIBUTED if state == CONTRIBUTED_STATE else ''


def mark(value: str, metadata) -> str:
    """``value`` with its review mark appended."""
    return value + review_mark(metadata)


#: Every mark a read appends after a value.
READ_MARKS = (UNVERIFIED, CONTRIBUTED)


def unmark(value, what: str = 'value'):
    """A value the model wrote, with the review mark a read appended to it
    taken off: the marks are display only, and a value copied back from a
    read ("NOUN~", "Ali^") is the value without them. Only one mark, at the
    very end (trailing space aside), is a read's, so nothing else is touched.
    A value that is nothing but a mark is refused. Every tool that writes a
    value the reads mark passes it through here, at the tool boundary."""
    if not isinstance(value, str):
        return value
    body = value.rstrip()
    if not body or body[-1] not in READ_MARKS:
        return value
    out = body[:-1]
    if not out.strip():
        raise ToolError(f'"{value}" is only a review mark: {UNVERIFIED} and {CONTRIBUTED} in a read say who '
                        f'made a value and are not part of it. Give the {what} itself.')
    return out
