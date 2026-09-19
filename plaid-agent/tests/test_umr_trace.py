"""Every declared tool has words of its own in the trace.

A tool with no line falls back to its own name, which reaches the reader as
`set_attributes` in a list of sentences. The fallback is worth keeping for a
tool added mid-change; it is not worth shipping.
"""

from plaid_agent.umr.toolkit import TOOLS
from plaid_agent.umr.trace import TRACER, describe_step

NAMES = sorted(t['function']['name'] for t in TOOLS)


def test_every_tool_is_described_in_the_past_tense():
    bare = [name for name in NAMES if describe_step(name, {}) == name.replace('_', ' ')]
    assert not bare, ('these tools fall back to their own name in the trace: '
                      + ', '.join(bare))


def test_every_tool_has_a_progress_line_or_the_planning_fallback():
    for name in NAMES:
        line = TRACER.progress(name, {})
        assert line and not line.startswith(f'{name}…'), name


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
