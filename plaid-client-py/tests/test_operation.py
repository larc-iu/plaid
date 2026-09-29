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
    b = client.batch()
    b.spans.set_metadata('S1', {'a': 1})
    b.spans.set_metadata('S2', {'b': 2})
    paths = [op['path'] for op in b.operations]
    b.abort()
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
    # A read never joins a batch, so the URL is observed on the wire.
    client = _client()
    client.begin_operation('x')
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
    client.spans.get('S1')
    assert len(urls) == 1
    assert 'group-id' not in urls[0]
    assert client._operation_group['written'] is False


def test_an_out_of_band_signal_never_joins_the_operation():
    # Shaped like a write, carrying no project data, never audited: a lock
    # taken or renewed, a stopped service request, a service reporting itself,
    # an admin control, and the query that travels as a POST. Stamping one
    # does nothing server-side and marks the group written, which promises a
    # group nothing ever created. The lock beat that renews a held lock puts a
    # POST inside every long operation, so this is not a corner case.
    from plaid_client.services import _report_event, cancel_service_request

    client = _client()
    calls = _stub_session(client)
    gid = client.begin_operation('Parse the document')

    client.documents.acquire_lock('D1')          # taking the lock
    client.documents.renew_lock('D1', 'L1')      # the keep-alive beat
    client.documents.release_lock('D1', 'L1')
    cancel_service_request(client, 'P1', 'R1')
    _report_event(client, 'P1', 'R1', {'status': 'progress'})
    client.admin.backup()
    client.admin.release_lock('D1')
    client.admin.clear_rate_limits()
    client.query({'find': ['?t'], 'where': []})

    assert len(calls) == 9
    stamped = [c['url'] for c in calls if 'group-id' in c.get('url', '')]
    assert stamped == [], f'these signals joined the operation: {stamped}'
    assert client._operation_group['written'] is False

    # So the relabel is skipped rather than PATCHing a group that never
    # materialized.
    client.end_operation('Parsed 40 sentences')
    assert len(calls) == 9
    assert not any(c['method'] == 'PATCH' for c in calls)
    assert gid  # the id was still minted for the writes that may yet come


def test_a_real_write_still_marks_the_operation_written():
    # The other side of the same rule: nothing above narrowed what a write does.
    client = _client()
    calls = _stub_session(client)
    gid = client.begin_operation('Parse the document')
    client.documents.acquire_lock('D1')
    client.spans.set_metadata('S1', {'a': 1})
    assert client._operation_group['written'] is True
    client.end_operation('Parsed 40 sentences')
    patches = [c for c in calls if c['method'] == 'PATCH']
    assert len(patches) == 1
    assert patches[0]['url'].endswith(f'/api/v1/operation-groups/{gid}')


def test_group_params_coexist_with_document_version_and_audit_message():
    client = _client()
    client.enter_strict_mode('D1')
    client.document_versions['D1'] = '7'
    gid = client.begin_operation('Combined')
    b = client.batch()
    b.spans.set_metadata('S1', {'a': 1}, audit_message='Step {span_id}')
    path = b.operations[0]['path']
    b.abort()
    params = _params(path)
    assert params['document-version'] == '7'
    assert params['audit-message'] == 'Step {span_id}'
    assert params['group-id'] == gid
    assert params['group-message'] == 'Combined'


def test_begin_operation_can_adopt_a_group_id():
    client = _client()
    gid = client.begin_operation('outer label', group_id='11111111-2222-4333-8444-555555555555')
    assert gid == '11111111-2222-4333-8444-555555555555'
    assert all(_params(p)['group-id'] == gid for p in _queue(client))


def test_base_service_joins_the_requesters_operation():
    from plaid_client.service import BaseService

    seen = {}

    class _Svc(BaseService):
        def process_request(self, request_data, response_helper):
            seen['request_data'] = dict(request_data)
            seen['group'] = dict(self.client._operation_group) if self.client._operation_group else None
            # the service's own operation flattens into the requester's
            with self.client.operation('inner label'):
                seen['inner_id'] = self.client._operation_group['id']
                seen['inner_msg'] = self.client._operation_group['message']

    svc = _Svc('svc', 'Svc', 'test')
    svc.client = _client()

    class _Helper:
        def progress(self, *a): pass
        def complete(self, *a): pass
        def error(self, *a): seen['error'] = a

    # The work runs on its own thread now, so the SSE reader stays free to
    # deliver a `service_cancel` for this very request.
    svc.handle_service_request(
        {'document_id': 'D', 'operation_group': {'id': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'message': 'Re-transcribe'}},
        _Helper()).join(5)
    assert 'error' not in seen
    assert seen['request_data'] == {'document_id': 'D'}, 'operation_group is popped before process_request'
    assert seen['group']['id'] == 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    assert seen['group']['message'] == 'Re-transcribe'
    assert seen['inner_id'] == 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    assert seen['inner_msg'] == 'Re-transcribe'
    assert svc.client._operation_group is None, 'ended after the request'

    # without a propagated group the service runs unjoined
    seen.clear()
    svc.handle_service_request({'document_id': 'D'}, _Helper()).join(5)
    assert seen['group'] is None
    assert seen['inner_msg'] == 'inner label'


