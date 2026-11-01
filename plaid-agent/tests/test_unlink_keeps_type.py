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


# REV-FX-AGENT-IGT-1: the kept types of a delete were one write per morpheme,
# and the batcher cut a change past 1,000 writes, so a delete core refused
# (an entry linked in a project the assistant cannot open) left the first
# 1,000 morphemes linked AND storing a type. They are bulk updates now, in the
# delete's own batch: the delete lands whole or not at all.

def _many_links_doc(did, n, linked=True):
    import fixtures as F
    body, words, morphs, links = '', [], [], []
    for i in range(n):
        o = len(body)
        body += 'di '
        words.append({'id': f'{did}w{i}', 'begin': o, 'end': o + 2})
        morphs.append({'id': f'{did}m{i}', 'begin': o, 'end': o + 2, 'precedence': 1, 'metadata': {'form': 'di'}})
        if linked:
            links.append({'id': f'{did}l{i}', 'vocab_item': {'id': 'vi-erg', 'form': '-di'}, 'tokens': [f'{did}m{i}']})
    return {'id': did, 'name': f'Doc {did}', 'text_layers': [{
        'id': F.TEXT_LAYER, 'name': 'Text', 'text': {'id': f'text-{did}', 'body': body},
        'token_layers': [
            {'id': F.SENT_LAYER, 'tokens': [{'id': f'{did}s', 'begin': 0, 'end': len(body) - 1}]},
            {'id': F.WORD_LAYER, 'tokens': words},
            {'id': F.MORPH_LAYER, 'tokens': morphs,
             'vocabs': [{'id': F.VOCAB, 'name': 'Lexicon', 'vocab_links': links}]},
        ]}]}


def _typed_morphemes(c, s, did):
    import fixtures as F
    d = c.documents.get(s.ids[did], include_body=True)
    return [t['id'] for tl in d['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[F.MORPH_LAYER]
            for t in tk.get('tokens') or [] if (t.get('metadata') or {}).get('morphType')]


def test_a_refused_delete_of_an_entry_with_many_links_writes_no_type(live_client):
    import fixtures as F
    import pytest
    from live import seed
    from plaid_agent.igt.plan import execute_plan
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    c = live_client
    a = seed(c, F.project_raw(), {'da': _many_links_doc('da', 1200)}, {F.VOCAB: F.lexicon_raw()},
             name='q1 many links A')
    b = seed(c, F.project_raw(), {'db': _many_links_doc('db', 1, linked=False)}, {F.VOCAB: F.lexicon_raw()},
             name='q1 many links B')
    try:
        # The lexicon of A is linked into B too, and a morpheme of B links -di.
        c.projects.link_vocab(b.project_id, a.ids[F.VOCAB])
        c.vocab_links.create(a.ids['vi-erg'], [b.ids['dbm0']])
        ws = Workspace(c, load_project(c, a.project_id))
        call_tool(ws, 'delete_entry', {'entry_id': a.ids['vi-erg']})
        with pytest.raises(Exception, match='cannot open'):
            execute_plan(c, ws.plan_payload()['ops'], source='s', label='l', project=ws.project)
        assert c.vocab_items.get(a.ids['vi-erg'])
        assert _typed_morphemes(c, a, 'da') == []
    finally:
        b.delete()
    # Without B, the same delete lands, every morpheme typed.
    try:
        ws = Workspace(c, load_project(c, a.project_id))
        call_tool(ws, 'delete_entry', {'entry_id': a.ids['vi-erg']})
        execute_plan(c, ws.plan_payload()['ops'], source='s', label='l', project=ws.project)
        assert len(_typed_morphemes(c, a, 'da')) == 1200
    finally:
        a.delete()


def test_a_morpheme_the_plan_unlinks_takes_a_type_of_its_own(live_client):
    """REV-FX-AGENT-IGT-5: set_morpheme on a morpheme whose unlink the plan
    holds sent the model to unlink_entry, which it had already planned. Its
    type is then its own, and stands over the entry's the unlink keeps."""
    c = live_client
    s, ws = _setup(c, 'q1 unlink then type')
    try:
        call_tool(ws, 'unlink_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2']})
        out = call_tool(ws, 'set_morpheme', {'document': 'Text 1', 'ref': 's1.w1.m2', 'type': 'enclitic'})
        assert out.startswith('Planned'), out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _morpheme(c, s) == 'enclitic'
    finally:
        s.delete()


# REV-LAST-1: unlink, set_morpheme with a type (allowed while the unlink is
# planned), then a link of the same morpheme, which takes the unlink back (the
# same entry) or replaces it (another). The type stayed and was written after
# the link, so the morpheme ended linked AND storing a type (R2).

def _linked_form(c, s):
    d = c.documents.get(s.ids['d1'], include_body=True)
    for tl in d['text_layers']:
        for tk in tl['token_layers']:
            for v in tk.get('vocabs') or []:
                for l in v.get('vocab_links') or []:
                    if s.ids['m-1b'] in [t if isinstance(t, str) else t.get('id') for t in l.get('tokens') or []]:
                        return (l.get('vocab_item') or {}).get('form')
    return None


