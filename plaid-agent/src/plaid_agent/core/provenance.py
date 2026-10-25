"""How a value's provenance shows in something the model reads.

The four provenance states are a cross-app convention (see the manual), and
so is the way a read marks them: a reader who cannot tell a parser's guess
from a person's decision cannot review either. The marks are one character so
they can ride along inside a dense rendering without turning every value into
a sentence.

The states themselves live in ``plaid_client.provenance``, and so do the
review and role rules. What is here is the reading of the states, and
:class:`Requester`, the user a turn or an approval acts for as those rules
see them.
"""

from typing import Optional

from plaid_client.provenance import prov_state, is_reviewed, MACHINE, CONTRIBUTED_STATE

from .tools import ToolError

UNVERIFIED = '~'    # after a value: machine-made, nobody has confirmed it
CONTRIBUTED = '^'   # after a value: a contributor's work, no verifier has reviewed it


class Requester:
    """The user a turn or an approval acts for. Whether they are an
    administrator is asked of the server once (a token may read its own
    user's record), and a read that fails answers no, so they then count by
    their listed role alone: a tool check then refuses, and the server
    decides anyway. ``strict`` raises the failure instead, for an approval,
    where the answer decides the stamp and a wrong no would stamp a reviewed
    administrator's work verified. ``user_id`` None (a script, a test) is
    nobody: not an administrator, not reviewed."""

    def __init__(self, client, user_id: Optional[str], strict: bool = False):
        self.client = client
        self.id = user_id
        self.strict = strict
        self._admin: Optional[bool] = None

    def is_admin(self) -> bool:
        if self.id is None:
            return False
        if self._admin is None:
            try:
                self._admin = bool((self.client.users.get(self.id) or {}).get('is_admin'))
            except Exception:  # noqa: BLE001 - unreadable: counted by role
                if self.strict:
                    raise
                self._admin = False
        return self._admin

    def reviewed(self, project) -> bool:
        """Whether their work is reviewed in ``project`` (its ``plaid.review``
        lists, by name or by role). An administrator with no role of their own
        counts as a maintainer, as everywhere else."""
        return bool(is_reviewed(project, self.id, is_admin=self.is_admin()))


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
                        f'made a value and are not part of it. Give the {what} itself.', kind='invalid-argument')
    return out
