"""Logical operations (audit-log grouping) — network-free paths.

Batch mode queues operations instead of sending them, so we can assert the
``?group-id=`` / ``group-message`` params are stamped on each queued op's path
without a live server. The server-side fold is covered by plaid-core's
operation-group-test.
"""

import json
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
from plaid_client import PlaidClient, PlaidAPIError

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def _client():
    return PlaidClient('http://localhost:0', 'dummy-token')


def _queue(client):
    client.begin_batch()
    client.spans.set_metadata('S1', {'a': 1})
    client.spans.set_metadata('S2', {'b': 2})
    paths = [op['path'] for op in client.batch_operations]
    client.abort_batch()
    return paths


def _params(path):
    return {k: v[0] for k, v in parse_qs(urlparse(path).query).items()}


class _Resp:
    def __init__(self, status=200, body=None):
        self.ok = status < 400
        self.status_code = status
        self.reason = 'OK' if self.ok else 'Not Found'
        self.headers = {'Content-Type': 'application/json'}
        self._body = body if body is not None else {}
        self.text = json.dumps(self._body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _stub_session(client, status=200):
    calls = []

    class _Sess:
        def request(self, **kw):
            calls.append(kw)
            return _Resp(status, {'error': 'Operation group not found'} if status == 404 else {})

        def close(self):
            pass

    client.session = _Sess()
    return calls


def test_begin_operation_stamps_group_id_and_message():
    client = _client()
    gid = client.begin_operation('Merge morphemes')
    assert UUID_RE.match(gid)
    for p in _queue(client):
        params = _params(p)
        assert params['group-id'] == gid
        assert params['group-message'] == 'Merge morphemes'


def test_end_operation_without_refine_is_local():
    client = _client()
    calls = _stub_session(client)
    client.begin_operation('x')
    _queue(client)
    client.end_operation()
    assert calls == []
    assert client._operation_group is None
    assert all('group-id' not in p for p in _queue(client))


def test_end_operation_with_refine_patches_when_written():
    client = _client()
    calls = _stub_session(client)
    gid = client.begin_operation('Merge morphemes')
    _queue(client)
    client.end_operation('Merged 3 morphemes')
    assert len(calls) == 1
    assert calls[0]['method'] == 'PATCH'
    assert calls[0]['url'].endswith(f'/api/v1/operation-groups/{gid}')
    assert json.loads(calls[0]['data']) == {'message': 'Merged 3 morphemes'}


def test_end_operation_with_refine_skips_patch_when_nothing_written():
    client = _client()
    calls = _stub_session(client)
    client.begin_operation('nothing')
    client.end_operation('still nothing')
    assert calls == []


def test_end_operation_tolerates_404():
    client = _client()
    _stub_session(client, status=404)
    client.begin_operation('x')
    _queue(client)
    client.end_operation('y')  # must not raise


def test_nested_begin_flattens_into_outer():
    client = _client()
    calls = _stub_session(client)
    outer = client.begin_operation('outer')
    inner = client.begin_operation('inner')
    assert inner == outer
    for p in _queue(client):
        assert _params(p)['group-id'] == outer
        assert _params(p)['group-message'] == 'outer'
    client.end_operation('inner refine is ignored')
    assert client._operation_group is not None
    assert all(_params(p)['group-id'] == outer for p in _queue(client))
    client.end_operation()
    assert client._operation_group is None
    assert calls == []


def test_context_manager_scopes_and_ends_on_exception():
    client = _client()
    with client.operation('Tokenize') as op:
        assert UUID_RE.match(op.id)
        paths = _queue(client)
    assert all('group-message=Tokenize' in p for p in paths)
    assert client._operation_group is None

    with pytest.raises(RuntimeError):
        with client.operation('boom'):
            _queue(client)
            raise RuntimeError('boom')
    assert client._operation_group is None


def test_context_manager_set_message_refines_at_end():
    client = _client()
    calls = _stub_session(client)
    with client.operation('Merge') as op:
        _queue(client)
        op.set_message('Merged 2')
    assert len(calls) == 1
    assert json.loads(calls[0]['data']) == {'message': 'Merged 2'}


def test_get_requests_never_carry_group_id():
    client = _client()
    client.begin_operation('x')
    client.begin_batch()
    client.spans.get('S1')
    paths = [op['path'] for op in client.batch_operations]
    client.abort_batch()
    assert all('group-id' not in p for p in paths)
    assert client._operation_group['written'] is False


def test_group_params_coexist_with_document_version_and_audit_message():
    client = _client()
    client.enter_strict_mode('D1')
    client.document_versions['D1'] = '7'
    gid = client.begin_operation('Combined')
    client.begin_batch()
    client.spans.set_metadata('S1', {'a': 1}, audit_message='Step {span_id}')
    path = client.batch_operations[0]['path']
    client.abort_batch()
    params = _params(path)
    assert params['document-version'] == '7'
    assert params['audit-message'] == 'Step {span_id}'
    assert params['group-id'] == gid
    assert params['group-message'] == 'Combined'
