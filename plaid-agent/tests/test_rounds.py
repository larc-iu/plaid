"""Each model call of a turn (a round) is stored beside the conversation:
what the model wrote beside its tool calls, each call's whole arguments and
its result exactly as the model was sent it, and the question as received on
the first (design/TRANSPARENCY.md). The record keeps only the steps' round
ids, the text between calls (``said``) and what each call read."""

import time
from types import SimpleNamespace

import pytest
from live import require_sandbox

from fixtures import FakeClient
from plaid_client import PlaidAPIError

from plaid_agent.core import agent
from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import ModelConfig, Toolkit, TurnCancelled, TurnResult, run_turn, turn_trace
from plaid_agent.core.conversation import ConversationStore, build_meta, meta_key
from plaid_agent.core.files import ORPHAN_AGE_S, sweep_orphans
from plaid_agent.core.rounds import RoundKeeper, fit, prompt_prefix, round_key, round_prefix
from plaid_agent.core.trace import READ, Tracer

import test_service_flow as flow

TRACER = Tracer(kind=lambda n: READ, describe=lambda n, a: f'Looked for {a.get("q")}',
                progress=lambda n, a: 'Working…')


def _calls(*calls, content=None):
    tc = [SimpleNamespace(id=cid, type='function', function=SimpleNamespace(name=name, arguments=args))
          for cid, name, args in calls]
    msg = SimpleNamespace(content=content, tool_calls=tc)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='tool_calls')], usage=None)


def _reply(text):
    msg = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='stop')], usage=None)


def _model(script, before=None):
    it = iter(script)

    def completion(**kwargs):
        if before:
            before(kwargs)
        nxt = next(it)
        if isinstance(nxt, BaseException):
            raise nxt
        return nxt
    return completion


class Ws:
    ops = []


def _store(client, conv='c1'):
    return ConversationStore(client, 'u@x', 'p1', 'igt')


def _ws(client, **kw):
    ws = Ws()
    ws.rounds = RoundKeeper(_store(client), 'c1', **kw)
    return ws


def _kit(answers):
    return Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: answers[a.get('q')], tracer=TRACER)


def _rounds(client, conv='c1'):
    under = round_prefix('igt', 'p1', conv)
    return sorted((e['value'] for (_u, k), e in client.user_data.store.items() if k.startswith(under)),
                  key=lambda r: r['n'])


def test_text_and_two_calls_then_a_reply(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), ('c2', 'search', '{"q": "ko"}'), content='Let me look.'),
        _reply('Two words.'),
    ]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': '3 words', 'ko': '1 word'}),
                    _ws(client), 'system', [{'role': 'user', 'content': '[In "Text 1"] hi'}])
    a, b = turn.steps
    [rnd] = _rounds(client)
    assert a['said'] == 'Let me look.' and 'said' not in b
    assert a['round'] == b['round'] == rnd['id']
    assert rnd['said'] == 'Let me look.' and rnd['asked'] == '[In "Text 1"] hi' and rnd['n'] == 1
    tool_messages = {m['tool_call_id']: m['content'] for m in turn.messages if m['role'] == 'tool'}
    assert [(c['id'], c['arguments'], c['result'], c['chars']) for c in rnd['calls']] == [
        ('c1', '{"q": "kai"}', tool_messages['c1'], 7), ('c2', '{"q": "ko"}', tool_messages['c2'], 6)]
    assert rnd['conversation_id'] == 'c1' and rnd['model'] == 'fake/m'
    # The reply's round holds nothing the steps' do not, so none is stored.
    assert turn.reply_round is None and turn.text == 'Two words.'


