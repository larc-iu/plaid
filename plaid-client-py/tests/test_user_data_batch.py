"""A user_data read goes over the wire even when made on a batch; a write
refuses the batch."""
import pytest

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError


def _client(monkeypatch):
    client = PlaidClient('http://example.test', 'tok')
    calls = []

    def fake_request(_client, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {'entries': [], 'next_cursor': None}

    # Two homes for one function: a resource method calls the name imported
    # into client.py, and the pagination helpers call the one in http.py. The
    # listing pages, so it goes through the second.
    monkeypatch.setattr('plaid_client.client.make_request', fake_request)
    monkeypatch.setattr('plaid_client.http.make_request', fake_request)
    return client, calls


def test_user_data_reads_go_over_the_wire_from_a_batch(monkeypatch):
    # The JS twin is the one that gets hurt: the assistant panel is app chrome
    # in both SPAs, so its conversation reads fire while an import holds a
    # batch open. Under the old one-flag model a queued read answered a batch
    # marker instead of the entries and took a slot in the batch's results.
    # Both clients answer the same way.
    client, calls = _client(monkeypatch)
    b = client.batch()

    b.user_data.list('u1', prefix='ud:assistant:')
    b.user_data.get('u1', 'ud:assistant:p1:meta:c1')

    assert [c[0] for c in calls] == ['GET', 'GET']
    assert b.operations == []


def test_user_data_writes_refuse_a_batch():
    # A transcript saved into someone else's transaction would roll back with
    # it, so the caller is told rather than left believing it landed.
    client = PlaidClient('http://example.test', 'tok')
    b = client.batch()

    with pytest.raises(PlaidAPIError, match='cannot be used in a batch'):
        b.user_data.put('u1', 'k', {'a': 1})
    with pytest.raises(PlaidAPIError, match='cannot be used in a batch'):
        b.user_data.delete('u1', 'k')
