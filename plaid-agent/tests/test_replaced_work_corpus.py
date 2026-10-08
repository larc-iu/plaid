"""Corpus-wide changes and the accepted-work line (ruling umr-assist-flag-accepted-work,
the two cases its first build left open, adopted by the parent as defaults).

Q1. A corpus-wide replace stored as one change (IGT's bulk_scope, UD's
replace_scope) is found again only when approved, so the values it replaces
are counted when it is staged, from the provenance its query returned. The row
is flagged, says how many, and the card's line counts them.

Q2. IGT changes staged from a query over documents the turn never loaded carry
the provenance that query returned, so they are flagged like the rest, and
their documents are pinned by sentence like a loaded one, to the version the
query saw.

And the plan-wide cap on pinned sentences, since each is stored beside the plan.
"""

import copy

import pytest

import fixtures as igt_fx
import ud_fixtures as ud_fx
from test_stale_by_sentence import _approve, _edit, _layer, APPS

from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item

MACHINE = {'prov': 'inferred', 'provSource': 'service:x'}
VERIFIED = {'prov': 'inferred', 'provSource': 'service:x', 'provConfirmed': True}


# --- IGT, a query over documents the turn never loaded ------------------------------

def _igt_engine(client, rows, versions=None):
    """A query engine for replace_in_field: ``rows`` are (span, token) pairs,
    and a document query answers each document's version as the fake holds it,
    or as ``versions`` says."""
    def query(body):
        where = body.get('where') or []
        if where and where[0][0] == 'document':
            ids = where[0][2]['id']
            return {'return': 'entities', 'results': [
                [{'id': d, 'version': (versions or {}).get(d, client._documents[d]['version'])}]
                for d in ids if d in client._documents]}
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [list(r) for r in rows]}
        return {'return': 'aggregate', 'results': []}
    client.query = query


def _gloss_row(span_id, value, token_id, metadata=None, doc='d1'):
    span = {'id': span_id, 'value': value, 'document': doc, 'layer': igt_fx.GLOSS, 'tokens': [token_id]}
    if metadata is not None:
        span['metadata'] = metadata
    return (span, {'id': token_id, 'document': doc, 'value': 'x', 'begin': 0, 'end': 1})


def _igt_ws(monkeypatch, rows, raw=None, versions=None):
    """A workspace that reaches d1 through the query engine alone: labels are
    written without loading it, as past the label budget in a large corpus."""
    from plaid_agent.igt import corpus
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    monkeypatch.setattr(corpus, 'LABEL_DOC_BUDGET', 0)
    client = igt_fx.FakeClient(documents={'d1': raw or igt_fx.document_raw()})
    _igt_engine(client, rows, versions)
    ws = Workspace(client, load_project(client, igt_fx.PID))
    ws.prefer_scan = False
    return client, ws


def _replace(ws):
    from plaid_agent.igt.toolkit import call_tool
    return call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'Bob'})


@pytest.mark.parametrize('metadata, flagged', [(None, 1), ({}, 1), (VERIFIED, 1), (MACHINE, 0)])
def test_igt_a_change_from_a_query_carries_the_provenance_the_query_returned(monkeypatch, metadata, flagged):
    _client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1', metadata)])
    _replace(ws)
    # One rule (core.rules), its count of a person's work from the query.
    assert [op['kind'] for op in ws.ops] == ['bulk_scope'] and 'd1' not in ws._docs
    assert [c['replaces_work'] for c in ws.plan_payload()['changes']] == [flagged]


def test_igt_a_document_reached_only_by_a_rule_is_recorded_as_such_and_not_read(monkeypatch):
    """What a rule matched there is checked by its digest when it is found
    again, so the document is neither read to fingerprint it nor pinned to its
    version: it is recorded with `rule: true`, at the version the query saw
    even when it moved before the turn ended."""
    client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
    _replace(ws)
    client._documents['d1']['version'] = 8
    ws.load_doc = lambda *a: pytest.fail('read a document only a rule reaches')
    [doc] = ws.plan_payload()['documents']
    assert doc == {'id': 'd1', 'name': 'Text 1', 'version': 7, 'rule': True}
    assert 'd1' not in ws._docs


