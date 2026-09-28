"""A corpus-wide change stored as one change is found again at approval, over
the whole project (IGT's bulk_scope, UD's replace_scope). The documents it
reaches then must be the ones it reached when the plan was made: those are the
documents the plan was pinned to, checked for staleness and locked. A document
that started matching since was never checked or locked, and its change was
never on the card. So such a plan is refused as out of date, with nothing
written, and so is one that no longer reaches a document it did.
"""

import copy

import pytest

import fixtures as igt_fx
import ud_fixtures as ud_fx
from test_stale_by_sentence import _approve, APPS
from test_replaced_work_corpus import _gloss_row, _igt_ws, _replace, _store
from test_apply_lock import _lock_state

from plaid_agent.core.conversation import ConversationStore


def _writes(client, since=0):
    return [k for k, _ in client.calls[since:]
            if k not in ('lock', 'unlock', 'read', 'operation') and not k.startswith('user_data')]


def _card(client, spec):
    conv, meta = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    return conv['display'][1].get('status'), (meta or {}).get('pending')


# --- IGT --------------------------------------------------------------------------

def _second_igt_document(client):
    raw = copy.deepcopy(igt_fx.document_raw())
    raw['id'], raw['name'] = 'd2', 'Text 2'
    client._documents['d2'] = raw


def _igt_scope_plan(monkeypatch, rows):
    from plaid_agent.igt import bulk
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 1)
    client, ws = _igt_ws(monkeypatch, rows)
    _second_igt_document(client)
    _replace(ws)
    [op] = ws.ops
    assert op['kind'] == 'bulk_scope'
    return client, ws, op


def _requery(client, rows):
    """The query engine as it answers at approval: ``rows`` now match."""
    from test_replaced_work_corpus import _igt_engine
    _igt_engine(client, rows)


D1_ROWS = [_gloss_row('sp-g1', 'Ali', 'w-1'), _gloss_row('sp-x2', 'ali', 'w-2')]


def test_igt_a_scope_that_now_reaches_another_document_is_refused_as_out_of_date(monkeypatch):
    client, ws, op = _igt_scope_plan(monkeypatch, D1_ROWS)
    assert op['documents'] == ['d1']
    plan = _store(ws, client, igt_fx.PID, 'igt')
    # Someone types a matching gloss into Text 2 after the plan was made.
    _requery(client, D1_ROWS + [_gloss_row('sp-n1', 'Ali', 'w-1', doc='d2')])
    before = len(client.calls)
    spec = APPS['igt']()
    helper = _approve(spec, client, plan)
    assert not helper.done, helper.done
    [said] = helper.errors
    assert said.startswith('Nothing was written.') and '"Text 2"' in said, said
    assert said.endswith('Ask the assistant to plan again.'), said
    assert 'd2' not in said.replace('"Text 2"', '')
    assert _writes(client, before) == []
    assert _card(client, spec) == ('stale', None)


def test_igt_a_scope_that_no_longer_reaches_a_document_is_refused_as_out_of_date(monkeypatch):
    rows = D1_ROWS + [_gloss_row('sp-n1', 'Ali', 'w-1', doc='d2')]
    client, ws, op = _igt_scope_plan(monkeypatch, rows)
    assert op['documents'] == ['d1', 'd2']
    plan = _store(ws, client, igt_fx.PID, 'igt')
    _requery(client, D1_ROWS)
    before = len(client.calls)
    helper = _approve(APPS['igt'](), client, plan)
    [said] = helper.errors
    assert said.startswith('Nothing was written.') and '"Text 2"' in said, said
    assert _writes(client, before) == []


def test_igt_a_scope_that_reaches_what_it_did_writes_every_document_under_its_lock(monkeypatch):
    rows = D1_ROWS + [_gloss_row('sp-n1', 'Ali', 'w-1', doc='d2')]
    client, ws, _op = _igt_scope_plan(monkeypatch, rows)
    plan = _store(ws, client, igt_fx.PID, 'igt')
    held = []
    from plaid_agent.core import plan as core_plan
    real_flush = core_plan.TrackingBatcher.flush

    def flush(self):
        held.append((_lock_state(client, 'd1'), _lock_state(client, 'd2')))
        return real_flush(self)

    monkeypatch.setattr(core_plan.TrackingBatcher, 'flush', flush)
    helper = _approve(APPS['igt'](), client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    assert held and all(h == (True, True) for h in held), held


# --- UD ---------------------------------------------------------------------------

def _ud_rows(spans):
    return [[{'id': i, 'value': v, 'document': d, 'layer': ud_fx.LEMMA, 'tokens': [t]},
             {'id': t, 'document': d, 'begin': 0, 'end': 1}] for i, v, t, d in spans]


def _ud_engine(client, spans):
    def engine(body):
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': _ud_rows(spans)}
        return {'return': 'aggregate', 'results': []}
    client.query = engine


UD1 = [('sp-l1', 'mar', 'uw-1', 'ud1'), ('sp-l3', 'mar', 'uw-3', 'ud1')]
UD2 = [('sp-z1', 'mar', 'uw-2', 'ud2')]


def _ud_scope_plan(spans):
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    second = copy.deepcopy(ud_fx.document_raw())
    second['id'], second['name'] = 'ud2', 'Otro'
    client = ud_fx.FakeClient(documents={'ud1': ud_fx.document_raw(), 'ud2': second})
    ws = Workspace(client, load_project(client, ud_fx.PID))
    _ud_engine(client, spans)
    call_tool(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'mar', 'replacement': 'mare'})
    [op] = ws.ops
    assert op['kind'] == 'replace_scope'
    return client, ws, op


