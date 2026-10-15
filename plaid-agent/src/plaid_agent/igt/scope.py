"""Several documents in place of one: the ``documents`` argument every read
tool that takes a ``document`` shares (survey item 8, 453d5450: "focus on MW
and LW" became a loop over documents in run_code).

A read tool is written for one document or the project. :func:`among_documents`
gives it ``documents`` without a change of its own: one document is passed on
as ``document``, several hold every query the tool makes to them
(``Corpus.among``), and a tool that walks documents itself asks
:func:`held_docs` which ones.
"""

import functools
import inspect
from typing import Callable, List, Optional

from ..core.tools import ToolError


def resolve_documents(ws, documents) -> List[str]:
    """The ids ``documents`` names (names or ids, each as a tool takes a
    document), in the order named, each once."""
    if isinstance(documents, str):
        documents = [documents]
    if not isinstance(documents, list) or not all(isinstance(d, str) and d.strip() for d in documents):
        raise ToolError('documents is a list of document names or ids, e.g. ["Text 1", "Text 2"].')
    ids: List[str] = []
    for d in documents:
        did = ws.resolve_document_id(d.strip())
        if did not in ids:
            ids.append(did)
    return ids


def held_docs(ws) -> Optional[List[str]]:
    """The documents a read is held to now (one, several), or None for all."""
    return ws.corpus.held_documents()


def among_documents(fn: Callable) -> Callable:
    """``fn`` with a ``documents`` argument beside its ``document``."""
    sig = inspect.signature(fn)
    if 'document' not in sig.parameters:
        raise TypeError(f'{fn.__name__} takes no document')

    @functools.wraps(fn)
    def run(ws, *args, documents=None, **kwargs):
        if documents is None or documents == [] or documents == '':
            return fn(ws, *args, **kwargs)
        bound = sig.bind(ws, *args, **kwargs)
        if bound.arguments.get('document'):
            raise ToolError('Give document or documents, not both.')
        ids = resolve_documents(ws, documents)
        if len(ids) == 1:
            bound.arguments['document'] = ids[0]
            return fn(*bound.args, **bound.kwargs)
        with ws.corpus.among(ids):
            out = fn(*bound.args, **bound.kwargs)
        names = ', '.join(ws.doc_label(i, quote=True) for i in ids)
        return f'In {len(ids)} documents: {names}.\n{out}'

    params = list(sig.parameters.values())
    params.append(inspect.Parameter('documents', inspect.Parameter.KEYWORD_ONLY, default=None))
    run.__signature__ = sig.replace(parameters=params)
    return run
