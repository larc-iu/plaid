"""Idempotent writes: every write that is not a signal, an upload or a secret
goes out with an Idempotency-Key, a write whose answer was lost is sent again
under the same key, and a create can name its own id. See the Idempotency-Key
note in plaid_client/http.py. The JS twin is plaid-client-js/test/idempotency.test.js."""

import json
import os
import re
import sys
import time

import pytest
import requests as requests_lib
from requests.structures import CaseInsensitiveDict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import uuid7
from plaid_client.client import MAX_BATCH_OPS, PlaidClient
from plaid_client.http import PlaidAPIError, is_unknown_outcome, retry_unknown

KEY = 'Idempotency-Key'

FAST = {'retry_delays': [0, 0, 0]}


class _Resp:
    def __init__(self, status, body=None, headers=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.reason = str(status)
        self._body = {} if body is None else body
        self.headers = CaseInsensitiveDict({'content-type': 'application/json', **(headers or {})})
        self.text = json.dumps(self._body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _stub_server(client, answer=lambda request, n: _Resp(200, {'id': 'x'})):
    """Records every request and answers with ``answer(request, n)``, a
    response or an exception to raise (a lost answer)."""
    requests = []

    def handle(method, url, headers, data):
        request = {'url': url, 'method': method, 'key': (headers or {}).get(KEY),
                   'body': json.loads(data) if isinstance(data, str) else None}
        requests.append(request)
        r = answer(request, len(requests) - 1)
        if isinstance(r, BaseException):
            raise r
        return r

    class _Session:
        def request(self, method=None, url=None, headers=None, data=None, **kw):
            return handle(method, url, headers, data)

        def post(self, url, headers=None, data=None, timeout=None):
            return handle('POST', url, headers, data)

        def close(self):
            pass

    client.session = _Session()
    return requests


def test_every_write_carries_a_key_a_read_does_not():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client)
    client.spans.create('L', ['t'], 'N')
    client.spans.update('s', 'V')
    client.documents.get('d')
    assert requests[0]['key']
    assert requests[1]['key']
    assert requests[0]['key'] != requests[1]['key']
    assert requests[2]['key'] is None


def test_signals_uploads_and_minted_secrets_carry_none():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: _Resp(
        200, {'lock-id': 'l', 'id': 'x', 'token': 't', 'code': 'c'}))
    client.documents.acquire_lock('d')
    client.api_tokens.create('u@x', 'name')
    client.invites.create()
    client.user_data.put('u', 'k', {'a': 1})
    client.query({'find': ['?s'], 'where': []})
    assert [r['key'] for r in requests] == [None] * 5


def test_a_queued_op_has_no_key_of_its_own_its_batch_request_has_one():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: _Resp(
        200, [{'status': 201, 'headers': {}, 'body': {'id': 'x'}} for _ in r['body']]))
    with client.batched() as b:
        b.spans.create('L', ['t'], 'A')
        b.spans.create('L', ['t'], 'B')
    assert len(requests) == 1
    assert requests[0]['key']
    assert all('headers' not in op for op in requests[0]['body'])


@pytest.mark.parametrize('lost', [
    lambda: requests_lib.ConnectionError('Connection refused'),
    lambda: requests_lib.ReadTimeout('timed out'),
    lambda: _Resp(502, {'error': 'Bad gateway'}),
    lambda: _Resp(504, {'error': 'Gateway timeout'}),
], ids=['no response', 'timeout', '502', '504'])
def test_a_write_whose_answer_is_lost_is_sent_again_under_the_same_key(lost):
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: lost() if n < 2 else _Resp(201, {'id': 's1'}))
    result = client.spans.create('L', ['t'], 'N')
    assert result['id'] == 's1'
    assert len(requests) == 3
    assert len({r['key'] for r in requests}) == 1
    assert requests[0]['body'] == requests[2]['body']
    assert requests[0]['url'] == requests[2]['url']


def test_three_resends_then_the_error_escapes_with_the_key():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: _Resp(502, {}))
    with pytest.raises(PlaidAPIError) as caught:
        client.spans.update('s', 'V')
    assert caught.value.status == 502
    assert caught.value.idempotency_key == requests[0]['key']
    assert len(requests) == 4


