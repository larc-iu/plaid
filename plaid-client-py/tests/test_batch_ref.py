"""``b.ref()`` stands in for the id an earlier queued op will create. The
client takes it out of the body when the write is queued and sends where it
was beside the body, as ``refs``, which the server fills in (plaid-core's
batch-ref-test). The body is never searched for anything else, so user data
shaped like a ref goes out as it was given (D19, REV-F-CORE-API REV-1). The JS
side is ``plaid-client-js/test/batchRef.test.js``."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError


def _client():
    return PlaidClient('http://localhost:0', 'dummy-token')


class _Resp:
    ok = True

    def __init__(self, n):
        self._n = n

    def json(self):
        return [{'status': 201, 'headers': {}, 'body': {'id': 'x'}}] * self._n


def _recording(monkeypatch, client):
    sent = []

    def post(url, headers=None, data=None, timeout=None):
        body = json.loads(data)
        sent.append(body)
        return _Resp(len(body))

    monkeypatch.setattr(client.session, 'post', post)
    return sent


def test_a_ref_names_the_op_it_was_taken_after_and_goes_beside_the_body():
    b = _client().batch()
    b.vocab_items.create('V', 'dog')
    entry = b.ref()
    b.vocab_items.bulk_create([{'vocab_layer_id': 'V', 'form': 'a'}])
    b.vocab_links.create(entry, ['t1'])
    b.vocab_links.create(b.ref(1, 0), ['t2'])
    assert b.operations[2]['body'] == {'vocab-item': None, 'tokens': ['t1']}
    assert b.operations[2]['refs'] == [{'at': ['vocab-item'], 'op': 0}]
    assert b.operations[3]['body'] == {'vocab-item': None, 'tokens': ['t2']}
    assert b.operations[3]['refs'] == [{'at': ['vocab-item'], 'op': 1, 'index': 0}]
    assert 'refs' not in b.operations[0]
    # What callers read off a ref keeps its meaning.
    assert (entry.op, entry.index) == (0, None)
    assert entry['$ref'] == 0 and entry == {'$ref': 0}
    assert b.ref(1, 0) == {'$ref': 1, 'index': 0} and b.ref(1, 0)['index'] == 0
    for bad in [lambda: b.ref(4), lambda: b.ref(-5), lambda: b.ref(0, -1)]:
        with pytest.raises(PlaidAPIError):
            bad()
    b.abort()


def test_a_ref_at_any_depth_including_in_a_list_and_in_metadata():
    b = _client().batch()
    b.tokens.bulk_create([{'token_layer_id': 'L', 'text': 'x', 'begin': 0, 'end': 1}])
    b.spans.create('S', ['t0', b.ref(0, 0)], 'v', metadata={'parent': b.ref(0, 0)})
    op = b.operations[1]
    assert op['body']['tokens'] == ['t0', None]
    assert op['body']['metadata']['parent'] is None
    assert op['refs'] == [{'at': ['tokens', 1], 'op': 0, 'index': 0},
                          {'at': ['metadata', 'parent'], 'op': 0, 'index': 0}]
    b.abort()


def test_user_data_shaped_like_a_ref_goes_out_as_given_and_gets_no_refs():
    b = _client().batch()
    shapes = [{'$ref': 0}, {'$ref': 0, 'index': 0}, {'$ref': '#/defs/tag'}]
    b.vocab_items.create('V', 'first')
    b.vocab_items.create('V', 'second', metadata={'x': shapes[0], 'all': shapes})
    b.projects.set_config('P', 't', 'schema', shapes[2])
    assert b.operations[1]['body']['metadata'] == {'x': shapes[0], 'all': shapes}
    assert 'refs' not in b.operations[1]
    assert b.operations[2]['body'] == shapes[2]
    assert 'refs' not in b.operations[2]
    b.abort()


def test_user_data_shaped_like_a_ref_past_op_1000_goes_out_as_given(monkeypatch):
    client = _client()
    sent = _recording(monkeypatch, client)
    b = client.batch()
    for i in range(1001):
        b.vocab_items.create('V', f'w{i}')
    metadata = {'a': {'$ref': '#/x'}, 'b': {'$ref': 3}, 'c': {'$ref': 1000}}
    b.vocab_items.create('V', 'late', metadata=metadata)
    b.submit()
    assert sent[1][1]['body']['metadata'] == metadata
    assert 'refs' not in sent[1][1]


def test_a_batch_split_in_two_counts_each_requests_refs_from_its_own_first_op(monkeypatch):
    client = _client()
    sent = _recording(monkeypatch, client)
    b = client.batch()
    for i in range(1001):
        b.vocab_items.create('V', f'w{i}')
    b.vocab_links.create(b.ref(1000), ['t'])
    b.submit()
    assert len(sent) == 2
    assert sent[1][1]['body']['vocab-item'] is None
    assert sent[1][1]['refs'] == [{'at': ['vocab-item'], 'op': 0}]


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
    with pytest.raises(PlaidAPIError) as caught:
        b.submit()
    assert caught.value.committed == 0
    assert posts == []


def test_a_ref_anywhere_but_a_later_body_on_its_own_batch_is_refused(monkeypatch):
    client = _client()
    sent = []
    monkeypatch.setattr(client.session, 'request', lambda **k: sent.append(k))
    b = client.batch()
    b.vocab_items.create('V', 'dog')
    ref = b.ref()
    # In a path.
    with pytest.raises(PlaidAPIError, match=r'b\.ref\(\)'):
        b.vocab_items.delete(ref)
    # On another batch.
    other = client.batch()
    other.vocab_items.create('V', 'cat')
    with pytest.raises(PlaidAPIError, match=r'b\.ref\(\)'):
        other.vocab_links.create(ref, ['t'])
    other.abort()
    # In a call made on the client, which would send it now.
    with pytest.raises(PlaidAPIError, match=r'b\.ref\(\)'):
        client.vocab_links.create(ref, ['t'])
    assert sent == []
    assert len(b.operations) == 1
    b.abort()
