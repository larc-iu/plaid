"""A turn whose model call fails after a plan was staged keeps the plan, and
says what happened (PROD-LOOP, 2026-11-10).

The turn was stored as "(The model did not answer.)" with the plan card. The
call had reached its 32,768-token output cap, its 110,647 characters of text
were in no place the panel shows, and the turn's usage left the call out.
"""

from types import SimpleNamespace

from fixtures import FakeClient
from test_service_flow import Helper, _request, _seed, _service

from plaid_agent.core import agent
from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import ModelConfig, Toolkit, TurnFailed, TurnResult, cut_line, run_turn
from plaid_agent.core.conversation import PARTIAL_MAX_CHARS, assistant_item, error_item
from plaid_agent.core.trace import PLAN, READ, Tracer

LOOP = 'Make the calls first. Then reply.'


def _call(i, name, arguments):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments=arguments))


def _resp(content=None, calls=None, finish='stop', usage=None, reasoning=None):
    msg = SimpleNamespace(content=content, tool_calls=calls or None, reasoning_content=reasoning)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=finish)], usage=usage)


def _usage(sent, received):
    return SimpleNamespace(prompt_tokens=sent, completion_tokens=received)


class _Ws:
    def __init__(self):
        self.ops = []


def _kit():
    def call_tool(ws, name, args):
        ws.ops.append({'kind': 'x'})
        return 'Planned.'
    tracer = Tracer(kind=lambda n: PLAN if n.startswith('plan') else READ,
                    describe=lambda n, a: 'Planned x', progress=lambda n, a: 'Working…')
    return Toolkit(tools_for=lambda ws: [], call_tool=call_tool, tracer=tracer)


def _planned_then(monkeypatch, second):
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return _resp(calls=[_call(1, 'plan_a', '{}')], usage=_usage(1000, 50))
        return second()

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    ws = _Ws()
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit(), ws, 'system',
                    [{'role': 'user', 'content': 'mark every np'}])
    return turn, ws


def test_a_call_cut_at_the_cap_after_a_plan_says_so_counts_its_tokens_and_keeps_its_text(monkeypatch, capsys):
    said = 'Staged.\n' + '\n'.join([LOOP] * 5)
    turn, ws = _planned_then(monkeypatch, lambda: _resp(said, finish='length', usage=_usage(1200, 32768),
                                                        reasoning='I should call.'))
    assert len(ws.ops) == 1, 'the plan is kept'
    assert turn.text == f'({cut_line(32768)})'
    assert isinstance(turn.failure, TurnFailed)
    assert turn.partial == said
    assert turn.usage['total'] == {'sent': 2200, 'received': 32818, 'calls': 2}
    assert turn.usage['received'] == 32768, 'the failed call is the last the provider reported'
    out = capsys.readouterr().out
    assert 'output limit' in out, out


def test_a_provider_failure_after_a_plan_says_what_it_says_with_nothing_planned(monkeypatch):
    class Down(agent._ProviderError):
        pass

    def second():
        raise Down('upstream 500')
    turn, ws = _planned_then(monkeypatch, second)
    assert len(ws.ops) == 1
    assert turn.text == '(The model could not answer.)'
    assert turn.partial is None
    assert turn.usage['total']['calls'] == 1, 'nothing streamed, nothing counted'


def test_the_stored_reply_says_what_happened_and_keeps_the_text_clipped(monkeypatch):
    """The record holds the reply as the failure's line, the text the call
    wrote (cut from its middle past PARTIAL_MAX_CHARS, with how much went),
    and `failed`, which the research extract reads."""
    client = FakeClient()
    store = _seed(client)
    looped = 'Staged 47 changes.\n' + '\n'.join([LOOP] * 3000)
    failure = TurnFailed(cut_line(32768))

    def run(cfg, kit, ws, system, transcript, on_progress, cancelled=None, on_text=None):
        return TurnResult(f'({cut_line(32768)})', [], [], {'sent': 1, 'received': 2},
                          failure=failure, partial=looped)

    monkeypatch.setattr(turn_mod, 'run_turn', run)
    helper = Helper()
    _service().process_request(_request(client), helper)
    conv, _meta = store.load('c1')
    item = conv['display'][-1]
    assert item['kind'] == 'assistant' and item['failed'] is True
    assert item['text'] == '(The model wrote 32,768 tokens without finishing, so this turn was stopped. ' \
                           'Ask again, perhaps more narrowly.)'
    kept = item['partial']
    assert kept.startswith('Staged 47 changes.') and kept.endswith(LOOP)
    assert f'[{len(looped) - PARTIAL_MAX_CHARS} characters cut to fit the store]' in kept
    assert len(kept) < PARTIAL_MAX_CHARS + 100
    assert helper.done[-1]['message'] == item['text']


def test_a_generic_failure_reads_as_the_service_says_it():
    svc = _service()
    assert svc.turn_failure_line(RuntimeError('boom')).startswith('The assistant could not answer: ')


def test_an_answer_and_an_error_item_hold_their_text_to_the_same_rule():
    long = 'x' * (PARTIAL_MAX_CHARS * 3)
    assert len(error_item('Stopped.', partial=long)['partial']) < PARTIAL_MAX_CHARS + 100
    assert 'partial' not in assistant_item('Hi.', None, [], [], '', 'm')
    assert 'failed' not in assistant_item('Hi.', None, [], [], '', 'm')
    short = assistant_item('(x)', None, [], [], '', 'm', failed=True, partial='So far.')
    assert short['partial'] == 'So far.' and short['failed'] is True


def test_a_generic_failure_after_a_plan_is_the_service_line_in_the_record(monkeypatch):
    client = FakeClient()
    store = _seed(client)

    def run(cfg, kit, ws, system, transcript, on_progress, cancelled=None, on_text=None):
        return TurnResult(f'({agent.NO_ANSWER})', [], [], None, failure=KeyError('ops'))

    monkeypatch.setattr(turn_mod, 'run_turn', run)
    _service().process_request(_request(client), Helper())
    conv, _meta = store.load('c1')
    assert conv['display'][-1]['text'].startswith('(The assistant could not answer: ')
