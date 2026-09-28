"""The skeleton-from-glosses service, driven end to end on the same harness
as the draft service: no model, so the whole run is the reading of the
glosses and links and the writing of the anchors and nodes.

Run: pytest -q services/tests, from plaid-umr. Runs from the base env.
"""

import json
import re
import pathlib

import pytest
from plaid_client import testing as servicetest

import test_umr_draft_llm as draft_tests

SERVICES = pathlib.Path(__file__).resolve().parent.parent

boot = servicetest.load_service(SERVICES / 'umr_bootstrap_igt.py')

DOC = draft_tests.DOC
PROJECT = draft_tests.PROJECT
REQUEST = {'document_id': DOC, 'project_id': PROJECT,
           'scope': 'document', 'sentence': 1, 'overwrite': False}

#: "The dog barks": "The" is glossed DET only (no lexical part, no node),
#: "dog" is glossed dog-PL, and "barks" is linked to the sense "bark 1" under
#: the headword "bark" and glossed bark.PRS, which makes it the root.
GLOSSES = [
    {'id': 'g1', 'tokens': ['w1'], 'value': 'DET'},
    {'id': 'g2', 'tokens': ['w2'], 'value': 'dog-PL'},
    {'id': 'g3', 'tokens': ['w3'], 'value': 'bark.PRS'},
]
VOCAB = {'id': 'v1', 'name': 'Lexicon', 'items': [
    {'id': 'i1', 'form': 'bark', 'metadata': {}},
    {'id': 'i2', 'form': 'barking', 'metadata': {'parent': 'i1'}},
]}


def _document(**kwargs):
    document = draft_tests._document(gloss_spans=kwargs.pop('gloss_spans', GLOSSES), **kwargs)
    word_layer = document['text_layers'][0]['token_layers'][1]
    word_layer['vocabs'] = [{'id': 'v1', 'vocab_links': [
        {'id': 'l1', 'vocab_item': {'id': 'i2', 'form': 'barking'}, 'tokens': ['w3']},
    ]}]
    return document


class _Client(draft_tests._Client):
    def __init__(self, documents, project=None, fails=None):
        super().__init__(documents, project=project, fails=fails)
        self.vocab_layers = self._Vocabs()

    class _Vocabs:
        def get(self, vocab_id, **kwargs):
            assert kwargs.get('include_items') is True
            return VOCAB


def _project():
    return {'id': PROJECT, 'name': 'UMR', 'config': {}, 'vocabs': [{'id': 'v1'}]}


def _service(*, documents=None, fails=None):
    service = boot.UmrBootstrapService()
    service.client = _Client(documents or [_document()], project=_project(), fails=fails)
    return service


def _ops(client, kind):
    return [op for payload in client.payloads(kind) for op in payload]


# --- reading a gloss ------------------------------------------------------------

def test_a_gloss_is_read_into_its_lexical_part_and_its_attributes():
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('bark.PRS', table) == {
        'lexical': 'bark', 'attrs': [], 'marked': [], 'eventive': True, 'possessive': False,
        'agreement': False}
    assert boot.read_gloss('3SG', table) == {
        'lexical': None, 'attrs': [(':refer-person', '3rd'), (':refer-number', 'singular')],
        'marked': [True, True], 'eventive': False, 'possessive': False, 'agreement': True}
    assert boot.read_gloss('go=1PL.IRR', table)['attrs'] == [
        (':refer-person', '1st'), (':refer-number', 'plural')]
    assert boot.read_gloss('go=1PL.IRR', table)['eventive'] is True
    assert boot.read_gloss('NEG', table)['attrs'] == [(':polarity', '-')]
    # An upper-case piece the table does not know is grammatical, not a word.
    assert boot.read_gloss('DET', table)['lexical'] is None
    # A capitalised word is a word.
    assert boot.read_gloss('Lindsay', table)['lexical'] == 'Lindsay'
    assert boot.concept_from('Go Away ') == 'go-away'


def test_a_language_table_adds_and_removes_abbreviations(tmp_path):
    path = tmp_path / 'arapaho.json'
    path.write_text(json.dumps({'OBV': [':refer-person', '4th'], 'AFF': ['root'], 'Q': None}))
    table = boot.load_abbreviations(str(path))
    assert table['OBV'] == (':refer-person', '4th')
    assert table['AFF'] == ('root',)
    assert 'Q' not in table
    assert table['SG'] == (':refer-number', 'singular')


def test_a_sense_takes_its_headword():
    assert boot.headwords_of([VOCAB]) == {'i1': 'bark', 'i2': 'bark'}


# --- the run ------------------------------------------------------------------------

def test_the_skeleton_is_one_anchored_node_per_glossed_or_linked_word():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['failed']) == (1, 0, 0)
    assert result['notice']['level'] == 'success'

    anchors = _ops(service.client, 'tokens.bulk_create')
    assert [(a['begin'], a['end']) for a in anchors] == [(4, 7), (8, 13)]
    nodes = _ops(service.client, 'spans.bulk_create')
    assert [n['value'] for n in nodes] == ['dog', 'bark']
    dog, bark = [n['metadata']['umr'] for n in nodes]
    assert dog['attrs'] == [{'rel': ':refer-number', 'value': 'plural', 'order': 0}]
    assert 'root' not in dog
    # The linked word takes the HEADWORD, not the sense's form, and its tense
    # gloss makes it the root.
    assert bark['root'] is True and bark['attrs'] == []
    assert dog['var'] == 's1d' and bark['var'] == 's1b'
    # Machine-made, and no relations at all.
    assert nodes[0]['metadata']['prov'] == 'inferred'
    assert nodes[0]['metadata']['provSource'].startswith('service:')
    assert service.client.payloads('relations.bulk_create') == []
    assert [kind for kind, _ in service.client.writes] == [
        'tokens.bulk_create', 'spans.bulk_create']


