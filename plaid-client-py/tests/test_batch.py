"""Tests for client.batch() and the client.batched() context manager: the
network-free paths (empty submit, abort-on-exception, what the block is
handed). The happy submit path needs a live server and is covered by the
services' integration tests.

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError


def _client():
    # No connection happens on construction; the network-free paths under test
    # never reach out.
    return PlaidClient('http://localhost:0', 'dummy-token')


def test_empty_block_submits_nothing():
    c = _client()
    with c.batched() as b:
        pass  # queued nothing
    assert b.results == []
    assert b.open is False


def test_the_block_is_handed_a_batch_of_this_client_with_the_same_resources():
    c = _client()
    with c.batched() as b:
        assert b.client is c
        assert b.base_url == c.base_url
        assert b.tokens is not c.tokens
        assert type(b.tokens) is type(c.tokens)


def test_exception_in_block_aborts_and_nothing_is_sent():
    c = _client()
    with pytest.raises(ValueError):
        with c.batched() as b:
            b.tokens.create('tl-1', 'text-1', 0, 3)
            raise ValueError('boom')
    assert b.open is False
    assert b.operations == []
    assert b.results == []


def test_a_batch_is_not_nestable():
    c = _client()
    with pytest.raises(PlaidAPIError, match='not nestable'):
        with c.batched() as b:
            with b.batched():
                pass
    with pytest.raises(PlaidAPIError, match='not nestable'):
        c.batch().batch()


def test_a_batch_submits_or_aborts_once():
    c = _client()
    b = c.batch()
    b.abort()
    with pytest.raises(PlaidAPIError, match='already submitted or aborted'):
        b.submit()
    with pytest.raises(PlaidAPIError, match='already submitted or aborted'):
        b.tokens.create('tl-1', 'text-1', 0, 3)


def test_a_batch_over_the_server_cap_goes_as_consecutive_requests_results_in_order(monkeypatch):
    # The server caps a batch at MAX_BATCH_OPS. A larger one is sent as
    # consecutive requests with the results concatenated in queue order, so a
    # repair or bulk edit over a big document never fails on its size alone.
    import json
    from plaid_client.client import MAX_BATCH_OPS
    c = _client()
    sizes = []

    class Resp:
        ok = True
        status_code = 200

        def __init__(self, ops):
            self._ops = ops

        def json(self):
            return [{'status': 200, 'body': {'path': op['path']}} for op in self._ops]

    def fake_post(url, headers=None, data=None, timeout=None):
        ops = json.loads(data)
        sizes.append(len(ops))
        return Resp(ops)

    monkeypatch.setattr(c.session, 'post', fake_post)
    n = MAX_BATCH_OPS + 1
    with c.batched() as b:
        for i in range(n):
            b.documents.update(f'doc-{i}', f'name-{i}')
    assert sizes == [MAX_BATCH_OPS, 1]
    assert len(b.results) == n
    assert b.results[0]['body']['path'].endswith('doc-0')
    assert b.results[-1]['body']['path'].endswith(f'doc-{n - 1}')
