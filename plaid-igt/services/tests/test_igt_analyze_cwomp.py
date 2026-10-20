"""The CWoMP analyze service: how a project's analyses become training data
and lexicon entries, and a whole request with the model replaced at its seam
(``service.model_for``), so no GPU, no checkpoint and no CWoMP checkout are
needed.

Run: pytest plaid-igt/services/tests
"""

import pathlib

from plaid_client import testing as servicetest

SERVICES = pathlib.Path(__file__).resolve().parent.parent
DOC = 'd1'

cwomp = servicetest.load_service(SERVICES / 'igt_analyze_cwomp.py')

REQUEST = {
    'document_id': DOC,
    'project_id': 'p1',
    'word_token_layer_id': 'wordL',
    'morpheme_token_layer_id': 'morphL',
    'sentence_token_layer_id': 'sentL',
    'gloss_field': 'Gloss',
    'translation_field': 'Translation',
    'overwrite': False,
}


# --- the lexicon's spelling ----------------------------------------------------

def test_a_clitic_keeps_its_side_and_an_affix_of_the_same_form_stays_apart():
    enc = cwomp.encode_form('ra', 'enclitic')
    pro = cwomp.encode_form('ra', 'proclitic')
    affix = cwomp.encode_form('ra', 'suffix')
    assert len({enc, pro, affix}) == 3
    assert cwomp.decode_form(enc) == ('ra', 'enclitic')
    assert cwomp.decode_form(pro) == ('ra', 'proclitic')
    assert cwomp.decode_form(affix) == ('ra', None)
    # None of them is split by CWoMP's own reading of a word.
    for f in (enc, pro, affix):
        assert '-' not in f and '=' not in f


def test_hyphens_equals_and_spaces_inside_a_piece_survive_the_round_trip():
    for s in ('self-made', 'a=b', 'go out', 'plain'):
        e = cwomp.encode_piece(s)
        assert not set(e) & {'-', '=', ' '}
        assert cwomp.decode_piece(e) == s


def test_joiners_put_equals_on_the_clitic_side():
    assert cwomp.joiners_for([None, None, 'enclitic']) == ['-', '=']
    assert cwomp.joiners_for(['proclitic', None]) == ['=']
    assert cwomp.joiners_for([None]) == []


# --- training data -------------------------------------------------------------

def _word(surface, morphs, glosses):
    """A derived word: `morphs` [(form, metadata)], `glosses` [(value, metadata)]."""
    ms = [{'id': f'{surface}-{k}', 'metadata': {'form': f, **meta}} for k, (f, meta) in enumerate(morphs)]
    return {'surface': surface, 'morphs': ms,
            'morph_spans': {m['id']: [('glossL', {'value': v, 'metadata': gm})]
                            for m, (v, gm) in zip(ms, glosses)}}


MACHINE = {'prov': 'inferred', 'provSource': 'service:x'}
VERIFIED = {**MACHINE, 'provConfirmed': True}


def test_a_word_counts_only_when_a_person_made_or_verified_every_piece():
    person = _word('evler', [('ev', {}), ('ler', {})], [('house', {}), ('PL', VERIFIED)])
    assert cwomp.trusted_analysis(person, 'glossL') == [('ev', 'house'), ('ler', 'PL')]
    machine_gloss = _word('evler', [('ev', {}), ('ler', {})], [('house', {}), ('PL', MACHINE)])
    assert cwomp.trusted_analysis(machine_gloss, 'glossL') is None
    machine_form = _word('evler', [('ev', MACHINE), ('ler', {})], [('house', {}), ('PL', {})])
    assert cwomp.trusted_analysis(machine_form, 'glossL') is None
    missing = _word('evler', [('ev', {}), ('ler', {})], [('house', {})])
    assert cwomp.trusted_analysis(missing, 'glossL') is None


def test_a_sentence_is_training_data_only_when_every_word_is_trusted():
    good = _word('ev', [('ev', {})], [('house', {})])
    bad = _word('gel', [('gel', {})], [('come', MACHINE)])
    s = {'id': 's1', 'translation': 'the  house', 'words': [good, good]}
    assert cwomp.sentence_record(s, 'glossL') == {
        'id': 's1', 't': 'ev ev', 'm': 'ev ev', 'g': 'house house', 'l': 'the house'}
    assert cwomp.sentence_record({**s, 'words': [good, bad]}, 'glossL') is None


