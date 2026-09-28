"""Which sentences a plan was worked out against, and whether they have moved.

A plan is refused at approval when a document it reaches has changed since it
was made, and every write inside a document bumps its version, so a fix in one
sentence used to refuse a plan about another. Now a plan records a fingerprint
of each sentence its changes depend on, and when the document's version has
moved, approval reads the document again and compares only those (ruled
2026-09-28). A change that is not about particular sentences (a
scope over the whole document, a text edit, a change to the document itself)
stays pinned to the whole document, as every change was before.

What a change depends on is read off the change itself, the same way for every
app: the ids it carries. An id of a thing inside a sentence ties the change to
that sentence. An id of the document or its text, or one that names nothing the
sentences hold, pins it to the whole document, because a change whose
dependencies cannot be named cannot be checked sentence by sentence. The
fingerprint is the whole sentence as the app parsed it (its extent, its words,
every annotation on them and their provenance), so whatever the change read
from it is covered.
"""

import dataclasses
import hashlib
import json
from typing import Any, Dict, Iterable, Optional, Set

# Keys that say WHERE a change lands rather than what it depends on, and keys
# that name something outside any document. Neither ties a change to a
# sentence, and neither pins it to the whole document either.
ADDRESSING_KEYS = frozenset({
    'label', 'kind', 'ref', 'staging', 'document_id', 'document_ids', 'documents', 'doc',
    'project_id', 'service_id', 'guideline_id', 'vocab_id', 'item_id', 'keep_id', 'remove_id',
    'entry_id',
})


def _plain(obj: Any, path: tuple) -> Any:
    """``obj`` as plain JSON values, deterministically. A dataclass field
    declared ``compare=False`` is a cache, not content, and is left out. A
    back-reference to an object already on the path (a word pointing at its
    token) is written as a marker instead of being followed."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if id(obj) in path:
        return '<up>'
    path = path + (id(obj),)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _plain(getattr(obj, f.name), path)
                for f in dataclasses.fields(obj) if f.compare}
    if isinstance(obj, dict):
        return {str(k): _plain(v, path) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v, path) for v in obj]
    if isinstance(obj, (set, frozenset)):
        return sorted((_plain(v, path) for v in obj), key=lambda v: json.dumps(v, sort_keys=True))
    if hasattr(obj, '__dict__'):
        return {k: _plain(v, path) for k, v in sorted(vars(obj).items()) if not k.startswith('_')}
    return repr(obj)


def fingerprint(obj: Any) -> str:
    """A short digest of everything ``obj`` holds. Two reads of the same data
    give the same digest, and any change to it gives another."""
    text = json.dumps(_plain(obj, ()), sort_keys=True, ensure_ascii=True, separators=(',', ':'))
    # Sixteen hex digits: a digest here tells an edit from no edit, it is not
    # guarding against anyone, and each one is stored in the conversation.
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def _ids_in(obj: Any, fields: Iterable[str], path: tuple = ()) -> Iterable[str]:
    """Every string held under one of ``fields`` anywhere in ``obj``."""
    if obj is None or isinstance(obj, (str, int, float, bool)) or id(obj) in path:
        return
    path = path + (id(obj),)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        for f in dataclasses.fields(obj):
            if not f.compare:
                continue
            value = getattr(obj, f.name)
            if f.name in fields and isinstance(value, str):
                yield value
            else:
                yield from _ids_in(value, fields, path)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _ids_in(v, fields, path)
    elif isinstance(obj, (list, tuple, set, frozenset)):
        for v in obj:
            yield from _ids_in(v, fields, path)


def sentence_index(sentences: Iterable[Any], fields: Iterable[str] = ('id',)) -> Dict[str, Set[str]]:
    """id -> the ids of the sentences it appears in. An id may appear in two
    (a relation between two sentences' nodes is held by both)."""
    fields = frozenset(fields)
    out: Dict[str, Set[str]] = {}
    for s in sentences:
        for value in _ids_in(s, fields):
            out.setdefault(value, set()).add(s.id)
    return out


def _id_like(key: Optional[str]) -> bool:
    return bool(key) and (key == 'id' or key == 'ids' or key.endswith('_id') or key.endswith('_ids'))


def sentences_of_op(op: Dict[str, Any], index: Dict[str, Set[str]], whole: Set[str],
                    skip: Iterable[str] = ()) -> Optional[Set[str]]:
    """The sentences a change depends on, or None when it depends on the
    document as a whole.

    ``index`` is :func:`sentence_index` of the document, ``whole`` the ids
    that stand for the document itself (its own id, its text's), and ``skip``
    the app's own keys that name neither. A layer is never content.
    """
    skip = ADDRESSING_KEYS | frozenset(skip)
    found: Set[str] = set()

    def walk(value: Any, key: Optional[str]) -> bool:
        """False as soon as the change turns out to reach the whole document."""
        if isinstance(value, dict):
            return all(walk(v, k) for k, v in value.items()
                       if k not in skip and not str(k).endswith('layer_id'))
        if isinstance(value, (list, tuple)):
            return all(walk(v, key) for v in value)
        if not isinstance(value, str):
            return True
        if value in index:
            found.update(index[value])
            return True
        # The document itself, or an id nothing in its sentences holds.
        return value not in whole and not _id_like(key)

    if not walk(op, None):
        return None
    return found or None
