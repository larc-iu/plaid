"""A model refused as busy is waited for, and the reader is told (FX-BUSY).

A class of eight shared one model key that allows 4 requests in flight. The
endpoint answered the fifth with HTTP 429 (``max_parallel_requests``), the
assistant tried again for at most 14 s while other calls held their slots for
1 to 5 minutes, and 15 student turns ended "The model could not answer."
(PROD-CLASS, 2026-11-11). The owner's ruling: wait for a slot for about 3
minutes, say so ("The model is busy. Waiting for a free slot…"), keep Stop
working, and when the wait runs out say "The model is busy. Try again in a
minute.". The other passing failures keep their short schedule.

No test sleeps: a fake clock stands in for the loop's (``agent.time``).
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from fixtures import FakeClient
from test_service_flow import Helper, _request, _seed, _service

from plaid_agent.core import agent
from plaid_agent.core.agent import ModelConfig, Toolkit, TurnCancelled, model_failure_line, run_turn
from plaid_agent.core.trace import PLAN, READ, Tracer
from plaid_agent.research.records import turn_end
from plaid_client.workflows import llm

BUSY_MESSAGE = ('Rate limit exceeded for api_key: 1a2b. Limit type: max_parallel_requests. Current limit: 4, '
                'Remaining: 0. Limit resets at: 2026-11-11 21:20:48 UTC')


class Clock:
    """The loop's clock: ``sleep`` moves it on and returns at once."""

    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def monotonic(self):
        return self.now

    def time(self):
        return self.now

    def sleep(self, s):
        self.slept.append(s)
        self.now += s


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(agent, 'time', c)
    monkeypatch.setattr(llm.random, 'uniform', lambda a, b: 0.0)
    return c


def busy(hint=None):
    e = agent.litellm.RateLimitError(BUSY_MESSAGE, model='glm', llm_provider='openai')
    e.litellm_response_headers = {'retry-after': str(hint)} if hint is not None else {}
    return e


def _resp(content=None, calls=None):
    msg = SimpleNamespace(content=content, tool_calls=calls or None, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='stop')], usage=None)


def _call(i, name):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments='{}'))


class Ws:
    def __init__(self):
        self.ops = []


def _kit():
    def call_tool(ws, name, args):
        ws.ops.append({'kind': 'x'})
        return 'Planned.'
    tracer = Tracer(kind=lambda n: PLAN if n.startswith('plan') else READ,
                    describe=lambda n, a: 'Planned x', progress=lambda n, a: 'Working…')
    return Toolkit(tools_for=lambda ws: [], call_tool=call_tool, tracer=tracer)


def _script(monkeypatch, *replies):
    calls = []
    it = iter(replies)

    def completion(**kwargs):
        calls.append(kwargs)
        r = next(it)
        if isinstance(r, BaseException):
            raise r
        return r

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    return calls


def _run(ws=None, cancelled=lambda: False):
    progress = []
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit(), ws or Ws(), 'system',
                    [{'role': 'user', 'content': 'mark every np'}],
                    on_progress=lambda p, m: progress.append(m), cancelled=cancelled)
    return turn, progress


# --- the wait ------------------------------------------------------------------

def test_a_busy_model_with_a_hint_is_waited_for_as_it_says_and_the_reader_is_told(monkeypatch, clock):
    calls = _script(monkeypatch, busy(60), busy(60), _resp('Done.'))
    turn, progress = _run()
    assert turn.text == 'Done.'
    assert len(calls) == 3
    assert clock.slept and sum(clock.slept) == 120, clock.slept
    assert progress == ['Thinking…', llm.BUSY_WAITING, 'Thinking…', llm.BUSY_WAITING, 'Thinking…']
    assert llm.BUSY_WAITING == 'The model is busy. Waiting for a free slot…'


