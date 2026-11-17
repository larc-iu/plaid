"""A chat turn whose model call fails after tools have run (survey
2026-11-17 item 1: four of seven turns ended "The model could not answer."
after 35 s to 4.5 min of tool work, all of it thrown away).

- The failed call is tried once more with the turn's steps kept, for a fixed
  list of failures by class (`agent.passes_again`). The trace has a step for
  it. A second failure ends the turn.
- Not tried again: a failure before any tool ran (nothing is lost), the
  product's own endings (output limit, repeat guard, empty reply), a request
  the provider refused as such, a stop, and any call of a job (its pieces and
  planning have their own handling, fixes/SP.md).
- The line of a turn that ends this way says the fact, and never quotes the
  provider.
- The steps of a failed turn stay in the model transcript, so "continue"
  reads what the turn did, and Retry takes them off with the question.
"""

from types import SimpleNamespace

import pytest

from plaid_agent.core import agent
from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import (META, ModelConfig, RETRY_LABEL, Toolkit, TurnCancelled, TurnFailed, cut_line,
                                    failed_turn_messages, model_failure_line, passes_again, run_turn, turn_messages,
                                    turn_trace)
from plaid_agent.core.conversation import rewind_for_retry
from plaid_agent.core.trace import PLAN, READ, Tracer

litellm = agent.litellm


def _call(i, name, arguments='{}'):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments=arguments))


def _resp(content=None, calls=None, finish='stop'):
    msg = SimpleNamespace(content=content, tool_calls=calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=finish)], usage=None)


def _errors():
    kw = dict(model='x', llm_provider='openai')
    return {
        'busy': litellm.RateLimitError('No deployments available', **kw),
        'timeout': litellm.Timeout('Request timed out.', **kw),
        'unavailable': litellm.ServiceUnavailableError('down', **kw),
        'server': litellm.InternalServerError('OpenAIException - upstream exploded at http://gpu:8000/v1', **kw),
        'connection': litellm.APIConnectionError('Connection error.', **kw),
        'gateway': litellm.BadGatewayError('502 Bad Gateway', **kw),
        'api': litellm.APIError(500, 'unmapped provider error', **kw),
    }


def _refusals():
    kw = dict(model='x', llm_provider='openai')
    return {
        'bad request': litellm.BadRequestError('malformed transcript', **kw),
        'key': litellm.AuthenticationError('bad key', **kw),
        'policy': litellm.ContentPolicyViolationError('refused', **kw),
        'cap': TurnFailed(cut_line(32768)),
        'repeating': TurnFailed(agent.REPEATING_LINE),
        'bug': RuntimeError('a bug'),
    }


