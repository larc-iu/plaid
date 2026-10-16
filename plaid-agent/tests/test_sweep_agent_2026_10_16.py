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


def test_latin_letters_above_the_bmp_are_never_checked_and_styled_letters_are():
    """Luke 2026-10-16 (DECIDE 7, 8): an extIPA letter is typed as it is,
    whatever the turn read, and a mathematical bold letter such as 𝐍 is
    still refused unless the turn read one."""
    from plaid_agent.core.garble import Seen, refusal
    seen = Seen()
    assert refusal({'value': 'pa\U00010780a'}, seen) is None
    assert refusal({'value': 'ta\U0001DF0Ae'}, seen) is None
    out = refusal({'value': '\U0001D40D\U0001D40E\U0001D40C'}, seen)
    assert out and 'characters from Mathematical Alphanumeric Symbols' in out
    seen.add('\U0001D40D')
    assert refusal({'value': '\U0001D40D\U0001D40E\U0001D40C'}, seen) is None


def test_a_merge_joins_values_with_the_rules_join_with():
    """Core's single-span remedy joins a merge's values with its rule's
    join-with, " | " when it has none, and the card showed " | " always
    (REV-AGENT F8)."""
    from fixtures import document_raw, project_raw, GLOSS

    def merged(join=None):
        project = project_raw()
        if join is not None:
            for tk in project['text_layers'][0]['token_layers']:
                for sl in tk.get('span_layers') or []:
                    if sl['id'] == GLOSS:
                        sl['constraints'] = {'igt': [{'type': 'single-span', 'join-with': join}]}
        raw = document_raw()
        raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'].append(
            {'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2']})
        w = fake_ws(FakeClient(project=project, documents={'d1': raw}))
        call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']})
        return w.ops[0]['spans'][0]['value']

    assert merged() == 'Ali | fish'
    assert merged(' / ') == 'Ali / fish'


def test_a_turns_reshapes_read_the_whole_document_once():
    """delete_word, merge_words and split_sentence read the whole document,
    every app's layers, on every call (REV-D7-FAKES). Once a turn now, for
    each version of the document."""
    w = igt_ws()
    real = w.client.documents.get
    whole = []

    def get(doc_id, *a, **k):
        if k.get('include_body'):
            whole.append(doc_id)
        return real(doc_id, *a, **k)
    w.client.documents.get = get
    call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w3']})
    call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']})
    call_tool(w, 'split_sentence', {'document': 'd1', 'ref': 's1.w2'})
    assert len(whole) <= 2, whole  # the document's own load, and the whole read once


def test_corpus_stats_says_how_many_segments_it_left_out_for_ending_before_they_start(monkeypatch):
    """A segment whose end is before its start is left out of every count of
    time, as the editor leaves it out, and corpus_stats said nothing of it
    (FX-H16-IGT)."""
    from test_time_alignment import _ws
    from plaid_agent.core.bidi import for_model
    w = _ws(monkeypatch, seconds=125.0)
    assert 'left out' not in for_model(call_tool(w, 'corpus_stats', {}))
    w = _ws(monkeypatch, seconds=125.0)
    seg = w.client._documents['d1']['text_layers'][0]['token_layers'][-1]['tokens'][2]
    seg['metadata'] = {'timeBegin': 5.0, 'timeEnd': 4.0}
    out = for_model(call_tool(w, 'corpus_stats', {}))
    assert '1 segment whose end is before its start is left out.' in out, out
    assert 'Time alignment: 2 segments in 1 document' in out, out


def test_the_tagsets_check_counts_one_unlisted_part_in_the_singular():
    """It said "1 unlisted parts" (FX-C-WIRE)."""
    def check(*values):
        client = FakeClient()
        raw = client._documents['d1']
        for tl in raw['text_layers'][0]['token_layers']:
            for sl in tl.get('span_layers') or []:
                if sl['id'] == 'sl-mgloss':
                    sl['spans'] += [{'id': f'sp-x{i}', 'value': v, 'tokens': [t]}
                                    for i, (v, t) in enumerate(values)]
        return call_tool(fake_ws(client), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    out = check(('DAT', 'm-2'))
    assert 'Morph Gloss: 3 values, 1 unlisted part.' in out, out
    # The fixture's one word gloss, "Ali", is the only part a close would add.
    out = check()
    assert ('The one unlisted part of Morph Gloss is a word gloss. Closing the list with add_used would list it '
            'as tags') in out, out