def test_the_first_node_is_the_root_when_no_gloss_carries_tense():
    glosses = [{'id': 'g2', 'tokens': ['w2'], 'value': 'dog'},
               {'id': 'g3', 'tokens': ['w3'], 'value': 'bark'}]
    document = _document(gloss_spans=glosses)
    document['text_layers'][0]['token_layers'][1]['vocabs'] = []
    service = _service(documents=[document])
    servicetest.run(service, REQUEST)
    nodes = _ops(service.client, 'spans.bulk_create')
    assert [n['value'] for n in nodes] == ['dog', 'bark']
    assert nodes[0]['metadata']['umr'].get('root') is True


def test_a_sentence_with_nothing_to_go_on_is_a_counted_failure():
    document = _document(gloss_spans=[])
    document['text_layers'][0]['token_layers'][1]['vocabs'] = []
    service = _service(documents=[document])
    helper = servicetest.run(service, REQUEST)
    [result] = helper.results
    assert (result['drafted'], result['failed']) == (0, 1)
    assert result['notice']['level'] == 'warning'
    assert result['notice']['message'] == (
        'Failed to draft sentence 1: No word has a vocabulary link or a gloss.')
    assert result['notice']['sticky'] is True
    assert service.client.writes == []


def _with_graph(node_metadata):
    """The document with sentence 1 already annotated: one node on the last
    word, whose provenance is the caller's."""
    return _document(
        node_tokens=[('n1', 8, 13)],
        concept_spans=[{'id': 'c1', 'tokens': ['n1'], 'value': 'bark-01',
                        'metadata': {'umr': {'var': 's1b', 'attrs': []}, **node_metadata}}])


def test_a_sentence_with_a_graph_is_skipped_unless_overwritten():
    document = _with_graph({'prov': 'inferred', 'provSource': 'service:umr-draft-llm'})
    service = _service(documents=[document])
    helper = servicetest.run(service, REQUEST)
    [result] = helper.results
    assert (result['drafted'], result['skipped']) == (0, 1)
    assert service.client.writes == []

    service = _service(documents=[document])
    servicetest.run(service, {**REQUEST, 'overwrite': True})
    assert [kind for kind, _ in service.client.writes] == [
        'tokens.bulk_delete', 'tokens.bulk_create', 'spans.bulk_create']
    # The freed variable is used again rather than s1b2.
    assert [n['metadata']['umr']['var'] for n in _ops(service.client, 'spans.bulk_create')] == [
        's1d', 's1b']


# The same rule as the drafting service, from the same reader: `overwrite`
# replaces the machine's own skeletons, never a person's graph.
@pytest.mark.parametrize('node_metadata, why', [
    ({}, 'hand-made'),
    ({'prov': 'inferred', 'provSource': 'service:umr-bootstrap-igt', 'provConfirmed': True},
     'verified'),
    ({'prov': 'contributed', 'provSource': 'user:a@b.com'}, 'contributed'),
])
def test_overwrite_keeps_a_sentence_a_person_built_or_confirmed(node_metadata, why):
    service = _service(documents=[_with_graph(node_metadata)])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})

    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['kept']) == (0, 0, 1), why
    assert service.client.writes == [], f'a {why} graph is not deleted'
    assert result['notice'] == {'level': 'warning', 'title': 'Document not modified',
                                'message': 'Kept 1 sentence a person had worked on.'}


# --- one run body for both services --------------------------------------------

def _both(document):
    """The skeleton and the draft service over the same document, each writing
    one graph when it writes at all."""
    skeleton = _service(documents=[document])
    draft = draft_tests._service(model=draft_tests._Model())
    draft.client = _Client([document], project=_project())
    return skeleton, draft


def test_both_services_take_the_same_parameters():
    skeleton, draft = _both(_document())
    assert skeleton.extras['parameters'] == draft.extras['parameters']


@pytest.mark.parametrize('overwrite', [False, True])
@pytest.mark.parametrize('document, why', [
    (_document(), 'no graph'),
    (_with_graph({'prov': 'inferred', 'provSource': 'service:umr-draft-llm'}), 'machine'),
    (_with_graph({}), 'hand-made'),
    (_with_graph({'prov': 'contributed', 'provSource': 'user:a@b.com'}), 'contributed'),
])
def test_both_services_choose_and_report_the_same_sentences(document, why, overwrite):
    reports = []
    for service in _both(document):
        [result] = servicetest.run(service, {**REQUEST, 'overwrite': overwrite}).results
        reports.append(result)
    assert reports[0] == reports[1], why


@pytest.mark.parametrize('request_data', [{**REQUEST, 'scope': 'sentence', 'sentence': 2},
                                          {**REQUEST, 'document_id': None}])
def test_both_services_refuse_the_same_requests(request_data):
    outcomes = []
    for service in _both(_document()):
        helper = servicetest.run(service, request_data)
        outcomes.append((helper.results, helper.errors, service.client.writes))
    assert outcomes[0] == outcomes[1]
    assert outcomes[0][0] == [] and outcomes[0][1]


# --- segmented words: the lexical morpheme names the word ----------------------------

