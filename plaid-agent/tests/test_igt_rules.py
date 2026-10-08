"""igt's corpus-wide tools as rules (core/rules.py, RULE-PLANS.md R2):
replace_in_field, set_field_for_form and copy_to_orthography are one stored
change each, whatever their count, composed in plan order, found again at
approval and refused whole when they find anything else.
"""

import copy

import fixtures as igt_fx
from fixtures import FakeClient, scan_ws
from test_replaced_work_corpus import _store
from test_stale_by_sentence import APPS, _approve
import test_lost_answers as la

from plaid_agent.core import plan as core_plan
from plaid_agent.core import rules
from plaid_agent.core.conversation import ConversationStore
from plaid_agent.igt.bulk import planned_changes
from plaid_agent.igt.toolkit import call_tool

# span id -> (token id, document); the store holds each one's value now.
SPANS = {'sp-g1': ('w-1', 'd1'), 'sp-x2': ('w-2', 'd1'), 'sp-x3': ('w-3', 'd1'), 'sp-y1': ('w-2', 'd2'),
         'sp-y2': ('w-3', 'd2')}


def _engine(client, store):
    """The query engine as the core answers it now: every Gloss value held,
    each on its token (the replacement keeps the ones it changes)."""
    def query(body):
        where = body.get('where') or []
        if where and where[0][0] == 'document':
            return {'return': 'entities', 'results': [
                [{'id': d, 'version': client._documents[d]['version']}]
                for d in where[0][2]['id'] if d in client._documents]}
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [
                [{'id': sid, 'value': store[sid], 'document': doc, 'layer': igt_fx.GLOSS, 'tokens': [tok]},
                 {'id': tok, 'document': doc, 'value': 'x', 'begin': 0, 'end': 1}]
                for sid, (tok, doc) in SPANS.items() if store.get(sid)]}
        return {'return': 'aggregate', 'results': []}
    client.query = query


def _ws(store):
    client = FakeClient()
    second = copy.deepcopy(igt_fx.document_raw())
    second['id'], second['name'] = 'd2', 'Text 2'
    client._documents['d2'] = second
    w = scan_ws(client)
    w.prefer_scan = False
    _engine(client, store)
    return client, w


def _replace(w, pattern, replacement, **kw):
    return call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': pattern, 'replacement': replacement, **kw})


def _approved(client, w):
    plan = _store(w, client, igt_fx.PID, 'igt')
    helper = _approve(APPS['igt'](), client, plan)
    return plan, helper


def test_a_rule_is_one_change_whatever_it_counts_and_its_card_row_says_where():
    store = {'sp-g1': 'VASP', 'sp-x2': 'VASP.3SG', 'sp-x3': 'X', 'sp-y1': 'VASP', 'sp-y2': 'VASP'}
    client, w = _ws(store)
    out = _replace(w, 'VASP', 'ASP')
    assert out.startswith('Planned 1 change') and 'One change covering 4 values in 2 documents.' in out
    assert 'Stored as one change, found again when the user approves.' in out
    [op] = w.ops
    assert op['label'] == ('Gloss: replace "VASP" with "ASP" (part of a value), 4 values in 2 documents, '
                           '4 of them replace accepted work')
    payload = w.plan_payload()
    [row] = payload['changes']
    assert row['change'] == 'Gloss "VASP" → "ASP"' and row['rule']['total'] == 4
    assert [(name, n) for _d, name, n in row['rule']['documents']] == [('Text 1', 2), ('Text 2', 2)]
    assert len(row['rule']['sample']) == 4 and all(s['change'] for s in row['rule']['sample'])
    assert 'card' not in payload['ops'][0] and 'labels' not in payload
    # The same rule asked again is the same one change.
    _replace(w, 'VASP', 'ASP')
    assert len(w.ops) == 1


def test_rules_compose_in_plan_order_when_staged_and_when_approved():
    store = {'sp-g1': 'X', 'sp-x2': 'Y', 'sp-x3': 'Q'}
    client, w = _ws(store)
    _replace(w, 'X', 'Y', whole=True)
    out = _replace(w, 'Y', 'Z', whole=True)
    assert 'One change covering 2 values in 1 document.' in out, out
    assert {o['span_id']: o['value'] for o in planned_changes(w) if o['value'] == 'Z'} == {'sp-g1': 'Z', 'sp-x2': 'Z'}
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-g1': 'Z', 'sp-x2': 'Z'}


