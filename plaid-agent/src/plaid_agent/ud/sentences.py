"""Where one sentence ends and the next begins.

Mirrors ``ConlluDocument.toggleSentenceBoundary``, which is the single gesture
the editor offers: a sentence boundary at a character position is either there
or not, and clicking a token toggles it. Splitting and merging are that one
operation seen from two sides, so they are built from it rather than beside it.

**A dependency relation never spans a sentence.** This app declares that as a
layer rule on both relation layers (the relation's ends lie in one sentence),
and where the rule is declared the server keeps it: a split deletes every
relation it would leave across the new boundary, in the split's own
transaction, whoever makes the split and just as silently as the editor's. The
alternative, listing them for approval, was considered and turned down: the
editor does it without asking and two answers to the same gesture is worse
than one. What is found here is what the card counts.

**Where the rule is not declared yet** (a project the app has not opened since
the rules existed), nothing on the server deletes them, and the card would
promise what the plan does not do. So the plan deletes, in the split's own
batch and before it, the crossing rows of each relation layer that declares no
rule keeping its relations inside a sentence, and leaves the rest to the
server. The plan does not declare the rule itself: a plan changes the
document, never the project's configuration.

**In BOTH relation layers.** An edge across two sentences is invalid data
whichever layer holds it, and the editor asks the same question of both (its
`relationsCrossing` reads `allDependencyRelations`, plaid-ud
``utils/udReconcile.js``). Removing them is a consequence of the split, not
the assistant authoring the enhanced graph, so it is no exception to the
enhanced layer being read-only to the assistant's own operations (ruled
2026-09-21). An extra edge is an arc, so it is counted in what the card says
goes; a suppressor (``crossing_suppressors``) is a statement about the basic
relation under it and is not.

Finding them is per sentence, which is all a split needs: a head is stored as
the CoNLL-U id of another word in the SAME sentence, in DEPS as in HEAD, so
the relations a cut can orphan are exactly the ones inside the sentence being
cut. One whose head points nowhere is left alone rather than guessed at.
"""

from typing import Any, Dict, List, Optional

from ..core.loss import _ancestor_layer, _token_layers, other_layers_crossing
from ..core.refs import clip
from .project import Sentence, UdDoc, Word, resolve, word_ref
from .tools import ToolError, Workspace, resolve_in


def _sentence_of(doc: UdDoc, thing) -> Sentence:
    if isinstance(thing, Sentence):
        return thing
    token = thing.token if isinstance(thing, Word) else thing
    return next(s for s in doc.sentences if any(t is token for t in s.tokens))


def _crossing_words(sentence: Sentence, char_pos: int):
    """Every word of ``sentence`` whose basic relation a boundary at
    ``char_pos`` would leave spanning two sentences.

    A word covers the whole of its surface token (the full-width rule), so
    where a word begins is where its token begins. The root is a self-relation
    (head 0) and crosses nothing.
    """
    for w in sentence.words:
        if not w.relation_id or not w.head:
            continue  # no relation, or head 0: the root
        head = sentence.word(w.head)
        if head is None:
            continue  # a head pointing nowhere
        if (w.token.begin < char_pos) != (head.token.begin < char_pos):
            yield w


def crossing_relations(sentence: Sentence, char_pos: int) -> List[str]:
    """Every dependency relation in ``sentence`` that a boundary at
    ``char_pos`` would leave spanning two sentences: the tree's, then the
    enhanced layer's EXTRA edges.

    Both layers, because an edge across two sentences is invalid data whichever
    one holds it, and the editor asks the same question of both (its
    `relationsCrossing` reads `allDependencyRelations`, plaid-ud
    ``utils/udReconcile.js``). An extra edge is an arc of its own, so it is
    counted in what the card says goes, unlike a suppressor
    (``crossing_suppressors``).
    """
    return ([w.relation_id for w in _crossing_words(sentence, char_pos)]
            + _crossing_extras(sentence, char_pos))


def _crossing_extras(sentence: Sentence, char_pos: int) -> List[str]:
    """The enhanced layer's extra edges a boundary at ``char_pos`` would leave
    spanning two sentences.

    An extra edge is a row of the enhanced layer with a head of its own, so
    each is asked separately rather than through the word's basic relation. The
    same two conservatisms as the tree: a self-relation (head 0) is on one side
    by definition, and an end that resolves to no word is left alone.
    """
    out = []
    for w in sentence.words:
        for head, rel_id in w.extra_edges:
            if not head:
                continue  # head 0: a self-relation
            source = sentence.word(head)
            if source is None:
                continue  # a head pointing nowhere
            if (w.token.begin < char_pos) != (source.token.begin < char_pos):
                out.append(rel_id)
    return out


