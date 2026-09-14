"""The half of a workspace that is the same whatever an app annotates."""

import pytest

from plaid_agent.core import opkind as ok
from plaid_agent.core.tools import ToolError
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


class StagingWorkspace(BaseWorkspace):
    """Two kinds: one that writes to a token, one that deletes it."""

    KIND = ok.registry([
        ok.OpKind('set_value', ('value', 'values'), apply=lambda ctx, op: 1,
                  token_keys=('id',), target=lambda op: ('value', op.get('id'))),
        ok.OpKind('drop_it', ('removal', 'removals'), apply=lambda ctx, op: 1,
                  target=lambda op: ('value', op.get('id')),
                  deletes_tokens=lambda op: [op['id']]),
    ])


def test_a_batch_that_refuses_half_way_stages_none_of_it():
    """`add_ops` pre-checks each op against the plan as it stands, but the loop
    that stages them can still refuse: an app guard that turns on what the
    batch holds, or a clash with the batch's OWN earlier ops. That left part of
    the batch in the plan behind an error the model was told was a failure."""
    class Refuses(StagingWorkspace):
        def guard_op(self, op, replacing=None):
            if op.get('id') == 'c':
                raise ToolError('not that one')

    ws = Refuses(None, None)
    ws.add_op({'kind': 'set_value', 'id': 'a', 'label': 'first'})
    before = list(ws.ops)
    with pytest.raises(ToolError, match='not that one'):
        ws.add_ops([{'kind': 'set_value', 'id': 'b', 'label': 'b'},
                    {'kind': 'set_value', 'id': 'c', 'label': 'c'}])
    assert ws.ops == before
    assert (ws.replaced, ws.reported_replaced) == (0, 0)


def test_a_rollback_forgets_what_the_plan_was_known_to_delete():
    """The watermark over `certainly_gone` is a length, and a restore can land
    on the length it holds with different ops under it."""
    ws = StagingWorkspace(None, None)
    ws.add_op({'kind': 'set_value', 'id': 'a', 'label': 'first'})
    assert ws.certainly_gone() == set()
    with pytest.raises(RuntimeError):
        with ws.staging():
            # It writes to the same target, so it REPLACES the op above and the
            # plan comes back to the length the watermark holds.
            ws.add_op({'kind': 'drop_it', 'id': 'a', 'label': 'gone'})
            assert ws.certainly_gone() == {'a'}
            raise RuntimeError('give up')
    assert ws.certainly_gone() == set()