def test_a_rule_rewrites_an_earlier_planned_value_and_a_later_one_wins():
    store = {'sp-g1': 'Ali', 'sp-x2': 'Ali.PL'}
    client, w = _ws(store)
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali.DU'})
    out = _replace(w, 'Ali', 'Bob')
    assert '1 planned change rewritten by this one.' in out, out
    explicit = w.ops[0]
    assert explicit['value'] == 'Bob.DU' and explicit['label'].endswith('Gloss "Ali" → "Bob.DU"'), explicit
    # The rule leaves the value the plan names by itself to that change.
    assert w.ops[1]['count'] == 1
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'mine'})
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    # w2's value is the later change's, made as a new value of its own.
    assert dict(client.updates('spans')) == {'sp-g1': 'Bob.DU'}
    assert [c['args'][2] for c in client.payloads('spans.create')] == ['mine']


def test_dropping_an_earlier_rule_finds_the_later_ones_again():
    store = {'sp-g1': 'X', 'sp-x2': 'Y'}
    client, w = _ws(store)
    _replace(w, 'X', 'Y', whole=True)
    _replace(w, 'Y', 'Z', whole=True)
    assert w.ops[1]['count'] == 2
    call_tool(w, 'drop_planned', {'indexes': [1]})
    [rule] = w.ops
    assert rule['count'] == 1 and '1 value in 1 document' in rule['label']
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-x2': 'Z'}


def test_an_approved_rule_writes_every_value_verified_under_one_operation():
    store = {sid: 'VASP' for sid in SPANS}
    client, w = _ws(store)
    _replace(w, 'VASP', 'ASP')
    plan, helper = _approved(client, w)
    assert not helper.errors and helper.done[-1]['kind'] == 'applied', helper.errors
    assert dict(client.updates('spans')) == {sid: 'ASP' for sid in SPANS}
    stamps = {sid: {o['path'][0]: o.get('value') for o in ops if o['op'] == 'set'}
              for sid, ops in client.patches('spans')}
    assert set(stamps) == set(SPANS)
    assert all(s['prov'] == 'inferred' and s['provConfirmed'] is True and s['provSource'] == 'service:igt:assist:fake'
               for s in stamps.values()), stamps
    [tag] = [t for t in client.operation_tags if t['kind']]
    assert tag['kind'] == 'assistant-plan' and tag['ref'].startswith(f'conv:c1/plan:{plan["id"]}/')


def test_a_rule_that_matches_differently_at_approval_refuses_the_whole_plan_and_says_why():
    store = {sid: 'VASP' for sid in SPANS}
    client, w = _ws(store)
    _replace(w, 'VASP', 'ASP')
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s2.w1'], 'field': 'Gloss', 'value': 'other'})
    plan = _store(w, client, igt_fx.PID, 'igt')
    # Another user glosses one more VASP in Text 2 before the user approves.
    SPANS['sp-new'] = ('w-1', 'd2')
    store['sp-new'] = 'VASP'
    try:
        before = len(client.writes)
        helper = _approve(APPS['igt'](), client, plan)
    finally:
        del SPANS['sp-new']
    [said] = helper.errors
    assert said == ('Nothing was written. Gloss "VASP" → "ASP" now matches 6 places in 2 documents, not the 5 '
                    'shown when it was planned (1 more in "Text 2"). Ask the assistant to plan again.'), said
    assert [k for k, _ in client.writes[before:] if not k.startswith('user_data')] == []
    conv, _ = ConversationStore(client, 'u@x', igt_fx.PID, 'igt').load('c1')
    item = conv['display'][1]
    assert item['status'] == 'stale' and item['reason'].startswith('Gloss "VASP" → "ASP" now matches 6 places')
    assert 'Nothing was written' in conv['messages'][-1]['content']


def test_a_rule_past_the_plans_change_limit_is_refused_when_staged(monkeypatch):
    monkeypatch.setattr(rules, 'PLAN_MAX_CHANGES', 3)
    store = {sid: 'VASP' for sid in SPANS}
    _client, w = _ws(store)
    out = _replace(w, 'VASP', 'ASP')
    assert 'more than the 3 one plan may make' in out and not w.ops