def test_a_turn_with_no_tool_call_stores_the_question_as_received(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([_reply('Hello.')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({}), _ws(client), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    [rnd] = _rounds(client)
    assert turn.reply_round == rnd['id'] and rnd['asked'] == 'hi' and rnd['calls'] == []
    assert 'said' not in rnd, 'the reply is the item\'s text'


def test_a_round_is_stored_before_the_next_model_call(monkeypatch):
    client = FakeClient()
    seen = []
    monkeypatch.setattr(agent.litellm, 'completion', _model(
        [_calls(('c1', 'search', '{"q": "kai"}')), _calls(('c2', 'search', '{"q": "ko"}')), _reply('ok')],
        before=lambda kw: seen.append(len(_rounds(client)))))
    run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a', 'ko': 'b'}), _ws(client), 'system',
             [{'role': 'user', 'content': 'hi'}])
    assert seen == [0, 1, 2]


def test_a_round_the_store_refuses_leaves_its_steps_unopenable(monkeypatch):
    client = FakeClient()
    ws = _ws(client)
    monkeypatch.setattr(ws.rounds, 'store', lambda rnd: False)
    monkeypatch.setattr(agent.litellm, 'completion', _model([_calls(('c1', 'search', '{"q": "kai"}')),
                                                               _reply('ok')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), ws, 'system',
                    [{'role': 'user', 'content': 'hi'}])
    assert turn.text == 'ok' and turn.steps[0]['unstored'] is True


def test_a_store_that_raises_does_not_fail_the_turn(monkeypatch):
    client = FakeClient()
    real = client.user_data.put

    def put(user, key, value, version=None):
        if ':round:' in key:
            raise PlaidAPIError('HTTP 413', status=413)
        return real(user, key, value, version)
    monkeypatch.setattr(client.user_data, 'put', put)
    monkeypatch.setattr(agent.litellm, 'completion', _model([_calls(('c1', 'search', '{"q": "kai"}')),
                                                               _reply('ok')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), _ws(client), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    assert turn.text == 'ok' and turn.steps[0]['unstored'] is True


def _chunk(content=None):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content))])


def test_a_stop_mid_stream_keeps_the_text_written_so_far(monkeypatch):
    client = FakeClient()
    stop = {'now': False}

    def stream():
        yield _chunk('Half a ')
        yield _chunk('sentence')
        time.sleep(0.3)
        stop['now'] = True
        time.sleep(2)
        yield _chunk(' more')
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: stream())
    with pytest.raises(TurnCancelled) as e:
        run_turn(ModelConfig(model='fake/m'), _kit({}), _ws(client), 'system',
                 [{'role': 'user', 'content': 'hi'}], cancelled=lambda: stop['now'])
    steps, partial = turn_trace(e.value)
    assert steps == [] and partial == 'Half a sentence'


def test_a_stop_between_calls_keeps_the_text_of_the_round_whose_calls_never_ran(monkeypatch):
    client = FakeClient()
    stop = {'now': False}
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), content='First this.')],
        before=lambda kw: stop.update(now=True)))
    with pytest.raises(TurnCancelled) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), _ws(client), 'system',
                 [{'role': 'user', 'content': 'hi'}], cancelled=lambda: stop['now'])
    steps, partial = turn_trace(e.value)
    assert steps == [] and partial == 'First this.'


def test_a_provider_failure_after_a_round_keeps_the_round_and_its_steps(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}'), content='One.'), RuntimeError('down')]))
    with pytest.raises(RuntimeError) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), _ws(client), 'system',
                 [{'role': 'user', 'content': 'hi'}])
    steps, partial = turn_trace(e.value)
    [rnd] = _rounds(client)
    assert steps[0]['round'] == rnd['id'] and steps[0]['said'] == 'One.' and partial == ''


def test_a_round_over_the_cap_is_cut_to_fit():
    rnd = {'id': 'r', 'n': 2, 'calls': [{'id': 'c1', 'name': 's', 'arguments': '{}', 'result': 'x' * 5000,
                                         'chars': 5000},
                                        {'id': 'c2', 'name': 's', 'arguments': '{}', 'result': 'small',
                                         'chars': 5}]}
    out = fit(rnd, 2000)
    from plaid_agent.core.conversation import _bytes
    assert _bytes(out) <= 2000 and out['fitted'] is True
    assert 'characters cut to fit the store' in out['calls'][0]['result']
    assert out['calls'][1]['result'] == 'small'
    assert fit(rnd, 100_000) is rnd


