"""The service is the only writer of a conversation record, and one tab acts
on a conversation at a time (design/SINGLE-WRITER.md, Luke's rulings of
2026-10-09). The page sends requests naming an ``op`` and reads.

Each of H10-RECORD's findings is here as a service test, and so is every
marker's way out (REV-FX12's table): a marker no request stands behind any
more is settled by the next op on the conversation."""

import threading
from datetime import datetime, timedelta, timezone

from fixtures import FakeClient
from plaid_client import PlaidAPIError
from test_service_flow import PLAN1, Helper, _seed_plan, _service

from plaid_agent.core import conversation as conversation_mod
from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import (DISCARDED_NOTE, ConversationStore, conv_key, conversation_bytes,
                                           meta_key, now_iso)
from plaid_agent.core.ops import LEASE_S, STALE_PAGE
from plaid_agent.core.plan import WRITING

TAB = 'tab-a'
OTHER_TAB = 'tab-b'


def _req(client, op, tab=TAB, conv='c1', **fields):
    return {'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1', 'conversation_id': conv,
            'tab': tab, 'op': op, **fields}


def _answering(monkeypatch, text='Two words.', calls=None, gate=None):
    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        if calls is not None:
            calls.append([m.get('content') for m in transcript])
        if gate is not None:
            gate.wait(5)
        return TurnResult(text, [{'role': 'assistant', 'content': text}], [])
    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)


def _send(svc, client, text='Which words are unglossed?', rid='r1', tab=TAB, create=True, **fields):
    helper = Helper(request_id=rid)
    svc.process_request(_req(client, 'send', tab=tab, text=text, create=create, **fields), helper)
    return helper


def _store(client):
    return ConversationStore(client, 'u@x', 'p1', 'igt')


def _set_meta(client, **fields):
    store = _store(client)
    conv, meta = store.load('c1')
    store.save('c1', conv, {**meta, **fields})


def _ago(seconds):
    return now_iso(datetime.now(timezone.utc) - timedelta(seconds=seconds))


# --- the wire -------------------------------------------------------------------------

def test_a_request_with_no_op_is_from_an_old_page_and_is_refused_with_a_reload_line():
    client = FakeClient()
    _seed_plan(client)
    helper = Helper(request_id='r9')
    _service().process_request({'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1',
                                'conversation_id': 'c1', 'approve': {'plan_id': PLAN1}}, helper)
    assert helper.errors == [STALE_PAGE] == ['This page is out of date. Reload it to keep going.']
    assert not client.payloads('spans.create')


def test_the_service_says_it_takes_ops():
    import inspect
    from plaid_agent.core.ops import RECORD_PROTOCOL
    assert RECORD_PROTOCOL == 2
    assert "self.extras['record'] = RECORD_PROTOCOL" in inspect.getsource(service_mod.BaseAssistantService.setup)


# --- send ---------------------------------------------------------------------------------

def test_a_first_send_creates_the_record_with_the_message_the_hold_and_the_size(monkeypatch):
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    where = {'kind': 'document', 'id': 'd1', 'name': 'Text 1'}
    helper = _send(_service(), client, where=where, files=[{'id': 'f1', 'name': 'a.csv', 'bytes': 3,
                                                          'lines': 1, 'chunks': 1}])
    assert not helper.errors, helper.errors
    assert helper.done[0]['kind'] == 'turn'
    conv, meta = _store(client).load('c1')
    asked = conv['display'][0]
    assert asked['kind'] == 'user' and asked['request_id'] == 'r1' and asked['where'] == where
    assert asked['files'][0]['id'] == 'f1'
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant']
    assert meta['title'] == 'Which words are unglossed?' and meta['about'] == {'document_id': 'd1',
                                                                              'document_name': 'Text 1'}
    assert meta['holder']['tab'] == TAB and meta['pending'] is None
    assert meta['size']['bytes'] == conversation_bytes(conv)
    assert len(calls) == 1


