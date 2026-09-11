"""One row per planned change, for the plan card the user approves.

Each row is ``{label, where}``: what the change is, and where in the corpus it
lands. ``where`` is what the Assistant tab turns into a link, and its
vocabulary is shared with plaid-igt (``kind``, ``document_id``,
``document_name``) so one card renders both apps' plans. What differs is the
addressing inside a document: UD locates a change by its CoNLL-U reference
(``s3.w2``), IGT by sentence, word and morpheme.
"""

from typing import Any, Dict, List, Optional

from .project import resolve


def describe_changes(ws, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [describe_change(ws, op) for op in ops]


def describe_change(ws, op: Dict[str, Any]) -> Dict[str, Any]:
    return {'label': op.get('label') or '', 'where': locate(ws, op)}


def locate(ws, op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Where a change lands: the document, and the word or sentence within it.

    An op with no ref changes the document as a whole (a parse, a restore), so
    it is located at the document and the card links there.
    """
    did = op.get('document_id')
    if not did:
        return None
    doc = ws._docs.get(did)
    name = doc.name if doc else did
    ref = op.get('ref')
    if not ref:
        return {'kind': 'document', 'document_id': did, 'document_name': name}

    where: Dict[str, Any] = {
        'kind': 'token',
        'document_id': did,
        'document_name': name,
        'ref': ref,
    }
    head = ref.split('.')[0]
    if head.startswith('s') and head[1:].isdigit():
        where['sentence'] = int(head[1:])
    # The word's own text, so the row names what changed rather than only
    # where it is. A ref that no longer resolves (the plan reshapes the words
    # ahead of this op) simply leaves it out.
    if doc is not None:
        try:
            target = resolve(doc, ref)
        except (ValueError, IndexError):
            return where
        where['surface'] = getattr(target, 'form', None) or getattr(target, 'text', '') or ''
        index = getattr(target, 'index', None)
        if '.' in ref and index is not None:
            where['word'] = index
    return where
