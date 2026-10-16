"""A value kept out of a corpus-wide change (Luke, 2026-10-16, REV-AGENT2-1
and -4): named with the value it already holds while a discard, a
replacement or a rule in the plan would change it, it is a planned keep. The
keep wins against the scope and writes nothing at approval, in both apps, so
the value survives and its provenance stays the person's. Its card row and
its trace line name what is kept, never a write. Set back to what is stored
with no scope reaching it, the earlier planned change is taken back."""

import pytest

from plaid_agent.core import keep
from plaid_agent.core.plan import plan_changes
from plaid_agent.core.trace import trace_step
from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool as ud_call
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, FakeClient, document_raw, project_raw, ud_client
from test_ud_tools import _engine_rows
from live import live_client  # noqa: F401 - fixture
from test_grew_search import treebank  # noqa: F401 - fixture


def _ud(doc=None):
    client = ud_client() if doc is None else FakeClient(project=project_raw(), documents={'ud1': doc})
    return Workspace(client, load_project(client, PID))


def _applied(ws):
    return execute_plan(ws.client, ws.plan_payload()['ops'], source='service:ud:assist:x', label='l',
                        project=ws.project)


def _span(client, sid):
    for tl in client._documents['ud1']['text_layers'][0]['token_layers']:
        for sl in tl.get('span_layers') or []:
            for sp in sl.get('spans') or []:
                if sp['id'] == sid:
                    return sp


def _machine_head_doc():
    doc = document_raw()
    lemma = doc['text_layers'][0]['token_layers'][2]['span_layers'][1]
    for r in lemma['relation_layers'][0]['relations']:
        if r['id'] == 'r-3':
            r['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    return doc


# --- ud ------------------------------------------------------------------------------

def test_ud_a_value_kept_out_of_a_discard_survives_and_nothing_is_written_to_it():
    ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    assert out == ('Kept upos "NOUN" on s1.w4: the corpus-wide change in the plan leaves it out, and approval '
                   'writes nothing to it.')
    assert [o['kind'] for o in ws.ops] == ['discard_scope', 'keep']
    # Asked again, it is kept already.
    assert ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos',
                                     'value': 'NOUN'}).startswith('Nothing to change')
    payload = ws.plan_payload()
    assert payload['changes'][-1]['label'] == 'upos stays "NOUN"'
    assert 'kept' not in payload['summary']
    result = _applied(ws)
    assert 'sp-u3' not in str(ws.client.writes)
    # Counted out of the discard when it was kept, so the applied message
    # has no drop to account for (REV2-AGENT-2).
    assert not any('keeps that value' in n for n in result.get('notes') or []), result


def test_ud_a_head_kept_out_of_a_discard_survives():
    ws = _ud(_machine_head_doc())
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'deprel'})
    out = ud_call(ws, 'set_head', {'document': 'Viaje', 'ref': 's1.w4', 'head': 's1.w1', 'deprel': 'obl'})
    assert out.startswith('Kept s1.w4 ("mar") as obl of word 1 ("Vamos")'), out
    assert ws.plan_payload()['changes'][-1]['label'] == 's1.w4 stays obl of word 1'
    _applied(ws)
    assert 'r-3' not in str(ws.client.writes)


def test_ud_a_value_kept_out_of_a_replacement_survives():
    ws = _ud()
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3'), ('sp-l1', 'ir', 'ud1', 'uw-1')])
    ud_call(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'ir', 'replacement': 'IR', 'whole': True})
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'ir'})
    assert out.startswith('Kept lemma "ir" on s1.w1'), out
    _applied(ws)
    assert ws.client.updates('spans') == []


def test_ud_a_planned_change_set_back_under_a_scope_becomes_a_keep():
    """Changed, then set back while a discard reaches it: the planned change
    gives way to the keep, so neither the change nor the discard is written."""
    ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'PROPN'})
    assert [o['kind'] for o in ws.ops] == ['discard_scope', 'set_span']
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    assert [o['kind'] for o in ws.ops] == ['discard_scope', 'keep']
    _applied(ws)
    assert 'sp-u3' not in str(ws.client.writes)


