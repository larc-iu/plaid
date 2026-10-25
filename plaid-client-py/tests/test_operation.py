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
from plaid_client.testing import Response, recording_session

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


def _stub_session(client, status=200):
    client.session = recording_session([(status, {'error': 'Operation group not found'} if status == 404 else {})])
    return client.session.sent


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
    client.spans.set_metadata('S1', {'a': 1})
    client.end_operation('Merged 3 morphemes')
    assert len(calls) == 2
    assert calls[1]['method'] == 'PATCH'
    assert calls[1]['url'].endswith(f'/api/v1/operation-groups/{gid}')
    assert json.loads(calls[1]['data']) == {'message': 'Merged 3 morphemes'}


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
    client._operation_group['written'] = True
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
        client.spans.set_metadata('S1', {'a': 1})
        op.set_message('Merged 2')
    assert len(calls) == 2
    assert json.loads(calls[1]['data']) == {'message': 'Merged 2'}


def test_get_requests_never_carry_group_id():
    # A read never joins a batch, so the URL is observed on the wire.
    client = _client()
    client.begin_operation('x')
    client.session = recording_session()
    client.spans.get('S1')
    urls = [request['url'] for request in client.session.sent]
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
        return Response(200, [{'status': 200, 'headers': {}, 'body': {}}])

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


# --- a group counts as written only once the server took a write in it ------
# (conc-2026-09-29, the Python twin of plaid-client-js b31e9f4b)

def _batch_session(client, status):
    def answer(request):
        if not request['url'].endswith('/api/v1/batch'):
            return {}
        body = json.loads(request['data'])
        return (status, [{'status': 200, 'headers': {}, 'body': {}} for _ in body]
                if status < 400 else {'error': 'Document version mismatch'})

    client.session = recording_session(answer)
    return client.session.sent


def test_an_operation_whose_only_write_was_refused_is_not_relabelled():
    client = _client()
    calls = _stub_session(client, status=409)
    client.begin_operation('Merge morphemes')
    with pytest.raises(PlaidAPIError):
        client.spans.set_metadata('S1', {'a': 1})
    assert client._operation_group['written'] is False
    client.end_operation('Merged 3 morphemes')
    assert [c['method'] for c in calls] == ['PUT']


def test_an_operation_whose_batch_was_refused_or_dropped_is_not_relabelled():
    client = _client()
    calls = _batch_session(client, 409)
    client.begin_operation('Parse')
    with pytest.raises(PlaidAPIError):
        with client.batched() as b:
            b.spans.set_metadata('S1', {'a': 1})
    # A batch the block gave up on sends nothing.
    with pytest.raises(RuntimeError):
        with client.batched() as b:
            b.spans.set_metadata('S2', {'a': 1})
            raise RuntimeError('stopped')
    assert client._operation_group['written'] is False
    client.end_operation('Parsed 40 sentences')
    assert [c['method'] for c in calls] == ['POST']


def test_an_operation_whose_batch_was_taken_is_relabelled():
    client = _client()
    calls = _batch_session(client, 200)
    gid = client.begin_operation('Parse')
    with client.batched() as b:
        b.spans.set_metadata('S1', {'a': 1})
    assert client._operation_group['written'] is True
    client.end_operation('Parsed 40 sentences')
    assert [c['method'] for c in calls] == ['POST', 'PATCH']
    assert calls[1]['url'].endswith(f'/api/v1/operation-groups/{gid}')


def test_a_refused_relabel_does_not_replace_the_error_the_block_raised():
    # A delegated token is scoped to projects, and a group names none, so the
    # core refuses its relabel with 403. An assistant plan that stopped
    # partway relabels its group as it raises: the 403 took the place of the
    # plan's own error, and the card said "Applying did not finish" with an
    # Apply again, where it should have said Partly applied.
    client = _client()
    client.session = recording_session(
        lambda request: (403, {'error': 'This token reaches only the projects it was issued for.'})
        if request['method'] == 'PATCH' else {})
    calls = client.session.sent
    with pytest.raises(RuntimeError, match='plan failed'):
        with client.operation('Assistant: 3 changes') as op:
            client.spans.set_metadata('S1', {'a': 1})
            op.set_message('Assistant, partly applied: 1 change')
            raise RuntimeError('plan failed')
    assert [c['method'] for c in calls] == ['PUT', 'PATCH']
    assert client._operation_group is None


def test_a_refused_relabel_after_a_block_that_ended_well_still_raises():
    client = _client()
    _stub_session(client, status=200)

    def patch_refused(**kw):
        return Response(403 if kw['method'] == 'PATCH' else 200, {'error': 'no'})

    client.session.request = patch_refused
    with pytest.raises(PlaidAPIError):
        with client.operation('Merge') as op:
            client.spans.set_metadata('S1', {'a': 1})
            op.set_message('Merged 2')


# The kinds are the server's closed list (plaid.sql.operation-group/kinds),
# which core's operation-kinds-test holds operation_kinds.json to. The client
# refuses any other when the operation begins, so a script with a misspelt kind
# stops before its first write instead of failing at it.
_KINDS_FILE = os.path.join(os.path.dirname(__file__), '..', '..', 'plaid-core', 'src', 'test', 'plaid', 'sql',
                           'operation_kinds.json')


