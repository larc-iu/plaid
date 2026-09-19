"""One row per planned change, for the plan card the user approves.

Each row is ``{label, where}``: what the change is, and where in the corpus it
lands. ``where`` is what the Assistant tab turns into a link, and its
vocabulary is shared with the other apps (``kind``, ``document_id``,
``document_name``) so one card renders every app's plans. What differs is the
addressing inside a document: UMR locates a change by its sentence and, where
there is one, the node's variable.
"""

from typing import Any, Dict, List, Optional

from ..core import opkind
from .plan import KIND

# Changes that replace prose a person wrote. UMR annotates graphs rather than
# prose, so the only ones here are the project's guidelines.
_PROSE_KINDS = frozenset(opkind.shaped(KIND, opkind.PROSE))


def describe_changes(ws, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [describe_change(ws, op) for op in ops]


def describe_change(ws, op: Dict[str, Any]) -> Dict[str, Any]:
    return {'label': op.get('label') or '', 'where': locate(ws, op),
            'writes_text': op.get('kind') in _PROSE_KINDS}


def locate(ws, op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Where a change lands: the document, and the sentence or node within it.

    An op with no sentence changes the document as a whole (a constant, a
    triple between two constants before a sentence is named), so it is located
    at the document and the card links there.
    """
    did = op.get('document_id')
    if not did:
        return None
    doc = ws._docs.get(did)
    name = doc.name if doc else did
    sentence = op.get('sentence')
    if not sentence:
        return {'kind': 'document', 'document_id': did, 'document_name': name}

    where: Dict[str, Any] = {
        'kind': 'token',
        'document_id': did,
        'document_name': name,
        'ref': op.get('ref') or f's{sentence}',
        'sentence': int(sentence),
    }
    # The editor's deep link needs the sentence's id, not its number. A
    # compacted op carries the one it was staged with.
    sentence_id = op.get('sentence_id')
    if not sentence_id and doc is not None and 1 <= int(sentence) <= len(doc.sentences):
        sentence_id = doc.sentences[int(sentence) - 1].id
    if sentence_id:
        where['sentence_id'] = sentence_id
    # The node's own variable, so the row names what changed rather than only
    # where it is.
    if op.get('var'):
        where['surface'] = op['var']
        where['node'] = op['var']
    elif doc is not None and 1 <= int(sentence) <= len(doc.sentences):
        where['surface'] = doc.sentences[int(sentence) - 1].text
    return where
