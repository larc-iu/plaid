"""Changing which WORDS a token holds: making a multi-word token, or undoing one.

This is the one reshaping a UD annotator needs that has no counterpart in the
other app. A surface token holds one word most of the time, and several when
it is a multi-word token: Spanish "al" holds "a" and "el". Both words cover
the whole token (the full-width rule), and what tells them apart is their
order and their Form span.

**It throws the token's annotation away, and says so.** The words are deleted
and remade, which cascades their lemma, UPOS, XPOS and features, and the
dependencies hanging off their lemma spans. That is right: a resegmentation
invalidates the analysis of what was segmented. It is also exactly the kind of
thing a user must see before approving, so the plan says how much goes.

It mirrors ``ConlluDocument.setWordMorphemes``, which is what the editor does
for the same gesture. Divergence here would mean two ways of building a
multi-word token that a later read cannot tell apart.
"""

from typing import Any, Dict, List

from .project import Token, UdDoc, Word, resolve
from .tools import ToolError, Workspace, _truncate


def _token_of(ws: Workspace, doc: UdDoc, ref: str) -> Token:
    thing = resolve(doc, ref)
    if isinstance(thing, Token):
        return thing
    if isinstance(thing, Word):
        return thing.token
    raise ToolError(f'{ref} is a sentence. Name a token: s{thing.index}.w1, or s{thing.index}.w1-2 '
                    f'for one that is already a multi-word token.')


def t_set_words(ws: Workspace, document: str = None, ref: str = None, forms=None) -> str:
    doc = ws.doc(document)
    from .tools import _no_parse_planned
    _no_parse_planned(ws, doc)
    token = _token_of(ws, doc, ref)
    if isinstance(forms, str):
        forms = [forms]
    clean = [f.strip() for f in (forms or []) if isinstance(f, str) and f.strip()]
    if not clean:
        raise ToolError('Give forms: the words this token holds, in order, as a list of strings.')
    sentence = next(s for s in doc.sentences if any(t is token for t in s.tokens))

    annotated = sum(1 for w in token.words for f in ('lemma', 'upos', 'xpos', 'features')
                    if w.value(f))
    heads = sum(1 for w in token.words if w.relation_id)
    lost = []
    if annotated:
        lost.append(f'{annotated} annotation value(s)')
    if heads:
        lost.append(f'{heads} dependenc' + ('y' if heads == 1 else 'ies'))

    ws.add_op({
        'kind': 'set_words', 'token_id': token.id, 'text_id': doc.text_id,
        'begin': token.begin, 'end': token.end, 'surface': token.surface,
        'forms': clean, 'existing_word_ids': [w.id for w in token.words],
        'word_layer_id': ws.project.word_layer_id,
        'form_layer_id': ws.project.layer('form'), 'lemma_layer_id': ws.project.layer('lemma'),
        'document_id': doc.id,
        'label': (f'{token.surface!r} becomes ' + ' + '.join(repr(f) for f in clean)
                  if len(clean) > 1 else f'{token.surface!r} becomes one word {clean[0]!r}'),
        'ref': f's{sentence.index}.{token.ref_range}'})

    what = ('one word' if len(clean) == 1
            else f'{len(clean)} words: ' + ', '.join(f'"{f}"' for f in clean))
    out = f'Planned "{token.surface}" in s{sentence.index} as {what}.'
    if lost:
        out += (' This replaces the token\'s words, so it discards ' + ' and '.join(lost)
                + ' on them. Their lemmas are seeded from the new forms.')
    return out


def apply_set_words(client, op: Dict[str, Any], b, stamp) -> None:
    """Batch 1 of the reshape: the words themselves, and the token's own form.

    Returns nothing; the created ids are read back in batch 2 (a batch op
    cannot refer to an id made in the same batch).
    """
    forms, surface = op['forms'], op.get('surface') or ''
    if op.get('existing_word_ids'):
        b.add(lambda ids=list(op['existing_word_ids']): client.tokens.bulk_delete(ids))
    idx = b.add(lambda o=op: client.tokens.bulk_create([
        {'token_layer_id': o['word_layer_id'], 'text': o['text_id'],
         'begin': o['begin'], 'end': o['end'], 'precedence': i}
        for i, _ in enumerate(o['forms'])]))
    # A multi-word token records its own surface, the way the editor does, so
    # an export knows what to print on the range line. A token back down to one
    # word drops it again.
    if len(forms) > 1:
        b.add(lambda i=op['token_id'], v=surface: client.tokens.patch_metadata(i, {'form': v}))
    else:
        b.add(lambda i=op['token_id']: client.tokens.patch_metadata(i, {'form': None}))
    op['_created_at'] = idx


def finish_set_words(client, op: Dict[str, Any], b, results, stamp) -> None:
    """Batch 2: the Form and Lemma spans on the words batch 1 created."""
    from ..core.plan import created_id
    at = op.get('_created_at')
    raw = results[at] if at is not None and at < len(results) else None
    ids = []
    if isinstance(raw, dict):
        body = raw.get('body')
        if isinstance(body, dict):
            ids = list(body.get('ids') or [])
    if not ids:
        made = created_id(raw)
        ids = [made] if made else []
    if len(ids) != len(op['forms']):
        raise ValueError(f'the words of {op.get("surface")!r} were not all created')
    forms, surface = op['forms'], op.get('surface') or ''
    for token_id, form in zip(ids, forms):
        # A Form span exists only where the form is not the token's own text:
        # one word spelled like its token needs none, and reads fall back to
        # the text. Every word gets a lemma, seeded from its form.
        if len(forms) > 1 or form != surface:
            b.add(lambda o=op, t=token_id, v=form: client.spans.bulk_create(
                [{'span_layer_id': o['form_layer_id'], 'tokens': [t], 'value': v,
                  'metadata': stamp() or None}]))
        b.add(lambda o=op, t=token_id, v=form: client.spans.bulk_create(
            [{'span_layer_id': o['lemma_layer_id'], 'tokens': [t], 'value': v,
              'metadata': stamp() or None}]))
