"""Changes that replace a person's work fold into groups of their own, never
with free ones (Luke, 2026-10-08, revising the 2026-09-28 "never folded"
ruling, RULE-PLANS.md R7). A bulk correction of human annotation staged one
change at a time (a run_code sweep, a relinking) kept about 600 bytes a
change on the card, every row its own. Such a group's row carries how many of
a person's things its members replace, so the card states the count and
always shows it.
"""

from plaid_agent.core.plan import COMPACT_ABOVE, compact_ops
from plaid_agent.igt.changes import describe_change

import fixtures as igt_fx
from fixtures import FakeClient, scan_ws


def _spec():
    return {'set_span': {'each': ('token_id', 'span_id', 'value', 'doc'), 'label': lambda f, m: f'{len(m)} changes'}}


def test_changes_that_replace_a_persons_work_fold_into_groups_of_their_own():
    free = [{'kind': 'set_span', 'layer_id': 'g', 'token_id': f'f{i}', 'span_id': None, 'value': 'v', 'doc': 'd1',
             'label': 'x'} for i in range(COMPACT_ABOVE + 1)]
    flagged = [{**op, 'token_id': f'p{i}', 'replaces_work': 1} for i, op in enumerate(free)]
    out = compact_ops(free + flagged + flagged[:1], _spec())
    assert [(o.get('compact'), o['count'], o.get('replaces_work')) for o in out] == [
        (True, COMPACT_ABOVE + 1, None), (True, COMPACT_ABOVE + 2, COMPACT_ABOVE + 2)]


def test_a_few_flagged_changes_stay_rows_of_their_own():
    flagged = [{'kind': 'set_span', 'layer_id': 'g', 'token_id': f'p{i}', 'span_id': None, 'value': 'v',
                'doc': 'd1', 'label': 'x', 'replaces_work': 1} for i in range(COMPACT_ABOVE)]
    assert compact_ops(flagged, _spec()) == flagged


def test_the_card_row_of_a_flagged_group_states_how_many_it_replaces():
    w = scan_ws(FakeClient())
    group = {'kind': 'set_span', 'layer_id': igt_fx.GLOSS, 'compact': True, 'count': 20, 'replaces_work': 20,
             'items': {'token_id': ['w-1'] * 20}, 'doc': 'd1', 'label': 'Text 1: 20 changes'}
    assert describe_change(w, group)['replaces_work'] == 20
