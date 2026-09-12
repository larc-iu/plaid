"""What in a document is waiting for review, and what a review does to it.

Shared by the tools (which count and name it) and the plan (which finds it
again at approval): a whole-document confirm or discard is stored as a
SCOPE, the document and the fields, not as one op per span. A document with
1300 words and four columns is over five thousand spans, and a plan that
named each of them was too large for the conversation record to hold. The
plan already pins the version of every document it touches, and approval
refuses a plan whose document has moved on, so what is found at approval is
what the model counted.
"""

from typing import Dict, List, Optional, Tuple

from plaid_client.provenance import prov_state

from .project import Sentence, UdDoc, Word

FIELDS = ('lemma', 'upos', 'xpos', 'features')
REVIEW_FIELDS = FIELDS + ('deprel',)
WAITING = ('machine', 'contributed')


def reviewable(w: Word, field: str):
    """(span, state) for a field whose value is waiting for review, else None."""
    sp = w.fields.get(field)
    if not sp or not sp.value:
        return None
    state = prov_state(sp.metadata)
    return (sp, state) if state in WAITING else None


def relation_waiting(w: Word) -> Optional[str]:
    """The provenance state of the word's head, when it is waiting for review."""
    if not w.relation_id:
        return None
    state = prov_state(w.relation_metadata)
    return state if state in WAITING else None


def vouched_arc_hangs_on(sentence: Sentence, w: Word) -> bool:
    """True when a relation nobody has to re-check anchors on this word's lemma
    span, either as the dependent's end or as the head's."""
    if w.relation_id and prov_state(w.relation_metadata) != 'machine':
        return True
    return any(o.relation_id and o.head == w.index
               and prov_state(o.relation_metadata) != 'machine'
               for o in sentence.words)


def confirm_targets(words: List[Tuple[Sentence, Word]], fields) -> List[tuple]:
    """``(sentence, word, field, span_id|None, relation_id|None)`` for every
    value among ``words`` that a confirmation reaches."""
    out = []
    for sentence, w in words:
        for f in fields:
            if f == 'deprel':
                continue
            hit = reviewable(w, f)
            if hit:
                out.append((sentence, w, f, hit[0].id, None))
        if 'deprel' in fields and relation_waiting(w):
            out.append((sentence, w, 'deprel', None, w.relation_id))
    return out


def discard_targets(words: List[Tuple[Sentence, Word]], fields) -> Tuple[List[tuple], int]:
    """``(sentence, word, field, span|None, relation_id|None)`` for every
    unconfirmed MACHINE value among ``words``, and how many machine lemmas
    were spared because an arc somebody vouched for hangs on them."""
    out = []
    spared = 0
    for sentence, w in words:
        for f in fields:
            if f == 'deprel':
                continue
            hit = reviewable(w, f)
            if not hit or hit[1] != 'machine':
                continue
            if f == 'lemma' and vouched_arc_hangs_on(sentence, w):
                spared += 1
                continue
            out.append((sentence, w, f, hit[0], None))
        if 'deprel' in fields and relation_waiting(w) == 'machine':
            out.append((sentence, w, 'deprel', None, w.relation_id))
    return out, spared


def per_field(targets) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for t in targets:
        counts[t[2]] = counts.get(t[2], 0) + 1
    return counts


def counts_phrase(counts: Dict[str, int]) -> str:
    return ', '.join(f'{f} {n}' for f, n in counts.items())


def all_words(doc: UdDoc) -> List[Tuple[Sentence, Word]]:
    return [(s, w) for s in doc.sentences for w in s.words]
