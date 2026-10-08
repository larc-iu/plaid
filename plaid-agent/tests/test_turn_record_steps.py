"""A turn that fails or is stopped keeps, in the record, the tool calls it
made before it ended: their steps as an answer's are, and what each was sent
and answered. The turn's tool messages stay out of the model transcript (the
question stays), so the calls ride on the error item, which the model never
reads. Every item is also dated (``created_at``).

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
from plaid_agent.core.conversation import (DROPPED, ConversationStore, assistant_item, build_meta, error_item,
                                           prune, user_item, conversation_bytes)
from plaid_agent.core.tools import MAX_RESULT_CHARS
from plaid_agent.core.trace import READ, Tracer, summarize_steps

import test_service_flow as flow

ISO_MS = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')


def _kit(answers):
    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: f'Looked for {a.get("q")}',
                    progress=lambda n, a: 'Working…')
    return Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: answers[a.get('q')], tracer=tracer)


def _calls(*calls):
    tc = [SimpleNamespace(id=cid, type='function', function=SimpleNamespace(name=name, arguments=args))
          for cid, name, args in calls]
    msg = SimpleNamespace(content=None, tool_calls=tc)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='tool_calls')], usage=None)


class Ws:
    ops = []


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
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), ('c2', 'search', '{"q": "nope"}')),
        RuntimeError('provider down'),
    ]))
    with pytest.raises(RuntimeError) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': '3 words', 'nope': 'Error: No word nope.'}),
                 Ws(), 'system', [{'role': 'user', 'content': 'hi'}])
    steps, calls = turn_trace(e.value)
    assert [s['id'] for s in steps] == ['c1', 'c2']
    assert steps[1]['failed'] is True and not steps[0].get('failed')
    assert calls == [{'id': 'c1', 'name': 'search', 'arguments': '{"q": "kai"}', 'result': '3 words'},
                     {'id': 'c2', 'name': 'search', 'arguments': '{"q": "nope"}', 'result': 'Error: No word nope.'}]


def test_a_stopped_turn_carries_the_calls_made_before_the_stop(monkeypatch):
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), ('c2', 'search', '{"q": "ko"}')),
    ]))
    kit = _kit({'kai': '3 words', 'ko': '1 word'})
    ran = []
    kit = Toolkit(tools_for=kit.tools_for, tracer=kit.tracer,
                  call_tool=lambda ws, n, a: (ran.append(n), '3 words')[1])

    # The reader stops the turn while its first tool call runs: it is noticed
    # before the second.
    with pytest.raises(TurnCancelled) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), kit,
                 Ws(), 'system', [{'role': 'user', 'content': 'hi'}], cancelled=lambda: bool(ran))
    steps, calls = turn_trace(e.value)
    assert [s['id'] for s in steps] == ['c1'] and [c['id'] for c in calls] == ['c1']


def test_long_arguments_are_cut_as_a_result_is(monkeypatch):
    code = json.dumps({'q': 'kai', 'code': 'x' * (MAX_RESULT_CHARS + 500)})
    monkeypatch.setattr(agent.litellm, 'completion', _model([_calls(('c1', 'run_code', code)),
                                                               RuntimeError('down')]))
    with pytest.raises(RuntimeError) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'ok'}), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}])
    _, calls = turn_trace(e.value)
    assert calls[0]['arguments'].startswith(code[:100])
    assert len(calls[0]['arguments']) < MAX_RESULT_CHARS + 200


def test_an_exception_from_elsewhere_has_no_trace():
    assert turn_trace(ValueError('x')) == ([], [])


def _failing_with(exc, steps, calls):
    exc.turn_steps, exc.turn_calls = steps, calls

    def fake_run_turn(*a, **k):
        raise exc
    return fake_run_turn


STEPS = [{'id': 'c1', 'name': 'search', 'kind': 'read', 'label': 'Searched'},
         {'id': 'c2', 'name': 'lexicon_entry', 'kind': 'read', 'label': 'Looked up kai', 'failed': True}]
CALLS = [{'id': 'c1', 'name': 'search', 'arguments': '{"q": "kai"}', 'result': '3 words'},
         {'id': 'c2', 'name': 'lexicon_entry', 'arguments': '{"form": "kai"}',
          'result': 'Error: lexicon_entry cannot be called with those arguments'}]


@pytest.mark.parametrize('exc,stopped', [(RuntimeError('provider down'), False), (TurnCancelled(), True)])
def test_the_record_keeps_a_failed_or_stopped_turns_steps(monkeypatch, exc, stopped):
    client = FakeClient()
    store = flow._seed(client)
    monkeypatch.setattr(service_mod, 'run_turn', _failing_with(exc, STEPS, CALLS))
    helper = flow.Helper()
    helper.cancelled = stopped
    flow._service().process_request(flow._request(client), helper)
    conv, meta = store.load('c1')
    item = conv['display'][-1]
    assert item['kind'] == 'error' and bool(item.get('stopped')) == stopped
    assert item['steps'] == STEPS
    assert item['steps_summary'] == summarize_steps(STEPS) == '1 search · 2 steps'
    assert item['calls'] == CALLS
    assert ISO_MS.match(item['created_at'])
    # The question stays, and the calls do not: the model reads what was
    # asked, never the tool use of a turn that did not finish.
    assert [m['role'] for m in conv['messages']] == ['user']
    assert meta['pending'] is None


def test_every_item_is_dated():
    for item in (user_item('q'), assistant_item('a', None, [], [], '', 'm'), error_item('x')):
        assert ISO_MS.match(item['created_at'])


def _error(n, size):
    calls = [{'id': f'c{n}.{i}', 'name': 'search', 'arguments': '{}', 'result': 'r' * size} for i in range(3)]
    steps = [{'id': c['id'], 'name': 'search', 'kind': 'read', 'label': 'Searched'} for c in calls]
    return error_item('failed', steps=steps, calls=calls)


def test_prune_drops_a_failed_turns_results_before_anything_shown():
    conv = {'messages': [], 'display': [user_item('a'), _error(1, 4000), user_item('b'), _error(2, 4000)]}
    whole = conv_bytes = conversation_bytes(conv)
    out = prune(conv, budget=whole - 5000)
    first, last = out['display'][1], out['display'][3]
    assert conversation_bytes(out) <= whole - 5000
    assert [c['result'] for c in first['calls']][:2] == [DROPPED, DROPPED], 'oldest first'
    assert first['steps'] and all(c['arguments'] == '{}' for c in first['calls']), 'steps and arguments stay'
    assert last['calls'][-1]['result'] == 'r' * 4000
    assert conv_bytes == whole


def test_prune_then_drops_an_older_failed_turns_steps_with_its_calls():
    conv = {'messages': [], 'display': [user_item('a'), _error(1, 10), user_item('b'), _error(2, 10)]}
    out = prune(conv, budget=conversation_bytes(conv) - 400)
    assert out['display'][1]['steps'] == [] and out['display'][1]['calls'] == []
    assert out['display'][3]['steps'], 'the item on screen keeps its steps'
