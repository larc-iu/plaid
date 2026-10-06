"""The record has two writers, the browser and the service, and each used to
write its own copy over the other's. Every write now names the version it was
made from, and a write that another overtook is made again on the record as
it is stored: the service's answer is never written over the browser's newer
work, and the browser's older copy never puts back a record without the
answer (REV-FX9-RUNTIME, the ruling on A1-IGT-1's read-then-write gap)."""

import pytest

from fixtures import FakeClient
from plaid_client import PlaidAPIError

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import (ConversationStore, RecordMoved, assistant_item, build_meta,
                                           conv_key, meta_key, plan_settling, turn_ending, user_item)
from test_service_flow import Helper, _request, _seed, _service

CONV = conv_key('igt', 'p1', 'c1')
META = meta_key('igt', 'p1', 'c1')


def _stored(client):
    return (client.user_data.get('u@x', CONV)['value'], client.user_data.get('u@x', META)['value'])


def _answering(monkeypatch, meanwhile=lambda client: None, text='Two words.'):
    """A turn that answers ``text``, with ``meanwhile`` run while it works
    (what the browser writes in that time)."""
    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        meanwhile(ws.client)
        return TurnResult(text, [{'role': 'assistant', 'content': text}], [])
    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)


def _browser_writes(client, change, pending='keep'):
    """The browser's write: read the record, change it, write it back."""
    conv, meta = _stored(client)
    conv = change(conv)
    client.user_data.put('u@x', CONV, conv)
    if pending != 'keep':
        meta = {**meta, 'pending': pending}
    client.user_data.put('u@x', META, meta)


def test_a_write_names_the_version_it_was_made_from():
    client = FakeClient()
    store = _seed(client)
    store.load('c1')
    client.user_data.put('u@x', CONV, {'messages': [], 'display': []})  # another writer
    changed = []

    def change(conv):
        changed.append(len(conv['display']))
        return {**conv, 'display': conv['display'] + [{'kind': 'note', 'text': 'x', 'created_at': 't'}]}

    assert store.write('c1', change, lambda conv, prev: prev)
    # Made on the copy it had, refused, then made again on the record as stored.
    assert changed == [1, 0]
    conv, _ = _stored(client)
    assert [d['kind'] for d in conv['display']] == ['note']


def test_an_answer_lands_on_the_record_the_browser_changed_while_the_turn_ran(monkeypatch):
    """The browser discards an older plan while the turn works. The answer
    used to be written from the copy read at the start, which put the plan
    back as undecided. Now the answer goes onto the record as stored."""
    client = FakeClient()
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    old_plan = assistant_item('Plan one.', {'id': 'p-old', 'ops': [{'kind': 'x'}], 'changes': []}, [], [], '', 'm')
    conv = {'messages': [{'role': 'user', 'content': 'q0'}, {'role': 'assistant', 'content': 'Plan one.'},
                         {'role': 'user', 'content': 'q1'}],
            'display': [user_item('q0'), old_plan, user_item('q1')]}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                      pending={'kind': 'turn', 'request_id': 'r1'}))

    def discard(conv):
        conv['display'][1]['status'] = 'discarded'
        conv['messages'].append({'role': 'user', 'content': '(note) The plan was discarded.'})
        return conv
    _answering(monkeypatch, lambda c: _browser_writes(c, discard))
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.done and not helper.errors
    conv, meta = _stored(client)
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant', 'user', 'assistant']
    assert conv['display'][1]['status'] == 'discarded'
    assert conv['display'][3]['text'] == 'Two words.'
    assert conv['messages'][-2] == {'role': 'user', 'content': '(note) The plan was discarded.'}
    assert conv['messages'][-1] == {'role': 'assistant', 'content': 'Two words.'}
    assert meta['pending'] is None and meta['turns'] == 2


def test_an_answer_after_the_browser_gave_up_on_the_request_replaces_its_line(monkeypatch):
    """A1-IGT-1: the server restarted, the browser settled the turn as
    unanswered (its line, and the question out of the model transcript) and
    cleared the marker. The answer the service then writes is the outcome:
    once, after the question, with the question back in the transcript."""
    client = FakeClient()
    _seed(client)

    def gave_up(conv):
        conv['display'].append({'kind': 'error', 'lost': True, 'text': 'No answer came back for this message.',
                                'created_at': '2026-10-06T00:00:00.000Z'})
        conv['messages'] = conv['messages'][:-1]
        return conv
    _answering(monkeypatch, lambda c: _browser_writes(c, gave_up, pending=None))
    _service().process_request(_request(client), Helper())
    conv, meta = _stored(client)
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant']
    assert [m['role'] for m in conv['messages']] == ['user', 'assistant']
    assert meta['pending'] is None


