"""Changing which WORDS a token holds: making a multi-word token, or undoing one.

This is the one reshaping a UD annotator needs that has no counterpart in the
other app. A surface token holds one word most of the time, and several when
it is a multi-word token: Spanish "al" holds "a" and "el". Both words cover
the whole token (the full-width rule), and what tells them apart is their
order and their Form span.

**As many forms as the token has words respells them in place**: each word
keeps its token and everything on it, and only its Form span is written. A
set_words that changes nothing is refused.

**Another number throws the token's annotation away, and says so.** The words
are deleted and remade, which cascades their lemma, UPOS, XPOS and features,
and the dependencies hanging off their lemma spans. That is right: a
resegmentation invalidates the analysis of what was segmented. It is also
exactly the kind of thing a user must see before approving, so the plan says
how much goes, on the card's row as well as in the reply.

It mirrors ``ConlluDocument.setWordMorphemes``, which is what the editor does
for the same gesture. Divergence here would mean two ways of building a
multi-word token that a later read cannot tell apart.
"""

from typing import Any, Dict, List


from .project import LEMMA_FROM_FORM, Token, UdDoc, Word, resolve, word_ref
from .tools import ToolError, Workspace


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
    from .tools import _guards
    _guards(ws, doc)
    token = _token_of(ws, doc, ref)
    if isinstance(forms, str):
        forms = [forms]
    clean = [f.strip() for f in (forms or []) if isinstance(f, str) and f.strip()]
    if not clean:
        raise ToolError('Give forms: the words this token holds, in order, as a list of strings.')
    sentence = next(s for s in doc.sentences if any(t is token for t in s.tokens))
    if clean == [w.form for w in token.words]:
        raise ToolError(f'Nothing to change: "{token.surface}" in s{sentence.index} already holds '
                        + ' + '.join(f'"{f}"' for f in clean) + '.')
    if len(clean) == len(token.words):
        return _respell(ws, doc, sentence, token, clean)

    annotated = sum(1 for w in token.words for f in ('lemma', 'upos', 'xpos', 'features')
                    if w.value(f))
    # Arcs ON these words, in both directions. They all hang off the words'
    # lemma spans, so an arc whose HEAD is one of them cascades exactly as one
    # whose dependent is. Counting only `relation_id` (the dependent's end)
    # promised one loss and took three.
    indexes = {w.index for w in token.words}
    arcs = [w.relation_id for w in sentence.words
            if w.relation_id and (w.index in indexes or w.head in indexes)]
    heads = len(arcs)
    # The enhanced graph's extra edges hang off the same lemma spans, and go
    # the same way.
    extras = sum(1 for w in sentence.words for head, _rid in w.extra_edges
                 if w.index in indexes or head in indexes)
    lost = []
    if annotated:
        lost.append(f'{annotated} annotation value(s)')
    if heads:
        lost.append(f'{heads} dependenc' + ('y' if heads == 1 else 'ies'))
    if extras:
        lost.append(f'{extras} enhanced dependenc' + ('y' if extras == 1 else 'ies'))
    becomes = (f'{token.surface!r} becomes ' + ' + '.join(repr(f) for f in clean)
               if len(clean) > 1 else f'{token.surface!r} becomes one word {clean[0]!r}')

    ws.add_op({
        'kind': 'set_words', 'token_id': token.id, 'text_id': doc.text_id,
        'begin': token.begin, 'end': token.end, 'surface': token.surface,
        'forms': clean, 'existing_word_ids': [w.id for w in token.words],
        # The arcs the words' delete takes with it, so a change to one of them
        # in the same plan is refused as it is staged, not by the server.
        'relation_ids': arcs,
        'word_layer_id': ws.project.word_layer_id,
        'form_layer_id': ws.project.layer('form'), 'lemma_layer_id': ws.project.layer('lemma'),
        'document_id': doc.id,
        # What goes is on the row the user approves, not only in the reply
        # the model may or may not pass on.
        'label': becomes + (f' (discards {" and ".join(lost)})' if lost else ''),
        'ref': f's{sentence.index}.{token.ref_range}'})

    what = ('one word' if len(clean) == 1
            else f'{len(clean)} words: ' + ', '.join(f'"{f}"' for f in clean))
    out = f'Planned "{token.surface}" in s{sentence.index} as {what}.'
    if lost:
        out += (' This replaces the token\'s words, so it discards ' + ' and '.join(lost)
                + ' on them. Their lemmas are seeded from the new forms.')
    return out