def test_the_instructions_are_stored_once_per_distinct_prompt(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(RoundKeeper, '_prompts_known', set())
    tools = [{'type': 'function', 'function': {'name': 'search', 'parameters': {'properties': {'from_sentence': {}}}}}]
    for system in ('You help.', 'You help.', 'You help more.'):
        monkeypatch.setattr(agent.litellm, 'completion', _model([_reply('ok')]))
        turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({}),
                        _ws(client, system=system, tools=tools), system, [{'role': 'user', 'content': 'hi'}])
        assert turn.reply_round
    under = prompt_prefix('igt', 'p1', 'c1')
    prompts = {k: e['value'] for (_u, k), e in client.user_data.store.items() if k.startswith(under)}
    assert len(prompts) == 2
    rounds = _rounds(client)
    assert all(r['prompt'] and under + r['prompt'] in prompts for r in rounds)
    one = prompts[under + rounds[0]['prompt']]
    assert one['system'] == 'You help.' and '"from_sentence"' in one['tools'], 'the tool list as sent, not recased'


def test_delete_removes_every_round_and_prompt_files_first_entry_last():
    client = FakeClient()
    store = flow._seed(client)
    for i in range(1205):
        client.user_data.put('u@x', round_key('igt', 'p1', 'c1', f'r{i:05}'), {'n': 1})
    client.user_data.put('u@x', prompt_prefix('igt', 'p1', 'c1') + 'abc', {'system': 's'})
    order = []
    real = client.user_data.delete
    client.user_data.delete = lambda u, k: (order.append(k), real(u, k))[1]
    store.delete('c1')
    assert not [k for (_u, k) in client.user_data.store if ':c1' in k]
    assert order[-1] == meta_key('igt', 'p1', 'c1')
    assert sum(1 for k in order if ':round:' in k) == 1205


def test_the_orphan_sweep_takes_rounds_of_a_deleted_conversation():
    client = FakeClient()
    store = _store(client)
    flow._seed(client, conv_id='alive')
    client.user_data.put('u@x', round_key('igt', 'p1', 'alive', 'r1'), {'n': 1})
    client.user_data.put('u@x', round_key('igt', 'p1', 'gone', 'r1'), {'n': 1})
    client.user_data.put('u@x', prompt_prefix('igt', 'p1', 'gone') + 'h', {'system': 's'})
    assert sweep_orphans(store) == 0, 'too young'
    assert sweep_orphans(store, now=time.time() + 2 * ORPHAN_AGE_S) == 2
    left = [k for (_u, k) in client.user_data.store]
    assert round_key('igt', 'p1', 'alive', 'r1') in left


class _Logged(flow.Helper):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.events = []

    def progress(self, pct, msg='', **extra):
        super().progress(pct, msg, **extra)
        self.events.append({**extra, 'message': msg})


def test_progress_events_carry_the_turn_so_far(monkeypatch):
    client = FakeClient()
    store = flow._seed(client)
    svc = flow._service()
    svc.kit = Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: 'found', tracer=TRACER)
    svc.cfg = ModelConfig(model='fake/model', stream=False)
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "1"}'), content='Looking.'),
        _calls(('c2', 'search', '{"q": "2"}'), content='Again.'),
        _reply('Done.')]))
    helper = _Logged()
    svc.process_request(flow._request(client), helper)
    assert not helper.errors, helper.errors
    traces = [e['trace'] for e in helper.events if 'trace' in e]
    last = traces[-1]
    assert [s['id'] for s in last] == ['c1', 'c2'] and all(s.get('stored') for s in last)
    assert [s.get('said') for s in last] == ['Looking.', 'Again.']
    # The text of a call is shown live until it moves onto its first step.
    assert not any(e.get('text') == 'Looking.' and e['trace'] for e in helper.events), 'never twice on screen'
    conv, _ = store.load('c1')
    item = conv['display'][-1]
    assert [s['id'] for s in item['steps']] == ['c1', 'c2'] and 'stored' not in item['steps'][0]
    assert [r['said'] for r in _rounds(client)] == ['Looking.', 'Again.']