def crossing_suppressors(doc: UdDoc, sentence: Sentence, char_pos: int) -> List[str]:
    """Every suppressor of the enhanced layer that a boundary at ``char_pos``
    would leave spanning two sentences.

    Asked of the suppressor ROWS themselves, not of the basic relations under
    them. A suppressor has two ends of its own, a pair of lemma spans, and the
    cut can put them in different sentences whether or not a basic relation
    still stands under them. Reaching them through the crossing basic relation
    saw only the ones a relation covers, and a DANGLING suppressor (a
    re-pointed head, a re-parse, a rewrite rule: none of them knows it is
    there) has no such cover, so it was exactly the kind the split left
    behind. This is what the editor does: its `relationsCrossing` asks
    `allDependencyRelations`, which is both layers' rows, suppressors included
    (plaid-ud ``utils/udReconcile.js``).

    It belongs to the pair it lies over and goes with it: left behind it
    suppresses nothing, and it quietly suppresses the next relation drawn over
    the same pair, which a person then sees born faded with nothing on screen
    saying why. Reconcile-on-open catches what anyone else leaves, and it only
    runs on an OPEN: the panel is app chrome, so the document can be open
    across a plan, and merging the two sentences back puts the pair within one
    sentence again with the stale suppressor still over it.

    Every row over a crossing pair goes, since nothing stops a writer leaving
    two over one pair, and the editor's walk sees each row.

    Both ends are resolved among the words of the sentence being cut, by lemma
    span, with the same conservatism as the tree: an end that is not one of
    them is left alone, and a self-relation is on one side by definition.
    """
    word_of = {w.fields['lemma'].id: w for w in sentence.words if w.fields.get('lemma')}
    out = []
    for (source_span, target_span), rel_ids in doc.suppressors.items():
        source, target = word_of.get(source_span), word_of.get(target_span)
        if source is None or target is None or source is target:
            continue
        if (target.token.begin < char_pos) != (source.token.begin < char_pos):
            out.extend(rel_ids)
    return out


def keeps_inside(raw: Dict[str, Any], relation_layer_id: Optional[str], sentence_layer_id: str) -> bool:
    """Whether the relation layer ``relation_layer_id`` declares, under any
    namespace, a rule keeping its relations inside one sentence: then the
    server deletes what a split leaves across the cut, and otherwise nothing
    does. Read off the document as the server returns it, which carries each
    layer's rules."""
    for tl in _token_layers(raw):
        for sl in tl.get('span_layers') or []:
            for rl in sl.get('relation_layers') or []:
                if rl.get('id') == relation_layer_id:
                    return any(_ancestor_layer(c) == sentence_layer_id
                               for lst in (rl.get('constraints') or {}).values()
                               if isinstance(lst, list) for c in lst)
    return False


def _starts_already(doc, sentence, ref: str) -> str:
    """The refusal for a cut where a sentence already begins, saying where the
    sentence CAN be cut, or that it cannot be at all."""
    out = f'{ref} already starts sentence s{sentence.index}, so a boundary is there already.'
    later = sentence.tokens[1:]
    if not later:
        out += (f' s{sentence.index} is one token ("{clip(sentence.tokens[0].surface)}"), and a sentence '
                f'begins only where a token does, so it cannot be cut.')
    else:
        t = later[0]
        out += (f' To cut s{sentence.index} in two, name the word the second part starts at, e.g. '
                f's{sentence.index}.w{t.words[0].index} ("{clip(t.words[0].form)}").')
    if sentence.index > 1:
        out += f' To join s{sentence.index} onto s{sentence.index - 1} instead, use merge_sentences.'
    return out


