"""A request on a conversation: the service reads the record, works, and
writes the outcome back before reporting, so the reply lands whether or not
the requester is still listening; a cancelled turn and a moved-on
conversation are settled the same way."""

import pytest

from fixtures import FakeClient

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import ModelConfig, TurnCancelled, TurnResult
from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.igt.service import AssistantService


class Helper:
    def __init__(self, request_id='r1', requester_id='u@x'):
        self.request_id = request_id
        self.requester_id = requester_id
        self.cancelled = False
        self.progress_log, self.done, self.errors = [], [], []

    def progress(self, pct, msg='', **extra):
        self.progress_log.append((pct, msg))
        self.extras = extra

    def complete(self, data=None):
        self.done.append(data)

    def error(self, err):
        self.errors.append(str(err))


def _service():
    svc = AssistantService()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = 'igt:assist:fake'
    return svc


def _seed(client, conv_id='c1', request_id='r1', text='Which words are unglossed?'):
    """What the browser writes before submitting a turn."""
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    conv = {'messages': [{'role': 'user', 'content': text}], 'display': [user_item(text)]}
    meta = build_meta(None, conv_id, conv, 'igt:assist:fake', 'fake/model',
                      pending={'kind': 'turn', 'request_id': request_id, 'service_id': 'igt:assist:fake'})
    store.save(conv_id, conv, meta)
    return store


def _request(client, **extra):
    return {'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1', 'conversation_id': 'c1', **extra}


