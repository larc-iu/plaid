"""The trace of what a turn did.

The point of these is the first one: the browser renders whatever the service
sends, so a tool added without a line in :mod:`plaid_agent.igt.trace` would
show up in the tab as a bare function name.
"""

import pytest

from plaid_agent.igt.toolkit import TOOLS, WRITE_TOOLS
from plaid_agent.core.trace import DOCUMENT, PLAN, READ, summarize_steps, trace_step
from plaid_agent.igt.trace import TRACER, describe_step


APPS = ('igt', 'ud', 'umr')


def _kit(app):
    import importlib
    return (importlib.import_module(f'plaid_agent.{app}.toolkit').TOOLS,
            importlib.import_module(f'plaid_agent.{app}.trace').TRACER)


@pytest.mark.parametrize('app', APPS)
def test_every_tool_has_a_line_of_its_own(app):
    """A tool with no line falls back to its own name, which reaches the reader
    as `set_attributes` in a list of sentences."""
    tools, tracer = _kit(app)
    missing = [t['function']['name'] for t in tools
               if tracer.describe(t['function']['name'], {}) == t['function']['name'].replace('_', ' ')]
    assert missing == [], f'no trace description for: {missing}'


@pytest.mark.parametrize('app', APPS)
def test_every_tool_has_a_progress_line_of_its_own(app):
    """The same guarantee as above, for the PRESENT tense.

    The list the panel ticks through while a turn runs comes from
    ``progress``, not ``describe``, and it had its own fallback to a bare
    function name. Three meta tools reached it, so a linguist watching a turn
    saw ``discard_plan…`` and ``plan_status…`` in among "Looking at the
    project…". The past-tense test above could not catch it, because those
    tools do have past-tense lines.
    """
    tools, tracer = _kit(app)
    missing = [t['function']['name'] for t in tools
               if tracer.progress(t['function']['name'], {}) == f"{t['function']['name']}…"]
    assert missing == [], f'no progress line for: {missing}'


def test_a_shared_tool_reads_the_same_in_every_app():
    """The tools every app offers have one line, in core, so the trace under a
    reply does not say the same thing three ways."""
    from plaid_agent.core.trace import SHARED_DESCRIBE, SHARED_PROGRESS
    a = {'document': 'Text 1', 'ref': 's3', 'title': 'Glosses', 'indexes': [1, 2]}
    for name in SHARED_DESCRIBE:
        lines = {app: (_kit(app)[1].describe(name, a), _kit(app)[1].progress(name, a)) for app in APPS}
        assert len(set(lines.values())) == 1, (name, lines)
        assert lines['igt'] == (SHARED_DESCRIBE[name](a), SHARED_PROGRESS[name](a))


def test_write_tools_are_the_ones_that_say_plan():
    assert WRITE_TOOLS == {t['function']['name'] for t in TOOLS
                           if t['function']['description'].startswith('PLAN:')}
    assert 'discard_plan' not in WRITE_TOOLS  # bookkeeping, not a change
    assert all(TRACER.kind(n) == PLAN for n in WRITE_TOOLS)


