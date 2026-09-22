"""What the Python reader makes of a document the UMR app has not healed.

RULED (Luke, 2026-09-20): reconcile-on-open is NOT ported to Python. It does
not need to be, and these tests are why.

`planUnalignedHeal` (plaid-umr/src/domain/umrReconcile.js) touches ONLY a node
aligned to no word, which is the kind that records the sentence it belongs to
(`umr.sentence`). It does three things: rebinds a node whose recorded sentence
token is gone, puts an anchor back over the sentence it drifted off, and
removes a node left outside every sentence.

The reader here never consults that record. It places a node by where its
anchor BEGINS (`sentence_of(pieces[0].begin)` in project.py), which is the
same answer a rebind would arrive at, and a node that begins inside no
sentence is simply attached to none, which is what a remove leaves behind. So
an unhealed document reads the same as a healed one, and the app still heals
it the moment somebody opens it.

The one case both sides would get wrong is an anchor whose begin has drifted
into a NEIGHBOURING sentence. Core moves a token with the text it covers, so
that takes a sentence boundary moving across a stale anchor, and the node is
misplaced by one sentence until the app is opened. Left alone deliberately:
healing it here means a second copy of the rule in a second language, which is
the thing the ruling refuses.
"""

import copy

import pytest

from umr_fixtures import document_raw, umr_client, umr_ws

from plaid_agent.umr.diff import round_trip


CONCEPTS = 'm-concept'
NODES = 'm-node'
# The fixture's sentences: 1 is 0-17, 2 is 17-31, and the body ends at 31.
SENT_2 = (17, 31)


def _with_unaligned(anchor, record):
    """The fixture document plus one node aligned to no word: an anchor over
    `anchor` and a `umr.sentence` record of `record`."""
    doc = copy.deepcopy(document_raw())
    layers = doc['text_layers'][0]['token_layers']
    node_layer = next(t for t in layers if t['id'] == NODES)
    node_layer['tokens'].append({'id': 'mn-x', 'begin': anchor[0], 'end': anchor[1]})
    concepts = next(sl for sl in node_layer['span_layers'] if sl['id'] == CONCEPTS)
    concepts['spans'].append({
        'id': 'mc-x', 'value': 'person', 'tokens': ['mn-x'],
        'metadata': {'umr': {'var': 's2p', 'attrs': [], 'sentence': record}}})
    return doc


def _load(doc):
    return umr_ws(umr_client(documents={'umr1': doc})).doc('Story')


def _node(document, var):
    for sentence in document.sentences:
        for node in sentence.nodes:
            if node.var == var:
                return sentence, node
    return None, None


def test_a_node_whose_recorded_sentence_is_gone_is_placed_by_its_anchor():
    """A boundary taken away and put back leaves the sentence under a NEW
    token, so the record names one that no longer exists. That is what the
    app's rebind repairs, and what reading by position never needed."""
    document = _load(_with_unaligned(SENT_2, 'ms-DELETED'))
    sentence, node = _node(document, 's2p')
    assert sentence is not None and sentence.index == 2
    assert node.pieces[0].begin == 17


def test_a_node_standing_over_its_whole_sentence_is_aligned_to_no_word():
    """What says a node is aligned to nothing is the sentence it records, not
    its anchor's width: the anchor covers the whole sentence, so reading the
    width would align the node to every word of it and the model would be told
    a node is about words nobody put it on."""
    document = _load(_with_unaligned(SENT_2, 'ms-2'))
    _sentence, node = _node(document, 's2p')
    assert node.aligned is False
    assert node.alignment == []


def test_a_node_whose_anchor_drifted_off_its_sentence_stays_in_it():
    """An anchor that no longer covers exactly its sentence is what the app's
    resize puts back. Placement reads the begin alone, so it is unaffected."""
    document = _load(_with_unaligned((17, 25), 'ms-2'))
    sentence, _node_ = _node(document, 's2p')
    assert sentence is not None and sentence.index == 2


def test_a_node_outside_every_sentence_belongs_to_none_and_reads_fine():
    """What the app's remove takes away. Here it lands in no sentence, which
    is the same thing every reader downstream sees, and nothing raises."""
    document = _load(_with_unaligned((40, 40), 'ms-2'))
    sentence, _node_ = _node(document, 's2p')
    assert sentence is None
    # The rest of the document still reads: a stray is ignored, not fatal.
    assert [s.index for s in document.sentences] == [1, 2]
    assert sorted(n.var for n in document.sentences[0].nodes) == ['s1b', 's1d']


@pytest.mark.parametrize('anchor', [SENT_2, (17, 25), (40, 40)])
def test_an_unhealed_document_still_renders_its_penman(anchor):
    """The read every tool is built on, over each of the three shapes."""
    document = _load(_with_unaligned(anchor, 'ms-DELETED'))
    assert '(s2r / run-01' in round_trip(document, document.sentences[1])