def test_a_send_reports_recorded_before_the_model_is_asked(monkeypatch):
    client = FakeClient()
    seen = []
    helper = Helper(request_id='r1')
    real = helper.progress

    def progress(pct, msg='', **extra):
        seen.append(extra.get('recorded'))
        real(pct, msg, **extra)
    helper.progress = progress

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        conv, meta = _store(client).load('c1')
        assert meta['pending']['request_id'] == 'r1' and meta['pending']['service_id'] == 'igt:assist:fake'
        assert seen[0] is True
        return TurnResult('ok', [{'role': 'assistant', 'content': 'ok'}], [])
    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    _service().process_request(_req(client, 'send', text='hi', create=True), helper)
    assert not helper.errors


def test_a_send_sent_again_under_its_request_id_appends_the_message_once(monkeypatch):
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    svc = _service()
    _send(svc, client, rid='r1')
    again = _send(svc, client, rid='r1')
    assert again.done[0]['kind'] == 'turn' and again.done[0].get('again')
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant']
    assert len(calls) == 1, 'the model is asked once'


def test_a_send_whose_service_died_before_answering_runs_once_when_sent_again(monkeypatch):
    """The question landed with its marker, and the service died before
    answering: the same request id sent again runs the turn without a
    second question."""
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    svc = _service()
    _send(svc, client, rid='r1')
    store = _store(client)
    conv, meta = store.load('c1')
    conv['display'].append({'kind': 'user', 'text': 'q2', 'created_at': now_iso(), 'request_id': 'r2'})
    conv['messages'].append({'role': 'user', 'content': 'q2'})
    store.save('c1', conv, {**meta, 'pending': {'kind': 'turn', 'request_id': 'r2',
                                                 'service_id': 'igt:assist:fake'}})
    again = _send(svc, client, text='q2', rid='r2', create=False)
    assert again.done[0]['kind'] == 'turn' and not again.done[0].get('again')
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant', 'user', 'assistant']
    assert [m['content'] for m in conv['messages']].count('q2') == 1
    assert len(calls) == 2 and meta['pending'] is None


