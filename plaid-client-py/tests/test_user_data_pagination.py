"""The private key/value store pages like every other collection.

A value runs to 1 MB, so a listing with values and no bound was the largest
response the API could be asked for. ``list`` follows the cursors and returns
the flat list, ``list_page`` returns the envelope.
"""
import pytest

from plaid_client.client import PlaidClient


def _client(monkeypatch, pages):
    """A client whose request layer answers from ``pages`` in turn, recording
    the query params each page was asked with."""
    client = PlaidClient('http://example.test', 'tok')
    calls = []

    def fake_request(_client, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return pages[len(calls) - 1]

    monkeypatch.setattr('plaid_client.http.make_request', fake_request)
    return client, calls


def _entry(key):
    return {'key': key, 'updated_at': '2026-09-14T00:00:00Z', 'value': {'key': key}}


def test_list_follows_the_cursors_and_returns_every_entry_flat(monkeypatch):
    client, calls = _client(monkeypatch, [
        {'entries': [_entry('a'), _entry('b')], 'next_cursor': 'cur-1'},
        {'entries': [_entry('c')], 'next_cursor': None},
    ])

    entries = client.user_data.list('u1', pattern='igt:assistant:*:meta:*', include_values=True)

    assert [e['key'] for e in entries] == ['a', 'b', 'c']
    assert len(calls) == 2
    # The narrowings ride along on every page, and so does the default bound.
    for _method, path, kwargs in calls:
        assert path == '/api/v1/users/u1/data'
        qp = kwargs['query_params']
        assert qp['pattern'] == 'igt:assistant:*:meta:*'
        assert qp['include-values'] is True
        assert qp['limit'] == 100
        assert kwargs['bypass_batch'] is True
    assert 'cursor' not in calls[0][2]['query_params']
    assert calls[1][2]['query_params']['cursor'] == 'cur-1'


def test_page_size_replaces_the_default_bound(monkeypatch):
    client, calls = _client(monkeypatch, [{'entries': [], 'next_cursor': None}])
    client.user_data.list('u1', prefix='igt:prefs:', page_size=500)
    qp = calls[0][2]['query_params']
    assert qp['limit'] == 500
    assert qp['prefix'] == 'igt:prefs:'


def test_list_page_hands_back_the_envelope_cursor_and_all(monkeypatch):
    client, calls = _client(monkeypatch, [
        {'entries': [_entry('a')], 'next_cursor': 'cur-1'},
    ])

    page = client.user_data.list_page('u1', prefix='igt:assistant:p1:meta:', limit=1)

    assert [e['key'] for e in page['entries']] == ['a']
    assert page['next_cursor'] == 'cur-1'
    qp = calls[0][2]['query_params']
    assert qp['limit'] == 1
    assert qp['prefix'] == 'igt:assistant:p1:meta:'


def test_iter_pages_yields_one_page_at_a_time(monkeypatch):
    client, _calls = _client(monkeypatch, [
        {'entries': [_entry('a')], 'next_cursor': 'cur-1'},
        {'entries': [_entry('b')], 'next_cursor': None},
    ])

    seen = [[e['key'] for e in page] for page in client.user_data.iter_pages('u1', page_size=1)]
    assert seen == [['a'], ['b']]


def test_a_listing_of_more_entries_than_one_page_is_read_whole(monkeypatch):
    # What a record reader does: 250 sidebar entries at the default bound is
    # three requests, and every one of them comes back.
    pages = [
        {'entries': [_entry(f'igt:assistant:p1:meta:c{i}') for i in range(100)], 'next_cursor': 'c1'},
        {'entries': [_entry(f'igt:assistant:p1:meta:c{i}') for i in range(100, 200)], 'next_cursor': 'c2'},
        {'entries': [_entry(f'igt:assistant:p1:meta:c{i}') for i in range(200, 250)], 'next_cursor': None},
    ]
    client, calls = _client(monkeypatch, pages)
    entries = client.user_data.list('u1', pattern='igt:assistant:*:meta:*', include_values=True)
    assert len(entries) == 250
    assert len(calls) == 3


def test_an_unmoving_cursor_is_refused_rather_than_looped_on(monkeypatch):
    client, _calls = _client(monkeypatch, [
        {'entries': [_entry('a')], 'next_cursor': 'stuck'},
        {'entries': [_entry('a')], 'next_cursor': 'stuck'},
    ])
    with pytest.raises(RuntimeError, match='did not advance'):
        client.user_data.list('u1')
