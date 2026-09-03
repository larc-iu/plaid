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


def test_query_does_not_join_an_open_batch():
    """A read must never be swallowed by whatever batch happens to be open on
    the shared client: it returns nothing to its caller until submit, and the
    server runs a batched sub-request against the batch's tx Connection, where
    a query throws and takes every write in the batch down with it. Queries
    therefore go straight over the wire (here: to a dead port, so the failure
    itself proves the call left the queue rather than joining it)."""
    c = _client()
    with pytest.raises(Exception):
        with c.batched():
            c.tokens.create('tl-1', 'text-1', 0, 3, 1)
            with pytest.raises(Exception):
                c.query({'find': ['?t'], 'where': [['token', '?t', {}]]})
            paths = [op['path'].split('?')[0] for op in c.batch_operations]
            assert paths == ['/api/v1/tokens']
            raise RuntimeError('done checking')  # abort rather than submit


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
            c.documents.update(f'doc-{i}', f'name-{i}')
    assert sizes == [MAX_BATCH_OPS, 1]
    assert len(b.results) == n
    assert b.results[0]['body']['path'].endswith('doc-0')
    assert b.results[-1]['body']['path'].endswith(f'doc-{n - 1}')
    assert c.is_batch_mode() is False
