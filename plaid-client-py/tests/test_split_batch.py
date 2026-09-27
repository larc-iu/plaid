"""A batch over MAX_BATCH_OPS goes as consecutive requests (see
``PlaidClient._post_batch``). These pin what each request carries and what the
caller gets back."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import MAX_BATCH_OPS, PlaidClient


def _version_of(path):
    values = parse_qs(urlparse(path).query).get('document-version')
    return values[0] if values else None


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'
    headers = {'content-type': 'application/json'}

    def __init__(self, results):
        self._results = results

    def json(self):
        return self._results


def _stub_batch_server(client, start):
    """Answers each batch POST as the server does: one result per op, and each
    result's X-Document-Versions header says the version after that op (every
    op bumps the document once). Returns the ops each request carried."""
    requests = []
    version = [start]

    class _Session:
        def post(self, url, headers=None, data=None, timeout=None):
            ops = json.loads(data)
            requests.append(ops)
            results = []
            for _ in ops:
                version[0] += 1
                results.append({
                    'status': 200,
                    'headers': {'X-Document-Versions': json.dumps({'d1': version[0]}),
                                'Content-Type': 'application/json'},
                    'body': {'token/id': 't1', 'token/begin': 0,
                             'document/version': version[0]},
                })
            return _Resp(results)

        def close(self):
            pass

    client.session = _Session()
    return requests


def test_a_split_strict_batch_claims_on_each_later_request_the_version_the_one_before_left():
    client = PlaidClient('http://x', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions = {'d1': 21}
    requests = _stub_batch_server(client, 21)
    b = client.batch()
    for i in range(MAX_BATCH_OPS + 1):
        b.tokens.patch_metadata(f't{i}', [{'op': 'set', 'path': ['k'], 'value': i}])
    results = b.submit()

    assert len(results) == MAX_BATCH_OPS + 1
    assert len(requests) == 2
    assert all(_version_of(op['path']) == '21' for op in requests[0])
    # The first request bumped the document once per op, so the second must
    # claim what the first left, not what the document had at queue time.
    assert [_version_of(op['path']) for op in requests[1]] == [str(21 + MAX_BATCH_OPS)]
    assert client.document_versions['d1'] == 22 + MAX_BATCH_OPS


def test_a_batch_result_keeps_its_status_and_headers_and_only_its_body_is_recased():
    client = PlaidClient('http://x', 'tok')
    _stub_batch_server(client, 1)
    b = client.batch()
    b.tokens.delete('t1')
    [result] = b.submit()

    assert sorted(result['headers']) == ['Content-Type', 'X-Document-Versions']
    assert result['body'] == {'id': 't1', 'begin': 0, 'version': 2}
    assert result['status'] == 200
