"""A drafted graph that closes a cycle UMR does not allow (one through any
role but ``:quote`` and ``:modal-predicate``) is refused for that sentence
alone, with the reason, as the canvas and Text mode refuse such an edge
(REV-FX-CORE F4). The run's other sentences are written: a failure is per
sentence (``validate_graph`` in the reply loop)."""

import pathlib
import types

import pytest
from plaid_client import testing as servicetest

SERVICES = pathlib.Path(__file__).resolve().parent.parent

umr = servicetest.load_service(SERVICES / 'umr_draft_llm.py')


@pytest.mark.parametrize('text', [
    # An inverse role written in the stored direction closes one.
    '(v1 / thing :ARG1-of (v2 / see-01 :ARG0 (v3 / dog :ARG0 v1)))',
    '(v1 / say-01 :ARG1 (v2 / believe-01 :ARG2 v1))',
    '(v1 / dog :mod v1)',
])
def test_a_graph_that_closes_a_cycle_is_refused(text):
    why = umr.validate_graph(umr.parse_penman(text))
    assert why is not None
    assert 'would close a cycle' in why


@pytest.mark.parametrize('text', [
    '(v1 / say-01 :ARG0 (v2 / person) :ARG1 (v3 / believe-01 :ARG0 v2 :quote v1))',
    '(v1 / x :modal-predicate (v2 / y :ARG0 v1))',
    # A reentrancy that is no cycle.
    '(v1 / want-01 :ARG0 (v2 / boy) :ARG1 (v3 / go-02 :ARG0 v2))',
])
def test_a_cycle_through_a_cycle_role_or_none_at_all_is_drafted(text):
    assert umr.validate_graph(umr.parse_penman(text)) is None


# --- H39-AGENT-UMR-3 -------------------------------------------------------------

@pytest.mark.parametrize('text', [
    # The live reply (Kukama, sentence 1): one relation, once as an inverse.
    '(p2 / person :ARG0-of (g1 / go-01 :ARG0 p2))',
    # The other way round, and with the copy written first.
    '(g1 / go-01 :ARG0 (p2 / person :ARG0-of g1))',
    '(x / thing :manner (r / run-02 :actor (p / person) :manner-of x))',
])
def test_a_relation_stated_both_ways_is_one_relation_and_is_drafted(text):
    graph = umr.parse_penman(text)
    edges_before = sum(c.kind == 'node' for n in graph.nodes.values() for c in n.children)
    assert umr.validate_graph(graph) is not None
    assert umr.merge_restated_edges(graph) == 1
    assert umr.validate_graph(graph) is None
    # Only the bare copy goes: every node is still written out where it was.
    assert sum(c.kind == 'node' for n in graph.nodes.values()
               for c in n.children) == edges_before - 1
    assert len(umr.tree_edges(graph)) == len(graph.nodes) - 1


def test_the_merge_keeps_a_real_cycle_and_a_different_relation():
    graph = umr.parse_penman('(v1 / say-01 :ARG1 (v2 / believe-01 :ARG2-of v1 :ARG0 v1))')
    # :ARG2-of v1 restates nothing (v1 has :ARG1, not :ARG2), and :ARG0 v1
    # is a cycle of its own.
    assert umr.merge_restated_edges(graph) == 0
    assert 'would close a cycle' in umr.validate_graph(graph)


def test_a_cycle_is_named_by_concepts_and_words_never_by_the_replys_variables():
    """Seen live: ":ARG0-of from p2 to g1 would close a cycle." The requester
    never sees p2 or g1: stored variables are minted afresh."""
    sentence = types.SimpleNamespace(words=[types.SimpleNamespace(text=t)
                                            for t in ['ikian', 'ritama', 'utsu']])
    graph = umr.parse_penman('(p2 / person :ARG0-of (g1 / go-01 :ARG1 (t / town :mod p2)))')
    alignment = {'p2': [(1, 1)], 'g1': [(3, 3)], 't': [(2, 2)]}
    why = umr.validate_graph(graph, alignment, sentence)
    assert why == 'person ("ikian") :ARG0-of go-01 ("utsu") would close a cycle.'
    assert not any(v in why.split() for v in ('p2', 'g1', 't'))
