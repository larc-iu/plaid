"""A turn that ends saying it planned changes when it planned none.

The bench (build-q38-1, qwen3.8-27b) found ten of 35 failed runs ending this
way in all three apps: reads only, then "I've staged the plan" or "Approve to
apply", over a card that did not exist. The loop now sends such a reply back
once, with the tools and a note, and keeps the first reply and the note for
the record (core/agent.py `claims_a_plan`, `NOTHING_PLANNED`).
"""

import json
import sys
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, 'tests')

from plaid_agent.core import agent
from plaid_agent.core.agent import NOTHING_PLANNED, claims_a_plan


# --- the detector -----------------------------------------------------------------
# The positive lines are the bench's failing replies (build-q38-1, build-q38-fix1),
# each the sentence that carried the claim.

CLAIMS = [
    "Here's the staged plan — four whole-value replacements, one per abbreviation, each across all five texts:",
    "I've staged four project-wide gloss corrections, one per value. Approve and all four are applied together.",
    "I've staged a plan that repoints five morpheme links:",
    "I've planned setting its part of speech to **suffix**, touching only that entry. Approve the plan when you're ready.",
    '**Plan:** set Gloss = "IPFV" on 3 morphemes.',
    "Staged plan: set the analysis of s12.w6 to three morphemes.",
    "I've staged the reattachment:",
    "**Planned (1 change):**\n1. Split s2 into two sentences.",
    "So: **approve the pending split**, and in the next message I'll read the two new sentences.",
    "The plan touches one node (the way in s14, adding its possessor). Approve it to apply.",
    "I've planned the one change:",
    "So I've staged the required first step:",
    "I've planned to set all three to PUNCT:",
    "The plan changes the UPOS of those three words from AUX to PUNCT. Approve to apply.",
    "I have prepared a plan to set their lemma to “le” across all three documents.",
    "I’ve staged the change.",
    # bench build-q38-3, ud-ru-split-two r3 turns 2 and 3.
    "The sentence split has to be planned on its own (it renumbers everything after it), so this turn's plan "
    "holds just that one change:",
    "A sentence split must be the only change in its plan, so this turn holds just that:",
]

NOT_CLAIMS = [
    "Tell me the sentence and I'll plan the gloss change.",
    "Which sentence (or word) do you want the gloss \"son\" set on? Once you tell me, I'll stage the change.",
    "Say the word if you'd like me to plan the translation fixes.",
    "Nothing has been planned yet.",
    "I haven't planned any changes.",
    "No changes planned.",
    "This is normal for a 91-roleset; no change is needed, and none was planned.",
    "Nothing further to plan.",
    "That said, I can't plan the alignment itself: I have no tool that sets word alignments.",
    "Shall I plan both: s8.w2 → s8.w3 as nsubj, and s8.w3 → s8.w8 as nsubj?",
    "Nothing changed — let me know if you'd like me to plan corrections.",
    "**Plan needed:** I would need to stage two separate replacements:",
    "Tell me which, and I'll plan both the reattachment and the new head, and you can approve the card.",
    "If you want, I can plan it and you approve it afterwards.",
    "15 nodes in \"Kukama text 2\" have the concept ikian.",
    "The plan holds nothing yet.",
    "This turn holds no changes.",
    "",
]


@pytest.mark.parametrize('text', CLAIMS)
def test_a_reply_that_says_it_planned_is_read_as_a_claim(text):
    assert claims_a_plan(text)


@pytest.mark.parametrize('text', NOT_CLAIMS)
def test_an_offer_a_question_or_a_denial_is_not(text):
    assert not claims_a_plan(text)


# --- the loop, in all three apps --------------------------------------------------

def _reply(*calls, text=None):
    tool_calls = [NS(id=f'c{n}-{i}', function=NS(name=name, arguments=json.dumps(args)))
                  for i, (name, args) in enumerate(calls) for n in [next(_ids)]]
    return NS(choices=[NS(message=NS(content=text, tool_calls=tool_calls or None), finish_reason='stop')],
              usage=None)


_ids = iter(range(10 ** 6))


def _igt():
    from fixtures import FakeClient, fake_ws
    from plaid_agent.igt.service import AssistantService
    ws = fake_ws(FakeClient())
    plan = ('set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'})
    return ws, AssistantService().toolkit(), plan, ('project_overview', {})