def test_without_a_hint_the_waits_back_off_and_never_all_land_at_once(monkeypatch, clock):
    calls = _script(monkeypatch, busy(), busy(), busy(), busy(), busy(), _resp('Done.'))
    waits = []
    delay = llm.busy_delay
    monkeypatch.setattr(llm, 'busy_delay', lambda *a: waits.append(delay(*a)) or waits[-1])
    turn, _ = _run()
    assert turn.text == 'Done.' and len(calls) == 6
    assert waits == [5, 10, 20, 30, 30]
    assert sum(clock.slept) == pytest.approx(95)

    # Jitter makes each wait longer by up to a fifth, never shorter.
    monkeypatch.setattr(llm.random, 'uniform', lambda a, b: b)
    assert llm.busy_delay(busy(), 0, 999) == pytest.approx(6.0)
    assert llm.busy_delay(busy(60), 0, 999) == pytest.approx(72.0)
    assert llm.busy_delay(busy(60), 0, 40) == 40, 'never past the budget left'


def test_the_budget_is_the_whole_wait_and_running_out_says_the_model_is_busy(monkeypatch, clock):
    calls = _script(monkeypatch, *[busy()] * 50)
    with pytest.raises(agent.litellm.RateLimitError) as e:
        _run()
    assert sum(clock.slept) == pytest.approx(llm.BUSY_WAIT_S)
    # 5 + 10 + 20 + 30 + 30 + 30 + 30 = 155, and the last wait is what is left.
    assert len(calls) == 9
    assert model_failure_line(e.value) == 'The model is busy. Try again in a minute.'
    # A hint longer than what is left waits only what is left.
    clock.slept.clear()
    calls = _script(monkeypatch, *[busy(150)] * 5)
    with pytest.raises(agent.litellm.RateLimitError):
        _run()
    assert sum(clock.slept) == pytest.approx(llm.BUSY_WAIT_S) and len(calls) == 3


def test_stop_during_the_wait_ends_the_turn_at_once(monkeypatch, clock):
    calls = _script(monkeypatch, busy(60), _resp('never asked for'))
    stop_at = clock.now + 12
    with pytest.raises(TurnCancelled):
        _run(cancelled=lambda: clock.now >= stop_at)
    assert len(calls) == 1, 'nothing more is asked of the model'
    assert sum(clock.slept) <= 12.5, 'the wait ends within half a second of the stop'


def test_the_other_passing_failures_keep_the_short_schedule(monkeypatch, clock):
    calls = _script(monkeypatch, *[agent.litellm.InternalServerError('down', model='x', llm_provider='openai')] * 9)
    with pytest.raises(agent.litellm.InternalServerError) as e:
        _run()
    assert len(calls) == agent.RETRIES + 1
    assert model_failure_line(e.value) == 'The model could not answer.'
    conn = agent.litellm.APIConnectionError('reset', model='x', llm_provider='openai')
    assert model_failure_line(conn) == 'The model could not answer.'
    assert not llm.is_busy(conn, agent.litellm) and llm.is_busy(busy(), agent.litellm)
    # The openai SDK's own 429, raised as it is, is a busy refusal too.
    import httpx
    import openai
    raw = openai.RateLimitError('busy', response=httpx.Response(429, request=httpx.Request('POST', 'http://x')),
                                body=None)
    assert llm.is_busy(raw, agent.litellm)
    assert not llm.is_busy(RuntimeError('RateLimitError: Model capacity reached'), agent.litellm), \
        'decided by the error class, never by its words'


def test_the_providers_hint_is_read_from_its_header_or_its_reset_time():
    assert llm.busy_hint(busy(60)) == 60
    e = busy()
    e.litellm_response_headers = {'retry-after': 'Wed, 11 Nov 2026 21:21:48 GMT'}
    reset = 1794432108.0  # 2026-11-11 21:21:48 UTC
    assert llm.busy_hint(e, now=reset - 45) == pytest.approx(45)
    # No header: the "Limit resets at" time a litellm proxy writes, in UTC.
    assert llm.busy_hint(busy(), now=reset - 60 - 30) == pytest.approx(30)
    assert llm.busy_hint(busy(), now=reset) is None, 'a time already past is no hint'
    plain = agent.litellm.RateLimitError('Model capacity reached for glm-5.3-flash. Model RPM: 60',
                                         model='glm', llm_provider='openai')
    assert llm.busy_hint(plain) is None


# --- what the reader is told -----------------------------------------------------

