"""The plaid-agent items of the 2026-10-16 sweep outside the plan rules
(build-2026-10-15/SWEEP-OPEN.md, fix round FX-G-AGENT)."""
from fixtures import fake_ws, FakeClient

from plaid_agent.igt.toolkit import call_tool


def igt_ws():
    return fake_ws(FakeClient())


def test_an_igt_label_names_the_place_once_whatever_form_the_ref_carries():
    """A word named by its form, or with its form beside the number, is
    labelled by its place and its form once: never `s1."gam" "gam"`."""
    for ref in ('s1."gam"', 's1.w2 "gam"', 's1.w2'):
        w = igt_ws()
        out = call_tool(w, 'set_field', {'document': 'd1', 'refs': [ref], 'field': 'Gloss',
                                        'value': 'n'})
        assert out.startswith('Planned'), out
        assert w.ops[-1]['label'] == 'Text 1 s1.w2 "gam": Gloss = "n"', (ref, w.ops[-1]['label'])


def test_a_layer_of_the_wrong_kind_for_its_clause_is_refused_by_name():
    """A token layer in a span clause was refused by the engine with its raw
    id (BENCH-SURVEY-NEW 12). The refusal names the layer, its kind, and the
    clause that takes it, and a name two kinds share resolves by the clause."""
    import pytest
    from plaid_agent.core.query import QueryRefused, rewrite
    idx = {'sentences': [('token-layer', 'L-sent', 'sentences')],
           'gloss': [('span-layer', 'L-gs', 'Gloss'), ('token-layer', 'L-gt', 'Gloss')],
           'baseline': [('text-layer', 'L-text', 'baseline')]}
    show = lambda lid: lid  # noqa: E731
    with pytest.raises(QueryRefused) as e:
        rewrite({'where': [['span', '?s', {'layer': 'sentences'}]]}, idx, show)
    assert str(e.value) == '"sentences" is a token layer, not a span layer: use it in a token clause.'
    with pytest.raises(QueryRefused) as e:
        rewrite({'where': [['token', '?t', {'layer': 'baseline'}]]}, idx, show)
    assert str(e.value) == '"baseline" is the text layer, not a token layer.'
    out = rewrite({'where': [['span', '?s', {'layer': 'gloss'}], ['token', '?t', {'layer': 'Gloss'}],
                             ['seq', {'layer': 'sentences'}, ['span', {'layer': 'gloss'}]]]}, idx, show)
    assert out['where'][0][2]['layer'] == 'L-gs' and out['where'][1][2]['layer'] == 'L-gt'
    assert out['where'][2][1]['layer'] == 'L-sent' and out['where'][2][2][1]['layer'] == 'L-gs'
    # Outside a clause, a name two layers share is still refused as before.
    from plaid_agent.core.query import resolve_layer
    with pytest.raises(QueryRefused, match='names 2 layers'):
        resolve_layer('gloss', idx, show)


def test_a_concordance_line_names_the_hit_morpheme():
    """A model wrote refs for set_field from concordance lines and gave every
    hit .m2, where one word's hit was m3 (BENCH-FX13). A morpheme hit's line
    names the morpheme, as the value lists do."""
    w = igt_ws()
    out = call_tool(w, 'concordance', {'pattern': 'ar'})
    assert '\n  s2.w1.m2 # [Gam-ar] # | seg=Gam=[ar] || Gam-ar.' in out, out
    # A word hit names the word alone.
    out = call_tool(w, 'concordance', {'pattern': 'akuna', 'where': 'word'})
    assert '\n  s1.w3 ' in out, out


def test_a_folded_form_is_shown_as_it_is_most_often_written():
    """igt counts forms case folded, and printed the folded key, so a
    capital-only letter such as Ӏ came out as ӏ (FX-H16-IGT)."""
    from plaid_agent.igt.queries import _casefold_tally, _commonest
    spelled = {}
    counts, raw = _casefold_tally([['Ӏа', 3], ['ӏа', 1], ['Gam', 1], ['gam', 1]],
                                  lambda r: (r[0].casefold(), r[0]), spelled)
    assert counts == {'ӏа': 4, 'gam': 2}
    assert _commonest(spelled['ӏа'], 'ӏа') == 'Ӏа'
    assert _commonest(spelled['gam'], 'gam') == 'gam'
    # A morpheme's spelling is its stored form, else its value.
    spelled = {}
    _casefold_tally([[None, 'Ӏа', 2], ['ӏа', 'x', 1]], lambda r: ((r[0] or r[1]).casefold(), (r[0], r[1])), spelled)
    assert _commonest(spelled['ӏа'], 'ӏа') == 'Ӏа'


