"""auth.logout_everywhere ends every sign-in of the user on every device
(POST /logout). It is a signal on the user's sign-ins, not project data: it
goes over the wire even when made on a batch, and never joins an operation."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.testing import Response, recording_session


def _stub(client):
    client.session = recording_session([Response(204, reason='No Content')])
    return client.session.sent


def _auth(request):
    return request['headers'].get('Authorization')


def test_logout_everywhere_posts_logout_with_this_clients_sign_in():
    client = PlaidClient('http://x', 'tok')
    sent = _stub(client)
    assert client.auth.logout_everywhere() is None
    assert [(s['url'], s['method'], _auth(s)) for s in sent] == [
        ('http://x/api/v1/logout', 'POST', 'Bearer tok')]


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