def _store(ws, client, pid, app):
    plan = ws.plan_payload()
    store = ConversationStore(client, 'u@x', pid, app)
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model', service=f'{app}:assist:fake')
    conv = {'messages': [{'role': 'user', 'content': 'do it'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('do it'), item]}
    meta = build_meta(None, 'c1', conv, f'{app}:assist:fake', 'fake/model',
                      pending={'kind': 'apply', 'request_id': 'r9', 'plan_id': plan['id']})
    store.save('c1', conv, meta)
    return plan


def test_igt_a_rule_applies_after_an_edit_that_leaves_what_it_matched_and_is_refused_after_one_that_does_not(monkeypatch):
    """An edit anywhere in the document, its sentence included, leaves a
    rule as it was when it does not touch what it matched. A value it matched
    edited since refuses the whole plan, naming the rule, what it matched then
    and now, and where (Luke's ruling, 2026-10-08)."""
    spec = APPS['igt']()
    for where in ('w-4', 'w-2'):
        client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
        _replace(ws)
        plan = _store(ws, client, igt_fx.PID, 'igt')
        _edit(client, spec, lambda raw: _layer(raw, igt_fx.GLOSS)['spans'].append(
            {'id': 'sp-new', 'value': 'fish', 'tokens': [where]}))
        helper = _approve(spec, client, plan)
        assert not helper.errors, helper.errors
    client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
    _replace(ws)
    plan = _store(ws, client, igt_fx.PID, 'igt')
    _igt_engine(client, [_gloss_row('sp-g1', 'Ali.PL', 'w-1')])
    helper = _approve(spec, client, plan)
    [said] = helper.errors
    assert said == ('Nothing was written. Gloss "Ali" → "Bob" now matches other values than the 1 shown when it '
                    'was planned (other values in "Text 1"). Ask the assistant to plan again.'), said
    conv, _meta = ConversationStore(client, 'u@x', igt_fx.PID, 'igt').load('c1')
    assert conv['display'][1]['status'] == 'stale'
    assert conv['display'][1]['reason'] == said[len('Nothing was written. '):-len(' Ask the assistant to plan again.')]


# --- IGT, a corpus-wide replace stored as one change ---------------------------------

def test_igt_a_corpus_wide_replace_counts_the_accepted_values_it_replaces(monkeypatch):
    rows = [_gloss_row('sp-g1', 'Ali', 'w-1'), _gloss_row('sp-x2', 'ali', 'w-2', MACHINE),
            _gloss_row('sp-x3', 'ALI', 'w-3', VERIFIED)]
    _client, ws = _igt_ws(monkeypatch, rows)
    out = _replace(ws)
    [op] = ws.ops
    assert op['kind'] == 'bulk_scope' and op['replaces_accepted'] == 2
    assert op['label'].endswith(', 2 of them replace accepted work')
    assert '2 of them replace work a person made or accepted' in out
    # Found again when approved and checked by what it matched, so its
    # document is not read to fingerprint it.
    ws.load_doc = lambda *a: pytest.fail('read a document a stored rule reaches')
    payload = ws.plan_payload()
    [row] = payload['changes']
    assert row['replaces_work'] == 2
    assert payload['documents'] == [{'id': 'd1', 'name': 'Text 1', 'version': 7, 'rule': True}]
    # None of a machine's: no mark, no count.
    _client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-x2', 'ali', 'w-2', MACHINE),
                                        _gloss_row('sp-x3', 'ALI', 'w-3', MACHINE)])
    _replace(ws)
    assert ws.ops[0]['replaces_accepted'] == 0 and 'accepted' not in ws.ops[0]['label']
    assert ws.plan_payload()['changes'][0]['replaces_work'] == 0


# --- UD, a corpus-wide replace stored as one change ----------------------------------

def test_ud_a_corpus_wide_replace_counts_the_accepted_values_it_replaces():
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    client = ud_fx.FakeClient(documents={'ud1': ud_fx.document_raw()})
    ws = Workspace(client, load_project(client, ud_fx.PID))
    spans = [('sp-l1', 'mar', MACHINE, 'uw-1'), ('sp-l3', 'mar', None, 'uw-3'), ('sp-l4', 'Mar', VERIFIED, 'uw-4')]

    def engine(body):
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [
                [{'id': i, 'value': v, 'document': 'ud1', 'layer': ud_fx.LEMMA, 'tokens': [t],
                  **({'metadata': m} if m is not None else {})},
                 {'id': t, 'document': 'ud1', 'begin': 0, 'end': 1}] for i, v, m, t in spans]}
        return {'return': 'aggregate', 'results': []}
    client.query = engine
    out = call_tool(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'mar', 'replacement': 'mare'})
    [op] = ws.ops
    assert op['kind'] == 'replace_scope' and op['replaces_accepted'] == 2
    assert op['label'].endswith(', 2 of them replace accepted work')
    assert '2 of them replace work a person made or accepted' in out
    assert ws.plan_payload()['changes'][0]['replaces_work'] == 2


