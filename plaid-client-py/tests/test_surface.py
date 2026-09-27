"""Small surface points the two clients must share (PARITY 15)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import client as client_module
from plaid_client.client import PlaidClient
from plaid_client.http import DEFAULT_BATCH_TIMEOUT_S


def test_a_batch_timeout_of_none_disables_it_whatever_timeout_is():
    assert PlaidClient('http://x', 't', timeout=5, batch_timeout=None).batch_timeout is None
    assert PlaidClient('http://x', 't', timeout=5).batch_timeout == 5
    assert PlaidClient('http://x', 't').batch_timeout == DEFAULT_BATCH_TIMEOUT_S
    assert PlaidClient('http://x', 't', batch_timeout=7).batch_timeout == 7


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def test_health_and_info_answer_with_no_client_and_no_token(monkeypatch):
    seen = []

    def get(url, **kw):
        seen.append((url, kw.get('headers')))
        body = ({'ok': True, 'uptime-ms': 3} if url.endswith('/health')
                else {'limits': {'batch-operations': 1000}})
        return _Resp(body)

    monkeypatch.setattr(client_module.req_lib, 'get', get)
    assert PlaidClient.health('http://x/') == {'ok': True, 'uptime_ms': 3}
    assert PlaidClient.info('http://x') == {'limits': {'batch_operations': 1000}}
    assert seen == [('http://x/health', None), ('http://x/api/v1/info', None)]


def test_a_vocabularys_comments_page_like_a_projects():
    client = PlaidClient('http://x', 'tok')
    sent = []
    pages = iter([{'entries': [{'id': 'c1'}], 'next-cursor': 'k'},
                  {'entries': [{'id': 'c2'}], 'next-cursor': None}])

    class _Page:
        ok = True
        status_code = 200
        headers = {'content-type': 'application/json'}

        def __init__(self):
            self._body = next(pages)

        def json(self):
            return self._body

    class _Session:
        def request(self, **kw):
            sent.append(kw['url'])
            return _Page()

    client.session = _Session()
    got = [[c['id'] for c in page]
           for page in client.comments.iter_in_vocab_pages('v1', entity_id='e1', page_size=1)]
    assert got == [['c1'], ['c2']]
    assert sent[0].startswith('http://x/api/v1/vocab-layers/v1/comments?')
    assert 'entity-id=e1' in sent[0] and 'limit=1' in sent[0]
    assert 'cursor=k' in sent[1]
