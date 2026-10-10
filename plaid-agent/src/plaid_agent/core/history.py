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
from collections import Counter
from typing import Any, Callable, Dict, List, Optional

from .args import clamp_limit
from .limits import AUDIT_MAX_PAGES, AUDIT_PAGE, READ_LIMITS
from .tools import ToolError, server_refused, truncate


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
    ws.note_read(len(entries), 'change')
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


# The most documents one comments read fetches to say where each comment sits.
# A comment in a document past it is shown by the label it was posted with.
COMMENT_DOC_BUDGET = 8


def comments(ws, document: Optional[str] = None, ref: Optional[str] = None,
             limit: Optional[int] = None) -> str:
    """What people have written to each other: in the whole project, in one
    document, or on one thing in it. These are notes between annotators, never
    annotation. Oldest first, the newest ``limit`` shown."""
    return read_comments(ws, document, ref, None, limit)


def comments_on_values(ws, document: Optional[str] = None, ref: Optional[str] = None,
                       field: Optional[str] = None, limit: Optional[int] = None) -> str:
    """:func:`comments`, for an app whose comments can also sit on one value
    of a thing (``field``)."""
    return read_comments(ws, document, ref, field, limit)


def read_comments(ws, document: Optional[str], ref: Optional[str], field: Optional[str],
                  limit: Optional[int]) -> str:
    """The one reading of a project's comments.

    What ``ref`` and ``field`` name is the app's
    (:meth:`BaseWorkspace.comment_target`), and so is where a listed comment's
    anchor sits (:meth:`BaseWorkspace.comment_ref`). Everything else about
    reading a thread is not.
    """
    limit = clamp_limit(limit, *READ_LIMITS['comments'])
    if ref and not document:
        raise ToolError('ref needs a document')
    if field and not ref:
        raise ToolError('field needs a ref: the thing whose value the comment is on')
    ws.on_progress('Reading the comments…')
    doc = ws.doc(document) if document else None
    if doc is not None and ref:
        etype, eid = ws.comment_target(doc, ref, field)
        kw: Dict[str, Any] = {'entity_type': etype, 'entity_id': eid}
        scope = f'on {doc_label(ws, doc.id)} {ref}' + (f' {field}' if field else '')
    elif doc is not None:
        kw = {'document_id': doc.id}
        scope = f'in {doc_label(ws, doc.id)}'
    else:
        kw = {}
        scope = 'in the project'
    try:
        rows = ws.client.comments.list(ws.project.id, **kw) or []
    except Exception as e:  # noqa: BLE001 - the model reads the server's reason
        raise server_refused('The comments', e) from None
    rows = sorted(rows, key=lambda c: c.get('created_at') or '')
    total = len(rows)
    rows = rows[-limit:]
    ws.note_read(len(rows), 'comment', of=total)
    if not rows:
        return f'No comments {scope}.'
    lines = [f'{total} comment{"s" if total != 1 else ""} {scope}'
             + (f' (newest {limit} shown)' if total > limit else '') + ', oldest first:']
    names = _ref_names(ws)
    listed = set(names)
    # A listing of more than one document says which one each comment is in.
    tagged = doc is None and len(listed) > 1
    loaded: set = set()
    for c in rows:
        when = (c.get('created_at') or '')[:16].replace('T', ' ')
        label = c.get('anchor_label') or c.get('entity_type') or '?'
        did = c.get('document_id')
        tag = f'"{names[did]}" ' if tagged and did in listed else ''
        if did not in listed:
            anchor = label + (' [outdated]' if did else '')
        elif did in ws._docs or len(loaded) < COMMENT_DOC_BUDGET:
            if did not in ws._docs:
                loaded.add(did)
            at = ws.comment_ref(ws.doc(did), c)
            anchor = tag + (at if at is not None else label + ' [outdated]')
        else:
            anchor = tag + label
        body = (c.get('body') or '').strip().replace('\n', ' ')
        lines.append(f'  {when}  {c.get("author_id") or "?"}  @ {anchor}: {body}'
                     + (' (edited)' if c.get('edited') else ''))
    return truncate('\n'.join(lines))


def _ref_names(ws) -> Dict[str, str]:
    """How a reference names each document: its name, or its id where another
    document shares that name (nothing forbids it, and imports produce it)."""
    names = {d['id']: d.get('name') or d['id'] for d in ws.documents()}
    taken = Counter(n.casefold() for n in names.values())
    return {i: (i if taken[n.casefold()] > 1 else n) for i, n in names.items()}


