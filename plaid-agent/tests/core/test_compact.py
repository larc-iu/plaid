"""Storing a large plan: like ops fold into one op and unfold again."""

from plaid_agent.core.plan import COMPACT_ABOVE, compact_ops, expand_ops

SPEC = {'set': {'each': ('token', 'ref'),
                'label': lambda first, members: f'{first["value"]} on {len(members)}'}}


def _ops(n, value='x', layer='L'):
    return [{'kind': 'set', 'layer': layer, 'value': value, 'token': f't{i}', 'ref': f'r{i}', 'label': f'op {i}'}
            for i in range(n)]


def test_a_small_group_is_left_alone():
    ops = _ops(COMPACT_ABOVE)
    assert compact_ops(ops, SPEC) == ops


def test_a_large_group_becomes_one_op_and_expands_back():
    ops = _ops(COMPACT_ABOVE + 1)
    stored = compact_ops(ops, SPEC)
    assert len(stored) == 1
    assert stored[0]['count'] == COMPACT_ABOVE + 1 and stored[0]['compact']
    assert stored[0]['label'] == f'x on {COMPACT_ABOVE + 1}'
    assert stored[0]['items']['token'] == [f't{i}' for i in range(COMPACT_ABOVE + 1)]
    back = expand_ops(stored)
    assert [{k: v for k, v in op.items() if k != 'label'} for op in back] == \
        [{k: v for k, v in op.items() if k != 'label'} for op in ops]


def test_groups_keep_the_order_of_first_appearance_and_other_kinds_stay_put():
    a = _ops(20, value='a')
    b = _ops(20, value='b')
    other = {'kind': 'other', 'label': 'o'}
    ops = [a[0], other, b[0]] + a[1:] + b[1:]
    stored = compact_ops(ops, SPEC)
    assert [op.get('value', op['kind']) for op in stored] == ['a', 'other', 'b']
    assert expand_ops([other]) == [other]


def test_a_key_the_spec_did_not_foresee_keeps_an_op_out_of_the_group():
    """Grouping is by every key that is not per-member, so nothing an op
    carries is ever dropped by being folded into a group."""
    ops = _ops(20)
    ops[3]['extra'] = {'nested': [1, 2]}
    stored = compact_ops(ops, SPEC)
    assert len(stored) == 2
    assert stored[0]['count'] == 19 and stored[1] == ops[3]