def test_a_refusal_is_not_resent_and_a_read_is_never_resent():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: _Resp(502, {}) if r['method'] == 'GET'
                            else _Resp(409, {'error': 'no'}))
    with pytest.raises(PlaidAPIError) as refused:
        client.spans.update('s', 'V')
    assert refused.value.status == 409
    with pytest.raises(PlaidAPIError) as read:
        client.documents.get('d')
    assert read.value.status == 502
    assert len(requests) == 2


def test_an_unkeyed_write_is_not_resent():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: _Resp(502, {}))
    with pytest.raises(PlaidAPIError):
        client.api_tokens.create('u@x', 'name')
    assert len(requests) == 1


def test_retry_unknown_resends_only_an_unknown_outcome():
    attempts = []

    def attempt():
        attempts.append(1)
        raise PlaidAPIError('conflict', status=409)

    with pytest.raises(PlaidAPIError):
        retry_unknown(attempt, [0, 0, 0])
    assert len(attempts) == 1
    assert is_unknown_outcome(PlaidAPIError('x', status=0))
    assert not is_unknown_outcome(PlaidAPIError('x', status=500))


def test_the_default_delays_back_off_with_jitter(monkeypatch):
    slept = []
    monkeypatch.setattr(time, 'sleep', slept.append)
    with pytest.raises(PlaidAPIError):
        retry_unknown(lambda: (_ for _ in ()).throw(PlaidAPIError('lost', status=0)))
    assert len(slept) == 3
    for delay, base in zip(slept, [1.0, 3.0, 9.0]):
        assert base * 0.5 <= delay <= base * 1.5


def test_a_batch_past_the_cap_takes_one_key_per_request_and_a_lost_second_request_is_resent_alone():
    client = PlaidClient('http://x', 'tok', **FAST)
    lost = []

    def answer(r, n):
        if len(r['body']) == 1 and not lost:
            lost.append(1)
            return _Resp(504, {})
        return _Resp(200, [{'status': 200, 'headers': {}, 'body': {}} for _ in r['body']])

    requests = _stub_server(client, answer)
    with client.batched() as b:
        for i in range(MAX_BATCH_OPS + 1):
            b.spans.update(f's{i}', i)
    assert len(requests) == 3
    assert len(requests[0]['body']) == MAX_BATCH_OPS
    assert requests[0]['key'] != requests[1]['key']
    assert requests[1]['key'] == requests[2]['key']
    assert requests[1]['body'] == requests[2]['body']
    assert len(b.results) == MAX_BATCH_OPS + 1


def test_a_lost_batch_escapes_with_its_key_and_what_was_saved():
    client = PlaidClient('http://x', 'tok', **FAST)
    requests = _stub_server(client, lambda r, n: requests_lib.ConnectionError('refused'))
    b = client.batch()
    b.spans.update('s', 'V')
    with pytest.raises(PlaidAPIError) as caught:
        b.submit()
    assert caught.value.status == 0
    assert caught.value.idempotency_key == requests[0]['key']
    assert caught.value.committed == 0
    assert len(requests) == 4


def _version_of(url):
    found = re.search(r'document-version=([^&]+)', url)
    return found.group(1) if found else None


def test_inside_an_operation_with_keys_the_nth_write_takes_seed_n_and_its_first_claim():
    client = PlaidClient('http://x', 'tok', **FAST)
    client.enter_strict_mode('d1')
    client.document_versions = {'d1': 5}
    keys = client.key_seed()
    group_id = uuid7()
    requests = _stub_server(client, lambda r, n: _Resp(
        200, {'id': 'x'}, {'X-Document-Versions': '{"d1": 6}'}))

    def run():
        with client.operation('Gloss', keys=keys, group_id=group_id):
            client.spans.update('s1', 'A')
            # A message beside the edit is outside its numbering.
            client.messages.send_message('p', {'m': 1})
            client.spans.update('s2', 'B')

    run()
    run()
    assert requests[0]['key'] == f"{keys['seed']}.0"
    assert requests[2]['key'] == f"{keys['seed']}.1"
    assert not requests[1]['key'].startswith(keys['seed'])
    # The second run sends the same keys and the same claims as the first,
    # although the client has since learned version 6.
    assert [requests[3]['key'], requests[5]['key']] == [requests[0]['key'], requests[2]['key']]
    assert requests[3]['url'] == requests[0]['url']
    assert requests[5]['url'] == requests[2]['url']
    assert _version_of(requests[0]['url']) == '5'
    assert _version_of(requests[2]['url']) == '6'
    assert f'group-id={group_id}' in requests[0]['url']


