"""Each model call of a turn (a round) is stored beside the conversation:
what the model wrote beside its tool calls, each call's whole arguments and
its result exactly as the model was sent it, and the question as received on
the first (design/TRANSPARENCY.md). The record keeps only the steps' round
ids, the text between calls (``said``) and what each call read."""

import time
from types import SimpleNamespace

import pytest

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
        self.events.append(extra)


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
