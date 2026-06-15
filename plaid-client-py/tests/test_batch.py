"""Tests for the client.batched() context manager — the network-free paths
(empty submit + abort-on-exception). The happy submit path needs a live server
and is covered by the services' integration tests.

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
from plaid_client import PlaidClient


def _client():
    # No connection happens on construction; the network-free paths under test
    # (begin/abort + empty submit) never reach out.
    return PlaidClient('http://localhost:0', 'dummy-token')


def test_empty_block_submits_nothing_and_leaves_no_batch_open():
    c = _client()
    with c.batched() as b:
        pass  # queued nothing
    assert b.results == []
    assert c.is_batch_mode() is False


def test_exception_in_block_aborts_and_clears_batch():
    c = _client()
    with pytest.raises(ValueError):
        with c.batched():
            assert c.is_batch_mode() is True  # batch is open inside the block
            raise ValueError('boom')
    # The half-open batch must be dropped so later plain calls don't queue.
    assert c.is_batch_mode() is False
    assert c.batch_operations == []


def test_block_opens_batch_mode():
    c = _client()
    seen = {}
    with c.batched():
        seen['inside'] = c.is_batch_mode()
    assert seen['inside'] is True
    assert c.is_batch_mode() is False


if __name__ == '__main__':
    test_empty_block_submits_nothing_and_leaves_no_batch_open()
    test_exception_in_block_aborts_and_clears_batch()
    test_block_opens_batch_mode()
    print('batch tests passed')