def test_frequency_list_asks_for_each_form_once():
    """The dispersion read listed a form once per value it was seen with (62
    copies of one form in BENCH-FX13)."""
    w = igt_ws()
    c = w.corpus
    real = c.group
    asked = []

    def spy(where, *a, **k):
        for clause in where:
            if isinstance(clause, list) and clause and clause[0] == 'in':
                asked.append(clause[2])
        return real(where, *a, **k)
    c.group = spy
    out = call_tool(w, 'frequency_list', {'what': 'morpheme'})
    assert '\tgam' in out, out
    assert asked and all(len(x) == len(set(x)) for x in asked), asked


def test_feature_bundles_past_the_group_limit_are_read_by_document(monkeypatch):
    """Cut at the group limit, the rows ended inside a word's features, and
    that word counted as a bundle it does not have (REV-AGENT F6). Past the
    limit the bundles are read a few documents at a time."""
    from ud_fixtures import PID, ud_client
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    from plaid_agent.ud.toolkit import call_tool as ud_call
    import plaid_agent.ud.stats as stats
    monkeypatch.setattr(stats, 'GROUP_LIMIT', 4)
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    rows = {'d1': [['w1', 'Mood=Ind', 1], ['w1', 'Number=Plur', 1], ['w2', 'Number=Sing', 1]],
            'd2': [['w3', 'Mood=Ind', 1], ['w3', 'Number=Plur', 1]]}

    def engine(body):
        where, group = body['where'], body['return']['group']
        if group == ['?t.doc']:
            return {'results': [['d1', 3], ['d2', 2]]}
        held = [c[2] for c in where if c[0] == 'in' and c[1] == '?t.doc']
        if not held:
            # The whole read, cut inside w3's features.
            return {'results': rows['d1'] + rows['d2'][:1], 'truncated': True}
        return {'results': [r for d in held[0] for r in rows[d]]}
    ws.client.query = engine
    out = ud_call(ws, 'frequency_list', {'what': 'feature-bundles'})
    assert '2  Mood=Ind|Number=Plur' in out and '1  Number=Sing' in out, out
    assert '1  Mood=Ind\n' not in out + '\n' and 'engine returned as many rows' not in out, out


def test_a_failure_while_the_turn_is_set_up_writes_the_record(monkeypatch):
    """The turn's setup (its workspace, the reach into other projects, the
    prompt) ran outside the turn's try, so a failure there ended the request
    with no record written and the question left pending (REV-MULTI)."""
    from fixtures import FakeClient
    from test_service_flow import Helper, _request, _seed, _service
    client = FakeClient()
    store = _seed(client, text='Gloss s1.')
    svc = _service()

    def broken(*a, **k):
        raise RuntimeError('the prompt hook broke')
    monkeypatch.setattr(svc, 'system_prompt', broken)
    helper = Helper()
    svc.process_request(_request(client), helper)
    conv, meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error']
    assert conv['display'][-1]['text'].startswith('The assistant could not answer')
    assert not meta.get('pending') and helper.errors


def test_a_conversations_lock_goes_once_nothing_holds_it():
    """The service's lock table kept a lock for every conversation it ever
    touched (REV-SW-1). A lock goes once nothing holds or waits on it, and
    while one does, every caller gets that same lock."""
    from test_service_flow import _service
    svc = _service()
    key = ('u@x', 'p1', 'c1')
    with svc._conv_lock(key) as _held:
        lock = svc._conv_lock(key)
        assert len(svc._locks) == 1 and svc._conv_lock(key) is lock
        del lock
    assert len(svc._locks) == 0

