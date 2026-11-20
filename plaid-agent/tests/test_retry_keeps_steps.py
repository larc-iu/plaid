"""Retry after a failed turn carries on from the steps that turn completed
(the owner's ruling 2026-11-18, "Retry keeps the work").

A failed turn (the model service did not answer, the output limit, any other
failure of the turn) leaves its calls, their results and a note in the model
transcript after its question, marked ``failed_turn`` (fixes/SVA.md), so that
"continue" reads them. Retry now keeps them too and asks the question again
after them: the transcript the model is sent is the one "continue" would get,
with the question in place of "continue". The failed turn's error item keeps
its steps on the page, and the retried turn's follow it.

A stopped turn and a turn whose connection was lost keep only their question
in the transcript, so Retry there is as before: the question is taken off and
asked again once.
"""

from types import SimpleNamespace

import pytest
from fixtures import FakeClient
from plaid_client import ServiceRequestGone
from test_service_flow import Helper, _service

from plaid_agent.core import agent
from plaid_agent.core import conversation as conversation_mod
from plaid_agent.core import record_ops
from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import ModelConfig, Toolkit, TurnCancelled, TurnFailed, TurnResult, cut_line
from plaid_agent.core.conversation import DROPPED, ConversationStore, build_meta, rewind_for_retry, user_item
from plaid_agent.core.trace import PLAN, READ, Tracer

litellm = agent.litellm

ASKED = 'Count the verbs in Text 1.'
NOTE_DOWN = ('(note) Your turn ended here without a reply: the model service did not answer. '
             'Nothing it staged, drafted or saved was kept.')


def _req(client, op, **fields):
    return {'requester_client': client, 'requester_id': 'u@x', 'project_id': 'p1', 'delegated_projects': ['p1'],
            'conversation_id': 'c1', 'tab': 'tab-a', 'op': op, **fields}


def _store(client):
    return ConversationStore(client, 'u@x', 'p1', 'igt')


def _server_error():
    return litellm.InternalServerError('upstream exploded', model='x', llm_provider='openai')


def _call(i, name):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments='{}'))


def _resp(content=None, calls=None):
    msg = SimpleNamespace(content=content, tool_calls=calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason='stop')], usage=None)


class Model:
    """The model call (``agent._complete``) scripted, keeping what each call
    was sent."""

    def __init__(self, *script):
        self.script = list(script)
        self.sent = []

    def __call__(self, cfg, kwargs, on_text, cancelled=None, on_thinking=None, on_busy=None, **ladder):
        self.sent.append(agent._clean_transcript(kwargs['messages']))
        out = self.script.pop(0)
        if isinstance(out, BaseException):
            raise out
        return out


def _real_turn_service(tool_calls):
    """The service with the real turn loop and a toolkit of one read tool
    that counts its calls."""
    svc = _service()
    svc.cfg = ModelConfig(model='fake/model', stream=False)
    tracer = Tracer(kind=lambda n: PLAN if n.startswith('plan') else READ, describe=lambda n, a: 'Read Text 1',
                    progress=lambda n, a: 'Reading…')

    def call_tool(ws, name, args):
        tool_calls.append(name)
        return '3 verbs: kanu, tapa, wiru'
    svc.kit = Toolkit(tools_for=lambda ws: [], call_tool=call_tool, tracer=tracer)
    return svc


def test_retry_after_a_service_failure_sends_the_kept_steps_and_does_not_repeat_their_calls(monkeypatch):
    client = FakeClient()
    tools = []
    svc = _real_turn_service(tools)
    err = _server_error()
    # The turn reads, then the model service fails twice (its one more try
    # included): the turn ends with its read kept.
    model = Model(_resp(calls=[_call(1, 'read_text')]), err, err, _resp('Three verbs.'))
    monkeypatch.setattr(agent, '_complete', model)
    first = Helper(request_id='r1')
    svc.process_request(_req(client, 'send', text=ASKED, create=True), first)
    assert first.errors == ['The model service did not answer. Nothing was changed. '
                            'Retry to continue from the steps already done.']
    assert tools == ['read_text']

    again = Helper(request_id='r2')
    svc.process_request(_req(client, 'retry'), again)
    assert again.done[0]['kind'] == 'turn' and again.done[0]['message'] == 'Three verbs.'
    # The read ran once: the retried turn was sent its result and answered.
    assert tools == ['read_text']
    sent = model.sent[-1]
    assert [m['role'] for m in sent] == ['user', 'assistant', 'tool', 'user', 'user']
    assert sent[0]['content'].endswith(ASKED) and sent[-1]['content'].endswith(ASKED)
    assert sent[2]['content'].startswith('3 verbs')
    assert sent[3]['content'] == NOTE_DOWN
    # The record: the failed turn and its steps stay on the page, the
    # question asked again follows, then the answer.
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error', 'user', 'assistant']
    assert [s['label'] for s in conv['display'][1]['steps']][0] == 'Read Text 1'
    assert conv['display'][2]['retry'] is True
    # The kept call is in the transcript once, and the question twice.
    calls = [c['id'] for m in conv['messages'] for c in (m.get('tool_calls') or [])]
    assert calls.count('c1') == 1
    assert sum(1 for m in conv['messages'] if m['role'] == 'user' and m['content'].endswith(ASKED)) == 2