def t_split_sentence(ws: Workspace, document: str = None, ref: str = None) -> str:
    """PLAN: start a new sentence at the named word."""
    doc = ws.doc(document)
    from .tools import _boundary_can_still_move, _guards
    _guards(ws, doc)
    _boundary_can_still_move(ws, doc)
    thing = resolve_in(ws, doc, ref)
    if not isinstance(thing, Word):
        raise ToolError(f'{ref} names a sentence or a multi-word token. Name the WORD the new '
                        f'sentence should start at, like "s3.w5".')
    sentence = _sentence_of(doc, thing)
    # The sentence layer is a gap-free partition, so a sentence owns the
    # whitespace before its first word and `sentence.begin` is often one or
    # more characters short of it. Comparing the two begins let a split through
    # at the first word, which planned a sentence holding no words at all,
    # plus a renumber of everything after it. Identity is what the question
    # actually asks.
    if thing.token is sentence.tokens[0]:
        raise ToolError(_starts_already(doc, sentence, ref))
    # Every word of a multi-word token shares that token's begin (the
    # full-width rule), so a cut "before w3" of the token w2-3 really falls
    # before w2. Planning it would renumber the document against a description
    # that is not what happens, and the user approves that description.
    if len(thing.token.words) > 1 and thing is not thing.token.words[0]:
        first = thing.token.words[0]
        raise ToolError(f'{ref} is inside the multi-word token "{thing.token.surface}", and a '
                        f'sentence cannot begin inside one. The nearest place a sentence can '
                        f'start is before "{first.form}" (w{first.index}).')

    basic = [w.relation_id for w in _crossing_words(sentence, thing.token.begin)]
    extras = _crossing_extras(sentence, thing.token.begin)
    suppressors = crossing_suppressors(doc, sentence, thing.token.begin)
    losing = basic + extras
    # What the same cut takes on the document's other layers, which this
    # assistant does not read: core's rule deletes those relations in the
    # split's own transaction, and the card names them, as the Text Editor's
    # question does (REV-N5-APPS R9). The whole document is read for it.
    full = ws.client.documents.get(doc.id, include_body=True)
    others = other_layers_crossing(full, ws.project.sentence_layer_id, sentence.id,
                                   thing.token.begin, skip_layer_ids=(ws.project.word_layer_id,))
    # The crossing rows of a layer with no rule declared against them, which
    # nothing but the plan deletes.
    sent_layer = ws.project.sentence_layer_id
    own = [] if keeps_inside(full, ws.project.relation_layer_id, sent_layer) else list(basic)
    if not keeps_inside(full, ws.project.enhanced_relation_layer_id, sent_layer):
        own += extras + suppressors
    ws.add_op({
        'kind': 'split_sentence',
        'document_id': doc.id,
        'sentence_id': sentence.id,
        'char_pos': thing.token.begin,
        # The sentence's extent as read: the cut moves with the sentence when
        # an edit before it has moved it (core.fingerprint, `token_at`).
        'token_at': {'begin': sentence.begin, 'end': sentence.end},
        'ref': ref,
        # Every dependency relation the cut would leave spanning two sentences,
        # the tree's and the enhanced layer's extra edges alike. All arcs, so
        # all counted.
        'relation_ids': losing,
        # A suppressor is no arc of its own, so it is not counted: it stands
        # over one of `losing` and goes with it.
        'suppressor_ids': suppressors,
        # Those of them on a layer that declares no rule keeping relations
        # inside a sentence: the plan deletes these itself.
        'delete_relation_ids': own,
        # The other layers' relations the cut deletes, which the card counts
        # as annotations, naming no layer.
        'other_relation_ids': others,
        'label': f'split s{sentence.index} before "{thing.form}" ({ref})',
    })
    lost = f', dropping {len(losing)} dependency relation(s) that would cross it' if losing else ''
    if others:
        lost += f'{" and" if losing else ", dropping"} {len(others)} annotation(s) of other layers that would cross it'
    return (f'Planned: s{sentence.index} splits before "{thing.form}"{lost}. '
            f'Sentences after it renumber.')


def _root_of(sentence) -> Optional[Word]:
    return next((w for w in sentence.words if w.relation_id and w.head == 0), None)


