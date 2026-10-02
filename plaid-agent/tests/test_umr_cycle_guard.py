"""The assistant's graph writes refuse a graph whose new edges would close a
cycle UMR does not allow, as Text mode refuses them (REV-FX-CORE F4): the
sentence is refused with the reason and nothing of it is staged, and the
other sentences of the plan are unaffected. An edge with ``:quote`` or
``:modal-predicate`` closes none."""

from umr_fixtures import SENTENCE_1_PENMAN, SENTENCE_2_PENMAN, umr_ws

from plaid_agent.umr.toolkit import call_tool


def _apply(ws, sentence, text):
    return call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': sentence, 'text': text})


def test_a_new_edge_that_closes_a_cycle_is_refused_and_stages_nothing():
    ws = umr_ws()
    _apply(ws, 2, SENTENCE_2_PENMAN.replace('run-01', 'run-02'))
    staged = len(ws.ops)
    assert staged
    out = _apply(ws, 1, SENTENCE_1_PENMAN.replace(':refer-number singular',
                                                  ':refer-number singular :ARG1-of s1b'))
    assert 'would close a cycle' in out
    assert ':ARG1-of from s1d to s1b' in out
    assert len(ws.ops) == staged


def test_a_cycle_through_quote_is_planned():
    ws = umr_ws()
    out = _apply(ws, 1, SENTENCE_1_PENMAN.replace(':refer-number singular',
                                                  ':refer-number singular :quote s1b'))
    assert 'would close a cycle' not in out
    assert any(op['kind'] == 'create_edge' and op['role'] == ':quote' for op in ws.ops)
