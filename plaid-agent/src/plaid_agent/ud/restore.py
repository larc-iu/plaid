"""Putting a document back to a moment in its history.

The tool is every app's (``core/history.py``, ``restore_document``): this
names the UD layers in what the dry run says will change. A restore is always
a plan of its own: it rewrites every layer of the document, so any other
change in the same plan would be addressing something the restore is about to
replace. Same reasoning as a parse, and as moving a sentence boundary.
"""

from typing import List

from ..core import history
from .plan import _plural
from .tools import Workspace


def restore_lines(ws: Workspace, summary: dict) -> List[str]:
    """The dry run's counts, in this app's names for its layers."""
    p = ws.project
    roles = {p.sentence_layer_id: 'sentence', p.token_layer_id: 'token', p.word_layer_id: 'word'}
    names = {'form': 'form', 'lemma': 'lemma', 'upos': 'UPOS', 'xpos': 'XPOS', 'features': 'feature'}
    fields = {lid: names.get(name, name) for name, lid in p.span_layers.items()}
    return history.restore_lines(
        summary,
        tokens=lambda layer_id, n: f'{n} {_plural(roles.get(layer_id, "token"), n)}',
        spans=lambda layer_id, n: f'{n} {fields.get(layer_id, "annotation")} {_plural("value", n)}',
        relations=lambda n: f'{n} {_plural("dependency", n)}',
        links=lambda n: f'{n} vocabulary {_plural("link", n)}')


def t_restore_document(ws: Workspace, document: str = None, as_of: str = None) -> str:
    """PLAN: put a document back as it was at a moment in its history."""
    return history.restore_document(ws, document, as_of, lines=lambda s: restore_lines(ws, s))
