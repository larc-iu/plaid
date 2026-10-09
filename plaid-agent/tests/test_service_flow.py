"""A request on a conversation: the service reads the record, works, and
writes the outcome back before reporting, so the reply lands whether or not
the requester is still listening; a cancelled turn and a moved-on
conversation are settled the same way."""

from types import SimpleNamespace

import pytest

from fixtures import FakeClient
from plaid_client import CancelScope, ServiceCancelled

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import ModelConfig, TurnCancelled, TurnResult
from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.toolkit import tools_for as igt_tools_for


class Helper:
    """plaid_client's ResponseHelper as a turn meets it: ``progress`` is a
    cancellation checkpoint that raises ServiceCancelled once ``cancelled`` is
    set, except inside ``critical()``, as the real one does. A helper whose
    progress never raised hid a stop that landed inside a tool (A2-UD-1)."""

    def __init__(self, request_id='r1', requester_id='u@x'):
        self.request_id = request_id
        self.requester_id = requester_id
        self.cancelled = False
        self._scope = CancelScope(lambda: self.cancelled)
        self.progress_log, self.done, self.errors = [], [], []

    def critical(self):
        return self._scope.critical()

    def progress(self, pct, msg='', **extra):
        self._scope.raise_if_cancelled()
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
    svc.kit = svc.toolkit()  # as `setup` makes it: a turn asks it for the tool schemas
    return svc


def _seed(client, conv_id='c1', request_id='r1', text='Which words are unglossed?'):
    """A record holding a question its turn has not answered, marked with
    that turn's request (as a send writes it), so a request with that id runs
    the turn on it without appending the question again."""
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    conv = {'messages': [{'role': 'user', 'content': text}], 'display': [user_item(text)]}
    meta = build_meta(None, conv_id, conv, 'igt:assist:fake', 'fake/model',
                      pending={'kind': 'turn', 'request_id': request_id, 'service_id': 'igt:assist:fake'})
    store.save(conv_id, conv, meta)
    return store


def _request(client, **extra):
    """A request as the page sends it: ``approve={plan_id, as_human}`` asks
    for an approval, anything else a turn on the last message."""
    approve = extra.pop('approve', None)
    op = ({'op': 'approve', **approve} if approve is not None
          else {'op': 'send', 'text': 'Which words are unglossed?'})
    return {'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1', 'delegated_projects': ['p1'], 'conversation_id': 'c1',
            'tab': 't1', **op, **extra}


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
    real_write = ConversationStore.write
    monkeypatch.setattr(ConversationStore, 'write',
                        lambda self, *a, **k: (order.append('saved'), real_write(self, *a, **k))[1])
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
    item = dict(conv['display'][-1])
    assert item.pop('created_at')
    assert item == {'kind': 'error', 'text': 'Stopped.', 'stopped': True,
                    'model': 'fake/model', 'version': _service().version,
                    'service': 'igt:assist:fake'}
    assert [m['role'] for m in conv['messages']] == ['user'], 'the question stays for the next turn to read'
    assert conv['messages'][0]['content'].endswith('Which words are unglossed?')
    assert meta['pending'] is None


def test_a_stop_seen_while_a_tool_reports_progress_is_recorded_as_a_stop(monkeypatch):
    """A2-UD-1: the reader presses Stop while a tool walks the corpus. The
    tool's next progress line is the client's checkpoint, which raises
    ServiceCancelled (not an Exception). The record gets the Stopped item with
    the steps made before it, the question stays in the transcript, and the
    request ends as stopped rather than escaping to the client."""
    from plaid_agent.core import agent
    from plaid_agent.core.agent import Toolkit
    from plaid_agent.core.trace import READ, Tracer

    client = FakeClient()
    store = _seed(client)
    helper = Helper()
    calls = [SimpleNamespace(id=f'c{i}', type='function',
                             function=SimpleNamespace(name='search', arguments=f'{{"q": "{i}"}}'))
             for i in (1, 2)]
    resp = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=calls),
                                                    finish_reason='tool_calls')], usage=None)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **k: resp)

    def call_tool(ws, name, args):
        if args['q'] == '2':
            helper.cancelled = True  # Stop, while this tool reads its next document
            ws.on_progress('Reading "doc 2"…')
        return 'found it'

    svc = _service()
    svc.kit = Toolkit(tools_for=lambda ws: [], call_tool=call_tool,
                      tracer=Tracer(kind=lambda n: READ, describe=lambda n, a: 'Searched',
                                    progress=lambda n, a: 'Searching…'))
    svc.cfg = agent.ModelConfig(model='fake/model', stream=False)
    svc.process_request(_request(client), helper)

    assert helper.done == [{'kind': 'stopped'}] and not helper.errors
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error']
    item = conv['display'][-1]
    assert item['stopped'] is True and item['text'] == 'Stopped.'
    assert len(item['steps']) == 1 and 'calls' not in item
    [rnd] = [e['value'] for (_u, k), e in client.user_data.store.items() if ':round:c1:' in k]
    assert item['steps'][0]['round'] == rnd['id'] and [c['id'] for c in rnd['calls']] == ['c1']
    assert [m['role'] for m in conv['messages']] == ['user']
    assert meta['pending'] is None


