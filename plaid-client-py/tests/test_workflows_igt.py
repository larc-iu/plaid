"""Tests for plaid_client.workflows.igt (the model-independent half of an
interlinear analysis service).

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.igt import (
    ParsedWord, parse_interleaved, align_words, analysis_for, clitic_types,
    derive, word_state, select_targets, is_token_ignored, chunk_plans,
)


# --- interleaved format ---------------------------------------------------------

def test_parsed_word_reads_glosses_segments_and_joiners():
    w = ParsedWord('house(ev)-PL(ler)=1PL(imiz)')
    assert w.glosses == ['house', 'PL', '1PL']
    assert w.segments == ['ev', 'ler', 'imiz']
    assert w.joiners == ['-', '=']
    assert w.surface == 'evlerimiz'
    assert not w.malformed


def test_malformed_words_degrade_to_one_morpheme_with_the_joined_gloss():
    w = ParsedWord('house-PL')
    assert w.malformed
    a = analysis_for('evler', w)
    assert a == {'segments': ['evler'], 'glosses': ['house-PL'], 'types': [None], 'joiners': [],
                 'degraded': True, 'surface_mismatch': False}


def test_analysis_for_flags_surface_mismatch_and_types_clitics():
    a = analysis_for('evlerdir', ParsedWord('house(ev)-PL(ler)=COP(dir)'))
    assert a['segments'] == ['ev', 'ler', 'dir']
    assert a['types'] == [None, None, 'enclitic']
    assert a['joiners'] == ['-', '=']
    assert not a['surface_mismatch'] and not a['degraded']
    assert analysis_for('evlerdi', ParsedWord('house(ev)-PL(ler)=COP(dir)'))['surface_mismatch']


def test_clitic_types_edge_rule_then_gloss_case():
    assert clitic_types(['='], ['DET', 'house']) == ['proclitic', None]  # two pieces: positional tie, caps left
    assert clitic_types(['='], ['house', 'DET']) == [None, 'enclitic']
    assert clitic_types(['=', '-'], ['x', 'y', 'z']) == ['proclitic', None, None]  # first boundary: left is first
    assert clitic_types(['-', '='], ['x', 'y', 'z']) == [None, None, 'enclitic']


# --- alignment --------------------------------------------------------------------

def test_align_words_fast_path_and_merge_and_drop():
    outs = parse_interleaved('house(ev) come(gel)-PROG(iyor)')
    assert align_words(['ev', 'geliyor'], outs) == outs
    # the model split one input word in two: merged back with a '-' boundary
    merged = align_words(['evler'], parse_interleaved('house(ev) PL(ler)'))
    assert merged[0] is not None and merged[0].segments == ['ev', 'ler']
    # a hallucinated punctuation word is dropped; unrelated output leaves None
    mapping = align_words(['ev', 'gel'], parse_interleaved('house(ev) .(.) come(gel)'))
    assert [o.surface for o in mapping] == ['ev', 'gel']
    assert align_words(['kalem'], parse_interleaved('house(ev)')) == [None]


# --- derive + write contract ---------------------------------------------------------

MACHINE = {'prov': 'inferred', 'provSource': 'service:x'}
VERIFIED = {**MACHINE, 'provConfirmed': True}


def raw_doc(*, word_meta=None, gloss_meta=None, morph2=None):
    body = 'ev geliyor .'
    words = [
        {'id': 'w1', 'text': 't', 'begin': 0, 'end': 2, 'metadata': word_meta or {'orthog:Latin': 'EV'}},
        {'id': 'w2', 'text': 't', 'begin': 3, 'end': 10, 'metadata': {}},
        {'id': 'w3', 'text': 't', 'begin': 11, 'end': 12, 'metadata': {}},
    ]
    morphs = [
        {'id': 'm1', 'text': 't', 'begin': 0, 'end': 2, 'precedence': 1, 'metadata': {}},
        {'id': 'm2', 'text': 't', 'begin': 3, 'end': 10, 'precedence': 1, 'metadata': {'form': 'gel'}},
    ]
    if morph2:
        morphs.append({'id': 'm3', 'text': 't', 'begin': 3, 'end': 10, 'precedence': 2, 'metadata': morph2})
    gloss_spans = []
    if gloss_meta is not None:
        gloss_spans.append({'id': 'g1', 'tokens': ['m2'], 'value': 'come', 'metadata': gloss_meta})
    return {'text_layers': [{
        'text': {'id': 't', 'body': body},
        'token_layers': [
            {'id': 'sentL', 'tokens': [{'id': 's1', 'begin': 0, 'end': 12}],
             'span_layers': [{'id': 'trL', 'name': 'Translation', 'config': {'igt': {'scope': 'Sentence'}},
                              'spans': [{'id': 'tr1', 'tokens': ['s1'], 'value': 'the house is coming'}]}]},
            {'id': 'wordL', 'config': {'igt': {'ignoredTokens': {'type': 'unicodePunctuation', 'whitelist': []}}},
             'tokens': words, 'span_layers': [], 'vocabs': []},
            {'id': 'morphL', 'tokens': morphs,
             'span_layers': [{'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme'}},
                              'spans': gloss_spans}],
             'vocabs': []},
        ],
    }]}


def test_derive_walks_sentences_words_morphemes_ignoring_punctuation():
    sentences, gloss_id = derive(raw_doc(), 'wordL', 'morphL', 'sentL',
                                 gloss_field='Gloss', translation_field='Translation', orthography='Latin')
    assert gloss_id == 'glossL'
    [s] = sentences
    assert s['translation'] == 'the house is coming'
    assert [w['surface'] for w in s['words']] == ['ev', 'geliyor']  # '.' ignored
    assert [w['text'] for w in s['words']] == ['EV', 'geliyor']  # orthography, surface fallback
    assert [m['id'] for m in s['words'][1]['morphs']] == ['m2']


def test_derive_rejects_a_missing_gloss_field_with_a_helpful_message():
    try:
        derive(raw_doc(), 'wordL', 'morphL', 'sentL', gloss_field='Nope')
    except ValueError as e:
        assert 'Gloss' in str(e)
    else:
        raise AssertionError('expected ValueError')


def test_is_token_ignored():
    cfg = {'type': 'unicodePunctuation', 'whitelist': ['$']}
    assert is_token_ignored('.', cfg) and not is_token_ignored('$', cfg)
    assert not is_token_ignored('😀', cfg) and not is_token_ignored('ev', cfg)
    assert is_token_ignored('x', {'type': 'blacklist', 'blacklist': ['x']})
    assert not is_token_ignored('.', None)


def words_of(doc):
    sentences, _ = derive(doc, 'wordL', 'morphL', 'sentL', gloss_field='Gloss')
    return sentences


def test_word_state_votes_by_provenance():
    s = words_of(raw_doc())
    assert word_state(s[0]['words'][0]) == 'unanalyzed'  # bare default morpheme, nothing attached
    assert word_state(s[0]['words'][1]) == 'protected'  # form 'gel' != surface, human-made
    s = words_of(raw_doc(gloss_meta=MACHINE, morph2=MACHINE))
    # the first morpheme's human-looking form still votes: mixed -> protected
    assert word_state(s[0]['words'][1]) == 'protected'
    doc = raw_doc(gloss_meta=MACHINE, morph2=MACHINE)
    doc['text_layers'][0]['token_layers'][2]['tokens'][1]['metadata'] = {'form': 'gel', **MACHINE}
    assert word_state(words_of(doc)[0]['words'][1]) == 'machine'
    doc['text_layers'][0]['token_layers'][2]['tokens'][1]['metadata'] = {'form': 'gel', **VERIFIED}
    assert word_state(words_of(doc)[0]['words'][1]) == 'protected'
    doc['text_layers'][0]['token_layers'][2]['tokens'] = []
    assert word_state(words_of(doc)[0]['words'][0]) == 'nomorph'


def test_select_targets_applies_the_write_contract():
    s = words_of(raw_doc())
    targets, skipped = select_targets(s, overwrite=False)
    assert [(sent['id'], idxs) for sent, idxs in targets] == [('s1', [0])]
    assert skipped == {'protected': 1, 'no_morpheme': 0}
    assert s[0]['words'][1]['state'] == 'protected'
    targets, skipped = select_targets(s, overwrite=True)
    assert [idxs for _, idxs in targets] == [[0, 1]]
    assert skipped == {'protected': 0, 'no_morpheme': 0}


def test_chunk_plans_respects_the_op_budget():
    s = words_of(raw_doc())
    w = s[0]['words'][0]
    plan = {'word': w, 'analysis': analysis_for('ev', ParsedWord('house(ev)'))}  # 2 ops
    assert chunk_plans([plan] * 5, budget=4) == [[plan, plan], [plan, plan], [plan]]
    assert chunk_plans([plan], budget=1) == [[plan]]  # never an empty chunk
