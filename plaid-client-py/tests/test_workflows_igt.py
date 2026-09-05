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
    normalize_tagset, read_tagsets, tagset_for, vocab_tagset_for, governed_fields, mode_rule, value_lines,
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


# --- cases carried over from the PolyGloss service's own tests ------------------------

def test_align_dropped_hallucinated_and_shifted_words():
    # the model dropped the second word: 'bbb' stays None, the rest align
    m = align_words(['aaa', 'bbb', 'ccc'], parse_interleaved('A(aaa) C(ccc)'))
    assert m[0].raw == 'A(aaa)' and m[1] is None and m[2].raw == 'C(ccc)'
    # a hallucinated word in the output is skipped
    m = align_words(['aaa', 'bbb'], parse_interleaved('A(aaa) X(xxx) B(bbb)'))
    assert m[0].raw == 'A(aaa)' and m[1].raw == 'B(bbb)'
    # same count but shifted (dropped + junk appended): the fast path must not fire
    m = align_words(['aaa', 'bbb', 'ccc'], parse_interleaved('A(aaa) C(ccc) Z(zzz)'))
    assert m[0].raw == 'A(aaa)' and m[1] is None and m[2].raw == 'C(ccc)'
    # non-Latin fast path
    out = parse_interleaved('1pl.gen(чи) teacher(муаллим) friend(юлдаш)-PL(ар)-ERG(и)')
    assert align_words(['Чи', 'муаллим', 'юлдашари'], out) == out


def test_clitic_defaults_and_undecidable_interior_boundary():
    assert clitic_types(['='], ['a', 'b']) == [None, 'enclitic']  # two-piece default
    assert clitic_types(['-', '=', '-'], ['a', 'b', 'c', 'd']) == [None, None, None, None]
    assert clitic_types(['-', '='], ['house', 'PL', 'TOP']) == [None, None, 'enclitic']


def test_analysis_for_surface_mismatch_in_cyrillic():
    a = analysis_for('rixoqiil', ParsedWord('E3S(r)-esposa(ixoqiil)'))
    assert not a['degraded'] and a['segments'] == ['r', 'ixoqiil'] and not a['surface_mismatch']
    assert analysis_for('тухузвай', ParsedWord('bring(тухун)-IMPF(зва)-PTP(й)'))['surface_mismatch']


def _word(surface, morphs, spans=(), links=(), morph_spans=None, morph_links=None):
    return {
        'surface': surface, 'text': surface, 'token': {'id': 'w'},
        'morphs': morphs, 'spans': list(spans), 'links': list(links),
        'morph_spans': morph_spans or {}, 'morph_links': morph_links or {},
    }


def test_word_state_on_hand_built_words():
    assert word_state(_word('abc', [])) == 'nomorph'
    m0 = {'id': 'm0', 'metadata': {}}
    assert word_state(_word('abc', [m0])) == 'unanalyzed'
    assert word_state(_word('abc', [{'id': 'm0', 'metadata': {'form': 'abc'}}])) == 'unanalyzed'
    # human segmentation (no prov on the morpheme tokens) -> protected
    assert word_state(_word('abc', [{'id': 'm0', 'metadata': {'form': 'ab'}},
                                     {'id': 'm1', 'metadata': {'form': 'c'}}])) == 'protected'
    ms = [{'id': 'm0', 'metadata': {'form': 'ab', **MACHINE}}, {'id': 'm1', 'metadata': {'form': 'c', **MACHINE}}]
    assert word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': MACHINE})]})) == 'machine'
    assert word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': VERIFIED})]})) == 'protected'
    # a human word-level span or morpheme link protects even a default morpheme
    assert word_state(_word('abc', [m0], spans=[('pos', {'metadata': None})])) == 'protected'
    assert word_state(_word('abc', [m0], morph_links={'m0': [{'metadata': {}}]})) == 'protected'


# --- tagsets ---------------------------------------------------------------------------

