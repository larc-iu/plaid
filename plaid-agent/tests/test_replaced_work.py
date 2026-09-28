"""The plan card says which changes replace a person's work (ruling umr-assist-flag-accepted-work).

An approval is the person's own act, so a plan may change a sentence someone
built or accepted. The card says so in a line above the list ("3 changes
replace accepted work"), and those rows are never folded into a group of like
changes. "A person's work" is anything but unconfirmed machine output: made by
a person, by a contributor, or verified. Each app answers, per kind, which
existing things a change rewrites or removes, and the card row carries
``replaces_work``.
"""

import copy

import pytest

import fixtures as igt_fx
import ud_fixtures as ud_fx
import umr_fixtures as umr_fx

from plaid_agent.core import plan as core_plan
from plaid_agent.core.plan import compact_ops

MACHINE = {'prov': 'inferred', 'provSource': 'service:x'}
VERIFIED = {'prov': 'inferred', 'provSource': 'service:x', 'provConfirmed': True}
CONTRIBUTED = {'prov': 'contributed', 'provSource': 'user:c@x'}


def _find(raw, entity_id):
    stack = [raw]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get('id') == entity_id and ('value' in node or 'source' in node):
                return node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    raise KeyError(entity_id)


def _stamped(raw, entity_id, stamp):
    """``raw`` with one span's or relation's provenance set to ``stamp``."""
    raw = copy.deepcopy(raw)
    thing = _find(raw, entity_id)
    thing['metadata'] = {**(thing.get('metadata') or {}), **stamp}
    return raw


# --- every kind answers --------------------------------------------------------------

@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
def test_every_kind_says_what_it_replaces(app):
    """A kind added later has to answer too: leaving it out would show its
    changes as replacing nothing, whatever they replace."""
    from importlib import import_module
    kinds = import_module(f'plaid_agent.{app}.plan').KIND
    module = {'igt': 'workspace', 'ud': 'tools', 'umr': 'tools'}[app]
    ws_cls = import_module(f'plaid_agent.{app}.{module}').Workspace
    assert set(ws_cls.REPLACES) == set(kinds)


def test_a_flagged_change_is_never_folded_into_a_group(monkeypatch):
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 1)
    spec = {'set': {'each': ('id',), 'label': lambda first, members: f'{len(members)} sets'}}
    ops = [{'kind': 'set', 'id': 'a'}, {'kind': 'set', 'id': 'b', 'replaces_work': True},
           {'kind': 'set', 'id': 'c'}]
    out = compact_ops(ops, spec)
    assert out[0]['compact'] and out[0]['items'] == {'id': ['a', 'c']}
    assert out[1] == {'kind': 'set', 'id': 'b', 'replaces_work': True}


# --- UMR ---------------------------------------------------------------------------

def _umr(raw=None):
    from plaid_agent.umr.toolkit import call_tool
    client = umr_fx.umr_client(documents={'umr1': raw or umr_fx.document_raw()})
    ws = umr_fx.umr_ws(client)
    return ws, lambda name, **a: call_tool(ws, name, {'document': 'Story', **a})


def _flags(ws):
    return [c['replaces_work'] for c in ws.plan_payload()['changes']]


@pytest.mark.parametrize('stamp, flagged', [(None, True), (MACHINE, False), (VERIFIED, True),
                                            (CONTRIBUTED, True)])
def test_umr_a_concept_change_on_a_persons_node_is_flagged(stamp, flagged):
    raw = umr_fx.document_raw() if stamp is None else _stamped(umr_fx.document_raw(), 'mc-d', stamp)
    ws, run = _umr(raw)
    run('apply_penman', sentence=1, text=umr_fx.SENTENCE_1_PENMAN.replace('dog', 'cat'))
    assert _flags(ws) == [flagged]


def test_umr_adding_an_attribute_replaces_nothing_and_changing_one_does():
    ws, run = _umr()
    run('set_attributes', sentence=2, var='s2r', line=':aspect process')
    assert _flags(ws) == [False]
    ws, run = _umr()
    run('set_attributes', sentence=1, var='s1b', line=':aspect state')
    assert _flags(ws) == [True]


