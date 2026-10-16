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


from ..core.bidi import qv
from ..core.refs import clip
from .project import LEMMA_FROM_FORM, Token, UdDoc, Word, visible, word_ref
from .tools import ToolError, Workspace, resolve_in


def _token_of(ws: Workspace, doc: UdDoc, ref: str) -> Token:
    thing = resolve_in(ws, doc, ref)
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
    from .tools import refuse_virtual
    for w in token.words:
        refuse_virtual(w, ref)
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
    if len(clean) > 1 and any(c.isspace() for c in token.surface):
        # Ten words for a token whose text held two lines, where the user
        # wanted ten tokens (2026-10-12 survey).
        raise ToolError(f'"{visible(token.surface)}" in s{sentence.index} holds whitespace, so this would make '
                        f'it ONE multi-word token of {len(clean)} words, not {len(clean)} tokens. Nothing was '
                        f'planned. To make tokens of it, use split_token on s{sentence.index}.{token.ref_range}.')

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
    # Quoted as every other plan line quotes a value (core.bidi), never as
    # Python's repr, which changed the marks with the value.
    becomes = (f'{qv(token.surface)} becomes ' + ' + '.join(qv(f) for f in clean)
               if len(clean) > 1 else f'{qv(token.surface)} becomes one word {qv(clean[0])}')

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
                       'label': f'form {qv(w.form)} → {qv(form)}'})
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
                  'metadata': stamp(), 'id': i}]))
        b.add(lambda batch, o=op, w=word, v=form, i=b.new_id(): batch.spans.bulk_create(
            [{'span_layer_id': o['lemma_layer_id'], 'tokens': [w], 'value': v,
              'metadata': dict(LEMMA_FROM_FORM), 'id': i}]))


# --- splitting a token into tokens ----------------------------------------------
#
# The other reshape a UD annotator needs: one surface token that should be
# several, a token whose text holds a space, or a multi-word token made where
# separate tokens were meant. It does what the Text Editor's split does when a
# space is typed inside a token (core's `split-spaced-words`): the token keeps
# its row on the part holding most of its letters (the first on a tie), and its
# words go with it, every value and dependency on them included. A multi-word
# token with as many words as parts deals them out instead, one to each part in
# order, so undoing a multi-word token built by mistake loses nothing. Each part
# left without a word gets a new word with no annotation.

def _letters(text: str) -> int:
    return sum(1 for c in text if not c.isspace())


def _pieces(surface: str, parts) -> List[tuple]:
    """``(begin, end)`` within ``surface`` of each part, in order. Without
    parts, the runs between its spaces."""
    import re
    if parts is None or parts == []:
        found = [(m.start(), m.end()) for m in re.finditer(r'\S+', surface)]
        if len(found) < 2:
            raise ToolError(f'"{visible(surface)}" holds no space to split at. Give parts: the new tokens\' '
                            'texts in order, e.g. ' + _example(surface) + '.')
        return found
    if isinstance(parts, str):
        parts = [parts]
    texts = [p.strip() for p in parts if isinstance(p, str) and p.strip()]
    if len(texts) < 2:
        raise ToolError('Give parts: two or more texts that spell the token in order, e.g. '
                        + _example(surface) + '.')
    out, at = [], 0
    for p in texts:
        while at < len(surface) and surface[at].isspace():
            at += 1
        if not surface.startswith(p, at):
            done = surface[:at].strip()
            rest = surface[at:].strip()
            raise ToolError(f'The parts must spell "{visible(surface)}" in order, without the spaces '
                            f'between them. ' + (f'After "{visible(done)}" comes ' if done else 'It starts ')
                            + f'"{visible(clip(rest))}", not "{visible(p)}". Nothing was planned.')
        out.append((at, at + len(p)))
        at += len(p)
    if surface[at:].strip():
        raise ToolError(f'The parts leave out "{visible(surface[at:].strip())}" at the end of '
                        f'"{visible(surface)}". Every letter goes in a part. Nothing was planned.')
    return out