def test_a_dead_turns_rounds_are_kept_until_the_conversation_goes(monkeypatch):
    # A turn whose service died leaves rounds no item names. They are not
    # swept while the conversation lives, and go with it.
    client = FakeClient()
    store = flow._seed(client)
    client.user_data.put('u@x', round_key('igt', 'p1', 'c1', 'r-dead'), {'n': 1})
    assert sweep_orphans(store, now=time.time() + 2 * ORPHAN_AGE_S) == 0
    store.delete('c1')
    assert not [k for (_u, k) in client.user_data.store if ':round:' in k]


def test_the_page_protocol_is_three():
    from plaid_agent.core.ops import RECORD_PROTOCOL
    assert RECORD_PROTOCOL == 3
    assert build_meta  # imported for the store helpers above
    assert TurnResult
    assert service_mod


def _tool_chunk(cid, args):
    tc = SimpleNamespace(index=0, id=cid, function=SimpleNamespace(name='search', arguments=args))
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None, tool_calls=[tc]),
                                                    finish_reason=None)])


def test_streamed_text_moves_onto_its_step_and_is_never_shown_twice(monkeypatch):
    client = FakeClient()
    flow._seed(client)
    svc = flow._service()
    svc.kit = Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: 'found', tracer=TRACER)
    svc.cfg = ModelConfig(model='fake/model')
    script = iter([[_chunk('Looking '), _chunk('first.'), _tool_chunk('c1', '{"q": "1"}')],
                   [_chunk('Then '), _chunk('again.'), _tool_chunk('c2', '{"q": "2"}')],
                   [_chunk('Done.')]])
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: iter(next(script)))
    helper = _Logged()
    svc.process_request(flow._request(client), helper)
    assert not helper.errors, helper.errors
    shown = [(e.get('text'), [s.get('said') for s in e.get('trace') or []]) for e in helper.events]
    # Live: the first call's text streams, then sits on its step while the
    # second call's streams below it.
    assert ('Looking first.', []) in shown
    assert ('Then again.', ['Looking first.']) in shown
    for text, saids in shown:
        assert not text or text not in saids, 'a text is on screen once'


# --- the model's reasoning (design/TRANSPARENCY.md D1) ---------------------------


def _thought_chunk(text):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None, reasoning_content=text),
                                                    finish_reason=None)])


def _with_reasoning(resp, reasoning):
    resp.choices[0].message.reasoning_content = reasoning
    return resp


def test_the_reasoning_is_kept_in_its_round_and_never_sent_back(monkeypatch):
    client = FakeClient()
    sent = []
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _with_reasoning(_calls(('c1', 'search', '{"q": "kai"}'), content='Looking.'), 'They asked about kai.'),
        _with_reasoning(_reply('Three.'), 'Three words came back.'),
    ], before=lambda kw: sent.append(kw['messages'])))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': '3 words'}), _ws(client), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    first, reply = _rounds(client)
    assert first['thinking'] == 'They asked about kai.' and turn.steps[0]['thought'] is True
    # The reply's reasoning is in a round of its own, which the item names.
    assert turn.reply_round == reply['id'] and turn.reply_thought is True
    assert reply['thinking'] == 'Three words came back.' and reply['calls'] == [] and 'asked' not in reply
    assert not any('reasoning_content' in m or 'thinking' in m for m in sent[1] + turn.messages)
    assert 'They asked' not in repr(sent[1]) and 'Three words came' not in repr(turn.messages)


def test_a_turn_without_reasoning_marks_no_step_and_stores_no_reply_round(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "kai"}')), _reply('ok')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), _ws(client), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    [rnd] = _rounds(client)
    assert 'thinking' not in rnd and 'thought' not in turn.steps[0]
    assert turn.reply_round is None and turn.reply_thought is False