def test_a_rule_stopped_partway_counts_the_values_it_wrote(monkeypatch):
    from test_one_change_per_batch import _budget
    store = {sid: 'VASP' for sid in SPANS}
    client, w = _ws(store)
    _replace(w, 'VASP', 'ASP')
    plan = _store(w, client, igt_fx.PID, 'igt')
    _budget(monkeypatch, 2)
    real = core_plan.Batcher.flush
    sent = []

    def second_fails(self):
        if self._batch is not None or any(self._bulk.values()):
            sent.append(1)
            if len(sent) == 2:
                raise la._lost()
        return real(self)
    monkeypatch.setattr(core_plan.Batcher, 'flush', second_fails)
    helper = _approve(APPS['igt'](), client, plan)
    [done] = helper.done
    assert done['message'].startswith('Partly applied: 2 of 5 changes written.'), done


# --- REV-RULES-1 ---------------------------------------------------------------------

def test_a_rule_in_one_document_leaves_a_value_planned_in_another_as_it_is():
    store = {'sp-g1': 'VASP', 'sp-y1': 'VASP'}
    client, w = _ws(store)
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'VASP.X'})
    out = _replace(w, 'VASP', 'ASP', document='d2')
    assert 'rewritten' not in out, out
    assert w.ops[0]['value'] == 'VASP.X'


def test_a_value_two_rules_change_is_counted_once_and_written_once():
    store = {'sp-g1': 'X', 'sp-x2': 'X.Y', 'sp-x3': 'Q'}
    client, w = _ws(store)
    _replace(w, 'X', 'A', whole=True)
    _replace(w, r'\bX\b', 'B', regex=True)
    _replace(w, 'Y', 'Z')
    payload = w.plan_payload()
    # X → A takes sp-g1 alone, \bX\b finds X.Y and Y → Z writes what both leave.
    assert [r['rule']['total'] for r in payload['changes']] == [1, 0, 1], payload['changes']
    assert payload['summary'] == ('Gloss "X" → "A" (1 value), Gloss "Y" → "Z" (1 value)')
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    assert client.updates('spans') == [('sp-g1', 'A'), ('sp-x2', 'B.Z')]


def test_a_rule_counts_what_it_writes_after_a_value_named_later():
    store = {'sp-g1': 'VASP', 'sp-x2': 'VASP', 'sp-x3': 'VASP'}
    client, w = _ws(store)
    _replace(w, 'VASP', 'ASP')
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'mine'})
    payload = w.plan_payload()
    assert payload['changes'][0]['rule']['total'] == 2
    assert payload['summary'] == 'Gloss "VASP" → "ASP" (2 values), 1 field value', payload['summary']
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    # w2's value is the named one, made as a value of its own (the fake
    # document holds no span there).
    assert dict(client.updates('spans')) == {'sp-g1': 'ASP', 'sp-x3': 'ASP'}
    assert [c['args'][2] for c in client.payloads('spans.create')] == ['mine']


def test_a_rule_and_a_merge_of_what_it_changes_refuse_each_other():
    store = {'sp-x3': 'VASP'}
    client, w = _ws(store)
    _replace(w, 'VASP', 'ASP')
    out = call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    assert 'writes to something this plan deletes' in out and len(w.ops) == 1, out
    client, w = _ws(store)
    call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    out = _replace(w, 'VASP', 'ASP')
    assert 'writes to something this plan deletes' in out and len(w.ops) == 1, out


def test_a_regular_expression_is_said_as_a_person_reads_it():
    store = {'sp-g1': 'RL', 'sp-x2': 'RL.3'}
    client, w = _ws(store)
    _replace(w, r'\bRL\b', 'REAL', regex=True)
    [row] = w.plan_payload()['changes']
    assert row['change'] == 'Gloss "RL" as a whole word → "REAL"'
    assert row['label'].startswith('Gloss: replace "RL" as a whole word with "REAL", 2 values')
    assert rules.pattern_words(r'^RL$', True) == ('"RL" as the whole value', False)
    assert rules.pattern_words(r'R(L|X)', True) == ('matching "R(L|X)"', True)


def test_a_sample_of_changes_that_all_replace_work_is_spread_over_the_documents():
    ops = [{'doc': d, 'i': i} for d in ('a', 'b', 'c') for i in range(10)]
    picked = rules.sample(ops, lambda o: o['doc'], lambda o: 1, n=6)
    assert sorted({o['doc'] for o in picked}) == ['a', 'b', 'c'] and len(picked) == 6
