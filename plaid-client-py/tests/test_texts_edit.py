"""``texts.edit`` sends the edits made at the caret with the digest of the body
they were made on, and strict mode does not stamp a write that carries
``base``: the digest is the precondition."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    headers = {'content-type': 'application/json'}
    reason = 'OK'

    def __init__(self, answer):
        self._answer = answer
        self.text = json.dumps(answer)
        self.content = self.text.encode()

    def json(self):
        return self._answer


def _stub_session(client, answer=None):
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append({'method': kw.get('method'), 'url': kw.get('url', ''), 'json': kw.get('json'),
                         'data': kw.get('data')})
            return _Resp(answer or {})

        def close(self):
            pass

    client.session = _Session()
    return sent


def _strict_client():
    client = PlaidClient('http://x', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions = {'d1': 7}
    return client


def _version(url):
    return parse_qs(urlparse(url).query).get('document-version', [None])[0]


def _body(record):
    if record['json'] is not None:
        return record['json']
    data = record['data']
    return json.loads(data) if data else None


EDITS = [{'type': 'insert', 'index': 3, 'value': 's'}]


def test_an_edit_with_base_goes_unstamped_and_answers_digest_and_reshape():
    client = _strict_client()
    sent = _stub_session(client, {'text/id': 't1', 'text/digest': 'd2',
                                  'reshape': {'tokens': [], 'vocab-links': [], 'deleted': {}}})
    answer = client.texts.edit('t1', EDITS, base='d1')
    assert len(sent) == 1
    assert sent[0]['method'] == 'PATCH'
    assert _body(sent[0]) == {'edits': EDITS, 'base': 'd1'}
    assert _version(sent[0]['url']) is None
    assert answer['digest'] == 'd2'
    assert answer['reshape']['vocab_links'] == []


def test_without_base_an_edit_is_stamped_as_any_write():
    client = _strict_client()
    sent = _stub_session(client)
    client.texts.edit('t1', EDITS)
    client.texts.update('t1', 'cats')
    client.texts.update('t1', EDITS, base='d1')
    assert [_version(r['url']) for r in sent] == ['7', '7', None]
    assert _body(sent[2]) == {'body': EDITS, 'base': 'd1'}


def test_an_edit_queues_on_a_batch_with_its_base_and_without_a_stamp():
    client = _strict_client()
    b = client.batch()
    b.texts.edit('t1', EDITS, base='d1')
    b.tokens.bulk_create([{'token_layer_id': 'l', 'text': 't1', 'begin': 0, 'end': 4}])
    assert b.operations[0]['body'] == {'edits': EDITS, 'base': 'd1'}
    assert _version(b.operations[0]['path']) is None
    assert _version(b.operations[1]['path']) == '7'
    b.abort()


def test_versioned_keeps_the_stamp_on_a_write_with_base():
    client = _strict_client()
    b = client.batch()
    b.texts.edit('t1', EDITS, base='d1', versioned=True)
    b.texts.update('t1', EDITS, base='d1', versioned=True)
    assert [_version(op['path']) for op in b.operations] == ['7', '7']
    b.abort()