def test_h10_record_5_a_send_or_retry_on_a_deleted_conversation_is_refused_as_deleted(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    deleted = Helper(request_id='rd')
    svc.process_request(_req(client, 'delete', tab=OTHER_TAB), deleted)
    assert deleted.done == [{'kind': 'done', 'meta': None}]
    for op, fields in (('send', {'text': 'again'}), ('retry', {}), ('approve', {'plan_id': PLAN1}),
                       ('discard', {'plan_id': PLAN1}), ('hold', {})):
        helper = Helper(request_id=f'r-{op}')
        svc.process_request(_req(client, op, **fields), helper)
        assert helper.done == [{'kind': 'refused', 'why': 'gone', 'message': 'This conversation was deleted.'}], op
    assert not client.user_data.store, 'nothing brought back'


def test_a_message_too_big_for_the_record_is_refused_and_nothing_is_written(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    monkeypatch.setattr(service_mod, 'value_cap', lambda c: 20_000)
    monkeypatch.setattr(conversation_mod, 'value_cap', lambda c: 20_000)
    svc = _service()
    _send(svc, client, text='short')
    before = _store(client).load('c1')
    helper = _send(svc, client, text='x' * 30_000, rid='r2')
    assert helper.done[0]['kind'] == 'refused' and helper.done[0]['why'] == 'full'
    assert helper.done[0]['message'].startswith('This message is too long for the room left')
    assert _store(client).load('c1')[0] == before[0]


def test_a_full_conversation_refuses_a_message(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch, text='y' * 18_000)
    monkeypatch.setattr(service_mod, 'value_cap', lambda c: 20_000)
    monkeypatch.setattr(conversation_mod, 'value_cap', lambda c: 20_000)
    svc = _service()
    _send(svc, client, text='short')
    helper = _send(svc, client, text='one more', rid='r2')
    assert helper.done[0]['why'] == 'full'
    assert helper.done[0]['message'] == ('This conversation is full, so the message was not sent. '
                                         'Start a new conversation to go on.')


# --- one tab at a time --------------------------------------------------------------------

def test_another_tab_is_refused_while_the_hold_is_live_and_takes_it_with_continue_here(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    helper = _send(svc, client, text='from b', rid='r2', tab=OTHER_TAB, create=False)
    assert helper.done[0] == {'kind': 'refused', 'why': 'held', 'message': 'This conversation is open in another tab.',
                              'meta': helper.done[0]['meta']}
    hold = Helper(request_id='h1')
    svc.process_request(_req(client, 'hold', tab=OTHER_TAB), hold)
    assert hold.done[0]['why'] == 'held', 'opening does not take a held conversation'
    take = Helper(request_id='h2')
    svc.process_request(_req(client, 'hold', tab=OTHER_TAB, take=True), take)
    assert take.done[0]['kind'] == 'done' and take.done[0]['meta']['holder']['tab'] == OTHER_TAB
    ok = _send(svc, client, text='from b', rid='r3', tab=OTHER_TAB, create=False)
    assert ok.done[0]['kind'] == 'turn'
    lost = _send(svc, client, text='from a', rid='r4', tab=TAB, create=False)
    assert lost.done[0]['why'] == 'held'


def test_a_lapsed_hold_is_free_and_a_renewal_moves_nothing_a_reader_rereads(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    _set_meta(client, holder={'tab': OTHER_TAB, 'at': _ago(LEASE_S + 5)})
    _, before = _store(client).load('c1')
    hold = Helper(request_id='h1')
    svc.process_request(_req(client, 'hold'), hold)
    meta = hold.done[0]['meta']
    assert meta['holder']['tab'] == TAB
    assert meta['updated_at'] == before['updated_at'] and meta['turns'] == before['turns']
    _set_meta(client, holder={'tab': OTHER_TAB, 'at': _ago(LEASE_S - 30)})
    held = Helper(request_id='h2')
    svc.process_request(_req(client, 'hold'), held)
    assert held.done[0]['why'] == 'held'


def test_rename_and_delete_are_list_actions_any_tab_may_take(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    _, before = _store(client).load('c1')
    helper = Helper(request_id='n1')
    svc.process_request(_req(client, 'rename', tab=OTHER_TAB, title='  Glossing   the  verbs ' + 'x' * 80), helper)
    meta = helper.done[0]['meta']
    assert meta['title'].startswith('Glossing the verbs') and len(meta['title']) == 60
    assert meta['updated_at'] == before['updated_at'] and meta['holder']['tab'] == TAB


# --- H10-RECORD 1 to 4: one thing at a time ------------------------------------------------

def test_h10_record_1_a_discard_during_an_approval_is_refused_and_the_apply_lands_once():
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    real = svc.execute_plan
    outcomes = {}

    def execute(*a, **k):
        # Continue here in the second tab, during the apply, then Discard.
        take = Helper(request_id='h2')
        svc.process_request(_req(client, 'hold', tab=OTHER_TAB, take=True), take)
        discard = Helper(request_id='d2')
        svc.process_request(_req(client, 'discard', tab=OTHER_TAB, plan_id=PLAN1), discard)
        outcomes['discard'] = discard.done[0]
        return real(*a, **k)

    svc.execute_plan = execute
    helper = Helper(request_id='r9')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1), helper)
    assert outcomes['discard'] == {'kind': 'refused', 'why': 'busy', 'message': 'The changes are being applied.',
                                   'meta': outcomes['discard']['meta']}
    assert helper.done[0]['kind'] == 'applied'
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied'
    notes = [m['content'] for m in conv['messages'] if str(m.get('content', '')).startswith('(note)')]
    assert len(notes) == 1 and notes[0].startswith('(note) The plan was approved and applied')
    assert len(client.payloads('spans.create')) == 1
    assert meta['pending'] is None and meta['holder']['tab'] == OTHER_TAB


def test_h10_record_2_an_approval_and_a_message_one_runs_the_other_is_refused(monkeypatch):
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    real = svc.execute_plan
    said = {}
    _answering(monkeypatch)

    def execute(*a, **k):
        said['send'] = _send(svc, client, text='meanwhile', rid='r2', create=False).done[0]
        return real(*a, **k)
    svc.execute_plan = execute
    helper = Helper(request_id='r9')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1), helper)
    assert said['send']['why'] == 'busy' and said['send']['message'] == 'The changes are being applied.'
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied'
    assert conv['messages'][-1]['content'].startswith('(note) The plan was approved and applied')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant'], 'the message was not recorded'
    # And the other way round: an approval while a turn runs.
    gate = threading.Event()
    _answering(monkeypatch, gate=gate)
    t = threading.Thread(target=_send, args=(svc, client), kwargs={'text': 'q2', 'rid': 'r3', 'create': False})
    t.start()
    for _ in range(100):
        if (store.meta('c1') or {}).get('pending'):
            break
        threading.Event().wait(0.02)
    approve = Helper(request_id='r10')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1), approve)
    gate.set()
    t.join(5)
    assert approve.done[0]['why'] == 'busy' and approve.done[0]['message'] == 'A message is being answered.'