def _example(surface: str) -> str:
    text = surface.strip()
    if len(text.split()) > 1:
        return '[' + ', '.join(f'"{visible(w)}"' for w in text.split()) + ']'
    if len(text) < 2:
        return '["can", "not"] for "cannot"'
    cut = len(text) // 2
    return f'["{text[:cut]}", "{text[cut:]}"]'


def t_split_token(ws: Workspace, document: str = None, ref: str = None, parts=None) -> str:
    from .tools import _guards, refuse_virtual
    doc = ws.doc(document)
    _guards(ws, doc)
    if not ref:
        raise ToolError('Give ref: the token, "s3.w2", or "s3.w2-3" for a multi-word token.')
    token = _token_of(ws, doc, ref)
    for w in token.words:
        refuse_virtual(w, ref)
    sentence = next(s for s in doc.sentences if any(t is token for t in s.tokens))
    pieces = _pieces(token.surface, parts)
    texts = [token.surface[x:y] for x, y in pieces]
    words = list(token.words)
    dealt = len(words) > 1 and len(words) == len(pieces)
    sizes = [_letters(t) for t in texts]
    keep = sizes.index(max(sizes))
    home = list(range(len(words))) if dealt else [keep] * len(words)
    new_parts = [i for i in range(len(pieces)) if i not in home]

    after = []
    for i, text in enumerate(texts):
        mine = [w for w, h in zip(words, home) if h == i]
        # A word with no Form span reads its token's text, which is now its part's.
        after += ([((w.fields['form'].value if w.fields.get('form') and w.fields['form'].value else text), w.id)
                   for w in mine] if mine else [(text, None)])
    held = len([h for h in home if h == keep])
    meta = None
    if not dealt and held > 1:
        meta = ('set', texts[keep])
    elif 'form' in (token.metadata or {}):
        meta = ('delete', None)

    # A Form span is the one value a split most surely leaves wrong: it
    # spelled the whole token, and the kept part is now shorter.
    stale_forms = [] if dealt else [w.value('form') for w in words
                                    if w.value('form') and w.value('form') != texts[keep]]
    where = f's{sentence.index}.{token.ref_range}'
    shown = ' | '.join(qv(t) for t in texts)
    if dealt:
        what = 'each word on its own token, with its values and dependencies'
    else:
        many = len(words) > 1
        whose = f'its {len(words)} words' if many else f'its word {word_ref(sentence, words[0])}'
        forms = ', '.join(qv(f) for f in stale_forms)
        spelt = (f'{"forms" if len(stale_forms) > 1 else "form"} {forms}, ' if stale_forms else '')
        what = f'{qv(texts[keep])} keeps {whose} with {"their" if many else "its"} {spelt}values and dependencies'
        if new_parts:
            what += (', ' + ', '.join(qv(texts[i]) for i in new_parts)
                     + (' gets a new word with none' if len(new_parts) == 1 else ' each get a new word with none'))
    ws.add_op({
        'kind': 'split_token', 'token_id': token.id, 'text_id': doc.text_id,
        'begin': token.begin, 'end': token.end, 'surface': token.surface,
        # Counted from the token's start, so they follow it wherever an edit
        # before it has moved it (the op's own begin and end are rebased).
        'pieces': [list(p) for p in pieces], 'keep': keep, 'dealt': dealt,
        'word_ids': [w.id for w in words], 'existing_word_ids': [w.id for w in words],
        'new_parts': new_parts,
        # The sentence's words once this runs, for the refusals that meet a
        # word it renumbers or makes (tools._after_plan).
        'forms': [f for f, _ in after], 'after_ids': [i for _, i in after],
        'word_layer_id': ws.project.word_layer_id,
        **({'form_meta': list(meta)} if meta else {}),
        'document_id': doc.id,
        'label': f'split {qv(token.surface)} into {shown} ({what})',
        'ref': where})

    out = (f'Planned splitting {where} "{visible(token.surface)}" into {len(texts)} tokens: '
           + ', '.join(f'"{visible(t)}"' for t in texts) + '. ')
    if dealt:
        out += ('Each of its words goes to its own token, in order ('
                + ', '.join(f'"{clip(w.form)}" to "{visible(texts[i])}"' for i, w in enumerate(words))
                + '), keeping its values and dependencies.')
        return out
    out += (f'"{visible(texts[keep])}" keeps ' + ('its words' if len(words) > 1 else 'its word')
            + ' and every value and dependency on ' + ('them' if len(words) > 1 else 'it') + '. ')
    if new_parts:
        out += (', '.join(f'"{visible(texts[i])}"' for i in new_parts)
                + (' gets' if len(new_parts) == 1 else ' each get') + ' a new word with no annotation. ')
    annotated = ([f'form "{clip(f)}"' for f in stale_forms]
                 + [f'{f} "{clip(w.value(f))}"' for w in words for f in ('lemma', 'upos', 'xpos', 'features')
                    if w.value(f)])
    if annotated or any(w.relation_id for w in words):
        out += (f'What {"they hold" if len(words) > 1 else "it holds"} was made for "{visible(token.surface)}"'
                + (f' ({", ".join(annotated[:6])}{", …" if len(annotated) > 6 else ""})' if annotated else '')
                + f': check it against "{visible(texts[keep])}" once this is applied.')
    return out.rstrip()