# --- the record, with the turn loop stood in for -----------------------------------------

KEPT = [{'role': 'assistant', 'content': None,
         'tool_calls': [{'id': 'k1', 'type': 'function', 'function': {'name': 'search', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'k1', 'content': '3 matches'}]


def _kept(i):
    """A failed turn's calls, with call ids of their own."""
    return [{'role': 'assistant', 'content': None,
             'tool_calls': [{'id': f'k{i}', 'type': 'function', 'function': {'name': 'search', 'arguments': '{}'}}]},
            {'role': 'tool', 'tool_call_id': f'k{i}', 'content': f'{i} matches'}]


def _failing(error, kept, seen):
    def run(cfg, kit, ws, system, transcript, on_progress, cancelled=None, on_text=None):
        seen.append([dict(m) for m in transcript])
        e = error() if callable(error) else error
        e.turn_steps = [{'id': 's', 'name': 'search', 'kind': READ, 'label': 'Searched'}]
        e.turn_partial, e.turn_reply_round = '', None
        e.turn_messages = [dict(m) for m in kept]
        raise e
    return run


def _answering(seen, text='Done.'):
    def run(cfg, kit, ws, system, transcript, on_progress, cancelled=None, on_text=None):
        seen.append([dict(m) for m in transcript])
        return TurnResult(text, [{'role': 'assistant', 'content': text}], [])
    return run


def _cut():
    e = TurnFailed(cut_line(32768), 'output-limit')
    e.cut_at = 32768
    return e


@pytest.mark.parametrize('error', [_server_error, _cut, lambda: RuntimeError('a bug')],
                         ids=['service', 'output limit', 'other'])
def test_retry_after_any_failed_turn_keeps_its_steps(monkeypatch, error):
    client = FakeClient()
    svc = _service()
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _failing(error, KEPT, seen))
    svc.process_request(_req(client, 'send', text=ASKED, create=True), Helper(request_id='r1'))
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    svc.process_request(_req(client, 'retry'), Helper(request_id='r2'))
    sent = seen[-1]
    assert [m['role'] for m in sent] == ['user', 'assistant', 'tool', 'user', 'user']
    assert sent[2]['content'] == '3 matches'
    assert sent[3]['content'].startswith('(note) Your turn ended here without a reply')
    assert sent[3]['content'].endswith('Nothing it staged, drafted or saved was kept.')
    assert sent[-1]['content'].endswith(ASKED)


def test_two_failed_turns_in_a_row_then_retry_sends_both_turns_steps(monkeypatch):
    client = FakeClient()
    svc = _service()
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _failing(_server_error, _kept(1), seen))
    svc.process_request(_req(client, 'send', text=ASKED, create=True), Helper(request_id='r1'))
    monkeypatch.setattr(turn_mod, 'run_turn', _failing(_server_error, _kept(2), seen))
    svc.process_request(_req(client, 'send', text='continue'), Helper(request_id='r2'))
    # "continue" read the first turn's steps.
    assert [m['role'] for m in seen[-1]] == ['user', 'assistant', 'tool', 'user', 'user']
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    svc.process_request(_req(client, 'retry'), Helper(request_id='r3'))
    sent = seen[-1]
    assert [m['role'] for m in sent] == ['user', 'assistant', 'tool', 'user', 'user', 'assistant', 'tool', 'user',
                                         'user']
    assert [m['content'] for m in sent if m['role'] == 'tool'] == ['1 matches', '2 matches']
    assert sent[4]['content'].endswith('continue') and sent[-1]['content'].endswith('continue')
    assert sum(1 for m in sent if m['role'] == 'user' and m['content'].endswith(ASKED)) == 1
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error', 'user', 'error', 'user', 'assistant']


def test_a_retry_that_fails_again_keeps_both_attempts_and_the_next_retry_sends_them(monkeypatch):
    client = FakeClient()
    svc = _service()
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _failing(_server_error, _kept(1), seen))
    svc.process_request(_req(client, 'send', text=ASKED, create=True), Helper(request_id='r1'))
    monkeypatch.setattr(turn_mod, 'run_turn', _failing(_server_error, _kept(2), seen))
    svc.process_request(_req(client, 'retry'), Helper(request_id='r2'))
    assert [m['role'] for m in seen[-1]] == ['user', 'assistant', 'tool', 'user', 'user']
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error', 'user', 'error']
    assert all(d.get('steps') for d in conv['display'] if d['kind'] == 'error')
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    svc.process_request(_req(client, 'retry'), Helper(request_id='r3'))
    sent = seen[-1]
    assert [m['content'] for m in sent if m['role'] == 'tool'] == ['1 matches', '2 matches']
    assert sum(1 for m in sent if m['role'] == 'user' and m['content'].endswith(ASKED)) == 3
    assert sent[-1]['content'].endswith(ASKED)
    conv, _ = _store(client).load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error', 'user', 'error', 'user', 'assistant']


