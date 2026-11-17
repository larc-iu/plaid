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
