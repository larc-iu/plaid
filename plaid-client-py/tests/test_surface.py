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
    headers = {'content-type': 'application/json'}

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


# AU-CLIENTS (2026-10-05): the points below were found different between the
# two clients and made the same. Each has its JS twin in surface.test.js.

def test_a_request_id_is_one_path_segment_in_every_service_request_path(monkeypatch):
    from plaid_client import services

    client = PlaidClient('http://x', 'tok')
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append(kw['url'])
            return _Resp({})

    class _Stream:
        ok = False
        status_code = 404
        text = 'gone'

        def close(self):
            pass

    def get(url, **kw):
        sent.append(url)
        return _Stream()

    client.session = _Session()
    monkeypatch.setattr(services.requests, 'get', get)
    odd = 'a/b?c#d'
    services._report_event(client, 'p', odd, {'status': 'completed'})
    services.cancel_service_request(client, 'p', odd)
    try:
        services.attach_service_request(client, 'p', odd)
    except Exception as e:
        assert getattr(e, 'status', None) == 404
    assert sent == [
        'http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d/events',
        'http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d',
        'http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d',
    ]


def test_a_timeout_of_0_disables_it_as_in_the_js_client():
    from plaid_client.http import wire_timeout

    client = PlaidClient('http://x', 'tok', timeout=0)
    seen = []

    class _Session:
        def request(self, **kw):
            seen.append(kw['timeout'])
            return _Resp({})

        def post(self, url, **kw):
            seen.append(kw['timeout'])
            return _Resp([{'status': 200, 'headers': {}, 'body': {}}])

    client.session = _Session()
    client.projects.get('p')
    with client.batched() as b:
        b.projects.update('p', 'n')
    client.projects.delete('p', timeout=0)
    assert seen == [None, None, None]
    assert wire_timeout(0) is None and wire_timeout(-1) is None and wire_timeout(None) is None
    assert wire_timeout(5) == 5 and wire_timeout((3, 10)) == (3, 10)


def test_login_and_redeem_invite_forward_the_client_options(monkeypatch):
    def post(url, **kw):
        return _Resp({'token': 'tk', 'user-id': 'u', 'kind': 'signup'})

    monkeypatch.setattr(client_module.req_lib, 'post', post)
    c = PlaidClient.login('http://x', 'u', 'pw', batch_timeout=None, retry_delays=[0.1])
    assert (c.token, c.batch_timeout, c.retry_delays) == ('tk', None, [0.1])
    c, data = PlaidClient.redeem_invite('http://x', 'code', 'password1', batch_timeout=7,
                                        retry_delays=[])
    assert (c.token, c.batch_timeout, c.retry_delays, data['kind']) == ('tk', 7, [], 'signup')
    c = PlaidClient.login('http://x', 'u', 'pw')
    assert (c.batch_timeout, c.retry_delays) == (DEFAULT_BATCH_TIMEOUT_S, None)


def test_the_package_exports_what_the_js_index_exports():
    import plaid_client
    from plaid_client.provenance import stamp_inferred, confirmed_inferred, stamp_contributed

    assert plaid_client.MAX_BATCH_OPS == 1000
    assert plaid_client.is_machine(stamp_inferred('service:x'))
    assert not plaid_client.is_machine(confirmed_inferred('service:x'))
    assert not plaid_client.is_machine(stamp_contributed('u'))
    assert not plaid_client.is_machine(None)
    assert not plaid_client.is_machine({'gloss': 'dog'})