#: Lamkang, as IGT stores it: full-width morpheme tokens with `metadata.form`,
#: `morphType` and precedence. "mhii" is m- 3.POS + hii 'blood', "pbulda" is
#: p- CAUS + bul 'smear' + -da sbj:3.pfv, "eekda" is a zero prefix obj:3 +
#: eek + -da. Every morpheme but the zero one is linked to an entry.
SEG_BODY = 'mhii pbulda eekda\n'
SEG_WORDS = [(0, 4), (5, 11), (12, 17)]
SEG_MORPHEMES = [
    # (id, word index, form, morphType, gloss, entry)
    ('m1', 0, 'm', 'prefix', '3.POS', 'e-m'),
    ('m2', 0, 'hii', 'stem', 'blood', 'e-hii'),
    ('m3', 1, 'p', 'prefix', 'CAUS', 'e-p'),
    ('m4', 1, 'bul', 'stem', 'smear', 'e-bul'),
    ('m5', 1, 'da', 'suffix', 'sbj:3.pfv', 'e-da'),
    ('m6', 2, '∅', 'prefix', 'obj:3', None),
    ('m7', 2, 'eek', 'stem', 'see', 'e-eek'),
    ('m8', 2, 'da', 'suffix', 'sbj:3.pfv', 'e-da'),
]
SEG_VOCAB = {'id': 'v1', 'name': 'Lexicon', 'items': [
    {'id': f'e-{form}', 'form': form, 'metadata': {}}
    for form in ('m', 'hii', 'p', 'bul', 'da', 'eek')]}


def _segmented(*, typed=True, links=True, word_glosses=(), body=SEG_BODY, words=SEG_WORDS,
               morphemes=SEG_MORPHEMES):
    document = draft_tests._document(body=body, sentences=((0, len(body)),), words=words,
                                     gloss_spans=list(word_glosses))
    tokens, glosses, vocab_links = [], [], []
    for n, (mid, w, form, morph_type, gloss, entry) in enumerate(morphemes):
        begin, end = words[w]
        precedence = sum(1 for m in morphemes[:n] if m[1] == w) + 1
        meta = {'form': form, **({'morphType': morph_type} if typed else {})}
        tokens.append({'id': mid, 'begin': begin, 'end': end, 'precedence': precedence,
                       'metadata': meta})
        glosses.append({'id': f'g-{mid}', 'tokens': [mid], 'value': gloss})
        if links and entry:
            vocab_links.append({'id': f'l-{mid}', 'vocab_item': {'id': entry}, 'tokens': [mid]})
    document['text_layers'][0]['token_layers'].append({
        'id': 'morphL', 'name': 'Morphemes', 'config': {'plaid': {'role': 'morpheme'}},
        'tokens': tokens,
        'span_layers': [{'id': 'mglossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme'}},
                         'spans': glosses}],
        'vocabs': [{'id': 'v1', 'vocab_links': vocab_links}],
    })
    return document


def _segmented_nodes(document, vocab=SEG_VOCAB):
    service = _service(documents=[document])
    service.client.vocab_layers.get = lambda vocab_id, **kwargs: vocab
    helper = servicetest.run(service, REQUEST)
    assert helper.errors == []
    return _ops(service.client, 'spans.bulk_create')


def _segmented_run(document, vocab=SEG_VOCAB):
    return [(n['value'], n['metadata']['umr']['attrs'])
            for n in _segmented_nodes(document, vocab)]


def _participant(attrs):
    return [a for a in attrs if a['rel'] in (':refer-person', ':refer-number')]


def test_a_segmented_word_is_named_by_its_stem_never_an_affix_or_a_zero_morph():
    assert [concept for concept, _ in _segmented_run(_segmented())] == ['hii', 'bul', 'eek']


def test_untyped_morphemes_name_the_word_by_the_first_lexical_gloss():
    # No morph types: the stem is the morpheme whose gloss is lexical, so
    # neither 3.POS, CAUS nor the zero morph's `obj:3` names the word.
    concepts = [c for c, _ in _segmented_run(_segmented(typed=False, links=False))]
    assert concepts == ['blood', 'smear', 'see']


def test_a_person_on_an_affix_or_a_possessive_is_not_put_on_the_node():
    # 3.POS is the possessor's person and sbj:3 the subject's: neither is the
    # node's own, and the skeleton draws no node for them.
    for _, attrs in _segmented_run(_segmented()):
        assert _participant(attrs) == []
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('3.POSS', table)['possessive'] is True
    # A pronoun's own person and number stay, and so does a noun's plural.
    assert boot.own_attrs(boot.read_gloss('3SG', table), True) == [
        (':refer-person', '3rd'), (':refer-number', 'singular')]
    assert boot.own_attrs(boot.read_gloss('PL', table), False) == [
        (':refer-number', 'plural')]
    # A possessive beside a lexical part, or on an affix, is the possessor's.
    assert boot.own_attrs(boot.read_gloss('3SG.POSS-hand', table), True) == []
    assert boot.own_attrs(boot.read_gloss('3SG.POSS', table), False) == []
    assert boot.own_attrs(boot.read_gloss('PL.POSS-hand', table), True) == []
    assert boot.own_attrs(boot.read_gloss('go.3SG', table), True) == []
    assert boot.own_attrs(boot.read_gloss('go.3SG.NEG', table), True) == [(':polarity', '-')]


