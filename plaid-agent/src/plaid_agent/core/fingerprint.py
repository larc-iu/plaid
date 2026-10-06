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
fingerprint is the whole sentence as the app parsed it (its length, its words,
every annotation on them and their provenance), so whatever the change read
from it is covered. Its offsets are counted from the sentence's own start, so
text typed into an earlier sentence does not move it, and a planned change
that holds a place in the text either reads it again from its token when it is
applied or pins the whole document (:func:`offsets_follow`).
"""

import dataclasses
import hashlib
import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

# Keys that say WHERE a change lands rather than what it depends on, and keys
# that name something outside any document. Neither ties a change to a
# sentence, and neither pins it to the whole document either.
ADDRESSING_KEYS = frozenset({
    'label', 'kind', 'ref', 'staging', 'document_id', 'document_ids', 'documents', 'doc',
    'project_id', 'service_id', 'guideline_id', 'vocab_id', 'item_id', 'keep_id', 'remove_id',
    'entry_id',
})

# The keys that hold a place in a document's text. Those are absolute, so an
# edit before a sentence moves every one in it. A sentence's fingerprint counts
# them from the sentence's start, and a planned change holding one either names
# the token it was read from (its kind's ``anchors``, read again when the plan
# is applied, :func:`rebase_offsets`) or pins the whole document.
OFFSET_KEYS = frozenset({'begin', 'end'})
POSITION_KEYS = frozenset({'position', 'char_pos'})


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


def _from(value: Any, origin: int) -> Any:
    """``value`` with every offset in it (an int under one of
    :data:`OFFSET_KEYS`) counted from ``origin`` instead of the text's
    start."""
    if isinstance(value, dict):
        return {k: (v - origin if k in OFFSET_KEYS and isinstance(v, int) and not isinstance(v, bool)
                    else _from(v, origin))
                for k, v in value.items()}
    if isinstance(value, list):
        return [_from(v, origin) for v in value]
    return value


def fingerprint(obj: Any, origin: Optional[int] = None) -> str:
    """A short digest of everything ``obj`` holds. Two reads of the same data
    give the same digest, and any change to it gives another.

    With ``origin`` (a sentence's own start), every offset is counted from it,
    so text typed into an earlier sentence, which moves every later offset,
    leaves the digest as it was. The sentence's length and every offset
    inside it still count."""
    plain = _plain(obj, ())
    if origin is not None:
        plain = _from(plain, origin)
    text = json.dumps(plain, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
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


# --- offsets a planned change holds ------------------------------------------------

def _holds_offset(value: Any) -> bool:
    """Whether ``value`` holds an offset or a position anywhere in it."""
    if isinstance(value, dict):
        return any(k in OFFSET_KEYS or k in POSITION_KEYS or _holds_offset(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(_holds_offset(v) for v in value)
    return False


def offset_places(op: Dict[str, Any]) -> Optional[Set[Optional[str]]]:
    """Where a planned change holds a place in the text: ``None`` in the set
    for the change's own ``begin`` and ``end``, a key for a dict under it
    holding its own. None when it holds one a rebase cannot reach: a
    position inside a token, or an offset any deeper."""
    places: Set[Optional[str]] = set()
    for k, v in op.items():
        if k in POSITION_KEYS:
            return None
        if k in OFFSET_KEYS:
            places.add(None)
        elif isinstance(v, dict):
            if any(kk in POSITION_KEYS or _holds_offset(vv) for kk, vv in v.items()):
                return None
            if any(kk in OFFSET_KEYS for kk in v):
                places.add(k)
        elif _holds_offset(v):
            return None
    return places


def offset_anchors(reg: Mapping[str, Any], op: Dict[str, Any]) -> List[Tuple[Optional[str], str]]:
    """``(place, token id)`` for each place in the text ``op`` holds and the
    token it was read from, as its kind declares them (``extra['anchors']``):
    the extent the place stands for is that token's, wherever it is now."""
    spec = reg.get(op.get('kind')) if isinstance(op, dict) else None
    fn = (getattr(spec, 'extra', None) or {}).get('anchors') if spec is not None else None
    return [(place, tid) for place, tid in (fn(op) if fn else ()) if tid]


def offsets_follow(reg: Mapping[str, Any], op: Dict[str, Any]) -> bool:
    """Whether every place in the text ``op`` holds is read again from its
    token when the plan is applied (:func:`rebase_offsets`). One that is not
    stays where it was read, so the change pins its whole document: an edit
    anywhere before it would move the text under it."""
    places = offset_places(op)
    if places is None:
        return False
    return places <= {place for place, _ in offset_anchors(reg, op)}


def rebase_offsets(client, reg: Mapping[str, Any], ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``ops`` with every place in the text they hold read again from the
    token it was read from (:func:`offset_anchors`).

    A plan pinned to its sentences applies after an edit elsewhere in its
    document, and an edit before a sentence moves every offset in it. A
    sentence's fingerprint counts its offsets from its own start, so it does
    not see that move. What a planned create was given is the extent of the
    token it was read from (a new token over the one it stands on), so it is
    taken from that token as it is now. A token that
    is gone leaves the place as it was planned: approval has already refused a
    plan whose sentence lost it, so nothing that reaches here has moved."""
    wanted = [offset_anchors(reg, op) for op in ops]
    extents: Dict[str, Optional[tuple]] = {}
    for pairs in wanted:
        for _, tid in pairs:
            if tid not in extents:
                extents[tid] = _extent(client, tid)
    out: List[Dict[str, Any]] = []
    for op, pairs in zip(ops, wanted):
        now = dict(op)
        for place, tid in pairs:
            extent = extents.get(tid)
            if extent is None:
                continue
            if place is None:
                now['begin'], now['end'] = extent
            elif isinstance(now.get(place), dict):
                now[place] = {**now[place], 'begin': extent[0], 'end': extent[1]}
        out.append(now)
    return out


def _extent(client, token_id: str) -> Optional[tuple]:
    """(begin, end) of a token as the server holds it now, or None when it is
    gone."""
    try:
        token = client.tokens.get(token_id) or {}
    except Exception as e:  # noqa: BLE001 - only a gone token is answered here
        if getattr(e, 'status', None) == 404:
            return None
        raise
    begin, end = token.get('begin'), token.get('end')
    if not isinstance(begin, int) or not isinstance(end, int):
        return None
    return begin, end
