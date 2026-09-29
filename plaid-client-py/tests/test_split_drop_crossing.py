"""tokens.split's drop_crossing_relations, as queued in a batch. The server's
side is plaid-core's split-drops-crossing-relations-test, the JS side
``plaid-client-js/test/splitDropCrossing.test.js``."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def test_split_sends_drop_crossing_relations_only_when_given():
    b = PlaidClient('http://localhost:0', 'dummy-token').batch()
    b.tokens.split('T', 13)
    b.tokens.split('T', 13, drop_crossing_relations=['R1', 'R2'])
    assert b.operations[0]['body'] == {'position': 13}
    assert b.operations[1]['body'] == {'position': 13, 'drop-crossing-relations': ['R1', 'R2']}
    b.abort()
