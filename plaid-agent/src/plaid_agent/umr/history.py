"""What the project's log and its comment threads say.

Neither of these is annotation. The audit log is who changed what and when,
which is how a session finds out what happened since it last looked and what
moment a restore would go back to; the comments are notes annotators leave for
each other, anchored on a document or on one of its sentences.

Both read the server directly rather than through the query engine: the log is
not corpus data, and a comment outlives the thing it is anchored to. Reading the
log is `core.history`'s, shared with the other apps; what is here is how this
app's references name the thing a comment is anchored to.
"""

from typing import Any, Dict

from ..core.args import clamp_limit
from ..core.limits import READ_LIMITS
from ..core.tools import ToolError, server_refused, truncate
from .project import Sentence, resolve
from .tools import Workspace


def t_comments(ws: Workspace, document: str = None, ref: str = None, limit: int = None) -> str:
    """What people have written to each other on a sentence or a document.
    These are notes between annotators, never annotation."""
    limit = clamp_limit(limit, *READ_LIMITS['comments'])
    doc = ws.doc(document)
    kw: Dict[str, Any] = {'document_id': doc.id}
    if ref:
        try:
            thing = resolve(doc, ref)
        except ValueError as e:
            raise ToolError(str(e)) from None
        if not isinstance(thing, Sentence):
            raise ToolError(f'{ref} is a node. A comment sits on a sentence or on the document.')
        # The app anchors a sentence's comments on its token, the way the
        # other apps do. Both halves of the anchor, because the server reads
        # the id only beside the type.
        kw = {'entity_type': 'token', 'entity_id': thing.id}
    try:
        got = ws.client.comments.list(ws.project.id, **kw) or []
    except Exception as e:  # noqa: BLE001 - the model reads the server's reason
        raise server_refused('The comments', e)
    if not got:
        return f'No comments on {ref}.' if ref else f'No comments in "{doc.name}".'
    # A comment names the entity it is anchored to. Turn that back into the
    # positional reference the rest of the tools speak.
    where = {s.id: f's{s.index}' for s in doc.sentences}
    out = []
    for cm in got[:limit]:
        who = (cm.get('user') or {}).get('display_name') or (cm.get('user') or {}).get('id') or '?'
        at = where.get(cm.get('entity_id'), doc.name)
        out.append(f'  {at}  {who} ({(cm.get("time") or "")[:10]}): {cm.get("body") or ""}')
    head = f'{len(got)} comment(s) in "{doc.name}"' + (f' on {ref}' if ref else '')
    if len(got) > limit:
        head += f', showing {limit}'
    return truncate(head + ':\n' + '\n'.join(out))


__all__ = ['t_comments']
