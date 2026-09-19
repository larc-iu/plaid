"""The PENMAN reader and writer, and the round trip through storage.

The port has to agree with plaid-umr's own reader, because the assistant's
diff compares its serialization against a text a person edited in the app. Two
readings of one graph would show up as phantom changes on a plan card.
"""

import pytest

from umr_fixtures import SENTENCE_1_PENMAN, SENTENCE_2_PENMAN, umr_ws

from plaid_agent.umr.penman import (next_variable, parse_attribute_line, parse_penman,
                                    serialize_penman, tree_edges)
from plaid_agent.umr.project import penman_of


@pytest.fixture
def ws():
    return umr_ws()


def test_the_stored_graph_serializes_to_the_text_the_app_shows(ws):
    doc = ws.doc('Story')
    assert penman_of(doc, doc.sentences[0]) == SENTENCE_1_PENMAN
    assert penman_of(doc, doc.sentences[1]) == SENTENCE_2_PENMAN


def test_the_round_trip_is_exact(ws):
    """Parse what the store writes and write it back: the same text.

    This is the property everything else rests on. A serializer that reordered
    children, or a parser that dropped an attribute, would make every
    apply_penman plan a rewrite of the whole sentence.
    """
    doc = ws.doc('Story')
    for s in doc.sentences:
        text = penman_of(doc, s)
        again = parse_penman(text)
        assert not again.errors
        assert serialize_penman(again) == text


def test_a_re_entrant_node_is_written_out_once_and_referred_to_afterwards():
    text = '(s1s / say-01\n    :ARG0 (s1p / person)\n    :ARG1 (s1w / want-01\n        :ARG0 s1p))'
    g = parse_penman(text)
    assert not g.errors
    assert sorted(g.nodes) == ['s1p', 's1s', 's1w']
    # The bare s1p is a reference, not an atom: it was defined earlier in the
    # text, and the scan of definitions is what tells the two apart.
    back = g.nodes['s1w'].children[0]
    assert (back.kind, back.value, back.inline) == ('node', 's1p', False)
    assert serialize_penman(g) == text
    # The tree edge is the FIRST visit, which is the one under say-01.
    assert ('s1s', 0) in tree_edges(g)
    assert ('s1w', 0) not in tree_edges(g)


def test_a_forward_reference_is_still_read_as_a_reference():
    """A reference may point at a node defined later in the text, so whether a
    bare token is a node or an atom cannot be decided where it is read."""
    text = '(s1s / say-01\n    :ARG0 s1p\n    :ARG1 (s1p / person))'
    g = parse_penman(text)
    assert not g.errors
    assert g.nodes['s1s'].children[0].kind == 'node'


def test_a_quoted_string_and_an_atom_are_told_apart():
    g = parse_penman('(s1c / city :wiki "New York" :quant 3)')
    assert not g.errors
    kinds = [(c.rel, c.kind, c.value) for c in g.nodes['s1c'].children]
    assert kinds == [(':wiki', 'string', '"New York"'), (':quant', 'atom', '3')]


def test_a_graph_that_cannot_be_read_comes_back_as_errors_rather_than_raising():
    g = parse_penman('(s1b / bark-01 :ARG0')
    assert any('without closing' in e.message for e in g.errors)
    g = parse_penman('not a graph')
    assert g.errors and 'opening bracket' in g.errors[0].message
    assert parse_penman('').root is None


def test_the_next_variable_follows_the_standard_rule():
    assert next_variable(3, 'dog', set()) == 's3d'
    assert next_variable(3, 'dog', {'s3d'}) == 's3d2'
    assert next_variable(3, 'dog', {'s3d', 's3d2'}) == 's3d3'
    # A concept that does not start with a lowercase letter takes `x`.
    assert next_variable(2, '-91', set()) == 's2x'


def test_an_attribute_line_is_read_with_the_graph_grammar():
    attrs, problems = parse_attribute_line(':aspect state :polarity -')
    assert not problems
    assert [(a['rel'], a['value'], a['order']) for a in attrs] == [
        (':aspect', 'state', 0), (':polarity', '-', 1)]
    assert parse_attribute_line('') == ([], [])
    # A child node is not an attribute, and saying so beats storing it as one.
    _attrs, problems = parse_attribute_line(':ARG0 (s1p / person)')
    assert problems and 'names a node' in problems[0]
