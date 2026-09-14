"""Tests for the per-call custom audit-log message — network-free paths.

Batch mode queues operations instead of sending them, so we can assert the
`?audit-message=` query param is appended to a queued op's path without a
live server. Server-side templating of `{param}` placeholders is covered by
plaid-core's audit-message-test. (Scoping a message over MANY writes is the
job of logical operations — see test_operation.py.)
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def _client():
    return PlaidClient('http://localhost:0', 'dummy-token')


def _stub_session(client):
    """Replace the client's HTTP session; return the list its URLs land in."""
    urls = []

    class _Resp:
        ok = True
        status_code = 200
        headers = {}
        text = '{}'
        content = b'{}'
        reason = 'OK'

        def json(self):
            return {}

    class _Session:
        def request(self, **kw):
            urls.append(kw.get('url', ''))
            return _Resp()

        def close(self):
            pass

    client.session = _Session()
    return urls


def _queue(client, message=None):
    """Queue one write with a per-call message and one without; return paths."""
    b = client.batch()
    b.spans.set_metadata('S1', {'a': 1}, audit_message=message)
    b.spans.set_metadata('S2', {'b': 2})
    paths = [op['path'] for op in b.operations]
    b.abort()
    return paths


def test_per_call_audit_message_applies_to_that_op_only():
    with_msg, without = _queue(_client(), 'Approve {span_id}')
    assert 'audit-message=Approve%20%7Bspan_id%7D' in with_msg
    assert 'audit-message' not in without


def test_get_requests_never_carry_audit_message():
    # A read never joins a batch, so this one is observed on the wire rather
    # than in the queue: the session is stubbed and the URL it was handed is
    # the assertion.
    client = _client()
    urls = _stub_session(client)
    client.spans.get('S1')
    assert len(urls) == 1
    assert 'audit-message' not in urls[0]


def test_special_characters_are_url_encoded():
    path = _queue(_client(), 'a & b = c')[0]
    # the raw '&'/'=' must be percent-encoded so they don't fork the query string
    assert 'a%20%26%20b%20%3D%20c' in path
