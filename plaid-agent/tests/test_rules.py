"""Rule-shaped plans (core/rules.py, design RULE-PLANS.md, Luke's rulings of
2026-10-08): one stored change standing for many, what it matched kept as a
count and a digest per document, refused whole at approval when it matches
anything else, with a sentence that says what changed and where.
"""

import json

import pytest

from plaid_agent.core import rules
from plaid_agent.core.conversation import SETTLED_ROWS_MAX, compact_plan, proposed_changes
from plaid_agent.core.limits import PLAN_MAX_CHANGES, PLAN_MAX_DOCUMENTS
from plaid_agent.core.plan import (COMPACT_ABOVE, EXPANSION, Expansion, PlanOutOfDate, labelled, pack_found,
                                   unpack_found)
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

def _uuid(n):
    import uuid
    return str(uuid.UUID(int=(0x0192_0000_0000_7000_8000_0000_0000_0000 + n * 7919)))


def test_a_packed_expansion_gives_back_the_same_changes_in_the_same_order():
    ops = []
    for i in range(30):
        ops.append({'kind': 'respell', 'text_id': 't', 'begin': i * 5, 'end': i * 5 + 3, 'value': f'w{i}', 'doc': 'd1'})
        if i % 3 == 0:
            ops.append({'kind': 'set_morpheme_form', 'morpheme_id': _uuid(1000 + i), 'form': f'f{i}', 'doc': 'd1',
                        'existing': {'ids': [1, 2], 'note': None}})
    ops += [{'kind': 'set_span', 'layer_id': 'g', 'token_id': _uuid(i), 'span_id': None if i % 4 else _uuid(500 + i),
             'value': 'ASP' if i % 2 else 'ASP.3SG', 'doc': _uuid(9000 + i % 3),
             **({'virtual_at': 2} if i == 7 else {})}
            for i in range(40)]
    known = [_uuid(9000), _uuid(9001), 'ASP']
    packed = pack_found(ops, known)
    # A key a change does not carry stays missing, None stays None, and a
    # nested value comes back equal.
    assert unpack_found(packed, known) == ops
    assert set(packed) == {'n', 'z', 'fp'} and packed['n'] == len(ops)
    assert pack_found([], known)['n'] == 0 and unpack_found(pack_found([], known), known) == []


def test_a_packed_expansion_costs_ids_not_repeated_values():
    ops = [{'kind': 'set_span', 'layer_id': 'gloss-layer', 'token_id': _uuid(2 * i), 'span_id': _uuid(2 * i + 1),
            'value': 'ASP.3SG' if i % 3 else 'ASP', 'doc': _uuid(9000 + i % 12)} for i in range(2000)]
    packed = pack_found(ops, [_uuid(9000 + d) for d in range(12)])
    # Two ids a change, packed: well under the 45 bytes a change asked for.
    assert len(json.dumps(packed)) / len(ops) < 45


def test_a_packed_expansion_that_does_not_read_back_refuses():
    ops = [_span('t1', 'a', 'b')]
    packed = pack_found(ops, ['d1'])
    # Read with other known values, the indexes name other values.
    with pytest.raises(ValueError, match='does not read back'):
        unpack_found(packed, ['d2', 'x'])
    with pytest.raises(ValueError, match='does not read back'):
        unpack_found({**packed, 'fp': '0' * 16}, ['d1'])


def test_an_expansion_names_what_the_rule_holds_and_drops_what_is_shown():
    plan = {}
    ex = Expansion(plan, lambda: None)
    op = {'kind': 'bulk_scope', '_row': 0, 'args': {'pattern': 'VASP'}, 'matched': [['d1', 2, 'x']]}
    found = [{**_span(f't{i}', 'VASP', 'ASP'), '_row': 0, '_member': i} for i in range(2)]
    ex.record(op, found)
    back = ex.recorded(op)
    assert [o['token_id'] for o in back] == ['t0', 't1']
    assert all('label' not in o and 'change_at' not in o and '_row' not in o and '_member' not in o for o in back)
    assert 'd1' not in plan[EXPANSION]['0']['z']


def test_an_expansion_is_kept_by_row_and_read_back_once_recorded():
    plan, saved = {}, []
    ex = Expansion(plan, lambda: saved.append(dict(plan)))
    op = {'kind': 'bulk_scope', '_row': 2}
    assert ex.recorded(op) is None
    found = [_span(f't{i}', 'a', 'b') for i in range(COMPACT_ABOVE + 5)]
    ex.record(op, found)
    ex.save()
    ex.save()
    assert len(saved) == 1 and list(plan['expansion']) == ['2']
    back = ex.recorded(op)
    assert [o['token_id'] for o in back] == [o['token_id'] for o in found]
    ex.forget()
    assert 'expansion' not in plan


def test_an_expansion_keeps_only_what_the_run_writes_and_a_run_again_writes_the_same():
    from types import SimpleNamespace
    from plaid_agent.core import opkind as ok
    from plaid_agent.core.plan import expanding
    found = {'r1': [_span(f't{i}', 'A', 'B') for i in range(6)], 'r2': [_span(f't{i}', 'B', 'C') for i in range(3)]}
    reg = ok.registry([ok.OpKind('scope', ('change', 'changes'), resolve=lambda ctx, op: list(found[op['tool']]),
                                 shape=ok.SCOPE, stage=ok.RESOLVED),
                       ok.OpKind('set_span', ('value', 'values'))])
    ops = [{'kind': 'scope', 'tool': 'r1', 'matched': [], '_row': 0}, {'kind': 'set_span', 'token_id': 't5', '_row': 1},
           {'kind': 'scope', 'tool': 'r2', 'matched': [], '_row': 2}]

    def keep(o):
        return o.get('token_id') != 't5' or o.get('kind') != 'set_span' or '_member' not in o

    def final(out):
        # The later rule's value wins (igt's later_rule_wins).
        later = {o['token_id'] for o in out if o.get('_row') == 2}
        return [o for o in out if not (o.get('_row') == 0 and o['token_id'] in later)]
    plan = {}
    client = SimpleNamespace()
    with expanding(client, Expansion(plan, lambda: None)):
        first = ok.resolve_ops(reg, SimpleNamespace(client=client), ops, keep, final=final)
    assert [(o.get('_row'), o['token_id']) for o in first] == [(0, 't3'), (0, 't4'), (1, 't5'), (2, 't0'), (2, 't1'),
                                                                (2, 't2')]
    # The first rule's changes a later one takes, and the one the plan names,
    # are not kept.
    assert plan[EXPANSION]['0']['n'] == 2 and plan[EXPANSION]['2']['n'] == 3
    found.clear()  # a run again reads nothing from the corpus
    with expanding(client, Expansion(plan, lambda: None)):
        again = ok.resolve_ops(reg, SimpleNamespace(client=client), ops, keep, final=final)
    strip = lambda os: [{k: v for k, v in o.items() if k not in ('label', 'change_at', '_member')}  # noqa: E731
                        for o in os]
    assert strip(again) == strip(first)
