"""What the trace beside a reply says a UD tool did.

The browser renders whatever the service sends, so a tool added without a line
here shows up in the tab as a bare function name. :mod:`plaid_agent.ud.trace`
names this file for that guarantee, and the file did not exist: these tests
lived under the prompt's and under IGT's.
"""

from plaid_agent.core.trace import DOCUMENT, PLAN, summarize_steps, trace_step
from plaid_agent.ud.toolkit import TOOLS
from plaid_agent.ud.trace import TRACER, describe_step


def test_every_declared_tool_has_a_line_of_its_own():
    """A tool described only by its own name has been added without a word for
    it, which the user then reads in the trace."""
    nameless = []
    for t in TOOLS:
        name = t['function']['name']
        if describe_step(name, {}) == name.replace('_', ' '):
            nameless.append(name)
    assert not nameless, 'no trace line for: ' + ', '.join(nameless)


def test_a_step_is_classified_by_what_it_was_for():
    assert TRACER.kind('read_document') == DOCUMENT
    assert TRACER.kind('set_head') == PLAN
    assert TRACER.kind('confirm') == PLAN


def test_a_tool_both_apps_declare_is_the_same_kind_in_both():
    """Each app listed its own bookkeeping tools, and the lists drifted:
    query_help was META in IGT and READ here, so the same reference page
    counted as a look at the data in one Assistant tab and not in the other.
    One list in core answers it for both apps."""
    from plaid_agent.core.trace import META
    from plaid_agent.igt.toolkit import TOOLS as IGT_TOOLS
    from plaid_agent.igt.trace import TRACER as IGT_TRACER

    assert TRACER.kind('query_help') == META
    shared = sorted({t['function']['name'] for t in TOOLS}
                    & {t['function']['name'] for t in IGT_TOOLS})
    assert shared, 'the two tool tables share nothing, so this proves nothing'
    differ = [(n, IGT_TRACER.kind(n), TRACER.kind(n)) for n in shared
              if IGT_TRACER.kind(n) != TRACER.kind(n)]
    assert not differ, f'the same tool is two kinds: {differ}'


def test_the_trace_reads_as_past_tense_lines():
    assert describe_step('set_head', {'ref': 's1.w2', 'head': 4, 'deprel': 'case'}) \
        == 'Planned s1.w2 as case of word 4'
    assert describe_step('set_head', {'ref': 's1.w1', 'head': 0}) \
        == 'Planned s1.w1 as the sentence root'
    assert describe_step('set_field', {'field': 'lemma', 'value': 'ir', 'refs': ['s1.w1'],
                                       'document': 'Viaje'}) \
        == 'Planned lemma = “ir” on 1 word in “Viaje”'
    assert describe_step('confirm', {'document': 'Viaje'}) \
        == 'Planned confirming everything awaiting review in “Viaje”'


def test_the_summary_counts_documents_and_plans_apart():
    steps = [trace_step(TRACER, 'a', 'read_document', {'document': 'Viaje'}),
             trace_step(TRACER, 'b', 'set_head', {'ref': 's1.w2', 'head': 1, 'deprel': 'det'})]
    assert summarize_steps(steps) == 'read 1 document · 1 planned change · 2 steps'


def test_every_declared_tool_has_a_progress_line_of_its_own():
    """The same guarantee for the PRESENT tense: the list the panel ticks
    through while a turn runs comes from progress_label, which has a fallback
    to a bare function name of its own."""
    missing = [t['function']['name'] for t in TOOLS
               if TRACER.progress(t['function']['name'], {}) == f"{t['function']['name']}…"]
    assert missing == [], f'no progress line for: {missing}'
