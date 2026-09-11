"""One row per planned change, for the plan card the user approves.

Each row is ``{label, where}``: what the change is, and where in the corpus it
lands. ``where`` is what the Assistant tab turns into a link, so its shape is
the app's half of the shared plan card (plaid-ud opens a sentence with
``annotate?sent=``, plaid-igt with a tab and a focus).
"""

from typing import Any, Dict, List, Optional


def describe_changes(ws, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [describe_change(ws, op) for op in ops]


def describe_change(ws, op: Dict[str, Any]) -> Dict[str, Any]:
    return {'label': op.get('label') or '', 'where': locate(ws, op)}


def locate(ws, op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Where a change lands: the document, and the sentence within it. The ref
    an op carries is positional (``s3.w2``), and the sentence is its first
    segment, which is all a link needs."""
    did = op.get('document_id')
    ref = op.get('ref')
    if not did:
        return None
    doc = ws._docs.get(did)
    where: Dict[str, Any] = {'document_id': did, 'document': doc.name if doc else did}
    if ref:
        where['ref'] = ref
        head = ref.split('.')[0]
        if head.startswith('s') and head[1:].isdigit():
            where['sentence'] = int(head[1:])
    return where
