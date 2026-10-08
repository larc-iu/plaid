"""How a turn ends when the model or a tool will not cooperate.

Each of these was seen on screen in the 2026-09-28 UMR round (V7 F4, F7, F8):
a refused plan call counted and labelled as planned, an unreadable completion
shown as an ordinary "(The model returned an empty reply.)" answer with no
Retry, fifty rounds of the same invalid tool call, and a provider's raw
exception text ("litellm.InternalServerError: ...") in the record.
"""

from types import SimpleNamespace

import pytest

from plaid_agent.core import agent
from plaid_agent.core import service as service_mod
from plaid_client.workflows import llm
from plaid_agent.core.agent import (EMPTY_REPLY, ModelConfig, Toolkit, TurnFailed, model_failure_line,
                                    run_turn)
from plaid_agent.core.trace import PLAN, READ, Tracer, summarize_steps, trace_step


def _call(i, name, arguments):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments=arguments))


def _resp(content=None, calls=None, finish='stop'):
    msg = SimpleNamespace(content=content, tool_calls=calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=finish)], usage=None)


class Script:
    """The model, one scripted response per call, the last one repeated."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = 0

    def __call__(self, **kwargs):
        self.calls += 1
        return self.responses[min(self.calls, len(self.responses)) - 1]


class Ws:
    def __init__(self):
        self.ops = []


def _kit(call_tool):
    tracer = Tracer(kind=lambda n: PLAN if n.startswith('plan') else READ,
                    describe=lambda n, a: f'Planned {a.get("what", "x")}' if n.startswith('plan') else 'Looked',
                    progress=lambda n, a: 'Working…')
    return Toolkit(tools_for=lambda ws: [], call_tool=call_tool, tracer=tracer)


def _turn(monkeypatch, script, call_tool=lambda ws, n, a: 'ok', ws=None, **cfg):
    monkeypatch.setattr(agent.litellm, 'completion', script)
    return run_turn(ModelConfig(model='fake/m', stream=False, **cfg), _kit(call_tool), ws or Ws(),
                    'system', [{'role': 'user', 'content': 'hi'}])


# --- F4: a refused plan call ----------------------------------------------------

def test_a_refused_plan_call_is_marked_failed_and_left_out_of_the_count(monkeypatch):
    def call_tool(ws, name, args):
        if args.get('what') == 'bad':
            return 'Error: s99: document "d" has 12 sentences'
        ws.ops.append({'kind': 'x'})
        return 'Planned.'

    script = Script(_resp(calls=[_call(1, 'plan_a', '{"what": "bad"}'),
                                 _call(2, 'plan_a', '{"what": "good"}')]),
                    _resp('Done.'))
    turn = _turn(monkeypatch, script, call_tool)
    bad, good = turn.steps
    assert bad == {'id': 'c1', 'name': 'plan_a', 'kind': PLAN, 'label': 'Could not plan bad', 'failed': True}
    assert good['label'] == 'Planned good' and 'failed' not in good
    assert turn.summary == '1 planned change · 2 steps'


def test_a_failed_step_keeps_a_reads_own_line_and_is_not_counted():
    tracer = Tracer(kind=lambda n: 'document', describe=lambda n, a: 'Read “Text 9”', progress=lambda n, a: '')
    step = trace_step(tracer, 'c1', 'read_document', {'document': 'Text 9'}, failed=True)
    assert step['label'] == 'Read “Text 9”' and step['failed'] and 'document' not in step
    assert summarize_steps([step]) == '1 step'


# --- F8: empty replies and a call repeated after it failed ----------------------

def test_a_second_empty_reply_is_a_failed_turn(monkeypatch):
    script = Script(_resp(''), _resp(''))
    with pytest.raises(TurnFailed, match=EMPTY_REPLY):
        _turn(monkeypatch, script)
    assert script.calls == 2, 'asked once more for the reply, then gave up'


def test_an_empty_reply_after_a_plan_keeps_the_plan(monkeypatch):
    """The plan is the substance of that turn and its card shows it, so the
    missing words do not throw it away."""
    def call_tool(ws, name, args):
        ws.ops.append({'kind': 'x'})
        return 'Planned.'

    script = Script(_resp(calls=[_call(1, 'plan_a', '{}')]), _resp(''), _resp(''))
    turn = _turn(monkeypatch, script, call_tool)
    assert turn.text == f'({EMPTY_REPLY})'


def test_the_same_failing_call_three_times_ends_the_turn(monkeypatch):
    script = Script(*([_resp(calls=[_call(i, 'plan_a', '{"what": ')]) for i in range(3)]
                      + [_resp('I could not write that change.')]))
    turn = _turn(monkeypatch, script)
    assert script.calls == 4, 'three rounds and the reply, not fifty rounds'
    assert turn.text.startswith('I could not write that change.')
    assert turn.text.endswith('*(Stopped after the same step failed 3 times.)*')
    assert all(s['failed'] for s in turn.steps)


def test_a_failing_call_that_changes_its_arguments_is_not_a_repeat(monkeypatch):
    def call_tool(ws, name, args):
        return 'Error: no such node'

    script = Script(*([_resp(calls=[_call(i, 'plan_a', f'{{"what": "v{i}"}}')]) for i in range(4)]
                      + [_resp('Gave up.')]))
    turn = _turn(monkeypatch, script, call_tool)
    assert script.calls == 5 and turn.text == 'Gave up.'


def test_the_step_limit_is_said_without_the_operators_flag(monkeypatch):
    script = Script(_resp(calls=[_call(1, 'read', '{}')]), _resp(calls=[_call(2, 'read', '{}')]),
                    _resp('Here is what I found.'))
    turn = _turn(monkeypatch, script, max_steps=2)
    assert turn.text == 'Here is what I found.\n\n*(Stopped at the step limit.)*'
    assert '--max-steps' not in turn.text


def test_a_cut_off_reply_does_not_name_the_operators_flag(monkeypatch):
    turn = _turn(monkeypatch, Script(_resp('Half a', finish='length')))
    assert turn.text == "Half a\n\n*(The reply was cut off at the model's output limit.)*"


# --- the operator's timeout reaches every model call ----------------------------

def test_every_model_call_carries_the_operators_timeout(monkeypatch):
    seen = []
    script = Script(_resp(calls=[_call(1, 'read', '{}')]), _resp(''), _resp('ok'))

    def spy(**kwargs):
        seen.append((kwargs.get('timeout'), kwargs.get('max_retries')))
        return script(**kwargs)

    _turn(monkeypatch, spy, timeout=120)
    assert seen == [(120, 0)] * 3, 'the SDK retries a timeout twice on its own unless told'


def _no_waiting(monkeypatch):
    monkeypatch.setattr(agent.time, 'sleep', lambda s: None)
    monkeypatch.setattr(llm.random, 'uniform', lambda a, b: 0.0)


def test_a_timed_out_call_is_tried_once_more_by_the_loop_and_no_more(monkeypatch):
    """Measured on a slow endpoint before the fix: the SDK's own retry made the
    second request, unseen. Now the SDK makes none and the loop makes one, as
    the model services do (plaid_client.workflows.llm)."""
    _no_waiting(monkeypatch)
    calls = []

    def slow(**kwargs):
        calls.append(kwargs.get('max_retries'))
        raise agent.litellm.Timeout('Request timed out.', model='x', llm_provider='openai')

    monkeypatch.setattr(agent.litellm, 'completion', slow)
    with pytest.raises(agent.litellm.Timeout):
        run_turn(ModelConfig(model='fake/m', timeout=5, stream=False), _kit(lambda ws, n, a: 'ok'), Ws(),
                 'system', [{'role': 'user', 'content': 'hi'}])
    assert calls == [0, 0]


def test_a_rate_limit_is_waited_out_and_the_turn_goes_on(monkeypatch):
    _no_waiting(monkeypatch)
    replies = iter([agent.litellm.RateLimitError('slow down', model='x', llm_provider='openai'),
                    agent.litellm.InternalServerError('busy', model='x', llm_provider='openai'),
                    _resp('ok')])

    def flaky(**kwargs):
        r = next(replies)
        if isinstance(r, Exception):
            raise r
        return r

    turn = _turn(monkeypatch, flaky)
    assert turn.text == 'ok'


def test_a_provider_that_stays_down_is_tried_a_bounded_number_of_times(monkeypatch):
    _no_waiting(monkeypatch)
    calls = []

    def down(**kwargs):
        calls.append(kwargs.get('stream'))
        raise agent.litellm.InternalServerError('down', model='x', llm_provider='openai')

    monkeypatch.setattr(agent.litellm, 'completion', down)
    with pytest.raises(agent.litellm.InternalServerError):
        run_turn(ModelConfig(model='fake/m'), _kit(lambda ws, n, a: 'ok'), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}])
    assert calls == [True] * (agent.RETRIES + 1), 'streamed each time, never re-asked unstreamed at once'


def test_a_stop_while_waiting_to_retry_ends_the_turn(monkeypatch):
    _no_waiting(monkeypatch)
    stop = {'now': False}
    calls = []

    def limited(**kwargs):
        calls.append(1)
        stop['now'] = True
        raise agent.litellm.RateLimitError('slow down', model='x', llm_provider='openai')

    monkeypatch.setattr(agent.litellm, 'completion', limited)
    with pytest.raises(agent.TurnCancelled):
        run_turn(ModelConfig(model='fake/m', stream=False), _kit(lambda ws, n, a: 'ok'), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}], cancelled=lambda: stop['now'])
    assert calls == [1]


def test_the_model_description_leaves_the_endpoint_out():
    cfg = ModelConfig(model='openai/gpt-oss-120b', api_base='http://gpu-internal:8000/v1', api_key='sk-x')
    assert cfg.describe() == {'model': 'openai/gpt-oss-120b'}


def test_an_unknown_tool_is_a_failed_step_in_every_app():
    """A model that keeps calling a tool that does not exist is repeating a
    failing call, and the turn stops after three as it does for any other."""
    from plaid_agent.igt import toolkit as igt
    from plaid_agent.ud import toolkit as ud
    from plaid_agent.umr import toolkit as umr
    for kit in (igt, ud, umr):
        assert kit.call_tool(None, 'delete_everything', {}).startswith('Error'), kit.__name__


def test_a_streamed_call_that_times_out_is_not_asked_again_without_streaming(monkeypatch):
    calls = []

    def slow(**kwargs):
        calls.append(kwargs.get('stream'))
        raise agent.litellm.Timeout('Request timed out.', model='x', llm_provider='openai')

    monkeypatch.setattr(agent.litellm, 'completion', slow)
    with pytest.raises(agent.litellm.Timeout):
        run_turn(ModelConfig(model='fake/m', timeout=5), _kit(lambda ws, n, a: 'ok'), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}])
    assert calls == [True, True], 'the one retry streams again, and nothing is asked unstreamed'


def test_no_timeout_is_sent_when_the_operator_gave_none(monkeypatch):
    seen = []

    def spy(**kwargs):
        seen.append('timeout' in kwargs)
        return _resp('ok')

    _turn(monkeypatch, spy)
    assert seen == [False]


# --- F7: what a failed turn says ------------------------------------------------

def _provider_errors():
    llm = agent.litellm
    return {
        'timeout': llm.Timeout('Request timed out.', model='x', llm_provider='openai'),
        'server': llm.InternalServerError('OpenAIException - upstream exploded at http://gpu:8000/v1 '
                                          'with key sk-secret-123456', model='x', llm_provider='openai'),
        'connection': llm.APIConnectionError('Connection error.', model='x', llm_provider='openai'),
        'window': llm.ContextWindowExceededError('too long', model='x', llm_provider='openai'),
    }


def test_a_provider_failure_is_one_plain_line():
    errors = _provider_errors()
    assert model_failure_line(errors['timeout']) == 'The model did not answer in time.'
    assert model_failure_line(errors['server']) == 'The model could not answer.'
    assert model_failure_line(errors['connection']) == 'The model could not answer.'
    assert model_failure_line(errors['window']) == 'The conversation is too long for the model.'
    assert model_failure_line(RuntimeError('a bug')) is None


def test_the_record_never_quotes_the_provider(monkeypatch):
    from test_service_flow import Helper, _request, _seed, _service
    from fixtures import FakeClient

    for name, error in _provider_errors().items():
        client = FakeClient()
        store = _seed(client)

        def boom(*a, **k):
            raise error

        monkeypatch.setattr(service_mod, 'run_turn', boom)
        helper = Helper()
        svc = _service()
        svc.REQUEST_SECRETS = ('sk-secret-123456',)
        svc.process_request(_request(client), helper)
        conv, meta = store.load('c1')
        shown = conv['display'][-1]['text']
        assert shown == helper.errors[0], name
        for leak in ('litellm', 'OpenAIException', 'http://', 'sk-secret'):
            assert leak not in shown, (name, shown)
        assert meta['pending'] is None


def test_any_other_failure_is_redacted(monkeypatch):
    from test_service_flow import Helper, _request, _seed, _service
    from fixtures import FakeClient

    client = FakeClient()
    store = _seed(client)

    def boom(*a, **k):
        raise RuntimeError('refused at http://internal:8085/api/v1/x with sk-secret-123456')

    monkeypatch.setattr(service_mod, 'run_turn', boom)
    helper = Helper()
    svc = _service()
    svc.REQUEST_SECRETS = ('sk-secret-123456',)
    svc.process_request(_request(client), helper)
    shown = store.load('c1')[0]['display'][-1]['text']
    assert shown.startswith('The assistant could not answer: refused')
    assert 'http://' not in shown and 'sk-secret' not in shown


def test_an_empty_reply_is_a_failed_turn_with_its_own_line(monkeypatch):
    from test_service_flow import Helper, _request, _seed, _service
    from fixtures import FakeClient

    client = FakeClient()
    store = _seed(client)

    def empty(*a, **k):
        raise TurnFailed(EMPTY_REPLY)

    monkeypatch.setattr(service_mod, 'run_turn', empty)
    helper = Helper()
    _service().process_request(_request(client), helper)
    conv, _meta = store.load('c1')
    item = dict(conv['display'][-1])
    assert item.pop('created_at')
    assert item == {'kind': 'error', 'text': EMPTY_REPLY, 'model': 'fake/model',
                    'version': _service().version, 'service': 'igt:assist:fake'}
    assert [m['role'] for m in conv['messages']] == ['user'], 'the question stays for the next turn to read'


# --- H38: a successful plan call repeated word for word -------------------------

def test_a_plan_call_repeated_to_no_effect_is_not_staged_again_and_ends_the_turn(monkeypatch):
    """One turn staged the same set_field seven times, each superseding the
    last. The second identical call that leaves the plan as it was answers
    that nothing was staged again, and the guard counts it as it counts a
    repeated failure."""
    def call_tool(ws, name, args):
        ws.ops[:] = [o for o in ws.ops if o != {'kind': 'x', **args}] + [{'kind': 'x', **args}]
        return 'Planned. 1 earlier planned change on the same target superseded.'

    same = '{"what": "a", "n": 1}'
    script = Script(*([_resp(calls=[_call(1, 'plan_a', same)]), _resp(calls=[_call(2, 'plan_b', '{}')])]
                      + [_resp(calls=[_call(i, 'plan_a', '{"n": 1,  "what": "a"}')]) for i in range(3, 6)]
                      + [_resp('Planned it.')]))
    ws = Ws()
    turn = _turn(monkeypatch, script, call_tool, ws=ws)
    assert script.calls == 6, 'the first call, another, three repeats, and the reply'
    assert turn.text == 'Planned it.\n\n*(Stopped after the same step was repeated 3 times.)*'
    results = [m['content'] for m in turn.messages if m.get('role') == 'tool']
    assert results[:2] == ['Planned. 1 earlier planned change on the same target superseded.'] * 2
    assert results[2:] == [agent.ALREADY_PLANNED] * 3
    assert len(ws.ops) == 2 and not any(s.get('failed') for s in turn.steps)


def test_the_same_plan_call_after_the_plan_changed_is_staged_again(monkeypatch):
    """Planning a value, then another over it, then the first again is a
    change of mind, not a loop."""
    def call_tool(ws, name, args):
        ws.ops[:] = [{'kind': 'x', **args}]
        return 'Planned.'

    script = Script(_resp(calls=[_call(1, 'plan_a', '{"v": 1}')]), _resp(calls=[_call(2, 'plan_a', '{"v": 2}')]),
                    _resp(calls=[_call(3, 'plan_a', '{"v": 1}')]), _resp('Done.'))
    ws = Ws()
    turn = _turn(monkeypatch, script, call_tool, ws=ws)
    assert turn.text == 'Done.' and ws.ops == [{'kind': 'x', 'v': 1}]
    assert agent.ALREADY_PLANNED not in [m['content'] for m in turn.messages if m.get('role') == 'tool']


def test_a_read_repeated_is_not_a_plan_repeat(monkeypatch):
    script = Script(*([_resp(calls=[_call(i, 'read', '{}')]) for i in range(4)] + [_resp('Found it.')]))
    turn = _turn(monkeypatch, script)
    assert turn.text == 'Found it.'


def test_a_step_names_the_files_its_call_saved(monkeypatch):
    # The summary counts a run of code that saved a file as the saving, which
    # it can only do if the step says what its call saved.
    ws = Ws()
    ws.keeper = SimpleNamespace(saved=['earlier.csv'])

    def tool(w, name, args):
        if args.get('save'):
            w.keeper.saved.append('words.csv')
        return 'ok'
    script = Script(_resp(calls=[_call(1, 'run_code', '{"save": true}'), _call(2, 'run_code', '{}')]),
                    _resp('Done.'))
    result = _turn(monkeypatch, script, tool, ws=ws)
    assert [s.get('saved') for s in result.steps] == [['words.csv'], None]
    assert result.summary == '1 search · saved 1 file · 2 steps'