def doc_label(ws, doc_id: str) -> str:
    """A document as a sentence names it: its name, with its id beside it
    where another document shares that name."""
    ref = _ref_names(ws).get(doc_id, doc_id)
    if ref != doc_id:
        return ref
    name = next((d.get('name') for d in ws.documents() if d['id'] == doc_id), None)
    return f'{name} ({doc_id})' if name else doc_id


# --- putting a document back -----------------------------------------------------
#
# The server does the work (``POST /documents/:id/restore?as-of=``), and the
# same call with ``dry_run`` says what would change, so the plan shows that
# rather than promising. Maintainers only, which the server decides and this
# only reports. The executor is ``plan.apply_restore_document``. What an app
# brings is the names of its own layers.

AS_OF = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')


def _changed(counts) -> int:
    return sum((counts or {}).get(k) or 0 for k in ('inserted', 'updated', 'deleted'))


def restore_lines(summary: Dict[str, Any], *, tokens: Callable[[Optional[str], int], str],
                  spans: Callable[[Optional[str], int], str], relations: Callable[[int], str],
                  links: Callable[[int], str]) -> List[str]:
    """The dry run's counts, one phrase per kind of change, in the order a
    document is built, its metadata, and then what cannot come back. Every count core's
    ``summarize`` puts in ``total`` is named here, so no change is counted and
    left out. The app names its layers: ``tokens(layer id, n)`` and
    ``spans(layer id, n)`` per layer, ``relations(n)`` and ``links(n)`` for
    the rest."""
    lines = []
    if summary.get('name'):
        lines.append('the document name')
    if _changed(summary.get('texts')):
        lines.append('the text')
    for e in (summary.get('tokens') or {}).get('by_layer') or []:
        n = _changed(e)
        if n:
            lines.append(tokens(e.get('layer_id'), n))
    for e in (summary.get('spans') or {}).get('by_layer') or []:
        n = _changed(e)
        if n:
            lines.append(spans(e.get('layer_id'), n))
    n = _changed(summary.get('relations'))
    if n:
        lines.append(relations(n))
    n = _changed(summary.get('vocab_links'))
    if n:
        lines.append(links(n))
    if summary.get('document_metadata'):
        lines.append('the document metadata')
    for k in summary.get('skipped') or []:
        lines.append(f'{k.get("count")} {k.get("kind")}(s) cannot come back ({k.get("reason")})')
    return lines


def restore_document(ws, document: Optional[str], as_of: Optional[str], *,
                     lines: Callable[[Dict[str, Any]], List[str]],
                     extra: Optional[Callable[[Any], Dict[str, Any]]] = None) -> str:
    """PLAN: put a document back as it was at a moment in its history (every
    layer, ids kept), as one operation. The plan shows what would change, from
    the server's dry run. Nothing else can share the plan, since the restore
    rewrites what the other changes would address. ``lines(summary)`` is the
    app's :func:`restore_lines`, ``extra(doc)`` the keys its op carries."""
    as_of = (as_of or '').strip()
    if not AS_OF.match(as_of):
        raise ToolError('as_of must be an ISO-8601 instant, e.g. 2026-09-05T18:45:49Z (recent_changes '
                        'prints one per change as as_of=).')
    doc = ws.doc(document)
    # The funnel asks the same question of the op this tool is about to stage;
    # asked here too, the model is told before the dry run costs a round trip.
    # Of the OP, so a second restore of the same document is the supersession
    # the registry declares rather than a refusal this tool alone made.
    ws.refuse_exclusive_early({'kind': 'restore_document', 'document_id': doc.id})
    ws.on_progress(f'Checking what a restore of "{doc.name}" would change…')
    try:
        summary = ws.client.documents.restore(doc.id, as_of, dry_run=True)
    except Exception as e:  # noqa: BLE001 - the server's reason is the model's answer
        if getattr(e, 'status', None) == 403:
            raise ToolError('Restoring a document needs maintainer access to the project.')
        raise ToolError(f'The restore was refused: {" ".join(str(e).split())[:400]}')
    summary = summary if isinstance(summary, dict) else {}
    total = summary.get('total') or 0
    if not total:
        return f'Nothing to restore: "{doc.name}" is as it was at {as_of}.'
    said = lines(summary)
    ws.add_op({'kind': 'restore_document', 'document_id': doc.id, 'as_of': as_of, **(extra(doc) if extra else {}),
               'label': f'{doc_label(ws, doc.id)}: restore to {as_of} ({total} change{"s" if total != 1 else ""}: '
                        + ', '.join(said) + ')'})
    return ws.planned_note(1) + '\nWhat changes (from the server\'s dry run): ' + ', '.join(said) + '.'
