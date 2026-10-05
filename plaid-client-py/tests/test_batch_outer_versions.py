"""A layer rule's remedy runs at the end of a batch, after its last operation,
and moves the version of the document it repaired once more. No operation's
answer holds that version, only the batch's own X-Document-Versions header. A
strict-mode client that missed it had its next write refused with a 409."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


def _version_of(path):
    values = parse_qs(urlparse(path).query).get('document-version')
    return values[0] if values else None


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, results, outer):
        self._results = results
        self.headers = {'content-type': 'application/json',
                        'X-Document-Versions': json.dumps(outer)}

    def json(self):
        return self._results


def test_a_batchs_own_versions_header_is_the_version_the_next_write_claims():
    client = PlaidClient('http://x', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions = {'d1': 20}
    sent = []

    class _Session:
        def post(self, url, headers=None, data=None, timeout=None):
            ops = json.loads(data)
            sent.append(ops)
            return _Resp([{'status': 200,
                           'headers': {'X-Document-Versions': json.dumps({'d1': 21})},
                           'body': {'token/id': 't1'}} for _ in ops], {'d1': 22})

        def close(self):
            pass

    client.session = _Session()
    with client.batched() as b:
        b.tokens.split('s1', 11)
    assert client.document_versions['d1'] == 22
    with client.batched() as b:
        b.tokens.split('s2', 19)
    assert _version_of(sent[0][0]['path']) == '20'
    assert _version_of(sent[1][0]['path']) == '22'
