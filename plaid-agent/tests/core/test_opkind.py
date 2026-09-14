"""The registry: one declaration per kind, and every table read off it."""

import pytest

from plaid_agent.core import opkind as ok


def _reg():
    return ok.registry([
        ok.OpKind('set_value', ('value', 'values'), required=('id',),
                  apply=lambda ctx, op: ctx.append(op) or 1,
                  target=lambda op: ('value', op.get('id')),
                  at=('id',), token_keys=('id',),
                  compact_each=('id', 'value')),
        ok.OpKind('drop_it', ('removal', 'removals'), required=('id',),
                  apply=lambda ctx, op: 1,
                  deletes_tokens=lambda op: [op['id']],
                  shape='reshape'),
        ok.OpKind('scope_it', ('sweep', 'sweeps'), stage=ok.RESOLVED, shape=ok.SCOPE),
    ])


def test_a_name_declared_twice_is_refused_at_import():
    with pytest.raises(ValueError, match='declared twice'):
        ok.registry([ok.OpKind('x', ('a', 'b')), ok.OpKind('x', ('c', 'd'))])


def test_every_table_is_the_registry_read_a_different_way():
    reg = _reg()
    assert ok.names(reg) == ('set_value', 'drop_it', 'scope_it')
    assert ok.required(reg) == {'set_value': ('id',), 'drop_it': ('id',), 'scope_it': ()}
    assert ok.nouns(reg)['drop_it'] == ('removal', 'removals')
    assert ok.shaped(reg, 'reshape') == ('drop_it',)
    assert ok.shaped(reg, ok.SCOPE) == ('scope_it',)
    assert ok.staged(reg, ok.BATCH) == ('set_value', 'drop_it')
    assert ok.token_keys(reg) == {'set_value': ('id',)}
    spec = ok.compact_spec(reg, label=lambda first, members: 'grouped')
    assert spec == {'set_value': {'each': ('id', 'value'), 'label': spec['set_value']['label']}}
    assert spec['set_value']['label'](None, []) == 'grouped'


def test_a_kind_that_folds_without_a_line_for_the_group_is_refused():
    reg = ok.registry([ok.OpKind('x', ('a', 'b'), compact_each=('id',))])
    with pytest.raises(ValueError, match='no line'):
        ok.compact_spec(reg)


def test_an_unknown_kind_raises_where_the_executor_asks_for_it():
    reg = _reg()
    with pytest.raises(ok.UnknownKind, match="op 3: unknown kind 'nope'"):
        ok.kind_of(reg, {'kind': 'nope'}, index=3)
    with pytest.raises(ok.UnknownKind):
        ok.kind_of(reg, 'not even an op')
    assert ok.kind_of(reg, {'kind': 'drop_it'}).noun == ('removal', 'removals')


def test_a_plan_refuses_before_a_pass_runs_what_no_pass_would_apply():
    """The three ways an op reaches the executor and is written as nothing at
    all, under an operation label saying it was applied."""
    reg = ok.registry([
        ok.OpKind('now', ('change', 'changes'), apply=lambda ctx, op: 1),
        ok.OpKind('later', ('change', 'changes'), stage='second', apply=lambda ctx, op: 1),
        ok.OpKind('never', ('sweep', 'sweeps'), stage=ok.RESOLVED, shape=ok.SCOPE),
    ])
    stages = (ok.BATCH, 'second')
    ok.check_applicable(reg, [{'kind': 'now'}, {'kind': 'later'}], stages)
    with pytest.raises(ok.UnknownKind, match='unknown kind'):
        ok.check_applicable(reg, [{'kind': 'nope'}], stages)
    with pytest.raises(ok.UnknownKind, match='resolved before'):
        ok.check_applicable(reg, [{'kind': 'never'}], stages)
    # An applier that works and a stage the caller does not run: every pass
    # skips it, nothing counts it, and the label says it was applied.
    with pytest.raises(ok.UnknownKind, match="op 2 \\(later\\): no pass of the executor applies a kind staged 'second'"):
        ok.check_applicable(reg, [{'kind': 'now'}, {'kind': 'later'}], (ok.BATCH,))


def test_what_a_plan_deletes_is_read_off_the_kinds_that_delete():
    reg = _reg()
    ops = [{'kind': 'drop_it', 'id': 't1'}, {'kind': 'set_value', 'id': 't2', 'value': 'x'}]
    assert ok.removed_tokens(reg, ops) == {'t1'}
    assert ok.removed_ids(reg, ops) == {'t1'}


def test_a_target_is_the_kind_s_own_and_a_kind_without_one_supersedes_nothing():
    reg = _reg()
    assert ok.target_of(reg, {'kind': 'set_value', 'id': 'a'}) == ('value', 'a')
    assert ok.target_of(reg, {'kind': 'drop_it', 'id': 'a'}) is None
    assert ok.target_of(reg, {'kind': 'nope'}) is None


def test_the_summary_counts_by_the_noun_the_user_reads():
    reg = _reg()
    assert ok.summarize(reg, []) == 'no changes'
    # The order the kinds first appear, unless the caller wants largest first.
    ops = [{'kind': 'drop_it'}, {'kind': 'set_value'}, {'kind': 'set_value'}]
    assert ok.summarize(reg, ops) == '1 removal, 2 values'
    assert ok.summarize(reg, ops, common_first=True) == '2 values, 1 removal'
    # A stored group and a scope stand for what they carry.
    assert ok.summarize(reg, [{'kind': 'scope_it', 'count': 7}], ok.stored_count) == '7 sweeps'
    assert ok.summarize(reg, [{'kind': 'set_value', 'compact': True, 'count': 3}], ok.stored_count) == '3 values'


def test_a_kind_may_count_as_something_other_than_its_own_noun():
    reg = ok.registry([ok.OpKind('set_value', ('value', 'values'),
                                 summary=lambda op, n: [(('cleared value', 'cleared values'), n)]
                                 if not op.get('value') else [(('value', 'values'), n)])])
    assert ok.summarize(reg, [{'kind': 'set_value'}]) == '1 cleared value'
    assert ok.summarize(reg, [{'kind': 'set_value', 'value': 'x'}]) == '1 value'


def test_an_undeclared_kind_shows_its_identifier_rather_than_vanishing():
    """Nothing here refuses a plan, so a kind the summary does not know must
    still appear in the line the user reads."""
    assert ok.summarize(_reg(), [{'kind': 'mystery'}]) == '1 mystery'


def test_a_noun_that_collides_with_what_rides_beside_the_counts_is_refused():
    """An executor returns per-kind counts keyed by plural noun, with the
    changes it dropped beside them under "notes". A kind counted as notes
    would be overwritten by that list, and found by whoever added the kind
    rather than by the code."""
    with pytest.raises(ValueError, match='dropped changes'):
        ok.registry([ok.OpKind('set_note', ('note', 'notes'))])
