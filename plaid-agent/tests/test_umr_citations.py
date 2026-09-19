"""Citations: the reference syntax, and the card one resolves to."""

import pytest

from umr_fixtures import SENTENCE_1_PENMAN, umr_ws

from plaid_agent.umr.citations import parse_refs, resolve_citations


@pytest.fixture
def ws():
    w = umr_ws()
    w.doc('Story')   # a citation is resolved against what the turn has read
    return w


# --- the syntax -----------------------------------------------------------------

def test_a_reference_is_a_sentence_or_a_node_in_one():
    assert parse_refs('s3') == ['s3']
    assert parse_refs('s3.s3e') == ['s3.s3e']


def test_a_list_marks_several_nodes_of_one_sentence():
    assert parse_refs('s3.s3e,s3p') == ['s3.s3e', 's3.s3p']
    assert parse_refs('s3.s3e, s3.s3p') == ['s3.s3e', 's3.s3p']


def test_a_variable_carries_its_own_sentence_so_a_bare_one_still_resolves():
    """The UMR convention writes the sentence number into the variable, which
    is what lets a part that names no sentence still say where it is."""
    assert parse_refs('s5e') == ['s5.s5e']
    # And it beats what the part before it said, because the variable is data
    # and the continuation is a convenience.
    assert parse_refs('s3.s3e,s5p') == ['s3.s3e', 's5.s5p']


def test_nonsense_is_dropped_rather_than_turned_into_a_neighbour():
    assert parse_refs('') == []
    assert parse_refs('s3.s3e,,') == ['s3.s3e']
    assert parse_refs(':ARG0') == []


# --- the card --------------------------------------------------------------------

def test_a_citation_resolves_to_the_sentence_with_its_words_and_its_graph(ws):
    cards = resolve_citations(ws, 'Here: <cite doc="Story" ref="s1"/>')
    assert len(cards) == 1
    c = cards[0]
    assert c['document_name'] == 'Story'
    assert c['sentence'] == 1 and c['sentence_id'] == 'ms-1'
    assert [w['text'] for w in c['words']] == ['The', 'dog', 'barked', '.']
    assert c['penman'] == SENTENCE_1_PENMAN
    assert c['lines'][0]['header'] == 'Word Gloss'
    assert c['focus'] == []


def test_a_node_reference_marks_that_node_and_nothing_else(ws):
    c = resolve_citations(ws, '<cite doc="Story" ref="s1.s1d"/>')[0]
    assert c['focus'] == ['s1d']
    assert [n['focus'] for n in c['nodes']] == [True, False]   # s1d sorts first


def test_several_nodes_of_one_sentence_are_all_marked(ws):
    c = resolve_citations(ws, '<cite doc="Story" ref="s1.s1d,s1b"/>')[0]
    assert sorted(c['focus']) == ['s1b', 's1d']


def test_a_node_that_is_not_in_the_sentence_is_left_unmarked(ws):
    c = resolve_citations(ws, '<cite doc="Story" ref="s1.s1z"/>')[0]
    assert c['sentence'] == 1 and c['focus'] == []


def test_a_citation_naming_nothing_real_is_left_out(ws):
    assert resolve_citations(ws, '<cite doc="Story" ref="s9"/>') == []
    assert resolve_citations(ws, '<cite doc="Nowhere" ref="s1"/>') == []


def test_each_distinct_citation_appears_once_in_order_of_first_mention(ws):
    text = ('<cite doc="Story" ref="s2"/> and <cite doc="Story" ref="s1"/> '
            'and <cite doc="Story" ref="s2"/>')
    assert [c['sentence'] for c in resolve_citations(ws, text)] == [2, 1]


def test_a_bare_node_reference_resolves_when_the_turn_read_one_document(ws):
    """Sloppier models write the reference with no document at all. A lone
    sentence number is NOT read that way: it would turn every "s1" in a
    sentence of prose into an example card."""
    assert [c['sentence'] for c in resolve_citations(ws, 'compare s2.s2t here')] == [2]
    assert resolve_citations(ws, 'see s2 for this') == []


def test_the_model_may_ask_for_a_view_and_anything_else_is_ignored(ws):
    assert resolve_citations(ws, '<cite doc="Story" ref="s1" view="words"/>')[0]['view'] == 'words'
    assert resolve_citations(ws, '<cite doc="Story" ref="s1" view="canvas"/>')[0]['view'] == 'graph'
