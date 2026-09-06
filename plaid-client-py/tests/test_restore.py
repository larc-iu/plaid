"""documents.restore builds the one request the server needs: the moment to
go back to, whether it is a dry run, and the optional audit message. Batch
mode queues the request, so the path can be checked without a server.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


def _queued(fn):
    client = PlaidClient('http://localhost:0', 'dummy-token')
    client.begin_batch()
    fn(client)
    ops = list(client.batch_operations)
    client.abort_batch()
    return ops


def test_restore_posts_the_moment_to_go_back_to():
    [op] = _queued(lambda c: c.documents.restore('D1', '2026-06-01T12:00:00Z'))
    assert op['method'] == 'POST'
    assert op['path'].startswith('/api/v1/documents/D1/restore?')
    assert 'as-of=2026-06-01T12%3A00%3A00Z' in op['path']
    assert 'dry-run' not in op['path']


def test_a_dry_run_says_so_and_the_audit_message_rides_along():
    [op] = _queued(lambda c: c.documents.restore(
        'D1', '2026-06-01T12:00:00Z', dry_run=True, audit_message='Restore to yesterday'))
    assert 'dry-run=true' in op['path']
    assert 'audit-message=Restore%20to%20yesterday' in op['path']
