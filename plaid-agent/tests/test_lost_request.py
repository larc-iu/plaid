"""A request the server no longer knows (its service channel dropped and the
server ended it, so the next progress report was answered 404) is not a stop
the reader asked for. A turn records it as an error that says so and can be
sent again, with the steps and the text it had, never as "Stopped.". An
approval whose request went goes on writing, and its record says what was
written."""

from types import SimpleNamespace

from fixtures import FakeClient
from plaid_client import CancelScope, ServiceCancelled, ServiceRequestGone

from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import TurnCancelled
from plaid_agent.core.conversation import CONNECTION_LOST_LINE, rewind_for_retry

from test_service_flow import PLAN1, Helper, _request, _seed, _seed_plan, _service


class GoneHelper(Helper):
    """The client's helper after the server answered 404 for the request:
    ``gone`` and ``cancelled`` both true, and a checkpoint raises
    ServiceRequestGone (a ServiceCancelled)."""

    def __init__(self, request_id='r1', gone_at=None):
        self.gone = False
        super().__init__(request_id=request_id)
        self._scope = CancelScope(lambda: self.asked, lambda: self.gone)
        # The progress line whose report the server refuses with 404.
        self.gone_at = gone_at

    # As the real helper's: true once the reader stops it or once it is gone.
    @property
    def cancelled(self):
        return self.asked or self.gone

    @cancelled.setter
    def cancelled(self, value):
        self.asked = value

    def progress(self, pct, msg='', **extra):
        self._scope.raise_if_cancelled()
        self.progress_log.append((pct, msg))
        self.extras = extra
        if self.gone_at is not None and msg == self.gone_at:
            self.gone = True


def test_a_turn_whose_request_the_server_lost_is_an_error_to_retry_not_a_stop(monkeypatch):
    from plaid_agent.core import agent
    from plaid_agent.core.agent import Toolkit
    from plaid_agent.core.trace import READ, Tracer

    client = FakeClient()
    store = _seed(client)
    helper = GoneHelper()
    calls = [SimpleNamespace(id=f'c{i}', type='function',
                             function=SimpleNamespace(name='search', arguments=f'{{"q": "{i}"}}'))
             for i in (1, 2)]
    resp = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=calls),
                                                    finish_reason='tool_calls')], usage=None)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **k: resp)

    def call_tool(ws, name, args):
        if args['q'] == '2':
            helper.gone = True  # the server answered 404 to the last report
            ws.on_progress('Reading "doc 2"…')
        return 'found it'

    svc = _service()
    svc.kit = Toolkit(tools_for=lambda ws: [], call_tool=call_tool,
                      tracer=Tracer(kind=lambda n: READ, describe=lambda n, a: 'Searched',
                                    progress=lambda n, a: 'Searching…'))
    svc.cfg = agent.ModelConfig(model='fake/model', stream=False)
    svc.process_request(_request(client), helper)

    assert helper.done == [], 'no stop is claimed'
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error']
    item = conv['display'][-1]
    assert item['text'] == CONNECTION_LOST_LINE
    assert 'stopped' not in item
    assert len(item['steps']) == 1, 'the steps made before it stay on the item'
    assert [m['role'] for m in conv['messages']] == ['user'], 'the question stays for Retry'
    assert meta['pending'] is None
    rewound = rewind_for_retry(conv)
    assert rewound is not None and rewound[1]['text'] == 'Which words are unglossed?'


def test_a_lost_request_seen_between_steps_keeps_the_partial_text(monkeypatch):
    client = FakeClient()
    store = _seed(client)
    helper = GoneHelper()

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        helper.gone = True
        assert cancelled() is True
        e = TurnCancelled()
        e.partial = 'Two words are'
        raise e

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    monkeypatch.setattr(turn_mod, 'turn_trace', lambda e: ([], getattr(e, 'partial', None)))
    _service().process_request(_request(client), helper)
    conv, meta = store.load('c1')
    item = conv['display'][-1]
    assert item['kind'] == 'error' and item['text'] == CONNECTION_LOST_LINE and 'stopped' not in item
    assert item['partial'] == 'Two words are'
    assert meta['pending'] is None


def test_a_stop_the_reader_asked_for_is_still_stopped(monkeypatch):
    client = FakeClient()
    store = _seed(client)
    helper = GoneHelper()
    helper.cancelled = True

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        raise TurnCancelled()

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    _service().process_request(_request(client), helper)
    conv, _meta = store.load('c1')
    assert conv['display'][-1]['stopped'] is True and conv['display'][-1]['text'] == 'Stopped.'
    assert helper.done == [{'kind': 'stopped'}]


def test_an_approval_whose_request_went_writes_and_settles_what_it_wrote():
    # The server ended the request as the approval began writing ("Applying
    # changes…" answered 404). The writes are under way and are not stopped
    # by it: the plan is written and settled applied, and the end of the
    # request raises ServiceRequestGone for the client to report nothing.
    client = FakeClient()
    store = _seed_plan(client)
    helper = GoneHelper(request_id='r9', gone_at='Applying changes…')
    try:
        _service().process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    except ServiceRequestGone:
        pass
    assert client.payloads('spans.create'), 'the span was written'
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied'
    assert meta['pending'] is None
    assert not helper.errors


def test_service_request_gone_is_a_service_cancelled():
    assert issubclass(ServiceRequestGone, ServiceCancelled)


class ReadOnlyCancelHelper(Helper):
    """As the real ResponseHelper: ``cancelled`` is a property with no
    setter."""

    def __init__(self):
        self.asked = True
        self._scope = CancelScope(lambda: self.asked)
        self.request_id, self.requester_id = 'r1', 'u@x'
        self.progress_log, self.done, self.errors = [], [], []

    @property
    def cancelled(self):
        return self.asked


def test_a_stop_before_the_first_line_is_recorded_with_the_real_helper(monkeypatch):
    # The send's first progress line is a checkpoint. The real helper's
    # `cancelled` cannot be set, and setting it failed the request.
    client = FakeClient()
    store = _seed(client)
    helper = ReadOnlyCancelHelper()

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        assert cancelled() is True
        raise TurnCancelled()

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    _service().process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    conv, _meta = store.load('c1')
    assert conv['display'][-1]['text'] == 'Stopped.'
