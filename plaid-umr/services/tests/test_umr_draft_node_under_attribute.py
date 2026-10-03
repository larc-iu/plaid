"""A node under a relation that takes a value (a list item, an attribute with
a closed set, ``:wiki``, a name's ``:opN``, ``:ARG2`` of have-polarity-91) is
refused in a model's reply with the words the app's Text mode and the
assistant use, rather than drafted and reported by Validation after."""

import pathlib

import pytest
from plaid_client import testing as servicetest

SERVICES = pathlib.Path(__file__).resolve().parent.parent

umr = servicetest.load_service(SERVICES / 'umr_draft_llm.py')


@pytest.mark.parametrize('parent, rel, why', [
    ('eat-01', ':aspect', "eat-01: ':aspect' takes a value, not a node."),
    ('eat-01', ':li', "eat-01: ':li' takes a value, not a node."),
    ('eat-01', ':refer-number', "eat-01: ':refer-number' takes a value, not a node."),
    ('have-polarity-91', ':ARG2', "have-polarity-91: ':ARG2' takes a value, not a node."),
    ('name', ':op1', "name: ':op1' takes a value, not a node."),
])
def test_a_node_under_a_relation_that_takes_a_value_is_refused(parent, rel, why):
    graph = umr.parse_penman(f'(v1 / {parent} {rel} (v2 / thing))')
    assert umr.validate_graph(graph) == why


@pytest.mark.parametrize('parent, rel', [('eat-01', ':mod'), ('eat-01', ':polarity'),
                                         ('eat-01', ':quant'), ('and', ':op1'),
                                         ('have-quant-91', ':ARG2')])
def test_a_node_under_a_relation_that_takes_one_is_drafted(parent, rel):
    graph = umr.parse_penman(f'(v1 / {parent} {rel} (v2 / thing))')
    assert umr.validate_graph(graph) is None
