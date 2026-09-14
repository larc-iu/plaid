"""The half of a workspace that is the same whatever an app annotates."""

import pytest

from plaid_agent.core import opkind as ok
from plaid_agent.core.workspace import BaseWorkspace


class AppWorkspace(BaseWorkspace):
    """An app whose value-on-a-token kind is called something else, which is
    the whole point: core holds no app's vocabulary."""

    KIND = ok.registry([ok.OpKind('put_value', ('value', 'values'), apply=lambda ctx, op: 1,
                                  target=lambda op: ('value', op.get('layer_id'), op.get('token_id')))])
    SPAN_KIND = 'put_value'


def test_planned_value_reads_the_kind_the_app_declares():
    w = AppWorkspace(None, None)
    assert w.planned_value('L', 't1', 'stored') == 'stored'
    w.add_op({'kind': 'put_value', 'layer_id': 'L', 'token_id': 't1', 'value': 'planned'})
    assert w.planned_value('L', 't1', 'stored') == 'planned'
    assert w.planned_value('L', 't2', 'stored') == 'stored'


def test_an_app_that_declares_no_such_kind_says_so():
    """Answering with the stored value would be a tool reading a value the
    plan has already changed, which is the bug this method exists to stop."""
    with pytest.raises(NotImplementedError):
        BaseWorkspace(None, None).planned_value('L', 't1', 'stored')