def test_a_stop_while_the_turn_is_set_up_is_recorded_at_its_first_check(monkeypatch):
    """A progress line sent while the turn is set up (a document or another
    project loading) does not end the request with nothing recorded: the stop
    is held off there and seen by the turn itself."""
    client = FakeClient()
    store = _seed(client)
    helper = Helper()
    svc = _service()
    real = svc.make_workspace

    def make_workspace(client, project, on_progress):
        ws = real(client, project, on_progress)
        helper.cancelled = True
        on_progress('Loading…')
        return ws

    svc.make_workspace = make_workspace

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        assert cancelled() is True
        raise TurnCancelled()

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    svc.process_request(_request(client), helper)
    assert helper.done == [{'kind': 'stopped'}]
    conv, meta = store.load('c1')
    assert conv['display'][-1]['stopped'] is True and meta['pending'] is None


def test_a_stop_after_the_answer_was_written_still_reports_the_answer(monkeypatch):
    client = FakeClient()
    store = _seed(client)
    helper = Helper()
    real_save = store.save

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        return TurnResult('Two words.', [{'role': 'assistant', 'content': 'Two words.'}], [])

    def save(self, *a):
        real_save(*a)
        helper.cancelled = True  # Stop lands as the record is written

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    monkeypatch.setattr(ConversationStore, 'save', save)
    _service().process_request(_request(client), helper)
    assert helper.done[0]['kind'] == 'turn' and helper.done[0]['message'] == 'Two words.'
    conv, _meta = store.load('c1')
    assert conv['display'][-1]['kind'] == 'assistant'


def test_a_failed_turn_is_written_as_an_error_item(monkeypatch):
    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(*a, **k):
        raise RuntimeError('provider down')

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.errors == ['The assistant could not answer: provider down']
    conv, meta = store.load('c1')
    assert conv['display'][-1]['kind'] == 'error' and 'provider down' in conv['display'][-1]['text']
    assert meta['pending'] is None


