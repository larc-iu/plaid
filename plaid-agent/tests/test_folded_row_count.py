"""A card row that folds many changes counts each of them when a plan stops
partway (conc-2026-09-29 REV-W-PY3 R1).

The model's 600 `set_head` calls are stored as one row, "dep on 600 words".
After a failure in the second batch, 400 of the 600 heads stood, and the card
said "Partly applied: 0 of 1 changes written". It now says "400 of 600", and
the model is told the row was written in part.
"""

import pytest

import test_stale_by_sentence as sbs
from test_one_change_per_batch import _budget, _nth_send_fails

from plaid_agent.core import plan as core_plan
from plaid_agent.core.conversation import ConversationStore, partial_note
from plaid_agent.core.opkind import MEMBER, ROW


def test_a_folded_row_expands_to_members_that_know_their_place():
    op = {'kind': 'k', 'x': 1, 'items': {'id': ['a', 'b', 'c']}, 'count': 3, 'compact': True, ROW: 4}
    assert [(m['id'], m[ROW], m[MEMBER]) for m in core_plan.expand_ops([op])] == \
        [('a', 4, 0), ('b', 4, 1), ('c', 4, 2)]
    stored = {k: v for k, v in op.items() if k != ROW}
    assert all(MEMBER not in m for m in core_plan.expand_ops([stored])), 'only at approval'


def test_the_batcher_counts_the_members_of_a_row_that_stand():
    class _Client:
        def batch(self):
            class _B:
                def submit(self):
                    return []
            return _B()
    b = core_plan.TrackingBatcher(_Client())
    ops = [{ROW: 0, MEMBER: i} for i in range(3)] + [{ROW: 1}]
    b.expect(ops)
    for op in ops[:2]:
        b.add(lambda batch: None)
        b.finish(op)
    b.flush()
    assert b.written_rows() == []
    assert b.written_members() == {0: 2}
    for op in ops[2:]:
        b.add(lambda batch: None)
        b.finish(op)
    b.flush()
    assert b.written_rows() == [0, 1]
    assert b.written_members() == {}, 'a row written whole is counted as a row'


def test_the_note_says_how_much_of_a_folded_row_was_written():
    note = partial_note(['dep on 600 words', 'lemma of s1.w1'], [1], False, 'HTTP 500',
                        parts={0: (400, 600)})
    assert 'dep on 600 words (400 of 600 written)' in note


def test_a_plan_stopped_in_a_folded_row_counts_its_changes(monkeypatch):
    spec = sbs.APPS['ud']()
    client = spec['client']()
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 1)
    plan, _ = sbs._plan(spec, client, ('set_field', {'document': 'Viaje', 'refs': ['s2.w1', 's2.w2'],
                                                      'field': 'lemma', 'value': 'x'}))
    [row] = plan['ops']
    assert row.get('compact') and row['count'] == 2, row
    _budget(monkeypatch, 1)
    _nth_send_fails(monkeypatch, 2)
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    [done] = helper.done
    assert done['message'].startswith('Partly applied: 1 of 2 changes written. '), done['message']
    assert done['applied'] == 1
    conv, _ = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    notes = [m['content'] for m in conv['messages'] if '(note)' in str(m.get('content'))]
    assert any('(1 of 2 written)' in n for n in notes), notes
