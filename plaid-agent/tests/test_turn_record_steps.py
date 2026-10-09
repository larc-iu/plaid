"""A turn that fails or is stopped keeps, in the record, the tool calls it
made before it ended: their steps as an answer's are, each naming the round
that holds what it was sent and answered (core/rounds.py), and the text the
model call under way had written (``partial``). The turn's tool messages stay
out of the model transcript (the question stays). Every item is also dated
(``created_at``).

Before 2026-10-06 an error item had neither, so the turns that went wrong
were exactly the ones whose tool use the record lost (R1-EXTRACT, hole 3)."""

import json
import re
from types import SimpleNamespace

import pytest

from fixtures import FakeClient

from plaid_agent.core import agent
from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import ModelConfig, Toolkit, TurnCancelled, run_turn, turn_trace
from plaid_agent.core.conversation import (ConversationStore, assistant_item, error_item, prune, user_item,
                                           conversation_bytes)
from plaid_agent.core.rounds import RoundKeeper, round_prefix
from plaid_agent.core.tools import MAX_RESULT_CHARS
from plaid_agent.core.trace import READ, Tracer, summarize_steps

import test_service_flow as flow

ISO_MS = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')


def _kit(answers):
    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: f'Looked for {a.get("q")}',
                    progress=lambda n, a: 'Working…')
    return Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: answers[a.get('q')], tracer=tracer)


def _calls(*calls, content=None):
    tc = [SimpleNamespace(id=cid, type='function', function=SimpleNamespace(name=name, arguments=args))
          for cid, name, args in calls]
    msg = SimpleNamespace(content=content, tool_calls=tc)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='tool_calls')], usage=None)


class Ws:
    ops = []


def _ws(client):
    ws = Ws()
    ws.rounds = RoundKeeper(ConversationStore(client, 'u@x', 'p1', 'igt'), 'c1')
    return ws


def _rounds(client):
    under = round_prefix('igt', 'p1', 'c1')
    return sorted((e['value'] for (_u, k), e in client.user_data.store.items() if k.startswith(under)),
                  key=lambda r: r['n'])


def _model(script):
    """A model that answers each call with the next of ``script``, raising
    it when it is an exception."""
    it = iter(script)

    def completion(**kwargs):
        nxt = next(it)
        if isinstance(nxt, BaseException):
            raise nxt
        return nxt
    return completion


def test_a_failed_turn_carries_the_calls_it_made(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), ('c2', 'search', '{"q": "nope"}'), content='Looking.'),
        RuntimeError('provider down'),
    ]))
    with pytest.raises(RuntimeError) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': '3 words', 'nope': 'Error: No word nope.'}),
                 _ws(client), 'system', [{'role': 'user', 'content': 'hi'}])
    steps, partial = turn_trace(e.value)
    assert [s['id'] for s in steps] == ['c1', 'c2']
    assert steps[1]['failed'] is True and not steps[0].get('failed')
    assert steps[0]['said'] == 'Looking.' and 'said' not in steps[1]
    [rnd] = _rounds(client)
    assert steps[0]['round'] == steps[1]['round'] == rnd['id']
    assert [{k: c[k] for k in ('id', 'name', 'arguments', 'result')} for c in rnd['calls']] == [
        {'id': 'c1', 'name': 'search', 'arguments': '{"q": "kai"}', 'result': '3 words'},
        {'id': 'c2', 'name': 'search', 'arguments': '{"q": "nope"}', 'result': 'Error: No word nope.'}]
    assert partial == ''


def test_a_stopped_turn_carries_the_calls_made_before_the_stop(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), ('c2', 'search', '{"q": "ko"}')),
    ]))
    kit = _kit({'kai': '3 words', 'ko': '1 word'})
    ran = []
    kit = Toolkit(tools_for=kit.tools_for, tracer=kit.tracer,
                  call_tool=lambda ws, n, a: (ran.append(n), '3 words')[1])

    # The reader stops the turn while its first tool call runs: it is noticed
    # before the second. The round under way is stored with the call it made.
    with pytest.raises(TurnCancelled) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), kit,
                 _ws(client), 'system', [{'role': 'user', 'content': 'hi'}], cancelled=lambda: bool(ran))
    steps, _ = turn_trace(e.value)
    [rnd] = _rounds(client)
    assert [s['id'] for s in steps] == ['c1'] and [c['id'] for c in rnd['calls']] == ['c1']


def test_arguments_are_kept_whole(monkeypatch):
    client = FakeClient()
    code = json.dumps({'q': 'kai', 'code': 'x' * (MAX_RESULT_CHARS + 500)})
    monkeypatch.setattr(agent.litellm, 'completion', _model([_calls(('c1', 'run_code', code)),
                                                               RuntimeError('down')]))
    with pytest.raises(RuntimeError):
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'ok'}), _ws(client), 'system',
                 [{'role': 'user', 'content': 'hi'}])
    [rnd] = _rounds(client)
    assert rnd['calls'][0]['arguments'] == code


def test_an_exception_from_elsewhere_has_no_trace():
    assert turn_trace(ValueError('x')) == ([], '')


def _failing_with(exc, steps, partial):
    exc.turn_steps, exc.turn_partial = steps, partial

    def fake_run_turn(*a, **k):
        raise exc
    return fake_run_turn


STEPS = [{'id': 'c1', 'name': 'search', 'kind': 'read', 'label': 'Searched', 'round': 'r1', 'said': 'First.'},
         {'id': 'c2', 'name': 'lexicon_entry', 'kind': 'read', 'label': 'Looked up kai', 'failed': True,
          'round': 'r1'}]


@pytest.mark.parametrize('exc,stopped', [(RuntimeError('provider down'), False), (TurnCancelled(), True)])
def test_the_record_keeps_a_failed_or_stopped_turns_steps(monkeypatch, exc, stopped):
    client = FakeClient()
    store = flow._seed(client)
    monkeypatch.setattr(service_mod, 'run_turn', _failing_with(exc, STEPS, 'Half a senten'))
    helper = flow.Helper()
    helper.cancelled = stopped
    flow._service().process_request(flow._request(client), helper)
    conv, meta = store.load('c1')
    item = conv['display'][-1]
    assert item['kind'] == 'error' and bool(item.get('stopped')) == stopped
    assert item['steps'] == STEPS
    assert item['steps_summary'] == summarize_steps(STEPS) == '1 search · 2 steps'
    assert item['partial'] == 'Half a senten'
    assert 'calls' not in item
    assert ISO_MS.match(item['created_at'])
    # The question stays, and the calls do not: the model reads what was
    # asked, never the tool use of a turn that did not finish.
    assert [m['role'] for m in conv['messages']] == ['user']
    assert meta['pending'] is None


def test_every_item_is_dated():
    for item in (user_item('q'), assistant_item('a', None, [], [], '', 'm'), error_item('x')):
        assert ISO_MS.match(item['created_at'])


def test_prune_drops_an_older_failed_turns_steps():
    steps = [{'id': f'c{i}', 'name': 'search', 'kind': 'read', 'label': 'Searched', 'round': 'r'} for i in range(3)]
    conv = {'messages': [], 'display': [user_item('a'), error_item('failed', steps=steps), user_item('b'),
                                        error_item('failed', steps=steps)]}
    out = prune(conv, budget=conversation_bytes(conv) - 100)
    assert out['display'][1]['steps'] == []
    assert out['display'][3]['steps'], 'the item on screen keeps its steps'
