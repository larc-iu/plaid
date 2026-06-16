"""Tests for the custom audit-log message support — network-free paths.

Batch mode queues operations instead of sending them, so we can assert the
`?audit-message=` query param is appended to each queued op's path without a
live server. Server-side templating of `{param}` placeholders is covered by
plaid-core's audit-message-test.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def _client():
    return PlaidClient('http://localhost:0', 'dummy-token')


def _queue(client):
    """Queue two same-span metadata patches in a batch and return their paths."""
    client.begin_batch()
    client.spans.set_metadata('S1', {'a': 1})
    client.spans.set_metadata('S2', {'b': 2})
    paths = [op['path'] for op in client.batch_operations]
    client.abort_batch()
    return paths


def test_context_manager_appends_to_every_op():
    client = _client()
    with client.audit_message('Approve {spanId}'):
        paths = _queue(client)
    assert all('audit-message=Approve%20%7BspanId%7D' in p for p in paths)


def test_context_manager_restores_previous_message():
    client = _client()
    with client.audit_message('outer'):
        with client.audit_message('inner'):
            assert 'audit-message=inner' in _queue(client)[0]
        # restored to outer after the nested block
        assert 'audit-message=outer' in _queue(client)[0]
    # cleared entirely after the outer block
    assert all('audit-message' not in p for p in _queue(client))


def test_set_and_clear_audit_message():
    client = _client()
    client.set_audit_message('manual')
    assert 'audit-message=manual' in _queue(client)[0]
    client.clear_audit_message()
    assert all('audit-message' not in p for p in _queue(client))


def test_get_requests_never_carry_audit_message():
    client = _client()
    with client.audit_message('msg'):
        client.begin_batch()
        # a GET is not a write — no audit-message even with an ambient message
        # (batch GETs still queue), so assert it is absent.
        client.spans.get('S1')
        paths = [op['path'] for op in client.batch_operations]
        client.abort_batch()
    assert all('audit-message' not in p for p in paths)


def test_special_characters_are_url_encoded():
    client = _client()
    with client.audit_message('a & b = c'):
        path = _queue(client)[0]
    # the raw '&'/'=' must be percent-encoded so they don't fork the query string
    assert 'a%20%26%20b%20%3D%20c' in path
