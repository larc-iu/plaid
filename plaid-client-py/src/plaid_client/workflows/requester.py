"""Who asked for a service run, named in what the run leaves behind.

A plain service writes with its own token, so the History entry of a run
reads "by <operator> (via <token>)" and the person who pressed the button is
recorded nowhere. Core tells every service who asked (``requester_id`` in the
request data), and the owner's ruling (umr-collab-service-requester) is that
every app's services put that person in the History label and in what they
store::

    AnCast adjudication against lunch, requested by second

This is the one place that wording and the stored key are decided, for every
service in every app. The JS twin is ``requesterOf`` in plaid-client-js.

The name is the requester's display name, which any signed-in user may read.
When it cannot be read the id stands in for it, and with no requester at all
(a run started outside a service request, a test) the label is left as it
was and nothing is stored.
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)

#: The key a run's stored record names its requester under: a report's
#: ``requestedBy: {id, name}``, a machine stamp's ``provDetail.requestedBy``.
REQUESTED_BY = 'requestedBy'


@dataclass(frozen=True)
class Requester:
    """The person who asked for one run. ``id`` is their account (their
    email), ``name`` how they are shown. Both are None when nobody asked."""

    id: Optional[str] = None
    name: Optional[str] = None

    def label(self, text: str) -> str:
        """A History label with the requester named: ``"<text>, requested by
        <name>"``, or ``text`` itself when nobody asked."""
        return f'{text}, requested by {self.name}' if self.name else text

    def record(self) -> Optional[Dict[str, str]]:
        """``{id, name}`` for a stored report, or None when nobody asked."""
        return {'id': self.id, 'name': self.name} if self.id else None

    def detail(self, detail: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """A machine stamp's ``provDetail`` with the requester's id added
        under ``requestedBy``. The id, not the name: a display name changes,
        and the stamp is kept for good."""
        out = dict(detail or {})
        if self.id:
            out[REQUESTED_BY] = self.id
        return out


def requester_of(client, request_data: Optional[Dict[str, Any]]) -> Requester:
    """The requester of one request, from the ``requester_id`` core put in
    its data, with their display name read through ``client``."""
    user_id = (request_data or {}).get('requester_id') if isinstance(request_data, dict) else None
    if not user_id:
        return Requester()
    name = None
    try:
        user = client.users.get(user_id)
        name = (user or {}).get('display_name')
    except Exception as exc:
        # The id is always there to fall back on, so a failed read costs the
        # label nothing but the nicer name.
        log.warning('Could not read the requester %s: %s', user_id, exc)
    return Requester(id=user_id, name=name or user_id)
