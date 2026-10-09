"""The service's own writes of a conversation record, when the answer to one
is lost and the put is sent again (`conversation._patiently`): the second
put is refused as a version conflict by the first one's landing, and the
write made again must find its own work there rather than doing it twice,
undoing it or refusing itself (REV-SW-1).

And a request core hands the service a second time while it still runs is
refused rather than run twice."""

from fixtures import FakeClient
from plaid_client import PlaidAPIError
from test_service_flow import Helper, _service
from test_single_writer import _answering, _req, _send, _store

from plaid_agent.core import conversation as conversation_mod
from plaid_agent.core import service as service_mod


def _lose_answer_once(client, match):
    """The first put whose value matches lands, and its answer is lost (502)."""
    real = client.user_data.put
    state = {'lost': False}

    def put(user_id, key, value, version=None):
        out = real(user_id, key, value, version=version)
        if not state['lost'] and match(key, value):
            state['lost'] = True
            raise PlaidAPIError('HTTP 502', status=502, method='PUT')
        return out
    client.user_data.put = put
    return state


def test_a_retry_whose_record_write_lost_its_answer_asks_once_and_adds_no_lost_line(monkeypatch):
    client = FakeClient()
    calls = []
    svc = _service()

    def boom(*a, **k):
        raise RuntimeError('provider down')
    monkeypatch.setattr(service_mod, 'run_turn', boom)
    _send(svc, client, text='Gloss it')
    monkeypatch.setattr(conversation_mod, '_pause', lambda s: None)
    state = _lose_answer_once(client, lambda k, v: ':conv:' in k and "'retry': True" in str(v))
    _answering(monkeypatch, calls=calls)
    helper = Helper(request_id='r2')
    svc.process_request(_req(client, 'retry'), helper)
    assert state['lost']
    conv, meta = _store(client).load('c1')
    kinds = [d['kind'] for d in conv['display']]
    assert not helper.errors, (helper.errors, kinds)
    assert kinds == ['user', 'error', 'user', 'assistant'], kinds
    assert len(calls) == 1


def test_a_request_handed_over_again_while_it_runs_asks_the_model_once(monkeypatch):
    import threading
    client = FakeClient()
    calls = []
    gate = threading.Event()
    _answering(monkeypatch, calls=calls, gate=gate)
    svc = _service()
    first = threading.Thread(target=_send, args=(svc, client), kwargs={'rid': 'r1'})
    first.start()
    import time
    for _ in range(100):
        if calls:
            break
        time.sleep(0.02)
    second = threading.Thread(target=_send, args=(svc, client), kwargs={'rid': 'r1'})
    second.start()
    time.sleep(0.3)
    gate.set()
    first.join(5)
    second.join(5)
    conv, meta = _store(client).load('c1')
    kinds = [d['kind'] for d in conv['display']]
    assert len(calls) == 1, (len(calls), kinds)
    assert kinds == ['user', 'assistant'], kinds


def test_an_approval_whose_marker_write_lost_its_answer_applies_and_does_not_refuse_itself(monkeypatch):
    from test_service_flow import PLAN1, _seed_plan
    from test_single_writer import _set_meta
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    monkeypatch.setattr(conversation_mod, '_pause', lambda s: None)
    state = _lose_answer_once(client, lambda k, v: ':meta:' in k and "'kind': 'apply'" in str(v))
    helper = Helper(request_id='r9')
    _service().process_request(_req(client, 'approve', plan_id=PLAN1), helper)
    assert state['lost']
    assert helper.done and helper.done[0]['kind'] == 'applied', (helper.done, helper.errors)
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied' and meta['pending'] is None


def test_a_discard_whose_write_lost_its_answer_is_done(monkeypatch):
    from test_service_flow import PLAN1, _seed_plan
    from test_single_writer import _set_meta
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    monkeypatch.setattr(conversation_mod, '_pause', lambda s: None)
    state = _lose_answer_once(client, lambda k, v: ':conv:' in k and "'discarded'" in str(v))
    helper = Helper(request_id='d1')
    _service().process_request(_req(client, 'discard', plan_id=PLAN1), helper)
    assert state['lost']
    assert helper.done[0]['kind'] == 'done', helper.done
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'discarded'


def test_a_first_message_whose_transcript_create_lost_its_answer_is_answered(monkeypatch):
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    monkeypatch.setattr(conversation_mod, '_pause', lambda s: None)
    state = _lose_answer_once(client, lambda k, v: ':conv:' in k)
    helper = _send(_service(), client)
    assert state['lost']
    assert helper.done and helper.done[0]['kind'] == 'turn', (helper.done, helper.errors)
    conv, meta = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant'] and meta['pending'] is None
    assert len(calls) == 1


def test_a_first_message_whose_entry_create_lost_its_answer_is_answered(monkeypatch):
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    monkeypatch.setattr(conversation_mod, '_pause', lambda s: None)
    state = _lose_answer_once(client, lambda k, v: ':meta:' in k)
    helper = _send(_service(), client)
    assert state['lost']
    assert helper.done and helper.done[0]['kind'] == 'turn', (helper.done, helper.errors)
    conv, meta = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant'] and meta['pending'] is None