class Model:
    """``_complete`` scripted: each entry an exception to raise or a response."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = 0

    def __call__(self, cfg, kwargs, on_text, cancelled=None, on_thinking=None, on_busy=None, **ladder):
        self.calls += 1
        out = self.script[min(self.calls, len(self.script)) - 1]
        if isinstance(out, BaseException):
            raise out
        return out


class Ws:
    def __init__(self):
        self.ops = []


def _kit():
    tracer = Tracer(kind=lambda n: PLAN if n.startswith('plan') else READ, describe=lambda n, a: 'Looked',
                    progress=lambda n, a: 'Looking…')
    return Toolkit(tools_for=lambda ws: [], call_tool=lambda ws, n, a: 'found 3', tracer=tracer)


def _turn(monkeypatch, model, pace=None, **cfg):
    monkeypatch.setattr(agent, '_complete', model)
    return run_turn(ModelConfig(model='fake/m', stream=False, **cfg), _kit(), Ws(), 'system',
                    [{'role': 'user', 'content': 'hi'}], pace=pace)


READ_ONCE = _resp(calls=[_call(1, 'read_a')])


@pytest.mark.parametrize('name', sorted(_errors()))
def test_a_service_failure_after_a_tool_ran_is_tried_once_more_and_the_steps_stay(monkeypatch, name):
    model = Model(READ_ONCE, _errors()[name], _resp('Three.'))
    turn = _turn(monkeypatch, model)
    assert turn.text == 'Three.' and model.calls == 3
    read, again = turn.steps
    assert read['label'] == 'Looked'
    assert again['kind'] == META and again['label'] == RETRY_LABEL == \
        'Asked the model again: the model service did not answer'
    assert set(again) == {'id', 'name', 'kind', 'label'}, "the provider's words go to the operator's log only"
    for leak in ('litellm', 'OpenAIException', 'http://', 'No deployments'):
        assert leak not in str(again)
    assert passes_again(_errors()[name])


def test_a_second_failure_ends_the_turn_with_its_steps_and_messages(monkeypatch):
    err = _errors()['server']
    model = Model(READ_ONCE, err, err, _resp('never'))
    with pytest.raises(litellm.InternalServerError) as e:
        _turn(monkeypatch, model)
    assert model.calls == 3
    steps, _partial = turn_trace(e.value)
    assert [s['label'] for s in steps] == ['Looked', RETRY_LABEL]
    kept = turn_messages(e.value)
    assert [m['role'] for m in kept] == ['assistant', 'tool']
    assert kept[1]['content'].startswith('found 3')


def test_each_call_gets_its_own_one_more_try(monkeypatch):
    err = _errors()['connection']
    model = Model(READ_ONCE, err, _resp(calls=[_call(2, 'read_a')]), err, _resp('Done.'))
    turn = _turn(monkeypatch, model)
    assert turn.text == 'Done.' and model.calls == 5
    assert [s['label'] for s in turn.steps] == ['Looked', RETRY_LABEL, 'Looked', RETRY_LABEL]


def test_a_failure_before_any_tool_ran_is_not_tried_again(monkeypatch):
    model = Model(_errors()['server'], _resp('never'))
    with pytest.raises(litellm.InternalServerError):
        _turn(monkeypatch, model)
    assert model.calls == 1


@pytest.mark.parametrize('name', sorted(_refusals()))
def test_the_products_own_endings_and_refused_requests_are_not_tried_again(monkeypatch, name):
    err = _refusals()[name]
    assert not passes_again(err)
    model = Model(READ_ONCE, err, _resp('never'))
    with pytest.raises(type(err)):
        _turn(monkeypatch, model)
    assert model.calls == 2


def test_a_stop_is_not_tried_again(monkeypatch):
    model = Model(READ_ONCE, TurnCancelled(), _resp('never'))
    with pytest.raises(TurnCancelled):
        _turn(monkeypatch, model)
    assert model.calls == 2 and not passes_again(TurnCancelled())


def test_a_jobs_call_is_not_tried_again(monkeypatch):
    """A job's pieces and planning keep their own handling (fixes/SP.md)."""
    pace = SimpleNamespace(note=lambda rounds, kwargs: None, sending=lambda kwargs: None, cut=lambda at: None)
    model = Model(READ_ONCE, _errors()['server'], _resp('never'))
    with pytest.raises(litellm.InternalServerError):
        _turn(monkeypatch, model, pace=pace)
    assert model.calls == 2


# --- what the person reads --------------------------------------------------------

def test_the_lines_say_the_service_did_not_answer():
    errors = _errors()
    assert model_failure_line(errors['server']) == 'The model service did not answer.'
    assert model_failure_line(errors['gateway']) == 'The model service did not answer.'
    assert model_failure_line(errors['timeout'], 120) == 'The model service did not answer within 120 seconds.'
    assert model_failure_line(errors['busy']) == 'The model is busy. Try again in a minute.'
    assert model_failure_line(_refusals()['bad request']) == 'The model service refused the request.'


def test_an_ended_turns_line_says_nothing_changed_and_the_message_can_be_sent_again():
    from test_service_flow import _service
    svc = _service()
    svc.cfg = ModelConfig(model='fake/model', timeout=120)
    errors = _errors()
    assert svc.turn_failure_line(errors['server']) == \
        'The model service did not answer. Nothing was changed. Retry to send the same message.'
    assert svc.turn_failure_line(errors['timeout']) == \
        'The model service did not answer within 120 seconds. Nothing was changed. Retry to send the same message.'
    assert svc.turn_failure_line(errors['busy']) == 'The model is busy. Try again in a minute. Nothing was changed.'
    assert svc.turn_failure_line(_refusals()['bad request']) == \
        'The model service refused the request. Nothing was changed.'
    # Beside a kept plan the fact alone: the card is the turn's answer.
    assert svc.turn_failure_line(errors['server'], ended=False) == 'The model service did not answer.'


def test_the_output_limit_line_names_a_narrower_ask():
    assert cut_line(32768) == ('The model wrote 32,768 tokens without finishing, so this turn stopped. '
                               'Ask about less at a time, for example sentences 1 to 10.')


# --- what the next turn reads -----------------------------------------------------

def _failing_turn(steps_messages, error):
    def run(cfg, kit, ws, system, transcript, on_progress, cancelled=None, on_text=None):
        e = error
        e.turn_steps, e.turn_partial, e.turn_reply_round = [], '', None
        e.turn_messages = steps_messages
        raise e
    return run