def _joining_service(users_get):
    """A service that records the group it runs under and the params of its
    first write, with the client's user read stubbed."""
    from plaid_client.service import BaseService

    seen = {}

    class _Svc(BaseService):
        def process_request(self, request_data, response_helper):
            seen['message'] = self.client._operation_group['message']
            seen['first'] = _params(_queue(self.client)[0])

    svc = _Svc('svc', 'Svc', 'test')
    svc.client = _client()
    svc.client.users.get = users_get

    class _Helper:
        def progress(self, *a): pass
        def complete(self, *a): pass
        def error(self, *a): seen['error'] = a

    return svc, _Helper(), seen


def test_a_joined_operation_names_the_requester_when_the_service_writes_first():
    # igt Transcribe on a document with no transcript: the app opens
    # "Transcribe audio (Whisper)" and the service's write comes first, so
    # core names the History entry from the service's group-message. It must
    # carry the requester, or the entry reads "by <operator>" and names
    # nobody who asked.
    gid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    svc, helper, seen = _joining_service(lambda uid: {'id': uid, 'display_name': 'Ana Second'})
    svc.handle_service_request(
        {'document_id': 'D', 'requester_id': 'second@x.com',
         'operation_group': {'id': gid, 'message': 'Transcribe audio (Whisper)'}},
        helper).join(5)
    assert 'error' not in seen
    assert seen['message'] == 'Transcribe audio (Whisper), requested by Ana Second'
    assert seen['first']['group-id'] == gid
    assert seen['first']['group-message'] == 'Transcribe audio (Whisper), requested by Ana Second'


def test_a_joined_operation_falls_back_to_the_requester_id_and_leaves_no_requester_alone():
    gid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

    def unreadable(uid):
        raise RuntimeError('404 Not found')

    svc, helper, seen = _joining_service(unreadable)
    svc.handle_service_request(
        {'requester_id': 'second@x.com', 'operation_group': {'id': gid, 'message': 'Parse'}},
        helper).join(5)
    assert seen['first']['group-message'] == 'Parse, requested by second@x.com'

    # No requester (a run started outside a service request): the label as it came.
    def never(uid):
        raise AssertionError('no user to read')

    svc, helper, seen = _joining_service(never)
    svc.handle_service_request({'operation_group': {'id': gid, 'message': 'Parse'}}, helper).join(5)
    assert 'error' not in seen
    assert seen['first']['group-message'] == 'Parse'


def test_a_broadcast_message_never_joins_the_operation():
    # A broadcast message is not written anywhere, so it has no History entry
    # to join. Sent inside an operation it once took the group stamp and
    # marked the group written, and the relabel then PATCHed a group that
    # never existed. It stays batchable, so a message queued after the writes
    # still goes out after them, only without the stamp.
    import inspect

    client = _client()
    calls = _stub_session(client)
    client.begin_operation('Parse')
    client.messages.send_message('P1', {'purpose': 'parsed'})
    assert len(calls) == 1
    assert 'group-id' not in calls[0]['url']
    assert client._operation_group['written'] is False

    b = client.batch()
    b.spans.set_metadata('S1', {'a': 1})
    b.messages.send_message('P1', {'purpose': 'parsed'})
    write, message = [op['path'] for op in b.operations]
    b.abort()
    assert 'group-id=' in write
    assert message.endswith('/api/v1/projects/P1/message')

    # The label parameter is gone.
    assert list(inspect.signature(client.messages.send_message).parameters) == \
        ['project_id', 'data']


def test_an_operation_that_only_sends_messages_asks_for_no_relabel():
    # The ruling's example: an assistant wraps "the parse finished" in an
    # operation and writes nothing else. Sent directly, queued on a submitted
    # batch, or from a nested operation, the message leaves the operation
    # unwritten, so the refined label is never PATCHed to a group that does
    # not exist.
    client = _client()
    calls = _stub_session(client)
    batches = []

    def post(url, headers=None, data=None, timeout=None):
        batches.append([op['path'] for op in json.loads(data)])
        return _Resp(200, [{'status': 200, 'headers': {}, 'body': {}}])

    client.session.post = post
    with client.operation('Parse') as op:
        with client.batched() as b:
            b.messages.send_message('P1', {'purpose': 'parsed'})
        client.messages.send_message('P1', {'purpose': 'parsed'})
        with client.operation('Inner') as inner:
            client.messages.send_message('P1', {'purpose': 'parsed'})
            inner.set_message('Inner done')
        op.set_message('Parsed')
    assert batches == [['/api/v1/projects/P1/message']]
    assert [(c['method'], urlparse(c['url']).path) for c in calls] == [
        ('POST', '/api/v1/projects/P1/message'),
        ('POST', '/api/v1/projects/P1/message'),
    ]


