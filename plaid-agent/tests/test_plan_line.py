"""Every tool result of a turn ends with what the turn's plan holds (owner,
2026-11-12: stop the model claiming a plan it did not make by the prompt and
by what the tools tell it, not by code that reads its reply).

The recorded false claim (bench glm53-stretch-2, igt-stretch-np-accessibility
rep 1) came after two reads and no plan call: the model decided the values
in its reasoning and wrote "The plan card holds three changes". Nothing it
had been shown said what the plan held. Now the read it had just been given
would have ended "[Plan of this turn: nothing staged.]"."""
import json
import sys

import pytest

sys.path.insert(0, 'tests')

from test_nothing_planned import APPS, _reply, _run  # noqa: E402

from plaid_agent.core.plan import plan_line  # noqa: E402

NOTHING = '[Plan of this turn: nothing staged.]'


def _tool_results(out):
    return [m['content'] for m in out.messages if m.get('role') == 'tool']


@pytest.mark.parametrize('app', sorted(APPS))
def test_a_read_in_a_turn_that_staged_nothing_says_so(monkeypatch, app):
    ws, kit, _plan, read = APPS[app]()
    out, _sent = _run(monkeypatch, ws, kit, [_reply(read), _reply(text='The project has three documents.')])
    (result,) = _tool_results(out)
    assert result.endswith('\n' + NOTHING), result[-200:]


@pytest.mark.parametrize('app', sorted(APPS))
def test_each_result_after_a_staging_says_how_many_changes_the_plan_holds(monkeypatch, app):
    ws, kit, plan, read = APPS[app]()
    out, sent = _run(monkeypatch, ws, kit, [_reply(read), _reply(plan), _reply(read), _reply(text='Planned.')])
    results = _tool_results(out)
    assert results[0].endswith('\n' + NOTHING)
    n = len(ws.ops) and plan_line(ws)
    assert n.startswith('[Plan of this turn: ') and n != NOTHING, n
    assert results[1].endswith('\n' + n) and results[2].endswith('\n' + n), results
    # The model is sent the same text it is recorded as having seen.
    assert sent[-1]['messages'][-1]['content'] == results[2]


def test_the_line_counts_as_the_card_counts():
    from fixtures import FakeClient, fake_ws
    from plaid_agent.igt.toolkit import call_tool
    ws = fake_ws(FakeClient())
    assert plan_line(ws) == NOTHING
    call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss', 'value': 'X'})
    assert plan_line(ws) == '[Plan of this turn: 2 changes.]'
    call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'X'})
    assert plan_line(ws) == '[Plan of this turn: 3 changes.]'


def test_a_plan_waiting_from_an_earlier_message_is_named_as_that_and_not_this_turns():
    from fixtures import FakeClient, fake_ws
    ws = fake_ws(FakeClient())
    ws.waiting = {'count': 1, 'summary': '', 'id': 'p', 'documents': []}
    assert plan_line(ws) == ('[Plan of this turn: nothing staged. The plan of 1 change from your earlier message '
                             'still waits on its card.]')


def test_a_refused_call_ends_with_the_line_too(monkeypatch):
    ws, kit, _plan, _read = APPS['igt']()
    bad = ('set_field', {'document': 'Nope', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'})
    out, _sent = _run(monkeypatch, ws, kit, [_reply(bad), _reply(text='No such document.')])
    (result,) = _tool_results(out)
    assert result.startswith('Error') and result.endswith('\n' + NOTHING), result
    assert json.dumps(result)