def test_an_answer_to_a_question_the_user_moved_on_from_is_not_written(monkeypatch):
    """The browser gave up and the user asked again (Retry, or another tab),
    so a newer question follows this one: its own turn answers, and this
    answer is dropped rather than written after it."""
    client = FakeClient()
    _seed(client)

    def asked_again(conv):
        conv['display'] += [{'kind': 'error', 'lost': True, 'text': 'No answer came back for this message.',
                             'created_at': '2026-10-06T00:00:00.000Z'}, user_item('q again')]
        return conv
    _answering(monkeypatch, lambda c: _browser_writes(c, asked_again, pending=None))
    _service().process_request(_request(client), Helper())
    conv, _ = _stored(client)
    assert [d['kind'] for d in conv['display']] == ['user', 'error', 'user']


def test_a_save_whose_answer_was_lost_is_not_written_twice(monkeypatch):
    """The transcript's put lands and its answer is lost, so it is sent
    again, which the version refuses (the first landed). Made again on the
    record as stored, it finds its answer there and adds nothing."""
    client = FakeClient()
    _seed(client)
    real = client.user_data.put
    lost = {'n': 1}

    def put(user_id, key, value, version=None):
        answer = real(user_id, key, value, version=version)
        if key == CONV and lost['n']:
            lost['n'] -= 1
            raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='PUT')
        return answer

    monkeypatch.setattr('plaid_agent.core.conversation._pause', lambda s: None)
    client.user_data.put = put
    _answering(monkeypatch)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.done[0]['message'] == 'Two words.' and 'warning' not in helper.done[0]
    conv, meta = _stored(client)
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant']
    assert meta['pending'] is None


def test_a_newer_request_marked_while_the_answer_was_written_keeps_its_marker():
    """The service wrote the transcript, then the browser wrote its next
    message and marked request r2, then the service's sidebar write came:
    refused, and made again on the browser's entry, keeping r2."""
    client = FakeClient()
    store = _seed(client)
    conv0, _ = store.load('c1')
    item = assistant_item('A.', None, [], [], '', 'm')
    real = client.user_data.put
    raced = {'n': 1}

    def put(user_id, key, value, version=None):
        if key == META and raced['n']:
            raced['n'] -= 1
            # The browser, just before: its question after the answer, and r2.
            conv = client.user_data.get('u@x', CONV)['value']
            conv['display'].append(user_item('next'))
            real('u@x', CONV, conv)
            meta = client.user_data.get('u@x', META)['value']
            real('u@x', META, {**meta, 'pending': {'kind': 'turn', 'request_id': 'r2'}})
        return real(user_id, key, value, version=version)

    client.user_data.put = put
    change = turn_ending(conv0, conv0['messages'], item, [{'role': 'assistant', 'content': 'A.'}])
    assert store.write('c1', change,
                       lambda conv, prev: build_meta(prev, 'c1', conv, 's', 'm',
                                                     pending=None if not (prev.get('pending') or {}).get(
                                                         'request_id') == 'r2' else prev['pending']),
                       'r1')
    conv, meta = _stored(client)
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant', 'user']
    assert meta['pending']['request_id'] == 'r2'
    assert meta['turns'] == 2


def test_a_record_that_keeps_moving_gives_up_with_record_moved(monkeypatch):
    client = FakeClient()
    store = _seed(client)
    store.load('c1')
    real = client.user_data.put

    def put(user_id, key, value, version=None):
        real(user_id, key, {'messages': [], 'display': []})  # someone else, every time
        return real(user_id, key, value, version=version)

    client.user_data.put = put
    with pytest.raises(RecordMoved):
        store.write('c1', lambda conv: {**conv, 'display': conv['display'] + [user_item('x')]},
                    lambda conv, prev: prev)


def _with_plan(status=None):
    plan = assistant_item('P.', {'id': 'p1', 'ops': [{'kind': 'x'}], 'documents': [{'id': 'd'}]}, [], [], '', 'm')
    plan['status'] = status
    return {'messages': [{'role': 'user', 'content': 'q'}], 'display': [user_item('q'), plan]}


def test_an_approval_that_wrote_settles_as_applied_over_a_discard_made_meanwhile():
    stored = _with_plan('discarded')
    after = plan_settling('p1', 'applied', '(note) applied')(stored)
    assert after['display'][1]['status'] == 'applied'


def test_an_approval_that_wrote_nothing_leaves_a_plan_settled_meanwhile_as_it_is():
    stored = _with_plan('discarded')
    assert plan_settling('p1', 'stale', '(note) stale')(stored) is stored
    applied = _with_plan('applied')
    assert plan_settling('p1', 'partial', '(note) partly')(applied) is applied


def test_an_approval_settling_twice_writes_its_note_once():
    stored = plan_settling('p1', 'applied', '(note) applied')(_with_plan())
    assert plan_settling('p1', 'applied', '(note) applied')(stored) is stored
    assert [m['content'] for m in stored['messages']].count('(note) applied') == 1


def test_the_versions_an_approval_holds_reach_the_record_while_it_is_undecided():
    stored = _with_plan()
    docs = [{'id': 'd', 'held_from': 7}]
    after = plan_settling('p1', documents=docs)(stored)
    assert after['display'][1]['plan']['documents'] == docs
    assert plan_settling('p1', documents=docs)(after) is after
