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