def test_the_training_file_is_sigmorphon_lines(tmp_path):
    path = tmp_path / 'prj-train'
    cwomp.write_split(path, [{'t': 'a b', 'm': 'a b-c', 'g': 'x y-Z', 'l': 'tr'},
                             {'t': 'd', 'm': 'd', 'g': 'q', 'l': ''}])
    assert path.read_text() == '\\t a b\n\\m a b-c\n\\g x y-Z\n\\l tr\n\n\\t d\n\\m d\n\\g q\n'


# --- a request -----------------------------------------------------------------

class _Model:
    """Stands in for a loaded CwompModel: every word gets `picked`."""

    def __init__(self, picked):
        self.picked = picked
        self.lexicon = []
        self.queries = []

    def describe(self):
        return {'model': 'cwomp-test'}

    def set_lexicon(self, entries):
        self.lexicon = sorted(entries)

    def query(self, word, transcript, translation):
        q = f'{word}|{transcript}|{translation}'
        self.queries.append(q)
        return q

    def encode_queries(self, queries):
        return list(queries)

    def analyze(self, emb):
        return self.picked


def _document():
    return {
        'id': DOC, 'version': 3,
        'text_layers': [{
            'id': 'textL', 'text': {'id': 't', 'body': 'ev geliyor .'},
            'token_layers': [
                {'id': 'sentL', 'name': 'Sentences', 'tokens': [{'id': 's1', 'begin': 0, 'end': 12}],
                 'span_layers': [{'id': 'trL', 'name': 'Translation', 'config': {'igt': {'scope': 'Sentence'}},
                                  'spans': [{'id': 'tr1', 'tokens': ['s1'], 'value': 'the house comes'}]}],
                 'vocabs': []},
                {'id': 'wordL', 'name': 'Words',
                 'config': {'igt': {'ignoredTokens': {'type': 'unicodePunctuation', 'whitelist': []}}},
                 'tokens': [{'id': 'w1', 'text': 't', 'begin': 0, 'end': 2, 'metadata': {}},
                            {'id': 'w2', 'text': 't', 'begin': 3, 'end': 10, 'metadata': {}},
                            {'id': 'w3', 'text': 't', 'begin': 11, 'end': 12, 'metadata': {}}],
                 'span_layers': [], 'vocabs': []},
                {'id': 'morphL', 'name': 'Morphemes', 'tokens': [],
                 'span_layers': [{'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme'}},
                                  'spans': []}],
                 'vocabs': []},
            ],
        }],
    }


def _service(picked):
    service = cwomp.CwompService()
    model = _Model(picked)
    service.model_for = lambda project_id: model
    service.confirmed_entries = lambda *a: {('ev', 'house')}
    service.client = servicetest.FakeClient([_document()])
    return service, model


def test_every_morpheme_and_gloss_carries_its_probability_and_a_clitic_its_side():
    enclitic = cwomp.encode_form('yor', 'enclitic')
    service, model = _service([('gel', 'come', 0.9), (enclitic, 'PROG', 0.4)])
    helper = servicetest.run(service, REQUEST)
    assert helper.errors == []
    [result] = helper.results
    assert result['words_written'] == 2
    # The query had the word, its sentence and the translation.
    assert model.queries[0] == 'ev|ev geliyor|the house comes'
    morphs = [c['kwargs']['metadata'] for kind, c in service.client.calls if kind == 'tokens.create']
    assert [m['form'] for m in morphs] == ['gel', 'yor', 'gel', 'yor']
    assert [m.get('morphType') for m in morphs] == [None, 'enclitic', None, 'enclitic']
    assert [m['provProb'] for m in morphs] == [0.9, 0.4, 0.9, 0.4]
    assert morphs[0]['provDetail']['boundaries'] == '='
    glosses = [(c['args'][2], c['args'][3]) for kind, c in service.client.calls if kind == 'spans.create']
    assert [(v, m['provProb']) for v, m in glosses] == [('come', 0.9), ('PROG', 0.4)] * 2


def test_an_uncalibrated_model_writes_no_probability():
    service, _ = _service([('gel', 'come', None)])
    servicetest.run(service, REQUEST)
    morphs = [c['kwargs']['metadata'] for kind, c in service.client.calls if kind == 'tokens.create']
    assert morphs and all('provProb' not in m for m in morphs)


def test_a_project_with_no_model_is_told_how_to_train_one():
    service, _ = _service([])
    service.model_for = lambda project_id: None
    helper = servicetest.run(service, REQUEST)
    assert helper.results == []
    assert 'igt_analyze_cwomp.py train p1' in helper.errors[0]
