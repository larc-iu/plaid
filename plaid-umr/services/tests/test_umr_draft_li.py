"""``:li`` takes a whole number, as in AMR, or a quoted label, as the UMR
guidelines write it (decided 2026-09-28): the draft service's validator reads
the inventory, so a model's ``:li 1``, ``:li -1`` or ``:li "(a)"`` is drafted
and ``:li first`` is refused with the reason, as the app refuses it."""

import pathlib

import pytest
from plaid_client import testing as servicetest

SERVICES = pathlib.Path(__file__).resolve().parent.parent

umr = servicetest.load_service(SERVICES / 'umr_draft_llm.py')


def _graph(value):
    return umr.parse_penman(f'(v1 / and :op1 (v2 / rice :li {value}) '
                            f':op2 (v3 / bean :li 2))')


@pytest.mark.parametrize('value', ['1', '-1', '12', '"(a)"'])
def test_a_number_under_li_is_drafted(value):
    assert umr.validate_graph(_graph(value)) is None


@pytest.mark.parametrize('value', ['first', '1.5'])
def test_anything_else_under_li_is_refused_with_the_reason(value):
    why = umr.validate_graph(_graph(value))
    assert why is not None
    assert 'neither a number nor a quoted label' in why
