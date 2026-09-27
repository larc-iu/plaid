"""auth.logout_everywhere ends every sign-in of the user on every device
(POST /logout). It is a signal on the user's sign-ins, not project data: it
goes over the wire even when made on a batch, and never joins an operation."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 204
    reason = 'No Content'
    headers = {}
    text = ''
    content = b''

    def json(self):
        raise ValueError('no body')


def _stub(client):
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append({'url': kw['url'], 'method': kw['method'],
                         'auth': kw['headers'].get('Authorization')})
            return _Resp()

        def close(self):
            pass

    client.session = _Session()
    return sent


def test_logout_everywhere_posts_logout_with_this_clients_sign_in():
    client = PlaidClient('http://x', 'tok')
    sent = _stub(client)
    assert client.auth.logout_everywhere() is None
    assert sent == [{'url': 'http://x/api/v1/logout', 'method': 'POST',
                     'auth': 'Bearer tok'}]


def test_logout_everywhere_on_a_batch_or_in_an_operation_goes_out_at_once_unstamped():
    client = PlaidClient('http://x', 'tok')
    sent = _stub(client)
    client.begin_operation('Tidy')
    b = client.batch()
    b.auth.logout_everywhere()
    assert b.operations == []
    b.abort()
    assert [s['url'] for s in sent] == ['http://x/api/v1/logout']
    assert client._operation_group['written'] is False