# --- records stored before this change ----------------------------------------------------

def _save(client, messages, display):
    store = _store(client)
    conv = {'messages': messages, 'display': display}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model'))
    return store


def test_a_stored_failed_turn_with_kept_steps_is_carried_on_by_retry(monkeypatch):
    """Written between the kept steps (2026-11-16) and this change: the same
    shape, so Retry now keeps them."""
    client = FakeClient()
    marked = [{**m, 'failed_turn': True} for m in KEPT + [{'role': 'user', 'content': NOTE_DOWN}]]
    _save(client, [{'role': 'user', 'content': ASKED}] + marked,
          [user_item(ASKED), {'kind': 'error', 'text': 'The model service did not answer. Nothing was changed. '
                                                       'Retry to send the same message.', 'steps': [{'id': 's'}]}])
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    _service().process_request(_req(client, 'retry'), Helper(request_id='r2'))
    assert [m['role'] for m in seen[-1]] == ['user', 'assistant', 'tool', 'user', 'user']
    assert all('failed_turn' not in m for m in agent._clean_transcript(seen[-1]))


def test_a_stored_failed_turn_from_before_kept_steps_is_asked_again_once(monkeypatch):
    client = FakeClient()
    _save(client, [{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'ok'},
                   {'role': 'user', 'content': ASKED}],
          [user_item('first'), {'kind': 'assistant', 'text': 'ok'}, user_item(ASKED),
           {'kind': 'error', 'text': 'The model could not answer.'}])
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    _service().process_request(_req(client, 'retry'), Helper(request_id='r2'))
    assert [m['content'] for m in seen[-1]][1:] == ['ok', ASKED]


# --- a stop and a lost connection keep today's Retry -------------------------------------

@pytest.mark.parametrize('error', [TurnCancelled, lambda: ServiceRequestGone('gone')],
                         ids=['stopped', 'connection lost'])
def test_retry_after_a_stop_or_a_lost_connection_asks_the_question_again_once(monkeypatch, error):
    client = FakeClient()
    svc = _service()
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _failing(error, KEPT, seen))
    svc.process_request(_req(client, 'send', text=ASKED, create=True), Helper(request_id='r1'))
    conv, _ = _store(client).load('c1')
    assert [m['role'] for m in conv['messages']] == ['user']
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    svc.process_request(_req(client, 'retry'), Helper(request_id='r2'))
    assert [m['role'] for m in seen[-1]] == ['user']
    assert seen[-1][0]['content'].endswith(ASKED)


# --- the record's cap ---------------------------------------------------------------------

