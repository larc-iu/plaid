"""tokens.split, as queued in a batch: the position and the id the client
minted, and nothing about relations. A relation layer that must stay inside
one token declares a same-ancestor constraint instead, and the server deletes
what a split leaves crossing (plaid-core's split-drops-crossing-relations-test,
the JS side ``plaid-client-js/test/splitDropCrossing.test.js``)."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def test_split_sends_the_position_and_the_id_only_when_given():
    b = PlaidClient('http://localhost:0', 'dummy-token').batch()
    b.tokens.split('T', 13)
    b.tokens.split('T', 13, id='N')
    assert b.operations[0]['body'] == {'position': 13}
    assert b.operations[1]['body'] == {'id': 'N', 'position': 13}
    with pytest.raises(TypeError):
        b.tokens.split('T', 13, drop_crossing_relations=['R1'])
    b.abort()