def test_ud_a_replacement_that_now_reaches_another_document_is_refused_as_out_of_date():
    client, ws, op = _ud_scope_plan(UD1)
    assert op['documents'] == ['ud1']
    plan = _store(ws, client, ud_fx.PID, 'ud')
    _ud_engine(client, UD1 + UD2)
    before = len(client.calls)
    spec = APPS['ud']()
    helper = _approve(spec, client, plan)
    assert not helper.done, helper.done
    [said] = helper.errors
    assert said.startswith('Nothing was written.') and '"Otro"' in said, said
    assert said.endswith('Ask the assistant to plan again.'), said
    assert _writes(client, before) == []
    assert _card(client, spec) == ('stale', None)


def test_ud_a_replacement_that_no_longer_reaches_a_document_is_refused_as_out_of_date():
    client, ws, op = _ud_scope_plan(UD1 + UD2)
    assert op['documents'] == ['ud1', 'ud2']
    plan = _store(ws, client, ud_fx.PID, 'ud')
    _ud_engine(client, UD1)
    before = len(client.calls)
    helper = _approve(APPS['ud'](), client, plan)
    [said] = helper.errors
    assert said.startswith('Nothing was written.') and '"Otro"' in said, said
    assert _writes(client, before) == []


def test_ud_a_replacement_that_reaches_what_it_did_writes_every_document_under_its_lock(monkeypatch):
    client, ws, _op = _ud_scope_plan(UD1 + UD2)
    plan = _store(ws, client, ud_fx.PID, 'ud')
    held = []
    from plaid_agent.core import plan as core_plan
    real_flush = core_plan.TrackingBatcher.flush

    def flush(self):
        held.append((_lock_state(client, 'ud1'), _lock_state(client, 'ud2')))
        return real_flush(self)

    monkeypatch.setattr(core_plan.TrackingBatcher, 'flush', flush)
    helper = _approve(APPS['ud'](), client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    assert held and all(h == (True, True) for h in held), held


# --- the check itself --------------------------------------------------------------

def test_a_scope_over_one_named_document_is_not_held_to_a_recorded_set():
    """A scope that names its document (a whole-document confirm, a UMR
    attribute change) records no set: it can reach nothing else."""
    from plaid_agent.core.plan import check_reach
    check_reach({'kind': 'confirm_scope', 'document_id': 'd1'}, [{'document_id': 'd1'}],
                lambda o: o.get('document_id'))


def test_the_check_names_what_was_gained_and_lost():
    from plaid_agent.core.plan import ScopeMoved, check_reach
    with pytest.raises(ScopeMoved) as e:
        check_reach({'documents': ['a', 'b']}, [{'doc': 'a'}, {'doc': 'c'}, {'doc': None}],
                    lambda o: o.get('doc'))
    assert (e.value.gained, e.value.lost) == (['c'], ['b'])


# --- UD, the version a stored replacement is pinned to ------------------------------
#
# A stored replacement's documents are pinned whole, by version, and the pin
# must be the version the replacement's query read. The project's document
# list is read once a turn, so taking the version from it pinned whatever the
# list said when the turn first read it, before or after the query.

def _ud_ws():
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    client = ud_fx.FakeClient(documents={'ud1': ud_fx.document_raw()})
    return client, Workspace(client, load_project(client, ud_fx.PID))


def _ud_replace(ws):
    from plaid_agent.ud.toolkit import call_tool
    call_tool(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'mar', 'replacement': 'mare'})
    assert [op['kind'] for op in ws.ops] == ['replace_scope']


def test_ud_an_edit_before_the_query_does_not_refuse_the_replacement():
    """The turn listed the documents, then a person edited Viaje, then the
    replacement read it. The query saw the edit, so the plan stands."""
    client, ws = _ud_ws()
    ws.documents()
    client._documents['ud1']['version'] += 1
    _ud_engine(client, UD1)
    _ud_replace(ws)
    plan = _store(ws, client, ud_fx.PID, 'ud')
    assert plan['documents'] == [{'id': 'ud1', 'name': 'Viaje', 'version': 4}]
    helper = _approve(APPS['ud'](), client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors


def test_ud_an_edit_after_the_query_refuses_the_replacement():
    """A person edits Viaje just after the replacement's query answered, and
    before the turn first lists the documents."""
    client, ws = _ud_ws()
    _ud_engine(client, UD1)
    real = client.query

    def query(body):
        out = real(body)
        if body.get('return') == 'entities':
            client._documents['ud1']['version'] += 1
        return out
    client.query = query
    _ud_replace(ws)
    plan = _store(ws, client, ud_fx.PID, 'ud')
    assert plan['documents'] == [{'id': 'ud1', 'name': 'Viaje', 'version': 3}]
    helper = _approve(APPS['ud'](), client, plan)
    [said] = helper.errors
    assert 'Document "Viaje" has changed since the plan was made' in said


def test_ud_an_edit_after_the_turn_refuses_the_replacement():
    client, ws = _ud_ws()
    _ud_engine(client, UD1)
    _ud_replace(ws)
    plan = _store(ws, client, ud_fx.PID, 'ud')
    client._documents['ud1']['version'] += 1
    helper = _approve(APPS['ud'](), client, plan)
    assert helper.errors and 'has changed since the plan was made' in helper.errors[0]
