"""users.avatar_token asks core for a token an image element can show profile
pictures with (avatarToken in the JS client), and keeps it: one token serves
the whole client until under ten minutes of it remain (half its life, for one
minted near the end of a login), and a change of the
client's login token drops it. users.avatar_url puts that token, never the
login token, in the picture's URL."""

import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError


def _in_hours(h):
    t = datetime.now(timezone.utc) + timedelta(hours=h)
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond:06d}000Z'


def _minted(token, expires_at=None):
    return 200, {'token': token, 'expires-at': expires_at or _in_hours(24)}


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = status < 300
        self.reason = ''
        self.headers = {'content-type': 'application/json'}
        self.content = json.dumps(body).encode()
        self.text = json.dumps(body)
        self._body = body

    def json(self):
        return self._body


def _answer(client, *answers, delay=0):
    seen = []

    def request(**kw):
        seen.append(kw)
        if delay:
            time.sleep(delay)
        status, body = answers[min(len(seen) - 1, len(answers) - 1)]
        return _Resp(status, body)

    client.session.request = request
    return seen


def _auth(call):
    headers = {k.lower(): v for k, v in (call.get('headers') or {}).items()}
    return headers.get('authorization')


def test_avatar_token_posts_to_avatar_link_and_answers_token_and_expires_at():
    client = PlaidClient('http://core:8085/', 'tok')
    expires_at = _in_hours(24)
    seen = _answer(client, _minted('av1', expires_at))
    assert client.users.avatar_token() == {'token': 'av1', 'expires_at': expires_at}
    assert len(seen) == 1
    assert seen[0]['method'] == 'POST'
    assert seen[0]['url'] == 'http://core:8085/api/v1/avatar-link'
    headers = {k.lower(): v for k, v in (seen[0].get('headers') or {}).items()}
    assert 'idempotency-key' not in headers


def test_later_calls_reuse_the_token():
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, _minted('av1'))
    assert client.users.avatar_url('a@x.org', 'h1') == \
        'http://core/api/v1/users/a@x.org/avatar?avatar-token=av1&v=h1'
    assert client.users.avatar_url('b@x.org') == \
        'http://core/api/v1/users/b@x.org/avatar?avatar-token=av1'
    assert client.users.avatar_token()['token'] == 'av1'
    assert len(seen) == 1


def test_threads_share_one_mint():
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, _minted('av1'), delay=0.05)
    out = []
    threads = [threading.Thread(target=lambda: out.append(client.users.avatar_token()['token']))
               for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert out == ['av1'] * 5
    assert len(seen) == 1


def test_the_url_never_carries_the_login_token():
    client = PlaidClient('http://core', 'login-secret')
    _answer(client, _minted('av1'))
    url = client.users.avatar_url('a@x.org', 'h')
    assert 'login-secret' not in url
    assert '?token=' not in url and '&token=' not in url


def _later(client, seconds):
    """The client's clock moved on, as its server reckons time."""
    real = client.server_now
    client.server_now = lambda: real() + timedelta(seconds=seconds)


def test_a_token_is_minted_again_ten_minutes_before_it_runs_out():
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, _minted('old'), _minted('new'))
    client.users.avatar_token()
    _later(client, (24 * 60 - 11) * 60)
    assert client.users.avatar_token()['token'] == 'old'
    _later(client, 2 * 60)
    assert client.users.avatar_token()['token'] == 'new'
    assert len(seen) == 2


def test_a_token_minted_near_the_end_of_a_login_is_kept_for_half_its_life():
    # The server caps a token at the login's own expiry, so near its end every
    # token runs out at that moment. Renewed at ten minutes, each call minted
    # another.
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, _minted('short', _in_hours(9 / 60)), _minted('again', _in_hours(9 / 60)))
    client.users.avatar_token()
    assert client.users.avatar_token()['token'] == 'short'
    _later(client, 5 * 60)
    assert client.users.avatar_token()['token'] == 'again'
    assert len(seen) == 2


def test_renew_mints_a_new_token_whatever_is_kept():
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, _minted('av1'), _minted('av2'))
    client.users.avatar_token()
    assert client.users.avatar_url('a@x.org', 'h', renew=True) == \
        'http://core/api/v1/users/a@x.org/avatar?avatar-token=av2&v=h'
    assert len(seen) == 2


def test_a_change_of_the_clients_token_drops_the_cached_one():
    client = PlaidClient('http://core', 'tok1')
    seen = _answer(client, _minted('for-tok1'), _minted('for-tok2'))
    client.users.avatar_token()
    client.token = 'tok2'
    assert client.users.avatar_token()['token'] == 'for-tok2'
    assert len(seen) == 2
    assert _auth(seen[1]) == 'Bearer tok2'


def test_a_failed_mint_raises_and_the_next_call_asks_again():
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, (401, {'error': 'Token invalid. Obtain a new token.'}), _minted('av2'))
    with pytest.raises(PlaidAPIError) as e:
        client.users.avatar_url('a@x.org', 'h')
    assert e.value.status == 401
    assert client.users.avatar_token()['token'] == 'av2'
    assert len(seen) == 2


def test_a_batch_uses_its_clients_token_and_queues_nothing():
    client = PlaidClient('http://core', 'tok')
    seen = _answer(client, _minted('av1'))
    b = client.batch()
    try:
        assert b.users.avatar_token()['token'] == 'av1'
        assert client.users.avatar_token()['token'] == 'av1'
        assert len(seen) == 1
        assert b.operations == []
    finally:
        b.abort()
