"""A media delete names the recording it means (H36-SETTINGS-LIVE-1): the
server refuses it 409 when the stored recording is another one."""

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


def test_delete_media_sends_the_recording_it_means_as_media_version():
    client = PlaidClient('http://x', 'tok')
    b = client.batch()
    try:
        b.documents.delete_media('d1', media_version='1700000000000-5')
        b.documents.delete_media('d2')
        named, bare = b.operations
        assert named['method'] == 'DELETE'
        assert re.match(r'^/api/v1/documents/d1/media\?(.*&)?media-version=1700000000000-5(&|$)',
                        named['path'])
        assert 'media-version' not in bare['path']
    finally:
        b.abort()