def test_a_free_possessive_pronoun_keeps_its_own_person_and_number():
    """A word glossed 3SG.POSS and nothing else is the possessor itself, not a
    noun it marks, so its node is where the person and number belong."""
    table = boot.ABBREVIATIONS
    assert boot.own_attrs(boot.read_gloss('3SG.POSS', table), True) == [
        (':refer-person', '3rd'), (':refer-number', 'singular')]
    assert boot.own_attrs(boot.read_gloss('1PL.POS', table), True) == [
        (':refer-person', '1st'), (':refer-number', 'plural')]

    # End to end: "The" glossed 3SG.POSS and linked to the entry "ani".
    document = _document(gloss_spans=[{'id': 'g1', 'tokens': ['w1'], 'value': '3SG.POSS'},
                                      *GLOSSES[1:]])
    word_layer = document['text_layers'][0]['token_layers'][1]
    word_layer['vocabs'][0]['vocab_links'].append(
        {'id': 'l2', 'vocab_item': {'id': 'i3', 'form': 'ani'}, 'tokens': ['w1']})
    service = _service(documents=[document])
    vocab = {**VOCAB, 'items': VOCAB['items'] + [{'id': 'i3', 'form': 'ani', 'metadata': {}}]}
    service.client.vocab_layers.get = lambda vocab_id, **kwargs: vocab
    assert servicetest.run(service, REQUEST).errors == []
    nodes = {n['value']: n['metadata']['umr']['attrs']
             for n in _ops(service.client, 'spans.bulk_create')}
    assert [(a['rel'], a['value']) for a in nodes['ani']] == [
        (':refer-person', '3rd'), (':refer-number', 'singular')]


def test_a_possessive_prefix_on_a_stem_still_leaves_the_noun_without_a_person():
    """The other side of the same rule: in m-hii the stem is hii, and 3.POS
    on the prefix is the possessor's, with or without the word's own gloss."""
    for word_glosses in ((), ({'id': 'gw', 'tokens': ['w1'], 'value': '3.POS-blood'},)):
        for concept, attrs in _segmented_run(_segmented(word_glosses=word_glosses)):
            assert _participant(attrs) == [], (concept, attrs)


def test_a_headword_of_several_words_is_a_hyphenated_concept():
    assert boot.concept_from("a va'") == "a-va'"
    # Nothing PENMAN would end a concept on survives.
    assert boot.concept_from('10:30 C# "x"') == '1030-c-x'


# --- compound glosses: sbj:3.pfv -------------------------------------------------------

def test_a_lower_case_abbreviation_beside_a_grammatical_part_is_grammatical():
    """Lamkang writes sbj:3.pfv on a verb's suffix: the 3 is grammatical by the
    case rule, so pfv and sbj beside it are too, and pfv is aspect. The stem's
    gloss is read with it, as the glosses of one word are."""
    table = boot.ABBREVIATIONS
    assert boot.read_glosses(['lay', 'sbj:3.pfv'], table)[1] == {
        'lexical': None, 'attrs': [(':refer-person', '3rd'), (':aspect', 'perfective')],
        'marked': [True, True], 'eventive': True, 'possessive': False, 'agreement': True}
    assert boot.read_glosses(['lay', 'obj:3'], table)[1]['lexical'] is None
    assert boot.read_gloss('go.3sg.ipfv', table) == {
        'lexical': 'go', 'attrs': [(':refer-person', '3rd'), (':refer-number', 'singular'),
                                   (':aspect', 'imperfective')],
        'marked': [True, True, True], 'eventive': True, 'possessive': False,
        'agreement': True}
    assert boot.read_gloss('go.3SG.prf', table)['eventive'] is True
    assert boot.read_glosses(['lay', 'sbj:3sg.pfv'], table)[1]['attrs'] == [
        (':refer-person', '3rd'), (':refer-number', 'singular'), (':aspect', 'perfective')]
    assert boot.read_gloss('lay-sbj:3.pfv', table)['lexical'] == 'lay'
    # Leipzig's other separators for one form of several meanings.
    assert boot.read_gloss('hit;PST', table) == {
        'lexical': 'hit', 'attrs': [], 'marked': [], 'eventive': True, 'possessive': False,
        'agreement': False}
    assert boot.read_gloss('sing\\PST', table)['lexical'] == 'sing'
    # An aspect abbreviation elects the root as a tense one does.
    assert boot.read_gloss('go.HAB', table)['eventive'] is True


def test_the_case_rule_still_holds_without_a_grammatical_part_beside():
    """A lower-case part is a word unless the same morpheme's gloss has a part
    grammatical by the case rule: not in a gloss of words only, and not
    because ANOTHER morpheme is grammatical."""
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('lay.pfv', table) == {
        'lexical': 'lay', 'attrs': [], 'marked': [], 'eventive': False, 'possessive': False,
        'agreement': False}
    assert boot.read_gloss('come.out', table)['lexical'] == 'come'
    assert boot.read_gloss('pass', table)['lexical'] == 'pass'
    assert boot.read_gloss('3SG-pfv', table)['lexical'] == 'pfv'
    assert boot.read_gloss('3SG-pfv', table)['eventive'] is False
    # A single letter stays a word even beside a grammatical part.
    assert boot.read_gloss('a.3SG', table)['lexical'] == 'a'


def test_a_word_that_spells_an_abbreviation_is_a_word_when_nothing_else_is():
    """pass.PST: read leniently, pass would be PASS and the word would have
    no lexical part, so the case rule stands for the whole word (ruling 2)."""
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('pass.PST', table)['lexical'] == 'pass'
    assert boot.read_gloss('pass.PST', table)['eventive'] is True
    assert boot.read_gloss('top.PL', table)['lexical'] == 'top'
    # The unit is the word: a stem's gloss beside it keeps the lenient reading.
    assert boot.read_glosses(['go', 'pass.PST'], table)[1]['lexical'] is None
    # A word glossed with abbreviations only is named by the first word-like one.
    assert boot.read_gloss('sbj:3.pfv', table)['lexical'] == 'sbj'
    body = 'dog passed\n'
    words = [(0, 3), (4, 10)]
    for gloss, concept in (('pass.PST', 'pass'), ('top.PL', 'top')):
        morphemes = [('m1', 0, 'dog', 'stem', 'dog', None), ('m2', 1, 'passed', 'stem', gloss, None)]
        document = _segmented(body=body, words=words, morphemes=morphemes)
        assert [c for c, _ in _segmented_run(document, _compound_vocab())] == ['dog', concept]