def test_lines_read_as_sentences():
    assert describe_step('read_document', {'document': 'Text 1'}) == 'Read “Text 1”'
    assert describe_step('read_document', {'document': 'Text 1', 'from_sentence': 3, 'to_sentence': 9}) \
        == 'Read “Text 1” (sentences 3–9)'
    assert describe_step('read_document', {'document': 'Text 1', 'from_sentence': 3}) \
        == 'Read “Text 1” (sentences 3 on)'
    assert describe_step('read_document', {'document': 'Text 1', 'sentences': ['s3', 's8']}) \
        == 'Read “Text 1” (2 sentences)'
    assert describe_step('search', {'pattern': 'di'}) == 'Searched the baseline for “di”'
    assert describe_step('search', {'pattern': 'di', 'where': 'Gloss', 'document': 'Text 1'}) \
        == 'Searched Gloss for “di” in “Text 1”'
    assert describe_step('set_field', {'field': 'Gloss', 'value': 'ERG', 'refs': ['s1.w2', 's1.w3']}) \
        == 'Planned Gloss = “ERG” on 2 words'
    assert describe_step('set_field', {'field': 'Gloss', 'value': '', 'refs': ['s1.w2']}) \
        == 'Planned Gloss = “” on 1 word'
    # The tools added after the trace first shipped, which used to show raw names.
    assert describe_step('split_word', {'ref': 's1.w2', 'at': 'Ali'}) \
        == 'Planned splitting the word s1.w2 at “Ali”'
    assert describe_step('merge_words', {'refs': ['s1.w2', 's1.w3']}) == 'Planned merging 2 words into one'
    assert describe_step('append_text', {'document': 'Text 1'}) \
        == 'Planned adding text to the end of “Text 1”'
    assert describe_step('confirm', {'document': 'Text 1'}) \
        == 'Planned confirming everything awaiting review in “Text 1”'
    assert describe_step('confirm', {}) == 'Planned confirming everything awaiting review across the project'



def test_a_plan_names_what_it_counts():
    """The igt copy rules: never "item", name what is counted, from the
    references the call named."""
    assert describe_step('set_field', {'field': 'Gloss', 'value': 'ERG', 'refs': ['s1.w2.m1', 's1.w3.m2']}) \
        == 'Planned Gloss = “ERG” on 2 morphemes'
    assert describe_step('set_field', {'values': {'Translation': 'x'}, 'refs': ['s4']}) \
        == 'Planned Translation = “x” on 1 sentence'
    assert describe_step('link_entry', {'entry_form': 'kai', 'refs': ['s1.w2', 's2."kai"']}) \
        == 'Planned linking 2 words to “kai”'
    assert describe_step('unlink_entry', {'refs': ['s1.w2', 's1.w2.m1', 's1.w3.m2']}) \
        == 'Planned unlinking 1 word and 2 morphemes'
    assert describe_step('confirm', {'refs': ['s1.w2.m1'], 'document': 'Text 1'}) \
        == 'Planned confirming 1 morpheme in “Text 1”'
    assert describe_step('discard_analysis', {'refs': ['s1', 's2.w1']}) \
        == 'Planned discarding the unverified analysis of 1 sentence and 1 word'
    assert describe_step('set_field', {'field': 'Gloss', 'value': 'x', 'refs': 's1.w2'}) \
        == 'Planned Gloss = “x” on 1 word'
    assert describe_step('set_field', {'field': 'Gloss', 'value': 'x', 'refs': ['nonsense']}) \
        == 'Planned Gloss = “x” on 1 reference'


def test_summary_counts_documents_searches_and_changes():
    steps = [trace_step(TRACER, 'a', 'read_document', {'document': 'Text 1'}),
             trace_step(TRACER, 'b', 'read_document', {'document': 'Text 1'}),
             trace_step(TRACER, 'c', 'read_document', {'document': 'Text 2'}),
             trace_step(TRACER, 'd', 'search', {'pattern': 'di'}),
             trace_step(TRACER, 'e', 'project_overview', {}),
             trace_step(TRACER, 'f', 'set_field', {'field': 'Gloss', 'value': 'ERG', 'refs': ['s1.w2']},
                        planned=1)]
    assert [s['kind'] for s in steps] == [DOCUMENT, DOCUMENT, DOCUMENT, READ, 'meta', PLAN]
    assert summarize_steps(steps) == 'read 2 documents · 1 search · 1 planned change · 6 steps'
    assert summarize_steps(steps[4:5]) == '1 step'
    assert summarize_steps([]) == '0 steps'


