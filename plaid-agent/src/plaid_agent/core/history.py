"""What the project's log says, and what people have written to each other.

Neither is annotation, and neither is corpus data, so both are read from the
server directly rather than through the query engine: a comment outlives the
thing it is anchored to.

The log is also long -- a corpus of a thousand documents has thousands of
entries and megabytes of ops -- which is the whole design of the read below:
newest first, a page at a time, stopped as soon as the asked-for number of
entries is in hand.

One reading for every app, because there is nothing app-specific in either but
what a reference names: the entries name people, documents and operations, and
each app's tools address a document by name, which
:meth:`BaseWorkspace.resolve_document_id` already does.
"""

import re
from typing import Any, Dict, List, Optional

from .args import clamp_limit
from .limits import AUDIT_MAX_PAGES, AUDIT_PAGE, READ_LIMITS
from .tools import server_refused, truncate


def recent_changes(ws, document: Optional[str] = None, limit: Optional[int] = None,
                   since: Optional[str] = None, user: Optional[str] = None) -> str:
    """The newest entries of the audit log. ``since`` is a date (YYYY-MM-DD) or
    a timestamp, ``user`` matches the actor's name or address.

    An app names its own way back to a moment in ``Workspace.RESTORE_TOOL``,
    which is what the ``as_of`` instant is for; an app with no such tool prints
    the instant without offering one.
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
            raise server_refused('The change history', e) from None
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

    restore = getattr(ws, 'RESTORE_TOOL', None)
    out = [f'{len(entries)} change(s), newest first. as_of= is the moment right AFTER that change'
           + (f', which is what {restore} takes.' if restore else '.')]
    for e in entries:
        who = (e.get('user') or {}).get('display_name') or (e.get('user') or {}).get('id') or '?'
        docs = ', '.join(f'"{d.get("name")}"' for d in (e.get('documents') or [])) or 'the project'
        what = e.get('message') or ', '.join(
            sorted({(o.get('type') or '').split('/')[0] for o in (e.get('ops') or [])})) or 'changes'
        # The END of the operation, not its start. A change is a whole operation
        # of many writes, and going back to the instant it BEGAN lands in the
        # middle of it, with some of its writes kept and some thrown away.
        after = e.get('end_time') or e.get('time') or ''
        out.append(f'  {e.get("time")}  {who}  {docs}: {what} ({len(e.get("ops") or [])} op(s))')
        out.append(f'      as_of={after}')
    return truncate('\n'.join(out))


def comments(ws, document: str = None, ref: str = None, limit: int = None) -> str:
    """What people have written to each other on a document, or on one thing in
    it. These are notes between annotators, never annotation.

    What ``ref`` names is the app's (:meth:`BaseWorkspace.comment_anchor`);
    everything else about reading a thread is not.
    """
    limit = clamp_limit(limit, *READ_LIMITS['comments'])
    doc = ws.doc(document)
    kw: Dict[str, Any] = {'document_id': doc.id}
    if ref:
        kw = {'entity_type': 'token', 'entity_id': ws.comment_anchor(doc, ref)}
    try:
        got = ws.client.comments.list(ws.project.id, **kw) or []
    except Exception as e:  # noqa: BLE001 - the model reads the server's reason
        raise server_refused('The comments', e) from None
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
    line = f'{len(got)} comment(s) in "{doc.name}"' + (f' on {ref}' if ref else '')
    if len(got) > limit:
        line += f', showing {limit}'
    return truncate(line + ':\n' + '\n'.join(out))