def _merged_root_op(ws: Workspace, doc, before, sentence, root_head, root_deprel) -> Optional[Dict[str, Any]]:
    """A sentence has one root, and two sentences joined would have two. When
    both have one, the merge names where one of them goes: ``root_head``, a
    word of either sentence, takes the OTHER sentence's root as its dependent
    with ``root_deprel``. Staged with the merge as one head write
    (``with_merge``): its ids name the same words before and after."""
    from .tools import refuse_virtual
    roots = [_root_of(before), _root_of(sentence)]
    if root_head is None and not root_deprel:
        if all(roots):
            raise ToolError(
                f's{before.index} and s{sentence.index} each have a root ("{roots[0].form}" and '
                f'"{roots[1].form}"), and a sentence has one. Say where one of them goes: root_head (a word of '
                f'one sentence, e.g. s{before.index}.w{roots[0].index}) takes the other sentence\'s root as '
                f'its dependent, with root_deprel.')
        return None
    if not all(roots):
        raise ToolError('root_head and root_deprel are for two sentences that each have a root, and these do not.')
    deprel = (root_deprel or '').strip()
    if not deprel or deprel == 'root':
        raise ToolError('Give root_deprel: the relation the demoted root takes to root_head (not "root").')
    head = resolve(doc, str(root_head))
    if not isinstance(head, Word):
        raise ToolError(f'{root_head} is not a word. Name the word the other root attaches to, like '
                        f'"s{before.index}.w1".')
    if head in before.words:
        dependent, head_sentence = roots[1], before
    elif head in sentence.words:
        dependent, head_sentence = roots[0], sentence
    else:
        raise ToolError(f'{root_head} is in neither s{before.index} nor s{sentence.index}.')
    refuse_virtual(head, str(root_head))
    lemma, head_lemma = dependent.fields.get('lemma'), head.fields.get('lemma')
    stale = [dependent.suppressor_id,
             doc.suppressor_over(head_lemma.id if head_lemma else None, lemma.id if lemma else None)]
    other = sentence if head_sentence is before else before
    return {'kind': 'set_head', 'word_id': dependent.id, 'head_id': head.id,
            'lemma_layer_id': ws.project.layer('lemma'), 'relation_layer_id': ws.project.relation_layer_id,
            'word_form': dependent.form, 'head_form': head.form,
            'lemma_span_id': lemma.id if lemma else None,
            'head_lemma_span_id': head_lemma.id if head_lemma else None,
            'relation_id': dependent.relation_id, 'deprel': deprel, 'document_id': doc.id,
            'suppressor_ids': [i for i in dict.fromkeys(stale) if i],
            'with_merge': sentence.id,
            'label': f'{word_ref(other, dependent)} ("{dependent.form}") {deprel} of '
                     f'{word_ref(head_sentence, head)} ("{head.form}"), so the joined sentence has one root',
            'ref': word_ref(other, dependent)}


def merge_op(ws: Workspace, doc, ref: str):
    """``(op, before, sentence)``: the merge of the sentence ``ref`` names
    onto the one before it, the write the editor's boundary toggle makes."""
    from .tools import _boundary_can_still_move, _guards
    _guards(ws, doc)
    _boundary_can_still_move(ws, doc)
    sentence = _sentence_of(doc, resolve(doc, ref))
    if sentence.index == 1:
        raise ToolError('s1 has nothing before it to join. Name the SECOND of the two sentences, '
                        'so s3 joins s2 and s3 into one.')
    before = doc.sentences[sentence.index - 2]
    op = {'kind': 'merge_sentences', 'document_id': doc.id, 'sentence_id': sentence.id,
          'previous_id': before.id, 'ref': ref, 'label': f'merge s{before.index} and s{sentence.index}'}
    # A sentence with no words between the two has no number, and the merge
    # takes it in, as the editor's boundary toggle does.
    between = [i for i, b, e in doc.wordless if before.end <= b and e <= sentence.begin]
    if between:
        op['between_ids'] = between
    return op, before, sentence


def t_merge_sentences(ws: Workspace, document: str = None, ref: str = None, root_head=None,
                      root_deprel: str = None) -> str:
    """PLAN: join the named sentence onto the one before it."""
    doc = ws.doc(document)
    op, before, sentence = merge_op(ws, doc, ref)
    root_op = _merged_root_op(ws, doc, before, sentence, root_head, root_deprel)
    # Merging only widens a sentence, so no arc becomes invalid. Its roots are
    # the one rule it can break, settled above.
    ws.add_ops([op] + ([root_op] if root_op else []))
    return (f'Planned: s{before.index} and s{sentence.index} become one sentence'
            + (f', and {root_op["label"]}' if root_op else '') + '. Sentences after them renumber.')


def apply_split_sentence(op: Dict[str, Any], b, stamp) -> None:
    """The split, after the crossing rows of any layer that declares no rule
    against them (``delete_relation_ids``). The relations it leaves across the
    new boundary on a layer that does declare one (and so the suppressors over
    them, which are rows of the enhanced layer) are the server's to delete, in
    the split's own transaction, read from what is stored when the split runs,
    so one drawn after the plan was made goes too. ``relation_ids`` and
    ``suppressor_ids`` are what the card counts.

    The plan's own deletes go first and in bulk. First, so a rule declared
    between the plan and its approval finds nothing left to delete rather
    than deleting a row the plan deletes after it. In bulk, because a bulk
    delete skips an id already gone, where a single delete of one fails the
    whole batch.
    """
    if op.get('delete_relation_ids'):
        b.add(lambda batch, ids=list(op['delete_relation_ids']): batch.relations.bulk_delete(ids))
    b.add(lambda batch, o=op: batch.tokens.split(o['sentence_id'], o['char_pos'], id=b.new_id()))


def apply_merge_sentences(op: Dict[str, Any], b, stamp) -> None:
    for joined in list(op.get('between_ids') or []) + [op['sentence_id']]:
        b.add(lambda batch, o=op, j=joined: batch.tokens.merge(o['previous_id'], j))