def test_a_run_of_code_that_saved_files_counts_as_saving_not_as_a_read():
    # H8-AGENT polish: two run_code calls, one of which saved two files, read
    # "2 searches". A file saved again (code run after a fix) is one file.
    steps = [trace_step(TRACER, 'a', 'run_code', {'code': 'x'}),
             trace_step(TRACER, 'b', 'run_code', {'code': 'y'}, saved=['words.csv', 'notes.txt']),
             trace_step(TRACER, 'c', 'run_code', {'code': 'z'}, saved=['Words.csv']),
             trace_step(TRACER, 'd', 'run_code', {'code': 'w'}, failed=True, saved=['other.csv'])]
    assert 'saved' not in steps[3]
    assert summarize_steps(steps) == '1 read · saved 2 files · 4 steps'


def test_the_summary_counts_searches_apart_from_other_reads():
    # H13-PANEL: "7 searches" for 3 concordances, 2 worklists, a corpus count
    # and a consistency check. A run of code is a read, as its label says.
    steps = [trace_step(TRACER, 'a', 'concordance', {'pattern': 'di'}),
             trace_step(TRACER, 'b', 'search', {'pattern': 'di'}),
             trace_step(TRACER, 'c', 'worklist', {}),
             trace_step(TRACER, 'd', 'corpus_stats', {}),
             trace_step(TRACER, 'e', 'run_code', {'code': 'x'})]
    assert summarize_steps(steps) == '2 searches · 3 reads · 5 steps'


def test_the_summary_counts_the_changes_planned_not_the_calls():
    """The step line said "7 planned changes" (calls) over a card listing 9
    (changes). One call can stage many changes, a refused call none, and a
    later change on the same target takes one away."""
    steps = [trace_step(TRACER, 'a', 'set_field', {'field': 'Gloss'}, planned=7),
             trace_step(TRACER, 'b', 'set_field', {'field': 'Gloss'}),  # refused
             trace_step(TRACER, 'c', 'set_field', {'field': 'Gloss'}, planned=3),
             trace_step(TRACER, 'd', 'set_field', {'field': 'Gloss'}, planned=-1)]
    assert summarize_steps(steps) == '9 planned changes · 4 steps'
    assert summarize_steps(steps[1:2]) == '1 step'


def test_a_step_names_the_call_it_belongs_to():
    step = trace_step(TRACER, 'call-7', 'read_document', {'document': 'Text 1'})
    # The id is how the tab finds the tool's output in the transcript, so the
    # result is never sent twice.
    assert step == {'id': 'call-7', 'name': 'read_document', 'kind': DOCUMENT,
                    'label': 'Read “Text 1”', 'document': 'Text 1'}


def test_code_steps_read_as_reads_in_igt_and_ud():
    """The reader asked a question, not for a program: a code step is a read
    across their data, as the UMR trace already says it."""
    from plaid_agent.ud import trace as ud_trace
    for describe, tracer in ((describe_step, TRACER), (ud_trace.describe_step, ud_trace.TRACER)):
        for name in ('run_code', 'code_help'):
            assert 'code' not in describe(name, {}).lower()
            assert 'code' not in tracer.progress(name, {}).lower()


def test_a_label_never_draws_a_value_reordered_by_its_own_formatting_characters():
    """H13-TRACE-3: a search the model wrote as RLO "evil" read "live"."""
    from plaid_agent.core.trace import q
    assert q('‮evil') == '“evil”'
    assert q('a‪b‬c⁦d⁩') == '“abcd”'
    assert q(None) == '“”'


def test_a_read_whose_arguments_did_not_parse_names_no_empty_document():
    """H13-TRACE polish: arguments that did not parse labelled the read `Read “”`."""
    from plaid_agent.core.trace import read_document_label, reading_line
    assert describe_step('read_document', {}) == 'Read a document'
    assert read_document_label({}) == 'Read a document'
    assert reading_line({}) == 'Reading a document…'
    assert TRACER.progress('read_document', {}) == 'Reading a document…'
