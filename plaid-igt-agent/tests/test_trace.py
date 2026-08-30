"""The trace of what a turn did.

The point of these is the first one: the browser renders whatever the service
sends, so a tool added without a line in :mod:`plaid_igt_agent.trace` would
show up in the tab as a bare function name.
"""

from plaid_igt_agent.tools import TOOLS, WRITE_TOOLS
from plaid_igt_agent.trace import DOCUMENT, PLAN, READ, describe_step, step_kind, summarize_steps, trace_step


def test_every_tool_has_a_line_of_its_own():
    missing = [t['function']['name'] for t in TOOLS
               if describe_step(t['function']['name'], {}) == t['function']['name'].replace('_', ' ')]
    assert missing == [], f'no trace description for: {missing}'


def test_write_tools_are_the_ones_that_say_plan():
    assert WRITE_TOOLS == {t['function']['name'] for t in TOOLS
                           if t['function']['description'].startswith('PLAN:')}
    assert 'discard_plan' not in WRITE_TOOLS  # bookkeeping, not a change
    assert all(step_kind(n) == PLAN for n in WRITE_TOOLS)


def test_lines_read_as_sentences():
    assert describe_step('read_document', {'document': 'Text 1'}) == 'Read “Text 1”'
    assert describe_step('read_document', {'document': 'Text 1', 'from_sentence': 3, 'to_sentence': 9}) \
        == 'Read “Text 1” (sentences 3–9)'
    assert describe_step('read_document', {'document': 'Text 1', 'from_sentence': 3}) \
        == 'Read “Text 1” (sentences 3 on)'
    assert describe_step('search', {'pattern': 'di'}) == 'Searched the baseline for “di”'
    assert describe_step('search', {'pattern': 'di', 'where': 'Gloss', 'document': 'Text 1'}) \
        == 'Searched Gloss for “di” in “Text 1”'
    assert describe_step('set_field', {'field': 'Gloss', 'value': 'ERG', 'refs': ['s1.w2', 's1.w3']}) \
        == 'Planned Gloss = “ERG” on 2 items'
    assert describe_step('set_field', {'field': 'Gloss', 'value': '', 'refs': ['s1.w2']}) \
        == 'Planned Gloss = “” on 1 item'
    # The tools added after the trace first shipped, which used to show raw names.
    assert describe_step('split_word', {'ref': 's1.w2', 'at': 'Ali'}) \
        == 'Planned splitting the word s1.w2 at “Ali”'
    assert describe_step('merge_words', {'refs': ['s1.w2', 's1.w3']}) == 'Planned merging 2 words into one'
    assert describe_step('append_text', {'document': 'Text 1'}) \
        == 'Planned adding text to the end of “Text 1”'
    assert describe_step('confirm', {'document': 'Text 1'}) \
        == 'Planned confirming everything unverified in “Text 1”'


def test_summary_counts_documents_searches_and_changes():
    steps = [trace_step('a', 'read_document', {'document': 'Text 1'}),
             trace_step('b', 'read_document', {'document': 'Text 1'}),
             trace_step('c', 'read_document', {'document': 'Text 2'}),
             trace_step('d', 'search', {'pattern': 'di'}),
             trace_step('e', 'project_overview', {}),
             trace_step('f', 'set_field', {'field': 'Gloss', 'value': 'ERG', 'refs': ['s1.w2']})]
    assert [s['kind'] for s in steps] == [DOCUMENT, DOCUMENT, DOCUMENT, READ, 'meta', PLAN]
    assert summarize_steps(steps) == 'read 2 documents · 1 search · 1 planned change · 6 steps'
    assert summarize_steps(steps[4:5]) == '1 step'
    assert summarize_steps([]) == '0 steps'


def test_a_step_names_the_call_it_belongs_to():
    step = trace_step('call-7', 'read_document', {'document': 'Text 1'})
    # The id is how the tab finds the tool's output in the transcript, so the
    # result is never sent twice.
    assert step == {'id': 'call-7', 'name': 'read_document', 'kind': DOCUMENT,
                    'label': 'Read “Text 1”', 'document': 'Text 1'}