def test_a_nested_operation_that_brings_its_own_seed_numbers_its_keys_then_the_outer_resumes():
    # REV-idempotency F1: the inner seed was dropped by the nested begin.
    client = PlaidClient('http://x', 'tok', **FAST)
    outer = client.key_seed()
    inner = client.key_seed()
    requests = _stub_server(client)
    with client.operation('Outer', keys=outer):
        client.spans.update('s0', 'O')
        with client.operation('Inner', keys=inner):
            client.spans.update('s1', 'A')
            client.spans.update('s2', 'B')
        client.spans.update('s3', 'O2')
    with client.operation('Run'):
        with client.operation('Gloss', keys=inner):
            client.spans.update('s4', 'C')
    client.spans.update('s5', 'D')
    assert [r['key'] for r in requests[:5]] == [
        f"{outer['seed']}.0", f"{inner['seed']}.0", f"{inner['seed']}.1",
        f"{outer['seed']}.1", f"{inner['seed']}.0"]
    assert not requests[5]['key'].startswith(inner['seed'])
    group = lambda r: re.search(r'group-id=([^&]+)', r['url']).group(1)
    assert group(requests[1]) == group(requests[0])


def test_a_nested_operation_without_a_seed_joins_the_outer_ones_keys():
    client = PlaidClient('http://x', 'tok', **FAST)
    keys = client.key_seed()
    requests = _stub_server(client)
    with client.operation('Outer', keys=keys):
        client.spans.update('s1', 'A')
        with client.operation('Inner'):
            client.spans.update('s2', 'B')
    assert [r['key'] for r in requests] == [f"{keys['seed']}.0", f"{keys['seed']}.1"]


def test_a_comment_made_while_an_operation_is_open_takes_none_of_its_keys_and_joins_nothing():
    # REV-idempotency F2.
    client = PlaidClient('http://x', 'tok', **FAST)
    keys = client.key_seed()
    requests = _stub_server(client, lambda request, n: _Resp(201, {'id': 'x'}))
    with client.operation('Gloss', keys=keys):
        client.spans.update('s1', 'A')
        client.comments.create('span', 's1', 'hmm')
        client.spans.update('s1', 'B')
    assert requests[0]['key'] == f"{keys['seed']}.0"
    assert not requests[1]['key'].startswith(keys['seed'])
    assert 'group-id' not in requests[1]['url']
    assert requests[2]['key'] == f"{keys['seed']}.1"


def test_a_batch_in_a_keyed_operation_takes_its_key_and_pins_its_claim():
    client = PlaidClient('http://x', 'tok', **FAST)
    client.enter_strict_mode('d1')
    client.document_versions = {'d1': 5}
    keys = client.key_seed()
    requests = _stub_server(client, lambda r, n: _Resp(200, [
        {'status': 200, 'headers': {'X-Document-Versions': '{"d1": 6}'}, 'body': {}}
        for _ in r['body']]))

    def run():
        with client.operation('Gloss', keys=keys):
            with client.batched() as b:
                b.spans.update('s1', 'A')

    run()
    run()
    assert requests[0]['key'] == requests[1]['key'] == f"{keys['seed']}.0"
    # The server reads the query sorted and without its labels, so the claim
    # is what must match, not where it sits.
    assert [_version_of(r['body'][0]['path']) for r in requests] == ['5', '5']
    assert keys['stamps'] == {0: 5}


def test_a_replayed_answer_only_raises_a_version_the_client_holds():
    client = PlaidClient('http://x', 'tok', **FAST)
    client.document_versions = {'d1': 9, 'd2': 1}
    _stub_server(client, lambda r, n: _Resp(200, {'id': 'x'}, {
        'X-Document-Versions': '{"d1": 7, "d2": 3}', 'Idempotent-Replayed': 'true'}))
    client.spans.update('s', 'V')
    assert client.document_versions == {'d1': 9, 'd2': 3}


def test_a_fresh_answer_is_learned_as_it_comes():
    client = PlaidClient('http://x', 'tok', **FAST)
    client.document_versions = {'d1': 9}
    _stub_server(client, lambda r, n: _Resp(200, {'id': 'x'}, {
        'X-Document-Versions': '{"d1": 7}'}))
    client.spans.update('s', 'V')
    assert client.document_versions == {'d1': 7}