def _respell(ws: Workspace, doc: UdDoc, sentence, token: Token, forms: List[str]) -> str:
    """As many forms as the token has words respells them in place, as the
    editor's ``_respellWords`` does: each word keeps its token and everything
    on it, its lemma, tags, features and arcs, and only its Form is written.
    A word whose form is the token's own text, alone in its token, carries no
    Form span."""
    is_mwt = len(forms) > 1
    layer = ws.project.layer('form')
    staged = []
    for w, form in zip(token.words, forms):
        want = form if (is_mwt or form != token.surface) else ''
        sp = w.fields.get('form')
        have = sp.value if sp and sp.value else ''
        if have == want:
            continue
        ref = word_ref(sentence, w)
        staged.append({'kind': 'set_span', 'layer_id': layer, 'token_id': w.id,
                       'span_id': sp.id if sp else None, 'value': want, 'field': 'form',
                       'document_id': doc.id, 'ref': ref,
                       'label': f'form "{w.form}" → "{form}"'})
    ws.add_ops(staged)
    return (f'Planned respelling "{token.surface}" in s{sentence.index} as '
            + ' + '.join(f'"{f}"' for f in forms)
            + '. Its words keep their annotation and dependencies: only their forms change.')


def apply_set_words(op: Dict[str, Any], b, stamp) -> List[str]:
    """The reshape's words themselves, and the token's own form. Returns the
    ids the words are made under, which the spans on them name
    (``finish_set_words``, which the executor calls right after, in the same
    change).
    """
    forms, surface = op['forms'], op.get('surface') or ''
    if op.get('existing_word_ids'):
        b.add(lambda batch, ids=list(op['existing_word_ids']): batch.tokens.bulk_delete(ids))
    # The words carry the plan's provenance, as a parser's syntactic words
    # carry its own (the substrate token above them carries none).
    prov = stamp()
    words = [b.new_id() for _ in forms]
    b.add(lambda batch, o=op: batch.tokens.bulk_create([
        {'token_layer_id': o['word_layer_id'], 'text': o['text_id'],
         'begin': o['begin'], 'end': o['end'], 'precedence': i, 'id': word,
         **({'metadata': dict(prov)} if prov else {})}
        for i, word in enumerate(words)]))
    # A multi-word token records its own surface, the way the editor does, so
    # an export knows what to print on the range line. A token back down to one
    # word drops it again.
    if len(forms) > 1:
        b.add(lambda batch, i=op['token_id'], v=surface: batch.tokens.patch_metadata(
            i, [{'op': 'set', 'path': ['form'], 'value': v}]))
    else:
        b.add(lambda batch, i=op['token_id']: batch.tokens.patch_metadata(
            i, [{'op': 'delete', 'path': ['form']}]))
    return words


def finish_set_words(op: Dict[str, Any], words: List[str], b, stamp) -> None:
    """The Form and Lemma spans on the words ``set_words`` creates, each
    naming its word by the id it is made under, in the same batch."""
    forms, surface = op['forms'], op.get('surface') or ''
    for word, form in zip(words, forms):
        # A Form span exists only where the form is not the token's own text:
        # one word spelled like its token needs none, and reads fall back to
        # the text. Every word gets a lemma, seeded from its form.
        if len(forms) > 1 or form != surface:
            b.add(lambda batch, o=op, w=word, v=form, i=b.new_id(): batch.spans.bulk_create(
                [{'span_layer_id': o['form_layer_id'], 'tokens': [w], 'value': v,
                  'metadata': stamp() or None, 'id': i}]))
        b.add(lambda batch, o=op, w=word, v=form, i=b.new_id(): batch.spans.bulk_create(
            [{'span_layer_id': o['lemma_layer_id'], 'tokens': [w], 'value': v,
              'metadata': dict(LEMMA_FROM_FORM), 'id': i}]))