def test_streamed_reasoning_is_kept_streamed_live_and_moves_onto_its_step(monkeypatch):
    client = FakeClient()
    store = flow._seed(client)
    svc = flow._service()
    svc.kit = Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: 'found', tracer=TRACER)
    svc.cfg = ModelConfig(model='fake/model')
    long = 'x' * (service_mod.THINKING_TAIL + 500)
    script = iter([[_thought_chunk('Pondering '), _thought_chunk('kai.'), _chunk('Looking.'),
                    _tool_chunk('c1', '{"q": "1"}')],
                   [_thought_chunk(long), _thought_chunk('end'), _chunk('Done.')]])
    sent = []

    def completion(**kw):
        sent.append(kw['messages'])
        return iter(next(script))
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    monkeypatch.setattr(agent.litellm, 'completion', completion)
    helper = _Logged()
    svc.process_request(flow._request(client), helper)
    assert not helper.errors, helper.errors
    shown = [(e.get('thinking'), [s.get('thought') for s in e.get('trace') or []]) for e in helper.events]
    # Live: the reasoning streams, then the step that holds it says so and
    # the live reasoning is gone, so it is never on screen twice.
    assert ('Pondering kai.', []) in shown
    # The line says the model is thinking until it writes.
    assert all(e['message'] != 'Writing…' for e in helper.events if e.get('thinking') and not e.get('text'))
    assert not any(t == 'Pondering kai.' and marks for t, marks in shown), 'the reasoning is on screen once'
    tails = [t for t, _ in shown if t and t.endswith('end')]
    assert tails and all(len(t) == service_mod.THINKING_TAIL for t in tails)
    first, reply = _rounds(client)
    assert first['thinking'] == 'Pondering kai.' and reply['thinking'] == long + 'end'
    assert not any('reasoning_content' in m for m in sent[1])
    conv, _ = store.load('c1')
    item = conv['display'][-1]
    assert item['steps'][0]['thought'] is True
    assert item['reply_round'] == reply['id'] and item['reply_thought'] is True
    assert 'Pondering' not in repr(conv['messages'])


def test_an_empty_reply_keeps_the_reasoning_of_both_calls(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _with_reasoning(_reply(''), 'Thought, wrote nothing.'),
        _with_reasoning(_reply('Here.'), 'Asked again.')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({}), _ws(client), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    [rnd] = _rounds(client)
    assert turn.text == 'Here.' and turn.reply_round == rnd['id'] and rnd['asked'] == 'hi'
    assert rnd['thinking'] == 'Thought, wrote nothing.\n\nAsked again.'


def test_a_round_over_the_cap_cuts_the_reasoning_first():
    rnd = {'id': 'r', 'n': 2, 'thinking': 'y' * 5000,
           'calls': [{'id': 'c1', 'name': 's', 'arguments': '{}', 'result': 'x' * 3000, 'chars': 3000}]}
    out = fit(rnd, 4000)
    from plaid_agent.core.conversation import _bytes
    assert _bytes(out) <= 4000 and out['fitted'] is True
    assert 'characters cut to fit the store' in out['thinking']
    assert out['calls'][0]['result'] == 'x' * 3000


# --- hunt round 13 ------------------------------------------------------------------


def test_the_reasoning_of_a_call_stopped_while_it_reasoned_is_kept_in_a_round_of_its_own(monkeypatch):
    """H13-TRACE-2: the reader watched it stream, so a stop does not lose it.
    A stop in the first call keeps the question as received too."""
    client = FakeClient()
    stop = {'now': False}

    def stream():
        yield _thought_chunk('Weighing ')
        yield _thought_chunk('the glosses.')
        yield _chunk('Half')
        time.sleep(0.3)
        stop['now'] = True
        time.sleep(2)
        yield _chunk(' more')
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: stream())
    with pytest.raises(TurnCancelled) as e:
        run_turn(ModelConfig(model='fake/m'), _kit({}), _ws(client), 'system',
                 [{'role': 'user', 'content': 'hi'}], cancelled=lambda: stop['now'])
    [rnd] = _rounds(client)
    assert agent.turn_reply_round(e.value) == rnd['id']
    assert rnd['thinking'] == 'Weighing the glosses.' and rnd['said'] == 'Half' and rnd['asked'] == 'hi'
    from plaid_agent.core.conversation import error_item
    item = error_item('Stopped.', stopped=True, reply_round=agent.turn_reply_round(e.value))
    assert item['reply_round'] == rnd['id'] and item['reply_thought'] is True