def test_ud_no_keep_where_the_scope_would_not_change_the_value():
    """A person's value a discard leaves alone needs no keep: naming it plans
    nothing, as before."""
    ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'VERB'})
    assert out.startswith('Nothing to change'), out
    assert [o['kind'] for o in ws.ops] == ['discard_scope']


def test_ud_a_kept_value_someone_changes_before_approval_is_not_touched():
    """The keep names the span, not its value: the discard is resolved over
    what is stored then and still leaves it out (the service's version check
    refuses such a plan before this, see the next test)."""
    ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    _span(ws.client, 'sp-u3')['value'] = 'PROPN'
    _applied(ws)
    assert 'sp-u3' not in str(ws.client.writes)
    assert _span(ws.client, 'sp-u3')['value'] == 'PROPN'


def test_ud_a_kept_value_someone_changes_refuses_the_approval():
    from test_replaced_work_corpus import _store
    from test_stale_by_sentence import APPS, _approve
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    plan = _store(ws, client, PID, 'ud')
    _span(client, 'sp-u3')['value'] = 'PROPN'
    client._documents['ud1']['version'] += 1
    helper = _approve(APPS['ud'](), client, plan)
    assert helper.errors and 'changed since the plan was made' in helper.errors[0], helper.errors
    assert 'sp-u3' not in str(client.writes)
    assert _span(client, 'sp-u3')['value'] == 'PROPN'


def test_ud_features_kept_out_of_a_replacement():
    ws = _ud()
    w1 = ws.doc('Viaje').sentences[0].words[0]
    plur = w1.feature_span('Number')
    feats = ws.project.layer('features')
    ws.client.query = lambda body: ({'return': 'entities', 'results': [[
        {'id': plur.id, 'value': plur.value, 'document': 'ud1', 'layer': feats, 'tokens': [w1.id]},
        {'id': w1.id, 'document': 'ud1', 'begin': 0, 'end': 1}]]} if body.get('return') == 'entities'
        else {'return': 'aggregate', 'results': []})
    ud_call(ws, 'replace_in_field', {'field': 'features', 'pattern': 'Number=Plur', 'replacement': 'Number=Sing',
                                     'whole': True})
    out = ud_call(ws, 'set_feature', {'document': 'Viaje', 'refs': ['s1.w1'], 'feature': 'Number', 'value': 'Plur'})
    assert out.startswith('Kept Number=Plur on s1.w1'), out
    assert ws.plan_payload()['changes'][-1]['label'] == 'Number=Plur stays'
    # The whole bundle, as stored, keeps it as well and adds nothing.
    assert ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'features',
                                     'value': 'Mood=Ind|Number=Plur'}).startswith('Nothing to change')
    _applied(ws)
    assert plur.id not in str(ws.client.writes)


def test_ud_drop_says_what_it_did():
    """A call that only takes back a planned change says so, never "Planned"
    over an empty plan (REV-AGENT2-6)."""
    ws = _ud()
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'NOUN'})
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'VERB'})
    assert out == 'Took back the planned upos change on s1.w1: it keeps "VERB".'
    assert ws.ops == [] and ws.step_label == 'Took back the planned upos change on s1.w1'
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'NOUN'})
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1', 's1.w4'], 'field': 'upos',
                                    'value': 'VERB'})
    assert out == ('Planned upos = "VERB" on 1 word(s): s1.w4. '
                   'Took back the planned upos change on s1.w1: it keeps "VERB".'), out


# --- igt -----------------------------------------------------------------------------

def test_igt_a_value_kept_out_of_a_rule_survives_and_the_rule_counts_without_it():
    import test_igt_rules as R
    store = {'sp-g1': 'Ali', 'sp-x2': 'Ali'}
    client, w = R._ws(store)
    R._replace(w, 'Ali', 'Bob', whole=True)
    out = call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    assert out.startswith('Kept Gloss "Ali" on s1.w1: the corpus-wide change in the plan leaves it out'), out
    assert [o['kind'] for o in w.ops] == ['bulk_scope', 'keep']
    assert w.step_label == 'Kept Gloss "Ali" on s1.w1'
    payload = w.plan_payload()
    rule, kept = payload['ops']
    assert rule['count'] == 1 and plan_changes(payload['ops']) == 1
    row = payload['changes'][1]
    assert row['change'] == 'Gloss stays "Ali"' and row['where']['kind'] == 'token'
    assert call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'}) == (
        'Nothing to change: the plan already keeps Gloss "Ali" on s1.w1 out of the corpus-wide change.')
    plan, helper = R._approved(client, w)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-x2': 'Bob'}


