"""Stop is noticed while a model call waits, as the model services notice it
(``plaid_client.workflows.llm``). The assistant used to look only between
calls, so a stop on a silent model waited up to two ``--timeout`` deadlines
(FIX-ASSISTANT, 2026-09-28)."""

import threading
import time
from types import SimpleNamespace

import pytest

from plaid_agent.core import agent
from plaid_agent.core.agent import ModelConfig, Toolkit, TurnCancelled, run_turn
from plaid_agent.core.trace import READ, Tracer


def _kit():
    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: 'Looked',
                    progress=lambda n, a: 'Working…')
    return Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: 'ok', tracer=tracer)


def _resp(content):
    msg = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='stop')],
                           usage=None)


class Ws:
    ops = []


def _stop_after(seconds):
    at = time.monotonic() + seconds
    return lambda: time.monotonic() >= at


def test_a_stop_ends_the_turn_while_the_model_is_silent(monkeypatch):
    release = threading.Event()

    def silent(**kwargs):
        release.wait(30)
        return _resp('late')

    monkeypatch.setattr(agent.litellm, 'completion', silent)
    started = time.monotonic()
    try:
        with pytest.raises(TurnCancelled):
            run_turn(ModelConfig(model='fake/m', stream=False, timeout=120), _kit(), Ws(),
                     'system', [{'role': 'user', 'content': 'hi'}],
                     cancelled=_stop_after(0.3))
        assert time.monotonic() - started < 2, 'seen within about a second of the stop'
    finally:
        release.set()


def test_a_streamed_reply_stops_reaching_the_reader_at_the_stop(monkeypatch):
    release = threading.Event()
    stopped = threading.Event()
    closed = []

    class Stream:
        def __iter__(self):
            yield SimpleNamespace(choices=[SimpleNamespace(
                delta=SimpleNamespace(content='Before the stop'))])
            release.wait(30)
            for _ in range(3):
                yield SimpleNamespace(choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=' after'))])

        def close(self):
            closed.append(True)
            stopped.set()

    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: Stream())
    seen = []
    stop = {'now': False}

    def on_text(t):
        seen.append(t)
        if t == 'Before the stop':
            stop['now'] = True

    with pytest.raises(TurnCancelled):
        run_turn(ModelConfig(model='fake/m', stream=True), _kit(), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}], cancelled=lambda: stop['now'],
                 on_text=on_text)
    release.set()
    assert stopped.wait(5), 'the stream is closed at its next chunk'
    assert all('after' not in t for t in seen), seen


def test_a_call_that_answers_is_read_as_before(monkeypatch):
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: _resp('Hello.'))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit(), Ws(), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    assert turn.text == 'Hello.'


def test_a_provider_error_on_the_worker_reaches_the_turn(monkeypatch):
    def broken(**kw):
        raise ValueError('bad request')

    monkeypatch.setattr(agent.litellm, 'completion', broken)
    with pytest.raises(ValueError, match='bad request'):
        run_turn(ModelConfig(model='fake/m', stream=False), _kit(), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}])


def test_a_stopped_stream_that_then_fails_asks_the_provider_nothing_more(monkeypatch):
    """A streamed call that errors before its first chunk is asked again
    unstreamed (a provider that refuses to stream). Once the turn is stopped,
    the call left running on its worker must not make that second request."""
    release = threading.Event()
    calls = []

    def refuses_late(**kwargs):
        calls.append(kwargs.get('stream'))
        if kwargs.get('stream'):
            release.wait(30)
            raise RuntimeError('streaming is not supported')
        return _resp('unstreamed')

    monkeypatch.setattr(agent.litellm, 'completion', refuses_late)
    with pytest.raises(TurnCancelled):
        run_turn(ModelConfig(model='fake/m', stream=True, timeout=120), _kit(), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}], cancelled=_stop_after(0.3))
    workers = [t for t in threading.enumerate() if t.name == 'model-call']
    release.set()
    for t in workers:
        t.join(5)
    assert calls == [True], calls
