"""Rule-shaped plans (core/rules.py, design RULE-PLANS.md, Luke's rulings of
2026-10-08): one stored change standing for many, what it matched kept as a
count and a digest per document, refused whole at approval when it matches
anything else, with a sentence that says what changed and where.
"""

import pytest

from plaid_agent.core import rules
from plaid_agent.core.conversation import SETTLED_ROWS_MAX, compact_plan, proposed_changes
from plaid_agent.core.limits import PLAN_MAX_CHANGES, PLAN_MAX_DOCUMENTS
from plaid_agent.core.plan import COMPACT_ABOVE, Expansion, PlanOutOfDate, expand_ops, labelled, pack_ops
from plaid_agent.igt.plan import KIND


def _span(token, old, new, doc='d1', replaces=0):
    return {'kind': 'set_span', 'layer_id': 'g', 'token_id': token, 'span_id': f'sp-{token}', 'value': new,
            'doc': doc, '_replaces': replaces, **labelled(f'{doc} {token}', f'Gloss "{old}" → "{new}"')}


def _matched(ops):
    return rules.matched(KIND, ops, lambda o: o.get('doc'), lambda o: o.get('_replaces', 0))


NAMES = {'d1': 'Text 1', 'd2': 'Text 2', 'd4': 'Text 4'}


def _check(then, now, change='"VASP" → "ASP" in Gloss'):
    op = {'matched': _matched(then), 'change': change}
    rules.check_matched(op, _matched(now), lambda d: NAMES.get(d, d))


# --- what a rule matched -------------------------------------------------------------

def test_matched_counts_each_document_and_digests_what_it_changes_there():
    ops = [_span('t1', 'VASP', 'ASP'), _span('t2', 'VASP.3SG', 'ASP.3SG'), _span('t3', 'VASP', 'ASP', 'd2')]
    m = _matched(ops)
    assert [(d, n) for d, n, _ in m] == [('d1', 2), ('d2', 1)]
    assert all(len(digest) == 16 for _, _, digest in m)
    # The order changes are found in, and their places, do not move it.
    moved = [{**_span('t2', 'VASP.3SG', 'ASP.3SG'), 'label': 'elsewhere: Gloss "VASP.3SG" → "ASP.3SG"',
              'change_at': 11}, _span('t1', 'VASP', 'ASP'), _span('t3', 'VASP', 'ASP', 'd2')]
    assert _matched(moved) == m


def test_the_same_match_passes_the_check():
    ops = [_span('t1', 'VASP', 'ASP'), _span('t3', 'VASP', 'ASP', 'd2')]
    _check(ops, list(reversed(ops)))


def test_more_matches_in_a_document_name_the_rule_the_counts_and_the_place():
    then = [_span(f't{i}', 'VASP', 'ASP', 'd4') for i in range(29)] + [_span('u1', 'VASP', 'ASP', 'd1')]
    now = then + [_span(f'n{i}', 'VASP', 'ASP', 'd4') for i in range(2)]
    with pytest.raises(PlanOutOfDate) as e:
        _check(then, now)
    assert e.value.reasons == ['"VASP" → "ASP" in Gloss now matches 32 places in 2 documents, not the 30 shown '
                               'when it was planned (2 more in "Text 4")']


def test_a_document_gained_or_lost_and_a_value_edited_are_each_named():
    then = [_span('t1', 'VASP', 'ASP'), _span('t2', 'VASP', 'ASP', 'd2')]
    with pytest.raises(PlanOutOfDate) as e:
        _check(then, [_span('t1', 'VASP', 'ASP')])
    assert '1 fewer in "Text 2"' in e.value.reasons[0] and 'matches 1 place in 1 document, not the 2' in e.value.reasons[0]
    with pytest.raises(PlanOutOfDate) as e:
        _check(then, then + [_span('t9', 'VASP', 'ASP', 'd4')])
    assert '1 more in "Text 4"' in e.value.reasons[0]
    # The same count, another value: someone retyped one of them.
    with pytest.raises(PlanOutOfDate) as e:
        _check(then, [_span('t1', 'VASP.PL', 'ASP.PL'), _span('t2', 'VASP', 'ASP', 'd2')])
    assert e.value.reasons == ['"VASP" → "ASP" in Gloss now matches other values than the 2 shown when it was '
                               'planned (other values in "Text 1")']