def apply_split_token(op: Dict[str, Any], b, stamp) -> None:
    """The split, as one change. The words go to their parts first, so no
    word straddles a cut and the token's split re-homes them by where they
    stand; then the token is cut at the start of each later part, keeping its
    row on part ``keep``; then each part is trimmed to its own text (the
    spaces between parts belong to no token); then the parts with no word get
    one. A batch is one transaction, and the rule that a word is as wide as its
    token holds again at its end."""
    base, end = op['begin'], op['end']
    pieces = [(base + x, base + y) for x, y in op['pieces']]
    n, keep, token = len(pieces), op['keep'], op['token_id']
    home = list(range(len(op['word_ids']))) if op.get('dealt') else [keep] * len(op['word_ids'])
    for word, i in zip(op['word_ids'], home):
        b.add(lambda batch, w=word, x=pieces[i][0], y=pieces[i][1]: batch.tokens.update(w, begin=x, end=y))
    ids = [None] * n
    ids[keep] = token
    for i in range(n - 1, keep, -1):
        ids[i] = b.new_id()
        b.add(lambda batch, p=pieces[i][0], i_=ids[i]: batch.tokens.split(token, p, id=i_))
    for i in range(keep):
        ids[i] = b.new_id()
        b.add(lambda batch, p=pieces[i + 1][0], i_=ids[i]: batch.tokens.split(token, p, id=i_, keep='right'))
    for i, (x, y) in enumerate(pieces):
        was = (base if i == 0 else x, pieces[i + 1][0] if i < n - 1 else end)
        if was != (x, y):
            b.add(lambda batch, t=ids[i], x=x, y=y: batch.tokens.update(t, begin=x, end=y))
    prov = stamp()
    made = [(i, b.new_id()) for i in op.get('new_parts') or []]
    if made:
        b.add(lambda batch: batch.tokens.bulk_create([
            {'token_layer_id': op['word_layer_id'], 'text': op['text_id'], 'begin': pieces[i][0],
             'end': pieces[i][1], 'precedence': 0, 'id': w, **({'metadata': dict(prov)} if prov else {})}
            for i, w in made]))
    meta = op.get('form_meta')
    if meta and meta[0] == 'set':
        b.add(lambda batch: batch.tokens.patch_metadata(token, [{'op': 'set', 'path': ['form'], 'value': meta[1]}]))
    elif meta:
        b.add(lambda batch: batch.tokens.patch_metadata(token, [{'op': 'delete', 'path': ['form']}]))