def _unlink_type_link(c, name, entry):
    s, ws = _setup(c, name)
    try:
        call_tool(ws, 'unlink_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2']})
        assert call_tool(ws, 'set_morpheme', {'document': 'Text 1', 'ref': 's1.w1.m2',
                                              'type': 'enclitic'}).startswith('Planned')
        out = call_tool(ws, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2'], **entry})
        assert 'The type planned on s1.w1.m2 was taken out of the plan' in out, out
        assert not any(op['kind'] == 'set_morph_type' for op in ws.ops), ws.ops
        if ws.ops:
            _p, h, _ = approve(c, s.project_id, ws)
            assert not h.errors, h.errors
        return _linked_form(c, s), _morpheme(c, s)
    finally:
        s.delete()


def test_a_link_back_to_the_same_entry_takes_back_the_type_planned_after_its_unlink(live_client):
    assert _unlink_type_link(live_client, 'revlast relink same', {'entry_form': '-di'}) == ('-di', None)


def test_a_link_to_another_entry_takes_back_the_type_planned_after_the_unlink(live_client):
    assert _unlink_type_link(live_client, 'revlast relink other', {'entry_form': 'Ali'}) == ('Ali', None)


def test_a_morpheme_whose_entry_the_plan_deletes_takes_a_type_of_its_own(live_client):
    """REV-LAST-5: as for a planned unlink (8ab125dac), a planned delete of
    the morpheme's entry lets set_morpheme type it, and the person's type
    stands over the one the delete keeps from the entry (Q1)."""
    c = live_client
    s, ws = _setup(c, 'revlast delete then type')
    try:
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-erg']})
        out = call_tool(ws, 'set_morpheme', {'document': 'Text 1', 'ref': 's1.w1.m2', 'type': 'enclitic'})
        assert out.startswith('Planned'), out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _morpheme(c, s) == 'enclitic'
    finally:
        s.delete()


def test_a_refusal_after_a_delete_that_landed_says_which_landed(live_client):
    """REV-LAST-2: a delete with hundreds of links fills a batch, which is sent
    as its block ends, so a later delete core refuses (linked in a project the
    assistant cannot open) came back as "none was deleted" while the first
    entry was gone. The refusal names the delete that landed."""
    import fixtures as F
    import pytest
    from live import seed
    from plaid_agent.igt.plan import execute_plan
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    c = live_client
    a = seed(c, F.project_raw(), {'da': _many_links_doc('da', 900)}, {F.VOCAB: F.lexicon_raw()},
             name='revlast two deletes A')
    b = seed(c, F.project_raw(), {'db': _many_links_doc('db', 1, linked=False)}, {F.VOCAB: F.lexicon_raw()},
             name='revlast two deletes B')
    try:
        c.projects.link_vocab(b.project_id, a.ids[F.VOCAB])
        c.vocab_links.create(a.ids['vi-gam'], [b.ids['dbm0']])
        ws = Workspace(c, load_project(c, a.project_id))
        call_tool(ws, 'delete_entry', {'entry_id': a.ids['vi-erg']})
        call_tool(ws, 'delete_entry', {'entry_id': a.ids['vi-gam']})
        with pytest.raises(Exception) as e:
            execute_plan(c, ws.plan_payload()['ops'], source='s', label='l', project=ws.project)
        msg = str(e.value)
        assert 'none was deleted' not in msg, msg
        assert msg.startswith('"-di" (ERG) was deleted, and "gam#1" (fish) is linked in projects'), msg
        with pytest.raises(Exception):
            c.vocab_items.get(a.ids['vi-erg'])
        assert c.vocab_items.get(a.ids['vi-gam'])
    finally:
        b.delete()
        a.delete()


# W2-R (parent call 2026-11-01): link_entry first, then set_morpheme with a
# type on the same morpheme, ended linked AND storing the type (R2).
# set_morpheme reads a link the plan makes as a stored one.

def _link_then_type(c, name, entry, morph_type):
    s, ws = _setup(c, name)
    try:
        assert call_tool(ws, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w1.m1'],
                                            'entry_form': entry}).startswith('Planned')
        out = call_tool(ws, 'set_morpheme', {'document': 'Text 1', 'ref': 's1.w1.m1', 'type': morph_type})
        assert 'is linked to' in out and 'in this plan' in out, out
        assert [op['kind'] for op in ws.ops] == ['link'], ws.ops
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        return (c.tokens.get(s.ids['m-1a']).get('metadata') or {}).get('morphType')
    finally:
        s.delete()


def test_a_type_on_a_morpheme_the_plan_links_to_an_untyped_entry_is_refused(live_client):
    assert _link_then_type(live_client, 'w2r link Ali then type', 'Ali', 'root') is None


def test_a_type_on_a_morpheme_the_plan_links_to_a_typed_entry_is_refused(live_client):
    assert _link_then_type(live_client, 'w2r link -di then type', '-di', 'enclitic') is None

