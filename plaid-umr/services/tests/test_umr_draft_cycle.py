"""A drafted graph that closes a cycle UMR does not allow (one through any
role but ``:quote`` and ``:modal-predicate``) is refused for that sentence
alone, with the reason, as the canvas and Text mode refuse such an edge
(REV-FX-CORE F4). The run's other sentences are written: a failure is per
sentence (``validate_graph`` in the reply loop)."""

import pathlib

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