def test_only_a_gloss_that_could_name_the_word_keeps_it_from_the_fall_back():
    """The fall-back asks whether the word has a lexical part among the
    glosses that could name it: the word's own and its stems', one gloss line
    at a time. A clitic's lexical gloss, or another line's, does not take
    pass away from pass.PST, and a suffix never falls back itself."""
    body = 'pasand\n'
    words = [(0, 6)]
    clitic = [('m1', 0, 'pas', 'stem', 'pass.PST', None), ('m2', 0, 'and', 'enclitic', 'and', None)]
    assert _segmented_run(_segmented(body=body, words=words, morphemes=clitic),
                          _compound_vocab())[0][0] == 'pass'
    # sbj:3.pfv on a suffix stays grammatical beside a stem that falls back.
    suffix = [('m1', 0, 'pas', 'stem', 'pass.PST', None),
              ('m2', 0, 'and', 'suffix', 'sbj:3.pfv', None)]
    nodes = _segmented_nodes(_segmented(body=body, words=words, morphemes=suffix),
                             _compound_vocab())
    assert [n['value'] for n in nodes] == ['pass']
    assert (':aspect', 'perfective') in [(a['rel'], a['value'])
                                         for a in nodes[0]['metadata']['umr']['attrs']]
    # An English project: a Spanish word gloss does not change how the English
    # morpheme gloss reads.
    document = _segmented(body=body, words=words, morphemes=clitic[:1], word_glosses=(
        {'id': 'gw', 'tokens': ['w1'], 'value': 'pasar'},))
    mapping = [{'header': 'morpheme-gloss', 'lang': 'en', 'source': 'layer:mglossL'},
               {'header': 'word-gloss', 'lang': 'es', 'source': 'layer:glossL'}]
    service = _service(documents=[document])
    service.client.vocab_layers.get = lambda vocab_id, **kwargs: _compound_vocab()
    service.client.projects._project['config'] = {'umr': {'language': 'en', 'ilg': mapping}}
    assert servicetest.run(service, REQUEST).errors == []
    assert [n['value'] for n in _ops(service.client, 'spans.bulk_create')] == ['pass']


def test_the_verb_with_sbj_3_pfv_is_the_root():
    """∅-eek-da (obj:3-lay-sbj:3.pfv) after a noun: the verb is the root, not
    the first node, and its node carries the aspect but not the subject's
    person."""
    body = 'hii eekda\n'
    words = [(0, 3), (4, 9)]
    morphemes = [
        ('m1', 0, 'hii', 'stem', 'blood', 'e-hii'),
        ('m2', 1, '\u2205', 'prefix', 'obj:3', None),
        ('m3', 1, 'eek', 'stem', 'lay', 'e-eek'),
        ('m4', 1, 'da', 'suffix', 'sbj:3.pfv', 'e-da'),
    ]
    nodes = _segmented_nodes(_segmented(body=body, words=words, morphemes=morphemes))
    assert [n['value'] for n in nodes] == ['hii', 'eek']
    assert [bool(n['metadata']['umr'].get('root')) for n in nodes] == [False, True]
    assert [(a['rel'], a['value']) for a in nodes[1]['metadata']['umr']['attrs']] == [
        (':aspect', 'perfective')]


# --- compounds -------------------------------------------------------------------------

#: Lamkang har buu 'chicken coop': har 'fowl' + buu 'nest', two stems, each
#: linked to its own entry, and no link on the word.
COMPOUND_BODY = 'har buu\n'
COMPOUND_WORDS = [(0, 7)]
COMPOUND_MORPHEMES = [
    ('m1', 0, 'har', 'stem', 'fowl', 'e-har'),
    ('m2', 0, 'buu', 'stem', 'nest', 'e-buu'),
]


def _compound_vocab(*forms):
    return {'id': 'v1', 'name': 'Lexicon', 'items': [
        {'id': f'e-{form}', 'form': form, 'metadata': {}} for form in forms]}


def test_a_compound_the_lexicon_lists_is_named_by_its_headword():
    document = _segmented(body=COMPOUND_BODY, words=COMPOUND_WORDS, morphemes=COMPOUND_MORPHEMES)
    vocab = _compound_vocab('har', 'buu', 'har buu')
    assert [c for c, _ in _segmented_run(document, vocab)] == ['har-buu']


def test_a_compound_the_lexicon_does_not_list_takes_its_first_stem():
    document = _segmented(body=COMPOUND_BODY, words=COMPOUND_WORDS, morphemes=COMPOUND_MORPHEMES)
    assert [c for c, _ in _segmented_run(document, _compound_vocab('har', 'buu'))] == ['har']


def test_a_link_on_the_compound_itself_comes_first():
    document = _segmented(body=COMPOUND_BODY, words=COMPOUND_WORDS, morphemes=COMPOUND_MORPHEMES)
    word_layer = document['text_layers'][0]['token_layers'][1]
    word_layer['vocabs'] = [{'id': 'v1', 'vocab_links': [
        {'id': 'lw', 'vocab_item': {'id': 'e-coop'}, 'tokens': ['w1']}]}]
    vocab = _compound_vocab('har', 'buu', 'har buu', 'coop')
    assert [c for c, _ in _segmented_run(document, vocab)] == ['coop']


