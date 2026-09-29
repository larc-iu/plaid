"""A write whose answer never came back may have been saved (conc-2026-09-29 V8).

H8-2: a plan batch the core committed, whose answer was lost, counted as not
applied. The user was told "PlaidAPIError: Network error: ... Nothing was
written", and approving again wrote the plan a second time over the first
attempt's leftovers.

H8-6: a lost answer to the service's save of the turn left the sidebar entry
unwritten, so the turn read as unfinished, and Retry asked the model the same
question twice. The save said "could not be reached.." with two periods.
"""

import pytest

from plaid_client import PlaidAPIError

import test_stale_by_sentence as sbs
from fixtures import FakeClient
from test_service_flow import Helper, _request, _seed, _service

from plaid_agent.core import plan as core_plan
from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import ConversationStore

APPS = sbs.APPS


def _lost(method='POST', path='/api/v1/batch'):
    # As the real client raises one: the network's own error under it.
    return PlaidAPIError(f'Network error: Remote end closed connection at http://h:8085{path}',
                         status=0, url=f'http://h:8085{path}', method=method,
                         original_error=ConnectionError('Remote end closed connection'))


@pytest.fixture(params=sorted(APPS))
def spec(request):
    return APPS[request.param]()


def _stored(spec, client):
    conv, _ = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    return conv['display'][1]


def test_a_batch_whose_answer_was_lost_counts_as_maybe_written(spec, monkeypatch):
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    real = core_plan.Batcher.flush

    def committed_but_unanswered(self):
        real(self)
        raise _lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', committed_but_unanswered)
    svc = spec['service']()
    spec = {**spec, 'service': lambda: svc}   # one running service, as in production
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors
    [done] = helper.done
    rows = len(plan['ops'])
    assert done['message'] == (f'Partly applied: 0 of {rows} changes written. '
                               'The server did not answer for the rest.')
    item = _stored(spec, client)
    assert item['status'] == 'partial' and item['unknown'] is True

    # Approving again does not write the plan a second time.
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    before = len(client.writes)
    sbs._approve(spec, client, plan)
    assert len(client.writes) == before


def test_a_refused_connection_still_says_nothing_was_written():
    import requests
    import urllib3
    refused = PlaidAPIError('Network error: refused at http://h:8085/api/v1/batch', status=0,
                            url='http://h:8085/api/v1/batch', method='POST',
                            original_error=requests.exceptions.ConnectionError(
                                urllib3.exceptions.MaxRetryError(
                                    None, '/', urllib3.exceptions.NewConnectionError(None, 'no'))))
    assert not core_plan.outcome_unknown(refused)
    assert core_plan.outcome_unknown(_lost())
    assert not core_plan.outcome_unknown(_lost('GET', '/api/v1/documents/d1'))


def test_a_client_error_reaches_the_user_without_its_class_or_address():
    def run(tracker):
        raise PlaidAPIError('HTTP 400 Span value is required at http://h:8085/api/v1/spans',
                            status=400, url='http://h:8085/api/v1/spans', method='POST')

    with pytest.raises(core_plan.PlanError) as caught:
        core_plan.applying([{'kind': 'x'}], run)
    assert str(caught.value) == 'HTTP 400 Span value is required'
    assert caught.value.unknown is False


def test_a_conversation_save_whose_answer_was_lost_is_sent_again():
    client = FakeClient()
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    real = client.user_data.put
    failures = [_lost('PUT', '/api/v1/users/u@x/data/k')]

    def put(user_id, key, value):
        real(user_id, key, value)
        if failures:
            raise failures.pop()

    client.user_data.put = put
    store.save('c1', {'messages': [], 'display': []}, {'id': 'c1', 'pending': None})
    conv, meta = store.load('c1')
    assert meta == {'id': 'c1', 'pending': None}


def test_a_refused_conversation_save_is_not_sent_again():
    client = FakeClient()
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    calls = []

    def put(user_id, key, value):
        calls.append(key)
        raise PlaidAPIError('HTTP 413 Too large', status=413, method='PUT')

    client.user_data.put = put
    with pytest.raises(PlaidAPIError):
        store.save('c1', {'messages': [], 'display': []}, {'id': 'c1'})
    assert len(calls) == 1