def test_a_value_verified_since_changes_the_digest():
    with pytest.raises(PlanOutOfDate):
        _check([_span('t1', 'VASP', 'ASP')], [_span('t1', 'VASP', 'ASP', replaces=1)])


def test_a_refusal_names_at_most_three_documents():
    then = [_span('t0', 'VASP', 'ASP')]
    now = then + [_span(f't{d}', 'VASP', 'ASP', f'd{d}') for d in range(5, 10)]
    with pytest.raises(PlanOutOfDate) as e:
        _check(then, now)
    assert e.value.reasons[0].count(' more in ') == 3 and e.value.reasons[0].endswith('and 2 more documents)')


# --- what a plan may hold ------------------------------------------------------------------

def test_a_rule_counts_every_change_it_stands_for():
    rule = {'kind': 'bulk_scope', 'tool': 'replace_in_field', 'args': {}, 'counts': {'set_span': 19000},
            'count': 19000, 'matched': [], 'documents': ['d1']}
    assert rules.changes_in(KIND, [rule, _span('t1', 'a', 'b')]) == 19001
    assert rules.too_many(KIND, [rule], 1000) is None
    said = rules.too_many(KIND, [rule], 1001)
    assert said.startswith('That would bring the plan to 20,001 changes, more than the 20,000')
    docs = [f'x{i}' for i in range(PLAN_MAX_DOCUMENTS)]
    assert rules.too_many(KIND, [rule], 0, docs[:-1]) is None
    assert 'Go in passes by document' in rules.too_many(KIND, [rule], 0, docs)
    assert PLAN_MAX_CHANGES == 20000 and PLAN_MAX_DOCUMENTS == 500


def test_approval_asks_the_limits_again():
    rule = {'kind': 'bulk_scope', 'count': PLAN_MAX_CHANGES + 1, 'matched': []}
    assert rules.too_big([rule], ['d1']) == 'The plan makes 20,001 changes, more than the 20,000 one plan may make.'
    assert rules.too_big([{'kind': 'set_span'}], [f'd{i}' for i in range(501)]).startswith('The plan reaches 501')
    assert rules.too_big([rule | {'count': 5}], ['d1']) is None


# --- the card row ----------------------------------------------------------------------

def test_the_sample_puts_replaced_work_first_and_takes_evenly_down_the_documents():
    ops = ([_span(f'a{i}', 'x', 'y', 'big') for i in range(50)] + [_span(f'b{i}', 'x', 'y', 'mid') for i in range(5)]
           + [_span('c0', 'x', 'y', 'small', replaces=1)] + [_span(f'e{i}', 'x', 'y', f'e{i}') for i in range(4)])
    picked = rules.sample(ops, lambda o: o['doc'], lambda o: o.get('_replaces', 0), n=8)
    assert len(picked) == 8 and any(o['token_id'] == 'c0' for o in picked)
    assert len({o['doc'] for o in picked}) >= 4, [o['doc'] for o in picked]
    assert sum(1 for o in picked if o['doc'] == 'big') < 5


def test_the_card_lists_documents_largest_first_and_counts_the_rest():
    ops = [_span(f't{d}-{i}', 'x', 'y', f'd{d:03}') for d in range(rules.DOCUMENTS_MAX + 3) for i in range(1 + (d == 7))]
    card = rules.card({'tool': 'replace_in_field', 'args': {'a': 1}, 'counts': {'set_span': len(ops)}}, ops,
                      lambda o: o['doc'], lambda d: f'name {d}', lambda o: {'label': o['label']},
                      lambda o: 0)
    assert card['total'] == len(ops) and card['documents'][0] == ['d007', 'name d007', 2]
    assert len(card['documents']) == rules.DOCUMENTS_MAX and card['documents_more'] == [3, 3]
    assert len(card['sample']) == 8 and card['kinds'] == {'set_span': len(ops)}