def test_a_failure_after_a_round_keeps_the_reasoning_of_the_call_under_way(monkeypatch):
    client = FakeClient()
    calls = iter([_with_reasoning(_calls(('c1', 'search', '{"q": "kai"}')), 'First.')])

    def completion(**kw):
        nxt = next(calls, None)
        if nxt is not None:
            return nxt
        raise RuntimeError('down')
    monkeypatch.setattr(agent.litellm, 'completion', completion)
    ws = _ws(client)
    with pytest.raises(RuntimeError) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), ws, 'system',
                 [{'role': 'user', 'content': 'hi'}])
    # No reasoning came for the failed call: nothing more is stored.
    assert len(_rounds(client)) == 1 and agent.turn_reply_round(e.value) is None


def test_a_bare_think_tag_is_no_reasoning(monkeypatch):
    """H13-PANEL-4: llama-server's Qwen sends `<think>` as the reasoning of a
    call that did not reason. It is not stored and the step has no Thinking."""
    client = FakeClient()
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _with_reasoning(_calls(('c1', 'search', '{"q": "kai"}')), '<think>'),
        _with_reasoning(_reply('Done.'), '<think>\nReal thought.\n</think>')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit({'kai': 'a'}), _ws(client), 'system',
                    [{'role': 'user', 'content': 'hi'}])
    first, reply = _rounds(client)
    assert 'thinking' not in first and not turn.steps[0].get('thought')
    assert reply['thinking'] == 'Real thought.'
    assert agent.clean_reasoning(' \n<think></think> ') is None


def test_cut_comes_from_the_cut_not_from_the_words(monkeypatch):
    """H13-TRACE-4: a result that only mentions truncation is not cut, and one
    `truncate` cut is."""
    from plaid_agent.core.limits import MAX_RESULT_CHARS
    from plaid_agent.core.tools import truncate
    client = FakeClient()
    answers = {'odd': 'short\n... [truncated: 3 more characters; narrow the request]',
               'long': lambda: truncate('x' * (MAX_RESULT_CHARS + 10))}
    kit = Toolkit(tools_for=lambda ws: [],
                  call_tool=lambda ws, n, a: (lambda v: v() if callable(v) else v)(answers[a['q']]), tracer=TRACER)
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'search', '{"q": "odd"}'), ('c2', 'search', '{"q": "long"}')), _reply('ok')]))
    run_turn(ModelConfig(model='fake/m', stream=False), kit, _ws(client), 'system',
             [{'role': 'user', 'content': 'hi'}])
    [rnd] = _rounds(client)
    odd, long = rnd['calls']
    assert 'cut' not in odd and long['cut'] is True


def test_a_round_write_waiting_out_the_server_gives_up_when_the_turn_is_stopped(monkeypatch):
    """H13-TRACE-6: Stop took minutes while a round write waited out 503s."""
    from plaid_agent.core import conversation as conv_mod
    client = FakeClient()
    stop = {'now': False}
    tries = []

    def away(*a, **k):
        tries.append(1)
        stop['now'] = True
        raise PlaidAPIError('HTTP 503', status=503)
    monkeypatch.setattr(conv_mod, '_pause', lambda s: None)
    ws = _ws(client)
    ws.rounds.cancelled = lambda: stop['now']
    monkeypatch.setattr(client.user_data, 'put', away)
    assert ws.rounds.store({'id': 'r1', 'n': 2, 'calls': []}) is False
    assert len(tries) == 1


def test_the_prompt_write_of_a_first_round_gives_up_when_the_turn_is_stopped(monkeypatch):
    """H13-TRACE-6 review: the first round writes the prompt before itself,
    and that write waited the server out whatever the stop said."""
    from plaid_agent.core import conversation as conv_mod
    client = FakeClient()
    stop = {'now': False}
    tries = []

    def away(*a, **k):
        tries.append(1)
        stop['now'] = True
        raise PlaidAPIError('HTTP 503', status=503)
    monkeypatch.setattr(conv_mod, '_pause', lambda s: None)
    ws = _ws(client, system='sys', tools=[])
    ws.rounds.cancelled = lambda: stop['now']
    monkeypatch.setattr(client.user_data, 'put', away)
    assert ws.rounds.store({'id': 'r1', 'n': 1, 'calls': []}) is False
    assert len(tries) == 2, 'the prompt once, the round once'


