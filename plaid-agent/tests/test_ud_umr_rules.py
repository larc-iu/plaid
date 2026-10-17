"""Rule plans R4 (P/design/RULE-PLANS.md, Luke 2026-10-08): ud's replace,
confirm and discard scopes and umr's attribute scope are rules
(core/rules.py), as igt's corpus-wide changes are. Each is stored with a
digest of what it matched in each document and a card row (``rule``: total,
documents, sample). Its documents are recorded ``rule: true``, so an edit
elsewhere in them leaves the plan standing, and approval finds the change
again and refuses the whole plan, saying what it finds now, when anything it
matched differs. A value the plan keeps out of a scope (core.keep) is no part
of it."""

import copy

import umr_fixtures as umr_fx
from test_replaced_work_corpus import _store
from test_scope_reach import _ud_engine, _writes
from test_stale_by_sentence import APPS, _approve, _layer
from ud_fixtures import LEMMA, PID, FakeClient, UPOS, document_raw, project_raw

from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool as ud_call
from plaid_agent.ud.tools import Workspace

MACHINE = {'prov': 'inferred', 'provSource': 'service:ud:parse'}


def _doc(machine=('sp-u3', 'sp-u1', 'sp-u4')):
    doc = document_raw()
    for sp in _layer(doc, UPOS)['spans']:
        if sp['id'] in machine:
            sp['metadata'] = dict(MACHINE)
    return doc


def _ud(doc=None):
    client = FakeClient(project=project_raw(), documents={'ud1': doc or _doc()})
    return client, Workspace(client, load_project(client, PID))


def _span(client, sid):
    return next(sp for sp in _layer(client._documents['ud1'], UPOS)['spans'] if sp['id'] == sid)


def _edit(client, fn):
    fn(client._documents['ud1'])
    client._documents['ud1']['version'] += 1


def _written(client):
    """The ids of every span or relation the plan's batches wrote or
    deleted."""
    out = []
    for b in client.batches:
        for _k, args in b:
            if isinstance(args, str):
                out.append(args)
            elif isinstance(args, list):
                out += [w['id'] for w in args if isinstance(w, dict) and w.get('id')]
    return out


def _applied(helper):
    return helper.done and helper.done[-1]['kind'] == 'applied'


# --- ud: confirm and discard ----------------------------------------------------------

def test_ud_a_whole_document_confirm_is_a_rule_row_with_its_total_documents_and_a_located_sample():
    client, ws = _ud()
    ud_call(ws, 'confirm', {'document': 'Viaje', 'field': 'upos'})
    plan = ws.plan_payload()
    [op] = plan['ops']
    assert op['kind'] == 'confirm_scope' and [m[:2] for m in op['matched']] == [['ud1', 3]]
    assert 'card' not in op
    [row] = plan['changes']
    assert row['change'] == 'confirm the upos values waiting for review in "Viaje"'
    rule = row['rule']
    assert rule['total'] == 3 and rule['documents'] == [['ud1', 'Viaje', 3]]
    assert rule['kinds'] == {'confirm': 3} and rule['unit'] == ['value', 'values']
    assert [c['where']['ref'] for c in rule['sample']] == ['s1.w1', 's1.w4', 's1.w5']
    assert plan['documents'] == [{'id': 'ud1', 'name': 'Viaje', 'version': 3, 'rule': True}]


def test_ud_a_confirm_stands_over_an_edit_it_does_not_reach_and_writes_what_it_counted():
    client, ws = _ud()
    ud_call(ws, 'confirm', {'document': 'Viaje', 'field': 'upos'})
    plan = _store(ws, client, PID, 'ud')
    # A person's lemma changes: nothing the confirmation finds.
    _edit(client, lambda raw: _layer(raw, LEMMA)['spans'][0].update(value='andar'))
    helper = _approve(APPS['ud'](), client, plan)
    assert _applied(helper), helper.errors
    assert sorted(_written(client)) == ['sp-u1', 'sp-u3', 'sp-u4']


def test_ud_a_confirm_whose_value_was_repredicted_is_refused_saying_so():
    client, ws = _ud()
    ud_call(ws, 'confirm', {'document': 'Viaje', 'field': 'upos'})
    plan = _store(ws, client, PID, 'ud')
    # The parser runs again and gives another machine value: the card's
    # count is the same, the values are not.
    _edit(client, lambda raw: _span_in(raw, 'sp-u3').update(value='PROPN'))
    before = len(client.calls)
    helper = _approve(APPS['ud'](), client, plan)
    [said] = helper.errors
    assert ('Since it was planned, confirm the upos values waiting for review in "Viaje" matches other '
            'values than the 3 shown (other values in "Viaje")') in said, said
    assert said.startswith('Nothing was written.')
    assert _writes(client, before) == []


