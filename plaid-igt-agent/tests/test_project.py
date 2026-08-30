from fixtures import FakeClient, document_raw, project_raw

from plaid_igt_agent.project import (load_project, parse_document, render_document, render_overview,
                                     resolve, parse_ref, Word, Morpheme, Sentence)


def test_load_project_reads_roles_scopes_orthographies_and_lexicons():
    p = load_project(FakeClient(), 'p1')
    assert p.word_layer_id == 'tk-word' and p.morpheme_layer_id == 'tk-morph' and p.sentence_layer_id == 'tk-sent'
    assert {f.name: f.scope for f in p.fields.values()} == {'Translation': 'Sentence', 'Gloss': 'Word', 'Morph Gloss': 'Morpheme'}
    assert p.orthographies == ['IPA']
    assert [v['name'] for v in p.vocabs] == ['Lexicon']
    assert p.document_metadata == ['Date']
    assert p.field('gloss').layer_id == 'sl-gloss'  # case-insensitive
    assert p.field('morph gloss').scope == 'Morpheme'
    # A scope-qualified name works even where nothing forces the qualifier,
    # so one spelling addresses a field in every project.
    assert p.field('Gloss (Word)').layer_id == 'sl-gloss'
    assert p.field('morph gloss (morpheme)').scope == 'Morpheme'


def test_parse_document_numbers_words_skipping_punctuation_and_attaches_everything():
    p = load_project(FakeClient(), 'p1')
    d = parse_document(document_raw(), p)
    assert [s.text for s in d.sentences] == ['Ali-di gam akuna.', 'Gam-ar.']
    s1 = d.sentences[0]
    assert [w.surface for w in s1.words] == ['Ali-di', 'gam', 'akuna']  # the "." is ignored, not numbered
    w1 = s1.words[0]
    assert w1.index == 1 and w1.orthographies == {'IPA': 'alidi'}
    assert w1.fields['Gloss'].value == 'Ali' and w1.link.form == 'Ali'
    assert [(m.form, m.morph_type) for m in w1.morphemes] == [('Ali', None), ('di', 'suffix')]
    assert w1.morphemes[1].fields['Morph Gloss'].value == 'ERG' and w1.morphemes[1].link.form == '-di'
    # A morpheme with no metadata.form shows the word surface (the editor's default morpheme).
    assert s1.words[1].morphemes[0].form == 'gam'
    # A word with no morpheme tokens at all.
    assert s1.words[2].morphemes == []
    assert s1.fields['Translation'].value == 'Ali saw a fish.'


def test_render_document_is_compact_and_positional():
    p = load_project(FakeClient(), 'p1')
    d = parse_document(document_raw(), p)
    out = render_document(d, p)
    assert 'Document "Text 1": 2 sentences, 4 words | Date=2020' in out
    assert '[s1] Ali-di gam akuna.' in out
    assert '  Translation: Ali saw a fish.' in out
    assert '  w1 Ali-di | seg=Ali-di types=?,suffix | Morph Gloss=Ali-ERG | Gloss=Ali | IPA=alidi | link=Ali | mlinks=m2:-di' in out
    assert '  w2 gam\n' in out  # single default morpheme, nothing else: just the surface
    assert '  w3 akuna\n' in out
    assert '[s2] Gam-ar.' in out
    assert '  w1 Gam-ar | seg=Gam=ar types=?,enclitic' in out  # clitic joiner
    assert 'Showing s1-s2.' in out and 'more sentences' not in out


def test_render_document_pages():
    p = load_project(FakeClient(), 'p1')
    d = parse_document(document_raw(), p)
    out = render_document(d, p, start=1, end=1)
    assert '[s1]' in out and '[s2]' not in out
    assert '1 more sentences (read_document with from_sentence=2' in out


def test_refs_resolve_and_fail_helpfully():
    p = load_project(FakeClient(), 'p1')
    d = parse_document(document_raw(), p)
    assert parse_ref('s2.w1.m2') == (2, 1, 2)
    assert isinstance(resolve(d, 's1'), Sentence)
    assert isinstance(resolve(d, 's1.w2'), Word) and resolve(d, 's1.w2').surface == 'gam'
    assert isinstance(resolve(d, 's2.w1.m2'), Morpheme) and resolve(d, 's2.w1.m2').form == 'ar'
    for bad, msg in (('s3', 'has 2 sentences'), ('s1.w9', 'has 3 words'), ('s1.w3.m1', 'has 0 morphemes'),
                     ('w1', 'Bad reference')):
        try:
            resolve(d, bad)
        except ValueError as e:
            assert msg in str(e)
        else:
            raise AssertionError(bad)