def test_igt_a_planned_change_set_back_under_a_rule_becomes_a_keep():
    import test_igt_rules as R
    client, w = R._ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    R._replace(w, 'Ali', 'Bob', whole=True)
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Other'})
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    assert [o['kind'] for o in w.ops] == ['bulk_scope', 'keep']
    plan, helper = R._approved(client, w)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-x2': 'Bob'}


def test_igt_set_back_to_stored_takes_back_the_planned_change():
    from test_tools import ws as igt_ws
    w = igt_ws()
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'other'})
    out = call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    assert out == ('Took back the planned change to Gloss on s1.w1: it keeps its stored value. '
                   'The plan now holds 0 changes.')
    assert w.ops == []


def test_igt_a_kept_value_someone_changes_refuses_the_approval():
    """A kept value edited since planning is not touched: the rule finds
    other values than it counted, and the whole plan is refused (Luke's
    ruling, 2026-10-08)."""
    import test_igt_rules as R
    store = {'sp-g1': 'Ali', 'sp-x2': 'Ali'}
    client, w = R._ws(store)
    R._replace(w, 'Ali', 'Bob', whole=True)
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    store['sp-g1'] = 'Ali2'
    plan, helper = R._approved(client, w)
    assert helper.errors, helper.errors
    assert 'sp-g1' not in dict(client.updates('spans'))


def call_igt(w, name, args):
    from test_tools import call_tool
    return call_tool(w, name, args)


# --- the keep itself -----------------------------------------------------------------

def test_a_keep_is_no_change_and_its_trace_line_is_the_tools():
    op = keep.op(('span', 'l', 't', None), 'upos stays "NOUN"')
    assert plan_changes([op]) == 0
    from plaid_agent.ud.trace import TRACER
    item = trace_step(TRACER, 'c1', 'set_field', {'field': 'upos', 'value': 'NOUN', 'refs': ['s1.w4']},
                      told='Kept upos "NOUN" on s1.w4')
    assert item['label'] == 'Kept upos "NOUN" on s1.w4'


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_both_apps_declare_the_keep(app):
    from importlib import import_module
    plan = import_module(f'plaid_agent.{app}.plan')
    spec = plan.KIND[keep.KEEP]
    assert spec.apply(None, {}) == 0 and spec.summary({}, 1) == []


def test_ud_a_keep_against_a_real_core_leaves_the_value_and_its_provenance(treebank):
    """On a private core: replace the lemma "mar" with "MAR" over the
    project, keep it in "Viaje", approve. The kept span is not written (its
    value and metadata are as before), the other document's is."""
    ws = treebank
    client = ws.client
    out = ud_call(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'mar', 'replacement': 'MAR', 'whole': True})
    assert out.startswith('Planned 2 lemma change(s) in 2 document(s)'), out
    viaje = ws.doc('Viaje')
    w4 = viaje.sentences[0].words[3]
    kept = client.spans.get(w4.fields['lemma'].id)
    out = ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'lemma', 'value': 'mar'})
    assert out.startswith('Kept lemma "mar" on s1.w4'), out
    with client.operation('keep test'):
        execute_plan(client, ws.plan_payload()['ops'], source='service:ud:assist:x', label='keep test',
                     project=ws.project)
    after = client.spans.get(w4.fields['lemma'].id)
    assert (after.get('value'), after.get('metadata')) == (kept.get('value'), kept.get('metadata'))
    other = Workspace(client, ws.project).doc('Viaje dos').sentences[0].words[3]
    assert other.fields['lemma'].value == 'MAR'
