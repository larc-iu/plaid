"""A user id is an email address, stored trimmed and lowercased. The client
sends it that way from login, invite redemption and account creation, exports
the rule for callers that compare a typed address with an id, and the test
double's user-data store keys by it as the server does. The JS twin
(``test/userIdCase.test.js``) sends the same bodies."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import normalize_user_id, testing
from plaid_client import client as client_mod
from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'
    headers = {}
    text = '{"token": "t"}'
    content = b'{"token": "t"}'

    def json(self):
        return {'token': 't'}


def _capture_posts(monkeypatch):
    sent = []

    def post(url, **kw):
        sent.append(json.loads(kw['data']))
        return _Resp()

    monkeypatch.setattr(client_mod.req_lib, 'post', post)
    return sent


def test_normalize_user_id_trims_and_lowercases():
    assert normalize_user_id('  Ana@Example.ORG ') == 'ana@example.org'
    assert normalize_user_id(None) is None


def test_login_sends_the_lowercased_id(monkeypatch):
    sent = _capture_posts(monkeypatch)
    PlaidClient.login('http://x', ' Ana@Example.org', 'pw')
    assert sent == [{'user-id': 'ana@example.org', 'password': 'pw'}]


def test_a_signup_redemption_sends_the_lowercased_email(monkeypatch):
    sent = _capture_posts(monkeypatch)
    PlaidClient.redeem_invite('http://x', 'CODE', 'pw', email='ANA@example.org ')
    assert sent == [{'code': 'CODE', 'password': 'pw', 'email': 'ana@example.org'}]


def test_users_create_sends_the_lowercased_email():
    client = PlaidClient('http://x', 'tok')
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append(json.loads(kw['data']))
            return _Resp()

        def close(self):
            pass

    client.session = _Session()
    client.users.create('Ana@Example.org', 'pw', False)
    assert sent == [{'email': 'ana@example.org', 'password': 'pw', 'is-admin': False}]


def test_the_fake_user_data_store_keys_by_the_stored_id():
    c = testing.FakeClient({}, project={'id': 'p', 'name': 'P'})
    c.user_data.put('Ana@Example.org', 'k', {'v': 1})
    assert c.user_data.get('ana@example.org', 'k')['value'] == {'v': 1}
    assert [r['key'] for r in c.user_data.list(' ANA@example.org')] == ['k']
    c.user_data.delete('ana@EXAMPLE.org', 'k')
    assert c.user_data.list('ana@example.org') == []