# Kind and ref: what a study of the log counts by and joins on. Stamped on
# every write beside the id, like the message, and carried to a service.

def test_begin_operation_stamps_group_kind_and_ref():
    client = _client()
    client.begin_operation('Assistant: gloss', kind='assistant-plan', ref='conv:c/plan:p')
    for p in _queue(client):
        params = _params(p)
        assert params['group-kind'] == 'assistant-plan'
        assert params['group-ref'] == 'conv:c/plan:p'
    client.end_operation()
    assert all('group-kind' not in p and 'group-ref' not in p for p in _queue(client))


def test_an_operation_with_no_kind_or_ref_sends_neither():
    client = _client()
    client.begin_operation('Plain')
    assert all('group-kind' not in p and 'group-ref' not in p for p in _queue(client))


def test_operation_context_manager_takes_kind_and_ref():
    client = _client()
    with client.operation('Import ELAN corpus', kind='import', ref='format:elan'):
        paths = _queue(client)
    assert all(_params(p)['group-kind'] == 'import' for p in paths)
    assert all(_params(p)['group-ref'] == 'format:elan' for p in paths)


def test_a_nested_operation_keeps_the_outer_kind_and_ref():
    client = _client()
    with client.operation('outer', kind='assistant-plan', ref='plan:1'):
        with client.operation('inner', kind='service-run', ref='service:x'):
            paths = _queue(client)
    assert all(_params(p)['group-kind'] == 'assistant-plan' for p in paths)
    assert all(_params(p)['group-ref'] == 'plan:1' for p in paths)


def test_request_service_carries_the_kind_and_ref(monkeypatch):
    from plaid_client import services
    client = _client()
    sent = {}

    class _Refused:
        status_code = 500
        ok = False
        text = 'nope'
        reason = 'nope'
        headers = {}

        def close(self):
            pass

    def post(url, headers=None, json=None, stream=None, timeout=None):
        sent['body'] = json
        return _Refused()

    monkeypatch.setattr(services.requests, 'post', post)
    gid = client.begin_operation('Transcribe', kind='service-run', ref='service:asr')
    with pytest.raises(Exception):
        services.request_service(client, 'P', 'svc', {'document_id': 'D'}, timeout=1)
    assert sent['body']['operation-group'] == {'id': gid, 'message': 'Transcribe',
                                               'kind': 'service-run', 'ref': 'service:asr'}



def test_request_service_with_no_operation_carries_none(monkeypatch):
    # One client holds one open operation, so a request that is its own
    # action (approving an assistant's plan, starting a service run) made
    # while another operation is open would put every write it causes under
    # that operation and its kind. With no_operation the service starts its own.
    from plaid_client import services
    client = _client()
    sent = {}

    class _Refused:
        status_code = 500
        ok = False
        text = 'nope'
        reason = 'nope'
        headers = {}

        def close(self):
            pass

    def post(url, headers=None, json=None, stream=None, timeout=None):
        sent['body'] = json
        return _Refused()

    monkeypatch.setattr(services.requests, 'post', post)
    client.begin_operation('Gloss', kind='guess-adoption')
    with pytest.raises(Exception):
        client.messages.request_service('P', 'svc', {'approve': {'plan_id': 'p1'}}, timeout=1, no_operation=True)
    assert sent['body'] == {'approve': {'plan-id': 'p1'}}
    with pytest.raises(Exception):
        services.request_service(client, 'P', 'svc', {'document_id': 'D'}, timeout=1, no_operation=True)
    assert sent['body'] == {'document-id': 'D'}

def test_base_service_joins_the_requesters_kind_and_ref():
    # The service may write before the requester does, and then its write
    # creates the group, so it must carry the kind and ref too.
    gid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    svc, helper, seen = _joining_service(lambda uid: {'id': uid, 'display_name': 'Ana'})
    svc.handle_service_request(
        {'document_id': 'D', 'operation_group': {'id': gid, 'message': 'Parse', 'kind': 'assistant-plan',
                                                 'ref': 'conv:c/plan:p'}},
        helper).join(5)
    assert 'error' not in seen
    assert seen['first']['group-kind'] == 'assistant-plan'
    assert seen['first']['group-ref'] == 'conv:c/plan:p'
