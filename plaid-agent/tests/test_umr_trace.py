"""What the trace beside a reply says a UMR tool did. That every tool has a
line at all is tested for every app in ``test_trace.py``."""

from plaid_agent.umr.trace import TRACER, describe_step


def test_a_plan_tool_is_counted_as_planning_and_a_read_is_not():
    assert TRACER.kind('apply_penman') == 'plan'
    assert TRACER.kind('read_document') == 'document'
    assert TRACER.kind('find_nodes') == 'read'
    assert TRACER.kind('project_overview') == 'meta'


def test_a_described_call_names_what_it_touched():
    assert 'Story' in describe_step('read_document', {'document': 'Story'})
    assert 's3' in describe_step('apply_penman', {'document': 'Story', 'sentence': 3})
    assert ':aspect state' in describe_step(
        'set_attributes', {'document': 'Story', 'var': 's3e', 'line': ':aspect state'})
    assert '(s1b :before s2r)' in describe_step(
        'add_triple', {'document': 'Story', 'a': 's1b', 'rel': ':before', 'b': 's2r'})


def test_a_sentence_is_named_once_however_the_model_wrote_it():
    for sentence in (7, '7', 's7', 's7.s7a'):
        assert describe_step('apply_penman', {'sentence': sentence}) == 'Planned a new graph for s7'


def test_code_steps_read_as_reads():
    for name in ('run_code', 'code_help'):
        assert 'code' not in describe_step(name, {}).lower()
        assert 'code' not in TRACER.progress(name, {}).lower()
