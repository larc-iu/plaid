"""vocab_items.merge and vocab_items.delete's expected_link_count, as queued
in a batch (exactly the request that would go out). The server's side is
plaid-core's vocab-item-merge-test, the JS side
``plaid-client-js/test/vocabItemMerge.test.js``."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def _queued(fn):
    client = PlaidClient('http://localhost:0', 'dummy-token')
    b = client.batch()
    fn(b)
    ops = [dict(op) for op in b.operations]
    b.abort()
    return ops


def test_merge_posts_the_losers_to_the_survivors_merge_route():
    [op] = _queued(lambda b: b.vocab_items.merge('S', ['L1', 'L2'], 'Merge'))
    assert op['method'] == 'POST'
    assert op['path'].startswith('/api/v1/vocab-items/S/merge')
    assert 'audit-message=Merge' in op['path']
    assert op['body'] == {'losers': ['L1', 'L2']}


def test_delete_sends_expected_link_count_only_when_given_zero_included():
    def go(b):
        b.vocab_items.delete('I')
        b.vocab_items.delete('I', expected_link_count=0)
        b.vocab_items.delete('I', expected_link_count=2)
    plain, zero, two = _queued(go)
    assert 'expected-link-count' not in plain['path']
    assert 'expected-link-count=0' in zero['path']
    assert 'expected-link-count=2' in two['path']