def test_umr_removing_a_node_or_an_edge_a_person_made_is_flagged():
    ws, run = _umr()
    run('delete_triple', a='s2t', rel=':same-entity', b='s1d')
    assert _flags(ws) == [True]
    ws, run = _umr(_stamped(umr_fx.document_raw(), 'md-1', MACHINE))
    run('delete_triple', a='s2t', rel=':same-entity', b='s1d')
    assert _flags(ws) == [False]
    # A machine node hung off by a person's relation: deleting it takes the
    # relation too.
    raw = _stamped(umr_fx.document_raw(), 'mc-d', MACHINE)
    ws, run = _umr(raw)
    run('apply_penman', sentence=1, text='(s1b / bark-01\n    :aspect performance)')
    assert [c['label'] for c in ws.plan_payload()['changes'] if c['replaces_work']] \
        == ['remove (s1d / dog) and 1 document-level relation']


def test_umr_a_concept_wide_change_is_flagged_only_where_it_takes_a_persons_value():
    ws, run = _umr()
    run('set_attribute_for_concept', concept='.', regex=True, rel=':aspect', value='state')
    assert _flags(ws) == [False]
    ws, run = _umr()
    run('set_attribute_for_concept', concept='.', regex=True, rel=':aspect', value='state',
        overwrite=True)
    assert _flags(ws) == [True]


# --- IGT ---------------------------------------------------------------------------

def _igt(raw=None):
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.toolkit import call_tool
    from plaid_agent.igt.tools import Workspace
    client = igt_fx.FakeClient(documents={'d1': raw or igt_fx.document_raw()})
    ws = Workspace(client, load_project(client, igt_fx.PID))
    return ws, lambda name, **a: call_tool(ws, name, {'document': 'd1', **a})


@pytest.mark.parametrize('stamp, flagged', [(None, True), (MACHINE, False), (VERIFIED, True)])
def test_igt_a_value_over_a_persons_value_is_flagged(stamp, flagged):
    raw = igt_fx.document_raw() if stamp is None else _stamped(igt_fx.document_raw(), 'sp-g1', stamp)
    ws, run = _igt(raw)
    run('set_field', refs=['s1.w1'], field='Gloss', value='Ali.ERG')
    assert _flags(ws) == [flagged]


def test_igt_a_value_where_there_was_none_replaces_nothing():
    ws, run = _igt()
    run('set_field', refs=['s1.w2'], field='Gloss', value='fish')
    assert _flags(ws) == [False]


def test_igt_a_link_taken_away_and_a_segmentation_redone_are_flagged():
    ws, run = _igt()
    run('unlink_entry', refs=['s1.w1.m2'])
    assert _flags(ws) == [True]
    ws, run = _igt()
    run('set_analysis', ref='s2.w1', morphemes=[{'form': 'Ga'}, {'form': 'm-ar'}])
    assert _flags(ws) == [True]
    # A word nobody has segmented: its one morpheme is the word itself.
    ws, run = _igt()
    run('set_analysis', ref='s1.w2', morphemes=[{'form': 'ga'}, {'form': 'm'}])
    assert _flags(ws) == [False]


# --- UD ----------------------------------------------------------------------------

def _ud(raw=None):
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    client = ud_fx.FakeClient(documents={'ud1': raw or ud_fx.document_raw()})
    ws = Workspace(client, load_project(client, ud_fx.PID))
    return ws, lambda name, **a: call_tool(ws, name, {'document': 'Viaje', **a})


def test_ud_a_value_over_a_persons_value_is_flagged_and_over_a_machines_is_not():
    ws, run = _ud()
    run('set_field', refs=['s1.w1'], field='lemma', value='irse')
    assert _flags(ws) == [True]
    ws, run = _ud()
    run('set_field', refs=['s1.w4'], field='upos', value='PROPN')  # sp-u3, machine-made
    assert _flags(ws) == [False]


def test_ud_a_head_that_replaces_a_persons_relation_is_flagged():
    ws, run = _ud()
    run('set_head', ref='s1.w5', head=4, deprel='punct')
    assert _flags(ws) == [True]
    ws, run = _ud(_stamped(ud_fx.document_raw(), 'r-4', MACHINE))
    run('set_head', ref='s1.w5', head=4, deprel='punct')
    assert _flags(ws) == [False]
