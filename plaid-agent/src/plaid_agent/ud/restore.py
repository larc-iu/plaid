"""Putting a document back to a moment in its history.

The server does the work (``POST /documents/:id/restore?as-of=``), and the
same call with ``dry_run`` says what would change, so the plan can show that
rather than promise. Maintainers only, which the server decides and this only
reports.

A restore is always a plan of its own: it rewrites every layer of the
document, so any other change in the same plan would be addressing something
the restore is about to replace. Same reasoning as a parse, and as moving a
sentence boundary.
"""

import re
from typing import Any, Dict, List

from .plan import _plural
from .tools import ToolError, Workspace

AS_OF = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')


def restore_lines(project, summary: dict) -> List[str]:
    """The dry run's counts, one phrase per kind of change, in the order the
    document is built: its name, its text, then each layer of tokens."""
    def changed(c):
        return sum((c or {}).get(k) or 0 for k in ('inserted', 'updated', 'deleted'))

    roles = {project.sentence_layer_id: 'sentence',
             project.token_layer_id: 'token',
             project.word_layer_id: 'word'}
    lines = []
    if summary.get('name'):
        lines.append('the document name')
    if changed(summary.get('texts')):
        lines.append('the text')
    for e in (summary.get('tokens') or {}).get('by_layer') or []:
        n = changed(e)
        if n:
            lines.append(f'{n} {_plural(roles.get(e.get("layer_id"), "token"), n)}')
    n = changed(summary.get('spans'))
    if n:
        lines.append(f'{n} {_plural("annotation", n)}')
    n = changed(summary.get('relations'))
    if n:
        lines.append(f'{n} {_plural("dependency", n)}')
    return lines


def t_restore_document(ws: Workspace, document: str = None, as_of: str = None) -> str:
    """PLAN: put a document back as it was at a moment in its history."""
    as_of = (as_of or '').strip()
    if not AS_OF.match(as_of):
        raise ToolError('as_of must be an ISO-8601 instant, e.g. 2026-09-05T18:45:49Z. '
                        'recent_changes prints one per change.')
    if ws.ops:
        raise ToolError('A restore must be a plan of its own, since it rewrites every layer of '
                        'the document. Discard the plan first (discard_plan), or let the user '
                        'approve it and ask for the restore afterwards.')
    doc = ws.doc(document)
    ws.on_progress(f'Checking what a restore of "{doc.name}" would change…')
    try:
        summary = ws.client.documents.restore(doc.id, as_of, dry_run=True)
    except Exception as e:  # noqa: BLE001 - the server's reason is the answer
        msg = str(e)
        if '403' in msg or 'orbidden' in msg:
            raise ToolError('Restoring a document needs maintainer access to this project.')
        raise ToolError(f'The restore was refused: {msg[:400]}')
    summary = summary if isinstance(summary, dict) else {}
    total = summary.get('total') or 0
    if not total:
        return f'Nothing to restore: "{doc.name}" is already as it was at {as_of}.'
    lines = restore_lines(ws.project, summary)
    ws.add_op({'kind': 'restore_document', 'document_id': doc.id, 'as_of': as_of,
                   'label': f'restore "{doc.name}" to {as_of} '
                            f'({total} change{"s" if total != 1 else ""}: ' + ', '.join(lines) + ')'})
    return ('Planned: restore "{}" to {}. From the server\'s dry run, that changes {}.'
            .format(doc.name, as_of, ', '.join(lines)))