def test_an_outcome_is_not_written_over_a_conversation_that_moved_on(monkeypatch):
    """Another assistant process took the conversation while the turn ran
    (its marker names another request): the outcome is dropped."""
    client = FakeClient()
    store = _seed(client, request_id='r1')

    def fake_run_turn(*a, **k):
        conv, meta = store.load('c1')
        store.save('c1', conv, {**meta, 'pending': {'kind': 'turn', 'request_id': 'r2'}})
        return TurnResult('late', [{'role': 'assistant', 'content': 'late'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper(request_id='r1')
    _service().process_request(_request(client), helper)
    assert helper.done[0]['kind'] == 'turn', 'the request still ends'
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user'], 'nothing written'
    assert meta['pending']['request_id'] == 'r2'


def test_a_send_to_a_conversation_that_is_not_there_is_refused_as_deleted():
    """H10-RECORD-5: a conversation deleted in another tab. The page keeps
    the message and offers a new conversation."""
    client = FakeClient()
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.done == [{'kind': 'refused', 'why': 'gone', 'message': 'This conversation was deleted.'}]
    assert not client.user_data.store, 'nothing written'
    helper = Helper()
    _service().process_request({'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1', 'delegated_projects': ['p1']}, helper)
    assert helper.errors == ['Missing conversation_id']


# A plan's id is a UUIDv7: the ids of what it creates are drawn from it.
PLAN1 = '01920000-0000-7000-8000-000000000001'


def _seed_plan(client, status=None, request_id='r9'):
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    plan = {'id': PLAN1, 'summary': '1 field value', 'labels': ['Text 1 s1.w2 "gam": Gloss = "fish"'],
            'ops': [{'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-2', 'span_id': None, 'value': 'fish',
                     'label': 'Text 1 s1.w2 "gam": Gloss = "fish"'}],
            'documents': [{'id': 'd1', 'name': 'Text 1', 'version': 7}]}
    item = assistant_item('I can gloss it.', plan, [], [], '', 'fake/model', service='igt:assist:fake')
    item['status'] = status
    conv = {'messages': [{'role': 'user', 'content': 'gloss gam'}, {'role': 'assistant', 'content': 'I can gloss it.'}],
            'display': [user_item('gloss gam'), item]}
    meta = build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model',
                      pending={'kind': 'apply', 'request_id': request_id, 'plan_id': PLAN1})
    store.save('c1', conv, meta)
    return store


def test_approving_applies_the_plan_from_the_record_and_settles_it():
    client = FakeClient()
    store = _seed_plan(client)
    helper = Helper(request_id='r9')
    svc = _service()
    svc.process_request(_request(client, approve={'plan_id': PLAN1, 'as_human': True}), helper)
    assert not helper.errors, helper.errors
    assert helper.done[0]['kind'] == 'applied' and helper.done[0]['applied'] == 1
    assert client.payloads('spans.create'), 'the span was written'
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied' and conv['display'][1]['as_human'] is True
    assert conv['messages'][-1]['content'].startswith('(note) The plan was approved and applied: 1 field value.')
    assert meta['pending'] is None
    # Approving again writes nothing twice.
    helper2 = Helper(request_id='r10')
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), helper2)
    assert helper2.done[0]['duplicate'] is True
    assert len(client.payloads('spans.create')) == 1


def test_an_applied_plan_is_one_operation_of_kind_assistant_plan():
    # The audit log is a study's record of what the assistant did: the
    # operation says it is a plan and names the conversation, the plan and
    # the assistant that made it.
    client = FakeClient()
    _seed_plan(client)
    _service().process_request(_request(client, approve={'plan_id': PLAN1}), Helper(request_id='r9'))
    assert client.operations[0].startswith('Assistant: ')
    assert client.operation_tags[0] == {'kind': 'assistant-plan',
                                        'ref': f'conv:c1/plan:{PLAN1}/service:igt:assist:fake'}


def test_a_stale_plan_is_refused_and_settled_as_out_of_date():
    client = FakeClient()
    store = _seed_plan(client)
    client._documents['d1']['version'] = 8
    helper = Helper(request_id='r9')
    _service().process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.errors and 'has changed since the plan was made' in helper.errors[0]
    assert not client.payloads('spans.create')
    conv, meta = store.load('c1')
    # Settled, so the card stops offering an Approve that can only fail, and
    # the model reads on its next turn that nothing happened.
    assert conv['display'][1]['status'] == 'stale' and meta['pending'] is None
    assert conv['messages'][-1]['content'].startswith('(note) The plan was not applied: Document "Text 1"')


@pytest.mark.parametrize('status, expected', [
    ('discarded', 'The plan was discarded'),
    ('stale', 'The plan is out of date. Ask the assistant to plan again.'),
    ('replaced', 'A newer plan replaced this one. Approve the newer plan.')])
def test_a_settled_plan_is_not_applied(status, expected):
    client = FakeClient()
    _seed_plan(client, status=status)
    helper = Helper(request_id='r9')
    _service().process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.errors == [expected]
    assert not client.payloads('spans.create')


def test_the_workspace_is_released_when_the_turn_ends(monkeypatch):
    """A turn may hold a code worker; whichever way the turn ends, the
    service lets the workspace give it back."""
    client = FakeClient()
    _seed(client)
    released = []
    real = AssistantService.make_workspace

    def make_workspace(self, c, project, on_progress):
        ws = real(self, c, project, on_progress)
        ws.close = lambda: released.append(True)
        return ws
    monkeypatch.setattr(AssistantService, 'make_workspace', make_workspace)
    monkeypatch.setattr(service_mod, 'run_turn',
                        lambda *a, **k: TurnResult('hi', [{'role': 'assistant', 'content': 'hi'}], []))
    svc = _service()
    svc.process_request(_request(client), Helper())
    assert released == [True]
    released.clear()

    def cancelled(*a, **k):
        raise TurnCancelled()
    monkeypatch.setattr(service_mod, 'run_turn', cancelled)
    _seed(client)
    svc.process_request(_request(client), Helper())
    assert released == [True]