def _core_kinds():
    with open(_KINDS_FILE, encoding='utf-8') as f:
        return json.load(f)['kinds']


def test_begin_operation_takes_every_kind_the_server_takes():
    kinds = _core_kinds()
    assert len(kinds) >= 7, kinds
    for kind in kinds:
        client = _client()
        client.begin_operation('x', kind=kind)
        assert client._operation_group['kind'] == kind


# Beta review B1-9: the closed list is written in five places, and the test
# above only holds the clients to accepting core's. One kind added to a client
# alone, or to the manual alone, passed everything.
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_KIND_SOURCES = {
    'js': 'plaid-client-js/src/operations.js',
    'js_types': 'plaid-client-js/src/types.js',
    'python': 'plaid-client-py/src/plaid_client/operations.py',
    'manual': 'plaid-core/docs/manual.adoc',
    'ui': 'plaid-ui/src/lib/auditText.js',
}


def _kind_lists(texts):
    """Each written list of operation kinds, read out of its file's text."""
    js_array = re.search(r'const OPERATION_KINDS = \[([^\]]*)\]', texts['js']).group(1)
    js_type = re.search(r'@typedef \{([^}]*)\} OperationKind', texts['js_types']).group(1)
    py = re.search(r'_OPERATION_KINDS = \(([^)]*)\)', texts['python']).group(1)
    section = texts['manual'].split('=== Kinds of operation', 1)[1]
    table = section.split('|===', 2)[1]
    # One row per blank-line-separated block, after the header; its first
    # cell is the kind.
    rows = [block.strip().split('\n')[0] for block in table.strip().split('\n\n')[1:]]
    labels = re.search(r'const KIND_LABELS = \{([^}]*)\}', texts['ui']).group(1)
    return {
        'core operation_kinds.json': texts['core'],
        'plaid-client-js OPERATION_KINDS': re.findall(r'"([^"]+)"', js_array),
        'plaid-client-js OperationKind typedef': re.findall(r'"([^"]+)"', js_type),
        'plaid-client-py _OPERATION_KINDS': re.findall(r"'([^']+)'", py),
        'the manual\'s Kinds of operation table': [re.match(r'\|`([^`]+)`', r).group(1) for r in rows],
        'plaid-ui KIND_LABELS': re.findall(r"^\s*'?([\w-]+)'?:", labels, re.M),
    }


def _kind_disagreements(lists):
    want = sorted(lists['core operation_kinds.json'])
    return [f'{name} has {sorted(kinds)}, core has {want}'
            for name, kinds in lists.items() if sorted(kinds) != want or len(set(kinds)) != len(kinds)]


def _kind_texts():
    texts = {k: open(os.path.join(_REPO, p), encoding='utf-8').read() for k, p in _KIND_SOURCES.items()}
    return {**texts, 'core': _core_kinds()}


def test_every_list_of_operation_kinds_is_cores():
    lists = _kind_lists(_kind_texts())
    assert all(len(kinds) >= 7 for kinds in lists.values()), lists
    problems = _kind_disagreements(lists)
    assert problems == [], (
        'The operation kinds disagree:\n  ' + '\n  '.join(problems) + '\nA kind is added or removed in '
        'all six at once: core plaid.sql.operation-group/kinds (and its case file, operation_kinds.json), plaid-client-js OPERATION_KINDS and the '
        'OperationKind typedef, plaid-client-py _OPERATION_KINDS, the manual\'s "Kinds of operation" table, and plaid-ui '
        'KIND_LABELS in auditText.js (what History calls the kind).')


def test_a_kind_in_one_list_alone_is_named():
    texts = _kind_texts()
    texts['js'] = texts['js'].replace('const OPERATION_KINDS = [', 'const OPERATION_KINDS = [\n  "export",', 1)
    texts['python'] = texts['python'].replace("'review')", "'reviews')", 1)
    texts['manual'] = texts['manual'].replace('|`guess-adoption`', '|`guess`', 1)
    texts['ui'] = texts['ui'].replace("  repair: 'Repair',\n", '', 1)
    named = [p.split(' has ')[0] for p in _kind_disagreements(_kind_lists(texts))]
    assert named == ['plaid-client-js OPERATION_KINDS', 'plaid-client-py _OPERATION_KINDS',
                     'the manual\'s Kinds of operation table', 'plaid-ui KIND_LABELS']


def test_an_unknown_kind_raises_before_anything_is_written():
    client = _client()
    with pytest.raises(ValueError, match=r'Unknown operation kind "imports"\. It is one of: assistant-plan, service-run'):
        client.begin_operation('Import', kind='imports')
    assert client._operation_group is None
    ran = []
    with pytest.raises(ValueError, match='Unknown operation kind'):
        with client.operation('Import', kind='Import'):
            ran.append(1)
    assert ran == []
    assert client._operation_group is None
    # A nested one is refused too, and leaves the outer one as it was.
    client.begin_operation('outer', kind='import')
    with pytest.raises(ValueError, match='Unknown operation kind'):
        client.begin_operation('inner', kind='nope')
    assert client._operation_group['depth'] == 1


def test_the_fake_client_refuses_an_unknown_kind_too():
    from plaid_client.testing import FakeClient
    fake = FakeClient({})
    with pytest.raises(ValueError, match='Unknown operation kind'):
        with fake.operation('x', kind='bulk_edit'):
            pass
