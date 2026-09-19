"""What the project's log and its comment threads say.

Neither of these is annotation. The audit log is who changed what and when,
which is how a session finds out what happened since it last looked and what
moment a restore would go back to; the comments are notes annotators leave for
each other, anchored on a document or on one of its sentences.

Both read the server directly rather than through the query engine: the log is
not corpus data, and a comment outlives the thing it is anchored to.
"""

import re
from typing import Any, Dict, List

from ..core.args import clamp_limit
from ..core.limits import AUDIT_MAX_PAGES, AUDIT_PAGE, READ_LIMITS
from ..core.tools import ToolError, server_refused, truncate
from .project import Sentence, resolve
from .tools import Workspace


def t_recent_changes(ws: Workspace, document: str = None, limit: int = None,
                     since: str = None, user: str = None) -> str:
    """Who changed what, when, under which operation label. The assistant's
    own applied plans appear here like anyone else's work.

    Read newest first, a page at a time, and stopped as soon as the limit is
    met: the log of a corpus is long, and reading a whole window of it to print
    twenty lines is most of the cost of this tool.
    """
    limit = clamp_limit(limit, *READ_LIMITS['recent_changes'])
    ws.on_progress('Reading the change history…')
    u = (user or '').casefold()

    def keep(e):
        who = e.get('user') or {}
        return not u or u in (who.get('display_name') or '').casefold() \
            or u in (who.get('id') or '').casefold()

    kw: Dict[str, Any] = {}
    if since:
        start = since.strip()
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', start):
            start += 'T00:00:00Z'
        kw['start_time'] = start
    source = ws.client.documents if document else ws.client.projects
    target = ws.resolve_document_id(document) if document else ws.project.id
    entries: List[dict] = []
    cursor = None
    pages = 0
    walked = 0
    while len(entries) < limit and pages < AUDIT_MAX_PAGES:
        try:
            page = source.audit_page(target, order='desc', limit=AUDIT_PAGE, cursor=cursor, **kw)
        except Exception as e:  # noqa: BLE001 - the model reads the server's reason
            raise server_refused('The change history', e)
        got = (page or {}).get('entries') or []
        walked += len(got)
        entries += [e for e in got if keep(e)]
        cursor = (page or {}).get('next_cursor')
        pages += 1
        if not cursor or not got:
            break
    entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=True)[:limit]
    if not entries:
        if u and walked:
            return (f'Nothing by "{user}" among the {walked} most recent change(s)'
                    + (f' since {since}' if since else '') + '.')
        return 'Nothing has changed here' + (f' since {since}' if since else '') + '.'
    out = [f'{len(entries)} change(s), newest first.']
    for e in entries:
        who = (e.get('user') or {}).get('display_name') or (e.get('user') or {}).get('id') or '?'
        docs = ', '.join(f'"{d.get("name")}"' for d in (e.get('documents') or [])) or 'the project'
        what = e.get('message') or ', '.join(
            sorted({(o.get('type') or '').split('/')[0] for o in (e.get('ops') or [])})) or 'changes'
        out.append(f'  {e.get("time")}  {who}  {docs}: {what} ({len(e.get("ops") or [])} op(s))')
    return truncate('\n'.join(out))


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


__all__ = ['t_comments', 't_recent_changes']