def test_h10_record_3_an_interrupted_approval_that_may_have_written_is_not_discarded():
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    conv, meta = store.load('c1')
    item = conv['display'][1]
    item['interrupted'] = True
    item['plan'][WRITING] = {'run': 'r-dead', 'inside': True}
    item['plan']['documents'][0]['held_from'] = 7
    client._documents['d1']['version'] = 9  # something was written
    store.save('c1', conv, {**meta, 'pending': None})
    svc = _service()
    helper = Helper(request_id='d1')
    svc.process_request(_req(client, 'discard', plan_id=PLAN1), helper)
    assert helper.done[0]['why'] == 'written'
    assert helper.done[0]['message'] == 'Some of its changes may be written. Apply again to finish them.'
    assert store.load('c1')[0]['display'][1]['status'] is None
    # Every held document unmoved and every change inside them: nothing landed.
    client._documents['d1']['version'] = 7
    helper = Helper(request_id='d2')
    svc.process_request(_req(client, 'discard', plan_id=PLAN1), helper)
    assert helper.done[0]['kind'] == 'done'
    conv, _ = store.load('c1')
    assert conv['display'][1]['status'] == 'discarded' and conv['messages'][-1]['content'] == DISCARDED_NOTE


def test_h10_record_4_two_sends_at_once_run_one_turn_and_one_model_call(monkeypatch):
    client = FakeClient()
    calls = []
    gate = threading.Event()
    _answering(monkeypatch, calls=calls)
    svc = _service()
    _send(svc, client)
    _answering(monkeypatch, calls=calls, gate=gate)
    results = {}

    def go(rid, tab, take):
        if take:
            svc.process_request(_req(client, 'hold', tab=tab, take=True), Helper(request_id='h' + rid))
        results[rid] = _send(svc, client, text=f'race {rid}', rid=rid, tab=tab, create=False)
    threads = [threading.Thread(target=go, args=('r2', TAB, False)),
               threading.Thread(target=go, args=('r3', OTHER_TAB, True))]
    for t in threads:
        t.start()
    threading.Event().wait(0.3)
    gate.set()
    for t in threads:
        t.join(5)
    kinds = sorted(r.done[0]['kind'] for r in results.values())
    assert kinds == ['refused', 'turn'], results
    assert len(calls) == 2, 'one model call for the first message, one for the race'
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant', 'user', 'assistant']