def test_ud_a_confirm_that_finds_one_more_value_is_refused_counting_it():
    client, ws = _ud()
    ud_call(ws, 'confirm', {'document': 'Viaje', 'field': 'upos'})
    plan = _store(ws, client, PID, 'ud')
    _edit(client, lambda raw: _span_in(raw, 'sp-u2a').update(metadata=dict(MACHINE)))
    helper = _approve(APPS['ud'](), client, plan)
    [said] = helper.errors
    assert 'matches 4 places in 1 document, not the 3 shown (1 more in "Viaje")' in said, said


def _span_in(raw, sid):
    return next(sp for sp in _layer(raw, UPOS)['spans'] if sp['id'] == sid)


def test_ud_a_discard_row_counts_and_samples_what_approval_writes_less_a_named_value():
    client, ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'AUX'})
    plan = ws.plan_payload()
    rule = next(c['rule'] for c in plan['changes'] if c.get('rule'))
    assert rule['total'] == 2 and rule['documents'] == [['ud1', 'Viaje', 2]]
    assert [c['where']['ref'] for c in rule['sample']] == ['s1.w4', 's1.w5']
    # The digest is of everything the discard finds: the named value wins
    # at approval, after the check.
    scope = next(op for op in plan['ops'] if op['kind'] == 'discard_scope')
    assert [m[:2] for m in scope['matched']] == [['ud1', 3]]
    helper = _approve(APPS['ud'](), client, _store(ws, client, PID, 'ud'))
    assert _applied(helper), helper.errors
    # The named AUX on s1.w1 wins over the discard there.
    assert sorted(_written(client)) == ['sp-u1', 'sp-u3', 'sp-u4']
    assert [k for b in client.batches for k, a in b if a == 'sp-u1'] == []


def test_ud_a_value_kept_out_of_a_discard_is_no_part_of_its_digest():
    """The keep takes the value out of the rule, at staging and at
    approval alike (igt's rules leave a kept value out as well). The keep
    itself pins its sentence, as a keep does in igt."""
    from plaid_agent.ud.plan import execute_plan
    client, ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    assert out.startswith('Kept'), out
    payload = ws.plan_payload()
    scope = next(op for op in payload['ops'] if op['kind'] == 'discard_scope')
    assert [m[:2] for m in scope['matched']] == [['ud1', 2]]
    # Whatever the kept value holds by then, the discard finds what it found.
    _span(client, 'sp-u3')['value'] = 'PROPN'
    execute_plan(client, payload['ops'], source='service:ud:assist:x', label='l', project=ws.project)
    assert sorted(_written(client)) == ['sp-u1', 'sp-u4']


# --- ud: a replacement with a keep ----------------------------------------------------

def test_ud_a_replacement_with_a_kept_value_is_digested_without_it():
    """Kept after the replacement was staged: the record's digest is taken
    again in the document the keep is in, without it, and approval leaves
    the kept value out whatever the query finds there by then."""
    from test_scope_reach import UD2, _ud_scope_plan
    client, ws, op = _ud_scope_plan([('sp-l3', 'mar', 'uw-3', 'ud1')] + UD2)
    staged = copy.deepcopy(op['matched'])
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'lemma', 'value': 'mar'})
    assert out.startswith('Kept'), out
    plan = _store(ws, client, PID, 'ud')
    scope = next(o for o in plan['ops'] if o['kind'] == 'replace_scope')
    assert [m[:2] for m in staged] == [['ud1', 1], ['ud2', 1]]
    assert scope['matched'] == [staged[1]]
    # The kept lemma is retyped in the index before approval.
    _ud_engine(client, [('sp-l3', 'marina', 'uw-3', 'ud1')] + UD2)
    helper = _approve(APPS['ud'](), client, plan)
    assert _applied(helper), helper.errors
    assert _written(client) == ['sp-z1']


# --- umr --------------------------------------------------------------------------------

def _umr_plan(**args):
    spec = APPS['umr']()
    client = spec['client']()
    from test_stale_by_sentence import _plan
    plan, _ = _plan(spec, client, tool=('set_attribute_for_concept', {
        'document': 'Story', 'concept': 'bark-01', 'rel': ':aspect', 'value': 'state', **args}))
    return spec, client, plan


def _umr_node(client, span_id):
    raw = client._documents['umr1']
    return next(sp for sp in _layer(raw, umr_fx.CONCEPT_LAYER)['spans'] if sp['id'] == span_id)