def test_a_word_of_one_stem_is_not_named_by_a_headword_it_happens_to_spell():
    # m-hii is one stem with a prefix: an entry spelled mhii does not name it.
    vocab = {**SEG_VOCAB, 'items': SEG_VOCAB['items'] + [
        {'id': 'e-mhii', 'form': 'mhii', 'metadata': {}}]}
    assert [c for c, _ in _segmented_run(_segmented(), vocab)][0] == 'hii'


@pytest.mark.parametrize('body, headword, concept', [
    ('harbuu', 'har buu', 'har-buu'),
    ('har-buu', 'harbuu', 'harbuu'),
    ('har buu', 'har-buu', 'har-buu'),
    ('Harbuu', 'har buu', 'har-buu'),
])
def test_a_compound_finds_its_entry_however_the_two_spell_the_join(body, headword, concept):
    """harbuu, har buu and har-buu are one compound: the lookup ignores the
    separators, and the concept is the entry's own spelling."""
    document = _segmented(body=f'{body}\n', words=[(0, len(body))], morphemes=COMPOUND_MORPHEMES)
    vocab = _compound_vocab('har', 'buu', headword)
    assert [c for c, _ in _segmented_run(document, vocab)] == [concept]


def test_an_untyped_affix_is_not_a_stem_of_a_compound():
    """Hand-segmented m-hii with no morph types: m is glossed 3.POS, which is
    not a lexical gloss, so the word has one stem and an entry spelled mhii
    does not name it."""
    morphemes = [('m1', 0, 'm', 'prefix', '3.POS', None), ('m2', 0, 'hii', 'stem', 'blood', 'e-hii')]
    document = _segmented(body='mhii\n', words=[(0, 4)], morphemes=morphemes, typed=False)
    assert [c for c, _ in _segmented_run(document, _compound_vocab('hii', 'mhii'))] == ['hii']
    # Two untyped morphemes each glossed as a word are a compound.
    document = _segmented(body=COMPOUND_BODY, words=COMPOUND_WORDS, morphemes=COMPOUND_MORPHEMES,
                          typed=False)
    assert [c for c, _ in _segmented_run(document, _compound_vocab('har', 'buu', 'harbuu'))] == [
        'harbuu']


def test_int_is_not_read_as_a_question():
    """INT is not a Leipzig abbreviation, and grammars use it for an
    intensifier (Lamkang IDEO:INT.rhythmic) as often as for a question, so the
    default table leaves it to a language table. Q is Leipzig's question."""
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('IDEO:INT.rhythmic', table)['attrs'] == []
    assert boot.read_gloss('Q', table)['attrs'] == [(':mode', 'interrogative')]


def test_the_digit_0_is_a_form_and_not_a_zero_morph():
    """plaid-igt's zero morph is U+2205 and nothing else (zeroMorph.js): a
    numeral written 0 is a real form, and the word it stands for is named."""
    assert not boot.can_name_word('stem', '∅') and not boot.can_name_word('stem', '')
    assert boot.can_name_word('stem', '0')
    morphemes = [('m1', 0, 'I', 'stem', '1SG', None), ('m2', 1, '0', 'stem', 'zero', None)]
    document = _segmented(body='I 0\n', words=[(0, 1), (2, 3)], morphemes=morphemes)
    assert [c for c, _ in _segmented_run(document, _compound_vocab())] == ['zero']


@pytest.mark.parametrize('gloss', ['水', 'पानी', 'ماء', 'go.水'])
def test_a_gloss_in_a_script_with_no_case_is_lexical(gloss):
    """The case rule asks for a capital, as igt's isLexicalPart does: a script
    with no letter case has none, so its gloss is a word and names the node."""
    read = boot.read_gloss(gloss, boot.ABBREVIATIONS)
    assert read['lexical'] == gloss.split('.')[0]
    # A capital with no lower case beside it is still grammatical.
    assert boot.read_gloss('水.DEM', boot.ABBREVIATIONS)['lexical'] == '水'
    assert boot.read_gloss('DEM', boot.ABBREVIATIONS)['lexical'] is None


@pytest.mark.parametrize('gloss', ['1-see-PL', 'see-3-PL', 'PL-see-1', '1-see.PL'])
def test_a_number_beside_an_agreement_person_is_the_agreeing_participants(gloss):
    """Georgian v-xedav-t, 1-see-PL: the plural agrees with the subject as the
    person does, on its own morpheme or not, so neither goes on the verb."""
    table = boot.ABBREVIATIONS
    assert boot.own_attrs(boot.read_gloss(gloss, table), True) == []


def test_a_segmented_verb_leaves_its_agreement_number_off_the_node():
    """The same verb segmented, each morpheme glossed on its own: the PL
    morpheme is not the stem and agrees with the person beside it."""
    morphemes = [('m1', 0, 'v', 'prefix', '1', None), ('m2', 0, 'xedav', 'stem', 'see', None),
                 ('m3', 0, 't', 'suffix', 'PL', None)]
    document = _segmented(body='vxedavt\n', words=[(0, 7)], morphemes=morphemes)
    assert _segmented_run(document, _compound_vocab()) == [('see', [])]
    # A plural suffix on a noun with no person beside it is the noun's.
    morphemes = [('m1', 0, 'kuca', 'stem', 'house', None), ('m2', 0, 'ebi', 'suffix', 'PL', None)]
    document = _segmented(body='kucaebi\n', words=[(0, 7)], morphemes=morphemes)
    assert [(c, [(a['rel'], a['value']) for a in attrs])
            for c, attrs in _segmented_run(document, _compound_vocab())] == [
        ('house', [(':refer-number', 'plural')])]