def test_h10_record_6_an_approval_in_a_full_conversation_writes_nothing():
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    real = client.user_data.put

    def put(user_id, key, value, version=None):
        if ':conv:' in key:
            raise PlaidAPIError('HTTP 413 Value exceeds 1048576 bytes', status=413, method='PUT')
        return real(user_id, key, value, version=version)
    client.user_data.put = put
    helper = Helper(request_id='r9')
    _service().process_request(_req(client, 'approve', plan_id=PLAN1), helper)
    assert helper.errors == ['This conversation is full, so the plan was not applied. Start a new conversation to go on.']
    assert not client.payloads('spans.create')
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] is None and meta['pending'] is None


# --- retry ----------------------------------------------------------------------------

def test_retry_sends_the_last_message_again_after_its_attempt(monkeypatch):
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    svc = _service()

    def boom(*a, **k):
        raise RuntimeError('provider down')
    monkeypatch.setattr(service_mod, 'run_turn', boom)
    _send(svc, client, text='Gloss it', files=[{'id': 'f1', 'name': 'a.csv'}])
    _answering(monkeypatch, calls=calls)
    helper = Helper(request_id='r2')
    svc.process_request(_req(client, 'retry'), helper)
    assert helper.done[0]['kind'] == 'turn'
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error', 'user', 'assistant']
    again = conv['display'][2]
    assert again['retry'] is True and again['text'] == 'Gloss it' and again['files'][0]['id'] == 'f1'
    assert again['request_id'] == 'r2'
    assert sum(1 for m in calls[-1] if isinstance(m, str) and m.endswith('Gloss it')) == 1, 'asked once'
    answered = Helper(request_id='r3')
    svc.process_request(_req(client, 'retry'), answered)
    assert answered.done[0]['why'] == 'answered'