# --- the record ------------------------------------------------------------------------

def _rule_row(i):
    return {'label': f'rule {i}', 'where': None, 'change': 'x', 'writes_text': False, 'replaces_work': 0,
            'rule': {'tool': 'replace_in_field', 'total': 900, 'documents': [], 'sample': []}}


def test_a_settled_plan_keeps_every_rule_row_past_the_row_cap_and_compacting_again_changes_nothing():
    rows = [{'label': f'r{i}', 'change': 'c', 'writes_text': False, 'replaces_work': 1} for i in range(250)]
    rows[3] = _rule_row(3)
    rows[230] = _rule_row(230)
    item = {'kind': 'assistant', 'status': 'discarded',
            'plan': {'id': 'p', 'changes': rows, 'ops': [{'kind': 'x'}] * 250, 'expansion': {'0': []}}}
    once = compact_plan(item)
    plan = once['plan']
    assert 'expansion' not in plan and 'ops' not in plan
    assert plan['changes'][:SETTLED_ROWS_MAX] == rows[:SETTLED_ROWS_MAX]
    assert plan['changes'][SETTLED_ROWS_MAX:] == [{'row': 230, **_rule_row(230)}]
    assert plan['omitted'] == {'count': 49, 'writes_text': 0, 'replaces_work': 49}
    assert compact_plan(once) is once


def test_a_rule_adds_its_total_to_what_a_plan_proposed_and_nothing_to_the_list():
    rule = {'kind': 'bulk_scope', 'tool': 'replace_in_field', 'count': 1240, 'matched': [['d1', 1240, 'x']]}
    out, total = proposed_changes([rule, {'kind': 'set_span', 'token_id': 't1', 'value': 'v'}],
                                  ('token_id',), ('value',))
    assert total == 1241 and out == [['set_span', 't1', 'v']]


# --- what approval records of a rule --------------------------------------------------------

def test_a_packed_expansion_gives_back_the_same_changes_in_the_same_order():
    ops = []
    for i in range(30):
        ops.append({'kind': 'respell', 'text_id': 't', 'begin': i * 5, 'end': i * 5 + 3, 'value': f'w{i}', 'doc': 'd1',
                    'label': f'w{i}'})
        if i % 3 == 0:
            ops.append({'kind': 'set_morpheme_form', 'morpheme_id': f'm{i}', 'form': f'f{i}', 'doc': 'd1',
                        'label': f'm{i}'})
    ops += [_span(f't{i}', 'a', 'b') for i in range(40)]
    packed = pack_ops(ops, KIND)
    # Runs short of a group stay as they are, in order, and the forty
    # values in a row fold into one.
    assert len(packed) == len(ops) - 40 + 1
    # A member gets every per-member key of its kind back, None where it had none.
    strip = lambda os: [{k: v for k, v in o.items() if k not in ('label', 'change_at') and v is not None}  # noqa: E731
                        for o in os]
    assert strip(expand_ops(packed)) == strip(ops)


def test_an_expansion_is_kept_by_row_and_read_back_once_recorded():
    plan, saved = {}, []
    ex = Expansion(plan, lambda: saved.append(dict(plan)))
    op = {'kind': 'bulk_scope', '_row': 2}
    assert ex.recorded(op) is None
    found = [_span(f't{i}', 'a', 'b') for i in range(COMPACT_ABOVE + 5)]
    ex.record(op, found, KIND)
    ex.save()
    ex.save()
    assert len(saved) == 1 and list(plan['expansion']) == ['2']
    back = ex.recorded(op)
    assert [o['token_id'] for o in back] == [o['token_id'] for o in found]
    ex.forget()
    assert 'expansion' not in plan