def test_a_retry_near_the_cap_drops_old_tool_results_as_continue_would_and_is_sent(monkeypatch):
    monkeypatch.setattr(record_ops, 'value_cap', lambda c: 20_000)
    monkeypatch.setattr(conversation_mod, 'value_cap', lambda c: 20_000)
    client = FakeClient()
    big = [{'role': 'assistant', 'content': None,
            'tool_calls': [{'id': 'k1', 'type': 'function', 'function': {'name': 'search', 'arguments': '{}'}}]},
           {'role': 'tool', 'tool_call_id': 'k1', 'content': 'm' * 17_350}]
    marked = [{**m, 'failed_turn': True} for m in big + [{'role': 'user', 'content': NOTE_DOWN}]]
    store = _save(client, [{'role': 'user', 'content': ASKED}] + marked,
                  [user_item(ASKED), {'kind': 'error', 'text': 'x', 'steps': [{'id': 's'}]}])
    before, _ = store.load('c1')
    budget = conversation_mod.record_budget(client)
    assert conversation_mod.conversation_bytes(before) <= budget
    # Under the budget by less than the question asked again and its item.
    assert budget - conversation_mod.conversation_bytes(before) < 100
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    helper = Helper(request_id='r2')
    _service().process_request(_req(client, 'retry'), helper)
    assert helper.done and helper.done[0]['kind'] == 'turn'
    sent = seen[-1]
    assert [m['role'] for m in sent] == ['user', 'assistant', 'tool', 'user', 'user']
    assert sent[2]['content'] == DROPPED
    conv, _ = store.load('c1')
    assert conversation_mod.conversation_bytes(conv) <= budget


def test_a_retry_with_no_room_even_after_thinning_is_refused_as_full(monkeypatch):
    monkeypatch.setattr(record_ops, 'value_cap', lambda c: 20_000)
    monkeypatch.setattr(conversation_mod, 'value_cap', lambda c: 20_000)
    client = FakeClient()
    marked = [{**m, 'failed_turn': True} for m in KEPT + [{'role': 'user', 'content': NOTE_DOWN}]]
    # The weight is in the reply on screen, which nothing thins.
    _save(client, [{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'ok'},
                   {'role': 'user', 'content': ASKED}] + marked,
          [user_item('first'), {'kind': 'assistant', 'text': 'y' * 17_500}, user_item(ASKED),
           {'kind': 'error', 'text': 'x'}])
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    helper = Helper(request_id='r2')
    _service().process_request(_req(client, 'retry'), helper)
    assert helper.done[0]['kind'] == 'refused' and helper.done[0]['why'] == 'full'
    assert not seen


# --- the rewind itself --------------------------------------------------------------------

def test_the_rewind_keeps_a_failed_turns_marked_messages_and_a_note_written_after_them():
    marked = [{**m, 'failed_turn': True} for m in KEPT + [{'role': 'user', 'content': NOTE_DOWN}]]
    later = {'role': 'user', 'content': '(note) The plan was discarded.'}
    c = {'messages': [{'role': 'user', 'content': ASKED}] + marked + [later],
         'display': [user_item(ASKED), {'kind': 'error', 'text': 'x'}]}
    out, asked = rewind_for_retry(c)
    assert out['messages'] == c['messages'] and asked['text'] == ASKED


def test_a_retry_refused_for_room_says_the_conversation_is_full_never_to_shorten_it(monkeypatch):
    """REV-RL1-5: a Retry sends no text the person can edit, so its refusal
    for room is the full conversation's, which says to start a new one. Here
    the record is far from full, but the question asked again does not fit
    (the base, which took the question and the kept steps off first,
    accepted this Retry)."""
    from plaid_agent.core.ops import CONVERSATION_FULL
    monkeypatch.setattr(record_ops, 'value_cap', lambda c: 66_667)
    monkeypatch.setattr(conversation_mod, 'value_cap', lambda c: 66_667)
    client = FakeClient()
    asked = 'q' * 15_000
    marked = [{**m, 'failed_turn': True} for m in KEPT + [{'role': 'user', 'content': NOTE_DOWN}]]
    _save(client, [{'role': 'user', 'content': asked}] + marked,
          [user_item(asked), {'kind': 'error', 'text': 'x'}])
    seen = []
    monkeypatch.setattr(turn_mod, 'run_turn', _answering(seen))
    helper = Helper(request_id='r2')
    _service().process_request(_req(client, 'retry'), helper)
    assert helper.done[0]['kind'] == 'refused' and helper.done[0]['why'] == 'full'
    assert helper.done[0]['message'] == CONVERSATION_FULL
    assert not seen
