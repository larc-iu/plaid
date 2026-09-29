"""``b.ref()`` stands in for the id an earlier queued op will create. The
server resolves it (plaid-core's batch-ref-test), the JS side is
``plaid-client-js/test/batchRef.test.js``."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def _client():
    return PlaidClient('http://localhost:0', 'dummy-token')


def test_a_ref_names_the_op_it_was_taken_after_and_survives_the_body_transform():
    b = _client().batch()
    b.vocab_items.create('V', 'dog')
    entry = b.ref()
    b.vocab_items.bulk_create([{'vocab_layer_id': 'V', 'form': 'a'}])
    b.vocab_links.create(entry, ['t1'])
    b.vocab_links.create(b.ref(1, 0), ['t2'])
    assert b.operations[2]['body'] == {'vocab-item': {'$ref': 0}, 'tokens': ['t1']}
    assert b.operations[3]['body'] == {'vocab-item': {'$ref': 1, 'index': 0}, 'tokens': ['t2']}
    with pytest.raises(Exception):
        b.ref(4)
    with pytest.raises(Exception):
        b.ref(-5)
    b.abort()


def test_a_batch_split_in_two_counts_each_requests_refs_from_its_own_first_op(monkeypatch):
    client = _client()
    sent = []

    class _Resp:
        ok = True

        def __init__(self, n):
            self._n = n

        def json(self):
            return [{'status': 201, 'headers': {}, 'body': {'id': 'x'}}] * self._n

    def post(url, headers=None, data=None, timeout=None):
        import json
        body = json.loads(data)
        sent.append(body)
        return _Resp(len(body))

    monkeypatch.setattr(client.session, 'post', post)
    b = client.batch()
    for i in range(1001):
        b.vocab_items.create('V', f'w{i}')
    b.vocab_links.create(b.ref(1000), ['t'])
    b.submit()
    assert len(sent) == 2
    assert sent[1][1]['body']['vocab-item'] == {'$ref': 0}


def test_a_ref_across_the_split_refuses_the_whole_batch_before_anything_goes(monkeypatch):
    client = _client()
    posts = []
    monkeypatch.setattr(client.session, 'post', lambda *a, **k: posts.append(1))
    b = client.batch()
    b.vocab_items.create('V', 'first')
    first = b.ref()
    for i in range(1000):
        b.vocab_items.create('V', f'w{i}')
    b.vocab_links.create(first, ['t'])
    with pytest.raises(Exception) as caught:
        b.submit()
    assert getattr(caught.value, 'committed', None) == 0
    assert posts == []