def test_umr_an_attribute_over_a_concept_is_a_rule_row():
    spec, client, plan = _umr_plan(overwrite=True)
    [op] = plan['ops']
    assert op['kind'] == 'attrs_scope' and [m[:2] for m in op['matched']] == [['umr1', 1]]
    [row] = plan['changes']
    assert row['change'] == ':aspect state on concept "bark-01" in "Story"'
    # Its one change takes :aspect performance from a person's node.
    assert op['replaces_accepted'] == 1 and row['replaces_work'] == 1
    rule = row['rule']
    assert rule['total'] == 1 and rule['documents'] == [['umr1', 'Story', 1]]
    assert rule['unit'] == ['node', 'nodes'] and rule['tool'] == 'set_attribute_for_concept'
    assert [c['where'].get('node') for c in rule['sample']] == ['s1b']
    [doc] = plan['documents']
    assert doc['id'] == 'umr1' and doc['rule'] is True and 'sentences' not in doc


def test_umr_a_matched_node_whose_attribute_changed_since_refuses_the_plan():
    spec, client, plan = _umr_plan(overwrite=True)
    _umr_node(client, 'mc-b')['metadata']['umr']['attrs'][0]['value'] = 'activity'
    client._documents['umr1']['version'] += 1
    helper = _approve(spec, client, plan)
    [said] = helper.errors
    assert ('Since it was planned, :aspect state on concept "bark-01" in "Story" matches other values than '
            'the 1 shown (other values in "Story")') in said, said


def test_umr_a_matched_node_given_the_value_since_refuses_the_plan_counting_none():
    spec, client, plan = _umr_plan(overwrite=True)
    _umr_node(client, 'mc-b')['metadata']['umr']['attrs'][0]['value'] = 'state'
    client._documents['umr1']['version'] += 1
    helper = _approve(spec, client, plan)
    [said] = helper.errors
    assert ('Since it was planned, :aspect state on concept "bark-01" in "Story" matches 0 places in 0 '
            'documents, not the 1 shown (1 fewer in "Story")') in said, said


def test_umr_another_attribute_on_a_matched_node_leaves_the_plan_standing():
    spec, client, plan = _umr_plan(overwrite=True)
    _umr_node(client, 'mc-b')['metadata']['umr']['attrs'].append({'rel': ':polarity', 'value': '-',
                                                                  'order': 1})
    client._documents['umr1']['version'] += 1
    helper = _approve(spec, client, plan)
    assert _applied(helper), helper.errors
    # The node's attributes as approval reads them, the change made there.
    [attrs] = [w['metadata'] for b in client.batches for _k, a in b for w in (a if isinstance(a, list) else [])
               if isinstance(w, dict) and w.get('id') == 'mc-b']
    assert 'polarity' in str(attrs) and 'state' in str(attrs) and 'performance' not in str(attrs)


# --- ud: a replacement's sample ---------------------------------------------------------

def _refs(rule):
    return [(c['where']['document_id'], c['where'].get('ref'), c['label']) for c in rule['sample']]


def test_ud_a_replacement_row_has_a_sample_placed_at_its_words():
    """Its rows came from the query, which names no word's place, so the
    row had none (FX-I-RULES judgment call 7): the sample's documents are
    read to place each at its word, as a confirm's are."""
    from test_scope_reach import UD1, _ud_scope_plan
    client, ws, _op = _ud_scope_plan(UD1 + [('sp-z1', 'mar', 'uw-5', 'ud2')])
    rule = next(c['rule'] for c in ws.plan_payload()['changes'] if c.get('rule'))
    assert rule['total'] == 3
    assert _refs(rule) == [('ud1', 's1.w1', 'lemma "mar" → "mare"'), ('ud1', 's1.w4', 'lemma "mar" → "mare"'),
                           ('ud2', 's2.w1', 'lemma "mar" → "mare"')], _refs(rule)
    assert all(c['where']['kind'] == 'token' and c['where'].get('surface') for c in rule['sample'])


def test_ud_a_value_the_plan_keeps_leaves_the_replacements_sample():
    from test_scope_reach import UD1, _ud_scope_plan
    client, ws, _op = _ud_scope_plan(UD1 + [('sp-z1', 'mar', 'uw-5', 'ud2')])
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'lemma', 'value': 'mar'})
    assert out.startswith('Kept'), out
    rule = next(c['rule'] for c in ws.plan_payload()['changes'] if c.get('rule'))
    assert rule['total'] == 2
    assert [r[:2] for r in _refs(rule)] == [('ud1', 's1.w1'), ('ud2', 's2.w1')], _refs(rule)