def test_a_turn_meets_the_file_the_user_attached(monkeypatch):
    """The record carries the reference and the store carries the text, so the
    turn has to put the two together: the model is told what arrived, in front
    of the message it arrived on, and the tools can read the rest of it."""
    from plaid_agent.core.files import file_key

    client = FakeClient()
    store = _seed(client, text='Which of these are already in the corpus?')
    text = 'word,translation\naq\'a,water\nnis,milk\n'
    client.user_data.put('u@x', f'{file_key("igt", "p1", "c1", "f1")}:part:0', text)
    conv, meta = store.load('c1')
    conv['display'][-1]['files'] = [{'id': 'f1', 'name': 'wordlist.csv',
                                     'bytes': len(text.encode()), 'lines': 3, 'chunks': 1}]
    store.save('c1', conv, meta)
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['stamp'] = transcript[-1]['content']
        seen['rows'] = ws.files.get('wordlist.csv').table()[1]
        seen['offered'] = {t['function']['name'] for t in igt_tools_for(ws)}
        return TurnResult('Both.', [{'role': 'assistant', 'content': 'Both.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)

    assert not helper.errors
    assert 'wordlist.csv' in seen['stamp'] and 'a table of 2 rows' in seen['stamp']
    assert seen['stamp'].endswith('Which of these are already in the corpus?')
    assert seen['rows'][0] == {'word': "aq'a", 'translation': 'water'}
    assert 'read_file' in seen['offered']
    # The note is written into the record with the message, so it is paid for
    # once rather than rebuilt (and re-read) on every later turn.
    saved, _ = store.load('c1')
    assert 'wordlist.csv' in saved['messages'][0]['content']


def test_a_turn_with_nothing_attached_is_not_told_about_files(monkeypatch):
    client = FakeClient()
    _seed(client)
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['stamp'] = transcript[-1]['content']
        seen['offered'] = {t['function']['name'] for t in igt_tools_for(ws)}
        return TurnResult('ok', [{'role': 'assistant', 'content': 'ok'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    _service().process_request(_request(client), Helper())
    assert seen['stamp'] == 'Which words are unglossed?'
    assert 'read_file' not in seen['offered']


def _turn_after_plan(monkeypatch, stages):
    """A plan waiting on the card, then a new message whose turn stages a plan
    of its own or not."""
    client = FakeClient()
    store = _seed_plan(client)
    conv, meta = store.load('c1')
    conv['messages'].append({'role': 'user', 'content': 'and the other one too'})
    conv['display'].append(user_item('and the other one too'))
    store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                       pending={'kind': 'turn', 'request_id': 'r1'}))
    real = AssistantService.make_workspace

    def make_workspace(self, c, project, on_progress):
        ws = real(self, c, project, on_progress)
        if stages:
            ws.plan_payload = lambda: {'id': 'p2', 'summary': '2 field values', 'labels': ['a', 'b'],
                                       'ops': [{'kind': 'x'}, {'kind': 'y'}], 'changes': [], 'documents': []}
        return ws

    monkeypatch.setattr(AssistantService, 'make_workspace', make_workspace)
    monkeypatch.setattr(service_mod, 'run_turn', lambda *a, **k: TurnResult(
        'Done.', [{'role': 'assistant', 'content': 'Done.'}], []))
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    return store.load('c1')[0]['display']


def test_a_turn_that_stages_a_plan_replaces_the_one_waiting(monkeypatch):
    display = _turn_after_plan(monkeypatch, stages=True)
    assert display[1]['status'] == 'replaced' and 'ops' not in display[1]['plan']
    assert display[-1]['plan']['id'] == 'p2' and display[-1]['status'] is None


def test_a_turn_that_stages_nothing_leaves_the_plan_waiting(monkeypatch):
    display = _turn_after_plan(monkeypatch, stages=False)
    assert display[1]['status'] is None and display[1]['plan']['ops']
