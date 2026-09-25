"""The skeleton-from-glosses service, driven end to end on the same harness
as the draft service: no model, so the whole run is the reading of the
glosses and links and the writing of the anchors and nodes.

Run: pytest -q services/tests, from plaid-umr. Runs from the base env.
"""

import json
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
        'lexical': 'bark', 'attrs': [], 'eventive': True, 'possessive': False}
    assert boot.read_gloss('3SG', table) == {
        'lexical': None, 'attrs': [(':refer-person', '3rd'), (':refer-number', 'singular')],
        'eventive': False, 'possessive': False}
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
    assert 'no word has a vocabulary link or a gloss' in result['notice']['message']
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
    """Lamkang writes sbj:3.pfv: the 3 is grammatical by the case rule, so pfv
    and sbj beside it are too, and pfv is aspect."""
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('sbj:3.pfv', table) == {
        'lexical': None, 'attrs': [(':refer-person', '3rd'), (':aspect', 'perfective')],
        'eventive': True, 'possessive': False}
    assert boot.read_gloss('obj:3', table)['lexical'] is None
    assert boot.read_gloss('go.3sg.ipfv', table) == {
        'lexical': 'go', 'attrs': [(':refer-person', '3rd'), (':refer-number', 'singular'),
                                   (':aspect', 'imperfective')],
        'eventive': True, 'possessive': False}
    assert boot.read_gloss('go.3SG.prf', table)['eventive'] is True
    assert boot.read_gloss('sbj:3sg.pfv', table)['attrs'] == [
        (':refer-person', '3rd'), (':refer-number', 'singular'), (':aspect', 'perfective')]
    assert boot.read_gloss('lay-sbj:3.pfv', table)['lexical'] == 'lay'
    # Leipzig's other separators for one form of several meanings.
    assert boot.read_gloss('hit;PST', table) == {
        'lexical': 'hit', 'attrs': [], 'eventive': True, 'possessive': False}
    assert boot.read_gloss('sing\\PST', table)['lexical'] == 'sing'
    # An aspect abbreviation elects the root as a tense one does.
    assert boot.read_gloss('go.HAB', table)['eventive'] is True


def test_the_case_rule_still_holds_without_a_grammatical_part_beside():
    """A lower-case part is a word unless the same morpheme's gloss has a part
    grammatical by the case rule: not in a gloss of words only, and not
    because ANOTHER morpheme is grammatical."""
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('lay.pfv', table) == {
        'lexical': 'lay', 'attrs': [], 'eventive': False, 'possessive': False}
    assert boot.read_gloss('come.out', table)['lexical'] == 'come'
    assert boot.read_gloss('pass', table)['lexical'] == 'pass'
    assert boot.read_gloss('3SG-pfv', table)['lexical'] == 'pfv'
    assert boot.read_gloss('3SG-pfv', table)['eventive'] is False
    # A single letter stays a word even beside a grammatical part.
    assert boot.read_gloss('a.3SG', table)['lexical'] == 'a'


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
