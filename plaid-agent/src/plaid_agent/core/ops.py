"""What the page may ask of a conversation, and the rules the service holds
each request to (design/SINGLE-WRITER.md in the polish campaign, Luke's
rulings of 2026-10-09).

The service is the only writer of a conversation record. The page sends a
request naming an ``op`` and the tab it was sent from:

``send``     text, where, files, projects, create: append the user's message and answer it
``retry``    send the last message again, after the attempt that did not finish
``approve``  plan_id, as_human: apply a plan
``discard``  plan_id: settle a plan as discarded, or dismiss one out of date
``attach``   file {id, name, bytes, lines, parts}: store one file's parts before a send
``delete``   the conversation, its files and its entry
``rename``   title
``hold``     take: the tab that may act on the conversation (``take``: Continue here)

A model-free op answers ``{kind: 'done', meta}``. Any op may answer
``{kind: 'refused', why, message, meta}``: ``message`` is the sentence the page
shows, so the copy lives here.

One tab acts on a conversation at a time. The sidebar entry names it
(``holder: {tab, at}``, the service's clock), and an op that acts inside the
conversation is allowed when the hold is free (none, this tab's, older than
:data:`LEASE_S`) or taken (``take``). ``rename`` and ``delete`` are list
actions, allowed from any tab.
"""

from datetime import datetime, timezone
from typing import Any, Dict, Optional

#: Every op a page may send.
OPS = ('send', 'retry', 'approve', 'discard', 'attach', 'delete', 'rename', 'hold')

#: The ops that act inside a conversation, held to the one-tab rule.
HELD_OPS = ('send', 'retry', 'approve', 'discard', 'attach', 'hold')

#: How long a tab's hold lasts without a renewal, in seconds. A tab renews it
#: every two minutes while it is visible (plaid-ui hold.js).
LEASE_S = 5 * 60

#: Advertised as ``extras.record``: the pages that send ops offer only an
#: assistant that takes them.
RECORD_PROTOCOL = 3

#: What a page that writes the record itself is told: it sent a request with
#: no op. The page writes it as the turn's error line, or shows it as a toast.
STALE_PAGE = 'This page is out of date. Reload it to keep going.'

#: A request whose data names a project other than the one it was posted to.
ANOTHER_PROJECT = 'This assistant was asked about another project.'

CONVERSATION_FULL = 'This conversation is full, so the message was not sent. Start a new conversation to go on.'
MESSAGE_TOO_LONG = ('This message is too long for the room left in this conversation, so it was not sent. '
                    'Shorten it or start a new conversation.')

#: The sentence for each refusal.
REFUSALS = {
    'held': 'This conversation is open in another tab.',
    'busy-turn': 'A message is being answered.',
    'busy-apply': 'The changes are being applied.',
    'delete-applying': 'That conversation is still applying changes.',
    'gone': 'This conversation was deleted.',
    'decided': 'This plan was already decided.',
    'written': 'Some of its changes may be written. Apply again to finish them.',
    'answered': 'That message has an answer.',
}


def refused(why: str, message: Optional[str] = None, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The result of an op the service turned down. ``why`` is the wire's
    reason: ``busy-turn`` and ``busy-apply`` go out as ``busy``, and a
    full record as ``full`` with the sentence that fits."""
    wire = 'busy' if why.startswith('busy') or why == 'delete-applying' else why
    out = {'kind': 'refused', 'why': wire, 'message': message or REFUSALS.get(why, why)}
    if meta is not None:
        out['meta'] = meta
    return out


def parse_time(text: Any) -> Optional[datetime]:
    """A time the record writes (`conversation.now_iso`), or None."""
    if not isinstance(text, str) or not text:
        return None
    try:
        at = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def hold_free(meta: Optional[Dict[str, Any]], tab: Optional[str], take: bool = False,
              now: Optional[datetime] = None) -> bool:
    """Whether ``tab`` may act on a conversation whose entry is ``meta``:
    nobody holds it, this tab does, the holder's lease ran out, or the tab
    takes it."""
    if take:
        return True
    holder = (meta or {}).get('holder')
    if not isinstance(holder, dict) or not holder.get('tab') or holder.get('tab') == tab:
        return True
    at = parse_time(holder.get('at'))
    now = now or datetime.now(timezone.utc)
    return at is None or (now - at).total_seconds() > LEASE_S


def busy_why(pending: Optional[Dict[str, Any]]) -> Optional[str]:
    """The refusal a live marker gives an op that starts work."""
    if not isinstance(pending, dict) or not pending.get('request_id'):
        return None
    return 'busy-apply' if pending.get('kind') == 'apply' else 'busy-turn'


def about_of(where: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Where a conversation began, as its entry stores it: the field name is
    the kind (``document_id``, ``document_name``), as plaid-ui ``aboutOf``
    wrote it."""
    if not isinstance(where, dict) or not where.get('kind') or not where.get('id'):
        return None
    kind = str(where['kind'])
    return {f'{kind}_id': where['id'], f'{kind}_name': where.get('name')}
