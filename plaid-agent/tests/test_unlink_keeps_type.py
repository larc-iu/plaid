"""A morpheme whose lexicon link goes keeps the morph type its entry gave it
(ruling Q1, as the app's unlink and entry delete since b814d716e): a linked
morpheme stores none (R2), so unlink_entry and delete_entry left the suffix
-di untyped, and it lost its "-" in every export. The type is written in the
batch that takes the link, and not on a morpheme the same plan types, links
again or deletes."""
from igt_rules_live import base_project, seeded
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_batching import _no_type_copy

from plaid_agent.igt.toolkit import call_tool


def _setup(c, name):
    return seeded(c, base_project(), [_no_type_copy()], name=name)


def _morpheme(c, s):
    t = c.tokens.get(s.ids['m-1b'])
    return (t.get('metadata') or {}).get('morphType')


def test_unlink_entry_keeps_the_type_its_entry_gave_the_morpheme(live_client):
    c = live_client
    s, ws = _setup(c, 'q1 unlink')
    try:
        assert _morpheme(c, s) is None
        call_tool(ws, 'unlink_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2']})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _morpheme(c, s) == 'suffix'
    finally:
        s.delete()


def test_delete_entry_keeps_the_type_its_entry_gave_each_morpheme(live_client):
    c = live_client
    s, ws = _setup(c, 'q1 delete')
    try:
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-erg']})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _morpheme(c, s) == 'suffix'
    finally:
        s.delete()


def test_a_morpheme_the_plan_links_again_takes_no_type(live_client):
    """Unlinked from -di and linked to Ali in the same plan: it goes by
    Ali's type (none), and stores no copy of -di's."""
    c = live_client
    s, ws = _setup(c, 'q1 linked again')
    try:
        call_tool(ws, 'unlink_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2']})
        out = call_tool(ws, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2'], 'entry_form': 'Ali'})
        assert 'Planned' in out, out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _morpheme(c, s) is None
    finally:
        s.delete()


# R2 the other way (REV-FX-VOCAB-1): a link takes off a type the morpheme
# stores, in the link's batch, as the app's links do since 6100f8a37. An
# unlink stores one now, and a later link left a linked morpheme holding it.

def _token_type(c, s, fixture_id):
    return (c.tokens.get(s.ids[fixture_id]).get('metadata') or {}).get('morphType')


def test_a_link_takes_off_the_type_the_morpheme_stores(live_client):
    c = live_client
    s, ws = _setup(c, 'r2 link untypes')
    try:
        assert _token_type(c, s, 'm-4b') == 'enclitic'
        out = call_tool(ws, 'link_entry', {'document': 'Text 1', 'refs': ['s2.w1.m2'], 'entry_form': 'Ali'})
        assert 'Planned' in out, out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _token_type(c, s, 'm-4b') is None
    finally:
        s.delete()


def test_a_morpheme_an_analysis_types_and_the_plan_links_stores_no_type(live_client):
    c = live_client
    s, ws = _setup(c, 'r2 analysis link untypes')
    try:
        call_tool(ws, 'set_analysis', {'document': 'Text 1', 'ref': 's1.w2',
                                       'morphemes': [{'form': 'gam', 'type': 'root'}]})
        out = call_tool(ws, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w2.m1'], 'entry_form': 'Ali'})
        assert 'Planned' in out, out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        doc = c.documents.get(s.ids['d1'], include_body=True)
        morphs = [t for tl in doc['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids['tk-morph']
                  for t in tk.get('tokens') or [] if t.get('begin') == 7 and t.get('end') == 10]
        assert morphs and all((t.get('metadata') or {}).get('morphType') is None for t in morphs), morphs
    finally:
        s.delete()


def _equals_typed_doc():
    """The fixture with the enclitic ar of Gam=ar typed by the "=" rule
    (morphTypeFromEquals, R47), and so recorded."""
    from fixtures import document_raw
    raw = document_raw()
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            for t in tk.get('tokens', []):
                if t['id'] == 'm-4b':
                    t['metadata'] = {'form': 'ar', 'morphType': 'enclitic', 'morphTypeFromEquals': 'enclitic',
                                     'equalsBefore': True}
    return raw


def _link_and_apply(raw, entry_id, ref='s2.w1.m2'):
    from fixtures import FakeClient, fake_ws
    from plaid_agent.igt.plan import execute_plan
    w = fake_ws(FakeClient(documents={'d1': raw}))
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': [ref], 'entry_id': entry_id})
    assert 'Planned' in out, out
    w.client.calls.clear()
    execute_plan(w.client, w.plan_payload()['ops'], source='s', label='l', project=w.project)
    return w.client.patches('tokens')


UNTYPE = [{'op': 'delete', 'path': ['morphType']}]


def test_a_link_to_an_untyped_entry_keeps_the_type_the_equals_rule_gave():
    """REV-FX-VOCAB-4: an untyped entry gives the morpheme no type, so the
    one the "=" before it gave stays. A typed entry's type replaces it."""
    assert _link_and_apply(_equals_typed_doc(), 'vi-ali') == []
    # The rule's record goes with the type it records.
    assert _link_and_apply(_equals_typed_doc(), 'vi-erg') == [
        ('m-4b', UNTYPE + [{'op': 'delete', 'path': ['morphTypeFromEquals']}])]


def test_a_link_to_an_untyped_entry_takes_off_a_type_a_person_chose():
    from fixtures import document_raw
    assert _link_and_apply(document_raw(), 'vi-ali') == [('m-4b', UNTYPE)]


def test_a_link_to_a_planned_morpheme_keeps_the_equals_rules_type_under_an_untyped_entry():
    from fixtures import FakeClient, fake_ws
    from plaid_agent.igt.plan import execute_plan
    for entry, untyped in (('vi-ali', False), ('vi-erg', True)):
        w = fake_ws(FakeClient())
        call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [
            {'form': 'aku'}, {'form': 'na', 'equals': True}]})
        assert w.ops[0]['morphemes'][1].get('type_from_equals') == 'enclitic', w.ops
        call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m2'], 'entry_id': entry})
        w.client.calls.clear()
        execute_plan(w.client, w.plan_payload()['ops'], source='s', label='l', project=w.project)
        patches = w.client.patches('tokens')
        assert [ops for _id, ops in patches] == ([UNTYPE + [{'op': 'delete', 'path': ['morphTypeFromEquals']}]]
                                                 if untyped else []), (entry, patches)
