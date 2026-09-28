"""The assistant refuses an attribute value validate.py cannot read, as the
app's editors refuse it (``UmrDocument.attrValueProblem``: the file's form,
then ``valueGrammarProblem``), on every route a plan writes a value by. The
guard used to ask only the form, so ``:mod Big_one`` or ``:quant ""`` was
planned, and Validation reported it after."""

import pytest

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool
from plaid_client.workflows.umr.penman import value_grammar_problem

#: Values the file can hold and validate.py cannot read, with the relation.
GRAMMAR_ONLY = [(':mod', 'Big_one'), (':quant', '""'), (':mod', 's1y-x'),
                (':mod', 'café')]


def _routes(rel, value):
    """Each tool that writes an attribute value, as (name, args)."""
    new_node = SENTENCE_1_PENMAN.replace(
        ':aspect performance)', f':aspect performance\n    :ARG1 (s1z / thing\n        {rel} {value}))')
    old_node = SENTENCE_1_PENMAN.replace(':refer-number singular)',
                                         f':refer-number singular\n        {rel} {value})')
    return [
        ('set_attribute_for_concept', {'concept': 'dog', 'rel': rel, 'value': value}),
        ('set_attributes', {'sentence': 1, 'var': 's1d',
                            'line': f':refer-number singular {rel} {value}'}),
        ('apply_penman', {'sentence': 1, 'text': new_node}),
        ('apply_penman', {'sentence': 1, 'text': old_node}),
    ]


@pytest.mark.parametrize('rel,value', GRAMMAR_ONLY)
@pytest.mark.parametrize('route', range(4))
def test_a_value_validate_py_cannot_read_is_refused_on_every_route(rel, value, route):
    ws = umr_ws(umr_client())
    name, args = _routes(rel, value)[route]
    out = call_tool(ws, name, {'document': 'Story', **args})
    assert ws.ops == [], out
    assert value_grammar_problem(value, rel)['message'] in out, out


@pytest.mark.parametrize('route', range(4))
def test_a_value_it_reads_is_planned_on_every_route(route):
    ws = umr_ws(umr_client())
    name, args = _routes(':mod', 'big-one')[route]
    out = call_tool(ws, name, {'document': 'Story', **args})
    assert ws.ops, out