def test_a_save_that_failed_says_so_with_one_period(monkeypatch):
    client = FakeClient()
    _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        return TurnResult('Two words.', [{'role': 'assistant', 'content': 'Two words.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    monkeypatch.setattr(ConversationStore, 'save', lambda self, *a: (_ for _ in ()).throw(
        PlaidAPIError('HTTP 413 The value is too large.', status=413, method='PUT')))
    helper = Helper()
    _service().process_request(_request(client), helper)
    [said] = helper.errors
    assert '..' not in said
    assert said == ('The answer is ready but the conversation could not be saved: HTTP 413 The '
                    'value is too large. It is below, and this turn is not in the record.')

    monkeypatch.setattr(ConversationStore, 'save', lambda self, *a: (_ for _ in ()).throw(
        _lost('PUT', '/api/v1/users/u@x/data/k')))
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.errors == ['The answer is ready, but saving the conversation got no answer. '
                             'It is below, and this turn may not be in the record.']


def test_a_plan_over_one_document_writes_at_the_version_it_had_once_held(spec):
    """conc-2026-09-29 D9: a batch of the plan's that lands after the apply
    gave up on it is refused over an edit made since, as a service's is."""
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    version = client._documents[spec['did']]['version']
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    writes = [kind for kind, _ in client.writes]
    assert writes and client.stamps == [(kind, spec['did'], version) for kind in writes]
    assert client.strict_mode_document_id is None


def test_a_new_document_is_written_without_the_held_documents_version():
    """A plan that edits one document and creates another holds the one, in
    strict mode. The new document's writes claimed the held one's version
    and would all have been refused."""
    from fixtures import FakeClient as IgtClient
    from plaid_agent.igt.plan import execute_plan
    from plaid_agent.igt.project import load_project
    c = IgtClient()
    project = load_project(c, 'p1')
    ops = [{'kind': 'set_doc_metadata', 'document_id': 'd1', 'field': 'Date', 'value': '', 'label': ''},
           {'kind': 'create_document', 'name': 'Text 2', 'text': 'Gam-ar.\n', 'metadata': {}, 'label': ''}]
    with core_plan.holding(c, ['d1']):
        execute_plan(c, ops, source='s', label='l', project=project)
    assert [kind for kind, _, _ in c.stamps] == ['documents.patch_metadata']


# --- which changes a plan that stopped partway wrote (Luke's ruling Q4) ------

class _Batch:
    def __init__(self, sent):
        self.sent = sent

    def submit(self):
        self.sent.append(1)
        return [{}]


class _Client:
    def __init__(self):
        self.sent = []

    def batch(self):
        return _Batch(self.sent)


def test_a_change_is_written_once_every_batch_holding_it_committed():
    b = core_plan.TrackingBatcher(_Client())
    ops = [{'_row': 0}, {'_row': 1}, {'_row': 1}, {'_row': 2}]
    b.expect(ops)
    b.add(lambda batch: None)
    b.finish(ops[0])                 # queued, not yet sent
    assert b.written_rows() == []
    b.flush()
    assert b.written_rows() == [0]
    b.add(lambda batch: None)
    b.finish(ops[1])                 # one of row 1's two ops
    b.flush()
    assert b.written_rows() == [0], 'a change of two ops needs both'
    b.add(lambda batch: None)
    b.finish(ops[2])
    b.finish(ops[3])
    assert b.written_rows() == [0], 'its last write is still queued'
    b.flush()
    assert b.written_rows() == [0, 1, 2]


def _plan_of(spec, client, *tools):
    """sbs._plan with several changes staged in one workspace."""
    from importlib import import_module
    from plaid_agent.core.conversation import assistant_item, build_meta, user_item
    call_tool = import_module(f'plaid_agent.{spec["app"]}.toolkit').call_tool
    ws = spec['workspace'](client, spec['load'](client, spec['pid']))
    for name, args in tools:
        out = call_tool(ws, name, dict(args))
        assert ws.ops, out
    plan = ws.plan_payload()
    store = ConversationStore(client, 'u@x', spec['pid'], spec['app'])
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model', service=f'{spec["app"]}:assist:fake')
    conv = {'messages': [{'role': 'user', 'content': 'do it'}], 'display': [user_item('do it'), item]}
    store.save('c1', conv, build_meta(None, 'c1', conv, f'{spec["app"]}:assist:fake', 'fake/model',
                                      pending={'kind': 'apply', 'request_id': 'r9',
                                               'plan_id': plan['id']}))
    return plan


def test_a_umr_plan_that_stops_after_its_anchors_wrote_no_node(monkeypatch):
    """A node is its anchor token (pass 1) and its concept span (pass 2). The
    anchors committed and the spans did not, so no change is written in
    full, though a batch was."""
    from umr_fixtures import SENTENCE_1_PENMAN
    spec = APPS['umr']()
    client = spec['client']()
    text = SENTENCE_1_PENMAN.replace(':aspect performance)', ':ARG1 (s1c / cat)\n    :aspect performance)')
    plan = _plan_of(spec, client, ('set_attributes', {'document': 'Story', 'sentence': 2, 'var': 's2r',
                                                      'line': ':aspect state'}),
                    ('apply_penman', {'document': 'Story', 'sentence': 1, 'text': text}))
    kinds = [op['kind'] for op in plan['ops']]
    assert 'create_node' in kinds and 'create_node' != kinds[0], kinds
    real = core_plan.Batcher.flush
    sent = []

    def second_fails(self):
        if self._batch is not None or any(self._bulk.values()):
            sent.append(1)
            if len(sent) == 2:
                raise PlaidAPIError('HTTP 500 boom at http://h:8085/api/v1/batch', status=500,
                                    url='http://h:8085/api/v1/batch', method='POST')
        real(self)

    monkeypatch.setattr(core_plan.Batcher, 'flush', second_fails)
    svc = spec['service']()
    spec = {**spec, 'service': lambda: svc}
    helper = sbs._approve(spec, client, plan)
    [done] = helper.done
    rows = len(plan['ops'])
    written = _stored(spec, client)['written']
    assert [kinds[i] for i in written] == [k for k in kinds if k not in ('create_node', 'create_edge')]
    assert done['message'] == (f'Partly applied: {len(written)} of {rows} changes written. '
                               'HTTP 500 boom.')
    # The new node's anchor, written in the first batch, is taken back out:
    # left, it was an anchor with no node, which the editor's repair deleted
    # on someone's next open, under their name (conc-2026-09-29 H8-2).
    [anchors] = [p for p in client.payloads('tokens.bulk_create')]
    [cleared] = client.payloads('tokens.bulk_delete')
    assert len(cleared) == len(anchors) == 1


def _second_send_fails(monkeypatch):
    real = core_plan.Batcher.flush
    sent = []

    def flush(self):
        if self._batch is not None or any(self._bulk.values()):
            sent.append(1)
            if len(sent) == 2:
                raise PlaidAPIError('HTTP 500 boom', status=500, method='POST')
        real(self)
    monkeypatch.setattr(core_plan.Batcher, 'flush', flush)


def test_an_igt_change_finished_in_the_second_batch_is_not_written_when_it_fails(monkeypatch):
    from fixtures import FakeClient as IgtClient
    from plaid_agent.igt.plan import execute_plan
    ops = [{'kind': 'rename_entry', 'item_id': 'vi-gam2', 'form': 'net', 'label': 'a', '_row': 0},
           {'kind': 'merge_entries', 'keep_id': 'vi-ali', 'remove_id': 'vi-erg', 'links': [],
            'label': 'b', '_row': 1},
           {'kind': 'rename_document', 'document_id': 'd1', 'name': 'Two', 'label': 'c', '_row': 2}]
    _second_send_fails(monkeypatch)
    with pytest.raises(core_plan.PlanError) as caught:
        execute_plan(IgtClient(), ops, source='s', label='l')
    assert caught.value.written == [0, 2], 'the merge is in the second batch'


def test_a_ud_head_needs_its_second_batch(monkeypatch):
    from plaid_agent.ud.plan import execute_plan
    spec = APPS['ud']()
    client = spec['client']()
    ws = spec['workspace'](client, spec['load'](client, spec['pid']))
    from plaid_agent.ud.toolkit import call_tool
    call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'ir'})
    call_tool(ws, 'set_head', {'document': 'Viaje', 'ref': 's2.w1', 'head': 0, 'deprel': 'root'})
    ops = [{**op, '_row': i} for i, op in enumerate(ws.ops)]
    kinds = [op['kind'] for op in ops]
    assert kinds[-1] == 'set_head', kinds
    _second_send_fails(monkeypatch)
    with pytest.raises(core_plan.PlanError) as caught:
        execute_plan(client, ops, source='s', label='l', project=ws.project)
    assert caught.value.written == [i for i, k in enumerate(kinds) if k != 'set_head']
