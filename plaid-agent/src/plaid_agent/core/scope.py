"""Several documents in place of one: the ``documents`` argument every app
gives each read that takes a ``document`` (survey item 8: "focus on MW and
LW" became a loop over documents in run_code). One copy for every app.

A read is written for one document or the project. :func:`among_documents`
gives it ``documents`` without a change of its own: one document is passed on
as ``document``, several hold every query the tool makes to them
(:meth:`Corpus.among`), and the answer opens by naming them. A tool that
walks documents itself asks ``ws.corpus.documents`` which ones.
"""

import functools
import inspect
from typing import Callable, List

from .bidi import qname
from .history import doc_label
from .limits import MAX_SCOPE_DOCS
from .tools import ToolError


def resolve_documents(ws, documents) -> List[str]:
    """The ids ``documents`` names (names or ids, each as a tool takes a
    document), in the order named, each once."""
    if isinstance(documents, str):
        documents = [documents]
    if not isinstance(documents, list) or not all(isinstance(d, str) and d.strip() for d in documents):
        raise ToolError('documents is a list of document names or ids, e.g. ["Text 1", "Text 2"].',
                        kind='invalid-argument')
    ids: List[str] = []
    for d in documents:
        did = ws.resolve_document_id(d.strip())
        if did not in ids:
            ids.append(did)
    return ids


def is_all(documents) -> bool:
    """Whether ``documents`` asks for the whole project. Only the word "all"
    does (Luke's ruling), alone or as the one item of a list: a name is one
    document, and a plan over the project is never staged by omission."""
    if isinstance(documents, list) and len(documents) == 1:
        documents = documents[0]
    return isinstance(documents, str) and documents.strip().lower() == 'all'


def review_documents(ws, documents, find_all: Callable[[], List[str]], too_many: str = '') -> List[str]:
    """The ids a review over several documents covers: what ``find_all()``
    finds when ``documents`` is "all" (:func:`is_all`), else the ones named,
    each once. More than one plan covers is refused, ``too_many`` saying
    what to do instead.

    A named list is handed to the trace as resolved, as
    :func:`among_documents` does, so an id and a name of one document are
    one document in the step the user sees."""
    if is_all(documents):
        ids = list(find_all())
    else:
        ids = resolve_documents(ws, documents)
        ws.scoped_documents = [doc_label(ws, i) for i in ids]
    if len(ids) > MAX_SCOPE_DOCS:
        raise ToolError(f'{len(ids)} documents, more than the {MAX_SCOPE_DOCS} one plan covers.'
                        + (f' {too_many}' if too_many else ''), kind='too-large')
    return ids


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
            raise ToolError('Give document or documents, not both.', kind='invalid-argument')
        ids = resolve_documents(ws, documents)
        # The documents as resolved, for the trace to count each once
        # (`core.agent`): an id and a name of one document are one.
        ws.scoped_documents = [doc_label(ws, i) for i in ids]
        if len(ids) == 1:
            bound.arguments['document'] = ids[0]
            return fn(*bound.args, **bound.kwargs)
        with ws.corpus.among(ids):
            out = fn(*bound.args, **bound.kwargs)
        names = ', '.join(doc_label(ws, i, qname) for i in ids)
        return f'In {len(ids)} documents: {names}.\n{out}'

    params = list(sig.parameters.values())
    params.append(inspect.Parameter('documents', inspect.Parameter.KEYWORD_ONLY, default=None))
    run.__signature__ = sig.replace(parameters=params)
    return run
