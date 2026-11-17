"""A private data write may name the version it was made from (``?version=``),
so the server refuses it with 409 when another write landed since. The JS
client's ``userData.put(..., { version })`` sends the same."""

from plaid_client.client import PlaidClient


def test_put_sends_the_version_it_was_made_from_and_none_when_not_given(monkeypatch):
    client = PlaidClient('http://example.test', 'tok')
    calls = []

    def fake_request(_client, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {'key': 'k', 'updated_at': 't', 'version': 3}

    monkeypatch.setattr('plaid_client.client.make_request', fake_request)
    assert client.user_data.put('u1', 'a:b', {'n': 1}, version=2)['version'] == 3
    client.user_data.put('u1', 'a:b', {'n': 1}, version=0)
    client.user_data.put('u1', 'a:b', {'n': 1})
    assert [c[2].get('query_params') for c in calls] == [{'version': 2}, {'version': 0}, None]
    assert {c[1] for c in calls} == {'/api/v1/users/u1/data/a%3Ab'}


def test_a_dot_segment_key_is_refused_before_sending(monkeypatch):
    # H20-4: requests resolves '.' and '..' as dot segments, so the request
    # reached another URL and answered 404 'Not Found'.
    import pytest
    client = PlaidClient('http://example.test', 'tok')
    calls = []
    monkeypatch.setattr('plaid_client.client.make_request', lambda *a, **k: calls.append(a))
    for key in ('.', '..'):
        for call in (lambda: client.user_data.get('u1', key), lambda: client.user_data.delete('u1', key),
                     lambda: client.user_data.put('u1', key, 1)):
            with pytest.raises(ValueError, match=r'A key cannot be \. or \.\.'):
                call()
    assert calls == []
    client.user_data.put('u1', '...', 1)
    assert len(calls) == 1


def test_a_non_ascii_value_goes_out_at_its_utf8_size():
    # REV-HFC-5: the body was json.dumps with ensure_ascii, so a 4 MB Arabic
    # value went out as about 12 MB of \uXXXX escapes and met the server's
    # 10 MB JSON body cap, while the JS client sent the same value as UTF-8.
    # The body is now the bytes JSON.stringify gives, UTF-8 encoded.
    import json
    from plaid_client.testing import recording_session
    client = PlaidClient('http://example.test', 'tok')
    client.session = recording_session([{'key': 'k', 'updated-at': 't', 'version': 1}])
    value = 'ب' * 2_000_000  # 4,000,000 bytes as UTF-8
    client.user_data.put('u1', 'big', value)
    [req] = client.session.sent
    body = req['data']
    assert isinstance(body, bytes)
    assert len(body) == len(value.encode('utf-8')) + 2
    assert json.loads(body) == value
    # the same bytes the JS client's JSON.stringify sends: no spaces after
    # a separator, letters as themselves
    client.user_data.put('u1', 'small', {'a': ['bب', 1]})
    assert client.session.sent[-1]['data'] == '{"a":["bب",1]}'.encode('utf-8')


def test_a_lone_surrogate_is_still_sent_as_an_escape():
    import json
    from plaid_client.testing import recording_session
    client = PlaidClient('http://example.test', 'tok')
    client.session = recording_session([{'key': 'k', 'updated-at': 't', 'version': 1}])
    client.user_data.put('u1', 'odd', 'a\ud800b')
    assert json.loads(client.session.sent[-1]['data']) == 'a\ud800b'
