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


class _FailResp:
    ok = False
    reason = 'Not Found'
    headers = {'content-type': 'application/json'}

    def __init__(self, status):
        self.status_code = status
        self.text = json.dumps({'error': 'Token t2400 not found'})

    def json(self):
        return {'error': 'Token t2400 not found'}


def _submit_failing(op_count, ok_requests, status):
    """Submit ``op_count`` deletes to a server that answers the first
    ``ok_requests`` batch POSTs and fails the next, with ``status`` or, when it
    is 0, with a dropped connection. Returns the error raised."""
    import pytest
    import requests as requests_lib

    client = PlaidClient('http://x', 'tok')
    sent = []

    class _Session:
        def post(self, url, headers=None, data=None, timeout=None):
            ops = json.loads(data)
            sent.append(ops)
            if len(sent) > ok_requests:
                if status == 0:
                    raise requests_lib.ConnectionError('Connection refused')
                return _FailResp(status)
            return _Resp([{'status': 204, 'headers': {}, 'body': {'token/id': 't'}}
                          for _ in ops])

        def close(self):
            pass

    client.session = _Session()
    b = client.batch()
    for i in range(op_count):
        b.tokens.delete(f't{i}')
    with pytest.raises(Exception) as info:
        b.submit()
    return info.value


def test_a_split_batch_that_fails_part_way_says_how_many_operations_were_saved():
    error = _submit_failing(2500, 2, 404)
    assert error.status == 404
    assert error.committed == 2000
    assert len(error.committed_results) == 2000
    assert error.committed_results[0]['body'] == {'id': 't'}


def test_a_batch_refused_at_its_first_request_saved_nothing_and_says_so():
    error = _submit_failing(3, 0, 404)
    assert error.status == 404
    assert error.committed == 0
    assert error.committed_results == []


def test_a_connection_lost_on_a_later_request_still_reports_the_requests_before_it():
    error = _submit_failing(1500, 1, 0)
    assert error.status == 0
    assert error.committed == 1000
    assert len(error.committed_results) == 1000