def raw_project():
    return {
        'id': 'p', 'config': {'igt': {
            'tagsets': {'Leipzig': {'delimiters': ' . : ', 'mode': 'mixed',
                                    'values': [{'value': ' PL ', 'description': 'plural'}, {'value': 'PL'},
                                               {'value': ''}, {'value': '1SG'}, 'junk']},
                        ' POS ': {'mode': 'closed', 'values': [{'value': 'n'}]},
                        'Odd': {'mode': 'strict', 'delimiters': 7}},
            'documentMetadata': [{'name': 'Genre', 'tagset': 'POS'}, {'name': 'Date'}, {'name': 'X', 'tagset': 'Gone'}],
        }},
        'text_layers': [{'token_layers': [
            {'id': 'morphL', 'span_layers': [
                {'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme', 'tagset': 'Leipzig'}}},
                {'id': 'noteL', 'name': 'Note', 'config': {'igt': {'scope': 'Morpheme'}}},
                {'id': 'oldL', 'name': 'Old', 'config': {'igt': {'scope': 'Morpheme', 'tagset': 'Gone'}}}]}]}],
        'vocabs': [{'id': 'v', 'name': 'Lex', 'config': {'igt': {
            'fields': {'pos': {'inline': True, 'tagset': 'POS'}, 'gloss': {'inline': True}},
            'tagsets': {'POS': {'mode': 'closed', 'values': [{'value': 'adj'}]}}}}}],
    }


def test_tagsets_are_read_the_way_the_editor_reads_them():
    ts = read_tagsets(raw_project()['config'])
    assert set(ts) == {'Leipzig', 'POS', 'Odd'}  # names trimmed
    leipzig = ts['Leipzig']
    assert leipzig['delimiters'] == '.:' and leipzig['mode'] == 'mixed'
    assert [v['value'] for v in leipzig['values']] == ['PL', '1SG']  # trimmed, deduped, empties and junk dropped
    assert leipzig['values'][0]['description'] == 'plural'
    assert ts['Odd'] == {'name': 'Odd', 'delimiters': '', 'mode': 'suggest', 'values': []}
    assert normalize_tagset(None)['mode'] == 'suggest'


def test_tagset_for_and_governed_fields_resolve_by_name_and_ignore_dangling_references():
    p = raw_project()
    assert tagset_for(p, 'glossL')['name'] == 'Leipzig'
    assert tagset_for(p, 'noteL') is None and tagset_for(p, 'oldL') is None and tagset_for(p, 'nope') is None
    g = governed_fields(p)
    assert [(f['kind'], f['name'], f['scope'], f['layer_id'], f['tagset']['name']) for f in g] == [
        ('span', 'Gloss', 'Morpheme', 'glossL', 'Leipzig'), ('metadata', 'Genre', 'document', None, 'POS')]
    # a vocabulary's field resolves against the vocabulary's own tagsets, never the project's
    assert [v['value'] for v in vocab_tagset_for(p['vocabs'][0], 'pos')['values']] == ['adj']
    assert vocab_tagset_for(p['vocabs'][0], 'gloss') is None


def test_tagset_rules_and_value_lines_for_a_prompt():
    leipzig = read_tagsets(raw_project()['config'])['Leipzig']
    assert mode_rule(leipzig) == ('A grammatical tag, written in capitals or digits, must be a listed value. '
                                  'A lexical gloss, an ordinary word in lowercase or in a script without capitals, '
                                  "may be anything. A composite value joins its parts with '.' or ':'.")
    assert mode_rule({'mode': 'closed', 'delimiters': ''}) == 'Only the listed values are accepted.'
    assert mode_rule({'mode': 'suggest', 'delimiters': '.:>'}).endswith("joins its parts with '.', ':' or '>'.")
    assert value_lines(leipzig) == ['PL: plural', '1SG']
    assert value_lines(leipzig, max_values=1) == ['PL: plural', '... and 1 more']
