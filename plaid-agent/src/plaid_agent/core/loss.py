"""What a reshape takes from the document's OTHER layers, counted the way
core's cascade and layer rules take it, naming no app.

An assistant reads only its own layers, but a project several apps annotate
keeps every app's work on the same sentences and words. Deleting a word
deletes every token nested under it whichever app made it, and the spans,
relations and vocabulary links on them. Merging words makes the layers that
declare their tokens ``coextensive`` with the words lose the merged words'
tokens. Splitting a sentence deletes every relation a layer keeps inside one
sentence (``same-ancestor``) whose ends then fall on two sides of the cut.
None of that is the assistant's own data, so a card counts it by number only.

The Python twin of plaid-ui's ``domain/annotationLoss.js``
(``countDeleteLoss`` and ``countSplitLoss``), which the editors ask with. The
input is a whole document read (``documents.get(..., include_body=True)``
with no ``layers``), in the client's snake_case shape.
"""

from typing import Any, Dict, Iterable, List, Optional


def _token_layers(raw: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [tl for text in (raw or {}).get('text_layers') or []
            for tl in text.get('token_layers') or []]


def _parent(layer: Dict[str, Any]) -> Optional[str]:
    given = layer.get('parent_token_layer')
    return given.get('id') if isinstance(given, dict) else given


def _nested_under(layers, layer_id: str) -> List[Dict[str, Any]]:
    out, queue = [], [layer_id]
    while queue:
        lid = queue.pop(0)
        for tl in layers:
            if _parent(tl) == lid:
                out.append(tl)
                queue.append(tl['id'])
    return out


def count_delete_loss(raw: Dict[str, Any], token_ids: Iterable[str], *, under: bool = False,
                      skip: Iterable[str] = ()) -> Dict[str, Any]:
    """What deleting the tokens ``token_ids`` takes with it: every token of a
    layer nested under theirs that lies within one of them, every span left
    with none of its tokens and every relation on such a span, and every
    vocabulary link left with none of its tokens. With ``under`` the given
    tokens stay and only what is nested under them goes (a merge).

    ``skip`` names the layers the caller counts itself (a token, span or
    relation layer, or a vocabulary): the cascade runs through them and they
    are left out of the count. Returns ``{'annotations', 'links'}``, where
    annotations are spans and relations."""
    layers = _token_layers(raw)
    ids = set(token_ids or [])
    skipped = set(skip or ())
    dying = set()
    for tl in layers:
        given = [t for t in tl.get('tokens') or [] if t['id'] in ids]
        if not given:
            continue
        if not under:
            dying.update(t['id'] for t in given)
        for nested in _nested_under(layers, tl['id']):
            for t in nested.get('tokens') or []:
                if any(g['begin'] <= t['begin'] and t['end'] <= g['end'] for g in given):
                    dying.add(t['id'])
    out = {'annotations': 0, 'links': 0}
    if not dying:
        return out
    emptied = set()
    for tl in layers:
        for sl in tl.get('span_layers') or []:
            for span in sl.get('spans') or []:
                tokens = span.get('tokens') or []
                if tokens and all(t in dying for t in tokens):
                    emptied.add(span['id'])
                    if not skipped & {tl['id'], sl['id']}:
                        out['annotations'] += 1
    for tl in layers:
        for sl in tl.get('span_layers') or []:
            for rl in sl.get('relation_layers') or []:
                if skipped & {tl['id'], sl['id'], rl['id']}:
                    continue
                out['annotations'] += sum(1 for r in rl.get('relations') or []
                                          if r.get('source') in emptied or r.get('target') in emptied)
    seen = set()
    for tl in layers:
        for vocab in tl.get('vocabs') or []:
            if skipped & {tl['id'], vocab.get('id')}:
                continue
            for link in vocab.get('vocab_links') or []:
                tokens = link.get('tokens') or []
                if link.get('id') not in seen and tokens and all(t in dying for t in tokens):
                    seen.add(link.get('id'))
                    out['links'] += 1
    return out


def _ancestor_layer(constraint) -> Optional[str]:
    """The token layer a ``same-ancestor`` rule keeps a relation inside, or
    None for any other rule. The read may spell the key either way."""
    if not isinstance(constraint, dict) or constraint.get('type') != 'same-ancestor':
        return None
    for key in ('token_layer', 'tokenLayer', 'token-layer'):
        if constraint.get(key):
            return constraint[key]
    return None


def other_layers_crossing(raw: Dict[str, Any], sentence_layer_id: str, sentence_id: str,
                          char_pos: int, skip_layer_ids=()) -> List[str]:
    """The relations that core's ``same-ancestor`` rule deletes when the
    sentence ``sentence_id`` is split at ``char_pos``: those on a relation
    layer that declares the rule over the sentence layer, under any
    namespace, whose two ends fall in different halves. An end lies at the
    smallest begin of its span's tokens, as core places it, and a relation
    with an end outside the sentence is left alone. ``skip_layer_ids`` are
    the token layers whose relations the caller counts itself.
    """
    layers = _token_layers(raw)
    begin_of = {t['id']: t['begin'] for tl in layers for t in tl.get('tokens') or []}
    sentence_layer = next((tl for tl in layers if tl.get('id') == sentence_layer_id), None)
    sentence = next((t for t in (sentence_layer or {}).get('tokens') or [] if t['id'] == sentence_id), None)
    if not sentence or not (sentence['begin'] < char_pos < sentence['end']):
        return []

    def side(span) -> int:
        begins = [begin_of[t] for t in (span or {}).get('tokens') or [] if t in begin_of]
        if not begins:
            return 0
        place = min(begins)
        if place < sentence['begin'] or place >= sentence['end']:
            return 0
        return -1 if place < char_pos else 1

    out = []
    for tl in layers:
        if tl.get('id') in skip_layer_ids:
            continue
        for sl in tl.get('span_layers') or []:
            spans = {sp['id']: sp for sp in sl.get('spans') or []}
            for rl in sl.get('relation_layers') or []:
                rules = (rl.get('constraints') or {}).values()
                if not any(_ancestor_layer(c) == sentence_layer_id
                           for lst in rules if isinstance(lst, list) for c in lst):
                    continue
                for r in rl.get('relations') or []:
                    a, b = side(spans.get(r.get('source'))), side(spans.get(r.get('target')))
                    if a and b and a != b:
                        out.append(r['id'])
    return out


def loss_note(annotations: int = 0, links: int = 0) -> str:
    """" (3 annotations and 1 vocabulary link of other layers go with it)", or ''."""
    parts = []
    if annotations:
        parts.append(f'{annotations} annotation{"s" if annotations != 1 else ""}')
    if links:
        parts.append(f'{links} vocabulary link{"s" if links != 1 else ""}')
    return f' ({" and ".join(parts)} of other layers go with it)' if parts else ''