# --- a deleted entry takes a person's links ----------------------------------------------

def test_igt_deleting_an_entry_a_person_linked_is_flagged():
    from plaid_agent.igt.toolkit import call_tool
    for stamp, flagged in ((None, 1), (MACHINE, 0)):
        raw = igt_fx.document_raw()
        if stamp:
            for layer in raw['text_layers'][0]['token_layers']:
                for v in layer.get('vocabs') or []:
                    for link in v['vocab_links']:
                        link['metadata'] = stamp
        client = igt_fx.FakeClient(documents={'d1': raw})
        ws = igt_fx.scan_ws(client)
        call_tool(ws, 'delete_entry', {'entry_id': 'vi-erg'})
        assert [op['kind'] for op in ws.ops] == ['delete_entry']
        assert [c['replaces_work'] for c in ws.plan_payload()['changes']] == [flagged]


# --- the cap on pinned sentences across a plan -----------------------------------------

def test_a_plan_pins_at_most_so_many_sentences_between_its_documents(monkeypatch):
    from plaid_agent.core import workspace
    from plaid_agent.core.workspace import BaseWorkspace
    monkeypatch.setattr(workspace, 'PIN_SENTENCES_PLAN_MAX', 3)
    s = lambda n: [{'id': f'x{i}', 'print': 'p'} for i in range(n)]
    entries = [{'id': 'a', 'version': 1, 'sentences': s(3)}, {'id': 'b', 'version': 1, 'sentences': s(1)},
               {'id': 'c', 'version': 1}]
    out = BaseWorkspace.cap_pins(entries)
    # The document pinning the most goes whole first, until the rest fit.
    assert out == [{'id': 'a', 'version': 1}, {'id': 'b', 'version': 1, 'sentences': s(1)},
                   {'id': 'c', 'version': 1}]
    assert BaseWorkspace.cap_pins(entries[1:]) == entries[1:]


@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
def test_every_app_holds_its_plan_to_the_cap(app, monkeypatch):
    from test_stale_by_sentence import _plan
    from plaid_agent.core import workspace
    monkeypatch.setattr(workspace, 'PIN_SENTENCES_PLAN_MAX', 0)
    spec = APPS[app]()
    plan, _store = _plan(spec, spec['client']())
    [doc] = plan['documents']
    assert 'sentences' not in doc and doc['version'] is not None


def test_a_corpus_wide_change_past_the_cap_is_held_to_the_layers_list(monkeypatch):
    """REV-DEBT-R1 F1: past the plan cap a corpus-wide change is staged as one
    scope op and rebuilt at approval. The values it would write are held to
    the layer's stored list as it is planned, as op by op under the cap, and
    again when it is rebuilt."""
    from fixtures import GLOSS
    from plaid_agent.igt import bulk
    from plaid_agent.igt.toolkit import call_tool
    rows = [_gloss_row('sp-g1', 'Ali', 'w-1'), _gloss_row('sp-g2', 'Ali', 'w-2')]
    for cap in (None, 1):
        if cap:
            monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', cap)
        _c, ws = _igt_ws(monkeypatch, rows)
        ws.project.field_by_layer(GLOSS).value_sets = [{'type': 'value-set', 'values': ['Ali']}]
        out = call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'Bob'})
        assert '"Bob" is not on the list Gloss is held to' in out and ws.ops == [], (cap, out)
    # And the rebuild at approval refuses what the list no longer takes.
    _c, ws = _igt_ws(monkeypatch, rows)
    call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'Bob'})
    [scope] = ws.ops
    assert scope['kind'] == 'bulk_scope'
    from plaid_agent.igt.plan import Resolution, _resolve_bulk_scope
    res = Resolution(ws.client, ws.project, None)
    res.ws.project.field_by_layer(GLOSS).value_sets = [{'type': 'value-set', 'values': ['Ali']}]
    with pytest.raises(ValueError, match='not on the list'):
        _resolve_bulk_scope(res, scope)