def test_a_possessed_noun_keeps_its_own_plural():
    """house-PL-1SG.POSS: the possessor's person and number are on their own
    morpheme and are dropped, and the noun's plural on another is kept. A
    number fused with the possessive in one morpheme stays the possessor's."""
    table = boot.ABBREVIATIONS
    assert boot.own_attrs(boot.read_gloss('house-PL-1SG.POSS', table), True) == [
        (':refer-number', 'plural')]
    assert boot.own_attrs(boot.read_gloss('1SG.POSS-house-PL', table), True) == [
        (':refer-number', 'plural')]
    assert boot.own_attrs(boot.read_gloss('PL.POSS-hand', table), True) == []
    assert boot.own_attrs(boot.read_gloss('go-3SG', table), True) == []
    document = _segmented(body='kuca\n', words=[(0, 4)], morphemes=[], word_glosses=(
        {'id': 'gw', 'tokens': ['w1'], 'value': 'house-PL-1SG.POSS'},))
    assert [(c, [(a['rel'], a['value']) for a in attrs])
            for c, attrs in _segmented_run(document, _compound_vocab())] == [
        ('house', [(':refer-number', 'plural')])]


@pytest.mark.parametrize('value, why', [
    ([':definite', '+'], 'UMR has no such relation'),
    ([':polarityy', '-'], 'Did you mean :polarity?'),
    (['refer-number', 'plural'], 'must start with a colon'),
    ([':refer-number'], 'a relation and a value'),
    ([':aspect', 'state', 'extra'], 'a relation and a value'),
    (['possesive'], 'a relation and a value'),
    ([':manner', 'quickly'], 'not an attribute'),
    ([':ARG0', 'foo'], 'not an attribute'),
    ([':ARG1-of', 'y'], 'not an attribute'),
    ([':mod-of', 'y'], 'not an attribute'),
    ([':refer-number', 'plurall'], 'Did you mean plural?'),
    ([':polarity', ''], 'a value of one word'),
    ([':mode', 'yes no'], 'a value of one word'),
])
def test_a_language_table_is_refused_when_it_names_no_umr_relation(tmp_path, value, why):
    """A table is a writer too: what it maps to is written as an attribute, so
    a relation UMR does not have is refused as the app and the assistant do."""
    path = tmp_path / 'table.json'
    path.write_text(json.dumps({'DEF': value}))
    with pytest.raises(ValueError, match=re.escape(why)):
        boot.load_abbreviations(str(path))


def test_every_default_abbreviation_is_a_umr_relation_or_a_marker():
    from plaid_client.workflows.umr import unknown_relation_problem
    for key, what in boot.ABBREVIATIONS.items():
        assert what in (('root',), ('possessive',)) or (
            len(what) == 2 and unknown_relation_problem(what[0]) is None), key
        if what not in (('root',), ('possessive',)):
            assert boot._table_entry(key, list(what)) == what, key


def test_a_language_table_may_map_to_any_attribute_value_the_validator_takes(tmp_path):
    path = tmp_path / 'table.json'
    path.write_text(json.dumps({'OBV': [':refer-person', '4th'], 'ID': [':mod', 'ideophone'],
                                'NMZ': [':op2', 'x'], 'AUG': [':degree', 'intensifier']}))
    table = boot.load_abbreviations(str(path))
    assert table['ID'] == (':mod', 'ideophone') and table['NMZ'] == (':op2', 'x')


# --- which layers are glosses ---------------------------------------------------

def _with_pos_line(document, values):
    """A word-scoped part-of-speech field beside the gloss, as IGT makes one."""
    word_layer = document['text_layers'][0]['token_layers'][1]
    word_layer['span_layers'].append({
        'id': 'posL', 'name': 'POS', 'config': {'igt': {'scope': 'Word', 'lang': 'en'}},
        'spans': [{'id': f'p{n}', 'tokens': [w], 'value': v}
                  for n, (w, v) in enumerate(values.items())]})
    return document


def test_a_part_of_speech_line_never_names_a_node():
    """Only a gloss line names a node, classified as the app's ILG mapping
    classifies it (ilg.js): a field named POS is the part-of-speech line, and
    'Praoloon', with no gloss, gets no node rather than a node named npr."""
    document = _with_pos_line(
        draft_tests._document(body='Praoloon went\n', sentences=((0, 14),),
                              words=[(0, 8), (9, 13)],
                              gloss_spans=[{'id': 'g2', 'tokens': ['w2'], 'value': 'go.PST'}]),
        {'w1': 'npr', 'w2': 'v'})
    assert [c for c, _ in _segmented_run(document, _compound_vocab())] == ['go']


def test_the_projects_own_ilg_mapping_says_which_layer_is_the_gloss():
    """A mapping on the project (config.umr.ilg) is the authority: the line it
    files as Word Gloss names the node, whatever the layer is called, and a
    layer it files as anything else does not."""
    document = _with_pos_line(_document(), {'w2': 'canine', 'w3': 'yap'})
    service = _service(documents=[document])
    service.client.projects._project['config'] = {'umr': {'ilg': [
        {'header': 'word-gloss', 'lang': 'en', 'source': 'layer:posL'},
        {'header': 'pos', 'lang': None, 'source': 'layer:glossL'},
    ]}}
    assert servicetest.run(service, REQUEST).errors == []
    # barks keeps its headword; dog is named by the mapped line, not dog-PL.
    assert [n['value'] for n in _ops(service.client, 'spans.bulk_create')] == ['canine', 'bark']