def test_overview_lists_shape_and_documents():
    p = load_project(FakeClient(), 'p1')
    out = render_overview(p, [{'id': 'd1', 'name': 'Text 1'}])
    assert 'Word fields: Gloss' in out and 'Morpheme fields: Morph Gloss' in out and 'Sentence fields: Translation' in out
    assert 'Orthographies: IPA' in out and 'Lexicons: Lexicon' in out
    assert '  Text 1  id=d1' in out


def test_project_without_morpheme_layer():
    raw = project_raw()
    raw['text_layers'][0]['token_layers'] = raw['text_layers'][0]['token_layers'][:2]
    p = load_project(FakeClient(project=raw), 'p1')
    assert p.morpheme_layer_id is None
    d = parse_document(document_raw(), p)
    assert d.sentences[0].words[0].morphemes == []
    assert 'No morpheme layer' in render_overview(p, [])


def test_colliding_field_names_get_scope_suffixes():
    raw = project_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['span_layers'][0]['name'] = 'Gloss'   # word-scope Gloss
    layers[2]['span_layers'][0]['name'] = 'Gloss'   # morpheme-scope Gloss
    p = load_project(FakeClient(project=raw), 'p1')
    assert sorted(p.fields) == ['Gloss (Morpheme)', 'Gloss (Word)', 'Translation']
    assert p.field('gloss (word)').layer_id == 'sl-gloss' and p.field('Gloss (Morpheme)').layer_id == 'sl-mgloss'
    assert p.field('translation').scope == 'Sentence'  # unique bare names still resolve
    try:
        p.field('Gloss')
    except ValueError as e:
        assert 'say which: Gloss (Word), Gloss (Morpheme)' in str(e)
    else:
        raise AssertionError
    d = parse_document(document_raw(), p)
    assert d.sentences[0].words[0].fields['Gloss (Word)'].value == 'Ali'
    assert 'Gloss (Word)=Ali' in render_document(d, p) and 'Gloss (Morpheme)=Ali-ERG' in render_document(d, p)


def test_literal_and_case_only_collisions_stay_addressable():
    raw = project_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['span_layers'][0]['name'] = 'gloss'          # word-scope, lowercase
    layers[2]['span_layers'][0]['name'] = 'Gloss'          # morpheme-scope
    layers[0]['span_layers'][0]['name'] = 'Gloss (Word)'   # a sentence layer literally so named
    p = load_project(FakeClient(project=raw), 'p1')
    assert sorted(p.fields) == ['Gloss (Morpheme)', 'Gloss (Word)', 'gloss (Word 2)']
    assert p.field('Gloss (Word)').scope == 'Sentence' and p.field('gloss (word 2)').scope == 'Word'
    assert p.field_by_layer('sl-trans') is not None
    # The literal name wins over the qualified reading of the same string.
    assert p.field('gloss (Morpheme)').scope == 'Morpheme'


def test_the_field_error_spells_names_the_way_they_must_be_passed_back():
    p = load_project(FakeClient(project=project_raw()), 'p1')
    try:
        p.field('Nope')
    except ValueError as e:
        # Not "Gloss (Word)", which in this project is not the field's name.
        assert str(e) == ('No field named "Nope". Fields: '
                          'Word: Gloss; Morpheme: Morph Gloss; Sentence: Translation')
    else:
        raise AssertionError


def test_two_lexicons_with_one_name_are_refused_rather_than_guessed():
    raw = project_raw()
    raw['vocabs'] = raw['vocabs'] + [{'id': 'v-other', 'name': 'lexicon', 'config': {}}]
    p = load_project(FakeClient(project=raw), 'p1')
    try:
        p.vocab('Lexicon')
    except ValueError as e:
        assert 'Several lexicons are named' in str(e)
    else:
        raise AssertionError
    # And with no name at all, since there is no longer only one.
    try:
        p.vocab()
    except ValueError as e:
        assert 'Several lexicons' in str(e)
    else:
        raise AssertionError
