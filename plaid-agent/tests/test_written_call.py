"""A reply that writes a tool call out as text instead of making it.

Small local models do this often: 52 of Gemma's 137 failed bench runs ended
with the call written in the reply (BENCH-GEMMA), as `set_head(...)`,
`<apply_penman document=...>` or `<action>set_head</action>`. Luke ruled
2026-10-16 (DECIDE 10): one nudge, detected cheaply, shown in the record and
the trace (core/agent.py `written_call`). Over the bench's records the
detector finds 55 of Gemma's replies and none of the 4,083 replies of the
other models, the false positives it must not have.
"""

import pytest

from plaid_agent.core import agent
from plaid_agent.core.agent import written_call, written_call_note

from test_nothing_planned import APPS, _reply, _run

NAMES = ['set_head', 'split_sentence', 'apply_penman', 'query', 'unlink_entry', 'read_document']

# The written-out calls, as the bench's Gemma replies wrote them.
WRITTEN = [
    ('<plan>\nsplit_sentence(document="Russian 2", ref="s4.w8")\n</plan>', 'split_sentence'),
    ('```python\nunlink_entry(document="Natugu text 2", refs=["s7.w6.m1"])\n```', 'unlink_entry'),
    ('`set_head(document="Arabic 1", ref="s1.w8", head=7, deprel="nmod")`', 'set_head'),
    ('<apply_penman document="Kukama text 2" text="(s12c / chikari)">', 'apply_penman'),
    ('<plan> <action>set_head</action> <args> {"ref": "s1.w2"} </args></plan>', 'set_head'),
    ('```json\n{"name": "split_sentence", "arguments": {"ref": "s4.w8"}}\n```', 'split_sentence'),
    ('results = query({\n    "find": ["?m"]})', 'query'),
    ('set_head {"document": "Arabic 1", "ref": "s1.w8"}', 'set_head'),
]

# Replies that name a tool or say "query" in prose.
PROSE = [
    'I read the document with read_document and found three hits.',
    'The query (over all five texts) found 35 morphemes.',
    'I can split sentence 4 with split_sentence if you like.',
    'Approve the plan card to set the head.',
    'The deprel is nmod (see s1.w8).',
    'Use the Search tab: <b>pattern</b> { N [upos=NOUN] }.',
    '',
]


@pytest.mark.parametrize('text,name', WRITTEN)
def test_a_call_written_as_text_is_found(text, name):
    assert written_call(text, NAMES) == name


@pytest.mark.parametrize('text', PROSE)
def test_a_tool_named_in_prose_is_not(text):
    assert written_call(text, NAMES) is None


def test_only_a_tool_the_turn_offers_counts():
    assert written_call('set_head(ref="s1.w2")', ['set_field']) is None
    assert written_call('foo(1)', []) is None


@pytest.mark.parametrize('app', sorted(APPS))
def test_a_written_call_is_sent_back_once_with_the_tools(monkeypatch, app):
    ws, kit, plan, read = APPS[app]()
    name, args = plan
    first = f'Here it is:\n{name}(document="x")'
    out, sent = _run(monkeypatch, ws, kit, [
        _reply(read),
        _reply(text=first),
        _reply(plan),
        _reply(text='Planned it.'),
    ])
    note = written_call_note(name)
    assert len(sent) == 4 and sent[2].get('tools')
    assert sent[2]['messages'][-1] == {'role': 'user', 'content': note}
    assert ws.ops and out.text == 'Planned it.'
    assert {'role': 'user', 'content': note} in out.messages
    step = next(s for s in out.steps if s['name'] == agent.WRITTEN_CALL_STEP)
    assert step['said'] == first and step['kind'] == 'meta' and step['label'] == agent.WRITTEN_CALL_LABEL
    assert [s['name'] for s in out.steps] == [read[0], agent.WRITTEN_CALL_STEP, plan[0]]


def test_it_is_sent_back_once_only(monkeypatch):
    ws, kit, plan, _read = APPS['igt']()
    out, sent = _run(monkeypatch, ws, kit, [
        _reply(text='set_field(document="Text 1")'),
        _reply(text='set_field(document="Text 1", refs=["s1.w1"])'),
    ])
    assert len(sent) == 2 and out.text.startswith('set_field(')
    assert [s['name'] for s in out.steps] == [agent.WRITTEN_CALL_STEP]


def test_the_note_names_the_tool_and_says_nothing_ran():
    assert written_call_note('set_head') == ('(system) Your reply wrote a set_head call as text, so it did not run: '
                                             'nothing was done. Call the tool itself now, or reply to the user '
                                             'without the call.')