def test_a_plan_call_that_planned_nothing_says_so(monkeypatch):
    """H13-PANEL-3: never "Planned" over a call that left the plan as it was."""
    from plaid_agent.core.trace import PLAN
    tracer = Tracer(kind=lambda n: PLAN, describe=lambda n, a: f'Planned replacing {a["q"]}',
                    progress=lambda n, a: 'Planning…')

    class PlanWs(Ws):
        def __init__(self):
            self.ops = []

    def call(ws, name, args):
        if args['q'] == 'hit':
            ws.ops.append({'kind': 'set', 'v': 1})
            return 'Planned 1 change.'
        return 'Nothing to change: no Gloss values matched.'
    client = FakeClient()
    ws = PlanWs()
    ws.rounds = RoundKeeper(_store(client), 'c1')
    monkeypatch.setattr(agent.litellm, 'completion', _model([
        _calls(('c1', 'replace', '{"q": "miss"}'), ('c2', 'replace', '{"q": "hit"}')), _reply('ok')]))
    turn = run_turn(ModelConfig(model='fake/m', stream=False),
                    Toolkit(tools_for=lambda ws: [], call_tool=call, tracer=tracer), ws, 'system',
                    [{'role': 'user', 'content': 'hi'}])
    miss, hit = turn.steps
    assert miss['label'] == 'Nothing to change: replacing miss' and miss['nothing'] is True
    assert hit['label'] == 'Planned replacing hit' and 'nothing' not in hit and hit['planned'] == 1


def test_a_request_refused_as_too_long_is_asked_again_on_a_transcript_held_to_the_window_it_named(monkeypatch):
    """H13-PANEL-1: the window is learned from the refusal, kept for the
    process, and the call asked once more with older results dropped."""
    monkeypatch.setattr(agent, '_learned', {})
    client = FakeClient()
    refusal = agent.litellm.ContextWindowExceededError(
        'request (65646 tokens) exceeds the available context size (65536 tokens)', model='x', llm_provider='openai')
    sent = []
    monkeypatch.setattr(agent.litellm, 'completion', _model([refusal, _reply('Fits now.')],
                                                            before=lambda kw: sent.append(kw['messages'])))
    ws = _ws(client)
    seen = {}

    def shrink(history, new):
        seen['window'] = agent.context_window('fake/unknown-model')
        return [m for m in history if m['role'] != 'tool']
    ws.shrink = shrink
    history = [{'role': 'user', 'content': 'q'},
               {'role': 'assistant', 'content': None,
                'tool_calls': [{'id': 't', 'type': 'function', 'function': {'name': 's', 'arguments': '{}'}}]},
               {'role': 'tool', 'tool_call_id': 't', 'content': 'x' * 100}, {'role': 'user', 'content': 'next'}]
    turn = run_turn(ModelConfig(model='fake/unknown-model', stream=False), _kit({}), ws, 'system', history)
    assert turn.text == 'Fits now.' and seen['window'] == 65536
    assert any(m['role'] == 'tool' for m in sent[0]) and not any(m['role'] == 'tool' for m in sent[1])
    assert agent.context_window('fake/unknown-model', 131072) == 65536, 'the learned window wins when smaller'