KEPT = [{'role': 'assistant', 'content': None,
         'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'search', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': '3 matches'}]


def _cut():
    e = TurnFailed(cut_line(32768))
    e.cut_at = 32768  # as `unless_capped` raises it
    return e


@pytest.mark.parametrize('error, why', [
    (litellm.InternalServerError('x', model='x', llm_provider='openai'), ': the model service did not answer.'),
    (_cut(), ': the model reached its output limit.'),
    (RuntimeError('a bug'), '.')])
def test_a_failed_turns_steps_stay_for_the_next_turn_and_retry_takes_them_off(monkeypatch, error, why):
    from fixtures import FakeClient
    from test_service_flow import Helper, _request, _seed, _service
    client = FakeClient()
    store = _seed(client, text='Count the verbs.')
    monkeypatch.setattr(turn_mod, 'run_turn', _failing_turn([dict(m) for m in KEPT], error))
    _service().process_request(_request(client), Helper())
    conv, _meta = store.load('c1')
    msgs = conv['messages']
    assert [m['role'] for m in msgs] == ['user', 'assistant', 'tool', 'user']
    assert msgs[3]['content'] == (f'(note) Your turn ended here without a reply{why} '
                                  'Nothing it staged, drafted or saved was kept.')
    assert all(m.get('failed_turn') for m in msgs[1:])
    # What the model is sent of them: the tag stays out.
    assert all('failed_turn' not in m for m in agent._clean_transcript(msgs))
    # Retry sends the question again, without the failed turn's steps.
    conv['messages'].append({'role': 'user', 'content': '(note) The plan was discarded.'})
    rewound, question = rewind_for_retry(conv)
    assert rewound['messages'] == [{'role': 'user', 'content': '(note) The plan was discarded.'}]
    assert question['text'] == 'Count the verbs.'


def test_a_stopped_turn_keeps_only_its_question(monkeypatch):
    from fixtures import FakeClient
    from test_service_flow import Helper, _request, _seed, _service
    client = FakeClient()
    store = _seed(client, text='Count the verbs.')
    monkeypatch.setattr(turn_mod, 'run_turn', _failing_turn([dict(m) for m in KEPT], TurnCancelled()))
    _service().process_request(_request(client), Helper())
    conv, _meta = store.load('c1')
    assert [m['role'] for m in conv['messages']] == ['user']


def test_only_answered_tool_calls_are_kept(monkeypatch):
    """A turn that ended between a call and its result keeps the steps up to
    the last call answered whole: a call with no result is refused by the
    provider on every later turn."""
    def call_tool(ws, name, args):
        if name == 'boom':
            raise KeyError('a fault')
        return 'ok'

    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: 'Looked', progress=lambda n, a: '')
    kit = Toolkit(tools_for=lambda ws: [], call_tool=call_tool, tracer=tracer)
    model = Model(READ_ONCE, _resp(calls=[_call(2, 'read_a'), _call(3, 'boom')]))
    monkeypatch.setattr(agent, '_complete', model)
    with pytest.raises(KeyError) as e:
        run_turn(ModelConfig(model='fake/m', stream=False), kit, Ws(), 'system', [{'role': 'user', 'content': 'hi'}])
    assert [m['role'] for m in turn_messages(e.value)] == ['assistant', 'tool']


def test_the_research_extractor_reads_the_output_limit_line_old_and_new():
    from plaid_agent.research.records import turn_end
    for text in (cut_line(32768), 'The model wrote 32,768 tokens without finishing, so this turn was stopped. '
                                  'Ask again, perhaps more narrowly.'):
        assert turn_end({'kind': 'error', 'text': text}) == 'cut_at_length'
        assert turn_end({'kind': 'assistant', 'failed': True, 'text': f'({text})'}) == 'cut_at_length'


def test_a_turn_that_staged_and_then_failed_twice_is_an_answer_with_its_plan_and_no_note(monkeypatch):
    """The note's "Nothing it staged ... was kept" and a kept plan cannot meet:
    a failure after a plan was staged keeps the plan as the turn's answer."""
    def stage(ws, name, args):
        ws.ops.append({'kind': 'x'})
        return 'Planned.'
    tracer = Tracer(kind=lambda n: PLAN, describe=lambda n, a: 'Planned x', progress=lambda n, a: '')
    kit = Toolkit(tools_for=lambda ws: [], call_tool=stage, tracer=tracer)
    err = _errors()['server']
    monkeypatch.setattr(agent, '_complete', Model(_resp(calls=[_call(1, 'plan_a')]), err, err))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), kit, Ws(), 'system', [{'role': 'user', 'content': 'hi'}])
    assert turn.failure is err and turn.text == '(The model service did not answer.)'


