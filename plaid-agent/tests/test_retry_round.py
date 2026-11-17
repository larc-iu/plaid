"""The round a progress event names (REV-SVU-3) while a chat's model call is
asked once more after a failure (SVA A1, `agent._run_turn.ask`): the call
asked again is the same model call, so its "Asking the model again…" line and
the answer's events name the same round, with the start of the first attempt
and not waiting, and a tool that runs after it still clears the round."""

from types import SimpleNamespace

from plaid_agent.core import agent
from plaid_agent.core.agent import RETRY_PROGRESS, ModelConfig, Toolkit, run_turn
from plaid_agent.core.trace import READ, Tracer

litellm = agent.litellm


def _call(i, name):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments='{}'))


def _resp(content=None, calls=None):
    msg = SimpleNamespace(content=content, tool_calls=calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='stop')], usage=None)


class Ws:
    def __init__(self):
        self.ops = []


def test_the_call_asked_again_keeps_its_round_and_its_start(monkeypatch):
    ws = Ws()
    events = []
    script = [_resp(calls=[_call(1, 'read_a')]),
              litellm.InternalServerError('down', model='x', llm_provider='openai'),
              _resp(calls=[_call(2, 'read_b')]),
              _resp('Done.')]
    calls = []

    def model(cfg, kwargs, on_text, cancelled=None, on_thinking=None, on_busy=None, **ladder):
        calls.append(dict(ws.model_round) if ws.model_round else None)
        out = script[len(calls) - 1]
        if isinstance(out, BaseException):
            raise out
        return out

    monkeypatch.setattr(agent, '_complete', model)
    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: 'Looked', progress=lambda n, a: 'Looking…')
    kit = Toolkit(tools_for=lambda w: [], call_tool=lambda w, n, a: 'found 3', tracer=tracer)
    turn = run_turn(ModelConfig(model='fake/m', stream=False), kit, ws, 'system',
                    [{'role': 'user', 'content': 'hi'}],
                    on_progress=lambda p, m: events.append((m, dict(ws.model_round) if ws.model_round else None)))
    assert turn.text == 'Done.'
    by_line = [(m, r and r['n']) for m, r in events]
    assert by_line == [('Thinking…', 1), ('Looking…', None), ('Thinking more…', 2), (RETRY_PROGRESS, 2),
                       ('Looking…', None), ('Thinking more…', 3)]
    second = [r for m, r in events if r and r['n'] == 2]
    assert len({r['began'] for r in second}) == 1, 'the call asked again counts from the first attempt'
    assert not any(r['waiting'] for r in second)
    assert calls[1] == calls[2] == second[0], 'both attempts of the second call are its round'