def test_a_request_still_too_long_after_the_one_retry_fails_with_the_line(monkeypatch):
    monkeypatch.setattr(agent, '_learned', {})
    client = FakeClient()
    refusal = lambda: agent.litellm.ContextWindowExceededError('too long', model='x', llm_provider='openai')  # noqa: E731
    monkeypatch.setattr(agent.litellm, 'completion', _model([refusal(), refusal()]))
    ws = _ws(client)
    ws.shrink = lambda history, new: history[-1:]
    with pytest.raises(Exception) as e:
        run_turn(ModelConfig(model='fake/m2', stream=False), _kit({}), ws, 'system',
                 [{'role': 'user', 'content': 'a'}, {'role': 'user', 'content': 'b'}])
    assert agent.model_failure_line(e.value) == agent.TOO_LONG_LINE
    # Named no window and none was known: half of nothing is nothing to go on.
    assert agent.context_window('fake/m2') is None


def test_learn_window_reads_the_figure_each_provider_names(monkeypatch):
    monkeypatch.setattr(agent, '_learned', {})
    for text, n in (('request (65646 tokens) exceeds the available context size (65536 tokens)', 65536),
                    ("This model's maximum context length is 8192 tokens. However, you requested 9000", 8192),
                    ('prompt is too long: 210000 tokens > 200000 maximum', 200000)):
        monkeypatch.setattr(agent, '_learned', {})
        assert agent.learn_window('m', RuntimeError(text)) == n
    monkeypatch.setattr(agent, '_learned', {})
    assert agent.learn_window('m', RuntimeError('too long'), sent=10_000) is None, 'no window known'
    assert agent.learn_window('m', RuntimeError('too long'), sent=10_000, stated=65536) == 32768


def test_unnamed_refusals_do_not_wear_the_window_down(monkeypatch):
    """A refusal that names no window halves the known one once. Again and
    again it never halves the learned one, which would leave every later
    conversation of the process a window no system prompt fits in."""
    monkeypatch.setattr(agent, '_learned', {})
    for _ in range(5):
        agent.learn_window('m', RuntimeError('too long'), stated=65536)
    assert agent.context_window('m', 65536) == 32768
    monkeypatch.setattr(agent, '_learned', {})
    for _ in range(5):
        agent.learn_window('openai/gpt-4o', RuntimeError('too long'))
    assert agent.context_window('openai/gpt-4o') == agent._library_window('openai/gpt-4o') // 2


def test_an_unnamed_refusal_of_more_than_the_known_window_teaches_nothing(monkeypatch):
    """The turn's own reads grew past the known window: it is not smaller."""
    monkeypatch.setattr(agent, '_learned', {})
    assert agent.learn_window('m', RuntimeError('too long'), sent=70_000, stated=65536) is None
    assert agent.context_window('m', 65536) == 65536
    # The loop passes what it sent and the operator's window.
    client = FakeClient()
    refusal = lambda: agent.litellm.ContextWindowExceededError('too long', model='x', llm_provider='openai')  # noqa: E731
    monkeypatch.setattr(agent.litellm, 'completion', _model([refusal(), refusal()]))
    ws = _ws(client)
    ws.shrink = lambda history, new: history[-1:]
    with pytest.raises(Exception):
        run_turn(ModelConfig(model='fake/m3', stream=False, context_window=65536), _kit({}), ws, 'system',
                 [{'role': 'user', 'content': 'a'}, {'role': 'user', 'content': 'b'}])
    assert agent.context_window('fake/m3', 65536) == 32768, 'a tiny request refused: halved once, by the known window'


@require_sandbox()
def test_what_the_codes_own_reads_cut_is_forgotten_on_every_way_out():
    """H13-TRACE-4 review: a read inside run_code that was cut for the code
    marked the step cut when the code then failed or printed nothing."""
    from plaid_agent.core import limits, sandbox
    from plaid_agent.core.tools import truncate
    session = sandbox.Session()
    api = {'big': lambda: truncate('x' * 20000)}
    try:
        for code in ("t = big()\nraise ValueError('boom')", 't = big()\nNone', 't = big()\nprint(len(t))'):
            before = limits.cuts()
            try:
                sandbox.run(code, api, session=session)
            except sandbox.CodeError:
                pass
            assert limits.cuts() == before, code
        before = limits.cuts()
        sandbox.run("print('y' * 20000)", api, session=session)
        assert limits.cuts() == before + 1, 'the output the model is sent, cut, still counts'
    finally:
        session.close()
