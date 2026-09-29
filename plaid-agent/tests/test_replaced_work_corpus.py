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
    assert [op['kind'] for op in ws.ops] == ['set_span'] and 'd1' not in ws._docs
    assert [c['replaces_work'] for c in ws.plan_payload()['changes']] == [flagged]


def test_igt_a_document_reached_only_through_a_query_is_pinned_by_sentence(monkeypatch):
    client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
    _replace(ws)
    [doc] = ws.plan_payload()['documents']
    assert doc['id'] == 'd1' and doc['version'] == 7
    assert [s['id'] for s in doc['sentences']] == ['s-1']
    assert 'd1' not in ws._docs


def test_igt_a_document_that_moved_after_the_query_is_pinned_whole_to_what_the_query_saw(monkeypatch):
    """The query saw version 7. Someone writes before the turn ends, so the
    document read to pin it is version 8, and fingerprints of version 8 would
    let a plan built from version 7 through. It is pinned whole, at 7."""
    client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
    _replace(ws)
    client._documents['d1']['version'] = 8
    [doc] = ws.plan_payload()['documents']
    assert doc == {'id': 'd1', 'name': 'Text 1', 'version': 7}


def test_igt_past_the_read_budget_a_document_is_pinned_whole(monkeypatch):
    from plaid_agent.igt import workspace
    monkeypatch.setattr(workspace, 'PIN_LOAD_MAX', 0)
    _client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
    _replace(ws)
    [doc] = ws.plan_payload()['documents']
    assert doc == {'id': 'd1', 'name': 'Text 1', 'version': 7}


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


def test_igt_a_query_plan_applies_after_an_edit_elsewhere_and_is_refused_after_one_in_its_sentence(monkeypatch):
    spec = APPS['igt']()
    for where, refused in (('w-4', False), ('w-2', True)):
        client, ws = _igt_ws(monkeypatch, [_gloss_row('sp-g1', 'Ali', 'w-1')])
        _replace(ws)
        plan = _store(ws, client, igt_fx.PID, 'igt')
        _edit(client, spec, lambda raw: _layer(raw, igt_fx.GLOSS)['spans'].append(
            {'id': 'sp-new', 'value': 'fish', 'tokens': [where]}))
        helper = _approve(spec, client, plan)
        assert bool(helper.errors) == refused, helper.errors


# --- IGT, a corpus-wide replace stored as one change ---------------------------------

def test_igt_a_corpus_wide_replace_counts_the_accepted_values_it_replaces(monkeypatch):
    from plaid_agent.igt import bulk
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 1)
    rows = [_gloss_row('sp-g1', 'Ali', 'w-1'), _gloss_row('sp-x2', 'ali', 'w-2', MACHINE),
            _gloss_row('sp-x3', 'ALI', 'w-3', VERIFIED)]
    _client, ws = _igt_ws(monkeypatch, rows)
    out = _replace(ws)
    [op] = ws.ops
    assert op['kind'] == 'bulk_scope' and op['replaces_accepted'] == 2
    assert op['label'].endswith(', 2 of them replace accepted work')
    assert '2 of them replace work a person made or accepted' in out
    # Found again when approved, so its document stays pinned whole and is
    # not read to fingerprint it.
    ws.load_doc = lambda *a: pytest.fail('read a document a stored scope pins whole')
    payload = ws.plan_payload()
    [row] = payload['changes']
    assert row['replaces_work'] == 2
    assert payload['documents'] == [{'id': 'd1', 'name': 'Text 1', 'version': 7}]
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