def _ud():
    from ud_fixtures import PID, ud_client
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.service import AssistantService
    from plaid_agent.ud.tools import Workspace
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    plan = ('set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'X'})
    return ws, AssistantService().toolkit(), plan, ('project_overview', {})


def _umr():
    from umr_fixtures import umr_ws
    from plaid_agent.umr.service import AssistantService
    ws = umr_ws()
    plan = ('set_attributes', {'document': 'Story', 'sentence': 1, 'var': 's1d', 'line': ':polarity -'})
    return ws, AssistantService().toolkit(), plan, ('project_overview', {})


APPS = {'igt': _igt, 'ud': _ud, 'umr': _umr}


def _run(monkeypatch, ws, kit, script):
    script = iter(script)
    sent = []

    def complete(cfg, kwargs, on_text, cancelled=None, on_thinking=None):
        sent.append(kwargs)
        return next(script)

    monkeypatch.setattr(agent, '_complete', complete)
    out = agent.run_turn(agent.ModelConfig(model='stub'), kit, ws, 'system', [{'role': 'user', 'content': 'x'}])
    return out, sent


@pytest.mark.parametrize('app', sorted(APPS))
def test_a_claimed_plan_with_nothing_planned_is_sent_back_once_with_the_tools(monkeypatch, app):
    ws, kit, plan, read = APPS[app]()
    first = "I've staged the plan. Approve to apply."
    out, sent = _run(monkeypatch, ws, kit, [
        _reply(read),
        _reply(text=first),
        _reply(plan),
        _reply(text='Planned it.'),
    ])
    assert len(sent) == 4
    # The round after the claim is a full one, with the tools and the note.
    assert sent[2].get('tools'), 'sent back with the tools'
    assert sent[2]['messages'][-1] == {'role': 'user', 'content': NOTHING_PLANNED}
    assert sent[2]['messages'][-2]['content'] == first
    assert ws.ops, f'{app}: the second round planned'
    assert out.text == 'Planned it.'
    # The first reply and the note stay in the transcript and the trace.
    assert {'role': 'user', 'content': NOTHING_PLANNED} in out.messages
    assert any(m.get('role') == 'assistant' and m.get('content') == first for m in out.messages)
    step = next(s for s in out.steps if s['name'] == agent.NOTHING_PLANNED_STEP)
    assert step['said'] == first and step['kind'] == 'meta' and not step.get('failed')
    assert [s['name'] for s in out.steps] == [read[0], agent.NOTHING_PLANNED_STEP, plan[0]]


@pytest.mark.parametrize('app', sorted(APPS))
def test_it_is_sent_back_once_only(monkeypatch, app):
    ws, kit, _plan, _read = APPS[app]()
    out, sent = _run(monkeypatch, ws, kit, [
        _reply(text="I've staged the plan."),
        _reply(text="Here's the staged plan: approve it."),
    ])
    assert len(sent) == 2 and out.text == "Here's the staged plan: approve it."
    assert [s['name'] for s in out.steps] == [agent.NOTHING_PLANNED_STEP]


def test_a_turn_that_planned_or_a_plan_still_waiting_is_left_alone(monkeypatch):
    ws, kit, plan, _read = _igt()
    out, sent = _run(monkeypatch, ws, kit, [_reply(plan), _reply(text="I've staged the plan. Approve to apply.")])
    assert len(sent) == 2 and not any(s['name'] == agent.NOTHING_PLANNED_STEP for s in out.steps)

    # A card from an earlier message still waits: the reply may be about it.
    ws, kit, _plan, _read = _igt()
    ws.waiting = {'count': 3, 'summary': 'x', 'id': 'p', 'documents': []}
    out, sent = _run(monkeypatch, ws, kit, [_reply(text='Approve the plan card above to apply all three.')])
    assert len(sent) == 1


def test_an_offer_ends_the_turn_as_before(monkeypatch):
    ws, kit, _plan, _read = _igt()
    out, sent = _run(monkeypatch, ws, kit, [_reply(text='Which sentence do you mean? Then I will plan it.')])
    assert len(sent) == 1 and out.steps == []


def test_the_rounds_keep_the_first_reply_and_the_note(monkeypatch):
    """The panel opens the step to its round's call: the note, as the model
    was sent it."""
    ws, kit, _plan, _read = _igt()
    kept = []
    ws.rounds = NS(follow=lambda trace: None, think=lambda t: None, thinking='', text='',
                   store=lambda rnd: kept.append(rnd) or True)
    out, _sent = _run(monkeypatch, ws, kit, [_reply(text="I've staged it."), _reply(text='I have not planned it.')])
    step = out.steps[0]
    rnd = next(r for r in kept if r['id'] == step['round'])
    assert rnd['said'] == "I've staged it."
    assert rnd['calls'] == [{'id': step['id'], 'name': agent.NOTHING_PLANNED_STEP, 'arguments': '{}',
                             'result': NOTHING_PLANNED, 'chars': len(NOTHING_PLANNED)}]


def test_the_note_says_the_next_reply_replaces_the_first():
    """The second reply described only the plan and lost the first reply's
    answer, and opened "I've now staged" (bench q38-2)."""
    assert 'repeat in it everything the one above answered' in NOTHING_PLANNED
    assert 'not mention this note or that the changes were staged only now' in NOTHING_PLANNED


@pytest.mark.parametrize('app', sorted(APPS))
def test_a_plan_discarded_this_turn_is_nothing_planned(monkeypatch, app):
    """A turn that planned, then emptied the plan with discard_plan, holds
    nothing: a reply claiming a plan is sent back (bench build-q38-3,
    ud-ru-split-two r3 turn 2)."""
    ws, kit, plan, _read = APPS[app]()
    first = "I've staged the plan. Approve to apply."
    out, sent = _run(monkeypatch, ws, kit, [
        _reply(plan),
        _reply(('discard_plan', {})),
        _reply(text=first),
        _reply(text='Nothing is planned.'),
    ])
    assert len(sent) == 4
    assert sent[3]['messages'][-1] == {'role': 'user', 'content': NOTHING_PLANNED}
    assert out.text == 'Nothing is planned.'
