"""documents.copy builds one POST carrying the new name and, when it is
turned off, the media flag. Batch mode queues the request, so the path and
body can be checked without a server.
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


def test_copy_posts_the_new_name_to_the_document():
    [op] = _queued(lambda c: c.documents.copy('D1', 'Doc, copy'))
    assert op['method'] == 'POST'
    assert op['path'] == '/api/v1/documents/D1/copy'
    assert op['body'] == {'name': 'Doc, copy'}


def test_leaving_the_media_behind_says_so_and_the_audit_message_rides_along():
    [op] = _queued(lambda c: c.documents.copy(
        'D1', 'Doc, copy', include_media=False, audit_message='Copy for the class'))
    assert op['body'] == {'name': 'Doc, copy', 'include-media': False}
    assert 'audit-message=Copy%20for%20the%20class' in op['path']