def test_retry_of_a_lost_turn_adds_the_line_the_screen_showed(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    store = _store(client)
    conv, meta = store.load('c1')
    conv['display'].append({'kind': 'user', 'text': 'lost one', 'created_at': now_iso(), 'request_id': 'r-dead'})
    conv['messages'].append({'role': 'user', 'content': 'lost one'})
    store.save('c1', conv, {**meta, 'pending': {'kind': 'turn', 'request_id': 'r-dead',
                                                 'service_id': 'igt:assist:fake'}})
    helper = Helper(request_id='r2')
    svc.process_request(_req(client, 'retry'), helper)
    conv, _ = store.load('c1')
    assert [d['kind'] for d in conv['display']][-4:] == ['user', 'error', 'user', 'assistant']
    assert conv['display'][-3]['text'] == 'No answer came back for this message.'
    assert [m['content'] for m in conv['messages']].count('lost one') <= 1


# --- markers left behind: every one has a way out --------------------------------------

def test_a_dead_turn_marker_of_this_service_is_cleared_by_the_next_op(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    _set_meta(client, pending={'kind': 'turn', 'request_id': 'r-dead', 'service_id': 'igt:assist:fake'})
    helper = Helper(request_id='h1')
    svc.process_request(_req(client, 'hold'), helper)
    assert helper.done[0]['kind'] == 'done' and helper.done[0]['meta']['pending'] is None


def test_a_dead_apply_marker_interrupts_its_plan_so_the_card_offers_apply_again():
    client = FakeClient()
    store = _seed_plan(client, request_id='r-dead')
    _set_meta(client, pending={'kind': 'apply', 'request_id': 'r-dead', 'service_id': 'igt:assist:fake',
                               'plan_id': PLAN1})
    helper = Helper(request_id='h1')
    _service().process_request(_req(client, 'hold'), helper)
    conv, meta = store.load('c1')
    assert conv['display'][1]['interrupted'] is True and conv['display'][1]['status'] is None
    assert meta['pending'] is None


def test_an_old_page_marker_with_no_service_is_cleared(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    _set_meta(client, pending={'kind': 'discard', 'request_id': 'x', 'plan_id': PLAN1})
    helper = _send(svc, client, text='next', rid='r2', create=False)
    assert helper.done[0]['kind'] == 'turn'


def test_another_assistants_marker_stands_while_it_is_online_and_is_settled_when_it_is_not(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    other = {'kind': 'turn', 'request_id': 'r-other', 'service_id': 'igt:assist:other'}
    _set_meta(client, pending=other)
    client.services['p1'] = [{'service_id': 'igt:assist:other', 'online': True}]
    helper = _send(svc, client, text='next', rid='r2', create=False)
    assert helper.done[0]['why'] == 'busy'
    client.services['p1'] = []
    helper = _send(svc, client, text='next', rid='r3', create=False)
    assert helper.done[0]['kind'] == 'turn'


# --- discard, attach, delete ---------------------------------------------------------------

def test_discard_settles_an_undecided_plan_and_dismisses_a_stale_one():
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    helper = Helper(request_id='d1')
    _service().process_request(_req(client, 'discard', plan_id=PLAN1), helper)
    assert helper.done[0]['kind'] == 'done' and helper.done[0]['meta']['holder']['tab'] == TAB
    conv, _ = store.load('c1')
    assert conv['display'][1]['status'] == 'discarded' and conv['messages'][-1]['content'] == DISCARDED_NOTE
    again = Helper(request_id='d2')
    _service().process_request(_req(client, 'discard', plan_id=PLAN1), again)
    assert again.done[0]['why'] == 'decided'
    client2 = FakeClient()
    store2 = _seed_plan(client2, status='stale', request_id=None)
    _set_meta(client2, pending=None)
    helper = Helper(request_id='d3')
    _service().process_request(_req(client2, 'discard', plan_id=PLAN1), helper)
    item = store2.load('c1')[0]['display'][1]
    assert item['status'] == 'stale' and item['dismissed'] is True


def test_attach_stores_the_parts_before_the_message_and_a_held_conversation_refuses_it(monkeypatch):
    client = FakeClient()
    f = {'id': '0f1e2d3c-aaaa-4bbb-8ccc-000000000001', 'name': 'a.csv', 'bytes': 6, 'lines': 2,
         'parts': ['a,b\n', '1,2\n']}
    helper = Helper(request_id='a1')
    _service().process_request(_req(client, 'attach', file=f), helper)
    assert helper.done == [{'kind': 'done', 'meta': None}]
    base = f'igt:assistant:p1:file:c1:{f["id"]}:part:'
    assert client.user_data.get('u@x', base + '1')['value'] == '1,2\n'
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    _set_meta(client, holder={'tab': OTHER_TAB, 'at': now_iso()})
    held = Helper(request_id='a2')
    svc.process_request(_req(client, 'attach', file={**f, 'id': '0f1e2d3c-aaaa-4bbb-8ccc-000000000002'}), held)
    assert held.done[0]['why'] == 'held'


def test_delete_takes_every_key_and_stops_a_running_turn(monkeypatch):
    client = FakeClient()
    gate = threading.Event()
    calls = []
    _answering(monkeypatch, calls=calls)
    svc = _service()
    _send(svc, client)
    client.user_data.put('u@x', 'igt:assistant:p1:file:c1:f1:part:0', 'x')
    _answering(monkeypatch, calls=calls, gate=gate)
    turn = {}
    t = threading.Thread(target=lambda: turn.setdefault('h', _send(svc, client, text='q2', rid='r2', create=False)))
    t.start()
    for _ in range(100):
        if svc._busy:
            break
        threading.Event().wait(0.02)
    helper = Helper(request_id='del')
    svc.process_request(_req(client, 'delete', tab=OTHER_TAB), helper)
    assert helper.done == [{'kind': 'done', 'meta': None}]
    gate.set()
    t.join(5)
    assert not client.user_data.store, 'nothing written back'


def test_delete_during_an_approval_is_refused():
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    real = svc.execute_plan
    said = {}

    def execute(*a, **k):
        h = Helper(request_id='del')
        svc.process_request(_req(client, 'delete', tab=OTHER_TAB), h)
        said['delete'] = h.done[0]
        return real(*a, **k)
    svc.execute_plan = execute
    svc.process_request(_req(client, 'approve', plan_id=PLAN1), Helper(request_id='r9'))
    assert said['delete']['message'] == 'That conversation is still applying changes.'


def test_a_sweep_deletes_files_whose_conversation_never_came(monkeypatch):
    from plaid_agent.core.files import sweep_orphan_files
    client = FakeClient()
    client.user_data.put('u@x', 'igt:assistant:p1:file:gone:f1:part:0', 'x')
    client.user_data.put('u@x', 'igt:assistant:p1:meta:live', {'id': 'live'})
    client.user_data.put('u@x', 'igt:assistant:p1:file:live:f2:part:0', 'y')
    store = _store(client)
    assert sweep_orphan_files(store) == 0, 'too young'
    import time
    assert sweep_orphan_files(store, now=time.time() + 2 * 3600) == 1
    keys = {k for (_u, k) in client.user_data.store}
    assert 'igt:assistant:p1:file:gone:f1:part:0' not in keys and 'igt:assistant:p1:file:live:f2:part:0' in keys


# --- answers the record could not take ------------------------------------------------

def test_an_answer_a_full_record_refuses_leaves_a_stand_in_line_and_clears_the_marker(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    real = client.user_data.put

    def put(user_id, key, value, version=None):
        if ':conv:' in key and 'answer two' in str(value):
            raise PlaidAPIError('HTTP 413 too large', status=413, method='PUT')
        return real(user_id, key, value, version=version)
    client.user_data.put = put
    _answering(monkeypatch, text='answer two')
    helper = _send(svc, client, text='q2', rid='r2', create=False)
    assert helper.done[0]['warning'] == 'This answer was not saved. This conversation is full.'
    assert helper.done[0]['item']['text'] == 'answer two'
    conv, meta = _store(client).load('c1')
    assert conv['display'][-1]['kind'] == 'error' and conv['display'][-1]['text'] == helper.done[0]['warning']
    assert meta['pending'] is None


def test_an_answer_whose_save_got_no_answer_is_written_by_the_next_op(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    svc = _service()
    _send(svc, client)
    monkeypatch.setattr(svc, '_keep_unsaved', lambda store, conv_id, change, rid, model: svc._unsaved.__setitem__(
        (store.user_id, store.project_id, conv_id),
        {'store': store, 'conv_id': conv_id, 'change': change, 'request_id': rid, 'model': model,
         'until': float('inf')}))
    real = client.user_data.put
    away = {'on': True}

    def put(user_id, key, value, version=None):
        if away['on'] and ':conv:' in key and 'late answer' in str(value):
            raise PlaidAPIError('HTTP 502', status=502, method='PUT')
        return real(user_id, key, value, version=version)
    client.user_data.put = put
    monkeypatch.setattr(conversation_mod, 'SERVER_AWAY_S', 0)
    _answering(monkeypatch, text='late answer')
    helper = _send(svc, client, text='q2', rid='r2', create=False)
    assert 'may not be in the record yet' in helper.done[0]['warning']
    away['on'] = False
    hold = Helper(request_id='h1')
    svc.process_request(_req(client, 'hold'), hold)
    conv, meta = _store(client).load('c1')
    assert conv['display'][-1]['text'] == 'late answer' and meta['pending'] is None
    assert [d['text'] for d in conv['display'] if d['kind'] == 'user'] == ['Which words are unglossed?', 'q2']


def test_a_size_is_written_with_every_transcript_write(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    _send(_service(), client)
    stored = client.user_data.get('u@x', conv_key('igt', 'p1', 'c1'))['value']
    meta = client.user_data.get('u@x', meta_key('igt', 'p1', 'c1'))['value']
    assert meta['size']['bytes'] == conversation_bytes(stored)