def test_a_gloss_in_the_projects_language_names_the_node_whatever_its_scope():
    """A Spanish project with an English morpheme gloss and a Spanish word
    gloss: the concept is Spanish, though a morpheme gloss is read before a
    word gloss in the same language."""
    morphemes = [('m1', 0, 'kuca', 'stem', 'house', None), ('m2', 0, 'ebi', 'suffix', 'PL', None)]
    document = _segmented(body='kucaebi\n', words=[(0, 7)], morphemes=morphemes, word_glosses=(
        {'id': 'gw', 'tokens': ['w1'], 'value': 'casa-PL'},))
    mapping = [{'header': 'morpheme-gloss', 'lang': 'en', 'source': 'layer:mglossL'},
               {'header': 'word-gloss', 'lang': 'es', 'source': 'layer:glossL'}]
    service = _service(documents=[document])
    service.client.vocab_layers.get = lambda vocab_id, **kwargs: _compound_vocab()
    service.client.projects._project['config'] = {'umr': {'language': 'es', 'ilg': mapping}}
    assert servicetest.run(service, REQUEST).errors == []
    assert [n['value'] for n in _ops(service.client, 'spans.bulk_create')] == ['casa']
    # With no language, the stem's gloss comes first.
    service = _service(documents=[document])
    service.client.vocab_layers.get = lambda vocab_id, **kwargs: _compound_vocab()
    service.client.projects._project['config'] = {'umr': {'ilg': mapping}}
    assert servicetest.run(service, REQUEST).errors == []
    assert [n['value'] for n in _ops(service.client, 'spans.bulk_create')] == ['house']


# The app's own classification, run in node: which layer is which line must be
# the same on the canvas and in the skeleton. Skips where node cannot run, and
# never when the two disagree.
ILG_JS = SERVICES.parent / 'src' / 'domain' / 'ilg.js'
_NAMES = ('Gloss', 'Word gloss', 'Meaning', 'POS', 'Part of speech', 'Tag', 'Class', 'Category',
          'Morph type', 'Translation', 'Free translation', 'Notes', '', 'Glosa', 'PARTS', 'pos-en')
_LANGS = ('en', 'pt-BR', 'qaa-x-eng', None, 'ENG', 'e', 'lmk_x')
ILG_LAYERS = [{'id': f'L{n}', 'name': name, 'scope': scope, 'lang': _LANGS[n % len(_LANGS)]}
              for n, (name, scope) in enumerate(
                  (name, scope) for name in _NAMES for scope in ('word', 'morpheme', 'sentence'))]
ILG_CONFIGS = [
    None, [],
    [{'header': 'word-gloss', 'lang': 'en', 'source': 'layer:L0'},
     {'header': 'morphemes', 'lang': None, 'source': 'morphemes'},
     {'header': 'pos', 'lang': None, 'source': 'layer:L9'},
     {'header': None, 'lang': None, 'source': 'stored'}],
    # A layer gone (a copied project): the proposal's layer for the same slot.
    [{'header': 'morpheme-gloss', 'lang': 'en', 'source': 'layer:gone'},
     {'header': 'word-gloss', 'lang': 'fr', 'source': 'layer:gone2'},
     {'header': 'sentence-gloss', 'lang': 'und', 'source': 'layer:L2'}],
]


def _umr_layers(specs, morphemes=True):
    from plaid_client.workflows.umr import GlossLayer, UmrLayers
    return UmrLayers(*([{}] * 7), morpheme_layer={'id': 'morphL'} if morphemes else None,
                     gloss_layers=[GlossLayer(id=s['id'], name=s['name'], scope=s['scope'],
                                              lang=s['lang']) for s in specs])


def test_the_gloss_line_mapping_is_the_apps():
    import shutil
    import subprocess
    from plaid_client.workflows.umr import layers as umr_layers
    exe = shutil.which('node')
    if not exe or not ILG_JS.is_file():
        pytest.skip('node or ilg.js is not here')
    info = {'morphemeTokenLayer': {'id': 'morphL'},
            'glossLayers': [{'layer': {'id': s['id'], 'name': s['name']}, 'scope': s['scope'],
                             'lang': s['lang']} for s in ILG_LAYERS]}
    script = (f"const m = await import({json.dumps(ILG_JS.as_uri())});\n"
              f"const info = {json.dumps(info)};\n"
              f"const configs = {json.dumps(ILG_CONFIGS)};\n"
              "console.log(JSON.stringify(configs.map((c) => m.resolveIlg(c, info))));\n")
    out = subprocess.run([exe, '--input-type=module', '-e', script], capture_output=True,
                         text=True, timeout=60, check=True).stdout
    layers = _umr_layers(ILG_LAYERS)
    assert [umr_layers.resolve_ilg(c, layers) for c in ILG_CONFIGS] == json.loads(out)


def test_the_default_table_knows_the_abbreviations_igt_knows():
    """With no language table, the lenient reading knows what plaid-igt's does
    (GLOSS_ABBREVIATIONS, pinned to tagsets.js by the client's mirror test), and
    every abbreviation the table gives a meaning is one of them."""
    from plaid_client.workflows.igt.glossing import GLOSS_ABBREVIATIONS
    assert boot._known(boot.ABBREVIATIONS) == GLOSS_ABBREVIATIONS
    assert set(boot.ABBREVIATIONS) <= GLOSS_ABBREVIATIONS