def test_a_drafted_job_card_is_kept_when_the_model_then_fails(monkeypatch):
    """Older than the retry: keep_the_plan kept ops only, so a card the turn
    drafted was lost with the turn while its result said it was on the reply."""
    def draft(ws, name, args):
        ws.job_card = {'summary': 'gloss 40 documents'}
        return 'Drafted the job. Its card is on your reply.'
    tracer = Tracer(kind=lambda n: PLAN, describe=lambda n, a: 'Drafted a job', progress=lambda n, a: '')
    kit = Toolkit(tools_for=lambda ws: [], call_tool=draft, tracer=tracer)
    ws = Ws()
    ws.job_card = None
    err = _errors()['server']
    monkeypatch.setattr(agent, '_complete', Model(_resp(calls=[_call(1, 'propose_job')]), err, err))
    turn = run_turn(ModelConfig(model='fake/m', stream=False), kit, ws, 'system', [{'role': 'user', 'content': 'hi'}])
    assert turn.failure is err and ws.job_card == {'summary': 'gloss 40 documents'}
    # An empty reply after a card is kept the same way as after a plan.
    monkeypatch.setattr(agent, '_complete', Model(_resp(calls=[_call(1, 'propose_job')]), _resp(''), _resp('')))
    ws = Ws()
    ws.job_card = None
    turn = run_turn(ModelConfig(model='fake/m', stream=False), kit, ws, 'system', [{'role': 'user', 'content': 'hi'}])
    assert turn.text == f'({agent.EMPTY_REPLY})'


@pytest.mark.parametrize('second, line', [
    (litellm.AuthenticationError('bad key', model='x', llm_provider='openai'), 'The model service refused the request.'),
    (RuntimeError('a bug'), None)])
def test_a_second_different_failure_reads_as_itself(monkeypatch, second, line):
    """The retry was made inside the first failure's except block, so a
    second failure carried the first as its context and a timeout read
    through it (REV-SVA-4)."""
    model = Model(READ_ONCE, _errors()['timeout'], second)
    with pytest.raises(type(second)) as e:
        _turn(monkeypatch, model, timeout=120)
    assert e.value.__context__ is None
    assert model_failure_line(e.value, 120) == line
    assert failed_turn_messages(e.value)[-1]['content'].startswith('(note) Your turn ended here without a reply. ')


def test_a_timeout_is_asked_again_once_with_no_second_ladder(monkeypatch):
    """The ladder already gave a timed-out call two windows: the turn's one
    more try is one more window, not two (REV-SVA-3). 2 + 2 windows of
    silence became 2 + 1: at the default 120 s, 360 s and not 480 s."""
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return _resp(calls=[_call(1, 'read_a')])
        raise litellm.Timeout('Request timed out.', model='x', llm_provider='openai')

    monkeypatch.setattr(litellm, 'completion', completion)
    with pytest.raises(litellm.Timeout):
        run_turn(ModelConfig(model='fake/m', stream=False, timeout=120), _kit(), Ws(), 'system',
                 [{'role': 'user', 'content': 'hi'}])
    assert len(calls) == 1 + 2 + 1


def test_a_busy_or_down_provider_keeps_its_ladder_on_the_one_more_try(monkeypatch):
    seen = []

    def complete(cfg, kwargs, on_text, cancelled=None, on_thinking=None, on_busy=None, **kw):
        seen.append(kw.get('timeout_retries', agent.TIMEOUT_RETRIES))
        if len(seen) == 1:
            return READ_ONCE
        if len(seen) == 2:
            raise _errors()['busy']
        return _resp('Done.')
    monkeypatch.setattr(agent, '_complete', complete)
    run_turn(ModelConfig(model='fake/m', stream=False), _kit(), Ws(), 'system', [{'role': 'user', 'content': 'hi'}])
    assert seen == [agent.TIMEOUT_RETRIES, agent.TIMEOUT_RETRIES, 0]


def test_litellms_unmapped_error_passes_only_for_a_server_status_or_none():
    """litellm raises APIError with the provider's own status for one it does
    not map, 4xx included (REV-SVA-7)."""
    kw = dict(model='x', llm_provider='openai')
    assert passes_again(litellm.APIError(503, 'down', **kw))
    assert not passes_again(litellm.APIError(402, 'payment required', **kw))
    none = litellm.APIError(500, 'no status', **kw)
    none.status_code = None
    assert passes_again(none)
    assert model_failure_line(litellm.APIError(402, 'payment required', **kw)) == 'The model service could not answer.'