def test_a_replayed_batch_only_raises_a_version_too():
    client = PlaidClient('http://x', 'tok', **FAST)
    client.document_versions = {'d1': 9}
    _stub_server(client, lambda r, n: _Resp(
        200, [{'status': 200, 'headers': {'X-Document-Versions': '{"d1": 7}'}, 'body': {}}],
        {'Idempotent-Replayed': 'true'}))
    with client.batched() as b:
        b.spans.update('s', 'V')
    assert client.document_versions['d1'] == 9


def test_uuid7_version_variant_and_order_within_one_millisecond():
    ids = [uuid7() for _ in range(4096 + 10)]
    for i in ids[:5]:
        assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', i)
    assert sorted(ids) == ids
    assert len(set(ids)) == len(ids)
    ms = int(ids[0].replace('-', '')[:12], 16)
    assert abs(ms - time.time() * 1000) < 5000


def test_uuid7_borrows_the_next_millisecond_when_one_is_full(monkeypatch):
    frozen = (time.time_ns() // 1_000_000 + 10_000) * 1_000_000
    monkeypatch.setattr(time, 'time_ns', lambda: frozen)
    ids = [uuid7() for _ in range(4096 + 2)]
    assert sorted(ids) == ids
    ms = [int(i.replace('-', '')[:12], 16) for i in ids]
    counters = [int(i.replace('-', '')[13:16], 16) for i in ids]
    assert ms[0] == frozen // 1_000_000
    assert counters[0] == 0
    assert ms[4095] == ms[0] and counters[4095] == 4095
    assert ms[4096] == ms[0] + 1 and counters[4096] == 0


# Every create that answers an id takes the id to use. A new create method
# belongs in this table.
CREATES = [
    ('projects.create', lambda c, **o: c.projects.create('P', **o)),
    ('documents.create', lambda c, **o: c.documents.create('p', 'D', **o)),
    ('documents.copy', lambda c, **o: c.documents.copy('d', 'C', **o)),
    ('texts.create', lambda c, **o: c.texts.create('tl', 'd', 'x', **o)),
    ('text_layers.create', lambda c, **o: c.text_layers.create('p', 'T', **o)),
    ('token_layers.create', lambda c, **o: c.token_layers.create('tl', 'W', **o)),
    ('span_layers.create', lambda c, **o: c.span_layers.create('tk', 'S', **o)),
    ('relation_layers.create', lambda c, **o: c.relation_layers.create('sl', 'R', **o)),
    ('vocab_layers.create', lambda c, **o: c.vocab_layers.create('V', **o)),
    ('tokens.create', lambda c, **o: c.tokens.create('tk', 't', 0, 1, **o)),
    ('tokens.split', lambda c, **o: c.tokens.split('t', 1, **o)),
    ('spans.create', lambda c, **o: c.spans.create('sl', ['t'], 'N', **o)),
    ('relations.create', lambda c, **o: c.relations.create('rl', 'a', 'b', 'r', **o)),
    ('vocab_items.create', lambda c, **o: c.vocab_items.create('v', 'dog', **o)),
    ('vocab_links.create', lambda c, **o: c.vocab_links.create('i', ['t'], **o)),
    ('guidelines.create', lambda c, **o: c.guidelines.create('p', 'G', **o)),
    ('comments.create', lambda c, **o: c.comments.create('document', 'd', 'hi', **o)),
]


@pytest.mark.parametrize('name,call', CREATES, ids=[n for n, _ in CREATES])
def test_a_create_sends_the_id_it_is_given(name, call):
    client = PlaidClient('http://x', 'tok', **FAST)
    new_id = uuid7()
    requests = _stub_server(client, lambda r, n: _Resp(201, {'id': new_id}))
    call(client, id=new_id)
    call(client)
    assert requests[0]['body']['id'] == new_id
    assert 'id' not in requests[1]['body']


def test_a_bulk_create_passes_the_ids_in_its_items_through():
    client = PlaidClient('http://x', 'tok', **FAST)
    ids = [uuid7(), uuid7()]
    requests = _stub_server(client, lambda r, n: _Resp(201, {'ids': ids}))
    client.spans.bulk_create([{'id': i, 'span_layer_id': 'sl', 'tokens': ['t'], 'value': 'N'}
                              for i in ids])
    assert [item['id'] for item in requests[0]['body']] == ids


def test_the_fake_client_answers_the_id_it_is_given_and_takes_keys():
    from plaid_client.testing import FakeClient

    fake = FakeClient([{'id': 'd1', 'text_layers': []}])
    new_id = uuid7()
    keys = fake.key_seed()
    assert set(keys) == {'seed', 'stamps'}
    with fake.operation('Gloss', keys=keys):
        assert fake.spans.create('sl', ['t'], 'N', id=new_id) == {'id': new_id}
        assert fake.tokens.split('t', 1, id='t-right') == {'id': 't-right'}
        assert fake.comments.create('document', 'd1', 'hi', id='c-1')['id'] == 'c-1'
    assert fake.spans.create('sl', ['t'], 'N')['id'] != new_id


def test_a_keyed_operation_that_ends_while_a_later_one_is_open_ends_its_own_frame():
    # REV2 G7: frames are ended by the operation that opened them.
    client = PlaidClient('http://x', 'tok', **FAST)
    a = client.key_seed()
    b = client.key_seed()
    requests = _stub_server(client)
    client.begin_operation('A', keys=a)
    client.spans.update('a0', 'x')
    inner = client.operation('B', keys=b)
    inner.__enter__()
    client.spans.update('b0', 'x')
    client.end_operation()  # A ends first
    client.spans.update('b1', 'x')
    inner.__exit__(None, None, None)
    client.spans.update('after', 'x')
    assert [r['key'] for r in requests[:3]] == [
        f"{a['seed']}.0", f"{b['seed']}.0", f"{b['seed']}.1"]
    assert not requests[3]['key'].startswith((a['seed'], b['seed']))
    assert client._operation_group is None


def test_an_id_taken_for_an_id_the_operation_minted_answers_as_made_and_the_rest_is_sent():
    # REV2 G3.
    client = PlaidClient('http://x', 'tok', **FAST)
    new_id = uuid7()

    def answer(request, n):
        if request['method'] == 'POST':
            return _Resp(409, {'error': 'id-taken', 'id-taken': True, 'id': new_id})
        return _Resp(200, {})

    requests = _stub_server(client, answer)
    with client.operation('Gloss', keys=client.key_seed(), minted={new_id}):
        made = client.spans.create('L', ['t'], 'N', id=new_id)
        client.spans.update('other', 'NEW')
    with pytest.raises(PlaidAPIError) as e:
        client.spans.create('L', ['t'], 'N', id=new_id)
    assert e.value.status == 409
    assert made['id'] == new_id
    assert [r['method'] for r in requests] == ['POST', 'PATCH', 'POST']


def test_a_bulk_create_refused_id_taken_is_a_refusal_even_for_an_id_the_operation_minted():
    # REV3 H7.
    client = PlaidClient('http://x', 'tok', **FAST)
    a, b = uuid7(), uuid7()
    _stub_server(client, lambda request, n: _Resp(409, {'error': 'id-taken', 'id-taken': True, 'id': a}))
    with pytest.raises(PlaidAPIError) as e:
        with client.operation('Gloss', minted=[a, b]):
            client.spans.bulk_create([
                {'id': a, 'span_layer_id': 'L', 'tokens': ['t'], 'value': 'N'},
                {'id': b, 'span_layer_id': 'L', 'tokens': ['u'], 'value': 'M'},
            ])
    assert e.value.status == 409
    with client.operation('Gloss', minted=[a]):
        made = client.spans.create('L', ['t'], 'N', id=a)
    assert made['id'] == a


def test_an_id_taken_for_a_deleted_row_is_a_refusal_even_for_an_id_the_operation_minted():
    # REV3 H8: the row is gone, so there is nothing to answer as made.
    client = PlaidClient('http://x', 'tok', **FAST)
    new_id = uuid7()
    _stub_server(client, lambda request, n: _Resp(
        409, {'error': 'id-taken', 'id-taken': True, 'id': new_id, 'deleted': True}))
    with pytest.raises(PlaidAPIError) as e:
        with client.operation('Gloss', minted=[new_id]):
            client.spans.create('L', ['t'], 'N', id=new_id)
    assert e.value.status == 409