def test_a_busy_failure_after_a_plan_keeps_the_plan_and_says_the_model_is_busy(monkeypatch, clock):
    _script(monkeypatch, _resp(calls=[_call(1, 'plan_a')]), *[busy()] * 50)
    ws = Ws()
    turn, _ = _run(ws)
    assert len(ws.ops) == 1, 'the plan is kept'
    assert turn.text == '(The model is busy. Try again in a minute.)'
    assert turn_end({'kind': 'assistant', 'failed': True, 'text': turn.text}) == 'busy'


def test_the_service_shows_the_wait_and_records_the_busy_line(monkeypatch, clock):
    client = FakeClient()
    store = _seed(client)
    _script(monkeypatch, *[busy()] * 50)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.errors == ['The model is busy. Try again in a minute.']
    assert any(m == 'The model is busy. Waiting for a free slot…' for _, m in helper.progress_log)
    conv, meta = store.load('c1')
    item = conv['display'][-1]
    assert item['kind'] == 'error' and item['text'] == 'The model is busy. Try again in a minute.'
    assert meta['pending'] is None
    assert turn_end(item) == 'busy'
    assert turn_end({**item, 'lost': True}) == 'busy'


def test_a_stop_during_the_wait_is_recorded_as_stopped(monkeypatch, clock):
    client = FakeClient()
    store = _seed(client)
    calls = _script(monkeypatch, busy(60), _resp('never asked for'))
    helper = Helper()
    stop_at = clock.now + 3
    real = clock.sleep

    def sleep(s):
        real(s)
        if clock.now >= stop_at:
            helper.cancelled = True
    monkeypatch.setattr(clock, 'sleep', sleep)
    _service().process_request(_request(client), helper)
    assert helper.done == [{'kind': 'stopped'}] and not helper.errors
    assert len(calls) == 1
    conv, meta = store.load('c1')
    assert conv['display'][-1]['text'] == 'Stopped.' and meta['pending'] is None


# --- the startup ping ----------------------------------------------------------------

def test_a_busy_model_at_startup_does_not_take_the_service_down(monkeypatch, clock, capsys):
    from plaid_agent.igt.service import AssistantService
    from test_agent import service_args
    calls = _script(monkeypatch, *[busy(60)] * 10)
    svc = AssistantService()
    svc.setup(service_args())
    assert len(calls) == agent.RETRIES + 1, 'the ping keeps its short schedule'
    assert sum(clock.slept) < 30
    out = capsys.readouterr().out
    assert 'The model is busy' in out and 'Serving anyway' in out


# --- through a real HTTP endpoint ------------------------------------------------------

class _Endpoint:
    """An OpenAI-shaped endpoint that answers 429 (with Retry-After, then
    without) and then streams a reply."""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.seen = 0
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length') or 0))
                outer.seen += 1
                status = outer.statuses.pop(0) if outer.statuses else 200
                if status != 200:
                    body = json.dumps({'error': {'message': BUSY_MESSAGE, 'code': '429'}}).encode()
                    self.send_response(429)
                    if status == '429-hint':
                        self.send_header('retry-after', '7')
                    self.send_header('content-type', 'application/json')
                    self.send_header('content-length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                for piece in ('Here ', 'it is.'):
                    chunk = {'id': 'x', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'm',
                             'choices': [{'index': 0, 'delta': {'content': piece}, 'finish_reason': None}]}
                    self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
                end = {'id': 'x', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'm',
                       'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}
                self.wfile.write(f'data: {json.dumps(end)}\n\ndata: [DONE]\n\n'.encode())

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def test_a_real_429_with_and_without_a_hint_then_an_answer(monkeypatch, clock):
    endpoint = _Endpoint(['429-hint', '429', 200])
    try:
        progress = []
        turn = run_turn(ModelConfig(model='openai/m', api_base=endpoint.url, api_key='k'), _kit(), Ws(),
                        'system', [{'role': 'user', 'content': 'hi'}],
                        on_progress=lambda p, m: progress.append(m))
    finally:
        endpoint.close()
    assert turn.text == 'Here it is.'
    assert endpoint.seen == 3
    assert sum(clock.slept) == pytest.approx(7 + 10), 'Retry-After 7, then the second step of the back-off'
    assert progress.count(llm.BUSY_WAITING) == 2 and progress[-1] == 'Thinking…'
