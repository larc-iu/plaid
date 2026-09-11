"""Where one sentence ends and the next begins.

Mirrors ``ConlluDocument.toggleSentenceBoundary``, which is the single gesture
the editor offers: a sentence boundary at a character position is either there
or not, and clicking a token toggles it. Splitting and merging are that one
operation seen from two sides, so they are built from it rather than beside it.

**A dependency relation never spans a sentence.** That is this app's rule, not
the server's: nothing rejects a relation whose ends are in different
sentences, and reconcile-on-open quietly deletes them the next time someone
opens the document. So a split deletes the relations it would orphan, in the
SAME batch, exactly as the editor does and just as silently. The alternative,
listing them for approval, was considered and turned down: the editor does it
without asking and two answers to the same gesture is worse than one.

Finding them is per sentence, which is all a split needs: a head is stored as
the CoNLL-U id of another word in the SAME sentence, so the relations a cut
can orphan are exactly the ones inside the sentence being cut. One whose head
points nowhere is left alone rather than guessed at.
"""

from typing import Any, Dict, List

from .project import Sentence, UdDoc, Word, resolve
from .tools import ToolError, Workspace


def _sentence_of(doc: UdDoc, thing) -> Sentence:
    if isinstance(thing, Sentence):
        return thing
    token = thing.token if isinstance(thing, Word) else thing
    return next(s for s in doc.sentences if any(t is token for t in s.tokens))


def crossing_relations(sentence: Sentence, char_pos: int) -> List[str]:
    """The relations in ``sentence`` that a boundary at ``char_pos`` would
    leave spanning two sentences.

    A word covers the whole of its surface token (the full-width rule), so
    where a word begins is where its token begins. The root is a self-relation
    (head 0) and crosses nothing.
    """
    out = []
    for w in sentence.words:
        if not w.relation_id or not w.head:
            continue  # no relation, or head 0: the root
        head = sentence.word(w.head)
        if head is None:
            continue  # a head pointing nowhere
        if (w.token.begin < char_pos) != (head.token.begin < char_pos):
            out.append(w.relation_id)
    return out


def t_split_sentence(ws: Workspace, document: str = None, ref: str = None) -> str:
    """PLAN: start a new sentence at the named word."""
    doc = ws.doc(document)
    from .tools import _no_boundary_moved, _no_parse_planned
    _no_parse_planned(ws, doc)
    _no_boundary_moved(ws, doc)
    thing = resolve(doc, ref)
    if not isinstance(thing, Word):
        raise ToolError(f'{ref} names a sentence or a multi-word token. Name the WORD the new '
                        f'sentence should start at, like "s3.w5".')
    sentence = _sentence_of(doc, thing)
    if thing.token.begin == sentence.begin:
        raise ToolError(f'{ref} already starts sentence s{sentence.index}. Name a word inside a '
                        f'sentence, not the first one.')

    losing = crossing_relations(sentence, thing.token.begin)
    ws.ops.append({
        'kind': 'split_sentence',
        'document_id': doc.id,
        'sentence_id': sentence.id,
        'char_pos': thing.token.begin,
        'ref': ref,
        'relation_ids': losing,
        'label': f'split s{sentence.index} before "{thing.form}" ({ref})',
    })
    lost = f', dropping {len(losing)} dependency relation(s) that would cross it' if losing else ''
    return (f'Planned: s{sentence.index} splits before "{thing.form}"{lost}. '
            f'Sentences after it renumber.')


def t_merge_sentences(ws: Workspace, document: str = None, ref: str = None) -> str:
    """PLAN: join the named sentence onto the one before it."""
    doc = ws.doc(document)
    from .tools import _no_boundary_moved, _no_parse_planned
    _no_parse_planned(ws, doc)
    _no_boundary_moved(ws, doc)
    sentence = _sentence_of(doc, resolve(doc, ref))
    if sentence.index == 1:
        raise ToolError('s1 has nothing before it to join. Name the SECOND of the two sentences, '
                        'so s3 joins s2 and s3 into one.')
    before = doc.sentences[sentence.index - 2]
    # Merging only widens a sentence, so no relation can become invalid.
    ws.ops.append({
        'kind': 'merge_sentences',
        'document_id': doc.id,
        'sentence_id': sentence.id,
        'previous_id': before.id,
        'ref': ref,
        'label': f'merge s{before.index} and s{sentence.index}',
    })
    return (f'Planned: s{before.index} and s{sentence.index} become one sentence. '
            f'Sentences after them renumber.')


def apply_split_sentence(client, op: Dict[str, Any], b, stamp) -> None:
    """The split and the relations it orphans, in ONE batch.

    Together, because between the two the document holds a relation spanning
    two sentences, and reconcile-on-open would delete it on the next read
    whether or not this plan finished. Neither op refers to an id the other
    makes, which is what lets them share a batch at all.
    """
    b.add(lambda o=op: client.tokens.split(o['sentence_id'], o['char_pos']))
    for rel_id in op.get('relation_ids') or []:
        b.add(lambda i=rel_id: client.relations.delete(i))


def apply_merge_sentences(client, op: Dict[str, Any], b, stamp) -> None:
    b.add(lambda o=op: client.tokens.merge(o['previous_id'], o['sentence_id']))