def test_a_turn_is_written_to_the_record_before_it_is_reported(monkeypatch):
    client = FakeClient()
    store = _seed(client)
    order = []

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        assert transcript[-1] == {'role': 'user', 'content': 'Which words are unglossed?'}
        on_progress(20, 'Reading')
        ws.doc('Text 1')
        return TurnResult('Two words.', [{'role': 'assistant', 'content': 'Two words.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    real_save = store.save
    monkeypatch.setattr(ConversationStore, 'save', lambda self, *a: (order.append('saved'), real_save(*a)))
    helper = Helper()
    helper.complete = lambda data=None: (order.append('completed'), helper.done.append(data))
    _service().process_request(_request(client), helper)

    assert not helper.errors
    assert order == ['saved', 'completed']
    assert helper.done[0]['kind'] == 'turn' and helper.done[0]['message'] == 'Two words.'
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'assistant']
    assert conv['display'][1]['text'] == 'Two words.' and conv['display'][1]['model'] == 'fake/model'
    assert conv['messages'][-1] == {'role': 'assistant', 'content': 'Two words.'}
    assert meta['pending'] is None and meta['turns'] == 1 and meta['title'] == 'Which words are unglossed?'
    assert (20, 'Reading') in helper.progress_log


def test_a_cancelled_turn_is_settled_as_stopped(monkeypatch):
    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        assert cancelled() is True
        raise TurnCancelled()

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    helper.cancelled = True
    _service().process_request(_request(client), helper)
    assert helper.done == [{'kind': 'stopped'}] and not helper.errors
    conv, meta = store.load('c1')
    assert conv['display'][-1] == {'kind': 'error', 'text': 'Stopped.', 'stopped': True}
    assert conv['messages'] == [], 'the unanswered message leaves the transcript so a retry sends it once'
    assert meta['pending'] is None


def test_a_failed_turn_is_written_as_an_error_item(monkeypatch):
    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(*a, **k):
        raise RuntimeError('provider down')

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.errors == ['provider down']
    conv, meta = store.load('c1')
    assert conv['display'][-1]['kind'] == 'error' and 'provider down' in conv['display'][-1]['text']
    assert meta['pending'] is None


def test_an_outcome_is_not_written_over_a_conversation_that_moved_on(monkeypatch):
    client = FakeClient()
    store = _seed(client, request_id='r1')
    monkeypatch.setattr(service_mod, 'run_turn',
                        lambda *a, **k: TurnResult('late', [{'role': 'assistant', 'content': 'late'}], []))
    # Meanwhile the user stopped and sent again: the record names r2 now.
    conv, meta = store.load('c1')
    store.save('c1', conv, {**meta, 'pending': {'kind': 'turn', 'request_id': 'r2'}})
    helper = Helper(request_id='r1')
    _service().process_request(_request(client), helper)
    assert helper.done[0]['kind'] == 'turn', 'the request still ends'
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user'], 'nothing written'
    assert meta['pending']['request_id'] == 'r2'


def test_a_missing_conversation_is_an_error_that_names_the_app():
    """A conversation's record is namespaced by app, so this is also what a
    turn sent from ANOTHER app's screen looks like. It happened: IGT offered a
    `ud:assist:` service because the discovery filter asked only about the
    task, and every turn came back "No such conversation" with nothing in the
    message to act on."""
    client = FakeClient()
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert len(helper.errors) == 1
    assert 'No such conversation in igt' in helper.errors[0]
    assert 'belongs to the app it was started in' in helper.errors[0]
    helper = Helper()
    _service().process_request({'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1'}, helper)
    assert helper.errors == ['Missing conversation_id']


def _seed_plan(client, status=None, request_id='r9'):
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    plan = {'id': 'plan1', 'summary': '1 field value', 'labels': ['Text 1 s1.w2 "gam": Gloss = "fish"'],
            'ops': [{'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-2', 'span_id': None, 'value': 'fish',
                     'label': 'Text 1 s1.w2 "gam": Gloss = "fish"'}],
            'documents': [{'id': 'd1', 'name': 'Text 1', 'version': 7}]}
    item = assistant_item('I can gloss it.', plan, [], [], '', 'fake/model')
    item['status'] = status
    conv = {'messages': [{'role': 'user', 'content': 'gloss gam'}, {'role': 'assistant', 'content': 'I can gloss it.'}],
            'display': [user_item('gloss gam'), item]}
    meta = build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model',
                      pending={'kind': 'apply', 'request_id': request_id, 'plan_id': 'plan1'})
    store.save('c1', conv, meta)
    return store


def test_approving_applies_the_plan_from_the_record_and_settles_it():
    client = FakeClient()
    store = _seed_plan(client)
    helper = Helper(request_id='r9')
    svc = _service()
    svc.process_request(_request(client, approve={'plan_id': 'plan1', 'as_human': True}), helper)
    assert not helper.errors, helper.errors
    assert helper.done[0]['kind'] == 'applied' and helper.done[0]['applied'] == 1
    assert client.calls('spans', 'create'), 'the span was written'
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied' and conv['display'][1]['as_human'] is True
    assert conv['messages'][-1]['content'].startswith('(note) The plan was approved and applied: 1 field value.')
    assert meta['pending'] is None
    # Approving again writes nothing twice.
    helper2 = Helper(request_id='r10')
    svc.process_request(_request(client, approve={'plan_id': 'plan1'}), helper2)
    assert helper2.done[0]['duplicate'] is True
    assert len(client.calls('spans', 'create')) == 1


def test_a_stale_plan_is_refused_and_left_undecided():
    client = FakeClient()
    store = _seed_plan(client)
    client._documents['d1']['version'] = 8
    helper = Helper(request_id='r9')
    _service().process_request(_request(client, approve={'plan_id': 'plan1'}), helper)
    assert helper.errors and 'has changed since the plan was made' in helper.errors[0]
    assert not client.calls('spans', 'create')
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] is None and meta['pending'] is None


@pytest.mark.parametrize('status, expected', [('discarded', 'The plan was discarded')])
def test_a_settled_plan_is_not_applied(status, expected):
    client = FakeClient()
    _seed_plan(client, status=status)
    helper = Helper(request_id='r9')
    _service().process_request(_request(client, approve={'plan_id': 'plan1'}), helper)
    assert helper.errors == [expected]
    assert not client.calls('spans', 'create')
