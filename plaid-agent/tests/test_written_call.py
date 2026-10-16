"""A reply that writes a tool call out as text instead of making it.

Small local models do this often: 52 of Gemma's 137 failed bench runs ended
with the call written in the reply (BENCH-GEMMA), as `set_head(...)`,
`<apply_penman document=...>` or `<action>set_head</action>`. Luke ruled
2026-10-16 (DECIDE 10): one nudge, detected cheaply, shown in the record and
the trace (core/agent.py `written_call`). Over the bench's records the
detector finds 55 of Gemma's replies and none of the 4,083 replies of the
other models, the false positives it must not have.
"""

import json

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


# REV7-AGENT R7A-1 (parent 2026-10-16): a reply that restates a call that went
# through this turn is not told it did not run. 11 of Gemma's 55 bench hits
# were this shape, and a model obeying the note staged the change again.

def test_a_restated_call_of_a_tool_that_ran_is_not_one():
    text = 'Plan:\n`set_head(document="Russian 2", ref="s11.w5", head=3, deprel="iobj")`'
    assert written_call(text, NAMES, ran={'set_head'}) is None
    assert written_call(text, NAMES, ran={'query'}) == 'set_head'
    # Another tool written beside it still counts.
    both = text + '\n\nsplit_sentence(document="Russian 2", ref="s4.w8")'
    assert written_call(both, NAMES, ran={'set_head'}) == 'split_sentence'


def test_a_reply_restating_a_call_that_ran_is_the_reply(monkeypatch):
    ws, kit, plan, _read = APPS['igt']()
    restated = ('I have planned the gloss change.\n\n```python\n'
                'set_field(document="Text 1", refs=["s1.w1"], field="Gloss", value="X")\n```\n\nPlease approve.')
    out, sent = _run(monkeypatch, ws, kit, [_reply(plan), _reply(text=restated)])
    assert len(sent) == 2 and out.text == restated
    assert agent.WRITTEN_CALL_STEP not in [s['name'] for s in out.steps]
    assert len(ws.ops) == 1


def test_the_entry_is_not_staged_twice(monkeypatch):
    ws, kit, _plan, _read = APPS['igt']()
    create = ('create_entry', {'lexicon': 'Lexicon', 'form': 'wil', 'fields': {'Gloss': 'do'}})
    restated = ('I have planned a new entry wil "do".\n\n```python\n'
                'create_entry(lexicon="Lexicon", form="wil", fields={"gloss": "do"})\n```')
    out, sent = _run(monkeypatch, ws, kit, [_reply(create), _reply(text=restated)])
    assert len(sent) == 2 and out.text == restated
    assert len(ws.ops) == 1


# R7A-6: code a run_code call ran, shown in a reply, and a Grew pattern shown
# under grew_search, are not calls written as text.

SHOWN = 'I counted with:\n\n```python\nrows = query({"find": ["?t"], "where": [["?t", "layer", "Words"]]})\nprint(len(rows))\n```'
RAN = 'rows = query({"find": ["?t"],\n  "where": [["?t", "layer", "Words"]]})\nprint(len(rows))'


def test_code_that_ran_is_shown_code():
    assert written_call(SHOWN, NAMES, code=[RAN]) is None
    assert written_call(SHOWN, NAMES) == 'query'
    assert written_call(SHOWN, NAMES, code=['print(1)']) == 'query'


def test_a_grew_pattern_under_the_tools_name_is_not_a_call():
    names = NAMES + ['grew_search']
    assert written_call('I searched with:\n\n```\ngrew_search {\n  pattern { X -[nsubj]-> Y }\n}\n```', names) is None
    assert written_call('grew_search {"pattern": "pattern { X [upos=NOUN] }"}', names) == 'grew_search'
    assert written_call('grew_search {\n  "pattern": "pattern { X }"\n}', names) == 'grew_search'


def test_run_code_of_reads_the_code_of_every_run_code_call():
    msgs = [{'role': 'user', 'content': 'q'},
            {'role': 'assistant', 'tool_calls': [
                {'id': 'a', 'function': {'name': 'run_code', 'arguments': '{"code": "print(1)"}'}},
                {'id': 'b', 'function': {'name': 'query', 'arguments': '{"q": {}}'}},
                {'id': 'c', 'function': {'name': 'run_code', 'arguments': '{"code": '}}]}]
    assert agent.run_code_of(msgs) == ['print(1)']


def test_code_run_in_an_earlier_turn_is_shown_code(monkeypatch):
    ws, kit, _plan, _read = APPS['igt']()
    transcript = [{'role': 'user', 'content': 'how many words?'},
                  {'role': 'assistant', 'content': '', 'tool_calls': [
                      {'id': 'r1', 'type': 'function',
                       'function': {'name': 'run_code', 'arguments': json.dumps({'code': RAN})}}]},
                  {'role': 'tool', 'tool_call_id': 'r1', 'content': '120'},
                  {'role': 'assistant', 'content': '120 words.'},
                  {'role': 'user', 'content': 'how did you count?'}]
    sent = []

    def complete(cfg, kwargs, on_text, cancelled=None, on_thinking=None):
        sent.append(kwargs)
        return _reply(text=SHOWN)

    monkeypatch.setattr(agent, '_complete', complete)
    out = agent.run_turn(agent.ModelConfig(model='stub'), kit, ws, 'system', transcript)
    assert len(sent) == 1 and out.text == SHOWN


# R7A-8 (parent 2026-10-16): a staged plan survives any model-call failure
# after it was staged, not only the call for the reply.

def test_a_failure_of_the_next_round_keeps_the_staged_plan(monkeypatch):
    ws, kit, plan, _read = APPS['igt']()
    calls = iter([_reply(plan), RuntimeError('litellm.Timeout: read timed out')])

    def complete(cfg, kwargs, on_text, cancelled=None, on_thinking=None):
        x = next(calls)
        if isinstance(x, Exception):
            raise x
        return x

    monkeypatch.setattr(agent, '_complete', complete)
    out = agent.run_turn(agent.ModelConfig(model='stub'), kit, ws, 'system', [{'role': 'user', 'content': 'x'}])
    assert out.text == f'({agent.NO_ANSWER})' and len(ws.ops) == 1
    assert [s['name'] for s in out.steps] == ['set_field']


def test_a_failure_with_nothing_planned_still_fails_the_turn(monkeypatch):
    ws, kit, _plan, read = APPS['igt']()
    calls = iter([_reply(read), RuntimeError('litellm.Timeout: read timed out')])

    def complete(cfg, kwargs, on_text, cancelled=None, on_thinking=None):
        x = next(calls)
        if isinstance(x, Exception):
            raise x
        return x

    monkeypatch.setattr(agent, '_complete', complete)
    with pytest.raises(RuntimeError):
        agent.run_turn(agent.ModelConfig(model='stub'), kit, ws, 'system', [{'role': 'user', 'content': 'x'}])
    assert not ws.ops
