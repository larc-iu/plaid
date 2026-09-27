"""users.create leaves out a display name it was not given, so core gives
the user the local part of the email, as the docstring says. The JS twin
(``users.create`` with no ``displayName``) sends the same body."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 201
    reason = 'Created'
    headers = {}
    text = '{}'
    content = b'{}'

    def json(self):
        return {}


def _stub(client):
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append(json.loads(kw['data']))
            return _Resp()

        def close(self):
            pass

    client.session = _Session()
    return sent


def test_create_without_a_display_name_leaves_it_out():
    client = PlaidClient('http://x', 'tok')
    sent = _stub(client)
    client.users.create('ana@example.com', 'pw', False)
    assert sent == [{'email': 'ana@example.com', 'password': 'pw', 'is-admin': False}]


def test_create_with_a_display_name_sends_it():
    client = PlaidClient('http://x', 'tok')
    sent = _stub(client)
    client.users.create('ana@example.com', 'pw', False, display_name='Ana')
    assert sent == [{'email': 'ana@example.com', 'password': 'pw', 'is-admin': False,
                     'display-name': 'Ana'}]
